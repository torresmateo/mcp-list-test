/**
 * The fake gateway, driven the way the probe will drive it: a real SDK client
 * over Streamable HTTP, a real hook counter on the other side, and nothing
 * mocked in between. Slice #4 measures hook fires through this pair, so a fake
 * that lied here would make #4 green while measuring nothing.
 *
 * Three rules shape the file:
 *
 *  - **Ephemeral ports.** Both servers bind port 0. `$PORT_WEB` belongs to the
 *    operator's hook server and to the other worktrees; a test that waited for
 *    it would fail whenever somebody else was working.
 *  - **Nothing is inherited from the environment.** `bun test` does not load
 *    `.env.local`, and an explicitly-set variable beats it even when empty, so
 *    every token and id used here is a literal defined in this file.
 *  - **A zero is never the whole assertion.** "The hook was not called" and
 *    "the hook rejected the call" both leave the count at 0, so wherever a
 *    count of 0 is the expectation the test also asserts the HTTP status the
 *    gateway saw.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  LATEST_PROTOCOL_VERSION,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { ARCADE_USER_ID_HEADER, arcadeUserHeaders } from "../src/client/headers.ts";
import { type FakeGateway, startFakeGateway } from "../src/fake-gateway/server.ts";
import { type HookServer, startHookServer } from "../src/hook-server/server.ts";

const HOOK_TOKEN = "hook-token-for-fake-gateway-tests";

/** Shapes these tests know, from DESIGN.md Contracts. `any` keeps them readable. */
type Loose = Record<string, any>;
interface HitsResponse {
  count: number;
  hits: { receivedAt: string; payload: Loose }[];
}

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  // Close in reverse order of creation, and never leave a listener behind: the
  // reviewer holds a different port block, and a leaked server is a live
  // instance of unreviewed code.
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A hook counter on an ephemeral port, logging to a temp file it owns. */
function hookServer(): HookServer {
  const dir = mkdtempSync(join(tmpdir(), "fake-gateway-hook-"));
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

/** A fake gateway pointed at `hook`, torn down with the test. */
function gateway(
  hook: HookServer,
  options: Partial<Parameters<typeof startFakeGateway>[0]> = {},
): FakeGateway {
  const fake = startFakeGateway({
    port: 0,
    hookUrl: hook.url,
    hookToken: HOOK_TOKEN,
    ...options,
  });
  cleanups.push(() => fake.close());
  return fake;
}

/**
 * A stand-in hook that answers `POST /access` with a body a test chose.
 *
 * The real hook counter can only ever answer the one thing its policy says, so
 * the *shape* of the answer is not a variable there. Here it is: these tests
 * are about how the gateway reads an `AccessHookResult`, including the shapes
 * a wrong hook would send.
 */
interface StubHook {
  url: string;
  /** Every body this stub received, parsed — proof the gateway really called it. */
  readonly received: readonly Loose[];
}

function stubHook(answer: (request: Loose) => unknown): StubHook {
  const received: Loose[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/access" || request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as Loose;
      received.push(body);
      return new Response(JSON.stringify(answer(body)), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, received };
}

/** A fake gateway pointed at an arbitrary hook URL, torn down with the test. */
function gatewayOn(hookUrl: string): FakeGateway {
  const fake = startFakeGateway({ port: 0, hookUrl, hookToken: HOOK_TOKEN });
  cleanups.push(() => fake.close());
  return fake;
}

/** The tool names a client actually sees, which is the only evidence that counts. */
async function listedTools(fake: FakeGateway, userId: string): Promise<string[]> {
  const { client } = await connectedClient(fake, userId);
  return (await client.listTools()).tools.map(tool => tool.name);
}

/** Every outbound HTTP request an SDK client made, for header-level evidence. */
interface Wire {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The request body as sent, so a handshake can be read off the wire. */
  body?: string;
}

/** A connected SDK client sending `userId` in the Arcade user header. */
async function connectedClient(fake: FakeGateway, userId: string) {
  const { client, wire, connect } = sdkClient(fake, userId);
  await connect();
  return { client, wire };
}

function sdkClient(
  fake: FakeGateway,
  userId: string | undefined,
  clientOptions?: ConstructorParameters<typeof Client>[1],
) {
  const wire: Wire[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(fake.url), {
    requestInit: userId === undefined ? {} : { headers: arcadeUserHeaders(userId) },
    fetch: async (url, init) => {
      wire.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return await fetch(url, init);
    },
  });
  const client = new Client({ name: "fake-gateway-test-client", version: "0.1.0" }, clientOptions);
  cleanups.push(async () => {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  });
  return { client, wire, connect: () => client.connect(transport) };
}

async function hits(hook: HookServer, userId: string): Promise<HitsResponse> {
  const response = await fetch(`${hook.url}/hits?user_id=${encodeURIComponent(userId)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as HitsResponse;
}

async function count(hook: HookServer, userId: string): Promise<number> {
  return (await hits(hook, userId)).count;
}

/**
 * A raw `initialize`, bypassing the SDK client.
 *
 * Needed because the SDK client refuses a negotiated version it does not
 * implement, which is exactly the case criterion 5 configures. The wire is
 * where the `initialize` result actually lives.
 */
async function rawInitialize(
  fake: FakeGateway,
  userId: string | undefined,
  protocolVersion: string,
): Promise<{ status: number; message: Loose }> {
  const response = await fetch(fake.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(userId === undefined ? {} : arcadeUserHeaders(userId)),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "raw-test-client", version: "0.1.0" },
      },
    }),
  });
  return { status: response.status, message: parseJsonRpc(await response.text()) };
}

/** A Streamable HTTP response body is either JSON or one or more SSE frames. */
function parseJsonRpc(body: string): Loose {
  const text = body.trim();
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text) as Loose;
  const frames = text
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice("data:".length).trim())
    .filter(line => line !== "");
  const last = frames.at(-1);
  if (last === undefined) throw new Error(`no JSON-RPC message in response body: ${body}`);
  return JSON.parse(last) as Loose;
}

describe("hook fires per MCP method", () => {
  test("one tools/list with hookCallsPerList: 3 leaves exactly 3 hits for that user", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 3 });
    const { client } = await connectedClient(fake, "u-test");

    await client.listTools();

    expect(await count(hook, "u-test")).toBe(3);
    // The count alone would also be 3 if some other user's calls had landed
    // here, so pin what the gateway actually did and who it did it for.
    expect(fake.hookCalls.map(call => call.method)).toEqual([
      "tools/list",
      "tools/list",
      "tools/list",
    ]);
    expect(fake.hookCalls.map(call => call.status)).toEqual([200, 200, 200]);
    expect(fake.hookCalls.map(call => call.userId)).toEqual(["u-test", "u-test", "u-test"]);
  });

  test("the N hook calls are serial: none starts before the previous one finished", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 5 });
    const { client } = await connectedClient(fake, "u-serial");

    await client.listTools();

    expect(fake.hookCalls).toHaveLength(5);
    for (let i = 1; i < fake.hookCalls.length; i += 1) {
      const previous = fake.hookCalls[i - 1]!;
      const current = fake.hookCalls[i]!;
      expect(current.startedAt).toBeGreaterThanOrEqual(previous.finishedAt);
    }
    // The hook counter agrees: it received them in the same order.
    const received = (await hits(hook, "u-serial")).hits.map(hit => Date.parse(hit.receivedAt));
    expect(received).toHaveLength(5);
    for (let i = 1; i < received.length; i += 1) {
      expect(received[i]!).toBeGreaterThanOrEqual(received[i - 1]!);
    }
  });

  test("initialize alone is 0 hits; the tools/list that follows is 1", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerList: 1 });
    const { client } = await connectedClient(fake, "u-init");

    // connect() has already sent initialize and notifications/initialized, and
    // the gateway awaits its hook calls inside the request, so a 0 here cannot
    // be a call still in flight.
    expect(await count(hook, "u-init")).toBe(0);
    expect(fake.hookCalls).toHaveLength(0);

    await client.listTools();

    expect(await count(hook, "u-init")).toBe(1);
    expect(fake.hookCalls.map(call => call.method)).toEqual(["tools/list"]);
  });

  test("initialize calling the hook is configuration, not a fact baked into the fake", async () => {
    // DESIGN.md open question 1 — "is `initialize` one of them?" — is still
    // open, and the live run in #6 answers it. A fake that hard-wired "no"
    // would have answered it here by accident.
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerInitialize: 2, hookCallsPerList: 1 });
    await connectedClient(fake, "u-init-hook");

    expect(await count(hook, "u-init-hook")).toBe(2);
    expect(fake.hookCalls.map(call => call.method)).toEqual(["initialize", "initialize"]);
  });
});

describe("the hook's answer decides the tool list", () => {
  test("tools/list drops every Gmail_ tool and keeps Slack_PostMessage", async () => {
    const hook = hookServer();
    const fake = gateway(hook);
    const { client } = await connectedClient(fake, "u-tools");

    const listed = (await client.listTools()).tools.map(tool => tool.name);

    expect(listed.filter(name => name.startsWith("Gmail_"))).toEqual([]);
    expect(listed).toContain("Slack_PostMessage");
    // An empty Gmail list proves nothing on its own — it is what a gateway
    // that never offered Gmail would also produce. The hook payload shows both
    // toolkits went in, so the absence is the hook's doing.
    const payload = (await hits(hook, "u-tools")).hits[0]!.payload;
    expect(Object.keys(payload.toolkits).sort()).toEqual(["Gmail", "Slack"]);
    expect(Object.keys(payload.toolkits.Gmail.tools).sort()).toEqual(["ListEmails", "SendEmail"]);
    expect(payload.user_id).toBe("u-tools");
    expect(listed).toEqual(["Slack_PostMessage"]);
  });
});

describe("protocol version negotiation", () => {
  test("a gateway pinned to 2025-11-05 answers 2025-11-05 to a client asking 2025-11-25", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { protocolVersion: "2025-11-05" });

    const { status, message } = await rawInitialize(fake, "u-version", LATEST_PROTOCOL_VERSION);

    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(status).toBe(200);
    expect(message.result.protocolVersion).toBe("2025-11-05");
  });

  test("the SDK client sees the pinned 2025-11-05 and refuses it", async () => {
    // The SDK client requests LATEST (2025-11-25) and rejects a negotiated
    // version it does not implement. The rejection naming 2025-11-05 is the
    // client seeing it — a silent downgrade would be the failure mode here.
    const hook = hookServer();
    const fake = gateway(hook, { protocolVersion: "2025-11-05" });
    const { connect } = sdkClient(fake, "u-version-sdk");

    await expect(connect()).rejects.toThrow(/2025-11-05/);
  });

  test("a pinned version the client does implement is used for every later request", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { protocolVersion: "2025-06-18", hookCallsPerList: 1 });
    const { client, wire } = await connectedClient(fake, "u-version-ok");

    await client.listTools();

    const initialize = wire.find(entry => entry.method === "POST")!;
    expect(initialize.headers[ARCADE_USER_ID_HEADER.toLowerCase()]).toBe("u-version-ok");
    const afterInitialize = wire.filter(entry => "mcp-protocol-version" in entry.headers);
    expect(afterInitialize.length).toBeGreaterThan(0);
    for (const entry of afterInitialize) {
      expect(entry.headers["mcp-protocol-version"]).toBe("2025-06-18");
    }
    expect(await count(hook, "u-version-ok")).toBe(1);
  });
});

describe("protocol era", () => {
  test("a client with default options lands on the legacy era and still sends initialize", async () => {
    // DESIGN.md decision 15: `legacy` is the era that opens with the
    // `initialize` handshake, and it is what this project measures today. The
    // v2 SDK can also speak the modern era, so "we are still on legacy" has to
    // be asserted rather than assumed after the migration.
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerInitialize: 1 });
    const { client, wire } = await connectedClient(fake, "u-era-default");

    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
    // An era label alone could be a default the client never tested. These are
    // the handshake itself: the bytes the client put on the wire, and the
    // gateway's own `initialize` handler running (it charged a hook call).
    const methods = wire
      .filter(entry => entry.body !== undefined)
      .map(entry => parseJsonRpc(entry.body!).method);
    expect(methods).toContain("initialize");
    expect(methods).not.toContain("server/discover");
    expect(fake.hookCalls.map(call => call.method)).toEqual(["initialize"]);
  });

  test("a client pinned to 2026-07-28 fails era negotiation against this legacy-only gateway", async () => {
    // The door is open on the client side and shut on ours: `2026-07-28` is
    // reachable through `versionNegotiation`, and the fake does not serve it.
    // DESIGN.md decision 15 defers the modern era; this records where it stands
    // rather than implementing it.
    const hook = hookServer();
    const fake = gateway(hook);
    const { connect } = sdkClient(fake, "u-era-pinned", {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });

    const thrown: unknown = await connect().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(SdkError.isInstance(thrown)).toBe(true);
    expect((thrown as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
    expect((thrown as Error).message).toContain("2026-07-28");
    // Pinning fails loudly instead of quietly downgrading: no era was adopted.
    expect(fake.hookCalls).toEqual([]);
  });
});

describe("the bearer token the gateway presents to the hook", () => {
  test("a wrong token is a rejected call, not a call that never happened", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookToken: "not-the-hook-token", hookCallsPerList: 2 });
    const { client } = await connectedClient(fake, "u-badtoken");

    const listed = (await client.listTools()).tools.map(tool => tool.name);

    // The count stays 0 — but so it would if the gateway never called the
    // hook, which is the bug this test exists to rule out. The 401s are what
    // separate the two.
    expect(await count(hook, "u-badtoken")).toBe(0);
    expect(fake.hookCalls.map(call => call.status)).toEqual([401, 401]);
    expect(fake.hookCalls.every(call => call.accepted)).toBe(false);
    // No usable decision means nothing is allowed: failing open would list the
    // Gmail tools the hook exists to remove.
    expect(listed).toEqual([]);
  });

  test("the same gateway with the right token is accepted, on the same hook server", async () => {
    // The control for the test above: the 401s were the token, not the wiring.
    const hook = hookServer();
    const wrong = gateway(hook, { hookToken: "not-the-hook-token", hookCallsPerList: 2 });
    const right = gateway(hook, { hookCallsPerList: 2 });

    const badClient = await connectedClient(wrong, "u-control-bad");
    await badClient.client.listTools();
    const goodClient = await connectedClient(right, "u-control-good");
    const listed = (await goodClient.client.listTools()).tools.map(tool => tool.name);

    expect(wrong.hookCalls.map(call => call.status)).toEqual([401, 401]);
    expect(right.hookCalls.map(call => call.status)).toEqual([200, 200]);
    expect(await count(hook, "u-control-bad")).toBe(0);
    expect(await count(hook, "u-control-good")).toBe(2);
    expect(listed).toEqual(["Slack_PostMessage"]);
  });
});

describe("a missing user header", () => {
  test("is an error, not an invented user id and a plausible zero", async () => {
    const hook = hookServer();
    const fake = gateway(hook, { hookCallsPerInitialize: 1, hookCallsPerList: 1 });

    const { message } = await rawInitialize(fake, undefined, LATEST_PROTOCOL_VERSION);

    expect(message.error.message).toContain(ARCADE_USER_ID_HEADER);
    expect(fake.hookCalls).toHaveLength(0);
  });
});

describe("the fail-open trap: neither `only` nor `deny` means no change (issue #21)", () => {
  /**
   * The bug this slice fixes, pinned from the outside.
   *
   * The hook used to answer with the request body minus Gmail. To a human that
   * reads like a deny. Per `AccessHookResult` it carries neither `only` nor
   * `deny`, which the engine defines as *no change* — so every tool stayed
   * allowed, Gmail included. It failed open, silently, and nothing crashed.
   *
   * The happy-path assertion ("Gmail is not listed") passed before this slice
   * and passes after it, so it never protected anything. These tests are the
   * ones that tell the two apart, and they run against the tool list a client
   * is rendered, not against what the hook returned.
   */
  test("the old filtered-echo answer leaves Gmail listed — it expressed no deny at all", async () => {
    const hook = stubHook(request => {
      // Verbatim the pre-#21 hook: the request body with Gmail removed.
      const toolkits = Object.fromEntries(
        Object.entries(request.toolkits as Loose).filter(([name]) => !/^gmail$/i.test(name)),
      );
      return { ...request, toolkits };
    });
    const fake = gatewayOn(hook.url);

    const listed = await listedTools(fake, "u-echo");

    // The hook was called and it did answer 200 — this is not a silent no-op.
    expect(hook.received).toHaveLength(1);
    expect(Object.keys(hook.received[0]!.toolkits as Loose).sort()).toEqual(["Gmail", "Slack"]);
    expect(fake.hookCalls.map(call => call.status)).toEqual([200]);
    expect(fake.hookCalls.every(call => call.accepted)).toBe(true);
    // And Gmail is still listed. That is the whole bug.
    expect(listed).toEqual(["Gmail_SendEmail", "Gmail_ListEmails", "Slack_PostMessage"]);
  });

  test("an empty `{}` answer — criterion 2's no-Gmail case — also leaves every tool listed", async () => {
    // Deliberate, and the reason the hook's empty answer is pinned by its own
    // test: `{}` means "no opinion", and the gateway has to honour that rather
    // than inventing a deny out of a blank.
    const hook = stubHook(() => ({}));
    const fake = gatewayOn(hook.url);

    expect(await listedTools(fake, "u-empty")).toEqual([
      "Gmail_SendEmail",
      "Gmail_ListEmails",
      "Slack_PostMessage",
    ]);
    expect(fake.hookCalls.map(call => call.status)).toEqual([200]);
  });

  test("the real hook counter, same gateway and catalogue, does remove Gmail", async () => {
    // The control for the two above: the difference is the shape of the answer,
    // not the wiring. This one goes through `deny`.
    const hook = hookServer();
    const fake = gateway(hook);

    expect(await listedTools(fake, "u-real-hook")).toEqual(["Slack_PostMessage"]);
  });
});

describe("the gateway consumes an AccessHookResult the way the engine documents it", () => {
  test("`deny` removes the named toolkit's tools and leaves the rest", async () => {
    const hook = stubHook(request => ({
      deny: { Gmail: (request.toolkits as Loose).Gmail },
    }));
    const fake = gatewayOn(hook.url);

    expect(await listedTools(fake, "u-deny")).toEqual(["Slack_PostMessage"]);
  });

  test("`deny` is read at tool level: naming one tool leaves its sibling listed", async () => {
    // Proof the gateway reads the `ToolkitInfo` it was handed rather than
    // treating any mention of a toolkit as a blanket deny. Our hook always
    // sends the whole `tools` map, so this distinction is invisible against it.
    const hook = stubHook(() => ({
      deny: { Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } } },
    }));
    const fake = gatewayOn(hook.url);

    expect(await listedTools(fake, "u-deny-one")).toEqual([
      "Gmail_ListEmails",
      "Slack_PostMessage",
    ]);
  });

  test("`only` wins over `deny`, as the schema says it does", async () => {
    // "If 'only' is included, ONLY those are allowed (deny list ignored)."
    // A gateway that applied both would deny Gmail_SendEmail here and list
    // nothing, which is a plausible-looking wrong answer.
    const hook = stubHook(() => ({
      only: { Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } } },
      deny: { Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } } },
    }));
    const fake = gatewayOn(hook.url);

    expect(await listedTools(fake, "u-only")).toEqual(["Gmail_SendEmail"]);
  });

  test("a hook that never answers 200 still lists nothing", async () => {
    // Unchanged, and a different case from "answered 200 with no opinion": a
    // hook we could not consult is not a hook that allowed everything.
    const hook = hookServer();
    const fake = gateway(hook, { hookToken: "not-the-hook-token" });

    expect(await listedTools(fake, "u-unreachable")).toEqual([]);
    expect(fake.hookCalls.map(call => call.status)).toEqual([401]);
  });
});
