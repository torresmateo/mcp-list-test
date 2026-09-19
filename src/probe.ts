/**
 * Probe CLI — the measurement itself.
 *
 *   bun run probe --protocol <revision> [--repetitions N] [--out results/]
 *                 [--quiesce-ms MS] [--poll-interval-ms MS] [--hook-url URL]
 *
 * For each repetition it generates a fresh user id, opens a new MCP session
 * against the gateway over Streamable HTTP, sends `initialize` then one
 * `tools/list`, logs every outbound JSON-RPC request through an injected
 * `fetch`, polls the hook counter to quiescence after each of them, and writes
 * one run JSON to `--out` in the DESIGN.md schema.
 *
 * Nothing here skips or falls back. A missing credential, a malformed
 * `ARCADE_USER_ID_PREFIX`, an unreachable gateway, an unreachable hook counter
 * and a negotiated revision other than the one requested are all non-zero exits
 * that say which one happened, because every one of them would otherwise
 * produce a zero that looks exactly like the answer we came to measure.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  InvalidEnvError,
  loadEnv,
  loadUserIdPrefix,
  MissingEnvError,
  REQUIRED_PROBE_ENV,
} from "./env.ts";
import { assertRequestableRevision, UnsupportedRevisionError } from "./client/session.ts";
import { HitsClient, HitsError } from "./probe/hits.ts";
import { everyListedToolUnmatched, runRepetition, type Run } from "./probe/run.ts";

export interface ProbeArgs {
  revision: string;
  repetitions: number;
  outputDir: string;
  quiesceMs: number;
  pollIntervalMs?: number;
  /** Base URL of the hook counter. Defaults to `http://127.0.0.1:$PORT_WEB`. */
  hookUrl?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** DESIGN.md Contracts -> Probe CLI: 5 repetitions, 2 s quiescence window. */
export const DEFAULTS = { repetitions: 5, outputDir: "results", quiesceMs: 2000 } as const;

const FLAGS = [
  "--protocol",
  "--repetitions",
  "--out",
  "--quiesce-ms",
  "--poll-interval-ms",
  "--hook-url",
] as const;

function positiveInteger(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseArgs(argv: string[]): ProbeArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const split = token.startsWith("--") && token.includes("=") ? token.indexOf("=") : -1;
    const flag = split === -1 ? token : token.slice(0, split);
    if (!(FLAGS as readonly string[]).includes(flag)) {
      throw new UsageError(`unknown argument ${token}`);
    }
    const value = split === -1 ? argv[++index] : token.slice(split + 1);
    if (value === undefined || value === "") throw new UsageError(`${flag} needs a value`);
    values.set(flag, value);
  }

  const revision = values.get("--protocol");
  if (revision === undefined) {
    throw new UsageError("--protocol is required, e.g. --protocol 2025-11-25");
  }

  const repetitions = values.has("--repetitions")
    ? positiveInteger("--repetitions", values.get("--repetitions")!)
    : DEFAULTS.repetitions;
  const quiesceMs = values.has("--quiesce-ms")
    ? positiveInteger("--quiesce-ms", values.get("--quiesce-ms")!)
    : DEFAULTS.quiesceMs;
  const pollIntervalMs = values.has("--poll-interval-ms")
    ? positiveInteger("--poll-interval-ms", values.get("--poll-interval-ms")!)
    : undefined;

  return {
    revision,
    repetitions,
    outputDir: values.get("--out") ?? DEFAULTS.outputDir,
    quiesceMs,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(values.has("--hook-url") ? { hookUrl: values.get("--hook-url")! } : {}),
  };
}

/**
 * `2026-09-18T12:00:00.123Z` -> `20260918T120000123Z`, so filenames sort by time.
 *
 * Milliseconds are kept rather than trimmed to whole seconds. `<timestamp>-<revision>-<n>`
 * is unique inside one invocation whatever the precision, but two invocations
 * in the same second would otherwise write the same name and the second would
 * silently overwrite the first's evidence.
 */
export function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

/** DESIGN.md Contracts -> Run JSON: `results/<timestamp>-<revision>-<n>.json`. */
export function runFileName(date: Date, revision: string, repetition: number): string {
  return `${fileTimestamp(date)}-${revision}-${repetition}.json`;
}

