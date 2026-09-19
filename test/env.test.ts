import { describe, expect, test } from "bun:test";
import {
  DEFAULT_USER_ID_PREFIX,
  InvalidEnvError,
  MissingEnvError,
  REQUIRED_PROBE_ENV,
  USER_ID_PREFIX_ENV,
  loadEnv,
  loadUserIdPrefix,
} from "../src/env.ts";

const FULL = {
  ARCADE_API_KEY: "key",
  ARCADE_MCP_URL: "https://gateway.example/mcp",
  HOOK_BEARER_TOKEN: "token",
  HOOK_PUBLIC_URL: "https://tunnel.example",
};

describe("loadEnv", () => {
  test("returns every requested variable when all are present", () => {
    expect(loadEnv(REQUIRED_PROBE_ENV, FULL)).toEqual(FULL);
  });

  test("names the first missing variable, in DESIGN.md table order", () => {
    // Blank each variable in turn with every earlier one present, so the
    // message can only be about the one that is actually absent.
    for (const [index, name] of REQUIRED_PROBE_ENV.entries()) {
      const env = { ...FULL };
      for (const later of REQUIRED_PROBE_ENV.slice(index)) delete env[later];
      expect(() => loadEnv(REQUIRED_PROBE_ENV, env)).toThrow(`missing ${name}`);
    }
  });

  test("reports the earliest gap when several are missing at once", () => {
    expect(() => loadEnv(REQUIRED_PROBE_ENV, {})).toThrow("missing ARCADE_API_KEY");
  });

  test("treats an empty or whitespace value as missing", () => {
    expect(() => loadEnv(["HOOK_BEARER_TOKEN"], { HOOK_BEARER_TOKEN: "" })).toThrow(
      "missing HOOK_BEARER_TOKEN",
    );
    expect(() => loadEnv(["HOOK_BEARER_TOKEN"], { HOOK_BEARER_TOKEN: "  " })).toThrow(
      "missing HOOK_BEARER_TOKEN",
    );
  });

  test("carries the variable name on the error, not only in the message", () => {
    try {
      loadEnv(REQUIRED_PROBE_ENV, { ARCADE_API_KEY: "key" });
      throw new Error("expected loadEnv to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvError);
      expect((error as MissingEnvError).variable).toBe("ARCADE_MCP_URL");
    }
  });

  test("required order is the DESIGN.md Environment table order", () => {
    expect([...REQUIRED_PROBE_ENV]).toEqual([
      "ARCADE_API_KEY",
      "ARCADE_MCP_URL",
      "HOOK_BEARER_TOKEN",
      "HOOK_PUBLIC_URL",
    ]);
  });
});

describe("loadUserIdPrefix", () => {
  test("defaults to probe when the variable is absent", () => {
    expect(loadUserIdPrefix({})).toBe("probe");
    expect(DEFAULT_USER_ID_PREFIX).toBe("probe");
  });

  test("defaults to probe when the variable is empty or whitespace only", () => {
    // Same reading `loadEnv` gives a blank required variable: an operator who
    // left `ARCADE_USER_ID_PREFIX=` in `.env.local` has not chosen a prefix.
    for (const blank of ["", " ", "\t", "\n  "]) {
      expect(loadUserIdPrefix({ [USER_ID_PREFIX_ENV]: blank })).toBe("probe");
    }
  });

  test("returns an operator-set prefix exactly as written", () => {
    for (const prefix of ["mateo", "run-7", "probe.2026-09-18", "A_b", "x"]) {
      expect(loadUserIdPrefix({ [USER_ID_PREFIX_ENV]: prefix })).toBe(prefix);
    }
  });

  test("rejects a value that the header and the query would encode differently", () => {
    /**
     * The failure this guard exists for: the prefix goes out in the Arcade user
     * header *and* comes back in `GET /hits?user_id=`. A value the two paths do
     * not agree on has the hook called under one id and polled under another,
     * and `GET /hits` answers `[]` — a clean zero indistinguishable from "the
     * hook never fired", which is the thing being measured. So it is rejected
     * here, loudly, rather than mangled later.
     */
    const bad = [
      "my probe", // a space: `%20` or `+` in a query, legal in a header
      "100%", // starts a percent-escape on one path only
      "a&b=c", // splits the query into other parameters
      "a/b", // path separator
      "a?b",
      "a#b",
      "a+b", // a literal plus decodes as a space
      "probe\n", // not transmissible in a header at all
      "probe\r\nX-Injected: 1",
      "prøbe", // non-ASCII: the header would need encoding the query does not use
      " probe", // never silently trimmed into the value that looks right
      "probe ",
    ];
    for (const value of bad) {
      expect(() => loadUserIdPrefix({ [USER_ID_PREFIX_ENV]: value })).toThrow(InvalidEnvError);
    }
  });

  test("names the variable when it rejects, and never falls back to the default", () => {
    try {
      loadUserIdPrefix({ [USER_ID_PREFIX_ENV]: "my probe" });
      throw new Error("expected loadUserIdPrefix to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvError);
      expect((error as InvalidEnvError).variable).toBe("ARCADE_USER_ID_PREFIX");
      // The message an operator reads on stderr names the variable, so the fix
      // is obvious without reading the source.
      expect((error as Error).message).toContain("ARCADE_USER_ID_PREFIX");
      // And it is not a `MissingEnvError`: "you set it wrong" and "you did not
      // set it" are different instructions.
      expect(error).not.toBeInstanceOf(MissingEnvError);
    }
  });

  test("is not one of the required variables: its absence never exits", () => {
    expect([...REQUIRED_PROBE_ENV]).not.toContain(USER_ID_PREFIX_ENV);
    expect(() => loadEnv(REQUIRED_PROBE_ENV, FULL)).not.toThrow();
  });
});
