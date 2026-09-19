/**
 * The logging `fetch` wrapper — DESIGN.md decision 4.
 *
 * It sits at the transport boundary, which is the only place that sees what
 * the client *actually* put on the wire. Everything above it is the SDK's
 * business: the SDK may page a `tools/list`, retry, or reconnect, and each of
 * those is one more outbound JSON-RPC request. A count taken anywhere higher
 * up would report "one list call" where three requests went out, and a reader
 * would have no way to tell.
 *
 * Five things it records that a naive wrapper would not:
 *
 *  - **Completion, not just dispatch.** `fetch` resolves when the response
 *    *headers* arrive, which on a Streamable HTTP SSE response is before the
 *    result frame — and the gateway's hook round trips finish before that
 *    frame, not before the headers. Timing taken at header time would miss the
 *    hook's share of the latency, and a hook-counter snapshot taken then would
 *    attribute one request's hits to the next one. So the response body is
 *    piped through an observer that reports the instant the reply to *this*
 *    request came back.
 *  - **The negotiated protocol version, off the wire.** The `initialize`
 *    result carries it. Reading it here means the probe does not depend on how
 *    the client reports — or rejects — a revision it does not implement.
 *  - **The `tools/list` result, as the gateway sent it.** DESIGN.md decision 18
 *    wants the MCP side of the session recorded, not only a count of it, and
 *    "as the gateway returned it" has to mean the wire. The v2 client parses a
 *    result against the spec schema and **drops every field of a tool entry
 *    that the spec does not name**: a tool sent as
 *    `{ name, description, inputSchema, arcadeToolkit }` reaches the caller
 *    without `arcadeToolkit`, silently. Reading the entries here, off the same
 *    frames the reply is observed in, is the only way the recorded result is
 *    the gateway's and not the SDK's idea of it — and a vendor field is exactly
 *    what the engine team would want to see.
 *  - **Which identity headers went out.** Header names and the user id only,
 *    never the API key. An absent `Arcade-User-Id` makes the gateway file its
 *    hook hits under a key nobody polls, and the probe would print a clean,
 *    wrong zero; recording what was sent is what tells "the hook never fired"
 *    apart from "we never identified ourselves".
 *  - **Both MCP frames, whole.** DESIGN.md decision 19: the JSON-RPC request
 *    the client sent and the JSON-RPC reply that came back, per request. The
 *    reply frame cannot be rebuilt higher up, for two measured reasons. The
 *    JSON-RPC envelope — `jsonrpc` and `id` — never reaches the caller at all,
 *    so a "frame" assembled above the transport is not one. And the loss above
 *    applies inside it: a reply whose tool entries carry a non-spec key reaches
 *    the caller with those entries trimmed to `name`, `description`,
 *    `inputSchema`. (The result *object's* own non-spec keys do survive the v2
 *    parse — measured 2026-09-19 — so they are not what tells a frame apart
 *    from the SDK's view; the per-entry loss and the envelope are.)
 *
 * The body is piped rather than cloned on purpose. A cloned branch that is
 * read only as far as the reply frame and then abandoned stalls the branch the
 * transport is reading, and the session goes silent on the *next* request —
 * a failure that looks nothing like its cause. Piping leaves the transport in
 * charge of reading, exactly as it would be with no wrapper at all.
 *
 * **The frame capture lives inside that same pass-through, and adds no second
 * reader and no wait.** `observe` already had to decode every chunk to spot the
 * reply, so recording the frame it just parsed costs one assignment. Nothing
 * here clones the response, nothing buffers ahead of the consumer, and nothing
 * awaits: `transform` enqueues each chunk *before* it looks at it, so the
 * transport receives every byte at the moment it arrives whatever the capture
 * does with it, and back-pressure stays the transport's. A chunked or streamed
 * body therefore terminates exactly as it did before this capture existed —
 * the stream ends when the server ends it, `flush` runs on that end, and a body
 * that ends without a matching reply settles the request with
 * `responseObserved: false` and a `responseFrame` of `null` rather than hanging.
 *
 * Because the transport only reads after this function returns, the hook
 * snapshot for a request cannot be taken inside the call that made it. It is
 * taken at the start of the *next* outbound call — notifications included, so
 * `notifications/initialized` cannot slip its hits into `initialize`'s
 * snapshot — and by {@link RequestLog.flush} at the end of an operation.
 */
