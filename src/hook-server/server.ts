/**
 * Access-hook counter — the measuring instrument every later slice trusts.
 *
 * DESIGN.md Contracts -> Hook counter HTTP API is the spec:
 *
 *   POST /access          Arcade access-hook contract. Requires
 *                         `Authorization: Bearer <token>`, else 401 and
 *                         **not counted**. Responds with the contract's
 *                         `AccessHookResult` — `{ deny: { <Toolkit>: ... } }`
 *                         naming every toolkit whose name matches
 *                         `/^gmail$/i`, `{}` when the request carried none.
 *                         It is **not** an echo of the request body.
 *   GET  /hits?user_id=   `{ count, hits: [ <hit> ] }` — see {@link HookHit}.
 *   GET  /healthz         200.
 *
 * Every accepted hit is appended as one JSON line to the log file before the
 * response is sent, so `wc -l` on the log and the count from `/hits` can never
 * disagree at the moment a caller observes either one.
 *
 * There are no other endpoints. Decisions 6 (deny Gmail, allow the rest),
 * 7 (verify the bearer, do not count rejects) and 8 (in-memory store plus JSONL
 * append) live here, and so does decision 17: a hit records the *shape and
 * cost* of the invocation — headers, toolkit/tool/version counts, body size and
 * the server's own handling time — because a bare count does not tell the
 * engine team what an access hook costs them.
 *
 * Decision 19 adds the direction that was missing entirely: **what this hook
 * answered.** `responseStatus` and `responseBody` sit on the hit beside the
 * request they answer, so the evidence file itself shows the deny that was
 * actually sent. Decision 7 is untouched by it — a 401 is not a hit, records
 * nothing, and therefore has no response to record either.
 */
import { timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureHeaders, redactValue } from "../redact.ts";

/** Repo root, so a relative log path means the same thing from any cwd. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** DESIGN.md: raw payloads land in `results/hook-log.jsonl`. */
export const DEFAULT_LOG_PATH = "results/hook-log.jsonl";

/**
 * Toolkit names the policy denies. Exact and case-insensitive per DESIGN.md —
 * `GMAIL` and `gmail` are denied, `gmail-labs` and `NotGmail` are not.
 */
const DENIED_TOOLKIT = /^gmail$/i;

/**
 * One recorded hit, as `/hits` returns it and as the JSONL file stores it.
 *
 * Everything past `receivedAt`/`payload` is decision 17's profile: how much
 * this invocation carried and what it cost the server to answer.
 */
