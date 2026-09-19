/**
 * The environment every spawn of the probe CLI pins — issue #29.
 *
 * ## Where the leak actually is
 *
 * Not `.env.local`. `bun test` sets `NODE_ENV=test` and bun skips `.env.local`
 * under it, and a child spawned from a test inherits that `NODE_ENV`, so the
 * child skips it too — even with its cwd set to the repo root, where the file
 * is. Measured on bun 1.3.14 with `.env.local` holding `PORT_WEB=3410`, a child
 * spawned from `bun test` and asked what it could see:
 *
 *     {"PORT_WEB":null,"NODE_ENV":"test","ARCADE_USER_ID_PREFIX":" "}
 *
 * The file was right there and contributed nothing; the `" "` came from the
 * shell that started `bun test`. **The parent process is the leak.** The
 * quickstart in `.orca/project.md` opens with `set -a; . ./.env.local; set +a`,
 * which exports those variables into the operator's shell — and after that same
 * export, the same child:
 *
 *     {"PORT_WEB":"3410","NODE_ENV":"test","ARCADE_USER_ID_PREFIX":null}
 *
 * Anything in the operator's shell reaches the probe through every `Bun.spawn`
 * that spreads `process.env`. That is how a stray `ARCADE_USER_ID_PREFIX=" "`
 * turned `bun test` from 220 pass into 219 pass / 1 fail: the probe validated
 * it and exited at the environment check, so the test that asserts the probe
 * "gets past the environment check and then fails loudly on the gateway" was
 * measuring a probe that never reached a gateway.
 *
 * ## Why pin rather than unset, and why not loosen the validation
 *
 * Deleting `ARCADE_USER_ID_PREFIX` from `process.env` would make today's red
 * test green and leave the next spawn exposed to `PORT_WEB`, or to whatever the
 * probe reads next. Loosening the validation would undo #23's contract, which
 * exists precisely because a supplied-but-invalid prefix quietly swapped for
 * `probe` polls a key the gateway never saw and reports an empty `hookHits` — a
 * clean zero indistinguishable from "the hook never fired", which is the
 * measurement this project exists to take. The defect is that a test inherits
 * ambient state, so the fix is at the spawn.
 *
 * ## Why blank
 *
 * An explicitly-set value beats `.env.local` even when it is empty, and blank
 * is what each of these variables' own contract reads as absent: the four
 * required ones exit `missing <VAR>`, and `ARCADE_USER_ID_PREFIX` falls back to
 * the documented `probe`. So a case that needs a value supplies it — by
 * spreading its own env after this object — and a case that forgets one gets a
 * loud, named failure instead of the operator's real credentials.
 *
 * ## Keeping it honest
 *
 * This names every variable `src/probe.ts` reads. A variable the probe starts
 * reading and this object does not name is a variable the next suite silently
 * inherits, so add it here in the same commit.
 */
import { REQUIRED_PROBE_ENV, USER_ID_PREFIX_ENV } from "../../src/env.ts";

export const PINNED_PROBE_ENV: Record<string, string> = {
  // ARCADE_API_KEY, ARCADE_MCP_URL, HOOK_BEARER_TOKEN, HOOK_PUBLIC_URL —
  // read from the shared list so a fifth required variable cannot be added to
  // the probe and forgotten here.
  ...Object.fromEntries(REQUIRED_PROBE_ENV.map(name => [name, ""])),
  [USER_ID_PREFIX_ENV]: "",
  // `src/probe.ts` falls back to `http://127.0.0.1:$PORT_WEB` when `--hook-url`
  // is absent. Unpinned, a spawn that omits the flag would poll whatever hook
  // server the operator has running on their worktree's port and report its
  // hits as this run's — the counter is keyed by user id, so it would answer,
  // and the number would look like an answer. Blank makes that spawn exit
  // `missing PORT_WEB` instead.
  PORT_WEB: "",
};
