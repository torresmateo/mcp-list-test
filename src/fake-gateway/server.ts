/**
 * A fake Arcade MCP gateway, for tests that must never touch the network.
 *
 * It is a real Streamable HTTP MCP server (`@modelcontextprotocol/server`) that
 * imitates the one behaviour under measurement: on an MCP request it calls a
 * contextual-access hook some configured number of times, forwarding the
 * caller's user id, and lists only the tools the hook's answer left standing.
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
 *    unfiltered one.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  Server,
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
} from "@modelcontextprotocol/server";
import { readArcadeUserId } from "../client/headers.ts";

/** The MCP endpoint path; `FakeGateway.url` already includes it. */
const MCP_PATH = "/mcp";

/** DESIGN.md decision 6 wants a denied toolkit and a surviving one. */
export const DEFAULT_TOOLS = ["Gmail_SendEmail", "Gmail_ListEmails", "Slack_PostMessage"] as const;

/** Every tool the catalogue reports carries a version, as Arcade's payload does. */
const TOOL_VERSION = "1.0.0";

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

/**
 * The tool names a hook response leaves allowed.
 *
 * The filter is driven by what came back, not by what we sent: a toolkit the
 * hook dropped takes its tools with it. An unusable body allows nothing.
 */
function allowedToolNames(decision: unknown): Set<string> {
  const allowed = new Set<string>();
  if (decision === null || typeof decision !== "object") return allowed;
  const toolkits = (decision as Record<string, unknown>).toolkits;
  if (toolkits === null || typeof toolkits !== "object" || Array.isArray(toolkits)) return allowed;
  for (const [toolkit, value] of Object.entries(toolkits as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const tools = (value as Record<string, unknown>).tools;
    if (tools === null || typeof tools !== "object" || Array.isArray(tools)) continue;
    for (const tool of Object.keys(tools as Record<string, unknown>)) {
      allowed.add(`${toolkit}_${tool}`);
    }
  }
  return allowed;
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
  if (!Number.isInteger(callsPerList) || callsPerList < 0) {
    throw new Error("fake-gateway: hookCallsPerList must be a non-negative integer");
  }
  if (!Number.isInteger(callsPerInitialize) || callsPerInitialize < 0) {
    throw new Error("fake-gateway: hookCallsPerInitialize must be a non-negative integer");
  }

  const hookCalls: HookCall[] = [];

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
          body: JSON.stringify(accessPayload(userId, tools)),
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
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "missing Arcade-User-ID header");
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
      };
    });

    server.setRequestHandler("tools/list", async (_request, ctx) => {
      const userId = requireUserId(ctx.http?.req?.headers ?? new Headers());
      const decision = await callHook("tools/list", userId, callsPerList);
      // No usable answer -> nothing is allowed. Failing open would hand the
      // caller the very tools the hook exists to remove.
      const allowed = allowedToolNames(decision);
      return {
        tools: tools
          .filter(name => allowed.has(name))
          .map(name => ({
            name,
            description: `${name} (fake)`,
            inputSchema: { type: "object" as const, properties: {} },
          })),
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