/** The per-run line `.orca/project.md` asks for: method, hook hits, negotiated revision. */
function summarise(run: Run): string {
  let previous = 0;
  const rows = run.requests.map(request => {
    const hits = request.hookHitsAfter - previous;
    previous = request.hookHitsAfter;
    return `    ${request.method.padEnd(14)} ${String(hits).padStart(5)}  ${request.durationMs.toFixed(1)} ms`;
  });
  const pages =
    run.toolsListRequests === 1 && !run.cursorFollowed
      ? "1 request, no cursor"
      : `${run.toolsListRequests} requests, cursor ${run.cursorFollowed ? "followed" : "not followed"}`;
  return [
    `  ${run.userId}  [${run.status}]  negotiated ${run.revisionNegotiated ?? "—"}`,
    `    ${"method".padEnd(14)} ${"hits".padStart(5)}  duration`,
    ...rows,
    `    tools/list: ${pages}; ${run.toolsListed} tools listed, ${run.gmailToolsListed} Gmail`,
    `    not offered to the hook: ${bypassed(run)}`,
    // A run where *nothing* matched is far more likely to be a broken join
    // between `Toolkit_Tool` and the hook's two-part naming than a gateway
    // that shares nothing between the two sides. Printing the count alone
    // would read as a discovery; this says what to check first.
    ...(everyListedToolUnmatched(run)
      ? [
          `    !! no listed tool matched any hook payload tool. Before reading this as`,
          `       ${run.toolsListed} tools bypassing the hook, check the name join: the MCP side`,
          `       names a tool Toolkit_Tool, the hook payload names toolkit and tool apart.`,
        ]
      : []),
    ...(run.error === null ? [] : [`    error: ${run.error}`]),
  ].join("\n");
}

/**
 * The `toolsNotOfferedToHook` line.
 *
 * `null` is spelled out rather than printed as an empty list, for the same
 * reason the field is `null` in the JSON: a run with no hook hits says nothing
 * about what was offered, and "none" would read as a clean bill of health.
 */
function bypassed(run: Run): string {
  if (run.toolsNotOfferedToHook === null) {
    return run.toolsListResult === null
      ? "not measured (no tools/list result)"
      : "not measured (no hook hits to compare against)";
  }
  return run.toolsNotOfferedToHook.length === 0
    ? "none; every listed tool was in a hook payload"
    : run.toolsNotOfferedToHook.join(", ");
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const env = loadEnv(REQUIRED_PROBE_ENV);

  // Also before a byte goes out. The prefix ends up in the Arcade user header
  // *and* in the `GET /hits?user_id=` query, so a value the two paths encode
  // differently would have the hook called under one id and polled under
  // another: `hookHits: []`, which reads exactly like "the hook never fired".
  // A bad value is a non-zero exit naming the variable, never the default.
  const userIdPrefix = loadUserIdPrefix();

  // Validated before a single byte goes out: `Client.connect()` offers the
  // first legacy entry of its supported list, so a revision it cannot request
  // would silently measure a different one under the name that was asked for.
  assertRequestableRevision(args.revision);

  // The probe polls the *local* counter. `HOOK_PUBLIC_URL` is the tunnel the
  // gateway calls and is recorded for provenance only (DESIGN.md Environment).
  const hookUrl = args.hookUrl ?? `http://127.0.0.1:${loadEnv(["PORT_WEB"]).PORT_WEB}`;
  const hits = new HitsClient({
    baseUrl: hookUrl,
    quiesceMs: args.quiesceMs,
    ...(args.pollIntervalMs === undefined ? {} : { pollIntervalMs: args.pollIntervalMs }),
  });

  await mkdir(args.outputDir, { recursive: true });

  const timestamp = Date.now();
  console.log(
    `probe: ${args.repetitions} repetition${args.repetitions === 1 ? "" : "s"} of ${args.revision} against ${env.ARCADE_MCP_URL}`,
  );
  console.log(`probe: hook counter ${hookUrl}, quiescence ${args.quiesceMs} ms`);

  const runs: Run[] = [];
  for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
    // Serial on purpose: two sessions in flight would interleave their hook
    // hits and the quiescence window could not tell them apart.
    const run = await runRepetition({
      gatewayUrl: env.ARCADE_MCP_URL,
      revision: args.revision,
      repetition,
      timestamp,
      userIdPrefix,
      apiKey: env.ARCADE_API_KEY,
      hookPublicUrl: env.HOOK_PUBLIC_URL,
      hits,
    });
    const file = join(args.outputDir, runFileName(new Date(run.startedAt), args.revision, repetition));
    // Never overwrite: a run file is evidence, and a lost one looks exactly
    // like a repetition that never happened.
    if (await Bun.file(file).exists()) {
      throw new UsageError(`${file} already exists; refusing to overwrite a run file`);
    }
    await Bun.write(file, `${JSON.stringify(run, null, 2)}\n`);
    runs.push(run);
    console.log(`${file}`);
    console.log(summarise(run));
  }

  const failed = runs.filter(run => run.status !== "ok");
  if (failed.length > 0) {
    console.error(
      `probe: ${failed.length} of ${runs.length} repetition${runs.length === 1 ? "" : "s"} did not complete as requested (${[
        ...new Set(failed.map(run => run.status)),
      ].join(", ")})`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main(Bun.argv.slice(2));
  } catch (error) {
    // `main` is async, so a `MissingEnvError` surfaces as a rejection rather
    // than the synchronous throw `exitOnMissingEnv` is built for. The contract
    // it exists to keep is the message and the exit code, and both are kept here.
    const expected =
      error instanceof MissingEnvError ||
      error instanceof InvalidEnvError ||
      error instanceof UsageError ||
      error instanceof UnsupportedRevisionError ||
      error instanceof HitsError;
    if (expected) console.error((error as Error).message);
    else console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
  process.exit(code);
}
