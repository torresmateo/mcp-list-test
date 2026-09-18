/**
 * Probe CLI — `bun run probe --protocol <revision>`.
 *
 * Slice #1 ships the environment contract only: the probe loads every
 * operator-supplied variable and fails loudly when one is absent. The MCP
 * session, the hook polling and the run JSON land in a later slice, so the
 * body is deliberately a stub that exits 1.
 */
import { REQUIRED_PROBE_ENV, exitOnMissingEnv, loadEnv } from "./env.ts";

exitOnMissingEnv(() => loadEnv(REQUIRED_PROBE_ENV));

console.error("not implemented");
process.exit(1);