import { redactJsonText, splitTopLevelJsonArray } from "../redact.ts";
import { readArcadeUserId } from "./headers.ts";

/** A JSON-RPC id as it appears on the wire. */
export type JsonRpcId = string | number;

/**
 * An SSE line terminator. The spec allows CRLF, LF **or** a bare CR, and a
 * `split("\n")` would leave a stray `\r` on the end of every line of a CRLF
 * stream — enough to make `startsWith("data:")` still work and the payload
 * quietly wrong.
 */
const EOL = /\r\n|\r|\n/;

/**
 * A blank line: one terminator immediately followed by another, in every
 * combination the spec permits.
 *
 * The alternatives are longest-first so that a CRLF pair is consumed as one
 * terminator rather than as two — `(?:\r\n|\r|\n){2}` would match a single
 * `\r\n` and cut every CRLF stream in half at the first line break.
 *
 * A boundary can straddle a chunk, and the scan can then match a **shorter**
 * boundary than the one that was coming — `\r\n\r` at the end of a buffer whose
 * next chunk starts with `\n`. That is harmless and cannot corrupt a message:
 * the only characters this matches are line terminators, an unescaped one
 * cannot appear inside a `data:` line, so the leftover terminator merely opens
 * the next frame with an empty line, which carries nothing.
 *
 * Only searched for from the start of the buffer, so no `g` flag — a sticky
 * `lastIndex` across calls would skip frames.
 */
const FRAME_BOUNDARY = /\r\n\r\n|\r\n\r|\r\n\n|\n\r\n|\r\r\n|\n\n|\r\r|\n\r/;

/**
 * One entry of a `tools/list` result, exactly as it arrived on the wire.
 *
 * The index signature is the courier rule this project applies to every
 * recorded payload: `name` is the only field anything here reads, and whatever
 * else the gateway chose to send travels through untouched. Naming the rest
 * would start trimming the evidence, which is the failure mode that made this
 * capture necessary in the first place.
 *
 * `name` is typed as a string because that is what the protocol says; an entry
 * that arrived without one is still recorded, so readers that match on names
 * check the type rather than assume it.
 */
export interface ListedTool {
  name: string;
  [field: string]: unknown;
}

/** One outbound JSON-RPC request, with everything observed about it. */
export interface OutboundRequest {
  /** 0-based position in this session's log, independent of the wire id. */
  index: number;
  /** The JSON-RPC id exactly as sent. */
  jsonRpcId: JsonRpcId;
  /** `initialize`, `tools/list`, … */
  method: string;
  /**
   * The JSON-RPC request frame as it went out: **the raw text**, with
   * credential values redacted in place.
   *
   * Text, not a parsed object, and that is the whole point. A frame that has
   * been through `JSON.parse` and back out again has already lost the thing
   * this capture exists to show — a duplicate key collapses to its last
   * occurrence, whitespace is normalised, and what you store is your
   * serialiser's idea of the message rather than the message. The parse this
   * wrapper does is for matching an `id` and a method and nothing else; it is
   * deliberately not the thing that gets stored.
   *
   * Taken from the body the wrapper was handed, before it reached the network —
   * there is no earlier point, and no later one either: the transport hands
   * `fetch` a serialised body and keeps nothing.
   *
   * When one HTTP call carries a JSON-RPC *batch*, each request in it is one
   * entry and each entry carries the source slice of its own message, so a row
   * is never shown a frame that is not its own.
   */
  requestFrame: string;
  /**
   * The JSON-RPC reply frame for this request — the raw text as it arrived,
   * credential values redacted in place — or `null` when the stream ended
   * without one.
   *
   * `null` is a measurement — "no reply to this id was seen" — and is the same
   * condition `responseObserved: false` reports. It is never an empty object:
   * a `{}` here would read as a gateway that answered with nothing.
   */
  responseFrame: string | null;
  /** `params.cursor`, present only when this request followed a cursor. */
  cursor?: string;
  /** ISO-8601 instant the request left the client. */
  sentAt: string;
  /** ISO-8601 instant its reply was observed on the wire. */
  finishedAt: string;
  /** Client-observed round trip in milliseconds, hook round trips included. */
  durationMs: number;
  /** HTTP status of the response carrying it. */
  status: number;
  /** The Arcade user header value as sent, or `null` when it was absent. */
  userIdHeader: string | null;
  /** `Authorization` scheme only — never the credential itself. */
  authorizationScheme: string | null;
  /**
   * `false` when the stream ended without a reply carrying this request's id.
   * `durationMs` is then how long the stream lasted, not a round trip.
   */
  responseObserved: boolean;
  /** Cumulative hook hits for this user id after this request; `null` until snapshotted. */
  hookHitsAfter: number | null;
}

