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

/** A recorded frame is raw text; tests that read inside one parse it here. */
function parseFrame(frame: unknown): Loose {
  expect(typeof frame, "a recorded frame must be the raw text, not a parsed object").toBe(
    "string",
  );
  return JSON.parse(frame as string) as Loose;
}

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

    const listResponse = parseFrame(list.responseFrame);
    expect(listResponse.result.fakeGatewayResultExtension).toBe("not named by the MCP spec");
    expect(parseFrame(init.responseFrame).result.fakeGatewayResultExtension).toBe(
      "not named by the MCP spec",
    );
    // The field the SDK's parse actually eats — see the next test — reaching
    // disk inside the frame.
    expect(listResponse.result.tools[0].fakeGatewayExtension).toBe("not named by the MCP spec");
    // The frame is the whole JSON-RPC message, envelope included — not the
    // `result` lifted out of it.
    expect(listResponse.jsonrpc).toBe("2.0");
    expect(listResponse.id).toBe(list.jsonRpcId);
    // …and the request direction, likewise whole, and as text rather than a
    // re-serialisation: the probe sends a compact body and the file holds it.
    expect(list.requestFrame).toBe(`{"method":"tools/list","jsonrpc":"2.0","id":${list.jsonRpcId}}`);
    const initRequest = parseFrame(init.requestFrame);
    expect(initRequest.params.protocolVersion).toBe(REVISION);
    expect(initRequest.params.clientInfo.name).toBe("mcp-list-test-probe");
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

    const raw = log.entries.find((entry) => entry.method === "tools/list")!.responseFrame;
    const frame = parseFrame(raw);

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
      (parseFrame(request.responseFrame).result.tools as Loose[]).map((tool) => tool.name),
    );
    expect(fromFrames).toEqual((run.toolsListResult as Loose[]).map((tool) => tool.name));
    // The cursor the client followed is in the frame it was sent in, which is
    // the only place it ever existed.
    expect(parseFrame(lists[1]!.requestFrame).params.cursor).toBe(lists[1]!.cursor);
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
    expect(parseFrame(init.requestFrame).params.protocolVersion).toBe(REVISION);
    expect(Object.hasOwn(init, "responseFrame")).toBe(true);
    for (const request of run.requests as Loose[]) {
      expect(request.responseFrame === null || typeof request.responseFrame === "string").toBe(true);
      expect(request.responseFrame).not.toBe("{}");
    }
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Criterion 4 — the streaming design is preserved
// ---------------------------------------------------------------------------

