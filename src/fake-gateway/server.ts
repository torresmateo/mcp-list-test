/**
 * A fake Arcade MCP gateway, for tests that must never touch the network.
 *
 * It is a real Streamable HTTP MCP server (`@modelcontextprotocol/server`) that
 * imitates the one behaviour under measurement: on an MCP request it calls a
 * contextual-access hook some configured number of times, forwarding the
 * caller's user id, and applies the hook's `AccessHookResult` — `only`, `deny`,
 * or neither — to the tools it lists.
 *
 * It is a measuring instrument, so its honesty rules are explicit:
 *
 *  - **Nothing here is a claim about Arcade.** How many hook calls an
 *    `initialize` or a `tools/list` provokes is *configuration*, not a
 *    discovered fact — DESIGN.md open question 1 ("is `initialize` one of
 *    them?") is answered by the live run, not by this file. Hence
 *    `hookCallsPerInitialize`, defaulting to 0, sitting beside
 *    `hookCallsPerList`: the default is a choice you can see and change, not a
 *    belief baked into the code.
 *  - **Hook calls are serial and awaited.** The probe attributes hits to a
 *    method with a quiescence window, so N overlapping calls would make an
 *    exact count flaky. Every call finishes before the next one starts, and
 *    `hookCalls` records the instants so a test can prove it.
 *  - **Every hook call is observable, including the rejected ones.** A wrong
 *    bearer token leaves the hit count at 0, and so does a gateway that never
 *    calls the hook at all. `hookCalls` carries the HTTP status, which is the
 *    only thing that tells those two apart.
 *  - **It fails loudly.** No user header is an MCP error, not an invented id;
 *    a hook that does not answer 200 yields an empty tool list rather than the
 *    unfiltered one. A hook that *does* answer 200 with neither `only` nor
 *    `deny` is the opposite case and is honoured as the engine documents it —
 *    no change — because that silent fail-open is the bug this harness has to
 *    be able to show.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  Server,
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
} from "@modelcontextprotocol/server";
import { ARCADE_USER_ID_HEADER, readArcadeUserId } from "../client/headers.ts";

/** The MCP endpoint path; `FakeGateway.url` already includes it. */
const MCP_PATH = "/mcp";

/** DESIGN.md decision 6 wants a denied toolkit and a surviving one. */
export const DEFAULT_TOOLS = ["Gmail_SendEmail", "Gmail_ListEmails", "Slack_PostMessage"] as const;

/** Every tool the catalogue reports carries a version, as Arcade's payload does. */
const TOOL_VERSION = "1.0.0";

/**
 * A top-level field on each listed tool that the MCP spec does not name.
 *
 * **Not a claim that Arcade sends this field**, or any field — the name is
 * obviously this fake's. It is here because the v2 *client* parses a
 * `tools/list` result against the spec schema and silently drops every
 * top-level key the spec does not name, so a probe that recorded
 * `client.listTools()` would record a trimmed shape and nothing would say so.
 * A gateway that sends something non-spec is the only way to prove the probe
 * records the wire; what a real gateway actually sends is then whatever it
 * sends, and it survives.
 */
const NON_SPEC_TOOL_FIELD = "fakeGatewayExtension";

/**
 * A field on the **result object itself** that the MCP spec does not name.
 *
 * It is here so the recorded frame is checkable one level up from
 * {@link NON_SPEC_TOOL_FIELD}: a capture that carries `result` whole carries
 * this, and a capture that rebuilt `result` from named fields would not.
 *
 * **Measured against the v2 client on 2026-09-19, so the two fields are not
 * interchangeable evidence.** Given a reply whose `result` carries this key and
 * whose tool entries carry {@link NON_SPEC_TOOL_FIELD}, `client.listTools()`
 * hands the caller result keys `["tools", "fakeGatewayResultExtension"]` and
 * tool keys `["name", "description", "inputSchema"]`. The client keeps what the
 * spec does not name on the result object and **drops it inside each entry** —
 * which is the loss issue #26 measured for `arcadeToolkit`, and it is the
 * tool-level field, not this one, that tells a frame apart from the SDK's view
 * of the same reply. What only a frame can carry either way is the JSON-RPC
 * envelope: `jsonrpc` and `id` never reach the caller at all.
 *
 * As with the tool-level field, this is **not a claim that Arcade sends it** —
 * the name is obviously this fake's.
 */