export interface RequestLogOptions {
  /**
   * Called once per outbound JSON-RPC request, after its reply has been seen
   * and before the next request leaves the client. This is where the
   * quiescence snapshot happens, so hits are attributed to the request that
   * caused them and not to the one after it.
   */
  onRequestComplete?: (request: OutboundRequest) => Promise<void>;
  /** Underlying fetch. Injectable for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
}

export interface RequestLog {
  /** Every outbound JSON-RPC request, in the order it was sent. */
  readonly entries: readonly OutboundRequest[];
  /**
   * `result.protocolVersion` from the `initialize` reply, read off the wire.
   * `undefined` until one has been seen.
   */
  readonly negotiatedProtocolVersion: string | undefined;
  /**
   * Every `result.tools` entry seen in a reply to one of this session's own
   * requests, concatenated in the order the replies arrived — so a paged
   * `tools/list` reads as one list, page by page, exactly as the client
   * assembled it.
   */
  readonly listedTools: readonly ListedTool[];
  /** The wrapping fetch to hand to the transport. */
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /**
   * Settles every request whose reply has arrived but whose hook snapshot has
   * not been taken yet. Call it once an operation has returned; the wrapper
   * calls it itself before each new outbound request.
   */
  flush(): Promise<void>;
}

interface ParsedRequest {
  id: JsonRpcId;
  method: string;
  cursor?: string;
  /** The source text of this message, redacted. Never a re-serialisation of it. */
  frame: string;
}

/** The JSON-RPC *requests* in a body; notifications and responses are not requests. */
function jsonRpcRequestsIn(body: unknown): ParsedRequest[] {
  if (typeof body !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  // The source text of each message, sliced rather than re-serialised. A batch
  // splits into its elements; a single message is the whole body. The two
  // arrays are built from the same value, so index `n` of one is index `n` of
  // the other.
  const sources = (Array.isArray(parsed) ? splitTopLevelJsonArray(body) : null) ?? [body];
  const requests: ParsedRequest[] = [];
  for (const [position, message] of messages.entries()) {
    if (message === null || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const id = record["id"];
    const method = record["method"];
    // A notification has a method and no id; a response has an id and no
    // method. Only a request has both, and only requests are what decision 4
    // counts.
    if (typeof method !== "string") continue;
    if (typeof id !== "string" && typeof id !== "number") continue;
    const params = record["params"];
    const cursor =
      params !== null && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)["cursor"]
        : undefined;
    requests.push({
      id,
      method,
      ...(typeof cursor === "string" ? { cursor } : {}),
      // Redacted here, on the way in, so no unredacted copy is ever held: this
      // is the only value that travels on to the entry. A batch whose element
      // slices could not be recovered falls back to the whole body, which is
      // still the text that went out and is never another message's.
      frame: redactJsonText(sources[position] ?? body),
    });
  }
  return requests;
}

/** The scheme of an `Authorization` header — deliberately never its credential. */
function authorizationScheme(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (header === null) return null;
  const scheme = header.trim().split(/[ \t]+/, 1)[0];
  return scheme === undefined || scheme === "" ? null : scheme;
}

/** `result.protocolVersion` if this JSON-RPC message carries one. */
function protocolVersionIn(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const result = (message as Record<string, unknown>)["result"];
  if (result === null || typeof result !== "object") return undefined;
  const version = (result as Record<string, unknown>)["protocolVersion"];
  return typeof version === "string" ? version : undefined;
}

/** `result.tools` if this JSON-RPC message carries one, raw and unparsed. */
function listedToolsIn(message: unknown): ListedTool[] | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const result = (message as Record<string, unknown>)["result"];
  if (result === null || typeof result !== "object") return undefined;
  const tools = (result as Record<string, unknown>)["tools"];
  // Every element is kept, malformed ones included. Dropping an entry that did
  // not look right would be the trimming this capture exists to avoid, and an
  // entry the gateway sent is evidence whatever shape it is in.
  return Array.isArray(tools) ? (tools as ListedTool[]) : undefined;
}

