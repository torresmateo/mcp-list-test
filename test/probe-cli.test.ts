import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
async function runProbe(env: Record<string, string>, extraArgs: string[] = []) {
  const child = Bun.spawn(["bun", "run", "probe", "--protocol", "2025-11-25", ...extraArgs], {
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

  /**
   * This replaces the assertion that the stub printed `not implemented`.
   *
   * That test existed to prove the stub failed loudly before the real probe
   * arrived, and slice #4 is the event that retires it: `bun run probe` now
   * opens a session, so nothing prints `not implemented` any more. What has to
   * survive is the project-level contract behind it — a command that cannot do
   * its job exits non-zero and says why — so the replacement keeps the same
   * shape against a gateway that is not there. `ARCADE_MCP_URL` points at port
   * 1, which nothing listens on, and `--out` is a scratch directory so the
   * failed run does not land in the operator's `results/`.
   */
  test("gets past the environment check and then fails loudly on the gateway", async () => {
    const out = mkdtempSync(join(tmpdir(), "probe-cli-out-"));
    try {
      const { exitCode, stdout, stderr } = await runProbe(
        { ...FILLED, ARCADE_MCP_URL: "http://127.0.0.1:1/mcp" },
        ["--repetitions", "1", "--out", out, "--quiesce-ms", "100", "--hook-url", "http://127.0.0.1:1"],
      );

      expect(stderr).not.toContain("missing ");
      expect(stderr).not.toContain("not implemented");
      expect(stdout).not.toContain("not implemented");
      // It says what it could not do, and it exits non-zero saying it.
      expect(stderr).toContain("did not complete as requested");
      expect(exitCode).not.toBe(0);

      // And it left the evidence rather than only a message: one run file,
      // status `error`, nothing negotiated.
      const files = readdirSync(out).filter((name) => name.endsWith(".json"));
      expect(files).toHaveLength(1);
      const run = (await Bun.file(join(out, files[0]!)).json()) as Record<string, unknown>;
      expect(run["status"]).toBe("error");
      expect(run["revisionNegotiated"]).toBeNull();
      expect(typeof run["error"]).toBe("string");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 30_000);
});
