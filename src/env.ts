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

export class MissingEnvError extends Error {
  /** The first required variable that was absent or empty. */
  readonly variable: string;

  constructor(variable: string) {
    super(`missing ${variable}`);
    this.name = "MissingEnvError";
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
 * Entry-point helper: run `fn`, and turn a `MissingEnvError` into the contract
 * every command shares — `missing <VAR>` on stderr and a non-zero exit.
 */
export function exitOnMissingEnv<R>(fn: () => R): R {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MissingEnvError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
