/**
 * Report renderer — `bun run report [--in results/] [--out results/report.html]`.
 *
 * Reads every `*.json` run file written by the probe and renders one
 * self-contained HTML document: a summary table across protocol revisions,
 * then a section per run with the request timeline and the raw hook payloads.
 * See DESIGN.md Contracts -> Run JSON for the input shape and Contracts ->
 * Report for the output.
 *
 * Self-contained is a contract, not a style note: the engine team opens this
 * file from a directory with no network, so everything is inlined and nothing
 * is fetched. `test/report.test.ts` asserts that by scanning the output.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The only `schema` value this renderer understands. */
export const SCHEMA_VERSION = 1;

export const RUN_STATUSES = ["ok", "version-mismatch", "error"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunRequest {
  id: number;
  method: string;
  sentAt: string;
  hookHitsAfter: number;
  /**
   * Client-observed round trip for this request, hook round trips included.
   * Optional: a run file written before the probe measured it does not carry
   * it, and `undefined` here means *absent*, never zero.
   */
  durationMs?: number;
  /**
   * What the probe already records about a request beyond the four fields
   * DESIGN.md's Run JSON example spells out. `src/probe/run.ts` writes every
   * one of these; the renderer simply did not read them until issue #25 asked
   * for a row a reader can expand. Optional for the usual reason — a run file
   * written before the probe recorded a field carries nothing for it, and
   * `undefined` is *absent*, not a value.
   *
   * The MCP request and response **bodies** are here too, as of #31. They were
   * not, and the row said `body not recorded` in those words, because
   * `src/client/request-log.ts` pipes the response through rather than cloning
   * it and nothing captured one. The capture now happens inside that same
   * pass-through, so the row prints the frames where a run file carries them
   * and keeps saying `body not recorded` — honestly — where it does not.
   *
   */
  jsonRpcId?: number;
  finishedAt?: string;
  status?: number;
  userIdHeader?: string;
  authorizationScheme?: string;
  responseObserved?: boolean;
  /** Written only when this `tools/list` request followed a `nextCursor`. */
  cursor?: string;
  /**
   * The JSON-RPC request frame the probe put on the wire, whole (#31,
   * DESIGN.md decision 19).
   *
   * `undefined` is a run file written before that capture existed and says
   * nothing at all — the row still renders and still says so in words. It is
   * the reason this is optional rather than required: the operator has evidence
   * from before this slice and it has to stay readable.
   */
  requestFrame?: unknown;
  /**
   * The JSON-RPC reply frame, whole, or `null` when the stream ended without a
   * reply carrying this request's id.
   *
   * Three states, three different sentences, and none of them is `{}`:
   * `undefined` is a pre-#31 run file; `null` is the measurement "no reply was
   * observed"; anything else is the frame the gateway sent.
   */
  responseFrame?: unknown;
}

/**
 * One hook hit as the counter recorded it.
 *
 * Everything past `receivedAt`/`payload` is decision 17's profile, added by
 * slice #15 and passed through whole by the probe. Each is optional for the
 * same reason: a run recorded before the counter measured it has no value to
 * show, and `undefined` is a different statement from `0`. The renderer never
 * collapses the two — see {@link rangeCell} and {@link totalCell}.
 */
export interface HookHit {
  receivedAt: string;
  payload: unknown;
  /**
   * Every request header the hit arrived with, credential values already
   * replaced by a descriptor at capture (`Bearer <redacted len=43
   * sha256=1f3a9c2b>`). Rendered verbatim: the descriptor is the evidence that
   * the header was present, had a plausible shape, and — because the digest is
   * stable — carried the same value on every hit.
   */
  headers?: Record<string, string>;
  toolkitCount?: number;
  toolCount?: number;
  versionCount?: number;
  bodyBytes?: number;
  /**
   * The HTTP status this hook answered the hit with (#31, decision 19).
   * `undefined` is a run file from before the hook recorded its own answer —
   * never a 0, and never an assumed 200.
   */
  responseStatus?: number;
  /**
   * The body this hook sent back: the `AccessHookResult` that carried the deny.
   *
   * `undefined` is absent and says nothing. `{}` is the real measurement "this
   * hook expressed no opinion" — row three of the contract, *no change* — and
   * it is exactly the value that made #21's fail-open invisible, so it must
   * never render as "not recorded".
   */
  responseBody?: unknown;
  /**
   * The hook server's *own* received-to-answered time. It excludes the server's
   * JSONL append, because the number has to be inside the line it writes, so it
   * is neither what the hook cost the gateway nor what the client waited. The
   * report shows it beside the client-observed time and never sums the two.
   */
  handlingMs?: number;
}

export interface Run {
  schema: number;
  revisionRequested: string;
  /**
   * Nullable on purpose: a run that failed before `initialize` returned has
   * nothing to report here. `formatRevisionNegotiated` is the single place
   * that decides how the absence renders.
   */
  revisionNegotiated: string | null;
  status: RunStatus;
  userId: string;
  hookPublicUrl: string;
  requests: RunRequest[];
  hookHits: HookHit[];
  toolsListed: number;
  gmailToolsListed: number;
  error: string | null;
  /**
   * How many `tools/list` requests actually went out. One `tools/list` call is
   * not one request — the SDK client walks pagination itself — and a hook count
   * that is high because the client fetched three pages is a different result
   * from one that is high per request. Optional, and absent is not 1.
   */
  toolsListRequests?: number;
  /** Whether any of those requests followed a `nextCursor`. */
  cursorFollowed?: boolean;
  /**
   * Client-observed time spent on `tools/list`, summed over its requests.
   * `null` when none went out; `undefined` when the run does not record it.
   */
  toolsListDurationMs?: number | null;
  /**
   * The `tools/list` result as it came off the wire, whole, in page order
   * (added by #27, DESIGN.md decision 18).
   *
   * Entries travel through untouched — the courier rule the probe applies. The
   * renderer reads nothing inside them; it shows them.
   *
   * Three states, and they are three different statements:
   * `undefined` is a run file written before #27 and says nothing at all;
   * `null` is "no result was ever assembled" (the run died first);
   * `[]` is the real measurement "the gateway returned an empty list", which is
   * what a hook that denied everything produces.
   */
  toolsListResult?: unknown[] | null;
  /**
   * Tool names the gateway listed that appear in **no** hook payload: tools
   * never submitted to access control, so no policy could have denied them.
   *
   * Four states, none of which may be collapsed into another. `undefined` is a
   * pre-#27 run file. `null` is *cannot say* — the run observed no hook hits,
   * or assembled no result, so it is not evidence of anything. `[]` is the
   * measurement "every listed tool appeared in a hook payload". A non-empty
   * list names the tools that bypassed the hook.
   *
   * Rendering `null` as "none" would be the project's characteristic bug in a
   * different costume: an absence printed as a finding.
   */
  toolsNotOfferedToHook?: string[] | null;
}

/** One run file: its basename (which becomes the section id) and its contents. */
export interface LoadedRun {
  file: string;
  run: Run;
}

/** Thrown for anything that should stop the renderer with a named cause. */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function fail(file: string, reason: string): never {
  throw new ReportError(`${file}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(file: string, holder: Record<string, unknown>, key: string): string {
  const value = holder[key];
  if (typeof value !== "string") fail(file, `${key} must be a string`);
  return value;
}

function requireNumber(file: string, holder: Record<string, unknown>, key: string): number {
  const value = holder[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(file, `${key} must be a number`);
  }
  return value;
}

function requireNullableString(
  file: string,
  holder: Record<string, unknown>,
  key: string,
): string | null {
  const value = holder[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(file, `${key} must be a string or null`);
  return value;
}

/**
 * A field the run file may simply not carry.
 *
 * Absent is not zero. A run recorded before the probe measured `bodyBytes`
 * has nothing to say about payload size; a run that measured it and got 0
 * describes an empty body. Collapsing the two is the plausible-but-wrong
 * rendering this whole report exists to avoid, so absence travels as
 * `undefined` all the way to the cell that prints `not recorded`.
 *
 * A field that is *present* and the wrong type is still an error naming the
 * file: optional means "may be missing", not "may be anything".
 */
function optionalNumber(
  file: string,
  holder: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = holder[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(file, `${key} must be a number`);
  return value;
}

/** As {@link optionalNumber}, but the probe also writes an explicit `null`. */
function optionalNullableNumber(
  file: string,
  holder: Record<string, unknown>,
  key: string,
): number | null | undefined {
  const value = holder[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(file, `${key} must be a number or null`);
  }
  return value;
}

/** As {@link optionalNumber}, for a string field the run file may not carry. */
function optionalString(
  file: string,
  holder: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = holder[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(file, `${key} must be a string`);
  return value;
}

/**
 * An array the run file may not carry and may record as an explicit `null`.
 *
 * Elements are not inspected. `toolsListResult` is the gateway's own list
 * travelling through this renderer the way it travelled through the probe —
 * validating its shape would start trimming the evidence, which is the failure
 * #27 exists to prevent.
 */
function optionalNullableArray(
  file: string,
  holder: Record<string, unknown>,
  key: string,
): unknown[] | null | undefined {
  const value = holder[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) fail(file, `${key} must be an array or null`);
  return value;
}

/** As {@link optionalNullableArray}, for a list of names the report prints. */
function optionalNullableStringArray(
  file: string,
  holder: Record<string, unknown>,
  key: string,
): string[] | null | undefined {
  const value = optionalNullableArray(file, holder, key);
  if (value === undefined || value === null) return value;
  return value.map((entry, index) => {
    if (typeof entry !== "string") fail(file, `${key}[${index}] must be a string`);
    return entry;
  });
}

/**
 * A recorded **body**: any JSON value, taken as it stands.
 *
 * Nothing about its shape is validated. These are the gateway's bytes and this
 * hook's own answer travelling through the renderer the way they travelled
 * through the probe; checking them would start trimming the evidence, which is
 * the failure #31 exists to close.
 *
 * Absence and `null` are different answers and both are real here, so absence
 * is decided by whether the **key is present**, not by whether the value is
 * nullish: `responseFrame: null` is the measurement "no reply was observed",
 * and a missing `responseFrame` is a run file written before the capture. JSON
 * has no `undefined`, so `undefined` out of this function can only ever mean
 * "the key was not there".
 */
function optionalBody(holder: Record<string, unknown>, key: string): unknown {
  return key in holder ? holder[key] : undefined;
}

function optionalBoolean(
  file: string,
  holder: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = holder[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(file, `${key} must be a boolean`);
  return value;
}

/**
 * The captured request headers: a flat name-to-value map.
 *
 * Values are taken exactly as the counter stored them, redaction descriptors
 * included. The renderer adds no filter of its own — the secret never reached
 * disk, and re-redacting the descriptor would destroy the one diagnostic it
 * carries (the same value arrived on every hit).
 */
function optionalHeaders(
  file: string,
  holder: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = holder[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) fail(file, `${key} must be an object`);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") fail(file, `${key}["${name}"] must be a string`);
    headers[name] = headerValue;
  }
  return headers;
}

/** Drops keys whose value is `undefined`, so an absent field stays absent. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Parses one run file. Every deviation from the DESIGN.md schema is an error
 * naming the file: a run the report cannot read is a hole in the evidence, and
 * a hole that is skipped quietly reads exactly like a run that never happened.
 */
export function parseRun(file: string, text: string): Run {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(file, `not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(parsed)) fail(file, "not a JSON object");

  const schema = requireNumber(file, parsed, "schema");
  if (schema !== SCHEMA_VERSION) {
    fail(file, `unsupported schema ${schema}, expected ${SCHEMA_VERSION}`);
  }

  const status = requireString(file, parsed, "status");
  if (!(RUN_STATUSES as readonly string[]).includes(status)) {
    fail(file, `unknown status "${status}", expected one of ${RUN_STATUSES.join(" | ")}`);
  }

  const rawRequests = parsed["requests"];
  if (!Array.isArray(rawRequests)) fail(file, "requests must be an array");
  const requests = rawRequests.map((entry, index): RunRequest => {
    if (!isRecord(entry)) fail(file, `requests[${index}] is not an object`);
    return {
      id: requireNumber(file, entry, "id"),
      method: requireString(file, entry, "method"),
      sentAt: requireString(file, entry, "sentAt"),
      hookHitsAfter: requireNumber(file, entry, "hookHitsAfter"),
      ...defined({
        durationMs: optionalNumber(file, entry, "durationMs"),
        jsonRpcId: optionalNumber(file, entry, "jsonRpcId"),
        finishedAt: optionalString(file, entry, "finishedAt"),
        status: optionalNumber(file, entry, "status"),
        userIdHeader: optionalString(file, entry, "userIdHeader"),
        authorizationScheme: optionalString(file, entry, "authorizationScheme"),
        responseObserved: optionalBoolean(file, entry, "responseObserved"),
        cursor: optionalString(file, entry, "cursor"),
        requestFrame: optionalBody(entry, "requestFrame"),
        responseFrame: optionalBody(entry, "responseFrame"),
      }),
    };
  });

  const rawHits = parsed["hookHits"];
  if (!Array.isArray(rawHits)) fail(file, "hookHits must be an array");
  const hookHits = rawHits.map((entry, index): HookHit => {
    if (!isRecord(entry)) fail(file, `hookHits[${index}] is not an object`);
    if (!("payload" in entry)) fail(file, `hookHits[${index}].payload is missing`);
    return {
      receivedAt: requireString(file, entry, "receivedAt"),
      payload: entry["payload"],
      ...defined({
        headers: optionalHeaders(file, entry, "headers"),
        toolkitCount: optionalNumber(file, entry, "toolkitCount"),
        toolCount: optionalNumber(file, entry, "toolCount"),
        versionCount: optionalNumber(file, entry, "versionCount"),
        bodyBytes: optionalNumber(file, entry, "bodyBytes"),
        handlingMs: optionalNumber(file, entry, "handlingMs"),
        responseStatus: optionalNumber(file, entry, "responseStatus"),
        responseBody: optionalBody(entry, "responseBody"),
      }),
    };
  });

  return {
    schema,
    revisionRequested: requireString(file, parsed, "revisionRequested"),
    revisionNegotiated: requireNullableString(file, parsed, "revisionNegotiated"),
    status: status as RunStatus,
    userId: requireString(file, parsed, "userId"),
    hookPublicUrl: requireString(file, parsed, "hookPublicUrl"),
    requests,
    hookHits,
    toolsListed: requireNumber(file, parsed, "toolsListed"),
    gmailToolsListed: requireNumber(file, parsed, "gmailToolsListed"),
    error: requireNullableString(file, parsed, "error"),
    ...defined({
      toolsListRequests: optionalNumber(file, parsed, "toolsListRequests"),
      cursorFollowed: optionalBoolean(file, parsed, "cursorFollowed"),
      toolsListDurationMs: optionalNullableNumber(file, parsed, "toolsListDurationMs"),
      toolsListResult: optionalNullableArray(file, parsed, "toolsListResult"),
      toolsNotOfferedToHook: optionalNullableStringArray(file, parsed, "toolsNotOfferedToHook"),
    }),
  };
}

/**
 * Loads every `*.json` file in `dir`, sorted by filename (which starts with the
 * run timestamp, so the sort is chronological).
 *
 * A missing directory and an empty one both produce `no run files in <dir>`:
 * either way there is nothing to report, and the message names the directory
 * the caller actually passed.
 */
export async function loadRuns(dir: string): Promise<LoadedRun[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ReportError(`no run files in ${dir} (no such directory)`);
    }
    throw error;
  }

  const files = entries.filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) throw new ReportError(`no run files in ${dir}`);

  const loaded: LoadedRun[] = [];
  for (const file of files) {
    const text = await Bun.file(join(dir, file)).text();
    loaded.push({ file, run: parseRun(file, text) });
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Derived numbers
// ---------------------------------------------------------------------------

/**
 * Hook hits attributable to each request, in `run.requests` order.
 *
 * `hookHitsAfter` is *cumulative* for the run's user id (DESIGN.md Contracts ->
 * Run JSON), so the hits caused by a request are the difference between its
 * snapshot and the previous one. The first request's baseline is 0 because the
 * probe generates a fresh user id per repetition.
 *
 * Reading the raw `hookHitsAfter` instead is the plausible-but-wrong answer
 * this whole report exists to avoid; `test/fixtures/runs` contains a run where
 * the two disagree so the mistake cannot pass.
 */
export function hitsPerRequest(run: Run): number[] {
  let previous = 0;
  return run.requests.map((request) => {
    const delta = request.hookHitsAfter - previous;
    previous = request.hookHitsAfter;
    return delta;
  });
}

/**
 * Hook hits attributable to `method` in this run, summed over every request
 * that used it. Summing matters: DESIGN.md decision 4 exists because the SDK
 * may issue a method more than once behind the caller's back, and each of those
 * requests gets its own timeline row.
 *
 * Returns `undefined` when the run never issued the method, which is not the
 * same as issuing it and observing zero hits.
 */
export function hitsForMethod(run: Run, method: string): number | undefined {
  const deltas = hitsPerRequest(run);
  let total: number | undefined;
  run.requests.forEach((request, index) => {
    if (request.method !== method) return;
    total = (total ?? 0) + (deltas[index] ?? 0);
  });
  return total;
}

/** What a hit no request can account for is called, everywhere it is printed. */
export const NOT_ATTRIBUTED = "not attributed";

/**
 * The method that caused each hook hit, in `run.hookHits` order.
 *
 * Derived, not recorded: `hookHitsAfter` is the cumulative count for the run's
 * user id at the moment the request finished (DESIGN.md Contracts -> Run JSON),
 * and `hookHits` is in arrival order, so the hits whose index falls between two
 * consecutive snapshots are the ones that request caused. That is the whole
 * attribution — it needs no new probe field and no run-JSON change, which
 * matters because the run JSON is a contract the probe slice and the operator's
 * committed evidence both already depend on.
 *
 * `null` is a real answer, not a fallback. A hit past the last snapshot arrived
 * after the probe stopped looking and **no request can be shown to have caused
 * it**; folding it into the first method, or into the nearest one, would invent
 * an attribution the data does not support. It renders as
 * {@link NOT_ATTRIBUTED}.
 */
export function attributeHits(run: Run): (string | null)[] {
  const attributed: (string | null)[] = run.hookHits.map(() => null);
  let previous = 0;
  for (const request of run.requests) {
    const after = request.hookHitsAfter;
    for (let index = previous; index < after && index < attributed.length; index += 1) {
      attributed[index] = request.method;
    }
    // Snapshots are cumulative and so never decrease; clamping rather than
    // assigning keeps a malformed non-monotonic run from re-attributing hits
    // that an earlier request already claimed.
    if (after > previous) previous = after;
  }
  return attributed;
}

/** One method and the hits attributed to it in a single run. */
export interface MethodSplitEntry {
  method: string;
  hits: number;
}

/**
 * Hits per method for one run, in the order the methods were first issued,
 * with any unattributable hits last.
 *
 * Counts the hits the run section actually renders, so a reader can check the
 * split by counting rows in the hit table. A method that was issued and caused
 * nothing keeps its entry with `0`: that zero is a measurement — the request
 * went out and the hook did not fire — and dropping the row would read like the
 * method was never issued.
 */
export function methodSplit(run: Run): MethodSplitEntry[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  const note = (method: string): void => {
    if (!counts.has(method)) {
      counts.set(method, 0);
      order.push(method);
    }
  };

  for (const request of run.requests) note(request.method);

  let unattributed = 0;
  for (const method of attributeHits(run)) {
    if (method === null) {
      unattributed += 1;
      continue;
    }
    note(method);
    counts.set(method, counts.get(method)! + 1);
  }

  const entries = order.map((method) => ({ method, hits: counts.get(method)! }));
  if (unattributed > 0) entries.push({ method: NOT_ATTRIBUTED, hits: unattributed });
  return entries;
}

/**
 * One thing that crossed a wire during a run: an MCP request the client sent,
 * or a hook hit the counter received.
 *
 * Two sides, one sequence. The run JSON keeps them in separate arrays and the
 * report used to render them as two separate tables, which left the reader to
 * correlate timestamps by eye to answer the only question that matters — which
 * request caused which hit.
 */
export type WireEvent =
  | {
      side: "client";
      at: string;
      /** Index into `run.requests`. */
      index: number;
      request: RunRequest;
    }
  | {
      side: "hook";
      at: string;
      /** Index into `run.hookHits`. */
      index: number;
      hit: HookHit;
      /** The method attributed to this hit, or `null` for {@link NOT_ATTRIBUTED}. */
      causedBy: string | null;
    };

/**
 * Everything that crossed a wire in one run, in chronological order.
 *
 * Requests are placed at `sentAt` and hits at `receivedAt`. On an exact tie the
 * request comes first, because a hit is a consequence of a request and the sort
 * is stable over an array built requests-first — putting the effect above the
 * cause would misread the storyline the table exists to tell.
 *
 * An unparseable timestamp sorts as `0` rather than `NaN`, which would make the
 * comparison non-transitive and the order arbitrary.
 */
export function wireEvents(run: Run): WireEvent[] {
  const attributed = attributeHits(run);
  const events: WireEvent[] = [
    ...run.requests.map((request, index): WireEvent => ({
      side: "client",
      at: request.sentAt,
      index,
      request,
    })),
    ...run.hookHits.map((hit, index): WireEvent => ({
      side: "hook",
      at: hit.receivedAt,
      index,
      hit,
      causedBy: attributed[index] ?? null,
    })),
  ];
  const time = (value: string): number => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  return events.sort((a, b) => time(a.at) - time(b.at));
}

/**
 * Milliseconds from the run's first wire event to `at`.
 *
 * The first event is the origin rather than a `startedAt` field: the run JSON's
 * `startedAt` is not part of the schema DESIGN.md records, and an offset a
 * reader can re-derive from the timestamps already in the table beats one that
 * depends on a field half the run files do not carry. `null` when either end
 * cannot be parsed — an absence, never a `0` that looks like simultaneity.
 */
export function offsetMs(origin: string | undefined, at: string): number | null {
  if (origin === undefined) return null;
  const from = Date.parse(origin);
  const to = Date.parse(at);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return to - from;
}

/**
 * A min/max over values that some of the records may not carry.
 *
 * `recorded` and `total` are part of the answer, not bookkeeping: a range over
 * three of seven hits is a partial reading, and printing `10–12` without saying
 * so would let four unmeasured hits disappear into a number that looks whole.
 */
export interface Range {
  min: number;
  max: number;
  /** How many of the records carried the field. `0` means nothing was measured. */
  recorded: number;
  /** How many records were in scope, measured or not. */
  total: number;
}

/** A sum over values some of the records may not carry. Same contract as {@link Range}. */
export interface Total {
  sum: number;
  recorded: number;
  total: number;
}

function rangeOf(values: (number | undefined)[]): Range {
  const present = values.filter((value): value is number => value !== undefined);
  return {
    min: present.length === 0 ? 0 : Math.min(...present),
    max: present.length === 0 ? 0 : Math.max(...present),
    recorded: present.length,
    total: values.length,
  };
}

function totalOf(values: (number | undefined)[]): Total {
  const present = values.filter((value): value is number => value !== undefined);
  return {
    sum: present.reduce((sum, value) => sum + value, 0),
    recorded: present.length,
    total: values.length,
  };
}

/**
 * The set of toolkits and tools a hook payload carried, as a comparable key.
 *
 * Names, not counts. "Every hit carried the same set" is a stronger statement
 * than "every hit carried the same number", and only the second one survives a
 * comparison of `toolCount`: two hits can both carry 51 tools and carry
 * different ones. Versions are deliberately out — `versionCount` reports that
 * axis, and folding it in here would report a version bump as a changed set.
 *
 * `null` when the payload is not shaped like the access-hook contract, which
 * is a third answer ("cannot tell"), not a fourth set.
 */
export function toolSetSignature(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const toolkits = payload["toolkits"];
  if (!isRecord(toolkits)) return null;

  const names: string[] = [];
  for (const [toolkitName, toolkit] of Object.entries(toolkits)) {
    if (!isRecord(toolkit)) return null;
    const tools = toolkit["tools"];
    if (!isRecord(tools)) return null;
    const toolNames = Object.keys(tools);
    // An empty toolkit is still part of the set: a hit that carried `Gmail`
    // with no tools differs from one that did not carry `Gmail` at all.
    if (toolNames.length === 0) names.push(`${toolkitName}:`);
    for (const tool of toolNames) names.push(`${toolkitName}:${tool}`);
  }
  return names.sort().join("\u0000");
}

/**
 * Whether every hit in scope carried the same toolkits and tools.
 *
 * `single` is its own answer because "identical across 1 hit" is not evidence
 * of anything, and `not-comparable` is its own because a payload we cannot read
 * must not be quietly counted as agreeing with the others.
 */
export type SetSameness = "none" | "single" | "identical" | "varies" | "not-comparable";

export function setSameness(hits: HookHit[]): SetSameness {
  if (hits.length === 0) return "none";
  const signatures = hits.map((hit) => toolSetSignature(hit.payload));
  if (signatures.some((signature) => signature === null)) return "not-comparable";
  if (new Set(signatures).size > 1) return "varies";
  return hits.length === 1 ? "single" : "identical";
}

/** What a group of hook hits carried, and what the hook server spent answering. */
export interface HitProfile {
  /** Hits in scope. */
  hits: number;
  toolkits: Range;
  tools: Range;
  versions: Range;
  bytes: Total;
  /** The hook server's own handling time, summed. Never added to client time. */
  handlingMs: Total;
  sameness: SetSameness;
}

export function profileHits(hits: HookHit[]): HitProfile {
  return {
    hits: hits.length,
    toolkits: rangeOf(hits.map((hit) => hit.toolkitCount)),
    tools: rangeOf(hits.map((hit) => hit.toolCount)),
    versions: rangeOf(hits.map((hit) => hit.versionCount)),
    bytes: totalOf(hits.map((hit) => hit.bodyBytes)),
    handlingMs: totalOf(hits.map((hit) => hit.handlingMs)),
    sameness: setSameness(hits),
  };
}

/**
 * How many `tools/list` requests a group of runs actually issued.
 *
 * `paged` is the number that changes what the hit counts *mean*: a run that
 * issued three requests spreads its hits over three of them, so its hit count
 * is not a per-request count. The report says which it is looking at rather
 * than leaving the reader to divide.
 */
export interface ToolsListProfile {
  /** Runs in scope. */
  runs: number;
  /** Runs that record the number at all. */
  recorded: number;
  /** Total requests across the runs that record it. */
  requests: number;
  min: number;
  max: number;
  /** Runs that issued more than one. */
  paged: number;
  /** Runs that followed a `nextCursor`. */
  cursorFollowed: number;
}

export function profileToolsList(runs: Run[]): ToolsListProfile {
  const counts = runs
    .map((run) => run.toolsListRequests)
    .filter((count): count is number => count !== undefined);
  return {
    runs: runs.length,
    recorded: counts.length,
    requests: counts.reduce((sum, count) => sum + count, 0),
    min: counts.length === 0 ? 0 : Math.min(...counts),
    max: counts.length === 0 ? 0 : Math.max(...counts),
    paged: counts.filter((count) => count > 1).length,
    cursorFollowed: runs.filter((run) => run.cursorFollowed === true).length,
  };
}

/**
 * Client-observed `tools/list` wall clock across runs.
 *
 * A run that recorded `null` measured nothing because nothing went out, which
 * is a measurement: it counts as recorded and contributes 0. A run with no
 * field at all contributes nothing and lowers `recorded`.
 */
export function clientToolsListMs(runs: Run[]): Total {
  return totalOf(
    runs.map((run) =>
      run.toolsListDurationMs === undefined
        ? undefined
        : (run.toolsListDurationMs ?? 0),
    ),
  );
}

export interface RevisionSummary {
  revision: string;
  /** Every run for this revision, whatever its status. */
  repetitions: number;
  /** Runs with `status: "ok"` — the only ones behind the statistics. */
  okRepetitions: number;
  /** null when no ok run issued `tools/list`. */
  toolsListHits: { min: number; max: number; mean: number } | null;
  /** Total hook hits attributed to `initialize` across the ok runs. */
  initializeHits: number | null;
  versionMismatches: number;
  errors: number;
  /** Distinct `gmailToolsListed` values across the ok runs, ascending. */
  gmailToolsListed: number[];
  /** What the ok runs' hook hits carried, and what the hook server spent. */
  hits: HitProfile;
  /** `tools/list` requests the client actually issued across the ok runs. */
  toolsList: ToolsListProfile;
  /**
   * Client-observed `tools/list` wall clock across the ok runs.
   *
   * Reported beside `hits.handlingMs` and never added to it: one is the hook
   * server's own received-to-answered time (and it excludes the server's JSONL
   * append), the other is the whole round trip the client waited on. The gap
   * between them is tunnel, gateway, and the hook work that falls outside the
   * hook's own measurement — which is the number a reader chasing latency is
   * actually after.
   */
  clientToolsListMs: Total;
}

/**
 * One row per `revisionRequested`, sorted by revision.
 *
 * Runs whose status is not `ok` are counted in the version-mismatch and error
 * columns and excluded from every derived number: a run that negotiated a
 * different revision measured a different thing, and an errored run measured an
 * incomplete one. Averaging either into min/max/mean would make a broken run
 * look like a data point.
 */
export function summarize(loaded: LoadedRun[]): RevisionSummary[] {
  const byRevision = new Map<string, LoadedRun[]>();
  for (const entry of loaded) {
    const key = entry.run.revisionRequested;
    const bucket = byRevision.get(key);
    if (bucket === undefined) byRevision.set(key, [entry]);
    else bucket.push(entry);
  }

  return [...byRevision.keys()].sort().map((revision) => {
    const runs = byRevision.get(revision)!.map((entry) => entry.run);
    const ok = runs.filter((run) => run.status === "ok");

    const listHits = ok
      .map((run) => hitsForMethod(run, "tools/list"))
      .filter((hits): hits is number => hits !== undefined);

    const initHits = ok
      .map((run) => hitsForMethod(run, "initialize"))
      .filter((hits): hits is number => hits !== undefined);

    return {
      revision,
      repetitions: runs.length,
      okRepetitions: ok.length,
      toolsListHits:
        listHits.length === 0
          ? null
          : {
              min: Math.min(...listHits),
              max: Math.max(...listHits),
              mean: listHits.reduce((sum, n) => sum + n, 0) / listHits.length,
            },
      initializeHits:
        initHits.length === 0 ? null : initHits.reduce((sum, n) => sum + n, 0),
      versionMismatches: runs.filter((run) => run.status === "version-mismatch").length,
      errors: runs.filter((run) => run.status === "error").length,
      gmailToolsListed: [...new Set(ok.map((run) => run.gmailToolsListed))].sort(
        (a, b) => a - b,
      ),
      hits: profileHits(ok.flatMap((run) => run.hookHits)),
      toolsList: profileToolsList(ok),
      clientToolsListMs: clientToolsListMs(ok),
    };
  });
}

// ---------------------------------------------------------------------------
// Raw payloads: where each one is rendered, and which are repeats
// ---------------------------------------------------------------------------

/** The anchor id of one hit's raw-payload block. */
export function payloadAnchor(file: string, hitIndex: number): string {
  return `${file}--payload-${hitIndex + 1}`;
}

/** How a reader is told which hit a payload block belongs to. */
export function payloadLabel(file: string, hitIndex: number): string {
  return `hit ${hitIndex + 1} of ${file}`;
}

/**
 * The anchor id of one run's `tools/list` result **block** — what a row links
 * to. Present on every run that has a block, repeats included.
 */
export function toolsListAnchor(file: string): string {
  return `${file}--tools-list`;
}

/** The anchor id of the `<pre>` holding one hit's recorded response body. */
export function hookResponseAnchor(file: string, hitIndex: number): string {
  return `${file}--hook-response-${hitIndex + 1}`;
}

/** How a reader is told which hit a recorded hook response belongs to. */
export function hookResponseLabel(file: string, hitIndex: number): string {
  return `the response to hit ${hitIndex + 1} of ${file}`;
}

/** The anchor id of the `<pre>` holding one request's outbound JSON-RPC frame. */
export function requestFrameAnchor(file: string, requestIndex: number): string {
  return `${file}--mcp-request-${requestIndex + 1}`;
}

export function requestFrameLabel(file: string, requestIndex: number): string {
  return `the request frame of MCP request ${requestIndex + 1} of ${file}`;
}

/** The anchor id of the `<pre>` holding one request's inbound JSON-RPC frame. */
export function responseFrameAnchor(file: string, requestIndex: number): string {
  return `${file}--mcp-response-${requestIndex + 1}`;
}

export function responseFrameLabel(file: string, requestIndex: number): string {
  return `the response frame of MCP request ${requestIndex + 1} of ${file}`;
}

/** The id of the `<pre>` holding one hit's shared `toolkits` object. */
export function toolkitsStoreId(file: string, hitIndex: number): string {
  return `${file}--toolkits-${hitIndex + 1}`;
}

/**
 * The id of the `<pre>` holding the embedded copy, distinct from
 * {@link toolsListAnchor}.
 *
 * They must not be the same string. The explorer finds its data with
 * `document.getElementById`, so a block and the `<pre>` inside it sharing an id
 * makes the lookup return the block — whose `textContent` is the summary line
 * plus the JSON — and every payload silently fails to parse. That is a bug no
 * assertion about the HTML would catch and only a browser shows, which is how
 * this one was found.
 */
export function toolsListStoreId(file: string): string {
  return `${file}--tools-list-json`;
}

export function toolsListLabel(file: string): string {
  return `the tools/list result of ${file}`;
}

/**
 * Above this many bytes of compact JSON, the embedded copy is stored compact
 * instead of pretty-printed.
 *
 * Not a size cap — **nothing is ever truncated**; compact means whitespace
 * removed and nothing else. The threshold exists because the two readers of the
 * stored copy want different things. Below it, the stored text is what a person
 * actually reads in the no-script fallback, and indenting it costs a few
 * kilobytes. Above it, nobody reads a 1.6 MB payload as a wall of text — the
 * explorer formats it on expand — so the indentation is pure weight: on the
 * live evidence, pretty-printing and escaping turned a 1,598,220 B payload into
 * 5,061,881 characters, three quarters of a megabyte of which is indentation
 * for a form no reader uses.
 *
 * 64 KiB because every payload in the repository's fixtures, and any payload a
 * person would sit and read, is far below it, while the catalogue payload that
 * made the live report 26 MB is twenty-four times above it.
 */
export const PRETTY_PAYLOAD_MAX_BYTES = 65_536;

/**
 * Above this many bytes, a `toolkits` object shared by more than one payload is
 * stored once and referenced, instead of being re-embedded inside each payload.
 *
 * The live evidence is the reason. Its five catalogue payloads are **not**
 * byte-identical — they differ in `user_id` — so whole-payload deduplication
 * correctly declines to collapse them, and the report carried five copies of
 * the same 1.6 MB `toolkits` object for the sake of five different id strings.
 * Splitting the shared part out recovers that without collapsing anything the
 * payloads actually disagree about.
 *
 * Only worth it when the shared part is large: below this, the reference costs
 * more than the object, and splitting a small payload into two pieces would
 * make it harder to read for no gain. 64 KiB, the same line
 * {@link PRETTY_PAYLOAD_MAX_BYTES} draws, so a payload is either small and
 * whole and indented, or large and stored the economical way.
 */
export const TOOLKITS_STORE_MIN_BYTES = 65_536;

/** The key whose value is eligible to be stored once and shared. */
const SHARED_KEY = "toolkits";

/**
 * A large `toolkits` object stored once, outside the payloads that carry it.
 *
 * The payload is still shown whole: its own fields are rendered from its own
 * bytes and the shared object from the store's, so nothing is rewritten and no
 * `$ref` is invented inside evidence JSON. The explorer reassembles the two
 * into the exact payload the gateway sent.
 */
export interface SharedToolkits {
  /** Which key was stored separately. Always `toolkits` today. */
  key: string;
  /** id of the `<pre>` holding the one copy. */
  storeId: string;
  /** sha-256 of the shared object's bytes. */
  digest: string;
  /** True when this payload's block is the one that emits the store. */
  emitsStore: boolean;
  /** Where the copy is, when this payload is not the one that emits it. */
  sameAs?: { anchor: string; label: string };
}

/** Where one hook payload is rendered, and whether it is a repeat of another. */
export interface PayloadPlacement {
  /** This occurrence's own anchor id, so a repeat can be linked to as well. */
  anchor: string;
  /** sha-256 over the payload bytes — the same string `bodyBytes` counts. */
  digest: string;
  /**
   * The id of the `<pre>` that holds this payload's one embedded copy. Equal to
   * {@link anchor} on the first occurrence and to the first occurrence's anchor
   * on a repeat, so a repeat's explorer reads the same embedded data instead of
   * a second copy of it.
   */
  storedAt: string;
  /**
   * Set only when this payload is **byte-identical** to an earlier one, which
   * is where the body is stored. `undefined` means this occurrence carries it.
   */
  sameAs?: { anchor: string; label: string };
  /**
   * Set when this payload's `toolkits` object is large and shared with another
   * payload, so it lives in its own store and {@link storedAt} holds only this
   * payload's remaining fields.
   */
  sharedToolkits?: SharedToolkits;
}

/**
 * Every kind of body this report can place, with the words it is counted in.
 *
 * **One table, two jobs.** The keys are the kinds the plan tallies and the
 * values are the nouns the sentence prints, so the total and the named parts
 * cannot drift apart: both are derived from this. A kind cannot be counted
 * without being nameable, because {@link BodyKind} *is* the key set — adding a
 * placement kind without a label here is a type error, not a quietly wrong
 * number.
 *
 * That is the point. Round 1's finding was `tools/list` results counted as hook
 * payloads; round 2's was shared `toolkits` objects counted as nothing at all.
 * Both came from a sentence assembled by hand beside a total assembled
 * separately. Two special cases invited a third, so there are no special cases
 * now.
 *
 * The shared object is **named rather than excluded**: it is a real `<pre>` on
 * the page with its own bytes and its own digest, and a total called "bodies"
 * that silently left some bodies out would be the same class of untruth in the
 * other direction. Insertion order is print order.
 */
export const BODY_KINDS = {
  "hook-payload": { one: "hook payload", many: "hook payloads" },
  "hook-response": { one: "hook response", many: "hook responses" },
  "shared-toolkits": { one: "shared toolkits object", many: "shared toolkits objects" },
  "mcp-request-frame": { one: "MCP request frame", many: "MCP request frames" },
  "mcp-response-frame": { one: "MCP response frame", many: "MCP response frames" },
  "tools-list-result": { one: "tools/list result", many: "tools/list results" },
} as const;

export type BodyKind = keyof typeof BODY_KINDS;

/** The kinds in print order, from the one table that defines them. */
export const BODY_KIND_ORDER = Object.keys(BODY_KINDS) as BodyKind[];

/** How many bodies of one kind were placed, and how many were repeats. */
export interface BodyCount {
  occurrences: number;
  repeats: number;
}

/**
 * Where one MCP request's two frames live, or `null` for each the run file does
 * not carry.
 *
 * `null` covers both "this run predates the capture" and "no reply was
 * observed"; which of the two it was is a question about the run, not about the
 * store, and {@link requestBodyNote} answers it in words.
 */
export interface McpFramePlacement {
  request: PayloadPlacement | null;
  response: PayloadPlacement | null;
}

/** Every body one run puts on the page, indexed the way the run section reads them. */
export interface RunPlacements {
  /** One per hook hit, in `run.hookHits` order. */
  hookPayloads: PayloadPlacement[];
  /** One per hook hit; `null` where the hit records no response of its own. */
  hookResponses: (PayloadPlacement | null)[];
  /** One per MCP request, in `run.requests` order. */
  mcpFrames: McpFramePlacement[];
  /** The run's `tools/list` result, or `null` where it has none to embed. */
  toolsListResult: PayloadPlacement | null;
}

export interface PayloadPlan {
  /** One entry per loaded run, holding every body that run puts on the page. */
  perRun: RunPlacements[];
  /**
   * Every placement, tallied by kind — the single structure both the total and
   * the printed sentence are derived from. See {@link BODY_KINDS}.
   */
  bodies: Record<BodyKind, BodyCount>;
  /** Every placement, whatever its kind. Always the sum over {@link bodies}. */
  occurrences: number;
  /** Distinct bodies — how many are embedded at all. */
  distinct: number;
  /** Placements that are repeats and therefore embed nothing. */
  repeats: number;
  /**
   * Characters of escaped, stored JSON the repeats did not re-emit.
   * The measurement behind "the report shrank", kept here so a test can pin it
   * instead of trusting that a smaller file means the right thing happened.
   */
  charsSaved: number;
}

/** An empty tally with an entry for every kind, so none can be forgotten. */
function emptyBodies(): Record<BodyKind, BodyCount> {
  return Object.fromEntries(
    BODY_KIND_ORDER.map((kind) => [kind, { occurrences: 0, repeats: 0 }]),
  ) as Record<BodyKind, BodyCount>;
}

/**
 * Decides, for every hook payload in the report, whether it renders in full or
 * as a pointer to an earlier byte-identical one.
 *
 * **Identical is computed, never assumed.** The map is keyed by the payload's
 * own JSON text, so two payloads collapse only when every byte matches — not
 * when their `toolkitCount` and `bodyBytes` happen to agree, and not because a
 * digest matched. The digest is printed for the reader to verify; the decision
 * does not rest on it. A payload that differs anywhere, by one tool or by one
 * character, is rendered in full: this project exists to measure a hook whose
 * behaviour is invisible unless measured, and a report that quietly hid a
 * difference between two hits would be the exact failure it is built to catch.
 *
 * Deduplication is document-wide, not per run, because the measured evidence
 * has the catalogue payload byte-identical *across* runs — which is where
 * almost all of the duplication was.
 */
export function planPayloads(loaded: LoadedRun[]): PayloadPlan {
  const seen = new Map<string, { anchor: string; label: string; digest: string }>();
  const perRun: RunPlacements[] = [];
  const bodies = emptyBodies();
  let charsSaved = 0;

  /**
   * How many hook payloads in the whole report carry each large `toolkits`
   * object, worked out before anything is placed.
   *
   * Splitting a payload is only worth doing when the object is actually shared,
   * and that is a property of the document, not of the payload in hand — so it
   * cannot be decided while walking the payloads one at a time.
   */
  const sharedCounts = new Map<string, number>();
  for (const { run } of loaded) {
    for (const hit of run.hookHits) {
      const text = shareableToolkitsText(hit.payload);
      if (text !== undefined) sharedCounts.set(text, (sharedCounts.get(text) ?? 0) + 1);
    }
  }

  /**
   * Places one body in the shared store, or points it at the copy already
   * there, and tallies it under its kind.
   *
   * Every placement goes through here and every placement declares a kind, so
   * the total the report prints is the sum of the parts it names. There is no
   * second path that could add to one without the other.
   */
  const place = (
    kind: BodyKind,
    body: string,
    anchor: string,
    label: string,
    displayDigest?: string,
  ): PayloadPlacement => {
    const tally = bodies[kind];
    tally.occurrences += 1;
    const earlier = seen.get(body);
    if (earlier === undefined) {
      const digest = createHash("sha256").update(body).digest("hex");
      seen.set(body, { anchor, label, digest });
      return { anchor, digest: displayDigest ?? digest, storedAt: anchor };
    }
    tally.repeats += 1;
    charsSaved += escapeHtml(storedText(body)).length;
    return {
      anchor,
      digest: displayDigest ?? earlier.digest,
      storedAt: earlier.anchor,
      sameAs: { anchor: earlier.anchor, label: earlier.label },
    };
  };

  /**
   * One hook payload, split in two when its `toolkits` object is large and
   * carried by more than one payload in this report.
   *
   * Split means *stored* in two parts, never *shown* in two: the payload's own
   * fields come from its own bytes, the shared object from the store's, and the
   * explorer puts them back together into exactly what the gateway sent.
   * Nothing is rewritten — inventing a `$ref` inside evidence JSON would make
   * the raw block stop being the gateway's bytes, which is the failure this
   * report is an instrument against.
   *
   * The split adds a second placement, of a second kind. It is counted as one,
   * named as one, and neither of those is optional.
   */
  const placeHookPayload = (
    payload: unknown,
    file: string,
    index: number,
  ): PayloadPlacement => {
    const whole = payloadText(payload);
    const wholeDigest = createHash("sha256").update(whole).digest("hex");
    const anchor = payloadAnchor(file, index);
    const label = payloadLabel(file, index);
    const toolkits = shareableToolkitsText(payload);

    if (toolkits === undefined || (sharedCounts.get(toolkits) ?? 0) < 2) {
      return place("hook-payload", whole, anchor, label, wholeDigest);
    }

    // Own fields first, keyed on their own bytes: two payloads that agree on
    // everything but the shared object share this store too, and one that does
    // not gets its own.
    const own = place(
      "hook-payload",
      withoutShared(payload),
      anchor,
      `the own fields of ${label}`,
      wholeDigest,
    );
    const store = place(
      "shared-toolkits",
      toolkits,
      toolkitsStoreId(file, index),
      `the toolkits of ${label}`,
    );
    return {
      ...own,
      sharedToolkits: {
        key: SHARED_KEY,
        storeId: store.storedAt,
        digest: store.digest,
        emitsStore: store.sameAs === undefined,
        ...(store.sameAs === undefined ? {} : { sameAs: store.sameAs }),
      },
    };
  };

  /**
   * A body the run file may simply not carry, placed only when it is there.
   *
   * The absent case gets no placement and no tally entry, because there is no
   * body: a run written before #31 must not contribute a phantom to "this
   * report embeds N bodies".
   */
  const placeOptional = (
    kind: BodyKind,
    body: unknown,
    anchor: string,
    label: string,
  ): PayloadPlacement | null =>
    body === undefined ? null : place(kind, payloadText(body), anchor, label);

  for (const { file, run } of loaded) {
    // Hook payloads and their responses first, then the MCP frames, then the
    // run's `tools/list` result: the order the run section renders them in, so
    // "the first occurrence carries the body" means the first one a reader
    // meets. Kinds never collide on bytes with each other by accident — the
    // store is keyed on the JSON text, so two bodies share a copy only when
    // they are byte for byte the same thing, whatever kind each is.
    const hookPayloads = run.hookHits.map((hit, index) =>
      placeHookPayload(hit.payload, file, index),
    );
    const hookResponses = run.hookHits.map((hit, index) =>
      placeOptional(
        "hook-response",
        hit.responseBody,
        hookResponseAnchor(file, index),
        hookResponseLabel(file, index),
      ),
    );
    const mcpFrames = run.requests.map((request, index): McpFramePlacement => ({
      request: placeOptional(
        "mcp-request-frame",
        request.requestFrame,
        requestFrameAnchor(file, index),
        requestFrameLabel(file, index),
      ),
      // A `null` frame is the measurement "no reply was observed" and has no
      // body to embed; the row says so in words rather than storing a `null`.
      response:
        request.responseFrame === null
          ? null
          : placeOptional(
              "mcp-response-frame",
              request.responseFrame,
              responseFrameAnchor(file, index),
              responseFrameLabel(file, index),
            ),
    }));
    const toolsListResult = Array.isArray(run.toolsListResult)
      ? place(
          "tools-list-result",
          payloadText(run.toolsListResult),
          toolsListStoreId(file),
          toolsListLabel(file),
        )
      : null;

    perRun.push({ hookPayloads, hookResponses, mcpFrames, toolsListResult });
  }

  // Derived, never accumulated alongside: the total is the sum of exactly the
  // parts the sentence names, by construction rather than by agreement.
  const counts = BODY_KIND_ORDER.map((kind) => bodies[kind]);
  return {
    perRun,
    bodies,
    occurrences: counts.reduce((sum, count) => sum + count.occurrences, 0),
    distinct: seen.size,
    repeats: counts.reduce((sum, count) => sum + count.repeats, 0),
    charsSaved,
  };
}

/**
 * The payload's `toolkits` value as JSON, when it is big enough to be worth
 * storing apart. `undefined` when the payload is not shaped like the
 * access-hook contract, or when the object is small enough that splitting it
 * would cost more than it saves.
 */
function shareableToolkitsText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const toolkits = payload[SHARED_KEY];
  if (!isRecord(toolkits)) return undefined;
  const text = payloadText(toolkits);
  return Buffer.byteLength(text, "utf8") >= TOOLKITS_STORE_MIN_BYTES ? text : undefined;
}

