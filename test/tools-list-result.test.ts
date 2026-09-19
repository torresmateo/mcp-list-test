/**
 * The MCP side of the session, recorded rather than counted — DESIGN.md
 * decision 18 and issue #26.
 *
 * Two halves, deliberately:
 *
 *  - the derivation (`deriveToolsNotOfferedToHook`) driven directly, because
 *    the rule that matters most — `null`, never `[]`, when there is nothing to
 *    compare against — has to be pinned as a rule and not only as a property of
 *    one end-to-end run;
 *  - the real CLI against the fake gateway and a real hook counter, because a
 *    field that is right in memory and absent from the written file is exactly
 *    the failure this project keeps finding.
 *
 * Nothing here mocks the unit under test. The gateway and the counter are the
 * real servers on ephemeral ports; `$PORT_WEB` belongs to the operator.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeGateway, startFakeGateway } from "../src/fake-gateway/server.ts";
import { type HookServer, startHookServer } from "../src/hook-server/server.ts";
import { deriveToolsNotOfferedToHook } from "../src/probe/run.ts";
import type { HookHit } from "../src/probe/hits.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_TOKEN = "hook-token-for-tools-list-tests";
const REVISION = "2025-11-25";
const SPAWN_TIMEOUT_MS = 40_000;

/** The run JSON as it comes back off disk. `any` keeps the assertions readable. */
type Loose = Record<string, any>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function hookServer(): HookServer {
  const dir = mkdtempSync(join(tmpdir(), "tools-list-hook-"));
  const server = startHookServer({
    port: 0,
    token: HOOK_TOKEN,
    logPath: join(dir, "hook-log.jsonl"),
  });
  cleanups.push(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return server;
}

function gateway(
  hook: HookServer,
  options: Partial<Parameters<typeof startFakeGateway>[0]> = {},
): FakeGateway {
  const fake = startFakeGateway({ port: 0, hookUrl: hook.url, hookToken: HOOK_TOKEN, ...options });
  cleanups.push(() => fake.close());
  return fake;
}

function outputDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tools-list-out-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface ProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputDir: string;
  files: string[];
  runs: Loose[];
}

/** The real CLI, with a short quiescence window so the suite stays quick. */
async function runProbe(options: {
  gatewayUrl: string;
  hookUrl: string;
  args?: string[];
}): Promise<ProbeResult> {
  const out = outputDir();
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "probe",
      "--protocol",
      REVISION,
      "--out",
      out,
      "--quiesce-ms",
      "200",
      "--poll-interval-ms",
      "25",
      "--hook-url",
      options.hookUrl,
      ...(options.args ?? ["--repetitions", "1"]),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ARCADE_API_KEY: "tools-list-test-key",
        ARCADE_MCP_URL: options.gatewayUrl,
        HOOK_BEARER_TOKEN: HOOK_TOKEN,
        HOOK_PUBLIC_URL: "https://tools-list-test-tunnel.example",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const files = readdirSync(out)
    .filter(name => name.endsWith(".json"))
    .sort();
  const runs = await Promise.all(files.map(name => Bun.file(join(out, name)).json() as Loose));
  return { stdout, stderr, exitCode, outputDir: out, files, runs };
}

/** A hook hit in the counter's shape, carrying the toolkits a payload named. */
function hit(toolkits: Record<string, string[]>): HookHit {
  const tools: Record<string, { tools: Record<string, { version: string }[]> }> = {};
  for (const [toolkit, names] of Object.entries(toolkits)) {
    tools[toolkit] = { tools: {} };
    for (const name of names) tools[toolkit]!.tools[name] = [{ version: "1.0.0" }];
  }
  return { receivedAt: new Date().toISOString(), payload: { user_id: "u", toolkits: tools } };
}

/** `[{ name }]` from bare names, the shape `toolsListResult` holds. */
function listed(...names: string[]) {
  return names.map(name => ({ name }));
}

describe("toolsNotOfferedToHook is null, never [], when there is nothing to compare", () => {
  // Criterion 3, and the one this slice exists for. `[]` reads as "nothing
  // bypassed the hook" — a confident, false statement produced by a run that
  // in fact observed nothing.
  test("no hook hits at all", () => {
    expect(deriveToolsNotOfferedToHook(listed("Slack_PostMessage"), [])).toBeNull();
  });

  test("no tools/list result", () => {
    expect(deriveToolsNotOfferedToHook(null, [hit({ Slack: ["PostMessage"] })])).toBeNull();
  });

  test("an empty list with hits is [] — that is a measurement, not an absence", () => {
    // The other side of the same rule. A hook that denied everything really
    // does leave nothing bypassing it, and saying so is not a guess.
    expect(deriveToolsNotOfferedToHook([], [hit({ Gmail: ["SendEmail"] })])).toEqual([]);
  });
});