function idOf(message: unknown): JsonRpcId | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const id = (message as Record<string, unknown>)["id"];
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/** One outbound HTTP call whose reply has not been settled yet. */
interface PendingCall {
  entries: OutboundRequest[];
  /** Resolves when the reply was seen, or the body ended without one. */
  replied: Promise<void>;
}

/** Creates the request log and the fetch that feeds it. */
export function createRequestLog(options: RequestLogOptions = {}): RequestLog {
  const entries: OutboundRequest[] = [];
  const listedTools: ListedTool[] = [];
  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  let negotiated: string | undefined;
  let pending: PendingCall | undefined;

  async function flush(): Promise<void> {
    const call = pending;
    if (call === undefined) return;
    pending = undefined;
    await call.replied;
    if (options.onRequestComplete === undefined) return;
    for (const entry of call.entries) await options.onRequestComplete(entry);
  }

  /**
   * Pipes `body` through untouched while watching for a reply to one of
   * `wanted`, and reports when it arrives (or when the body ends without it).
   *
   * `wanted` maps each awaited JSON-RPC id to the entry it belongs to, so the
   * reply frame is recorded on the row that asked for it rather than on
   * whichever row happened to be last.
   */
  function observe(
    body: ReadableStream<Uint8Array>,
    wanted: Map<JsonRpcId, OutboundRequest>,
    onReply: (observed: boolean) => void,
  ): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    let buffered = "";
    let replied = false;

    /**
     * One reconstructed message payload.
     *
     * `text` is what gets stored and `parsed` is what gets matched on, and the
     * two are deliberately separate values: the parse tells us which request
     * this answers, the text is the evidence. Storing the parse would fold the
     * message through this file's serialiser and lose a duplicate key, the
     * original spacing, and — the reason any of this exists — the difference
     * between the wire and somebody's idea of it.
     */
    const consume = (text: string): void => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      // Source slices, so a batched reply gives each row its own message text
      // rather than the batch it arrived in. `trimmed` rather than `text`:
      // whitespace *around* the message is the framing's, not the message's —
      // everything inside it, duplicate keys and spacing included, is kept.
      const sources = (Array.isArray(parsed) ? splitTopLevelJsonArray(trimmed) : null) ?? [trimmed];
      for (const [position, message] of messages.entries()) {
        const version = protocolVersionIn(message);
        if (version !== undefined) negotiated = version;
        const id = idOf(message);
        if (id === undefined) continue;
        const entry = wanted.get(id);
        if (entry === undefined) continue;
        // Only replies to requests this session sent. A frame that belongs to
        // someone else's request is not this run's tool list.
        const tools = listedToolsIn(message);
        if (tools !== undefined) listedTools.push(...tools);
        // The frame as it arrived, redacted on the way in so no unredacted copy
        // is ever held (DESIGN.md decision 19, issue #31 criteria 3 and 5).
        // Nothing above here has seen these bytes yet; the client's own schema
        // parse — which keeps no envelope and trims each tool entry to the
        // fields the spec names — happens later and to a different object. The
        // first reply carrying an id wins, because a JSON-RPC id is answered
        // once.
        if (entry.responseFrame === null) {
          entry.responseFrame = redactJsonText(sources[position] ?? trimmed);
        }
        if (!replied) {
          replied = true;
          onReply(true);
        }
      }
    };

    /**
     * The `data:` payload of one SSE frame, per the spec's own rule: drop the
     * field name, drop **one** optional space after the colon, and join the
     * lines with a newline. Not `trim()` and not a bare concatenation — both
     * edit bytes that belong to the message, and the message is the evidence.
     */
    const dataPayload = (frame: string): string =>
      frame
        .split(EOL)
        .filter(line => line.startsWith("data:"))
        .map(line => {
          const value = line.slice("data:".length);
          return value.startsWith(" ") ? value.slice(1) : value;
        })
        .join("\n");

    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          // Enqueued before it is looked at, always. The consumer never waits on
          // the capture, back-pressure stays the transport's, and nothing here
          // awaits — which is what keeps a chunked body terminating exactly as
          // it would with no wrapper at all.
          controller.enqueue(chunk);
          buffered += decoder.decode(chunk, { stream: true });
          // SSE frames end at a blank line; `data:` lines carry the message. A
          // plain JSON body has neither and is parsed when the body ends.
          for (;;) {
            const boundary = FRAME_BOUNDARY.exec(buffered);
            if (boundary === null) break;
            const frame = buffered.slice(0, boundary.index);
            buffered = buffered.slice(boundary.index + boundary[0].length);
            consume(dataPayload(frame));
          }
        },
        flush() {
          // A plain JSON body has no SSE framing at all, so whatever is left in
          // the buffer *is* the message. A trailing SSE frame that the server
          // ended without a blank line after it does have `data:` lines, and
          // those are what carry it.
          const payload = dataPayload(buffered);
          consume(payload === "" ? buffered : payload);
          if (!replied) onReply(false);
        },
      }),
    );
  }

  const wrapped = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    // Before anything else leaves the client — a notification counts — settle
    // the previous request, so its hits cannot be counted against this one.
    await flush();

    const requests = jsonRpcRequestsIn(init?.body);
    if (requests.length === 0) return await baseFetch(url, init);

    const headers = new Headers(init?.headers);
    // Through the shared reader rather than a lookup of its own: it is the one
    // place that knows header names are case-insensitive, and a transport that
    // rewrote the name — HTTP/2 lowercases it on the wire — must still be
    // recorded as identified, not as an anonymous request.
    const userIdHeader = readArcadeUserId(headers) ?? null;
    const scheme = authorizationScheme(headers);

    const sentAt = new Date();
    const startedAt = performance.now();
    const response = await baseFetch(url, init);

    const recorded: OutboundRequest[] = requests.map(request => {
      const entry: OutboundRequest = {
        index: entries.length,
        jsonRpcId: request.id,
        method: request.method,
        requestFrame: request.frame,
        // `null` until a reply carrying this id is seen, which is also what it
        // stays when the stream ends without one.
        responseFrame: null,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        sentAt: sentAt.toISOString(),
        finishedAt: sentAt.toISOString(),
        durationMs: 0,
        status: response.status,
        userIdHeader,
        authorizationScheme: scheme,
        responseObserved: false,
        hookHitsAfter: null,
      };
      entries.push(entry);
      return entry;
    });

    const settle = (observed: boolean): void => {
      const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
      const finishedAt = new Date().toISOString();
      for (const entry of recorded) {
        entry.durationMs = durationMs;
        entry.finishedAt = finishedAt;
        entry.responseObserved = observed;
      }
    };

    let resolveReplied!: () => void;
    const replied = new Promise<void>(resolve => {
      resolveReplied = resolve;
    });
    pending = { entries: recorded, replied };

    // A body-less or failed response has nothing to observe: it is already as
    // finished as it is going to get.
    if (response.body === null || !response.ok) {
      settle(false);
      resolveReplied();
      return response;
    }

    const wanted = new Map(recorded.map(entry => [entry.jsonRpcId, entry] as const));
    const observed = observe(response.body, wanted, seen => {
      settle(seen);
      resolveReplied();
    });

    return new Response(observed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    entries,
    listedTools,
    get negotiatedProtocolVersion() {
      return negotiated;
    },
    fetch: wrapped,
    flush,
  };
}
