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
   * There is no MCP request or response **body** here, and that is not an
   * oversight to paper over: `src/client/request-log.ts` deliberately pipes the
   * response through instead of cloning it, so nothing ever captured one. The
   * row says `body not recorded` rather than rendering `{}` as though it were
   * the payload.
   */
  jsonRpcId?: number;
  finishedAt?: string;
  status?: number;
  userIdHeader?: string;
  authorizationScheme?: string;
  responseObserved?: boolean;
  /** Written only when this `tools/list` request followed a `nextCursor`. */
  cursor?: string;
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
}

export interface PayloadPlan {
  /** One entry per loaded run, each with one placement per hook hit. */
  perRun: PayloadPlacement[][];
  /** Payload occurrences across the whole report. */
  occurrences: number;
  /** Distinct payload bodies — how many are rendered in full. */
  distinct: number;
  /** Occurrences that are repeats and therefore render no body. */
  repeats: number;
  /**
   * Characters of escaped, pretty-printed JSON the repeats did not re-emit.
   * The measurement behind "the report shrank", kept here so a test can pin it
   * instead of trusting that a smaller file means the right thing happened.
   */
  charsSaved: number;
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
  const perRun: PayloadPlacement[][] = [];
  let occurrences = 0;
  let repeats = 0;
  let charsSaved = 0;

  for (const { file, run } of loaded) {
    const placements = run.hookHits.map((hit, index): PayloadPlacement => {
      occurrences += 1;
      const body = payloadText(hit.payload);
      const anchor = payloadAnchor(file, index);
      const earlier = seen.get(body);
      if (earlier === undefined) {
        const digest = createHash("sha256").update(body).digest("hex");
        seen.set(body, { anchor, label: payloadLabel(file, index), digest });
        return { anchor, digest, storedAt: anchor };
      }
      repeats += 1;
      charsSaved += escapeHtml(storedPayload(hit.payload)).length;
      return {
        anchor,
        digest: earlier.digest,
        storedAt: earlier.anchor,
        sameAs: { anchor: earlier.anchor, label: earlier.label },
      };
    });
    perRun.push(placements);
  }

  return { perRun, occurrences, distinct: seen.size, repeats, charsSaved };
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

/**
 * The payload as the document embeds it: pretty-printed while it is small
 * enough for a person to read as text, compact once it is not.
 *
 * Complete either way — see {@link PRETTY_PAYLOAD_MAX_BYTES}. The explorer
 * parses this same text, so there is exactly one copy of a payload in the
 * document no matter which form it took.
 */
export function storedPayload(payload: unknown): string {
  const compact = payloadText(payload);
  return Buffer.byteLength(compact, "utf8") > PRETTY_PAYLOAD_MAX_BYTES
    ? compact
    : (JSON.stringify(payload, null, 2) ?? "null");
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
  const mount = `<div class="json" data-payload="${escapeHtml(placement.storedAt)}"></div>`;

  if (placement.sameAs !== undefined) {
    return [
      mount,
      `<p class="repeat-note">Byte-identical to ` +
        `<a href="#${escapeHtml(placement.sameAs.anchor)}">` +
        `${escapeHtml(placement.sameAs.label)}</a>, which carries the one embedded copy. ` +
        `Compared byte for byte, not by size or by tool count; sha-256 of the payload is ` +
        `<code>${escapeHtml(placement.digest)}</code>.</p>`,
    ].join("\n");
  }
  return [
    mount,
    `<details class="raw"><summary>raw JSON</summary>`,
    `<pre id="${escapeHtml(placement.anchor)}">${escapeHtml(storedPayload(hit.payload))}</pre>`,
    `</details>`,
  ].join("\n");
}

/** One `<dt>`/`<dd>` pair, with `not recorded` for anything the run file lacks. */
function detailRow(term: string, value: string | undefined): string {
  return `<dt>${escapeHtml(term)}</dt><dd>${
    value === undefined ? metaUnmeasured() : escapeHtml(value)
  }</dd>`;
}

/**
 * What the run JSON holds about one MCP request (issue #25 criterion 5).
 *
 * There is no body, and the row says so in those words. `src/client/request-log.ts`
 * pipes the response through instead of cloning it, so no MCP request or
 * response body was ever captured — rendering `{}` here would put an empty
 * object where a reader expects the payload, which is the plausible-but-wrong
 * rendering this report exists to avoid. A later slice adds capture; the row is
 * shaped so a body slots in beside this list when it does.
 */
function requestDetail(request: RunRequest): string {
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
    `<p class="empty">body not recorded — <code>src/client/request-log.ts</code> pipes the ` +
      `response through rather than cloning it, so no MCP body was captured for this request.</p>`,
  ].join("\n");
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
function wireTable(entry: LoadedRun, placements: PayloadPlacement[]): string {
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
        `<details class="event"><summary>body not recorded · ` +
          `${escapeHtml(event.request.method)} request · what the run JSON holds</summary>`,
        requestDetail(event.request),
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
    const placement = placements[event.index]!;
    const detail = [
      `<tr class="detail">`,
      `<td colspan="10">`,
      `<details class="event" id="${escapeHtml(placement.anchor)}--row">` +
        `<summary>${payloadSummaryLine(event.hit, placement)}</summary>`,
      payloadDetail(event.hit, placement),
      `<h5>captured request headers</h5>`,
      headersList(event.hit.headers),
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
 * What the reader is told about repeated payloads, stated whether or not there
 * were any: "nothing was collapsed" is as much a result as a saving.
 */
export function payloadDedupeNote(plan: PayloadPlan): string {
  if (plan.occurrences === 0) return `<p class="sub">No hook payloads in this report.</p>`;
  if (plan.repeats === 0) {
    return (
      `<p class="sub">No two of the ${plan.occurrences} hook payloads in this report are ` +
      `byte-identical, so every one is embedded in full.</p>`
    );
  }
  return (
    `<p class="sub">${plan.repeats} of the ${plan.occurrences} hook payloads are ` +
    `<strong>byte-identical repeats</strong> of an earlier hit; ${plan.distinct} distinct ` +
    `payloads are embedded once each, and every repeat shows its digest, links the hit that ` +
    `carries the copy, and expands from that same copy. The comparison is over the payload ` +
    `bytes, not over <code>bodyBytes</code> or the toolkit and tool counts: a payload that ` +
    `differs anywhere is embedded in full, so nothing a hit carried can be hidden by this.</p>`
  );
}

/** `not recorded` as a `<dd>` value, kept distinct from a measured value of 0. */
function metaUnmeasured(): string {
  return '<span class="empty">not recorded</span>';
}

function runSection(entry: LoadedRun, placements: PayloadPlacement[]): string {
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