describe("capture happens inside the pass-through and always terminates", () => {
  const REQUEST_BODY = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" });

  /**
   * A response whose body arrives as the given chunks, one microtask apart.
   *
   * `contentType` is a parameter rather than a constant because it is what
   * decides the framing: the same bytes are a stream of frames under
   * `text/event-stream` and one indivisible document under `application/json`.
   */
  function streaming(
    chunks: string[],
    contentType = "text/event-stream",
    status = 200,
  ): typeof fetch {
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
      return new Response(body, { status, headers: { "content-type": contentType } });
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

  /** A frame whose bytes no round trip survives: a duplicate key and spacing. */
  const LOSSY_FRAME =
    '{"jsonrpc":"2.0", "id":7, "dup":1,"dup":2, "result":{"tools":' +
    '[{"name":"Slack_PostMessage","arcadeToolkit":"Slack"}],"vendorTop":"kept"}}';

  test("a frame split across chunks is captured whole, and every byte still reaches the consumer", async () => {
    // One byte at a time: every boundary inside the frame is exercised, which
    // is what a real chunked transfer is free to do.
    const chunks = ["event: message\n", ...`data: ${LOSSY_FRAME}\n\n`.split("")];

    const { log, delivered } = await send(streaming(chunks));

    expect(delivered).toBe(chunks.join(""));
    const entry = log.entries[0]!;
    expect(entry.responseObserved).toBe(true);
    // The frame as it arrived, byte for byte — not a re-serialisation of a
    // parse of it. `JSON.parse` keeps only the last `dup`, so a round trip
    // anywhere on this path shows up here as a missing `"dup":1` and as
    // normalised spacing.
    expect(entry.responseFrame).toBe(LOSSY_FRAME);
    expect(JSON.parse(entry.responseFrame as string).dup).toBe(2);
  });

  test("a duplicate key survives the request direction too", async () => {
    const body = '{"jsonrpc":"2.0", "id":7,"dup":1,"dup":2, "method":"tools/list"}';
    const log = createRequestLog({ fetchImpl: streaming([]) });
    await (await log.fetch("http://gateway.invalid/mcp", { method: "POST", body })).text();
    await log.flush();

    expect(log.entries[0]!.requestFrame).toBe(body);
  });

  test("a CRLF-delimited frame is seen, not silently missed", async () => {
    // SSE permits CRLF. A scan that looked only for `\n\n` reported
    // `responseObserved: false` and no frame at all — not a crash, a run that
    // quietly says the gateway never answered, which is this project's
    // characteristic failure.
    const { log } = await send(
      streaming([`event: message\r\n`, `data: ${LOSSY_FRAME}\r\n\r\n`]),
    );

    const entry = log.entries[0]!;
    expect(entry.responseObserved).toBe(true);
    expect(entry.responseFrame).toBe(LOSSY_FRAME);
  });

  test("a CRLF frame split one byte at a time is seen too", async () => {
    // The boundary itself straddles chunks, so the scan has to wait for it
    // rather than match half of it and drop the rest of the message.
    const chunks = `event: message\r\ndata: ${LOSSY_FRAME}\r\n\r\n`.split("");

    const { log, delivered } = await send(streaming(chunks));

    expect(delivered).toBe(chunks.join(""));
    expect(log.entries[0]!.responseFrame).toBe(LOSSY_FRAME);
  });

  test("a plain JSON body, with no SSE framing at all, is still captured", async () => {
    const { log } = await send(streaming([LOSSY_FRAME], "application/json"));

    expect(log.entries[0]!.responseObserved).toBe(true);
    expect(log.entries[0]!.responseFraming).toBe("whole");
    expect(log.entries[0]!.responseFrame).toBe(LOSSY_FRAME);
  });

  test("a last frame the server ended without a blank line is still captured", async () => {
    // `flush` has to finish the job `transform` could not: there is no boundary
    // to find, so the buffer is the frame. Dropping it would be another quiet
    // "the gateway never answered".
    const { log } = await send(streaming([`event: message\n`, `data: ${LOSSY_FRAME}`]));

    expect(log.entries[0]!.responseObserved).toBe(true);
    expect(log.entries[0]!.responseFrame).toBe(LOSSY_FRAME);
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
    expect(log.entries[0]!.responseFrame).toBe('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}');
  });

  /**
   * Round 2 finding 2, verbatim: a legal, pretty-printed JSON body whose
   * insignificant blank line the scanner treated as an SSE frame boundary.
   *
   * It carries a **trailing newline**, which is what round 3 found being
   * trimmed away — and which is why every assertion about it below compares
   * bytes rather than a parsed or trimmed equivalent.
   */
  const PRETTY_JSON_BODY = '{\n  "jsonrpc": "2.0",\n\n  "id": 7,\n  "result": {"ok": true}\n}\n';

  /** Byte length, so "whole" is checked as a count and not as a feeling. */
  const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

  test("a JSON body is stored byte for byte, trailing newline included", async () => {
    // Round 3's finding, and the reason it survived round 2: the assertion
    // here used to read `PRETTY_JSON_BODY.trim()`, which is the implementation
    // restated as a requirement. Written that way it passed while the frame
    // was 60 bytes of a 61-byte body. It compares the bytes now, so
    // reintroducing a `.trim()` anywhere on this path fails it.
    const { log } = await send(streaming([PRETTY_JSON_BODY], "application/json"));

    const entry = log.entries[0]!;
    expect(entry.responseFraming).toBe("whole");
    expect(entry.responseObserved).toBe(true);
    expect(entry.responseFrameAbsence).toBeNull();

    const frame = entry.responseFrame as string;
    expect(bytes(frame)).toBe(bytes(PRETTY_JSON_BODY));
    expect(frame).toBe(PRETTY_JSON_BODY);
    // Named individually so a failure says which end was eaten.
    expect(frame.endsWith("}\n")).toBe(true);
    expect(frame).toContain('"2.0",\n\n');
  });

  test("leading whitespace on a JSON body survives too", async () => {
    // The other end of the same rule. `JSON.parse` ignores whitespace around a
    // document, so nothing downstream needs it gone — and "whole" has to mean
    // whole at both ends or it means whatever the implementation felt like.
    const padded = `\n  ${PRETTY_JSON_BODY}`;
    const { log } = await send(streaming([padded], "application/json"));

    const frame = log.entries[0]!.responseFrame as string;
    expect(bytes(frame)).toBe(bytes(padded));
    expect(frame).toBe(padded);
  });

  test("the same bytes under text/event-stream are framed as SSE, not taken whole", async () => {
    // The control for the test above. If the media type were being ignored,
    // one of these two would be wrong — they are the same bytes.
    const { log } = await send(streaming([PRETTY_JSON_BODY], "text/event-stream"));

    const entry = log.entries[0]!;
    expect(entry.responseFraming).toBe("sse");
    // No `data:` line anywhere, so SSE framing finds no message. That is the
    // correct reading of these bytes *as SSE*, and it is why the media type
    // has to decide rather than the bytes.
    expect(entry.responseFrame).toBeNull();
    expect(entry.responseFrameAbsence).toBe("unanswered");
  });

  test("a media type with no rule is taken whole, and says which rule it used", async () => {
    // Deliberate, documented, and recorded: an undivided body is the shape
    // that cannot lose data, and the row reports `unknown` so a reader can see
    // it was read under a rule nobody wrote for that media type.
    for (const contentType of ["text/plain", "application/vnd.arcade+json"]) {
      const { log } = await send(streaming([PRETTY_JSON_BODY], contentType));
      const entry = log.entries[0]!;
      expect(entry.responseFraming, contentType).toBe(
        contentType.endsWith("+json") ? "whole" : "unknown",
      );
      // Bytes, and untrimmed: a body read under a rule nobody wrote for it is
      // the last place to start quietly editing what was stored.
      const frame = entry.responseFrame as string;
      expect(bytes(frame), contentType).toBe(bytes(PRETTY_JSON_BODY));
      expect(frame, contentType).toBe(PRETTY_JSON_BODY);
    }
  });

  test("SSE strips only the framing, and keeps every byte of the payload", async () => {
    // The same assumption, checked on the other side of the fence. For
    // `text/event-stream` the `data:` prefix, the **one** optional space the
    // spec allows after the colon, and the terminating blank line are framing
    // and are genuinely not payload. Everything else is, including a second
    // space, trailing spaces, and the newline that joins multi-line data.
    //
    // Each case names the exact payload rather than deriving it, so a change
    // that trimmed either end fails here with a byte count.
    const message = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    const cases: { name: string; wire: string; payload: string }[] = [
      { name: "one space after the colon", wire: `data: ${message}\n\n`, payload: message },
      { name: "no space after the colon", wire: `data:${message}\n\n`, payload: message },
      {
        // Only the first space is framing; the second and the trailing two are
        // the data field's own value.
        name: "extra spaces are payload",
        wire: `data:  ${message}  \n\n`,
        payload: ` ${message}  `,
      },
      {
        name: "multi-line data joins with a newline",
        wire: 'data: {"jsonrpc":"2.0","id":7,\ndata: "result":{"ok":true}}\n\n',
        payload: '{"jsonrpc":"2.0","id":7,\n"result":{"ok":true}}',
      },
      { name: "CRLF terminator", wire: `data: ${message}\r\n\r\n`, payload: message },
    ];

    for (const { name, wire, payload } of cases) {
      const { log } = await send(streaming([wire], "text/event-stream"));
      const frame = log.entries[0]!.responseFrame as string;
      expect(bytes(frame), name).toBe(bytes(payload));
      expect(frame, name).toBe(payload);
      // The framing really is gone, rather than the payload happening to match.
      expect(frame.includes("data:"), name).toBe(false);
      expect(/[\r\n]\s*$/.test(frame), name).toBe(false);
    }
  });

  test("bytes that cannot be read say so, instead of becoming `no response`", async () => {
    // The rule this whole finding turns on: a frame the capture cannot parse
    // must not silently become "no response observed". An HTML error page is a
    // defect in the instrument's reading, not a finding about the gateway, and
    // the two must never print as each other.
    const { log } = await send(
      streaming(["<html><body>502 Bad Gateway</body></html>"], "text/html"),
    );

    const entry = log.entries[0]!;
    expect(entry.responseFraming).toBe("unknown");
    expect(entry.responseFrame).toBeNull();
    expect(entry.responseFrameAbsence).toBe("unreadable");
    expect(entry.responseObserved).toBe(false);
  });

  test("an empty body is `unanswered`, not `unreadable`", async () => {
    // The other side of that distinction: nothing arrived, so there was
    // nothing to fail at reading.
    const { log } = await send(streaming([], "application/json"));

    expect(log.entries[0]!.responseFrameAbsence).toBe("unanswered");
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
    // Each row gets the source slice of its own message, not the batch it
    // travelled in — and the slices are text, so nothing was re-serialised to
    // take them apart.
    expect(first!.requestFrame).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(second!.requestFrame).toBe('{"jsonrpc":"2.0","id":2,"method":"resources/list"}');
    expect(first!.responseFrame).toBe('{"jsonrpc":"2.0","id":1,"result":{"first":true}}');
    expect(second!.responseFrame).toBe('{"jsonrpc":"2.0","id":2,"result":{"second":true}}');
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — nothing newly recorded is a credential
// ---------------------------------------------------------------------------

/**
 * The sentinels round 1's reviewer planted, kept verbatim so the reproduction
 * and the fix are talking about the same strings.
 */
const SENTINELS = [
  "REQ-SECRET",
  "PROXY-SECRET",
  "COOKIE-SECRET",
  "SET-COOKIE-SECRET",
  "API-SECRET",
  "MCP-SECRET",
  "HOOK-SECRET",
] as const;

/** Every sentinel that appears anywhere in `text`. Empty is the passing answer. */
function leaks(text: string): string[] {
  return SENTINELS.filter((sentinel) => text.includes(sentinel));
}

/** The descriptor a redacted value becomes, whatever it held. */
const DESCRIPTOR = /<redacted len=\d+ sha256=[0-9a-f]{8}>/;

describe("no credential reaches disk through anything recorded", () => {
  /**
   * A credential under every name we redact, at the top level, in a header bag
   * one level down, and nested several levels deep. A body that only ever
   * carried a secret at the top would not have caught round 1's defect.
   */
  function seeded(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      authorization: "Bearer REQ-SECRET",
      "x-api-key": "API-SECRET",
      headers: {
        "proxy-authorization": "Basic PROXY-SECRET",
        cookie: "session=COOKIE-SECRET",
        "set-cookie": "session=SET-COOKIE-SECRET; HttpOnly",
      },
      deep: [{ level2: { level3: { Authorization: "Bearer MCP-SECRET" } } }],
      ...extra,
    };
  }

  test("the sweep finds a planted secret — the control for every assertion below", () => {
    // A sweep that cannot find a planted secret is not evidence. This is the
    // same `leaks` the assertions below rely on, run against text nothing has
    // redacted, and it has to come back with all seven.
    const planted = JSON.stringify({ ...seeded(), note: "HOOK-SECRET" });
    expect(leaks(planted).sort()).toEqual([...SENTINELS].sort());
    expect(planted).not.toMatch(DESCRIPTOR);
  });

  test("both MCP frames are redacted at capture, at every depth", async () => {
    // Round 1's finding 1, reproduced and then fixed: a direct
    // `createRequestLog` drive stored frames holding every sentinel.
    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: seeded(),
    });
    const responseText = JSON.stringify({ jsonrpc: "2.0", id: 3, result: seeded() });

    // The control, on this run's own bytes: what went in really did carry them.
    expect(leaks(requestBody).length).toBeGreaterThan(0);
    expect(leaks(responseText).length).toBeGreaterThan(0);

    const log = createRequestLog({
      fetchImpl: (async () =>
        new Response(`data: ${responseText}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch,
    });
    const response = await log.fetch("http://gateway.invalid/mcp", {
      method: "POST",
      body: requestBody,
      headers: { authorization: "Bearer REQ-SECRET", "x-api-key": "API-SECRET" },
    });
    await response.text();
    await log.flush();

    const entry = log.entries[0]!;
    const stored = JSON.stringify(entry);
    expect(leaks(stored)).toEqual([]);

    // Not an empty capture: the frames are there, the key names are there, and
    // what replaced the values is the descriptor rather than nothing at all.
    expect(entry.requestFrame).toContain('"authorization"');
    expect(entry.requestFrame).toContain('"set-cookie"');
    expect(entry.requestFrame).toContain('"Authorization"');
    expect(entry.requestFrame).toMatch(DESCRIPTOR);
    expect(entry.responseFrame).toMatch(DESCRIPTOR);
    // The scheme survives where there is one; a cookie has none and goes whole.
    expect(entry.requestFrame).toMatch(/"authorization":"Bearer <redacted /);
    expect(entry.requestFrame).toMatch(/"cookie":"<redacted /);
    // And the non-credential parts of the frame are untouched.
    expect(entry.requestFrame).toContain('"method":"tools/list"');
  });

  test("the hook's recorded answer is redacted, even though the answer it sent is not", async () => {
    // Round 1's second reproduction: the decision echoes `ToolkitInfo` **as
    // received**, so a credential in tool metadata travelled straight back out
    // into `responseBody` and onto disk. The gateway still has to receive the
    // real value or it cannot act on the deny, so the redaction is on the
    // record, not on the wire.
    const dir = scratchDir("wire-redact-hook-");
    const logPath = join(dir, "hook-log.jsonl");
    const server = startHookServer({ port: 0, token: HOOK_TOKEN, logPath });
    cleanups.push(() => server.close());

    const payload = {
      user_id: "u-redact",
      toolkits: {
        Gmail: { tools: { SendEmail: [{ version: "1.0.0", metadata: seeded() }] } },
      },
    };
    const sent = await fetch(`${server.url}/access`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HOOK_TOKEN}`,
        "content-type": "application/json",
        cookie: "session=COOKIE-SECRET",
      },
      body: JSON.stringify(payload),
    });
    const answer = await sent.text();

    // The control: the answer that went to the gateway is the real one.
    expect(leaks(answer).length).toBeGreaterThan(0);

    const hits = (await (await fetch(`${server.url}/hits?user_id=u-redact`)).json()) as {
      hits: Loose[];
    };
    const recorded = hits.hits[0]!;
    expect(leaks(JSON.stringify(recorded.responseBody))).toEqual([]);
    expect(leaks(JSON.stringify(recorded.headers))).toEqual([]);
    expect(JSON.stringify(recorded.responseBody)).toMatch(DESCRIPTOR);
    // The deny itself is intact — redaction replaced values, not the decision.
    expect(Object.keys(recorded.responseBody.deny)).toEqual(["Gmail"]);
    // The JSONL copy is the same record, so the crash-surviving file is clean too.
    expect(leaks(JSON.stringify(JSON.parse(readFileSync(logPath, "utf8").trim()).responseBody)))
      .toEqual([]);

    // Redaction copied rather than reached back into the payload it echoes.
    expect(payload.toolkits.Gmail.tools.SendEmail[0]!.metadata.authorization).toBe(
      "Bearer REQ-SECRET",
    );
  });

  test("the boundary is where it was decided, not where it drifted to", async () => {
    // The three surfaces this slice added are redacted by key name. The hook
    // hit's `payload` is not, and that is a ruling rather than a gap: it is the
    // gateway's description of its catalogue, where an `authorization` key
    // names what a tool *requires* rather than a secret it carries, and a
    // key-based rule cannot tell those apart (DESIGN.md decision 17). The
    // protection there is value-based — `RUNBOOK.md` step 10 greps the
    // operator's real key, URL, bearer and tunnel host across the whole
    // evidence directory before anything is committed, with its own positive
    // control at step 10.4.
    //
    // Pinned as a test so the next reader finds a decision instead of
    // rediscovering it as a leak.
    const dir = scratchDir("wire-boundary-");
    const server = startHookServer({ port: 0, token: HOOK_TOKEN, logPath: join(dir, "l.jsonl") });
    cleanups.push(() => server.close());

    await (
      await fetch(`${server.url}/access`, {
        method: "POST",
        headers: { authorization: `Bearer ${HOOK_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          user_id: "u-boundary",
          toolkits: { Gmail: { tools: { SendEmail: [{ version: "1.0.0", metadata: seeded() }] } } },
        }),
      })
    ).text();

    const hit = (
      (await (await fetch(`${server.url}/hits?user_id=u-boundary`)).json()) as { hits: Loose[] }
    ).hits[0]!;

    // Redacted: the answer we sent, and the headers that arrived.
    expect(leaks(JSON.stringify(recordedAnswer(hit)))).toEqual([]);
    // Not redacted, on purpose: the gateway's own catalogue description.
    expect(leaks(JSON.stringify(hit.payload)).length).toBeGreaterThan(0);
  });

  /** The parts of a hit this slice is responsible for redacting. */
  function recordedAnswer(hit: Loose): Loose {
    return { responseStatus: hit.responseStatus, responseBody: hit.responseBody, headers: hit.headers };
  }

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

// ---------------------------------------------------------------------------
// Criterion 4, end to end — the probe must terminate and still write
// ---------------------------------------------------------------------------

/**
 * A gateway that stops talking, driven through the **real probe binary**.
 *
 * Round 2's reviewer found the failure these exist for, and found it the only
 * way it could be found: the direct `createRequestLog` drive settled while the
 * actual probe did not. A unit test that passes while the real thing hangs is
 * worse than no test, so criterion 4's guarantee is asserted where it has to
 * hold — a process that exits, non-zero, with its run file on disk.
 *
 * The bound that makes it exit is `--request-timeout-ms`. Without one the SDK
 * waits `DEFAULT_REQUEST_TIMEOUT_MSEC` (60 s) for a reply that can never
 * arrive: the run still completes and still writes, but a minute of silence per
 * repetition is indistinguishable from a hang to whoever is watching. Measured
 * on this branch and on `main` at `67c8dc4` alike — the wait is the SDK's, not
 * this slice's.
 */
describe("the probe terminates and writes its evidence, whatever the gateway does", () => {
  /** Ways a gateway can stop talking, and the complete stream for contrast. */
  const CLOSINGS = {
    "mid-frame": 'data: {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25"',
    "no reply at all": "",
    "after a partial chunk": "event: message\n",
  } as const;

  /** An MCP endpoint that answers every POST with `body`, then closes. */
  function closingGateway(body: string): { url: string; stop(): void } {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.method !== "POST") return new Response("", { status: 202 });
        await request.text();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (body !== "") controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    cleanups.push(() => server.stop(true));
    return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
  }

  /**
   * Spawns the real probe with a hard ceiling of its own.
   *
   * The ceiling is generous next to the 800 ms request bound and is not the
   * thing under test — it is there so a regression fails this test in seconds
   * instead of hanging the suite, which is the failure mode being guarded
   * against in the first place.
   */
  async function probeAgainst(gatewayUrl: string, ceilingMs = 15_000) {
    const hook = hookServer();
    const out = scratchDir("wire-terminate-out-");
    const child = Bun.spawn(
      [
        "bun", "run", "probe",
        "--protocol", REVISION,
        "--repetitions", "1",
        "--out", out,
        "--quiesce-ms", "20",
        "--poll-interval-ms", "5",
        "--request-timeout-ms", "800",
        "--hook-url", hook.url,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...PINNED_PROBE_ENV,
          ARCADE_API_KEY: "probe-test-key",
          ARCADE_MCP_URL: gatewayUrl,
          HOOK_BEARER_TOKEN: HOOK_TOKEN,
          HOOK_PUBLIC_URL: "https://wire-terminate.example",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    let killed = false;
    const ceiling = setTimeout(() => {
      killed = true;
      child.kill(9);
    }, ceilingMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(ceiling);

    const files = readdirSync(out).filter((name) => name.endsWith(".json"));
    return {
      killed,
      exitCode,
      stdout,
      stderr,
      files,
      runs: files.map((name) => JSON.parse(readFileSync(join(out, name), "utf8")) as Loose),
    };
  }

  for (const [name, body] of Object.entries(CLOSINGS)) {
    test(`a gateway that closes ${name}: the probe exits non-zero and still writes`, async () => {
      const gateway = closingGateway(body);

      const result = await probeAgainst(gateway.url);

      // Termination first, because a hang makes every other assertion moot.
      expect(result.killed, `the probe had to be killed:\n${result.stdout}`).toBe(false);
      expect(result.exitCode).not.toBe(0);
      // …and the evidence is on disk, which is the other half of criterion 4:
      // a run that terminates without writing is a failure nobody can read.
      expect(result.files).toHaveLength(1);

      const run = result.runs[0]!;
      expect(run.schema).toBe(1);
      expect(run.status).toBe("error");
      expect(run.error).not.toBeNull();
      // The request went out and is recorded even though nothing came back —
      // that is the point of recording the outbound direction separately.
      expect((run.requests as Loose[]).length).toBeGreaterThan(0);
      const first = (run.requests as Loose[])[0]!;
      expect(first.method).toBe("initialize");
      expect(typeof first.requestFrame).toBe("string");
      // No reply, said as a measurement rather than as an empty object.
      expect(first.responseFrame).toBeNull();
      // Which kind of nothing it was, named. A truncated frame is bytes we
      // could not read; an empty body and a frame carrying no `data:` line are
      // both "the gateway did not answer".
      expect(first.responseFrameAbsence).toBe(
        name === "mid-frame" ? "unreadable" : "unanswered",
      );
    }, SPAWN_TIMEOUT_MS);
  }

  test("a complete stream still exits 0 — the control for the three above", async () => {
    // Without this, "exits non-zero" could be true of a probe that fails
    // against everything, and the three tests above would prove nothing.
    const hook = hookServer();
    const fake = gateway(hook);

    const result = await runProbe({
      gatewayUrl: fake.url,
      hookUrl: hook.url,
      args: ["--repetitions", "1", "--request-timeout-ms", "5000"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.files).toHaveLength(1);
    const run = result.runs[0]!;
    expect(run.status).toBe("ok");
    const init = (run.requests as Loose[])[0]!;
    expect(init.responseFrameAbsence).toBeNull();
    expect(typeof init.responseFrame).toBe("string");
  }, SPAWN_TIMEOUT_MS);
});
