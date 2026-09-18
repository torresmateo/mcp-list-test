/**
 * Access-hook counter — the measuring instrument every later slice trusts.
 *
 * DESIGN.md Contracts -> Hook counter HTTP API is the spec:
 *
 *   POST /access          Arcade access-hook contract. Requires
 *                         `Authorization: Bearer <token>`, else 401 and
 *                         **not counted**. Responds with the same body, minus
 *                         every toolkit whose name matches `/^gmail$/i`.
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
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
   * Values are verbatim except for {@link CREDENTIAL_HEADERS}, whose secret is
   * replaced by a descriptor at capture time — see {@link captureHeaders}. The
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
  /** The body exactly as the gateway sent it, unfiltered. */
  payload: Record<string, unknown>;
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

/**
 * Headers whose value is a credential. Matched by name, case-insensitively.
 *
 * Deliberately short and about *names only*: these are the headers that carry
 * a secret by definition. Nothing here pattern-matches on a value — a gateway's
 * `traceparent`, `user-agent` or anything else we have never seen is exactly
 * what this instrument exists to discover, and guessing at values would start
 * redacting the evidence.
 */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

/**
 * The subset whose value begins with an auth scheme (RFC 7235). The scheme is
 * kept in the clear because it is shape, not secret. A cookie has no scheme —
 * its first token is already a value — so it is redacted whole.
 */
const SCHEMED_CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization"]);

/** `Bearer <token>` -> scheme and credential; no match means "no scheme". */
const AUTH_SCHEME = /^([A-Za-z][A-Za-z0-9._~+-]*)[ \t]+(\S[\s\S]*)$/;

/** First 8 hex of SHA-256: stable across hits, useless for recovering the value. */
function shortDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

/**
 * What a redacted value becomes: `<redacted len=43 sha256=1f3a9c2b>`.
 *
 * A descriptor rather than a bare `<redacted>`, because the three things we
 * actually need from a credential header survive it — the header was present,
 * it had a plausible shape, and it was *the same value on every hit*. That last
 * one is the only diagnostic the raw bytes would have given us, and a constant
 * placeholder would throw it away. `len` is the byte length of the portion that
 * was removed, and the digest is over that same portion.
 */
function redact(secret: string): string {
  return `<redacted len=${Buffer.byteLength(secret, "utf8")} sha256=${shortDigest(secret)}>`;
}

/**
 * Every header that arrived, with credential values redacted before the record
 * exists. There is no path by which the raw secret is stored and cleaned up
 * later: it is replaced here, once, on the way in.
 */
function captureHeaders(headers: Headers): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const [name, value] of headers) {
    // The runtime lower-cases header names; `toLowerCase` makes the match
    // independent of that rather than dependent on it.
    const key = name.toLowerCase();
    if (!CREDENTIAL_HEADERS.has(key)) {
      captured[name] = value;
      continue;
    }
    const schemed = SCHEMED_CREDENTIAL_HEADERS.has(key) ? AUTH_SCHEME.exec(value) : null;
    captured[name] =
      schemed === null ? redact(value) : `${schemed[1]} ${redact(schemed[2] as string)}`;
  }
  return captured;
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

/** The access decision: drop denied toolkits, keep the rest and every other field. */
function applyPolicy(payload: Record<string, unknown>): Record<string, unknown> {
  const { toolkits } = payload;
  if (toolkits === null || typeof toolkits !== "object" || Array.isArray(toolkits)) {
    return { ...payload };
  }
  const allowed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(toolkits)) {
    if (DENIED_TOOLKIT.test(name)) continue;
    allowed[name] = value;
  }
  return { ...payload, toolkits: allowed };
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

    const response = json(applyPolicy(body));
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
