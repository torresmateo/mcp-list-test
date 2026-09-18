/**
 * Access-hook counter — the measuring instrument every later slice trusts.
 *
 * DESIGN.md Contracts -> Hook counter HTTP API is the spec:
 *
 *   POST /access          Arcade access-hook contract. Requires
 *                         `Authorization: Bearer <token>`, else 401 and
 *                         **not counted**. Responds with the same body, minus
 *                         every toolkit whose name matches `/^gmail$/i`.
 *   GET  /hits?user_id=   `{ count, hits: [ { receivedAt, payload } ] }`.
 *   GET  /healthz         200.
 *
 * Every accepted hit is appended as one JSON line to the log file before the
 * response is sent, so `wc -l` on the log and the count from `/hits` can never
 * disagree at the moment a caller observes either one.
 *
 * There are no other endpoints. Decisions 6 (deny Gmail, allow the rest),
 * 7 (verify the bearer, do not count rejects) and 8 (in-memory store plus JSONL
 * append) live here.
 */
import { timingSafeEqual } from "node:crypto";
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

/** One recorded hit, as `/hits` returns it and as the JSONL file stores it. */
export interface HookHit {
  /** ISO-8601 instant the hit was accepted. */
  receivedAt: string;
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

  function record(userId: string, payload: Record<string, unknown>): void {
    const hit: HookHit = { receivedAt: new Date().toISOString(), payload };
    // Append first: the file is the crash-surviving copy, and writing it
    // before the response keeps `wc -l` and `/hits` in agreement.
    appendFileSync(logPath, `${JSON.stringify(hit)}\n`, "utf8");
    const existing = hitsByUser.get(userId);
    if (existing === undefined) hitsByUser.set(userId, [hit]);
    else existing.push(hit);
  }

  async function postAccess(request: Request): Promise<Response> {
    if (!isAuthorized(request, token)) return unauthorized();

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ error: "body must be a JSON object" }, 400);
    }

    const body = payload as Record<string, unknown>;
    const userId = body.user_id;
    if (typeof userId !== "string" || userId === "") {
      // Without a key there is nothing to count it against, and a hit the
      // probe can never read back is worse than a loud rejection.
      return json({ error: "missing user_id" }, 400);
    }

    record(userId, body);
    return json(applyPolicy(body));
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
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/access":
          return request.method === "POST"
            ? await postAccess(request)
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
