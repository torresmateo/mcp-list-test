/**
 * `bun run hook-server` end to end — acceptance criterion 1, plus the
 * fail-loud environment contract slice #1 established.
 *
 * Every variable these tests depend on is passed explicitly, including the
 * empty strings that stand for "absent". A test that leaned on the ambient
 * `.env.local` would stop testing anything the day the operator filled in real
 * credentials, and would stay green while it did.
 *
 * Two measured bun facts drive how that is done here:
 *
 *  1. `bun test` sets `NODE_ENV=test`, and bun does **not** load `.env.local`
 *     under that NODE_ENV. A child spawned from a test inherits it, so by
 *     default a spawned command sees no `.env.local` at all. Relying on that
 *     would make "missing PORT_WEB" prove nothing about precedence.
 *  2. bun reads `.env` files from the **cwd of the process it starts**, not
 *     from the directory the entry script lives in. So the child's cwd — not
 *     the repo root — decides which `.env.local` it loads.
 *  3. With `.env.local` actually loaded, an explicitly-set variable still wins,
 *     including when it is empty. That is what `withEnvLocalLoaded` exercises.
 *
 * Together, (2) and (3) are why every child here runs in a temp directory this
 * file created. The worktree's own `.env.local` is gitignored and written by
 * `scripts/orca-setup.sh`: it exists in an Orca worktree and in no plain
 * `git clone`, so a test that interrogated it would prove precedence on one
 * machine and throw ENOENT on another.
 *
 * The server is started on `PORT_WEB=0` — an ephemeral port — and reports the
 * port it actually bound, so these tests never race the operator's own hook
 * server for the worktree's `$PORT_WEB`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * What `package.json`'s `hook-server` script runs, as an absolute path. The
 * fixture cases below give the child a temp directory as its cwd, and from
 * there `bun run hook-server` would find no `package.json` to look the script
 * up in. `test/scripts.test.ts` and the `startCli` cases keep the script alias
 * itself covered.
 */
const HOOK_SERVER_ENTRY = `${REPO_ROOT}src/hook-server/index.ts`;

const TOKEN = "cli-hook-token";

/** The value only the fixture `.env.local` can supply; the CLI echoes it back. */
const FIXTURE_PORT_WEB = "port-from-env-local-fixture";

const running: { kill(): void }[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  // Nothing this suite starts may outlive it.
  while (running.length > 0) running.pop()?.kill();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * A temp directory to hand the child as its cwd, holding the `.env.local` the
 * caller passed — or none at all. bun reads `.env` files from the child's cwd,
 * so this is what decides which file the child loads, and it is always one
 * this test wrote. Cleaned up in `afterEach` with the rest of `tempDirs`.
 */
function envCwd(envLocal?: string): string {
  const dir = tempDir("hook-env-");
  if (envLocal !== undefined) writeFileSync(join(dir, ".env.local"), envLocal);
  return dir;
}

/**
 * Child env with `NODE_ENV` cleared, so bun loads `.env.local` in the child the
 * way it does for an operator at a shell prompt. `bun test` sets
 * `NODE_ENV=test`, under which bun skips `.env.local` entirely.
 *
 * `PORT_WEB` is dropped unless the caller overrides it, so a child that ends up
 * with one got it from the `.env.local` in its cwd and nowhere else. Without
 * that, an operator who had run `set -a; . ./.env.local; set +a` before
 * `bun test` would export `PORT_WEB` into this process, the child would inherit
 * it, and "PORT_WEB was found" would stop being evidence that any file was read.
 */
function withEnvLocalLoaded(
  overrides: Record<string, string>,
): Record<string, string | undefined> {
  // Bun.spawn drops a variable whose value is `undefined`.
  return { NODE_ENV: undefined, PORT_WEB: undefined, ...overrides };
}

/**
 * Runs the hook-server CLI to completion — for the cases that exit.
 *
 * `cwd` defaults to a temp directory with no `.env` files in it, so a case that
 * does not ask for a fixture reads no ambient file either.
 */
async function runToExit(
  env: Record<string, string | undefined>,
  args: string[] = [],
  cwd: string = envCwd(),
) {
  const child = Bun.spawn(["bun", "run", HOOK_SERVER_ENTRY, ...args], {
    cwd,
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

/** Reads `stream` until `pattern` shows up, or gives up with what it saw. */
async function readUntil(stream: ReadableStream<Uint8Array>, pattern: RegExp, timeoutMs = 15_000) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => "timeout" as const),
      ]);
      if (next === "timeout") break;
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (pattern.test(buffer)) return buffer;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`timed out waiting for ${pattern}; saw: ${JSON.stringify(buffer)}`);
}