/** The payload as JSON with the shared key removed, key order otherwise intact. */
function withoutShared(payload: unknown): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (key !== SHARED_KEY) rest[key] = value;
  }
  return payloadText(rest);
}

/**
 * The payload's bytes as a comparison key and as the digest's input.
 *
 * Compact, not pretty-printed: it is the same string the hook counter measured
 * for `bodyBytes`, so a digest printed here can be reproduced from the run JSON
 * with `jq -cj '.hookHits[N].payload' run.json | shasum -a 256`.
 */
function payloadText(payload: unknown): string {
  return JSON.stringify(payload) ?? "null";
}

/** {@link payloadText}, for callers outside the plan. */
function payloadTextOf(value: unknown): string {
  return payloadText(value);
}

/**
 * The payload as the document embeds it: pretty-printed while it is small
 * enough for a person to read as text, compact once it is not.
 *
 * Complete either way — see {@link PRETTY_PAYLOAD_MAX_BYTES}. The explorer
 * parses this same text, so there is exactly one copy of a payload in the
 * document no matter which form it took.
 */
export function storedPayload(payload: unknown): string {
  return storedText(payloadText(payload));
}

/**
 * {@link storedPayload} for a body the caller already serialised.
 *
 * The plan works in JSON text — that is what it compares and digests — so it
 * must not have to parse a body back into a value just to ask how long the
 * stored form would be.
 */
