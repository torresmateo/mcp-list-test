/**
 * One repetition: a fresh session, `initialize`, one `tools/list`, and the run
 * JSON that comes out of it.
 *
 * The shape is DESIGN.md Contracts -> Run JSON, plus the fields decision 17
 * added when the deliverable became a *profile* rather than a verdict. Two of
 * those exist because of specific ways this measurement could be plausible and
 * wrong:
 *
 *  - `toolsListRequests` / `cursorFollowed`. One `tools/list` call is not one
 *    outbound request: the v2 client walks pagination for you. A hook count
 *    that is high because the client fetched three pages is a different result
 *    from one that is high per request, and a reader must not have to derive
 *    which by counting rows in `requests[]`.
 *  - `userIdHeader` on every request. If the Arcade user header does not go
 *    out, the gateway files its hook hits under a key this probe never polls,
 *    `GET /hits` finds nothing, and the run reports a clean zero —
 *    indistinguishable from "the hook never fired", which is the measurement.
 *    A repetition whose requests went out unidentified is an `error`, not a 0.
 *
 * `hookHits[]` is stored exactly as `GET /hits` returned it. Slice #15 is
 * extending what the counter records per hit; passing it through means this
 * slice does not get to decide what is interesting.
 *
 * `toolsListResult` is the other half of that pair (DESIGN.md decision 18):
 * `hookHits` is what the gateway told the hook, `toolsListResult` is what the
 * same gateway told the client in the same session. The live run of 2026-09-19
 * listed 42 tools while offering the hook 40, and the instrument could report
 * that the gap was *2* but not *which two* — this project's own "an absence is
 * not evidence; an excerpt, not a count" rule turned against itself. Recording
 * the result makes `toolsNotOfferedToHook` something a reader can recompute
 * rather than something the run asserts.
 */
import type { Client } from "@modelcontextprotocol/client";
import { ARCADE_USER_ID_HEADER } from "../client/headers.ts";
import {
  createRequestLog,
  type ListedTool,
  type OutboundRequest,
} from "../client/request-log.ts";
import { openSession, RevisionMismatchError } from "../client/session.ts";
import { type HitsClient, type HookHit } from "./hits.ts";

/** The `schema` value this slice writes. */
export const SCHEMA_VERSION = 1;

export type RunStatus = "ok" | "version-mismatch" | "error";

/** One row of the run's request timeline. */
export interface RunRequest {
  /** Numeric id for the report; the JSON-RPC id when it was a number. */
  id: number;
  /** The JSON-RPC id exactly as it went on the wire, whatever its type. */
  jsonRpcId: string | number;
  method: string;
  /** Present only when this request followed a pagination cursor. */
  cursor?: string;
  sentAt: string;
  finishedAt: string;
  /** Client-observed round trip, hook round trips included — they are on the path. */
  durationMs: number;
  status: number;
  /** The Arcade user header as sent, or `null`. Never the API key. */
  userIdHeader: string | null;
  /** The `Authorization` scheme as sent. Never the credential. */
  authorizationScheme: string | null;
  /** `false` when the response could not be confirmed complete; timing is then a floor. */
  responseObserved: boolean;
  /** Cumulative hook hits for this user id after this request. */
  hookHitsAfter: number;
}

/** Re-exported: the run JSON's `toolsListResult` entries are the wire entries. */
export type { ListedTool };