export interface HookHit {
  /** ISO-8601 instant the request arrived, taken before any work on it. */
  receivedAt: string;
  /**
   * Every request header that arrived. No allow-list decides *which* headers
   * are captured: we do not yet know which ones a real Arcade gateway sends,
   * and a hit that cannot be tied back to the request that caused it is a hit
   * we can only count, not explain.
   *
   * Values are verbatim except for credential-bearing names, whose secret is
   * replaced by a descriptor at capture time — see `src/redact.ts`. The
   * secret therefore never reaches the store, the JSONL log or `/hits`, so it
   * cannot travel on into a run file and into the public `evidence/` directory.
   * Nothing real is lost: the server has already verified the bearer, so a
   * recorded hit is by definition one that authenticated.
   */
  headers: Record<string, string>;
  /** Toolkits present in the payload as it arrived. */
  toolkitCount: number;
  /** Tool names across every toolkit. */
  toolCount: number;
  /** Total version entries across every tool — see {@link profilePayload}. */
  versionCount: number;
  /** Byte length of the raw request body as received, before any parsing. */
  bodyBytes: number;
  /**
   * The server's own handling time in milliseconds: request received to
   * response ready. Not client-observed latency — the report presents the two
   * separately and the gap between them is the interesting part.
   */
  handlingMs: number;
  /**
   * The body exactly as the gateway sent it, unfiltered (DESIGN.md decision 17).
   *
   * Deliberately **not** put through `redactValue`, unlike {@link headers} and
   * {@link responseBody}. This is the gateway's description of its catalogue: an
   * `authorization` key in tool metadata here names what a tool *requires*, not
   * a secret it carries, and a key-based rule cannot tell those apart — it would
   * delete the measurement to protect something that was never a credential. A
   * real credential that lands here is caught by `RUNBOOK.md` step 10's
   * value-based grep over the whole evidence directory, which has its own
   * positive control. See the header of `src/redact.ts`.
   */
  payload: Record<string, unknown>;
  /**
   * The HTTP status this hook answered with — DESIGN.md decision 19.
   *
   * Always 200 on a recorded hit, and recorded anyway rather than assumed: a
   * hit exists only on the path that answers 200, so a constant in the file
   * would be a restatement of the code and a *recorded* value is a measurement
   * a reader can check. A 401 is not a hit and never reaches here (decision 7).
   */
  responseStatus: number;
  /**
   * The body this hook sent back — the `AccessHookResult` it serialised, with
   * credential values replaced at capture by {@link redactValue}.
   *
   * The same value, not a reconstruction of it: {@link postAccess} builds the
   * decision once and sends `JSON.stringify` of it, so
   * `JSON.stringify(hit.responseBody)` reproduces the response byte for byte
   * **except** where a credential value was replaced by its descriptor — and
   * the descriptor names the length of what it replaced, so even that is
   * checkable.
   *
   * Redacted for the same reason the headers are: the decision echoes
   * `ToolkitInfo` **as received**, so anything a gateway put under an
   * `authorization`, `cookie`, `set-cookie`, `proxy-authorization` or
   * `x-api-key` key in tool metadata would otherwise travel out of here into a
   * run file and into the public `evidence/` directory.
   *
   * This is the direction that was missing. A hook that records what it was
   * asked and not what it answered cannot show that the deny it believes it
   * issued was issued — which is the fail-open #21 fixed, and which until now
   * was only ever provable by a `curl` run by hand.
   */
  responseBody: Record<string, unknown>;
}

export interface StartHookServerOptions {
  /** Listen port. `0` (the default) binds an ephemeral port. */
  port?: number;
  /** The bearer the gateway must present. Empty or blank is refused. */
  token: string;
  /** JSONL log; relative paths resolve against the repo root. */
  logPath?: string;
  /** Interface to bind. Loopback by default; a tunnel reaches it from there. */
  hostname?: string;
}

export interface HookServer {
  /** Base URL, e.g. `http://127.0.0.1:52341` — no trailing slash. */
  url: string;
  /** The port actually bound, which is what you want when `port` was 0. */
  port: number;
  /** Absolute path of the JSONL log this server appends to. */
  logPath: string;
  /** Stops listening and drops active connections. */
  close(): Promise<void>;
}

/** Constant-time comparison, so a wrong token leaks nothing but its length. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The bearer check, failing closed at every step: no header, a non-Bearer
 * scheme, an empty token and a wrong token are all rejected. The scheme is
 * matched case-insensitively (RFC 7235 says it is); the token is not.
 */
