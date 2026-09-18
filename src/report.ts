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
}

export interface HookHit {
  receivedAt: string;
  payload: unknown;
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
    };
  });
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

function statusBadge(status: RunStatus): string {
  return `<span class="status status-${status}">${escapeHtml(status)}</span>`;
}

function num(value: number | string): string {
  return `<td class="num">${escapeHtml(String(value))}</td>`;
}

function empty(): string {
  return `<td class="num empty">—</td>`;
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

function timelineTable(run: Run): string {
  const deltas = hitsPerRequest(run);
  const rows = run.requests
    .map((request, index) =>
      [
        "<tr>",
        num(request.id),
        `<td class="text">${escapeHtml(request.method)}</td>`,
        `<td class="text">${escapeHtml(request.sentAt)}</td>`,
        num(request.hookHitsAfter),
        num(deltas[index] ?? 0),
        "</tr>",
      ].join(""),
    )
    .join("\n");

  return [
    `<table class="timeline">`,
    `<thead><tr><th>id</th><th class="text">method</th><th class="text">sent at</th>` +
      `<th>hookHitsAfter<br>(cumulative)</th><th>hook hits<br>(this request)</th></tr></thead>`,
    `<tbody>\n${rows}\n</tbody>`,
    `</table>`,
  ].join("\n");
}

function runSection(entry: LoadedRun): string {
  const { file, run } = entry;
  const meta: [string, string][] = [
    ["revision requested", escapeHtml(run.revisionRequested)],
    ["revision negotiated", escapeHtml(formatRevisionNegotiated(run.revisionNegotiated))],
    ["status", statusBadge(run.status)],
    ["user id", escapeHtml(run.userId)],
    ["hook public url", escapeHtml(run.hookPublicUrl)],
    ["tools listed", escapeHtml(String(run.toolsListed))],
    ["Gmail tools listed", escapeHtml(String(run.gmailToolsListed))],
    ["error", run.error === null ? '<span class="empty">none</span>' : escapeHtml(run.error)],
  ];

  const payloads =
    run.hookHits.length === 0
      ? `<p class="empty">No hook hits recorded for this run.</p>`
      : run.hookHits
          .map(
            (hit, index) =>
              `<h4>hit ${index + 1} — received at ${escapeHtml(hit.receivedAt)}</h4>\n` +
              `<pre>${escapeHtml(JSON.stringify(hit.payload, null, 2))}</pre>`,
          )
          .join("\n");

  return [
    `<section class="run" id="${escapeHtml(file)}">`,
    `<h3>${escapeHtml(file)}</h3>`,
    `<dl class="meta">`,
    ...meta.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`),
    `</dl>`,
    `<h4>request timeline</h4>`,
    timelineTable(run),
    `<h4>raw hook payloads (${run.hookHits.length})</h4>`,
    payloads,
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

<h2>Runs</h2>
<nav><ol>
${toc}
</ol></nav>

${loaded.map(runSection).join("\n\n")}

<footer>Generated by <code>bun run report</code>. Print to PDF from the browser.</footer>
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
