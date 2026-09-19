import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_PROBE_ENV, USER_ID_PREFIX_ENV } from "../src/env.ts";
import { PINNED_PROBE_ENV } from "./support/probe-env.ts";

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
 * Every variable the probe reads is pinned by `PINNED_PROBE_ENV` before the
 * caller's own env is spread over it, so nothing the operator's shell happens
 * to hold decides what these cases measure. Read that module for what leaks and
 * why blank is the right pin; the short version is that `process.env`, not
 * `.env.local`, is the channel, and this file used to leave it open.
 *
 * The caller's `env` goes last on purpose: a case that wants a value — a real
 * gateway URL, or a deliberately malformed prefix — still gets exactly the one
 * it asked for.
 */
async function runProbe(env: Record<string, string>, extraArgs: string[] = []) {
  const child = Bun.spawn(["bun", "run", "probe", "--protocol", "2025-11-25", ...extraArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...PINNED_PROBE_ENV, ...env },
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

/**
 * The guard for issue #29, and the reason it is a test rather than a comment.
 *
 * Every case above pins the environment it needs. Nothing about the *pinning*
 * is visible in their assertions, though, so the day somebody adds a spawn that
 * forgets it, those cases stay green and the loss shows up only on the machine
 * of whoever happens to have the wrong thing exported. These two cases assert
 * the pinning directly: they put the hostile value in `process.env` — the
 * channel that actually leaks, since `bun test` sets `NODE_ENV=test` and
 * neither the test process nor its children read `.env.local` under it — and
 * then check that the spawned probe behaved as if it were not there.
 *
 * The values are the two that matter. `ARCADE_USER_ID_PREFIX=" "` is the one
 * that turned `bun test` red on `973c1ea`; `PORT_WEB` is the one nothing
 * exercises yet, which is worse, because a probe spawned without `--hook-url`
 * would fall back to `http://127.0.0.1:$PORT_WEB` and poll the operator's own
 * running hook server without a word.
 *
 * Neither case weakens the probe. `src/env.ts` still rejects the prefix and
 * `src/probe.ts` still demands a hook URL; `test/env.test.ts` and the
 * `ARCADE_USER_ID_PREFIX` cases in `test/probe.test.ts` pin that contract, and
 * this file leaves it alone. What changed is that a test no longer inherits.
 */
describe("a spawned probe does not inherit the operator's environment", () => {
  /** Sets `name` in this process for the duration of `body`, then restores it. */
  async function withAmbient(name: string, value: string, body: () => Promise<void>) {
    const saved = process.env[name];
    process.env[name] = value;
    try {
      await body();
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  }

  test("an invalid ambient ARCADE_USER_ID_PREFIX never reaches it", async () => {
    await withAmbient(USER_ID_PREFIX_ENV, " ", async () => {
      const out = mkdtempSync(join(tmpdir(), "probe-cli-ambient-prefix-"));
      try {
        const { exitCode, stderr } = await runProbe(
          { ...FILLED, ARCADE_MCP_URL: "http://127.0.0.1:1/mcp" },
          ["--repetitions", "1", "--out", out, "--quiesce-ms", "100", "--hook-url", "http://127.0.0.1:1"],
        );

        // It got where the case above gets: past the environment check, and
        // then loudly nowhere, because port 1 has nothing on it.
        expect(stderr).not.toContain(USER_ID_PREFIX_ENV);
        expect(stderr).toContain("did not complete as requested");
        expect(exitCode).not.toBe(0);

        // Positive evidence, not a missing error message: the run the probe
        // wrote is keyed by the documented default, so the blank pin is what
        // reached `loadUserIdPrefix` and `probe` is what came back out.
        const files = readdirSync(out).filter((name) => name.endsWith(".json"));
        expect(files).toHaveLength(1);
        const run = (await Bun.file(join(out, files[0]!)).json()) as Record<string, unknown>;
        expect(run["userId"]).toMatch(/^probe-2025-11-25-\d+-1$/);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  }, 30_000);

  test("an ambient PORT_WEB is not silently adopted as the hook counter", async () => {
    // A port number that is not going to be anybody's hook server, and is
    // distinctive enough to recognise in the output if it ever leaked through.
    const AMBIENT_PORT = "64999";
    await withAmbient("PORT_WEB", AMBIENT_PORT, async () => {
      const out = mkdtempSync(join(tmpdir(), "probe-cli-ambient-port-"));
      try {
        // Deliberately no `--hook-url`: this is the path that reads PORT_WEB.
        const { exitCode, stderr } = await runProbe(FILLED, [
          "--repetitions",
          "1",
          "--out",
          out,
          "--quiesce-ms",
          "100",
        ]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("missing PORT_WEB");
        expect(stderr).not.toContain(AMBIENT_PORT);
        // It stopped before it could measure anything, which is the point: a
        // run file here would be a count taken against somebody else's counter.
        expect(readdirSync(out).filter((name) => name.endsWith(".json"))).toHaveLength(0);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  }, 30_000);
});