export function storedText(compact: string): string {
  return Buffer.byteLength(compact, "utf8") > PRETTY_PAYLOAD_MAX_BYTES
    ? compact
    : prettyText(compact);
}

/** Re-indents compact JSON. Same bytes, same order, whitespace added. */
function prettyText(compact: string): string {
  return JSON.stringify(JSON.parse(compact), null, 2) ?? "null";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The single place that decides how `revisionNegotiated` reads when the probe
 * had nothing to record. Keep it here: the run-JSON ruling for that case is
 * recorded on issue #5, and applying it should touch one function.
 */
export function formatRevisionNegotiated(value: string | null): string {
  return value === null || value.trim() === "" ? "—" : value;
}

/** At most two decimals, with no trailing zeros: 2 renders as `2`, not `2.00`. */
export function formatMean(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Milliseconds to microsecond resolution.
 *
 * The hook counter keeps microseconds for a reason — a local hook answers in
 * well under a millisecond, and rounding to an integer would print `0`, which a
 * reader cannot tell from "not measured". Rounding here would undo that.
 */
export function formatMs(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * How "every hit carried the same set" reads.
 *
 * Spelled out rather than left for the reader to infer from a min and a max
 * that happen to match: equal counts are not an identical set, and the issue
 * asks for the statement, not the coincidence.
 */
export function samenessText(sameness: SetSameness, hits: number): string {
  switch (sameness) {
    case "none":
      return "no hits";
    case "single":
      return "1 hit only";
    case "identical":
      return `identical on all ${hits} hits`;
    case "varies":
      return `varies across ${hits} hits`;
    case "not-comparable":
      return "not comparable";
  }
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 2rem 1.5rem; max-width: 70rem;
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #16181d; background: #fff;
}
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.2rem; margin: 2.5rem 0 .75rem; padding-bottom: .3rem; border-bottom: 2px solid #16181d; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
h4 { font-size: .85rem; margin: 1rem 0 .35rem; font-weight: 600; color: #44485a; }
p.sub { margin: 0 0 1.5rem; color: #5a5f70; font-size: .85rem; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .85rem; }
th, td { border: 1px solid #d3d6e0; padding: .4rem .55rem; text-align: right; vertical-align: top; }
th { background: #f2f3f7; font-weight: 600; text-align: right; }
th:first-child, td:first-child, td.text, th.text { text-align: left; }
td.num { font-variant-numeric: tabular-nums; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre {
  background: #f7f8fa; border: 1px solid #e2e4ec; border-radius: 4px;
  padding: .6rem .75rem; overflow-x: auto; font-size: .78rem; margin: 0 0 .75rem;
}
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .9rem; margin: .5rem 0 1rem; font-size: .85rem; }
dl.meta dt { color: #5a5f70; }
dl.meta dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
section.run { border-top: 1px solid #e2e4ec; padding-top: .5rem; margin-top: 2rem; }
.status { display: inline-block; padding: .05rem .45rem; border-radius: 3px; font-size: .78rem; font-weight: 600; }
.status-ok { background: #e3f5e8; color: #14622f; }
.status-version-mismatch { background: #fdf0d5; color: #7a5200; }
.status-error { background: #fbe3e3; color: #8a1c1c; }
.empty { color: #8b90a0; }
.callout {
  margin: 1rem 0 1.25rem; padding: .7rem .9rem; border-radius: 4px;
  border: 1px solid #d3d6e0; background: #f7f8fa; font-size: .88rem;
}
.callout ul { margin: .45rem 0 0; padding-left: 1.2rem; }
.callout-warn { border-color: #e6c072; background: #fdf6e6; }
.callout-ok { border-color: #a8dcb8; background: #f1faf3; }
.callout-unknown { border-color: #c9ccd8; background: #f4f5f8; }
table.wire tr.event.hook > td:first-child { border-left: 3px solid #7f8cc4; }
table.wire tr.event.client > td:first-child { border-left: 3px solid #16181d; }
table.wire tr.detail > td { background: #fafbfd; padding: .35rem .55rem; }
details.event > summary {
  cursor: pointer; font-size: .76rem; word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #2b2f3a;
}
details.event > summary::marker { color: #7f8cc4; }
details.event dl.meta { margin: .5rem 0 .5rem 1.1rem; font-size: .8rem; }
details.event h5 { margin: .8rem 0 .3rem 1.1rem; font-size: .78rem; color: #44485a; }
details.raw { margin: .4rem 0 .4rem 1.1rem; }
details.raw > summary { cursor: pointer; font-size: .75rem; color: #5a5f70; }
details.raw > pre { margin: .3rem 0 0; }
.headers { margin-left: 1.1rem; font-size: .72rem; line-height: 1.4; }
.hdr { word-break: break-all; }
p.repeat-note { margin: .4rem 0 .4rem 1.1rem; font-size: .8rem; word-break: break-all; }
.json { margin: .4rem 0 .4rem 1.1rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .76rem; }
.json details { margin-left: .9rem; }
.json > details { margin-left: 0; }
.json summary { cursor: pointer; }
.json .k { color: #7a4fbf; }
.json .s { color: #14622f; }
.json .n { color: #1f4fd8; }
.json .b, .json .z { color: #8a1c1c; }
.json .c { color: #8b90a0; }
.json .leaf { margin-left: .9rem; }
nav ol { margin: .25rem 0 0; padding-left: 1.4rem; font-size: .85rem; }
nav a { color: #1f4fd8; }
footer { margin-top: 3rem; color: #5a5f70; font-size: .78rem; }
@media print {
  body { max-width: none; padding: 0; font-size: 11px; }
  section.run { page-break-inside: avoid; }
  pre { white-space: pre-wrap; word-break: break-word; }
  nav { display: none; }
}
`.trim();

/**
 * The JSON explorer (issue #25 criterion 6).
 *
 * Inline, and inline only: the engine team opens this file from a directory
 * with no network, so an external script or a CDN stylesheet would make the
 * evidence unreadable exactly where it is read. The self-containment test
 * forbids `script src=`, `link href=`, `@import` and off-file `url(`; an inline
 * `<script>` is the one mechanism left, and it is the right one here because a
 * nested-`<details>` tree for an 8,258-tool payload would be megabytes of HTML
 * on its own.
 *
 * Three rules it lives by:
 *
 * - **It reads the payload that is already on the page.** Each payload is
 *   embedded once, as the text of a `<pre>`; this script parses that text. It
 *   never carries a second copy, and a byte-identical repeat points at the same
 *   `<pre>` rather than embedding its own.
 * - **It is lazy twice over.** A payload is parsed the first time a row is
 *   opened, and each object or array builds its children the first time *it* is
 *   opened. Opening one row of a 26 MB report must not build a tree for the
 *   whole document.
 * - **It is an enhancement, never a dependency.** With scripting off, every
 *   payload is still there, whole, inside `<details><summary>raw JSON</summary>`
 *   — this script adds a tree beside it and removes nothing.
 */
const EXPLORER = `
(function () {
  var cache = {};
  function payloadOf(id) {
    if (!(id in cache)) {
      var host = document.getElementById(id);
      try {
        cache[id] = host === null ? undefined : JSON.parse(host.textContent);
      } catch (error) {
        cache[id] = undefined;
      }
    }
    return cache[id];
  }
  function span(className, text) {
    var element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    return element;
  }
  function count(n, noun) {
    return n + " " + noun + (n === 1 ? "" : "s");
  }
  function scalarText(value) {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    return String(value);
  }
  function scalarClass(value) {
    if (value === null) return "z";
    if (typeof value === "string") return "s";
    if (typeof value === "number") return "n";
    return "b";
  }
  function keyText(key) {
    return key === null ? "" : key + ": ";
  }
  function node(key, value) {
    var isArray = Array.isArray(value);
    if (value === null || typeof value !== "object") {
      var leaf = document.createElement("div");
      leaf.className = "leaf";
      if (key !== null) leaf.appendChild(span("k", keyText(key)));
      leaf.appendChild(span(scalarClass(value), scalarText(value)));
      return leaf;
    }
    var keys = isArray ? null : Object.keys(value);
    var size = isArray ? value.length : keys.length;
    var branch = document.createElement("details");
    var head = document.createElement("summary");
    if (key !== null) head.appendChild(span("k", keyText(key)));
    head.appendChild(
      span("c", isArray ? "[" + count(size, "item") + "]" : "{" + count(size, "key") + "}")
    );
    branch.appendChild(head);
    var built = false;
    branch.addEventListener("toggle", function () {
      if (built || branch.open !== true) return;
      built = true;
      for (var i = 0; i < size; i += 1) {
        var childKey = isArray ? String(i) : keys[i];
        branch.appendChild(node(childKey, isArray ? value[i] : value[childKey]));
      }
    });
    return branch;
  }
  function render(mount) {
    if (mount.getAttribute("data-rendered") === "yes") return;
    mount.setAttribute("data-rendered", "yes");
    var value = payloadOf(mount.getAttribute("data-payload"));
    if (value === undefined) {
      mount.appendChild(span("c", "payload could not be parsed - the raw JSON below is the evidence"));
      return;
    }
    // A payload whose large shared object is stored apart is put back together
    // here, so the tree is the whole payload the gateway sent. The copy is
    // shallow: the cached own-fields object is shared by every payload that has
    // the same ones, and must not be mutated.
    var sharedId = mount.getAttribute("data-shared");
    if (sharedId !== null && value !== null && typeof value === "object") {
      var sharedValue = payloadOf(sharedId);
      if (sharedValue !== undefined) {
        var merged = {};
        for (var key in value) merged[key] = value[key];
        merged[mount.getAttribute("data-shared-key")] = sharedValue;
        value = merged;
      }
    }
    var tree = node(null, value);
    if (tree.tagName === "DETAILS") tree.open = true;
    mount.appendChild(tree);
  }
  var rows = document.querySelectorAll("details.event");
  for (var i = 0; i < rows.length; i += 1) {
    (function (row) {
      row.addEventListener("toggle", function () {
        if (row.open !== true) return;
        var mounts = row.querySelectorAll(".json");
        for (var j = 0; j < mounts.length; j += 1) render(mounts[j]);
      });
    })(rows[i]);
  }
})();
`.trim();

function statusBadge(status: RunStatus): string {
  return `<span class="status status-${status}">${escapeHtml(status)}</span>`;
}

function num(value: number | string): string {
  return `<td class="num">${escapeHtml(String(value))}</td>`;
}

function empty(): string {
  return `<td class="num empty">—</td>`;
}

/**
 * The cell for a number nothing recorded.
 *
 * Deliberately not `0` and deliberately not the em dash the other empties use:
 * "not recorded" is the whole point of the distinction, and a reader who sees
 * `0` bytes or `0` ms will believe a measurement that never happened.
 */
function unmeasured(): string {
  return `<td class="num empty">not recorded</td>`;
}

/** ` (3 of 7 hits)` when only some of the records carried the field. */
function partial(recorded: number, total: number, noun: string): string {
  return recorded === total ? "" : ` (${recorded} of ${total} ${noun})`;
}

function rangeCell(range: Range, noun: string): string {
  if (range.recorded === 0) return unmeasured();
  const value = range.min === range.max ? String(range.min) : `${range.min}–${range.max}`;
  return num(`${value}${partial(range.recorded, range.total, noun)}`);
}

function totalCell(
  total: Total,
  noun: string,
  format: (value: number) => string = String,
): string {
  if (total.recorded === 0) return unmeasured();
  return num(`${format(total.sum)}${partial(total.recorded, total.total, noun)}`);
}

/**
 * `tools/list` requests for a revision: the total, the per-run spread, and the
 * word "paged" when any run issued more than one. The spread is not optional
 * decoration — 6 requests over 6 runs and 6 over 2 are different measurements.
 */
function toolsListCell(profile: ToolsListProfile): string {
  if (profile.recorded === 0) return unmeasured();
  const spread =
    profile.min === profile.max
      ? `${profile.min} per run`
      : `${profile.min}–${profile.max} per run`;
  const paged = profile.paged > 0 ? ` — paged in ${profile.paged}` : "";
  return num(
    `${profile.requests} (${spread})${paged}${partial(profile.recorded, profile.runs, "runs")}`,
  );
}

function summaryTable(summaries: RevisionSummary[]): string {
  const header = [
    ["text", "revision"],
    ["", "repetitions"],
    ["", "min hits<br>tools/list"],
    ["", "max hits<br>tools/list"],
    ["", "mean hits<br>tools/list"],
    ["", "hits on<br>initialize"],
    ["", "version-<br>mismatch"],
    ["", "error"],
    ["", "Gmail tools<br>listed"],
    ["", "toolkits<br>per hook hit"],
    ["", "tools<br>per hook hit"],
    ["text", "tool set<br>across hits"],
    ["", "bytes sent<br>to hook"],
    ["", "tools/list<br>requests issued"],
    ["", "hook server<br>handling (ms)"],
    ["", "client-observed<br>tools/list (ms)"],
  ]
    .map(([cls, label]) => `<th class="${cls}">${label}</th>`)
    .join("");

  const rows = summaries
    .map((s) => {
      const stats = s.toolsListHits;
      return [
        "<tr>",
        `<td class="text">${escapeHtml(s.revision)}</td>`,
        num(s.repetitions),
        stats === null ? empty() : num(stats.min),
        stats === null ? empty() : num(stats.max),
        stats === null ? empty() : num(formatMean(stats.mean)),
        s.initializeHits === null ? empty() : num(s.initializeHits),
        num(s.versionMismatches),
        num(s.errors),
        s.gmailToolsListed.length === 0 ? empty() : num(s.gmailToolsListed.join(", ")),
        rangeCell(s.hits.toolkits, "hits"),
        rangeCell(s.hits.tools, "hits"),
        `<td class="text">${escapeHtml(samenessText(s.hits.sameness, s.hits.hits))}</td>`,
        totalCell(s.hits.bytes, "hits"),
        toolsListCell(s.toolsList),
        totalCell(s.hits.handlingMs, "hits", formatMs),
        totalCell(s.clientToolsListMs, "runs", formatMs),
        "</tr>",
      ].join("");
    })
    .join("\n");

  return [
    `<table id="summary">`,
    `<thead><tr>${header}</tr></thead>`,
    `<tbody>\n${rows}\n</tbody>`,
    `</table>`,
  ].join("\n");
}

/**
 * The `tools/list`-request banner (issue #16 criterion 4).
 *
 * Top of the document, not a footnote, because it changes what every hit count
 * below it means: a run that issued three `tools/list` requests spread its hits
 * over three of them, and a count that is high for that reason is a different
 * result from one that is high per request. The reader must not have to derive
 * which they are looking at, so the banner states it either way — including the
 * case where no run records the number at all, which is a third answer and not
 * a quiet "1".
 */
export function toolsListBanner(loaded: LoadedRun[]): string {
  const paged = loaded.filter((entry) => (entry.run.toolsListRequests ?? 0) > 1);
  const unrecorded = loaded.filter((entry) => entry.run.toolsListRequests === undefined);
  const runs = loaded.length;

  const item = (entry: LoadedRun): string => {
    const count = entry.run.toolsListRequests ?? 0;
    const cursor =
      entry.run.cursorFollowed === true
        ? ", following a cursor"
        : entry.run.cursorFollowed === false
          ? ", no cursor"
          : "";
    return (
      `<li><a href="#${escapeHtml(entry.file)}">${escapeHtml(entry.file)}</a> — ` +
      `${count} <code>tools/list</code> requests${cursor}</li>`
    );
  };

  const missing =
    unrecorded.length === 0
      ? ""
      : ` ${unrecorded.length} of ${runs} ` +
        `${unrecorded.length === 1 ? "run does" : "runs do"} not record the number at all, ` +
        `so their hit counts cannot be read as per-request either.`;

  if (paged.length > 0) {
    return [
      `<div class="callout callout-warn" id="tools-list-requests">`,
      `<strong>${paged.length} of ${runs} runs issued more than one <code>tools/list</code> request.</strong>`,
      ` Their hook hits are spread across several requests, so the hit counts for those runs`,
      ` are per <em>run</em>, not per request.${missing}`,
      `<ul>`,
      paged.map(item).join("\n"),
      `</ul>`,
      `</div>`,
    ].join("");
  }

  if (unrecorded.length === runs) {
    return (
      `<div class="callout callout-unknown" id="tools-list-requests">` +
      `<strong>No run records how many <code>tools/list</code> requests the client issued.</strong>` +
      ` These run files predate that measurement, so a hit count here cannot be read as a` +
      ` per-request count — it is per run, and the client may have paged.` +
      `</div>`
    );
  }

  return (
    `<div class="callout callout-ok" id="tools-list-requests">` +
    `<strong>Every run that records it issued exactly one <code>tools/list</code> request.</strong>` +
    ` Hook hits per run are therefore hook hits per request.${missing}` +
    `</div>`
  );
}

/** The same fact, inside the run it belongs to. */
function runToolsListNotice(run: Run): string {
  const count = run.toolsListRequests;
  if (count === undefined || count <= 1) return "";
  const cursor = run.cursorFollowed === true ? " following a cursor" : "";
  return (
    `<div class="callout callout-warn">` +
    `<strong>This run issued ${count} <code>tools/list</code> requests${cursor}.</strong>` +
    ` Its hook hits are spread across them: the counts below are per run, not per request.` +
    `</div>`
  );
}

/**
 * Captured request headers for one hit, verbatim.
 *
 * Credential values arrive already replaced by the counter's descriptor
 * (`Bearer <redacted len=43 sha256=1f3a9c2b>`). The renderer adds nothing on
 * top: the secret never reached disk, and a second pass of eliding would
 * destroy the descriptor's one diagnostic — the same digest on every hit means
 * the same value arrived every time. Repeated descriptors are printed in full,
 * hit after hit, for exactly that reason — including when this hit's payload
 * collapsed into an earlier one. Deduplication is a statement about payload
 * bodies and about nothing else.
 */
function headersList(headers: Record<string, string> | undefined): string {
  if (headers === undefined) return `<p class="empty">Headers not recorded for this hit.</p>`;
  const names = Object.keys(headers);
  if (names.length === 0) return `<p class="empty">This hit arrived with no headers.</p>`;
  return (
    `<div class="headers">` +
    names
      .map(
        (name) =>
          `<div class="hdr"><code>${escapeHtml(name)}</code>: ` +
          `<code>${escapeHtml(headers[name]!)}</code></div>`,
      )
      .join("") +
    `</div>`
  );
}

/**
 * What this hook answered the hit with (#31 criterion 1, DESIGN.md decision 19).
 *
 * The direction the report could not show at all. A hook that records what it
 * was asked and not what it answered cannot demonstrate that the deny it
 * believes it issued was issued — #21's fail-open was provable only by a
 * `curl` run by hand — so the status and the body sit here beside the payload
 * they answer.
 *
 * `{}` is rendered as a body, loudly, and never as an absence. It is a real
 * `AccessHookResult`: neither `only` nor `deny`, which the engine reads as *no
 * change*. That value is correct when the request carried no Gmail and is the
 * exact shape of the bug when it did, and a reader has to be able to tell the
 * two apart by looking at the payload above it.
 */
function hookResponseDetail(hit: HookHit, placement: PayloadPlacement | null): string {
  if (placement === null) {
    return (
      `<p class="empty">not recorded — this run file predates the hook recording its own ` +
      `answer.</p>`
    );
  }
  const status =
    hit.responseStatus === undefined
      ? `<p class="empty">HTTP status not recorded for this hit.</p>`
      : `<p class="repeat-note">HTTP ${escapeHtml(String(hit.responseStatus))}</p>`;
  const noOpinion = isRecord(hit.responseBody) && Object.keys(hit.responseBody).length === 0
    ? `<p class="sub">This answer carries neither <code>only</code> nor <code>deny</code>, ` +
      `which the engine reads as <strong>no change</strong> — every tool stays allowed. That ` +
      `is the right answer to a request this policy has no opinion about, and it is also the ` +
      `shape of the fail-open #21 fixed. The payload above says which of the two this was.</p>`
    : "";
  return [status, bodyBlock(hit.responseBody, placement, "response body"), noOpinion]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * The method that caused this hit (issue #25 criterion 4).
 *
 * `not attributed` is styled as an absence, not printed as a method, because it
 * is the one answer the reader must not read as "some request did this".
 */
function causedByCell(method: string | null): string {
  return method === null
    ? `<td class="text empty">${NOT_ATTRIBUTED}</td>`
    : `<td class="text">${escapeHtml(method)}</td>`;
}

/** `initialize 1 · tools/list 3`, for one run. */
export function formatMethodSplit(run: Run): string {
  const entries = methodSplit(run);
  if (entries.length === 0) return "no requests and no hook hits";
  return entries.map((entry) => `${entry.method} ${entry.hits}`).join(" · ");
}

/**
 * The line a reader decides on before expanding a hook hit's payload: how big
 * it was, how much it carried, and its digest.
 *
 * Counts the run file does not carry read `not recorded` here for the same
 * reason they do in every other cell: `0 tools` would be a measurement.
 */
function payloadSummaryLine(hit: HookHit, placement: PayloadPlacement): string {
  const plural = (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;
  const parts = [
    "payload",
    hit.bodyBytes === undefined ? "size not recorded" : `${hit.bodyBytes} B`,
    hit.toolkitCount === undefined
      ? "toolkits not recorded"
      : plural(hit.toolkitCount, "toolkit"),
    hit.toolCount === undefined ? "tools not recorded" : plural(hit.toolCount, "tool"),
    `sha256 ${placement.digest}`,
  ];
  if (placement.sameAs !== undefined) parts.push(`identical to ${placement.sameAs.label}`);
  return parts.map(escapeHtml).join(" · ");
}

/**
 * One hook hit's payload: the explorer's mount point, and the one embedded copy
 * of the payload that both the explorer and a scriptless reader use.
 *
 * The `<pre>` is not a second copy of the data — it *is* the data. The script
 * reads its `textContent`, parses it, renders the tree next to it and hides it;
 * with no script it stays exactly where it is, complete, which is what keeps
 * the evidence from depending on scripting.
 *
 * A byte-identical repeat embeds nothing and points its explorer at the copy
 * the first occurrence embedded, so the reader still expands a full tree
 * without the document carrying the payload twice.
 */
function payloadDetail(hit: HookHit, placement: PayloadPlacement): string {
  const shared = placement.sharedToolkits;
  const mount =
    `<div class="json" data-payload="${escapeHtml(placement.storedAt)}"` +
    (shared === undefined
      ? ""
      : ` data-shared-key="${escapeHtml(shared.key)}" data-shared="${escapeHtml(shared.storeId)}"`) +
    `></div>`;

  if (placement.sameAs !== undefined && shared === undefined) {
    return [
      mount,
      `<p class="repeat-note">Byte-identical to ` +
        `<a href="#${escapeHtml(placement.sameAs.anchor)}">` +
        `${escapeHtml(placement.sameAs.label)}</a>, which carries the one embedded copy. ` +
        `Compared byte for byte, not by size or by tool count; sha-256 of the payload is ` +
        `<code>${escapeHtml(placement.digest)}</code>.</p>`,
    ].join("\n");
  }

  if (shared === undefined) {
    return [
      mount,
      `<details class="raw"><summary>raw JSON</summary>`,
      `<pre id="${escapeHtml(placement.anchor)}">${escapeHtml(storedPayload(hit.payload))}</pre>`,
      `</details>`,
    ].join("\n");
  }

  // Stored in two parts, shown as one. Neither part is rewritten: the own
  // fields are this payload's bytes with the shared key left out, and the
  // shared object is the gateway's bytes in the store. The explorer above puts
  // them back together; a reader with no scripting reads them in sequence.
  const own = payloadText(hit.payload);
  const ownPart =
    placement.storedAt === placement.anchor
      ? `<pre id="${escapeHtml(placement.anchor)}">` +
        `${escapeHtml(storedText(withoutShared(hit.payload)))}</pre>`
      : `<p class="repeat-note">This hit’s own fields are byte-identical to those of ` +
        `<a href="#${escapeHtml(placement.sameAs!.anchor)}">` +
        `${escapeHtml(placement.sameAs!.label)}</a>.</p>`;

  const sharedPart = shared.emitsStore
    ? `<pre id="${escapeHtml(shared.storeId)}">${escapeHtml(storedText(sharedToolkitsTextOf(hit.payload)))}</pre>`
    : `<p class="repeat-note">Byte-identical to ` +
      `<a href="#${escapeHtml(shared.sameAs!.anchor)}">${escapeHtml(shared.sameAs!.label)}</a>, ` +
      `which carries the one embedded copy. Compared byte for byte; sha-256 of the ` +
      `<code>${escapeHtml(shared.key)}</code> object is <code>${escapeHtml(shared.digest)}</code>.</p>`;

  return [
    mount,
    `<p class="sub">Stored in two parts because this payload’s ` +
      `<code>${escapeHtml(shared.key)}</code> object is shared with other hits: its own fields ` +
      `below, and that object once. Nothing is rewritten and nothing is dropped — the whole ` +
      `payload is sha-256 <code>${escapeHtml(placement.digest)}</code>, ` +
      `${Buffer.byteLength(own, "utf8")} B.</p>`,
    `<details class="raw"><summary>raw JSON — this hit’s own fields</summary>`,
    ownPart,
    `</details>`,
    `<details class="raw"><summary>raw JSON — the shared <code>${escapeHtml(shared.key)}</code> object</summary>`,
    sharedPart,
    `</details>`,
  ].join("\n");
}

/** The shared object's JSON, for the block that emits the store. */
function sharedToolkitsTextOf(payload: unknown): string {
  return payloadText((payload as Record<string, unknown>)[SHARED_KEY]);
}

/**
 * One recorded body, rendered the way every body in this report is: an explorer
 * mount, the one embedded `<pre>` that holds its bytes, and — when an earlier
 * body was byte for byte the same — a note pointing at the copy instead of a
 * second one.
 *
 * The same three pieces {@link payloadDetail} uses for a hook payload, in one
 * function because #31 added three more kinds of body and a fourth hand-rolled
 * copy of this shape is how the dedupe sentence went wrong twice before.
 */
function bodyBlock(body: unknown, placement: PayloadPlacement, heading: string): string {
  const mount = `<div class="json" data-payload="${escapeHtml(placement.storedAt)}"></div>`;
  const size = Buffer.byteLength(payloadTextOf(body), "utf8");
  const summary = [heading, `${size} B`, `sha256 ${placement.digest}`]
    .concat(placement.sameAs === undefined ? [] : [`identical to ${placement.sameAs.label}`])
    .map(escapeHtml)
    .join(" \u00b7 ");

  const embedded =
    placement.sameAs === undefined
      ? [
          `<details class="raw"><summary>raw JSON</summary>`,
          `<pre id="${escapeHtml(placement.anchor)}">${escapeHtml(storedPayload(body))}</pre>`,
          `</details>`,
        ].join("\n")
      : `<p class="repeat-note">Byte-identical to ` +
        `<a href="#${escapeHtml(placement.sameAs.anchor)}">` +
        `${escapeHtml(placement.sameAs.label)}</a>, which carries the one embedded copy. ` +
        `Compared byte for byte; sha-256 is <code>${escapeHtml(placement.digest)}</code>.</p>`;

  return [
    `<p class="repeat-note">${summary}</p>`,
    mount,
    embedded,
  ].join("\n");
}

/** One `<dt>`/`<dd>` pair, with `not recorded` for anything the run file lacks. */
function detailRow(term: string, value: string | undefined): string {
  return `<dt>${escapeHtml(term)}</dt><dd>${
    value === undefined ? metaUnmeasured() : escapeHtml(value)
  }</dd>`;
}

/**
 * What the run JSON holds about one MCP request (issue #25 criterion 5, then
 * #31).
 *
 * #25 shaped this row so a body could slot in beside the metadata list when a
 * slice captured one, and said `body not recorded` in those words until then —
 * rendering `{}` would have put an empty object where a reader expects the
 * payload. #31 filled that seam: the two MCP frames follow the list, from the
 * same store every other body in this report uses. A run file that carries
 * neither still reads exactly as it did.
 */
function requestDetail(
  request: RunRequest,
  run: Run,
  file: string,
  frames: McpFramePlacement,
): string {
  return [
    `<dl class="meta">`,
    detailRow("method", request.method),
    detailRow("JSON-RPC id", request.jsonRpcId === undefined ? undefined : String(request.jsonRpcId)),
    detailRow("sent at", request.sentAt),
    detailRow("finished at", request.finishedAt),
    detailRow("HTTP status", request.status === undefined ? undefined : String(request.status)),
    detailRow(
      "client-observed round trip",
      request.durationMs === undefined ? undefined : `${formatMs(request.durationMs)} ms`,
    ),
    detailRow("user-id header observed", request.userIdHeader),
    detailRow("authorization scheme", request.authorizationScheme),
    detailRow(
      "response observed",
      request.responseObserved === undefined ? undefined : request.responseObserved ? "yes" : "no",
    ),
    detailRow("cursor followed", request.cursor),
    detailRow("hookHitsAfter (cumulative)", String(request.hookHitsAfter)),
    `</dl>`,
    requestBodyNote(request, run, file),
    mcpFrameBlocks(request, frames),
  ].join("\n");
}

/**
 * The two MCP directions for one request: what the probe sent, and what came
 * back (#31, DESIGN.md decision 19).
 *
 * Each of the three states reads as itself. A frame the run file does not
 * carry says the run predates the capture; a `responseFrame` of `null` says no
 * reply was observed, which is the same condition `responseObserved: false`
 * reports and is deliberately not an empty object; anything else is the frame,
 * whole, through the same store every other body goes through.
 */
function mcpFrameBlocks(request: RunRequest, frames: McpFramePlacement): string {
  const parts: string[] = [];

  parts.push(`<h5>probe \u2192 gateway (MCP request frame)</h5>`);
  if (frames.request === null) {
    parts.push(
      `<p class="empty">not recorded \u2014 this run file predates the MCP frame capture.</p>`,
    );
  } else {
    parts.push(bodyBlock(request.requestFrame, frames.request, "request frame"));
  }

  parts.push(`<h5>gateway \u2192 probe (MCP response frame)</h5>`);
  if (frames.response !== null) {
    parts.push(bodyBlock(request.responseFrame, frames.response, "response frame"));
  } else if (request.responseFrame === null) {
    parts.push(
      `<p class="empty">No reply carrying this request\u2019s JSON-RPC id was seen on the ` +
        `wire. That is a measurement, not a missing one \u2014 the stream ended first, which ` +
        `is what <code>response observed: no</code> above reports.</p>`,
    );
  } else {
    parts.push(
      `<p class="empty">not recorded \u2014 this run file predates the MCP frame capture.</p>`,
    );
  }

  return parts.join("\n");
}

/**
 * How the two MCP frames read in one phrase, or `null` when the run file
 * carries neither and the row's older wording still applies.
 *
 * `responseFrame: null` is a state of its own and gets its own words: no reply
 * carrying this request's id was seen. It is a measurement, and the one thing
 * it must never be confused with is a frame that was recorded and happened to
 * be empty.
 */
function frameState(request: RunRequest): string | null {
  const hasRequest = request.requestFrame !== undefined;
  const hasResponse = request.responseFrame !== undefined;
  if (!hasRequest && !hasResponse) return null;
  if (hasRequest && hasResponse && request.responseFrame !== null) {
    return "request and response frames recorded";
  }
  const parts: string[] = [];
  if (hasRequest) parts.push("request frame recorded");
  if (request.responseFrame === null) parts.push("no response frame observed");
  else if (hasResponse) parts.push("response frame recorded");
  return parts.join(" \u00b7 ");
}

/**
 * The same fact as {@link requestBodyNote}, short enough for the collapsed row.
 *
 * A reader scanning summary lines must not be told `body not recorded` about a
 * request whose frames — or whose result — the run file carries.
 */
function requestBodyState(request: RunRequest, run: Run): string {
  const frames = frameState(request);
  if (frames !== null) return frames;
  return request.method === "tools/list" && Array.isArray(run.toolsListResult)
    ? "response body recorded for the run"
    : "body not recorded";
}

/**
 * What this request's response body is, in one sentence that has to stay true.
 *
 * It was `body not recorded` for every request until #27, and for `initialize`
 * it still is: `src/client/request-log.ts` pipes the response through instead
 * of cloning it and keeps no body per request. But #27 made the observer read
 * `result.tools` off the same frames, so a run file now carries the
 * `tools/list` result the gateway returned. Saying `body not recorded` on a
 * `tools/list` row of such a run would be a false claim in an evidence
 * document, which is worse than an incomplete one.
 *
 * The result is assembled **per run**, not per request: a paged `tools/list`
 * concatenates its pages into one list. A row therefore points at the run's
 * result and says so, rather than implying it is that row's own page.
 */
function requestBodyNote(request: RunRequest, run: Run, file: string): string {
  // A run that carries frames says everything about them in the blocks below,
  // which state each direction's own state. All this row owes such a reader is
  // the pointer to the run's assembled `tools/list` result, which is a
  // per-*run* body and not this row's frame.
  if (frameState(request) !== null) return toolsListResultLink(request, run, file);

  const piped =
    `<code>src/client/request-log.ts</code> pipes the response through rather than cloning it`;

  if (request.method !== "tools/list") {
    return `<p class="empty">body not recorded — ${piped}, so no MCP body is kept per request.</p>`;
  }
  if (run.toolsListResult === undefined) {
    return (
      `<p class="empty">body not recorded — ${piped}, and this run file predates ` +
      `the <code>toolsListResult</code> capture.</p>`
    );
  }
  if (run.toolsListResult === null) {
    return (
      `<p class="empty">body not recorded — ${piped}, and this run assembled no ` +
      `<code>tools/list</code> result at all.</p>`
    );
  }

  const tools = run.toolsListResult.length;
  return (
    `<p>The response body is not kept per request — ${piped} — but the result the gateway ` +
    `returned <strong>is</strong> recorded for this run: ` +
    `<a href="#${escapeHtml(toolsListAnchor(file))}">${tools} tool${tools === 1 ? "" : "s"}, ` +
    `as it came off the wire</a>.${pagedNote(run)}</p>`
  );
}

/** ` It is the run’s assembled list…` — said wherever the result is pointed at. */
function pagedNote(run: Run): string {
  const requests = run.toolsListRequests;
  return requests !== undefined && requests > 1
    ? ` It is the run’s assembled list, concatenated across ${requests} ` +
      `<code>tools/list</code> requests in page order — not this row’s page alone.`
    : "";
}

/**
 * The pointer from a `tools/list` row to the run's assembled result.
 *
 * Still worth saying next to a recorded response frame, and not a duplicate of
 * it: the frame below is **this request's page**, and the result the section
 * embeds is the whole list the client assembled across every page. On a
 * single-page run the two agree; on a paged one they do not, and a reader who
 * mistook one for the other would misread the evidence.
 */
function toolsListResultLink(request: RunRequest, run: Run, file: string): string {
  if (request.method !== "tools/list" || !Array.isArray(run.toolsListResult)) return "";
  const tools = run.toolsListResult.length;
  return (
    `<p>The run also records the <code>tools/list</code> result the gateway returned, ` +
    `assembled: <a href="#${escapeHtml(toolsListAnchor(file))}">${tools} ` +
    `tool${tools === 1 ? "" : "s"}, as it came off the wire</a>.${pagedNote(run)}</p>`
  );
}

/** A running total over values some records may not carry. */
interface RunningTotal {
  sum: number;
  recorded: number;
  total: number;
}

function runningCell(running: RunningTotal): string {
  // No hits yet is a genuine zero — nothing has been sent — so it is printed as
  // a number. `not recorded` is reserved for hits that happened and whose size
  // the run file never measured.
  if (running.total === 0) return num(0);
  if (running.recorded === 0) return unmeasured();
  return num(`${running.sum}${partial(running.recorded, running.total, "hits")}`);
}

/**
 * One ordered table per run of everything that crossed a wire, both sides
 * interleaved (issue #25 criteria 1–5).
 *
 * Replaces the request timeline and the hook-hit table this report used to
 * render side by side. Every number those two carried is still here — the
 * client-observed round trip, the hook server's handling time, the cumulative
 * snapshot, the payload shape — but a reader no longer has to correlate two
 * lists by timestamp to answer the question the whole report is about.
 *
 * The two latency numbers keep their own columns and can never land on the same
 * row: a request row has no hook handling time and a hit row has no client
 * round trip, so there is nothing for a reader to add together.
 */
function wireTable(entry: LoadedRun, placements: RunPlacements): string {
  const { file, run } = entry;
  const events = wireEvents(run);
  const origin = events[0]?.at;

  let hits = 0;
  const bytes: RunningTotal = { sum: 0, recorded: 0, total: 0 };

  const rows = events.map((event, order) => {
    const offset = offsetMs(origin, event.at);
    const common = [
      num(order + 1),
      `<td class="text">${event.side === "client" ? "client → gateway" : "gateway → hook"}</td>`,
    ];
    const when = [
      `<td class="text">${escapeHtml(event.at)}</td>`,
      offset === null ? unmeasured() : num(`+${formatMs(offset)}`),
    ];

    if (event.side === "client") {
      const detail = [
        `<tr class="detail">`,
        `<td colspan="10">`,
        `<details class="event"><summary>${requestBodyState(event.request, run)} · ` +
          `${escapeHtml(event.request.method)} request · what the run JSON holds</summary>`,
        requestDetail(event.request, run, file, placements.mcpFrames[event.index]!),
        `</details>`,
        `</td>`,
        `</tr>`,
      ].join("\n");
      return [
        `<tr class="event client">`,
        ...common,
        `<td class="text">${escapeHtml(event.request.method)}</td>`,
        `<td class="text empty">—</td>`,
        ...when,
        num(hits),
        runningCell(bytes),
        event.request.durationMs === undefined
          ? unmeasured()
          : num(formatMs(event.request.durationMs)),
        `<td class="num empty">—</td>`,
        `</tr>`,
        detail,
      ].join("\n");
    }

    hits += 1;
    bytes.total += 1;
    if (event.hit.bodyBytes !== undefined) {
      bytes.sum += event.hit.bodyBytes;
      bytes.recorded += 1;
    }
    const placement = placements.hookPayloads[event.index]!;
    const detail = [
      `<tr class="detail">`,
      `<td colspan="10">`,
      `<details class="event" id="${escapeHtml(placement.anchor)}--row">` +
        `<summary>${payloadSummaryLine(event.hit, placement)}</summary>`,
      payloadDetail(event.hit, placement),
      `<h5>captured request headers</h5>`,
      headersList(event.hit.headers),
      `<h5>hook \u2192 gateway (the answer this hook sent)</h5>`,
      hookResponseDetail(event.hit, placements.hookResponses[event.index] ?? null),
      `</details>`,
      `</td>`,
      `</tr>`,
    ].join("\n");

    return [
      `<tr class="event hook">`,
      ...common,
      `<td class="text">POST /access</td>`,
      causedByCell(event.causedBy),
      ...when,
      num(hits),
      runningCell(bytes),
      `<td class="num empty">—</td>`,
      event.hit.handlingMs === undefined ? unmeasured() : num(formatMs(event.hit.handlingMs)),
      `</tr>`,
      detail,
    ].join("\n");
  });

  const header =
    `<thead><tr><th>#</th><th class="text">side</th><th class="text">what</th>` +
    `<th class="text">caused by</th><th class="text">at</th><th>+ms from<br>first event</th>` +
    `<th>hook hits<br>(cumulative)</th><th>bytes to hook<br>(cumulative)</th>` +
    `<th>client-observed<br>round trip (ms)</th><th>hook server<br>handling (ms)</th>` +
    `</tr></thead>`;

  return [
    `<table class="wire" id="${escapeHtml(file)}--wire">`,
    header,
    `<tbody>\n${rows.join("\n")}\n</tbody>`,
    `</table>`,
  ].join("\n");
}

/**
 * What the gateway returned for `tools/list`, embedded once (#27, decision 18).
 *
 * The other half of the comparison this report exists to make: `hookHits` is
 * what the gateway told the hook, this is what the same gateway told the
 * client. It goes through the same store as the hook payloads, so a result
 * repeated across repetitions of one gateway is embedded once, and through the
 * same compact-above-the-threshold path, because it is not guaranteed small.
 *
 * Three states, three different sentences. Absent is a pre-#27 run file and
 * says nothing; `null` is "no result was ever assembled"; `[]` is the real
 * measurement "the gateway returned an empty list", which is what a hook that
 * denied everything produces and must never read as "not recorded".
 */
function toolsListResultBlock(entry: LoadedRun, placement: PayloadPlacement | null): string {
  const { file, run } = entry;
  const heading = `<h4>tools/list result</h4>`;

  if (run.toolsListResult === undefined) {
    return [
      heading,
      `<p class="empty">not recorded — this run file predates the ` +
        `<code>toolsListResult</code> capture.</p>`,
    ].join("\n");
  }
  if (run.toolsListResult === null) {
    return [
      heading,
      `<p class="empty">No <code>tools/list</code> result was assembled in this run.</p>`,
    ].join("\n");
  }

  const tools = run.toolsListResult.length;
  const requests = run.toolsListRequests;
  const paged =
    requests !== undefined && requests > 1
      ? `<p class="sub">Assembled across ${requests} <code>tools/list</code> requests, in page ` +
        `order: one list, not one page.</p>`
      : "";
  const empty =
    tools === 0
      ? `<p class="sub">The gateway returned an <strong>empty list</strong>. That is a ` +
        `measurement, not a missing one — it is what a hook denying everything produces.</p>`
      : "";

  const summary = [
    "tools/list result",
    `${tools} tool${tools === 1 ? "" : "s"}`,
    `${Buffer.byteLength(payloadTextOf(run.toolsListResult), "utf8")} B`,
    `sha256 ${placement!.digest}`,
    ...(placement!.sameAs === undefined ? [] : [`identical to ${placement!.sameAs.label}`]),
  ]
    .map(escapeHtml)
    .join(" \u00b7 ");

  const body =
    placement!.sameAs === undefined
      ? [
          `<details class="raw"><summary>raw JSON</summary>`,
          `<pre id="${escapeHtml(placement!.anchor)}">` +
            `${escapeHtml(storedPayload(run.toolsListResult))}</pre>`,
          `</details>`,
        ].join("\n")
      : `<p class="repeat-note">Byte-identical to ` +
        `<a href="#${escapeHtml(placement!.sameAs.anchor)}">` +
        `${escapeHtml(placement!.sameAs.label)}</a>, which carries the one embedded copy. ` +
        `Compared byte for byte; sha-256 of the result is ` +
        `<code>${escapeHtml(placement!.digest)}</code>.</p>`;

  return [
    heading,
    paged,
    empty,
    `<details class="event" id="${escapeHtml(toolsListAnchor(file))}">`,
    `<summary>${summary}</summary>`,
    `<div class="json" data-payload="${escapeHtml(placement!.storedAt)}"></div>`,
    body,
    `</details>`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * How the tools the gateway listed but never showed the hook are stated.
 *
 * Four states, and collapsing any pair of them is the bug this whole project is
 * an instrument for. `null` is the dangerous one: it means *we cannot say*,
 * because the run observed no hook hits or assembled no result, and printing it
 * as "none" would turn an absence into the finding "nothing bypassed the hook".
 *
 * A non-empty list is printed as **names**, not a count: an absence is not
 * evidence, and the engine team opens this file to learn *which* tools were
 * never submitted to access control.
 */
export function toolsNotOfferedText(run: Run): string {
  const names = run.toolsNotOfferedToHook;
  if (names === undefined) {
    return '<span class="empty">not recorded</span>';
  }
  if (names === null) {
    const because =
      run.hookHits.length === 0
        ? "this run observed no hook hits"
        : "this run assembled no tools/list result";
    return `<span class="empty">cannot say — ${escapeHtml(because)}</span>`;
  }
  if (names.length === 0) {
    return "none " + "—" + " every listed tool appeared in a hook payload";
  }
  return (
    `<strong>${names.length}</strong>: ` +
    names.map((name) => `<code>${escapeHtml(name)}</code>`).join(", ")
  );
}

/**
 * What the reader is told about the bodies this report holds.
 *
 * **The total and the named parts are the same data.** Both come from
 * {@link BODY_KINDS} by way of `plan.bodies`, so "N bodies — a of these and b of
 * those" reconciles for every shape, including shapes nobody has built a
 * fixture for. Two rounds of review found this sentence wrong in two different
 * ways — `tools/list` results counted as hook payloads, then shared `toolkits`
 * objects counted as nothing — and both times the cause was a sentence written
 * by hand next to a total accumulated separately. A kind that is counted is
 * named because the same table supplies both, and a kind that cannot be named
 * cannot exist: {@link BodyKind} is that table's key set.
 */
export function payloadDedupeNote(plan: PayloadPlan): string {
  if (plan.occurrences === 0) return `<p class="sub">No payloads in this report.</p>`;

  const plural = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`;

  // Every kind present, in the table's own order. Nothing is enumerated here
  // by hand, so a kind added to the table joins the sentence with it.
  const named = BODY_KIND_ORDER.filter((kind) => plan.bodies[kind].occurrences > 0).map((kind) =>
    plural(plan.bodies[kind].occurrences, BODY_KINDS[kind].one, BODY_KINDS[kind].many),
  );
  const parts =
    named.length === 1
      ? named[0]!
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]!}`;

  const head =
    `This report embeds ${plural(plan.occurrences, "body", "bodies")} — ${parts}.`;

  const body =
    plan.repeats === 0
      ? `<p class="sub">${head} No two of them are byte-identical, so every one is embedded ` +
        `in full.</p>`
      : `<p class="sub">${head} <strong>${plan.repeats}</strong> of them are byte-identical ` +
        `repeats of an earlier body; ` +
        `${plural(plan.distinct, "distinct body is", "distinct bodies are")} embedded once ` +
        `each, and every repeat shows its digest and links the one that carries the copy. The ` +
        `comparison is over the bytes, not over <code>bodyBytes</code> or the toolkit and tool ` +
        `counts: a body that differs anywhere is embedded in full, so nothing a hit carried can ` +
        `be hidden by this.</p>`;

  const toolkits = plan.bodies["shared-toolkits"];
  if (toolkits.occurrences === 0) return body;

  // Derived from the same tally rather than tracked beside it: a reference that
  // found an earlier copy is a repeat, so the rest are the stores.
  const stores = toolkits.occurrences - toolkits.repeats;
  return (
    body +
    `\n<p class="sub">${plural(toolkits.occurrences, "hook payload", "hook payloads")} ` +
    `${toolkits.occurrences === 1 ? "carries" : "carry"} a large <code>toolkits</code> object ` +
    `that another payload carries too. Those payloads are <strong>not</strong> identical — ` +
    `they differ elsewhere, in the live evidence only in <code>user_id</code> — so nothing ` +
    `is collapsed: ${plural(stores, "object is", "objects are")} stored once and referenced, ` +
    `and each payload still shows its own fields. Equality is computed over the object’s ` +
    `bytes, the same as for a whole body.</p>`
  );
}

/** `not recorded` as a `<dd>` value, kept distinct from a measured value of 0. */
function metaUnmeasured(): string {
  return '<span class="empty">not recorded</span>';
}

function runSection(entry: LoadedRun, placements: RunPlacements): string {
  const { file, run } = entry;
  const profile = profileHits(run.hookHits);
  const meta: [string, string][] = [
    ["revision requested", escapeHtml(run.revisionRequested)],
    ["revision negotiated", escapeHtml(formatRevisionNegotiated(run.revisionNegotiated))],
    ["status", statusBadge(run.status)],
    ["user id", escapeHtml(run.userId)],
    ["hook public url", escapeHtml(run.hookPublicUrl)],
    ["tools listed", escapeHtml(String(run.toolsListed))],
    ["Gmail tools listed", escapeHtml(String(run.gmailToolsListed))],
    [
      "tools/list requests issued",
      run.toolsListRequests === undefined
        ? metaUnmeasured()
        : escapeHtml(String(run.toolsListRequests)),
    ],
    [
      "cursor followed",
      run.cursorFollowed === undefined ? metaUnmeasured() : run.cursorFollowed ? "yes" : "no",
    ],
    [
      "client-observed tools/list",
      run.toolsListDurationMs === undefined
        ? metaUnmeasured()
        : run.toolsListDurationMs === null
          ? '<span class="empty">no tools/list request went out</span>'
          : `${escapeHtml(formatMs(run.toolsListDurationMs))} ms`,
    ],
    [
      "hook server handling (sum)",
      profile.handlingMs.recorded === 0
        ? metaUnmeasured()
        : `${escapeHtml(formatMs(profile.handlingMs.sum))} ms` +
          escapeHtml(partial(profile.handlingMs.recorded, profile.handlingMs.total, "hits")),
    ],
    [
      "bytes sent to hook",
      profile.bytes.recorded === 0
        ? metaUnmeasured()
        : escapeHtml(
            String(profile.bytes.sum) +
              partial(profile.bytes.recorded, profile.bytes.total, "hits"),
          ),
    ],
    ["tool set across hits", escapeHtml(samenessText(profile.sameness, profile.hits))],
    // Issue #25 criterion 3: the split is here, in the run, so a reader sees
    // "initialize 1 · tools/list 3" without counting rows or going back to the
    // summary table — which aggregates across the whole revision anyway.
    ["hook hits by method", escapeHtml(formatMethodSplit(run))],
    // #27's derived finding: tools the gateway listed without ever submitting
    // them to access control. Four states, never collapsed — see
    // `toolsNotOfferedText`.
    ["tools not offered to hook", toolsNotOfferedText(run)],
    ["error", run.error === null ? '<span class="empty">none</span>' : escapeHtml(run.error)],
  ];

  const timeline =
    run.requests.length === 0 && run.hookHits.length === 0
      ? `<p class="empty">Nothing crossed a wire in this run.</p>`
      : wireTable(entry, placements);

  return [
    `<section class="run" id="${escapeHtml(file)}">`,
    `<h3>${escapeHtml(file)}</h3>`,
    runToolsListNotice(run),
    `<dl class="meta">`,
    ...meta.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`),
    `</dl>`,
    `<h4>wire timeline (${run.requests.length} requests, ${run.hookHits.length} hook hits)</h4>`,
    `<p class="sub">Every request the client sent and every hit the counter received, in one` +
      ` sequence, oldest first. Each row expands: a hook hit shows its payload and its headers,` +
      ` an MCP request shows what the run JSON holds for it. Expanding needs no network, and no` +
      ` scripting — the explorer is an enhancement over a plain <code>&lt;pre&gt;</code> that is` +
      ` already there.</p>`,
    timeline,
    toolsListResultBlock(entry, placements.toolsListResult),
    `</section>`,
  ].join("\n");
}

export interface RenderOptions {
  /** The `--in` directory as the caller spelled it; shown for provenance. */
  inputDir: string;
  /** Injectable so tests and reruns are byte-stable. */
  generatedAt?: string;
}

/** Renders the whole document. No external assets — see the file header. */
export function renderHtml(loaded: LoadedRun[], options: RenderOptions): string {
  const summaries = summarize(loaded);
  const plan = planPayloads(loaded);
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const toc = loaded
    .map((entry) => {
      const label = `${escapeHtml(entry.file)} — ${escapeHtml(entry.run.revisionRequested)}`;
      return `<li><a href="#${escapeHtml(entry.file)}">${label}</a> ${statusBadge(entry.run.status)}</li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP tools/list hook-hit report</title>
<style>
${STYLE}
</style>
</head>
<body>
<h1>MCP <code>tools/list</code> hook-hit report</h1>
<p class="sub">
${loaded.length} run${loaded.length === 1 ? "" : "s"} from <code>${escapeHtml(options.inputDir)}</code>
· generated ${escapeHtml(generatedAt)}
</p>

${toolsListBanner(loaded)}

<h2>Summary by protocol revision</h2>
${summaryTable(summaries)}
<p class="sub">
Hook hits per method are the difference between consecutive <code>hookHitsAfter</code>
snapshots, not the raw cumulative value. Runs whose status is not <code>ok</code> are
counted in the version-mismatch and error columns and excluded from min/max/mean,
from the initialize total, and from the Gmail column. The initialize column is the
total across this revision&#39;s <code>ok</code> runs; the Gmail column lists the distinct
values those runs reported.
</p>
<p class="sub">
The profile columns cover every hook hit recorded by this revision&#39;s <code>ok</code>
runs. <em>tool set across hits</em> compares the toolkit and tool <em>names</em> each hit
carried, not their counts: two hits can carry the same number of tools and not the same
tools, so equal min and max is not the same statement as an identical set.
A field no run file carries reads <em>not recorded</em> — never <code>0</code>, which
would be a measurement.
</p>
<p class="sub">
<strong>The two latency columns are separate numbers and are never summed.</strong>
<em>hook server handling</em> is the hook counter&#39;s own received-to-answered time, and
it excludes the counter&#39;s JSONL append — the number has to be inside the line it
writes — so it is not what the hook cost the gateway.
<em>client-observed tools/list</em> is the wall clock the client waited on its
<code>tools/list</code> requests, hook round trips included because they are on the
request path. The gap between the two is the tunnel, the gateway, and the hook work
that falls outside the hook&#39;s own measurement; that gap is what a reader chasing
latency is after, and one blended figure would hide it.
</p>

<h2>Runs</h2>
${payloadDedupeNote(plan)}
<nav><ol>
${toc}
</ol></nav>

${loaded.map((entry, index) => runSection(entry, plan.perRun[index]!)).join("\n\n")}

<footer>Generated by <code>bun run report</code>. Print to PDF from the browser.</footer>
<script>
${EXPLORER}
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ReportArgs {
  inputDir: string;
  outputFile: string;
}

export const DEFAULT_ARGS: ReportArgs = {
  inputDir: "results",
  outputFile: "results/report.html",
};

export function parseArgs(argv: string[]): ReportArgs {
  const args = { ...DEFAULT_ARGS };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    const [flag, inlineValue] = token.startsWith("--") && token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];

    if (flag !== "--in" && flag !== "--out") {
      throw new ReportError(`unknown argument ${token}`);
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined || value === "") throw new ReportError(`${flag} needs a value`);
    if (flag === "--in") args.inputDir = value;
    else args.outputFile = value;
  }
  return args;
}

export async function runReport(argv: string[]): Promise<string> {
  const { inputDir, outputFile } = parseArgs(argv);
  const loaded = await loadRuns(inputDir);
  const html = renderHtml(loaded, { inputDir });
  await mkdir(dirname(outputFile), { recursive: true });
  await Bun.write(outputFile, html);
  return `${outputFile}: ${loaded.length} run${loaded.length === 1 ? "" : "s"} from ${inputDir}`;
}

if (import.meta.main) {
  try {
    console.log(await runReport(Bun.argv.slice(2)));
  } catch (error) {
    if (error instanceof ReportError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