const NON_SPEC_RESULT_FIELD = "fakeGatewayResultExtension";

export interface StartFakeGatewayOptions {
  /** Listen port. `0` (the default) binds an ephemeral port. */
  port?: number;
  /** Interface to bind. Loopback by default. */
  hostname?: string;
  /**
   * The hook counter: either its base URL (`http://127.0.0.1:1234`) or the
   * access endpoint itself. `/access` is appended when it is missing.
   */
  hookUrl: string;
  /** Bearer the gateway presents to the hook. Wrong on purpose in some tests. */
  hookToken: string;
  /** Hook calls per `tools/list`. Default 1 — DESIGN.md decision 1's baseline. */
  hookCallsPerList?: number;
  /**
   * Hook calls per `initialize`. Default 0. Configurable on purpose: whether
   * the real gateway calls the hook on `initialize` is an open question, and a
   * fake that hard-wired "no" would quietly answer it.
   */
  hookCallsPerInitialize?: number;
  /**
   * Version returned in the `initialize` result regardless of what the client
   * asked for — a gateway pinned to one revision. Omit to echo the client's
   * request, which is what a server that supports everything does.
   */
  protocolVersion?: string;
  /** Tool names, `Toolkit_Tool`. Defaults to {@link DEFAULT_TOOLS}. */
  tools?: readonly string[];
  /**
   * The tools this gateway submits to the access hook. Defaults to `tools` —
   * every tool it can list, which is what a gateway that consults access
   * control about its whole catalogue does.
   *
   * It is configurable because the live run of 2026-09-19 showed a gateway that
   * does not: it listed 42 tools while offering the hook 40, so two tools were
   * never submitted to access control and no policy could have denied them
   * (DESIGN.md decision 18). A fake that could only ever offer its whole
   * catalogue would leave that shape — the one `toolsNotOfferedToHook` exists
   * to name — untestable.
   *
   * Tools left out are still listed: the decision is applied against the whole
   * catalogue, so a tool the hook never heard about survives every `deny`.
   * That is precisely the finding.
   */
  toolsOfferedToHook?: readonly string[];
  /**
   * Tools per `tools/list` page. Omit (the default) to answer in one page with
   * no `nextCursor`, which is what every existing caller gets.
   *
   * It exists because "one `tools/list` call" and "one outbound `tools/list`
   * request" are not the same thing: the v2 client walks pagination itself, so
   * a client-side count of hook hits per *call* can be three pages' worth. A
   * fake that could only ever answer in one page would leave that distinction
   * untestable, and a probe that reported pages it never observed would look
   * exactly like one that observed them correctly.
   */
  pageSize?: number;
}

/** One outbound hook call, whatever became of it. */
export interface HookCall {
  /** 1-based, in the order the gateway issued them. */
  sequence: number;
  /** The MCP method that provoked it: `initialize` or `tools/list`. */
  method: string;
  /** The user id forwarded as `user_id`, read from the Arcade user header. */
  userId: string;
  /** Epoch ms when the request went out. */
  startedAt: number;
  /** Epoch ms when the response (or the failure) came back. */
  finishedAt: number;
  /** HTTP status, or `null` if the request never got one (connection refused). */
  status: number | null;
  /** True only for a 200 whose body the gateway could use as a decision. */
  accepted: boolean;
  /** Transport-level failure message, when `status` is `null`. */
  error?: string;
}

export interface FakeGateway {
  /** Full MCP endpoint, e.g. `http://127.0.0.1:52341/mcp`. */
  url: string;
  /** The port actually bound, which is what you want when `port` was 0. */
  port: number;
  /** Every hook call this gateway issued, in order. */
  readonly hookCalls: readonly HookCall[];
  /** The `cursor` of every `tools/list` it served, `null` for a first page. */
  readonly listCursors: readonly (string | null)[];
  /** Stops listening and closes every open MCP session. */
  close(): Promise<void>;
}

