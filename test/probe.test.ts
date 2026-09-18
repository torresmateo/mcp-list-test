/**
 * The probe, driven the way an operator drives it: the real `bun run probe`
 * binary, a real hook counter, and the fake gateway from slice #3 standing in
 * for Arcade. Nothing is mocked — DESIGN.md decision 14 puts the live probe in
 * its own command precisely so this suite can be honest without credentials.
 *
 * The rules this file works under:
 *
 *  - **Ephemeral ports.** `$PORT_WEB` belongs to the operator's hook server and
 *    to the other worktrees. Both servers here bind port 0 and the probe is
 *    told where they landed with `--hook-url`.
 *  - **Nothing is inherited from the environment.** `bun test` does not load
 *    `.env.local`, but the child process it spawns through `bun run` does, and
 *    an explicitly-set variable beats it even when empty. Every variable the
 *    probe reads is therefore passed explicitly on every spawn.
 *  - **A zero is never the whole assertion.** "The hook was not called" and
 *    "the probe could not ask" both leave a count at 0, so every count here is
 *    paired with something that tells those apart: the gateway's own record of
 *    the calls it made, or the payload the counter stored.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARCADE_USER_ID_HEADER } from "../src/client/headers.ts";
import { type FakeGateway, startFakeGateway } from "../src/fake-gateway/server.ts";
import { type HookServer, startHookServer } from "../src/hook-server/server.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_TOKEN = "hook-token-for-probe-tests";
const REVISION = "2025-11-25";

/**
 * Every test here spawns the real CLI, which starts a bun process, runs a
 * handshake and waits out a quiescence window per request. That is comfortably
 * over bun's 5 s default, so each test says how long it is allowed to take
 * rather than failing on the clock.
 */
const SPAWN_TIMEOUT_MS = 40_000;

/** The run JSON this slice writes. `any` keeps the assertions readable. */
type Loose = Record<string, any>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  // Reverse order, and never leave a listener behind: the reviewer holds a
  // different port block and a leaked server is unreviewed code still running.
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function hookServer(): HookServer {
  const dir = mkdtempSync(join(tmpdir(), "probe-hook-"));
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

/** A scratch `--out` directory this test owns; `results/` is the operator's. */
function outputDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "probe-out-"));
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

/**
 * Runs the real CLI and reads back whatever it wrote.
 *
 * The quiescence window is 200 ms rather than the 2 s default so the suite
 * stays quick; it is a flag precisely so this is a configuration choice and
 * not a different code path.
 */
async function runProbe(
  options: {
    gatewayUrl?: string;
    hookUrl?: string;
    args?: string[];
    env?: Record<string, string>;
    out?: string;
  } = {},
): Promise<ProbeResult> {
  const out = options.out ?? outputDir();
  const argv = [
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
    ...(options.hookUrl === undefined ? [] : ["--hook-url", options.hookUrl]),
    ...(options.args ?? []),
  ];
  const child = Bun.spawn(argv, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ARCADE_API_KEY: "probe-test-key",
      ARCADE_MCP_URL: options.gatewayUrl ?? "http://127.0.0.1:1/mcp",
      HOOK_BEARER_TOKEN: HOOK_TOKEN,
      HOOK_PUBLIC_URL: "https://probe-test-tunnel.example",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
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

/** Hook hits attributable to each request — the difference the report computes. */
function hitsPerRequest(run: Loose): number[] {
  let previous = 0;
  return run.requests.map((request: Loose) => {
    const delta = request.hookHitsAfter - previous;
    previous = request.hookHitsAfter;
    return delta;
  });
}

describe("one hook call per tools/list", () => {
  test("two repetitions write one file each, ok, with one hit on tools/list", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 1 });

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "2"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.files).toEqual([
      expect.stringMatching(/^\d{8}T\d{9}Z-2025-11-25-1\.json$/) as unknown as string,
      expect.stringMatching(/^\d{8}T\d{9}Z-2025-11-25-2\.json$/) as unknown as string,
    ]);
    expect(result.runs).toHaveLength(2);

    for (const run of result.runs) {
      expect(run.status).toBe("ok");
      expect(run.error).toBeNull();
      expect(run.revisionRequested).toBe(REVISION);
      expect(run.revisionNegotiated).toBe(REVISION);
      expect(run.requests.map((request: Loose) => request.method)).toEqual([
        "initialize",
        "tools/list",
      ]);
      expect(run.requests[1].method).toBe("tools/list");
      // The cumulative snapshots, and the difference the report reads off them.
      expect(run.requests[0].hookHitsAfter).toBe(0);
      expect(run.requests[1].hookHitsAfter).toBe(1);
      expect(hitsPerRequest(run)).toEqual([0, 1]);
    }

    // The count alone would also be 2 if one repetition had fired twice and the
    // other not at all; the gateway's own record says which method it called
    // the hook for, and for whom.
    expect(fake.hookCalls.map(call => call.method)).toEqual(["tools/list", "tools/list"]);
    expect(fake.hookCalls.map(call => call.status)).toEqual([200, 200]);
    expect(fake.hookCalls.map(call => call.userId)).toEqual([
      result.runs[0]!.userId,
      result.runs[1]!.userId,
    ]);
  }, SPAWN_TIMEOUT_MS);

  test("hookCallsPerList 3: the difference is 3 and exactly two requests went out", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 3 });

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    expect(run.status).toBe("ok");
    // Two requests, not three: the extra hook fires are the gateway's doing,
    // not the client issuing `tools/list` again behind our back. That is the
    // "miscounting hook fires" failure this assertion exists to rule out.
    expect(run.requests).toHaveLength(2);
    expect(hitsPerRequest(run)).toEqual([0, 3]);
    expect(run.requests[1].hookHitsAfter).toBe(3);
    expect(fake.hookCalls.map(call => call.method)).toEqual([
      "tools/list",
      "tools/list",
      "tools/list",
    ]);
  }, SPAWN_TIMEOUT_MS);
});

