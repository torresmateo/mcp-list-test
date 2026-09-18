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
 */
import type { Client } from "@modelcontextprotocol/client";
import { ARCADE_USER_ID_HEADER } from "../client/headers.ts";
import { createRequestLog, type OutboundRequest } from "../client/request-log.ts";
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
  apiKey: string;
  hookPublicUrl: string;
  hits: HitsClient;
}

/** DESIGN.md Contracts -> Probe CLI step 1. */
export function userIdFor(revision: string, timestamp: number, repetition: number): string {
  return `probe-${revision}-${timestamp}-${repetition}`;
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
  const userId = userIdFor(options.revision, options.timestamp, options.repetition);

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
    toolsListed = listed.length;
    gmailToolsListed = listed.filter(isGmailTool).length;

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