/** `Gmail_SendEmail` -> `{ toolkit: "Gmail", tool: "SendEmail" }`. */
function splitToolName(name: string): { toolkit: string; tool: string } {
  const separator = name.indexOf("_");
  if (separator <= 0 || separator === name.length - 1) {
    throw new Error(`fake-gateway: tool name must be Toolkit_Tool, got ${JSON.stringify(name)}`);
  }
  return { toolkit: name.slice(0, separator), tool: name.slice(separator + 1) };
}

/** The access-hook request body, DESIGN.md Contracts -> Hook counter HTTP API. */
function accessPayload(userId: string, tools: readonly string[]): Record<string, unknown> {
  const toolkits: Record<string, { tools: Record<string, { version: string }[]> }> = {};
  for (const name of tools) {
    const { toolkit, tool } = splitToolName(name);
    const entry = (toolkits[toolkit] ??= { tools: {} });
    (entry.tools[tool] ??= []).push({ version: TOOL_VERSION });
  }
  return { user_id: userId, toolkits };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tool names a `Toolkits` map names, as `Toolkit_Tool`.
 *
 * A toolkit entry whose `tools` map is absent or empty names the toolkit and
 * no tool in it. `wholeToolkits` collects those, because "GitHub, and I am not
 * enumerating its tools" is a statement about the whole toolkit — the caller
 * decides what that means for an `only` and for a `deny`. This hook always
 * sends the `tools` map it received, so for our own responses the two readings
 * coincide; the fallback exists so a hand-written decision in a test is not
 * silently read as naming nothing.
 */
function namedTools(toolkits: unknown): { tools: Set<string>; wholeToolkits: Set<string> } {
  const tools = new Set<string>();
  const wholeToolkits = new Set<string>();
  if (!isPlainObject(toolkits)) return { tools, wholeToolkits };
  for (const [toolkit, value] of Object.entries(toolkits)) {
    const entry = isPlainObject(value) ? value["tools"] : undefined;
    const names = isPlainObject(entry) ? Object.keys(entry) : [];
    if (names.length === 0) wholeToolkits.add(toolkit);
    for (const tool of names) tools.add(`${toolkit}_${tool}`);
  }
  return { tools, wholeToolkits };
}

/** The toolkit half of a `Toolkit_Tool` name; `""` if it is not shaped that way. */
function toolkitOf(name: string): string {
  const separator = name.indexOf("_");
  return separator <= 0 ? "" : name.slice(0, separator);
}

/**
 * The tools a hook decision leaves allowed, read the way Arcade's engine
 * documents `AccessHookResult` (`logic_extensions/http/1.0/schema.yaml`):
 *
 *  - `only` present -> **only** those tools are allowed; `deny` is ignored.
 *  - otherwise `deny` present -> those tools are removed from the catalogue.
 *  - **neither present -> no change: every tool stays allowed.**
 *
 * That last line is the one this gateway exists to reproduce faithfully. The
 * hook used to answer with the request body minus Gmail, which carries neither
 * field: it reads like a deny and means nothing, so the engine left Gmail
 * allowed and nothing crashed. A fake that took the echoed body as the allowed
 * set would keep agreeing with that hook forever while proving nothing — see
 * DESIGN.md decision 6 (amended) and the fail-open test in
 * `test/fake-gateway.test.ts`.
 *
 * The decision is read against `catalogue`, not built from itself: a `deny`
 * naming a tool this gateway never offered changes nothing, which is what
 * "remove from the list" means.
 */
function allowedToolNames(decision: unknown, catalogue: readonly string[]): Set<string> {
  if (!isPlainObject(decision)) return new Set(catalogue);

  const only = decision["only"];
  if (only !== undefined) {
    const { tools, wholeToolkits } = namedTools(only);
    return new Set(
      catalogue.filter(name => tools.has(name) || wholeToolkits.has(toolkitOf(name))),
    );
  }

  const deny = decision["deny"];
  if (deny !== undefined) {
    const { tools, wholeToolkits } = namedTools(deny);
    return new Set(
      catalogue.filter(name => !tools.has(name) && !wholeToolkits.has(toolkitOf(name))),
    );
  }

  // No opinion expressed. Not a failure, and not an excuse to deny: the engine
  // treats this as no change, so the whole catalogue stays listed.
  return new Set(catalogue);
}

function accessEndpoint(hookUrl: string): string {
  const trimmed = hookUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/access") ? trimmed : `${trimmed}/access`;
}

/**
 * Starts the fake gateway and returns its MCP endpoint.
 *
 * ```ts
 * const hook = startHookServer({ port: 0, token, logPath });
 * const gateway = startFakeGateway({ hookUrl: hook.url, hookToken: token, hookCallsPerList: 3 });
 * // point an SDK client at gateway.url, then read hook hits by user id
 * ```
 */
export function startFakeGateway(options: StartFakeGatewayOptions): FakeGateway {
  const hookEndpoint = accessEndpoint(options.hookUrl);
  const hookToken = options.hookToken;
  const callsPerList = options.hookCallsPerList ?? 1;
  const callsPerInitialize = options.hookCallsPerInitialize ?? 0;
  const tools = [...(options.tools ?? DEFAULT_TOOLS)];
  for (const name of tools) splitToolName(name); // fail at startup, not mid-request
  const offeredToHook = [...(options.toolsOfferedToHook ?? tools)];
  for (const name of offeredToHook) splitToolName(name);
  if (!Number.isInteger(callsPerList) || callsPerList < 0) {
    throw new Error("fake-gateway: hookCallsPerList must be a non-negative integer");
  }
  if (!Number.isInteger(callsPerInitialize) || callsPerInitialize < 0) {
    throw new Error("fake-gateway: hookCallsPerInitialize must be a non-negative integer");
  }

  const pageSize = options.pageSize;
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
    throw new Error("fake-gateway: pageSize must be a positive integer");
  }

  const hookCalls: HookCall[] = [];
  const listCursors: (string | null)[] = [];

  /**
   * Issues `times` hook calls, one after another, and returns the last usable
   * response body. Serial by construction: the loop awaits each call, so two
   * calls can never be in flight at once and the probe's quiescence polling
   * sees a count that only ever steps.
   */
  async function callHook(method: string, userId: string, times: number): Promise<unknown> {
    let lastAccepted: unknown = undefined;
    for (let i = 0; i < times; i += 1) {
      const startedAt = Date.now();
      const record: HookCall = {
        sequence: hookCalls.length + 1,
        method,
        userId,
        startedAt,
        finishedAt: startedAt,
        status: null,
        accepted: false,
      };
      hookCalls.push(record);
      try {
        const response = await fetch(hookEndpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${hookToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(accessPayload(userId, offeredToHook)),
        });
        record.status = response.status;
        const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
        // Drain a rejected body too: leaving it unread keeps the socket busy.
        if (!response.ok) await response.text().catch(() => "");
        record.accepted = response.ok && body !== undefined;
        if (record.accepted) lastAccepted = body;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
      } finally {
        record.finishedAt = Date.now();
      }
    }
    return lastAccepted;
  }

  function requireUserId(headers: Headers): string {
    const userId = readArcadeUserId(headers);
    if (userId === undefined) {
      // Loud, on purpose. Inventing an id here would file the hook hits under
      // a key nobody polls, and the caller would read a plausible 0.
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `missing ${ARCADE_USER_ID_HEADER} header`,
      );
    }
    return userId;
  }

  function createMcpServer(): Server {
    const server = new Server(
      { name: "fake-arcade-gateway", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    // Overrides the SDK's own initialize handler: the SDK echoes the requested
    // version when it recognises it, and a gateway pinned to one revision does
    // not. That pinning is what the probe must detect, so the fake has to be
    // able to do it.
    server.setRequestHandler("initialize", async (request, ctx) => {
      const userId = requireUserId(ctx.http?.req?.headers ?? new Headers());
      await callHook("initialize", userId, callsPerInitialize);
      return {
        protocolVersion: options.protocolVersion ?? request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-arcade-gateway", version: "0.1.0" },
        [NON_SPEC_RESULT_FIELD]: "not named by the MCP spec",
      };
    });

    server.setRequestHandler("tools/list", async (request, ctx) => {
      const userId = requireUserId(ctx.http?.req?.headers ?? new Headers());
      const cursor = request.params?.cursor;
      listCursors.push(typeof cursor === "string" ? cursor : null);
      const decision = await callHook("tools/list", userId, callsPerList);
      // No usable answer at all -> nothing is allowed. That is this gateway's
      // own fail-closed choice for a hook that errored, refused us or was never
      // called, and it is a different case from a hook that answered 200 with
      // no opinion — which `allowedToolNames` reads as "no change".
      const allowed =
        decision === undefined ? new Set<string>() : allowedToolNames(decision, tools);

      // Pagination runs over the whole catalogue and the hook filters each
      // page, which is the order a gateway consulting an access hook per
      // request would use. A page can therefore come back empty while a later
      // one still has tools, and the cursor keeps going.
      const start = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(start) || start < 0 || start > tools.length) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `unknown cursor ${String(cursor)}`);
      }
      const end = pageSize === undefined ? tools.length : Math.min(tools.length, start + pageSize);
      const page = tools.slice(start, end);

      return {
        tools: page
          .filter(name => allowed.has(name))
          .map(name => ({
            name,
            description: `${name} (fake)`,
            inputSchema: { type: "object" as const, properties: {} },
            [NON_SPEC_TOOL_FIELD]: "not named by the MCP spec",
          })),
        ...(end < tools.length ? { nextCursor: String(end) } : {}),
        [NON_SPEC_RESULT_FIELD]: "not named by the MCP spec",
      };
    });

    return server;
  }

  /** One MCP session: its transport, its server, and how to shut both down. */
  interface Session {
    transport: WebStandardStreamableHTTPServerTransport;
    server: Server;
  }
  const sessions = new Map<string, Session>();

  /**
   * Hands the transport a request whose `MCP-Protocol-Version` header it can
   * live with.
   *
   * The SDK transport 400s a header naming a revision it does not implement,
   * and this gateway exists partly to impersonate revisions the SDK has never
   * heard of. Dropping the header makes the transport fall back to the version
   * negotiated at `initialize`, which is the one this gateway chose anyway.
   */
  function withUsableProtocolHeader(request: Request): Request {
    const header = request.headers.get("mcp-protocol-version");
    if (header === null || SUPPORTED_PROTOCOL_VERSIONS.includes(header)) return request;
    const headers = new Headers(request.headers);
    headers.delete("mcp-protocol-version");
    return new Request(request.url, { method: request.method, headers });
  }

  function jsonRpcError(status: number, code: number, message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== MCP_PATH) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const sessionId = request.headers.get("mcp-session-id");
    const forwarded = withUsableProtocolHeader(request);

    if (request.method === "POST") {
      // Read the body here so `initialize` can be recognised before a session
      // exists, then hand the parsed value on: the transport must not try to
      // read a body that has already been consumed.
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonRpcError(400, -32700, "Parse error");
      }
      const isInitialize = Array.isArray(body)
        ? body.some(message => isInitializeRequest(message))
        : isInitializeRequest(body);

      if (sessionId === null && isInitialize) {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: id => {
            sessions.set(id, { transport, server });
          },
          onsessionclosed: id => {
            sessions.delete(id);
          },
        });
        const server = createMcpServer();
        await server.connect(transport);
        return await transport.handleRequest(forwarded, { parsedBody: body });
      }

      const session = sessionId === null ? undefined : sessions.get(sessionId);
      if (session === undefined) {
        return jsonRpcError(404, -32001, "Session not found");
      }
      return await session.transport.handleRequest(forwarded, { parsedBody: body });
    }

    const session = sessionId === null ? undefined : sessions.get(sessionId);
    if (session === undefined) {
      return jsonRpcError(404, -32001, "Session not found");
    }
    return await session.transport.handleRequest(forwarded);
  }

  const hostname = options.hostname ?? "127.0.0.1";
  const httpServer = Bun.serve({
    port: options.port ?? 0,
    hostname,
    fetch: handle,
  });

  const boundPort = httpServer.port;
  if (boundPort === undefined) throw new Error("fake-gateway: no TCP port was bound");

  return {
    url: `http://${hostname}:${boundPort}${MCP_PATH}`,
    port: boundPort,
    hookCalls,
    listCursors,
    async close() {
      // Close the MCP sessions first: a stopped listener would leave their SSE
      // streams open, and a leaked listener is an unreviewed server still running.
      for (const session of sessions.values()) {
        await session.server.close().catch(() => {});
      }
      sessions.clear();
      await httpServer.stop(true);
    },
  };
}
