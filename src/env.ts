/**
 * Shared environment loader.
 *
 * DESIGN.md Contracts -> Environment fixes the variable names and the order
 * they appear in; `REQUIRED_PROBE_ENV` below preserves that order so the
 * "first missing variable" a caller sees is stable across slices.
 *
 * Nothing here skips. A missing variable is an error, never a default.
 */

/** Operator-supplied variables the live probe needs, in DESIGN.md table order. */
export const REQUIRED_PROBE_ENV = [
  "ARCADE_API_KEY",
  "ARCADE_MCP_URL",
  "HOOK_BEARER_TOKEN",
  "HOOK_PUBLIC_URL",
] as const;

/**
 * The one optional entry in the DESIGN.md Environment table. Absent or empty,
 * the default applies; it never causes an exit. A value that was *supplied* and
 * is bad does — whitespace-only included.
 */
export const USER_ID_PREFIX_ENV = "ARCADE_USER_ID_PREFIX";

/** What `<prefix>` is when the operator did not choose one. */
export const DEFAULT_USER_ID_PREFIX = "probe";

/**
 * The characters a prefix may use.
 *
 * Deliberately narrower than either place the prefix ends up. It is sent as an
 * HTTP header value and it is polled back as `GET /hits?user_id=`, and the two
 * do not agree on what survives: a space is legal in a header value and is
 * `%20` (or `+`, depending who decodes it) in a query, `%` starts an escape in
 * one and means nothing in the other, and a newline is not transmissible in
 * either. Anything that is encoded differently on the two paths would have the
 * hook called under one id and polled under another, and `GET /hits` would
 * answer `[]` — a clean zero indistinguishable from "the hook never fired",
 * which is the measurement. Unreserved URL characters are identical on both
 * paths, so that is the whole alphabet allowed.
 */
export const USER_ID_PREFIX_PATTERN = /^[A-Za-z0-9._-]+$/;

export class MissingEnvError extends Error {
  /** The first required variable that was absent or empty. */
  readonly variable: string;

  constructor(variable: string) {
    super(`missing ${variable}`);
    this.name = "MissingEnvError";
    this.variable = variable;
  }
}

export class InvalidEnvError extends Error {
  /** The variable whose value was rejected. */
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = "InvalidEnvError";
    this.variable = variable;
  }
}

/**
 * Returns the values of `required`, in the order they were asked for.
 *
 * Throws `MissingEnvError` naming the *first* variable that is unset or empty;
 * a variable set to whitespace only counts as unset, because an operator who
 * pasted an empty value into `.env.local` meant "I have not filled this in".
 */
export function loadEnv<const T extends readonly string[]>(
  required: T,
  env: Record<string, string | undefined> = process.env,
): Record<T[number], string> {
  const resolved = {} as Record<string, string>;
  for (const name of required) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new MissingEnvError(name);
    }
    resolved[name] = value;
  }
  return resolved as Record<T[number], string>;
}

/**
 * The `<prefix>` of the generated `user_id` (DESIGN.md Contracts -> Probe CLI
 * step 1): `$ARCADE_USER_ID_PREFIX`, or `probe`.
 *
 * Two cases, and the line between them is the whole point:
 *
 *  - **Absent or empty** (unset, or `ARCADE_USER_ID_PREFIX=`). The variable was
 *    not supplied, so the default applies and nothing about the run changes.
 *  - **Supplied but invalid** — `" "`, a tab, or anything else failing
 *    {@link USER_ID_PREFIX_PATTERN}. The operator meant something and got it
 *    wrong, so this throws `InvalidEnvError` naming the variable.
 *
 * Whitespace-only is the *second* case, not the first. `loadEnv` reads a blank
 * required variable as "I have not filled this in" and that is right for a
 * credential, where the next thing that happens is a loud `missing <VAR>`.
 * Here the next thing that happens would be a completed run under `probe`,
 * which is not the prefix the operator asked for. The value is never trimmed,
 * repaired, or quietly swapped for the default: the prefix goes out in an HTTP
 * header and comes back in a `GET /hits?user_id=` query, so a run that used
 * `probe` while the operator believed it used theirs polls a key the gateway
 * never saw and reports an empty `hookHits` — a clean zero indistinguishable
 * from "the hook never fired", which is the measurement.
 */
export function loadUserIdPrefix(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[USER_ID_PREFIX_ENV];
  if (raw === undefined || raw === "") return DEFAULT_USER_ID_PREFIX;
  if (!USER_ID_PREFIX_PATTERN.test(raw)) {
    throw new InvalidEnvError(
      USER_ID_PREFIX_ENV,
      `invalid ${USER_ID_PREFIX_ENV}=${JSON.stringify(raw)}: must match ${USER_ID_PREFIX_PATTERN.source}`,
    );
  }
  return raw;
}

/**
 * Entry-point helper: run `fn`, and turn a `MissingEnvError` into the contract
 * every command shares — `missing <VAR>` on stderr and a non-zero exit. An
 * `InvalidEnvError` takes the same path: both name the variable, and neither
 * lets the command carry on with a value it did not get.
 */
export function exitOnMissingEnv<R>(fn: () => R): R {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
