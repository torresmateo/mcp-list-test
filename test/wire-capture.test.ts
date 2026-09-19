/**
 * All four wire directions, recorded and rendered — issue #31, DESIGN.md
 * decision 19.
 *
 * Three of the four were missing or reduced to metadata, so the report could
 * only print `body not recorded`. What is asserted here is that each one now
 * reaches the *written file*: a field that is right in memory and absent from
 * disk is the failure this project keeps finding.
 *
 * Nothing mocks the unit under test. The gateway and the counter are the real
 * servers on ephemeral ports, the probe and the report are the real CLIs, and
 * every variable the probe reads is pinned on every spawn by
 * `PINNED_PROBE_ENV` — neither `bun test` nor the child it spawns reads
 * `.env.local`, so what would otherwise reach the child is whatever the
 * operator exported into their shell (issue #29, `test/support/probe-env.ts`).
 *
 * The one place a dependency is injected is `createRequestLog`'s `fetchImpl`,
 * which exists to be injected: the streaming cases below need a body that
 * arrives in chunks the caller chooses, and no real server hands you that
 * deterministically. The request log itself is never stubbed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestLog } from "../src/client/request-log.ts";
import { openSession } from "../src/client/session.ts";
import { type FakeGateway, startFakeGateway } from "../src/fake-gateway/server.ts";
import { type HookServer, startHookServer } from "../src/hook-server/server.ts";
import { PINNED_PROBE_ENV } from "./support/probe-env.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const HOOK_TOKEN = "hook-token-for-wire-capture-tests";
const REVISION = "2025-11-25";
const SPAWN_TIMEOUT_MS = 40_000;

/** The run JSON as it comes back off disk. `any` keeps the assertions readable. */
type Loose = Record<string, any>;

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  // Reverse order, and never leave a listener behind: the reviewer holds a
  // different port block and a leaked server is unreviewed code still running.
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hookServer(): HookServer & { logText(): string } {
  const dir = scratchDir("wire-hook-");
  const logPath = join(dir, "hook-log.jsonl");
  const server = startHookServer({ port: 0, token: HOOK_TOKEN, logPath });
  cleanups.push(() => server.close());
  return { ...server, logText: () => readFileSync(logPath, "utf8") };
}

function gateway(
  hook: HookServer,
  options: Partial<Parameters<typeof startFakeGateway>[0]> = {},
): FakeGateway {
  const fake = startFakeGateway({ port: 0, hookUrl: hook.url, hookToken: HOOK_TOKEN, ...options });
  cleanups.push(() => fake.close());
  return fake;
}

interface ProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputDir: string;
  files: string[];
  /** The bytes on disk, not the parsed value: criterion 5 is about what landed. */
  texts: string[];
  runs: Loose[];
}