describe("matching a listed Toolkit_Tool to a two-part hook payload", () => {
  test("the contract's own spelling matches", () => {
    expect(
      deriveToolsNotOfferedToHook(listed("Slack_PostMessage"), [hit({ Slack: ["PostMessage"] })]),
    ).toEqual([]);
  });

  test("a gateway that spelled the join differently still matches", () => {
    // Criterion 4's failure mode: a separator assumption that is wrong makes
    // *every* tool fail to match and the run reports that all of them bypassed
    // the hook — a dramatic finding that is entirely an artefact of the join.
    const payload = [hit({ Slack: ["PostMessage"] })];
    expect(deriveToolsNotOfferedToHook(listed("Slack.PostMessage"), payload)).toEqual([]);
    expect(deriveToolsNotOfferedToHook(listed("slack-postmessage"), payload)).toEqual([]);
    expect(deriveToolsNotOfferedToHook(listed("SLACK_POSTMESSAGE"), payload)).toEqual([]);
  });

  test("a payload that already carries the qualified name matches", () => {
    expect(
      deriveToolsNotOfferedToHook(listed("Gmail_SendEmail"), [
        hit({ Gmail: ["Gmail_SendEmail"] }),
      ]),
    ).toEqual([]);
  });

  test("a bare tool name is not a wildcard across toolkits", () => {
    // `Ping` under toolkit `A` must not match a listed `B_Ping`: silently
    // matching it would understate what bypassed the hook, which is the same
    // class of false confidence in the other direction.
    expect(deriveToolsNotOfferedToHook(listed("B_Ping"), [hit({ A: ["Ping"] })])).toEqual([
      "B_Ping",
    ]);
  });

  test("the result is deduplicated and sorted, so two runs are diffable", () => {
    const result = deriveToolsNotOfferedToHook(
      listed("Zeta_Two", "Alpha_One", "Zeta_Two"),
      [hit({ Slack: ["PostMessage"] })],
    );
    expect(result).toEqual(["Alpha_One", "Zeta_Two"]);
  });
});