function isAuthorized(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization");
  if (header === null) return false;
  const match = /^Bearer[ \t]+(.*)$/i.exec(header.trim());
  const presented = match?.[1]?.trim();
  if (presented === undefined || presented === "") return false;
  return tokensMatch(presented, expected);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="access-hook"',
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a payload carried, counted from the body as it arrived. */
interface PayloadProfile {
  toolkitCount: number;
  toolCount: number;
  versionCount: number;
}

/**
 * Counts the shape of `{ toolkits: { <Toolkit>: { tools: { <Tool>: [ ... ] } } } }`.
 *
 * Counted from the payload **as received**, before the Gmail policy runs: the
 * profile describes what the gateway sent, not what we sent back.
 *
 * `versionCount` is the total number of version entries across every tool. It
 * is neither the number of tools that carry versions nor the number of
 * distinct version strings — three readings that coincide on a payload where
 * every tool has exactly one version, which is why the tests use one where
 * they cannot.
 *
 * Anything not shaped like the contract contributes nothing rather than
 * throwing. The counter records whatever arrives; a malformed payload is
 * evidence too, and a 500 here would lose the hit entirely.
 */
function profilePayload(payload: Record<string, unknown>): PayloadProfile {
  let toolkitCount = 0;
  let toolCount = 0;
  let versionCount = 0;

  const toolkits = payload["toolkits"];
  if (isPlainObject(toolkits)) {
    for (const toolkit of Object.values(toolkits)) {
      toolkitCount += 1;
      if (!isPlainObject(toolkit)) continue;
      const tools = toolkit["tools"];
      if (!isPlainObject(tools)) continue;
      for (const versions of Object.values(tools)) {
        toolCount += 1;
        if (Array.isArray(versions)) versionCount += versions.length;
      }
    }
  }

  return { toolkitCount, toolCount, versionCount };
}

/**
 * Elapsed milliseconds, kept to microsecond resolution.
 *
 * A local hook answers in well under a millisecond, and an integer would
 * record that as `0` — a number a reader cannot tell from "not measured".
 */
function millisSince(start: number): number {
  return Math.round((performance.now() - start) * 1000) / 1000;
}

/**
 * The access decision, in the contract's own shape.
 *
 * `AccessHookResult` (`logic_extensions/http/1.0/schema.yaml`, ArcadeAI/schemas)
 * is `{ only?: Toolkits, deny?: Toolkits }` and nothing else. It is **not** an
 * echo of the request: a response carrying neither field means *no change*, so
 * the request body with Gmail removed — which is what this function used to
 * return — expressed no opinion at all and left every tool allowed, Gmail
 * included. It read like a deny to a human and was a silent fail-open to the
 * engine. DESIGN.md decision 6, amended 2026-09-18, is the ruling.
 *
 * `deny` carries each denied toolkit's `ToolkitInfo` **as received**, so the
 * engine denies the tools it told us about rather than a set we reconstructed.
 * Nothing else from the request travels back: no `user_id`, no `toolkits`, no
 * passthrough of unknown top-level fields — they are not part of the result
 * type, and a response that carried them would be guessing at the contract
 * again.
 *
 * Nothing matched -> `{}`, per DESIGN.md's Contracts entry. That *is* "no
 * change", and here it is the deliberate answer: a request with no Gmail in it
 * is one this policy has no opinion about. The empty case is pinned by a test
 * precisely because it is shaped like the bug.
 */
function accessDecision(payload: Record<string, unknown>): Record<string, unknown> {
  const toolkits = payload["toolkits"];
  if (!isPlainObject(toolkits)) return {};
  const deny: Record<string, unknown> = {};
  for (const [name, info] of Object.entries(toolkits)) {
    if (DENIED_TOOLKIT.test(name)) deny[name] = info;
  }
  return Object.keys(deny).length === 0 ? {} : { deny };
}

/** The instant a request arrived, in both the forms a hit needs. */
interface Received {
  /** ISO-8601, for `receivedAt`. */
  iso: string;
  /** Monotonic `performance.now()` reading, for `handlingMs`. */
  at: number;
}

/**
 * Starts the hook counter and returns its real URL.
 *
 * Exported so other slices can run it on an ephemeral port inside their own
 * tests instead of racing for `$PORT_WEB`; `bun run hook-server` is a thin
 * wrapper over this.
 */
export function startHookServer(options: StartHookServerOptions): HookServer {
  const token = options.token;
  if (typeof token !== "string" || token.trim() === "") {
    // Fail closed. A blank expected token would make `Bearer <anything>` or
    // even a blank bearer a valid hit, and the tunnel URL is public.
    throw new Error("hook-server: a non-empty bearer token is required");
  }

  const requested = options.logPath ?? DEFAULT_LOG_PATH;
  const logPath = isAbsolute(requested) ? requested : resolve(REPO_ROOT, requested);
  // `results/` is gitignored, so it is absent in a fresh worktree. Touch the
  // log too: an existing empty file means "running, no hits yet", which is a
  // different statement from `wc -l` failing on a path that is not there.
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, "", "utf8");

  /** Hits keyed by `user_id`, in arrival order. DESIGN.md decision 8. */
  const hitsByUser = new Map<string, HookHit[]>();

  function record(userId: string, hit: HookHit): void {
    // Append first: the file is the crash-surviving copy, and writing it
    // before the response keeps `wc -l` and `/hits` in agreement.
    appendFileSync(logPath, `${JSON.stringify(hit)}\n`, "utf8");
    const existing = hitsByUser.get(userId);
    if (existing === undefined) hitsByUser.set(userId, [hit]);
    else existing.push(hit);
  }

  async function postAccess(request: Request, received: Received): Promise<Response> {
    // Rejected requests record nothing at all — no hit, no log line, and no
    // handling time (DESIGN.md decision 7). A 401 that started recording would
    // make every scanner on a public tunnel URL a measurement.
    if (!isAuthorized(request, token)) return unauthorized();

    // The bytes that crossed the wire, before any parsing. Measuring a
    // re-serialised copy would report our formatting, not the gateway's.
    const raw = await request.arrayBuffer();
    const bodyBytes = raw.byteLength;

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!isPlainObject(payload)) {
      return json({ error: "body must be a JSON object" }, 400);
    }

    const body = payload;
    const userId = body["user_id"];
    if (typeof userId !== "string" || userId === "") {
      // Without a key there is nothing to count it against, and a hit the
      // probe can never read back is worse than a loud rejection.
      return json({ error: "missing user_id" }, 400);
    }

    // Built once, sent as it is, recorded redacted. The gateway has to receive
    // the real `ToolkitInfo` or it cannot act on the deny; what lands on disk
    // goes through `redactValue` first, at capture, so no unredacted copy is
    // ever held. `redactValue` copies rather than mutating, which matters here:
    // the decision carries `ToolkitInfo` objects taken straight from `payload`,
    // and `payload` is stored unfiltered on purpose.
    const decision = accessDecision(body);
    const response = json(decision);
    // Everything the answer needed is done; what remains is bookkeeping, and
    // the JSONL append cannot be inside the number it writes.
    record(userId, {
      receivedAt: received.iso,
      // Every header name, credential values redacted: see HookHit.headers.
      headers: captureHeaders(request.headers),
      ...profilePayload(body),
      bodyBytes,
      handlingMs: millisSince(received.at),
      payload: body,
      responseStatus: response.status,
      responseBody: redactValue(decision) as Record<string, unknown>,
    });
    return response;
  }

  function getHits(url: URL): Response {
    const userId = url.searchParams.get("user_id");
    if (userId === null || userId === "") return json({ error: "missing user_id" }, 400);
    const hits = hitsByUser.get(userId) ?? [];
    return json({ count: hits.length, hits });
  }

  const hostname = options.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname,
    async fetch(request) {
      // Taken before any routing, so `handlingMs` covers the whole of what
      // this server did with the request rather than part of it.
      const received: Received = { iso: new Date().toISOString(), at: performance.now() };
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/access":
          return request.method === "POST"
            ? await postAccess(request, received)
            : json({ error: "method not allowed" }, 405);
        case "/hits":
          return request.method === "GET"
            ? getHits(url)
            : json({ error: "method not allowed" }, 405);
        case "/healthz":
          return request.method === "GET"
            ? json({ status: "ok" })
            : json({ error: "method not allowed" }, 405);
        default:
          return json({ error: "not found" }, 404);
      }
    },
  });

  const boundPort = server.port;
  if (boundPort === undefined) throw new Error("hook-server: no TCP port was bound");

  return {
    url: `http://${hostname}:${boundPort}`,
    port: boundPort,
    logPath,
    async close() {
      await server.stop(true);
    },
  };
}
