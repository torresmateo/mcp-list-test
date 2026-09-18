import { describe, expect, test } from "bun:test";
import { MissingEnvError, REQUIRED_PROBE_ENV, loadEnv } from "../src/env.ts";

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