/** Runs the real CLI the README documents and reads back whatever it wrote. */
async function runProbe(options: {
  gatewayUrl: string;
  hookUrl: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<ProbeResult> {
  const out = scratchDir("wire-out-");
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
      ...(options.args ?? []),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...PINNED_PROBE_ENV,
        ARCADE_API_KEY: "probe-test-key",
        ARCADE_MCP_URL: options.gatewayUrl,
        HOOK_BEARER_TOKEN: HOOK_TOKEN,
        HOOK_PUBLIC_URL: "https://wire-capture-tunnel.example",
        ...options.env,
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
    .filter((name) => name.endsWith(".json"))
    .sort();
  const texts = files.map((name) => readFileSync(join(out, name), "utf8"));
  return { stdout, stderr, exitCode, outputDir: out, files, texts, runs: texts.map((t) => JSON.parse(t)) };
}

/** Runs the real report CLI over a directory of run files. */
async function runReport(inputDir: string): Promise<string> {
  const outFile = join(scratchDir("wire-report-"), "report.html");
  const child = Bun.spawn(["bun", "run", "report", "--in", inputDir, "--out", outFile], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return readFileSync(outFile, "utf8");
}

// ---------------------------------------------------------------------------
// Criterion 1 — the hook's own response
// ---------------------------------------------------------------------------

describe("the hook records what it answered, not only what it was asked", () => {
  /** Posts one payload to the real counter and returns both sides of the exchange. */
  async function post(hook: HookServer, payload: unknown) {
    const response = await fetch(`${hook.url}/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${HOOK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    return { status: response.status, text };
  }

  async function hits(hook: HookServer, userId: string) {
    const response = await fetch(`${hook.url}/hits?user_id=${encodeURIComponent(userId)}`);
    return (await response.json()) as { count: number; hits: Loose[] };
  }

  test("the recorded body is the deny that went on the wire, byte for byte", async () => {
    const hook = hookServer();
    const sent = await post(hook, {
      user_id: "u-deny",
      toolkits: {
        Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } },
        Slack: { tools: { PostMessage: [{ version: "1.0.0" }] } },
      },
    });

    const recorded = (await hits(hook, "u-deny")).hits[0]!;
    expect(recorded.responseStatus).toBe(sent.status);
    expect(recorded.responseStatus).toBe(200);
    // Not "a deny was recorded" — *the* deny, reproduced from the stored value
    // and compared against the bytes the caller actually received.
    expect(JSON.stringify(recorded.responseBody)).toBe(sent.text);
    expect(recorded.responseBody).toEqual({
      deny: { Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } } },
    });
    // Both directions on one record: the request it answers is still there.
    expect(recorded.payload.toolkits.Slack).toBeDefined();
    // And the JSONL copy carries the same thing, so a crash-surviving file is
    // evidence of the answer too.
    expect(JSON.parse(hook.logText().trim()).responseBody).toEqual(recorded.responseBody);
  });

  test("an empty decision is recorded as a body, never as an absence", async () => {
    // `{}` is row three of the contract — neither `only` nor `deny`, which the
    // engine reads as *no change*. It is the right answer here and it is the
    // shape of #21's fail-open, so it must be on the record as a value.
    const hook = hookServer();
    const sent = await post(hook, {
      user_id: "u-nogmail",
      toolkits: { Slack: { tools: { PostMessage: [{ version: "1.0.0" }] } } },
    });

    const recorded = (await hits(hook, "u-nogmail")).hits[0]!;
    expect(sent.text).toBe("{}");
    expect(Object.hasOwn(recorded, "responseBody")).toBe(true);
    expect(recorded.responseBody).toEqual({});
    expect(recorded.responseStatus).toBe(200);
  });

  test("a rejected request is still not counted and records no answer either", async () => {
    // DESIGN.md decision 7. Recording our own 401s would make every scanner on
    // a public tunnel URL a measurement.
    const hook = hookServer();
    await post(hook, { user_id: "u-401", toolkits: {} });
    expect((await hits(hook, "u-401")).count).toBe(1);
    const linesBefore = hook.logText().trim().split("\n").length;

    const rejected = await fetch(`${hook.url}/access`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ user_id: "u-401", toolkits: {} }),
    });
    await rejected.text();

    expect(rejected.status).toBe(401);
    expect((await hits(hook, "u-401")).count).toBe(1);
    expect(hook.logText().trim().split("\n").length).toBe(linesBefore);
  });
});

// ---------------------------------------------------------------------------
// Criteria 2 and 3 — the MCP frames, as frames
// ---------------------------------------------------------------------------

describe("the run file holds both MCP frames, whole", () => {
  test("a non-spec top-level key on the result survives into the written file", async () => {
    // The courier rule at the frame level: the gateway sent a key the spec does
    // not name on `result`, and the written file has it. What tells the frame
    // apart from the SDK's view is the next test, which measures the loss
    // rather than assuming where it falls.
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url, args: ["--repetitions", "1"] });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    const list = (run.requests as Loose[]).find((request) => request.method === "tools/list")!;
    const init = (run.requests as Loose[]).find((request) => request.method === "initialize")!;

    expect(list.responseFrame.result.fakeGatewayResultExtension).toBe("not named by the MCP spec");
    expect(init.responseFrame.result.fakeGatewayResultExtension).toBe("not named by the MCP spec");
    // The field the SDK's parse actually eats — see the next test — reaching
    // disk inside the frame.
    expect(list.responseFrame.result.tools[0].fakeGatewayExtension).toBe(
      "not named by the MCP spec",
    );
    // The frame is the whole JSON-RPC message, envelope included — not the
    // `result` lifted out of it.
    expect(list.responseFrame.jsonrpc).toBe("2.0");
    expect(list.responseFrame.id).toBe(list.jsonRpcId);
    // …and the request direction, likewise whole.
    expect(list.requestFrame).toEqual({ method: "tools/list", jsonrpc: "2.0", id: list.jsonRpcId });
    expect(init.requestFrame.params.protocolVersion).toBe(REVISION);
    expect(init.requestFrame.params.clientInfo.name).toBe("mcp-list-test-probe");
    // Additive to schema 1 (criterion 6).
    expect(run.schema).toBe(1);
  }, SPAWN_TIMEOUT_MS);

  test("the SDK's own view of that same reply is a lossy one, measured side by side", async () => {
    // The control criterion 3 rests on: "record the frame, not the parsed
    // object" is only a real distinction if the two differ, so this measures
    // the difference on one reply instead of asserting where it falls.
    //
    // It also pins where the loss is **not**, because the obvious guess is
    // wrong: the v2 client keeps a non-spec key on the result *object* and
    // drops one inside each tool *entry*. A test written to the guess would
    // have passed for the wrong reason the day the client changed.
    const hook = hookServer();
    const fake = gateway(hook);

    const log = createRequestLog();
    const session = await openSession({
      url: fake.url,
      revision: REVISION,
      userId: "u-sdk-view",
      apiKey: "k",
      fetchImpl: log.fetch,
      observedRevision: () => log.negotiatedProtocolVersion,
    });
    const parsed = (await session.client.listTools()) as Loose;
    await log.flush();
    await session.close();

    const frame = log.entries.find((entry) => entry.method === "tools/list")!
      .responseFrame as Loose;

    // Lost on the way to the caller, and present in the frame: the per-entry
    // vendor field — #26's `arcadeToolkit`, under this fake's own name.
    expect(Object.keys(parsed.tools[0])).toEqual(["name", "description", "inputSchema"]);
    expect(frame.result.tools[0].fakeGatewayExtension).toBe("not named by the MCP spec");

    // Lost as well, and the reason a frame cannot be rebuilt above the
    // transport at all: the JSON-RPC envelope never reaches the caller.
    expect(Object.hasOwn(parsed, "jsonrpc")).toBe(false);
    expect(Object.hasOwn(parsed, "id")).toBe(false);
    expect(frame.jsonrpc).toBe("2.0");

    // And *not* lost, which is why the result-level key is not the control:
    // the client keeps what the spec does not name on the result object.
    expect(parsed.fakeGatewayResultExtension).toBe("not named by the MCP spec");
  }, SPAWN_TIMEOUT_MS);

  test("a paged list records one frame per request, each its own page", async () => {
    // One `tools/list` call is three outbound requests here, and a row that
    // showed the assembled list as its own body would misstate what crossed.
    const hook = hookServer();
    const fake = gateway(hook, {
      pageSize: 1,
      tools: ["Notion_CreatePage", "Slack_PostMessage", "Linear_CreateIssue"],
    });

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url, args: ["--repetitions", "1"] });

    expect(result.exitCode).toBe(0);
    const run = result.runs[0]!;
    const lists = (run.requests as Loose[]).filter((request) => request.method === "tools/list");
    expect(lists.length).toBeGreaterThan(1);
    expect(run.toolsListRequests).toBe(lists.length);

    // Each frame is that request's own page: the names in the frames, in order,
    // are the assembled result — not three copies of it.
    const fromFrames = lists.flatMap((request) =>
      (request.responseFrame.result.tools as Loose[]).map((tool) => tool.name),
    );
    expect(fromFrames).toEqual((run.toolsListResult as Loose[]).map((tool) => tool.name));
    // The cursor the client followed is in the frame it was sent in, which is
    // the only place it ever existed.
    expect(lists[1]!.requestFrame.params.cursor).toBe(lists[1]!.cursor);
  }, SPAWN_TIMEOUT_MS);

  test("a run that never got a reply writes null, not an empty object", async () => {
    // A version-mismatch run dies inside the handshake. `responseFrame: {}`
    // would read as a gateway that answered with nothing.
    const hook = hookServer();
    const fake = gateway(hook, { protocolVersion: "2025-11-05" });

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url, args: ["--repetitions", "1"] });

    expect(result.exitCode).not.toBe(0);
    const run = result.runs[0]!;
    expect(run.status).toBe("version-mismatch");
    // The handshake still went out, so the request direction is recorded even
    // though the run failed — that is the point of recording it.
    const init = (run.requests as Loose[])[0]!;
    expect(init.method).toBe("initialize");
    expect(init.requestFrame.params.protocolVersion).toBe(REVISION);
    expect(Object.hasOwn(init, "responseFrame")).toBe(true);
    for (const request of run.requests as Loose[]) {
      expect(request.responseFrame === null || typeof request.responseFrame === "object").toBe(true);
      expect(request.responseFrame).not.toEqual({});
    }
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Criterion 4 — the streaming design is preserved
// ---------------------------------------------------------------------------

describe("capture happens inside the pass-through and always terminates", () => {
  const REQUEST_BODY = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });

  /** A response whose body arrives as the given chunks, one microtask apart. */
  function streaming(chunks: string[], status = 200): typeof fetch {
    return (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            await Promise.resolve();
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(body, {
        status,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
  }

  /** Drives one request through the log and drains whatever comes back. */
  async function send(fetchImpl: typeof fetch) {
    const log = createRequestLog({ fetchImpl });
    const response = await log.fetch("http://gateway.invalid/mcp", {
      method: "POST",
      body: REQUEST_BODY,
    });
    const delivered = await response.text();
    await log.flush();
    return { log, delivered };
  }

  test("a frame split across chunks is captured whole, and every byte still reaches the consumer", async () => {
    const frame =
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        result: { tools: [{ name: "Slack_PostMessage", arcadeToolkit: "Slack" }], vendorTop: "kept" },
      })}\n\n`;
    // One byte at a time: every boundary inside the frame is exercised, which
    // is what a real chunked transfer is free to do.
    const chunks = ["event: message\n", ...frame.split("")];

    const { log, delivered } = await send(streaming(chunks));

    expect(delivered).toBe(chunks.join(""));
    const entry = log.entries[0]!;
    expect(entry.responseObserved).toBe(true);
    expect(entry.responseFrame).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { tools: [{ name: "Slack_PostMessage", arcadeToolkit: "Slack" }], vendorTop: "kept" },
    });
  });

  test("a stream that ends without a reply terminates, and says so", async () => {
    // The failure criterion 4 names: a capture that waited for a frame that
    // never comes hangs the probe, and a hung probe reports a clean zero.
    const { log, delivered } = await send(
      streaming(["event: message\n", 'data: {"jsonrpc":"2.0","method":"notifications/x"}\n\n']),
    );

    expect(delivered).toContain("notifications/x");
    const entry = log.entries[0]!;
    expect(entry.responseObserved).toBe(false);
    expect(entry.responseFrame).toBeNull();
  });

  test("the reply is reported as soon as it arrives, and the rest of the stream still flows", async () => {
    // Enqueue-then-inspect, not inspect-then-enqueue: the consumer is never
    // made to wait on the capture, and the capture never waits on the end of
    // the body to report a reply it has already seen.
    const completed: number[] = [];
    const log = createRequestLog({
      fetchImpl: streaming([
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } })}\n\n`,
        "data: trailing-noise\n\n",
        ": keep-alive\n\n",
      ]),
      onRequestComplete: async (request) => {
        completed.push(request.jsonRpcId as number);
      },
    });

    const response = await log.fetch("http://gateway.invalid/mcp", {
      method: "POST",
      body: REQUEST_BODY,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    await log.flush();

    expect(received).toContain("trailing-noise");
    expect(received).toContain("keep-alive");
    expect(completed).toEqual([7]);
    expect(log.entries[0]!.responseFrame).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  test("a batch gives each request its own frames, never another request's", async () => {
    const log = createRequestLog({
      fetchImpl: streaming([
        `data: ${JSON.stringify([
          { jsonrpc: "2.0", id: 2, result: { second: true } },
          { jsonrpc: "2.0", id: 1, result: { first: true } },
        ])}\n\n`,
      ]),
    });
    const response = await log.fetch("http://gateway.invalid/mcp", {
      method: "POST",
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "resources/list" },
      ]),
    });
    await response.text();
    await log.flush();

    const [first, second] = log.entries;
    expect(first!.requestFrame).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(second!.requestFrame).toEqual({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    expect(first!.responseFrame).toEqual({ jsonrpc: "2.0", id: 1, result: { first: true } });
    expect(second!.responseFrame).toEqual({ jsonrpc: "2.0", id: 2, result: { second: true } });
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — nothing newly recorded is a credential
// ---------------------------------------------------------------------------

describe("no credential reaches disk through anything recorded", () => {
  test("neither the gateway key nor the hook bearer appears in what was written", async () => {
    const hook = hookServer();
    const fake = gateway(hook);
    const apiKey = "arcade-key-DO-NOT-LEAK-9f2b7c1e";

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1"],
      env: { ARCADE_API_KEY: apiKey },
    });

    expect(result.exitCode).toBe(0);
    const written = result.texts.join("\n");

    // An absence is only evidence when the thing it is an absence *of* was
    // actually in play: the key went out on every request and the bearer was
    // accepted on every hit, and neither string is anywhere in the file.
    const run = result.runs[0]!;
    for (const request of run.requests as Loose[]) {
      expect(request.authorizationScheme).toBe("Bearer");
    }
    expect(run.hookHits.length).toBeGreaterThan(0);
    expect(written).not.toContain(apiKey);
    expect(written).not.toContain(HOOK_TOKEN);
    expect(hook.logText()).not.toContain(HOOK_TOKEN);

    // The new fields are populated, so the absence above is not the absence of
    // a capture that never happened.
    expect(run.requests.every((request: Loose) => request.requestFrame !== undefined)).toBe(true);
    expect(run.hookHits.every((hit: Loose) => hit.responseStatus === 200)).toBe(true);

    // The bearer is on the record as a descriptor, which is the capture-time
    // redaction doing its job rather than the header never arriving.
    const authorization = (run.hookHits as Loose[])[0]!.headers.authorization as string;
    expect(authorization).toMatch(/^Bearer <redacted len=\d+ sha256=[0-9a-f]{8}>$/);

    // And the report built from it carries neither either.
    expect(await runReport(result.outputDir)).not.toContain(apiKey);
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Criterion 7 — the report renders all four directions in the existing timeline
// ---------------------------------------------------------------------------

describe("the report shows all four directions in the wire timeline", () => {
  test("every row states what crossed, and the deny is readable in the document", async () => {
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({ gatewayUrl: fake.url, hookUrl: hook.url, args: ["--repetitions", "1"] });
    expect(result.exitCode).toBe(0);
    const html = await runReport(result.outputDir);

    // The timeline is #25's table, not a new one.
    expect(html).toContain('<table class="wire"');
    expect(html).toContain("client → gateway");
    expect(html).toContain("gateway → hook");

    // The two MCP directions, named as directions.
    expect(html).toContain("probe → gateway (MCP request frame)");
    expect(html).toContain("gateway → probe (MCP response frame)");
    // The fourth one, which the report could not show at all before.
    expect(html).toContain("hook → gateway (the answer this hook sent)");

    // `body not recorded` is gone from the rows that now have bodies, and the
    // frames are on the page as bytes a reader can check.
    expect(html).toContain("request and response frames recorded");
    expect(html).toContain("fakeGatewayResultExtension");
    expect(html).toContain("&quot;deny&quot;");
    expect(html).toContain("HTTP 200");

    // Criterion 8: the bodies went through #25's store rather than beside it,
    // so the sentence that totals the report's bodies names every new kind and
    // still reconciles. Two rounds of #25's review were spent on a total that
    // counted a kind the sentence could not name.
    const sentence = /This report embeds (\d+) bod(?:y|ies) — ([^.]+)\./.exec(
      html.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " "),
    );
    expect(sentence, "no body-count sentence").not.toBeNull();
    const parts = sentence![2]!
      .split(/, | and /)
      .map((part) => /^(\d+) (.+)$/.exec(part.trim())!)
      .map((found) => ({ count: Number(found[1]), label: found[2]! }));
    expect(parts.reduce((sum, part) => sum + part.count, 0)).toBe(Number(sentence![1]));
    // Singular or plural depending on how many this run produced; what matters
    // is that each kind is named at all.
    const labels = parts.map((part) => part.label.replace(/s$/, ""));
    expect(labels).toContain("MCP request frame");
    expect(labels).toContain("MCP response frame");
    expect(labels).toContain("hook response");
    expect(labels).toContain("hook payload");
  }, SPAWN_TIMEOUT_MS);
});