/** DESIGN.md Contracts -> Run JSON, with the decision 17 additions. */
export interface Run {
  schema: number;
  revisionRequested: string;
  /** `null` when the run died before anything was negotiated (operator ruling, 2026-09-18). */
  revisionNegotiated: string | null;
  status: RunStatus;
  userId: string;
  hookPublicUrl: string;
  requests: RunRequest[];
  hookHits: HookHit[];
  toolsListed: number;
  gmailToolsListed: number;
  /**
   * The `tools/list` result as the gateway returned it, whole — no truncation,
   * no sampling, no re-derived shape (DESIGN.md decision 18). When the list
   * paged this is the concatenation the client assembled, page by page, in the
   * order the replies arrived.
   *
   * Read off the wire rather than from `client.listTools()`, because the two
   * are not the same list: the v2 client parses the result against the spec
   * schema and drops every top-level field the spec does not name, so an Arcade
   * tool carrying a vendor field would arrive here without it and nothing would
   * say so. See `src/client/request-log.ts`.
   *
   * `null`, not `[]`, when no `tools/list` result was ever assembled — the run
   * died first, or never got that far. `[]` is reserved for the real
   * measurement "the gateway returned an empty list", which is what a hook that
   * denied everything produces and is a different statement. Same reasoning as
   * `toolsListDurationMs` above.
   */
  toolsListResult: ListedTool[] | null;
  /**
   * Tool names in `toolsListResult` that appear in **no** hook payload: the
   * tools this gateway listed without ever submitting them to access control,
   * so no policy could have denied them. Deduplicated and sorted, so two runs
   * of the same gateway are diffable.
   *
   * `null` — never `[]` — when there is nothing to derive it from: no hook hits,
   * or no `tools/list` result. A run that observed no hook hits says *nothing*
   * about what was offered, and `[]` would read as "nothing bypassed the hook",
   * which is a false statement dressed as a measurement. See
   * {@link deriveToolsNotOfferedToHook}.
   */
  toolsNotOfferedToHook: string[] | null;
  /** `null` when `status` is `ok`; a plain string otherwise. Never an object. */
  error: string | null;
  /** How many `tools/list` requests actually went out. Not derived by the reader. */
  toolsListRequests: number;
  /** Whether any of them followed a `nextCursor`. */
  cursorFollowed: boolean;
  /**
   * Client-observed time spent on `tools/list` requests: the sum of their
   * round trips, hook round trips included because they are on the path.
   * `null` when none went out.
   *
   * A sum rather than first-sent-to-last-replied. When the list pages, the
   * probe's own quiescence window sits between the pages, and a span would
   * report that wait as if the gateway had spent it.
   */
  toolsListDurationMs: number | null;
  /** `legacy` or `modern` (DESIGN.md decision 15); `null` when no session was opened. */
  protocolEra: string | null;
  /** The wall clock the whole repetition took, quiescence windows included. */
  startedAt: string;
  finishedAt: string;
}

export interface RunRepetitionOptions {
  gatewayUrl: string;
  revision: string;
  /** 1-based repetition number; becomes the trailing `-<n>` of the user id and filename. */
  repetition: number;
  /** Epoch ms shared by every repetition of one invocation, per DESIGN.md's id shape. */
  timestamp: number;
  /** Already resolved and validated by `loadUserIdPrefix`; `probe` by default. */
  userIdPrefix: string;
  apiKey: string;
  hookPublicUrl: string;
  hits: HitsClient;
}

/**
 * DESIGN.md Contracts -> Probe CLI step 1: `<prefix>-<revision>-<timestamp>-<n>`.
 *
 * Only `<prefix>` is the operator's — `$ARCADE_USER_ID_PREFIX`, resolved and
 * validated by `loadUserIdPrefix`, defaulting to `probe`. **The trailing `-<n>`
 * is not configurable.** It is what makes five repetitions five distinct end
 * users; collapse them onto one id and a cached session or a reused
 * authorization can serve four of them without touching the access path, and
 * the run would report a healthy-looking count of something it never measured.
 */
export function userIdFor(
  prefix: string,
  revision: string,
  timestamp: number,
  repetition: number,
): string {
  return `${prefix}-${revision}-${timestamp}-${repetition}`;
}

/**
 * Tools belonging to the Gmail toolkit.
 *
 * Arcade names a tool `Toolkit_Tool`; the separator is matched loosely because
 * a gateway that spelled it `Gmail.SendEmail` must not read as zero Gmail
 * tools — this count is evidence that the hook was consulted (decision 6), and
 * a false zero here is the same class of bug as a false zero in the hit count.
 */
export function isGmailTool(name: string): boolean {
  return /^gmail[._-]/i.test(name);
}

/**
 * The matching rule between the two sides, stated once (DESIGN.md decision 18).
 *
 * The MCP side names a tool in one string, `Toolkit_Tool`. The hook side names
 * the same tool in two, `toolkits: { <Toolkit>: { tools: { <Tool>: [...] } } }`.
 * Comparing them therefore means reassembling a name, and **the separator is the
 * whole risk**: if the assumption is wrong, nothing matches at all and the run
 * reports that every listed tool bypassed the hook — a dramatic finding that is
 * entirely an artefact of the join. So the key drops the separator instead of
 * guessing it: `Gmail_SendEmail`, `Gmail.SendEmail` and `gmail-sendemail` all
 * reduce to `gmailsendemail`. Same reasoning as {@link isGmailTool}, which
 * matches the separator loosely for the same reason.
 *
 * Dropping the separator entirely rather than accepting a set of them is
 * deliberate: a gateway that spelled the join with a character we did not think
 * of would otherwise reproduce exactly the failure above.
 */
function toolMatchKey(name: string): string {
  return name.replace(/[\s._\-]/g, "").toLowerCase();
}