describe("protocol revision", () => {
  test("a gateway pinned to 2025-11-05 is a version-mismatch run and a non-zero exit", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { protocolVersion: "2025-11-05" });

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    expect(result.exitCode).not.toBe(0);
    const run = result.runs[0]!;
    expect(run.status).toBe("version-mismatch");
    expect(run.revisionRequested).toBe(REVISION);
    expect(run.revisionNegotiated).toBe("2025-11-05");
    expect(run.error).toContain("2025-11-05");
    // The downgrade was caught before any tools were listed, which is the
    // point: with one revision under test, a silent downgrade is the only way
    // a run could measure something other than what its filename claims.
    expect(run.requests.map((request: Loose) => request.method)).toEqual(["initialize"]);
    expect(result.files[0]).toMatch(/-2025-11-25-1\.json$/);
  }, SPAWN_TIMEOUT_MS);

  test("a revision this client cannot request exits non-zero naming what it can", async () => {
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--protocol", "2026-07-28", "--repetitions", "1"],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("2026-07-28");
    expect(result.stderr).toContain("2025-11-25");
    // Nothing was measured, so nothing was written: a file labelled
    // `2026-07-28` holding a `2025-11-25` measurement is the exact failure the
    // validation exists to prevent.
    expect(result.files).toEqual([]);
    expect(fake.hookCalls).toEqual([]);
  }, SPAWN_TIMEOUT_MS);

  test("an ok run records the legacy era it actually spoke", async () => {
    // DESIGN.md decision 15: `legacy` is the era that opens with `initialize`,
    // and it is what this project measures today. The v2 client can also speak
    // the modern era, so the run says which one it used rather than implying it.
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    expect(result.runs[0]!.protocolEra).toBe("legacy");
    expect(result.runs[0]!.requests[0].method).toBe("initialize");
  }, SPAWN_TIMEOUT_MS);
});

