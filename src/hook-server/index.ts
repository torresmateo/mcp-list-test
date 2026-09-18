/**
 * Access-hook counter CLI — `bun run hook-server`.
 *
 * A thin wrapper: it reads `PORT_WEB` and `HOOK_BEARER_TOKEN` through
 * `loadEnv` (so a missing one is a loud `missing <VAR>` and exit 1, never a
 * default) and hands them to `startHookServer`. All the behaviour lives in
 * `./server.ts`, which other slices import directly to run a counter on an
 * ephemeral port.
 *
 *   bun run hook-server [--log <path>]
 *
 * `--log` overrides `results/hook-log.jsonl`; it exists so a test can point the
 * server at its own temp directory instead of sharing one mutable file.
 */
import { exitOnMissingEnv, loadEnv } from "../env.ts";
import { DEFAULT_LOG_PATH, startHookServer } from "./server.ts";

/** Reads `--log <path>`; anything else is a usage error rather than ignored. */
function parseArgs(argv: string[]): { logPath: string } {
  let logPath = DEFAULT_LOG_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--log") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        console.error("--log requires a path");
        process.exit(1);
      }
      logPath = value;
      index += 1;
      continue;
    }
    console.error(`unknown argument ${arg}`);
    process.exit(1);
  }
  return { logPath };
}

const { logPath } = parseArgs(process.argv.slice(2));
const env = exitOnMissingEnv(() => loadEnv(["PORT_WEB", "HOOK_BEARER_TOKEN"]));

// `0` is allowed and means "any free port"; the listening line reports the one
// that was actually bound, so a caller never has to guess.
const port = Number(env.PORT_WEB);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT_WEB must be a port number, got ${JSON.stringify(env.PORT_WEB)}`);
  process.exit(1);
}

const server = startHookServer({
  port,
  token: env.HOOK_BEARER_TOKEN,
  logPath,
});

console.log(`hook-server listening on :${server.port}`);
console.log(`appending hits to ${server.logPath}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