/**
 * Every tool name a hook payload named, as match keys.
 *
 * One key per `(toolkit, tool)` pair, chosen by a single rule: the reassembled
 * `Toolkit` + `Tool` — the contract's shape, and the one Arcade sends — unless
 * the tool name **already begins with the toolkit name**, in which case it is
 * taken as already qualified and used as it stands. Without that exception a
 * payload carrying `tools: { Gmail_SendEmail: [...] }` under toolkit `Gmail`
 * would reassemble to `gmailgmailsendemail` and match nothing.
 *
 * The exception is a condition, not a wildcard: a bare `Ping` under toolkit `A`
 * is only ever the key `aping`, so a listed `B_Ping` still counts as not
 * offered rather than being silently matched to another toolkit's tool.
 *
 * Anything not shaped like the contract contributes nothing rather than
 * throwing — the same rule the hook counter's own `profilePayload` follows. A
 * malformed payload is evidence too, and it is visible in `hookHits`.
 */
function offeredToolKeys(hookHits: readonly HookHit[]): Set<string> {
  const keys = new Set<string>();
  for (const hit of hookHits) {
    const payload = hit["payload"];
    if (!isPlainObject(payload)) continue;
    const toolkits = payload["toolkits"];
    if (!isPlainObject(toolkits)) continue;
    for (const [toolkit, info] of Object.entries(toolkits)) {
      if (!isPlainObject(info)) continue;
      const tools = info["tools"];
      if (!isPlainObject(tools)) continue;
      for (const tool of Object.keys(tools)) {
        const toolkitKey = toolMatchKey(toolkit);
        const toolKey = toolMatchKey(tool);
        keys.add(toolKey.startsWith(toolkitKey) ? toolKey : `${toolkitKey}${toolKey}`);
      }
    }
  }
  return keys;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The tools a gateway listed but never submitted to access control.
 *
 * `null` — never `[]` — when the run has nothing to derive the answer from:
 * no hook hits, or no `tools/list` result. That is criterion 3 of issue #26 and
 * the reason this function exists as its own testable unit: `[]` would read as
 * "nothing bypassed the hook", a confident statement produced by a run that in
 * fact observed nothing. An absence is not evidence.
 *
 * `[]` therefore means one specific thing — the run *did* see hook payloads and
 * every listed tool was in them.
 */
export function deriveToolsNotOfferedToHook(
  listed: readonly ListedTool[] | null,
  hookHits: readonly HookHit[],
): string[] | null {
  if (listed === null || hookHits.length === 0) return null;
  const offered = offeredToolKeys(hookHits);
  const missing = listedNames(listed).filter(name => !offered.has(toolMatchKey(name)));
  return [...new Set(missing)].sort();
}

/**
 * The names in a listed set.
 *
 * An entry that arrived without a string `name` is not a tool this can match on
 * and is left out of the derived set rather than named as "not offered" — the
 * entry itself is still in `toolsListResult`, which is where a reader sees it.
 * The protocol says `name` is required, so this is defence against a gateway
 * that broke it, not an expected case.
 */
function listedNames(listed: readonly ListedTool[]): string[] {
  return listed.map(tool => tool.name).filter(name => typeof name === "string");
}

/**
 * True when the hook was offered tools, the gateway listed tools, and *not one*
 * of them matched — the shape {@link toolMatchKey} exists to guard against.
 *
 * It is a real possible finding, so it is not an error; but it is far more
 * likely to be a broken join than a gateway that shares nothing between the two
 * sides, and the probe says so out loud rather than printing "42 tools bypassed
 * the hook" as if it were a discovery. Derived from the run's own fields, so a
 * reader of the JSON can reach the same conclusion without this function.
 */
export function everyListedToolUnmatched(run: Run): boolean {
  return (
    run.toolsListResult !== null &&
    listedNames(run.toolsListResult).length > 0 &&
    run.toolsNotOfferedToHook !== null &&
    run.toolsNotOfferedToHook.length === new Set(listedNames(run.toolsListResult)).size &&
    offeredToolKeys(run.hookHits).size > 0
  );
}

/** The report's `id` must be a number; the wire id is kept alongside it regardless. */
function toRunRequest(entry: OutboundRequest): RunRequest {
  return {
    id: typeof entry.jsonRpcId === "number" ? entry.jsonRpcId : entry.index,
    jsonRpcId: entry.jsonRpcId,
    method: entry.method,
    ...(entry.cursor === undefined ? {} : { cursor: entry.cursor }),
    sentAt: entry.sentAt,
    finishedAt: entry.finishedAt,
    durationMs: entry.durationMs,
    status: entry.status,
    userIdHeader: entry.userIdHeader,
    authorizationScheme: entry.authorizationScheme,
    responseObserved: entry.responseObserved,
    hookHitsAfter: entry.hookHitsAfter ?? 0,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one repetition. Never throws for a gateway failure — it reports one. */
export async function runRepetition(options: RunRepetitionOptions): Promise<Run> {
  const startedAt = new Date();
  const userId = userIdFor(
    options.userIdPrefix,
    options.revision,
    options.timestamp,
    options.repetition,
  );

  let hookHits: HookHit[] = [];
  const log = createRequestLog({
    onRequestComplete: async request => {
      const snapshot = await options.hits.snapshot(userId);
      request.hookHitsAfter = snapshot.count;
      hookHits = snapshot.hits;
    },
  });

  let status: RunStatus = "ok";
  let revisionNegotiated: string | null = null;
  let error: string | null = null;
  let protocolEra: string | null = null;
  let toolsListed = 0;
  let gmailToolsListed = 0;
  // `null` until a result actually comes back: "the gateway returned no tools"
  // and "we never got a result" must not collapse into the same value.
  let toolsListResult: ListedTool[] | null = null;

  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  try {
    session = await openSession({
      url: options.gatewayUrl,
      revision: options.revision,
      userId,
      apiKey: options.apiKey,
      fetchImpl: log.fetch,
      observedRevision: () => log.negotiatedProtocolVersion,
    });
    revisionNegotiated = session.negotiatedRevision;
    protocolEra = session.era;
    // `initialize`'s snapshot is already taken: the wrapper settles a request
    // before the next thing leaves the client, and `connect()` ends with a
    // `notifications/initialized`. This is the belt for the case where a
    // future client does not send one.
    await log.flush();

    const listed = await listTools(session.client);
    await log.flush();
    // `toolsListed` and `gmailToolsListed` keep their meaning and their source:
    // the tools the *client* ended up with, which is what every existing run
    // file and every existing test means by them.
    toolsListed = listed.length;
    gmailToolsListed = listed.filter(isGmailTool).length;
    // The recorded result is the wire's, not the client's, and it is recorded
    // whole (DESIGN.md decision 18): the live gateway lists 12-42 tools,
    // negligible beside the 1.6 MB catalogue payloads a run already carries per
    // hook hit, so there is nothing to truncate or sample for.
    toolsListResult = [...log.listedTools];

    // A request that went out without the user header makes every hook hit
    // unattributable, and the counter would answer 0 for a user id the gateway
    // never saw. That is a broken run, not an empty one.
    const unidentified = log.entries.filter(entry => entry.userIdHeader !== userId);
    if (unidentified.length > 0) {
      status = "error";
      error = `requests went out without ${ARCADE_USER_ID_HEADER}=${userId}: ${unidentified
        .map(entry => entry.method)
        .join(", ")}`;
    }
  } catch (caught) {
    if (caught instanceof RevisionMismatchError) {
      status = "version-mismatch";
      revisionNegotiated = caught.negotiated;
      error = caught.message;
    } else {
      status = "error";
      revisionNegotiated = log.negotiatedProtocolVersion ?? null;
      error = message(caught);
    }
  } finally {
    // Whatever happened, settle any request whose snapshot is still owed, so a
    // failed run still reports the hits its requests did cause.
    await log.flush().catch(() => {});
    await session?.close();
  }

  // A failure before the first response leaves no snapshot, so read the
  // counter once more — best effort, because a run that failed because the
  // counter is unreachable must keep its original cause.
  if (hookHits.length === 0) {
    try {
      hookHits = (await options.hits.read(userId)).hits;
    } catch {
      /* the run's own error already says what went wrong */
    }
  }

  const toolsList = log.entries.filter(entry => entry.method === "tools/list");

  return {
    schema: SCHEMA_VERSION,
    revisionRequested: options.revision,
    revisionNegotiated,
    status,
    userId,
    hookPublicUrl: options.hookPublicUrl,
    requests: log.entries.map(toRunRequest),
    hookHits,
    toolsListed,
    gmailToolsListed,
    toolsListResult,
    toolsNotOfferedToHook: deriveToolsNotOfferedToHook(toolsListResult, hookHits),
    error,
    toolsListRequests: toolsList.length,
    cursorFollowed: toolsList.some(entry => entry.cursor !== undefined),
    toolsListDurationMs:
      toolsList.length === 0
        ? null
        : Math.round(toolsList.reduce((total, entry) => total + entry.durationMs, 0) * 1000) / 1000,
    protocolEra,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

/**
 * One `tools/list` call, the way a real client makes it (DESIGN.md decision 3):
 * no cursor, so the SDK walks every page itself. How many requests that became
 * is read back off the request log, never assumed.
 */
async function listTools(client: Client): Promise<string[]> {
  const result = await client.listTools();
  return result.tools.map(tool => tool.name);
}