describe("the run file records both sides of the comparison", () => {
  test("toolsListResult holds the gateway's entries whole, vendor fields included", async () => {
    // Criterion 1. The v2 client parses a `tools/list` result against the spec
    // schema and drops every top-level field the spec does not name, so a
    // result taken from `client.listTools()` would be a trimmed shape with
    // nothing saying so. This asserts the field the SDK would have eaten.
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    expect(run.toolsListResult).toEqual([
      {
        name: "Slack_PostMessage",
        description: "Slack_PostMessage (fake)",
        inputSchema: { type: "object", properties: {} },
        fakeGatewayExtension: "not named by the MCP spec",
      },
    ]);
    // The count keeps its meaning and its value (criterion 5) and agrees with
    // the result it now sits beside.
    expect(run.toolsListed).toBe(1);
    expect(run.gmailToolsListed).toBe(0);
    expect(run.toolsListResult).toHaveLength(run.toolsListed);
    // Additive to `schema: 1` (criterion 6).
    expect(run.schema).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  test("a paged list is the concatenation, in order, across every page", async () => {
    // Criterion 1's second sentence. Three pages, one tool each, and the two
    // Gmail tools denied by the hook — so the assembled result is not a page
    // and not the catalogue.
    const hook = hookServer();
    const fake = gateway(hook, {
      pageSize: 1,
      tools: ["Gmail_SendEmail", "Notion_CreatePage", "Slack_PostMessage"],
    });

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    expect(run.toolsListRequests).toBe(3);
    expect(run.cursorFollowed).toBe(true);
    expect((run.toolsListResult as Loose[]).map(tool => tool.name)).toEqual([
      "Notion_CreatePage",
      "Slack_PostMessage",
    ]);
    expect(run.toolsListed).toBe(2);
  }, SPAWN_TIMEOUT_MS);

  test("a strict superset of what the hook was offered names the bypassing tools", async () => {
    // Criterion 7, and the shape of the live run of 2026-09-19: the gateway
    // listed more tools than it submitted to access control, so no policy
    // could have denied the difference. Two tools bypass here, as two did
    // there.
    const hook = hookServer();
    const fake = gateway(hook, {
      tools: [
        "Gmail_SendEmail",
        "Slack_PostMessage",
        "Arcade_SearchDocumentation",
        "Arcade_ListApps",
      ],
      toolsOfferedToHook: ["Gmail_SendEmail", "Slack_PostMessage"],
    });

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    // An excerpt, not a count, on both sides: what the hook was told, and what
    // the client was told.
    expect(Object.keys(run.hookHits[0].payload.toolkits).sort()).toEqual(["Gmail", "Slack"]);
    expect((run.toolsListResult as Loose[]).map(tool => tool.name).sort()).toEqual([
      "Arcade_ListApps",
      "Arcade_SearchDocumentation",
      "Slack_PostMessage",
    ]);
    // The two tools the hook never saw, named — not "the gap was 2".
    expect(run.toolsNotOfferedToHook).toEqual([
      "Arcade_ListApps",
      "Arcade_SearchDocumentation",
    ]);
    // Gmail was offered and denied, so it is absent from the list and absent
    // from the bypass set. Those are different reasons and must not collapse.
    expect(run.gmailToolsListed).toBe(0);
    expect(run.toolsNotOfferedToHook).not.toContain("Gmail_SendEmail");
    expect(result.stdout).toContain(
      "not offered to the hook: Arcade_ListApps, Arcade_SearchDocumentation",
    );
  }, SPAWN_TIMEOUT_MS);

  test("every listed tool in a hook payload is [], and the probe says so", async () => {
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url });

    expect(result.exitCode).toBe(0);
    expect(result.runs[0]!.toolsNotOfferedToHook).toEqual([]);
    expect(result.stdout).toContain("not offered to the hook: none;");
  }, SPAWN_TIMEOUT_MS);

  test("a run whose counter saw no hits writes null, not []", async () => {
    // Criterion 3 end to end, in the shape that would actually mislead a
    // reader: the gateway listed a tool and the run has no hook hits to
    // compare it against, because the probe was pointed at a counter the
    // gateway never calls. `[]` here would say "nothing bypassed the hook"
    // about a run that observed nothing at all.
    const called = hookServer();
    const polled = hookServer();
    const fake = gateway(called);

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: polled.url });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    expect(run.status).toBe("ok");
    expect(run.hookHits).toEqual([]);
    expect(run.toolsListed).toBe(1);
    expect(run.toolsNotOfferedToHook).toBeNull();
    expect(Object.hasOwn(run, "toolsNotOfferedToHook")).toBe(true);
    // The gateway really did call its hook — the zero is the counter the probe
    // polled, not the hook never firing, and this is what tells them apart.
    expect(called.url).not.toBe(polled.url);
    expect(fake.hookCalls.map(call => call.status)).toEqual([200]);
    expect(result.stdout).toContain("not offered to the hook: not measured (no hook hits");
  }, SPAWN_TIMEOUT_MS);

  test("a run that never listed writes null for both fields", async () => {
    // A version-mismatch run dies before `tools/list`. `toolsListResult: []`
    // would read as "the gateway returned no tools", which it never said.
    const hook = hookServer();
    const fake = gateway(hook, { protocolVersion: "2025-11-05" });

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url });

    expect(result.exitCode).not.toBe(0);
    const run = result.runs[0]!;
    expect(run.status).toBe("version-mismatch");
    expect(run.toolsListResult).toBeNull();
    expect(run.toolsNotOfferedToHook).toBeNull();
    expect(Object.hasOwn(run, "toolsListResult")).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  test("a join that matches nothing is called out, not reported as a discovery", async () => {
    // Criterion 4's visible failure mode. The hook here is offered a toolkit
    // that shares no tool with the listed catalogue, so every listed tool
    // reads as bypassing — which is exactly what a wrong separator assumption
    // would produce, and the probe must not print it as a finding.
    const hook = hookServer();
    const fake = gateway(hook, {
      tools: ["Slack_PostMessage", "Notion_CreatePage"],
      toolsOfferedToHook: ["Unrelated_Thing"],
    });

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    expect(run.toolsNotOfferedToHook).toEqual(["Notion_CreatePage", "Slack_PostMessage"]);
    expect(result.stdout).toContain("no listed tool matched any hook payload tool");
    expect(result.stdout).toContain("check the name join");
  }, SPAWN_TIMEOUT_MS);
});