/** Starts the CLI on an ephemeral port and returns the port it reported. */
async function startCli(overrides: Record<string, string> = {}) {
  const dir = tempDir("hook-cli-");
  const logPath = join(dir, "hook-log.jsonl");
  const child = Bun.spawn(["bun", "run", "hook-server", "--log", logPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT_WEB: "0", HOOK_BEARER_TOKEN: TOKEN, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  running.push(child);

  const stdout = await readUntil(child.stdout, /hook-server listening on :\d+/);
  const port = Number(/hook-server listening on :(\d+)/.exec(stdout)?.[1]);
  expect(port).toBeGreaterThan(0);
  return { child, stdout, port, logPath, url: `http://127.0.0.1:${port}` };
}

describe("bun run hook-server (criterion 1)", () => {
  test("logs the port it is listening on and answers /healthz with 200", async () => {
    const cli = await startCli();
    expect(cli.stdout).toContain(`hook-server listening on :${cli.port}`);

    const response = await fetch(`${cli.url}/healthz`);
    expect(response.status).toBe(200);
  });

  test("the running CLI serves the whole contract, log file included", async () => {
    const cli = await startCli();

    const accepted = await fetch(`${cli.url}/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        user_id: "u1",
        toolkits: {
          Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } },
          Slack: { tools: { Post: [{ version: "1.0.0" }] } },
        },
      }),
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { toolkits: Record<string, unknown> };
    expect(Object.keys(body.toolkits)).toEqual(["Slack"]);

    const rejected = await fetch(`${cli.url}/access`, {
      method: "POST",
      body: JSON.stringify({ user_id: "u1", toolkits: {} }),
    });
    expect(rejected.status).toBe(401);

    const hits = (await (await fetch(`${cli.url}/hits?user_id=u1`)).json()) as { count: number };
    expect(hits.count).toBe(1);
    expect(readFileSync(cli.logPath, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("writes to the --log path, leaving results/hook-log.jsonl alone", async () => {
    const cli = await startCli();
    expect(cli.stdout).toContain(`appending hits to ${cli.logPath}`);
    expect(cli.stdout).not.toContain("results/hook-log.jsonl");
  });
});

describe("bun run hook-server environment contract", () => {
  test("a blank PORT_WEB beats the PORT_WEB a loaded .env.local defines", async () => {
    // One fixture, used by both runs, so the only difference between them is
    // whether PORT_WEB is explicitly set. `FIXTURE_PORT_WEB` is deliberately not
    // a number: the CLI quotes the value it found back at you, which turns "the
    // file was loaded" into something the run prints rather than something the
    // absence of an error implies. It also means neither run binds a port.
    const cwd = envCwd(`PORT_WEB=${FIXTURE_PORT_WEB}\n`);

    // Nothing else can supply PORT_WEB — `withEnvLocalLoaded` drops the
    // inherited one — so the echoed value proves the child read this file.
    const loaded = await runToExit(withEnvLocalLoaded({ HOOK_BEARER_TOKEN: TOKEN }), [], cwd);
    expect(loaded.exitCode).not.toBe(0);
    expect(loaded.stderr).toContain(`PORT_WEB must be a port number, got "${FIXTURE_PORT_WEB}"`);

    // Same file, same run, PORT_WEB explicitly blank: the empty value wins, and
    // the file's value never reaches `loadEnv` at all.
    const overridden = await runToExit(
      withEnvLocalLoaded({ PORT_WEB: "", HOOK_BEARER_TOKEN: TOKEN }),
      [],
      cwd,
    );
    expect(overridden.exitCode).not.toBe(0);
    expect(overridden.stderr).toContain("missing PORT_WEB");
    expect(overridden.stderr).not.toContain(FIXTURE_PORT_WEB);
  });

  test("under NODE_ENV=test the child does not load .env.local at all", async () => {
    // The asymmetry the fixture above depends on. If bun ever started loading
    // `.env.local` under NODE_ENV=test, `withEnvLocalLoaded` would stop being
    // the thing that makes the precedence run meaningful, and this fails first.
    const cwd = envCwd(`PORT_WEB=${FIXTURE_PORT_WEB}\n`);

    const { exitCode, stderr } = await runToExit(
      { NODE_ENV: "test", PORT_WEB: undefined, HOOK_BEARER_TOKEN: TOKEN },
      [],
      cwd,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("missing PORT_WEB");
    expect(stderr).not.toContain(FIXTURE_PORT_WEB);
  });

  test("names HOOK_BEARER_TOKEN when only that one is blank", async () => {
    const { exitCode, stderr } = await runToExit({ PORT_WEB: "0", HOOK_BEARER_TOKEN: "" });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("missing HOOK_BEARER_TOKEN");
    expect(stderr).not.toContain("missing PORT_WEB");
  });

  test("refuses a PORT_WEB that is not a port number", async () => {
    const { exitCode, stderr } = await runToExit({ PORT_WEB: "not-a-port", HOOK_BEARER_TOKEN: TOKEN });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("PORT_WEB must be a port number");
  });

  test("rejects an unknown argument instead of ignoring it", async () => {
    const { exitCode, stderr } = await runToExit(
      { PORT_WEB: "0", HOOK_BEARER_TOKEN: TOKEN },
      ["--verbose"],
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown argument --verbose");
  });
});
