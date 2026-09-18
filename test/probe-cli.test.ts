import { describe, expect, test } from "bun:test";
import { REQUIRED_PROBE_ENV } from "../src/env.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const FILLED: Record<string, string> = {
  ARCADE_API_KEY: "test-key",
  ARCADE_MCP_URL: "https://gateway.example/mcp",
  HOOK_BEARER_TOKEN: "test-token",
  HOOK_PUBLIC_URL: "https://tunnel.example",
};

/**
 * Runs the real `bun run probe` CLI.
 *
 * Variables are passed explicitly — including as empty strings — because a
 * shell variable beats `.env.local`, so these cases stay deterministic on an
 * operator's machine where `.env.local` already holds real credentials.
 */
async function runProbe(env: Record<string, string>) {
  const child = Bun.spawn(["bun", "run", "probe", "--protocol", "2025-11-25"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** All four present except `absent`, which is blanked out. */
function envWithout(absent: string): Record<string, string> {
  return { ...FILLED, [absent]: "" };
}

describe("bun run probe", () => {
  test("exits non-zero naming ARCADE_API_KEY when nothing is configured", async () => {
    const blank = Object.fromEntries(REQUIRED_PROBE_ENV.map((name) => [name, ""]));
    const { exitCode, stderr } = await runProbe(blank);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("missing ARCADE_API_KEY");
  });

  for (const name of REQUIRED_PROBE_ENV) {
    test(`exits non-zero and names ${name} when only ${name} is absent`, async () => {
      const { exitCode, stderr } = await runProbe(envWithout(name));
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(`missing ${name}`);
      for (const other of REQUIRED_PROBE_ENV) {
        if (other !== name) expect(stderr).not.toContain(`missing ${other}`);
      }
    });
  }

  test("gets past the environment check once all four are set", async () => {
    const { exitCode, stderr } = await runProbe(FILLED);
    expect(stderr).not.toContain("missing ");
    expect(stderr).toContain("not implemented");
    expect(exitCode).toBe(1);
  });
});