describe("attribution", () => {
  test("each repetition uses a distinct user id and every hook hit carries it", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 2 });

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "3"],
    });

    expect(result.exitCode).toBe(0);
    const ids = result.runs.map(run => run.userId as string);
    expect(new Set(ids).size).toBe(3);
    for (const [index, id] of ids.entries()) {
      expect(id).toMatch(/^probe-2025-11-25-\d+-\d+$/);
      expect(id.endsWith(`-${index + 1}`)).toBe(true);
    }

    for (const run of result.runs) {
      expect(run.hookHits).toHaveLength(2);
      // Not a count: the ids the counter actually stored, which is what makes
      // the number attributable to this repetition and no other.
      expect(run.hookHits.map((hit: Loose) => hit.payload.user_id)).toEqual([
        run.userId,
        run.userId,
      ]);
      expect(run.hookHits.every((hit: Loose) => typeof hit.receivedAt === "string")).toBe(true);
    }
  }, SPAWN_TIMEOUT_MS);

  test("every outbound request carried the Arcade user header and a bearer", async () => {
    // If it did not, the gateway would file its hook hits under a key this
    // probe never polls, `GET /hits` would find nothing, and the run would
    // report a clean zero that reads exactly like "the hook never fired".
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    const run = result.runs[0]!;
    for (const request of run.requests as Loose[]) {
      expect(request.userIdHeader).toBe(run.userId);
      expect(request.authorizationScheme).toBe("Bearer");
    }
    // The header name is the one constant the probe and the gateway share.
    expect(ARCADE_USER_ID_HEADER).toBe("Arcade-User-ID");
  }, SPAWN_TIMEOUT_MS);

  test("hook hits are stored as the counter returned them, payload and all", async () => {
    // Slice #15 is extending what each hit carries. Passing entries through
    // unprojected is what keeps this slice from deciding what is interesting.
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    const run = result.runs[0]!;
    const stored = (await (
      await fetch(`${hook.url}/hits?user_id=${encodeURIComponent(run.userId as string)}`)
    ).json()) as Loose;
    expect(run.hookHits).toEqual(stored.hits);
    // An excerpt, not a count: both toolkits went to the hook, which is what
    // makes the empty Gmail list below the hook's doing.
    expect(Object.keys(run.hookHits[0].payload.toolkits).sort()).toEqual(["Gmail", "Slack"]);
    expect(run.hookHits[0].payload.user_id).toBe(run.userId);
  }, SPAWN_TIMEOUT_MS);
});

describe("what the tools/list returned", () => {
  test("gmailToolsListed is 0 and toolsListed is at least 1 in every ok run", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 1 });

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "2"],
    });

    expect(result.exitCode).toBe(0);
    for (const run of result.runs) {
      expect(run.status).toBe("ok");
      expect(run.gmailToolsListed).toBe(0);
      expect(run.toolsListed).toBeGreaterThanOrEqual(1);
    }
    // A zero Gmail count would also be what a gateway that never offered Gmail
    // produced. The hook payload above shows Gmail went in; the surviving
    // Slack tool shows the list was not simply empty.
    expect(result.runs[0]!.toolsListed).toBe(1);
  }, SPAWN_TIMEOUT_MS);
});

describe("pagination", () => {
  test("a paged tools/list is three outbound requests with a followed cursor", async () => {
    // Failure mode #1 for this slice: a hook count that is high because the
    // client fetched three pages is a different result from one that is high
    // per request, and a reader must not have to derive which by counting
    // rows in `requests[]`.
    const hook = hookServer();
    const fake = gateway(hook, { pageSize: 1, hookCallsPerList: 1 });

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    expect(run.toolsListRequests).toBe(3);
    expect(run.cursorFollowed).toBe(true);
    // The gateway's own view agrees on both the count and the cursors.
    expect(fake.listCursors).toEqual([null, "1", "2"]);
    expect(fake.hookCalls.map(call => call.method)).toEqual([
      "tools/list",
      "tools/list",
      "tools/list",
    ]);

    // Four requests, three of them `tools/list`, each with its own snapshot —
    // so the three hits are attributed one per page, not three to one request.
    const methods = (run.requests as Loose[]).map(request => request.method);
    expect(methods).toEqual(["initialize", "tools/list", "tools/list", "tools/list"]);
    expect(hitsPerRequest(run)).toEqual([0, 1, 1, 1]);
    expect((run.requests as Loose[]).map(request => request.cursor)).toEqual([
      undefined,
      undefined,
      "1",
      "2",
    ]);
    // The aggregate is still one Slack tool: paging did not change the answer.
    expect(run.toolsListed).toBe(1);
    expect(run.gmailToolsListed).toBe(0);

    // The reported tools/list time is the three round trips and nothing else.
    // A first-sent-to-last-replied span would have swallowed the two 200 ms
    // quiescence windows the probe itself waits between pages and reported
    // them as the gateway's latency.
    const listRequests = (run.requests as Loose[]).filter(r => r.method === "tools/list");
    const sum = listRequests.reduce((total, r) => total + (r.durationMs as number), 0);
    expect(run.toolsListDurationMs).toBeCloseTo(sum, 3);
    expect(run.toolsListDurationMs).toBeLessThan(400);
  }, SPAWN_TIMEOUT_MS);

  test("an unpaged tools/list says so as a number, not as an absence", async () => {
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    const run = result.runs[0]!;
    expect(run.toolsListRequests).toBe(1);
    expect(run.cursorFollowed).toBe(false);
    expect(fake.listCursors).toEqual([null]);
  }, SPAWN_TIMEOUT_MS);
});

describe("timing", () => {
  test("every request records a start, an end and a duration that bracket it", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 1 });

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    const run = result.runs[0]!;
    for (const request of run.requests as Loose[]) {
      const sent = Date.parse(request.sentAt);
      const finished = Date.parse(request.finishedAt);
      expect(Number.isNaN(sent)).toBe(false);
      expect(finished).toBeGreaterThanOrEqual(sent);
      expect(request.durationMs).toBeGreaterThan(0);
      // The duration measures the request, not the quiescence window that
      // follows it; 200 ms of polling must not land inside it.
      expect(request.durationMs).toBeLessThan(200);
      expect(request.responseObserved).toBe(true);
    }
    // The tools/list total is the sum of the round trips, so it never picks up
    // the quiescence window the probe waits out between pages.
    const list = (run.requests as Loose[]).filter(request => request.method === "tools/list");
    expect(run.toolsListDurationMs).toBe(list[0]!.durationMs);
    expect(Date.parse(run.finishedAt)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
  }, SPAWN_TIMEOUT_MS);
});

describe("a failure is never a zero", () => {
  test("an unreachable hook counter is an error run with a reason, not 0 hits", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 1 });
    const unreachable = "http://127.0.0.1:1";

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: unreachable,
      args: ["--repetitions", "1"],
    });

    expect(result.exitCode).not.toBe(0);
    const run = result.runs[0]!;
    expect(run.status).toBe("error");
    expect(run.error).toContain("hook counter unreachable");
    expect(run.revisionNegotiated).toBe(REVISION);
    // The error names the counter and the URL it could not read, so the empty
    // `hookHits` cannot be mistaken for "the hook never fired" — which is the
    // whole project's headline failure. It stops at the first snapshot it
    // cannot take, which is why `tools/list` never went out at all.
    expect(run.error).toContain("/hits?user_id=");
    expect(run.hookHits).toEqual([]);
    expect(run.toolsListRequests).toBe(0);
    expect(fake.hookCalls).toEqual([]);
  }, SPAWN_TIMEOUT_MS);

  test("an unreachable gateway is an error run with revisionNegotiated null", async () => {
    const hook = hookServer();

    const result = await runProbe({
      gatewayUrl: "http://127.0.0.1:1/mcp",
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    expect(result.exitCode).not.toBe(0);
    const run = result.runs[0]!;
    expect(run.status).toBe("error");
    // The operator's ruling of 2026-09-18: nothing was negotiated, so the
    // field is JSON `null` — not `""`, not omitted.
    expect(run.revisionNegotiated).toBeNull();
    expect(Object.hasOwn(run, "revisionNegotiated")).toBe(true);
    expect(typeof run.error).toBe("string");
    expect(run.requests).toEqual([]);
  }, SPAWN_TIMEOUT_MS);

  test("missing ARCADE_MCP_URL exits non-zero naming it, with nothing written", async () => {
    const hook = hookServer();
    const out = outputDir();

    const result = await runProbe({
      hookUrl: hook.url,
      out,
      env: { ARCADE_MCP_URL: "" },
      args: ["--repetitions", "1"],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("missing ARCADE_MCP_URL");
    expect(result.files).toEqual([]);
  }, SPAWN_TIMEOUT_MS);
});

describe("what the probe prints", () => {
  test("a table of method, hook hits and the negotiated revision", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 2 });

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
    });

    expect(result.stdout).toContain("initialize");
    expect(result.stdout).toContain("tools/list");
    expect(result.stdout).toContain(`negotiated ${REVISION}`);
    expect(result.stdout).toContain(result.runs[0]!.userId as string);
    expect(result.stdout).toContain(result.files[0]!);
  }, SPAWN_TIMEOUT_MS);
});
