import { describe, expect, test } from "bun:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

async function runScript(name: string) {
  const child = Bun.spawn(["bun", "run", name], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stderr, exitCode };
}

describe("package scripts", () => {
  // The probe has its own suite; these two are stubs until their slices land,
  // and the contract for now is only that they exist and fail loudly.
  for (const name of ["hook-server", "report"]) {
    test(`bun run ${name} exits 1 with "not implemented"`, async () => {
      const { exitCode, stderr } = await runScript(name);
      expect(stderr).toContain("not implemented");
      expect(exitCode).toBe(1);
    });
  }

  test("package.json declares probe, hook-server, report and test", async () => {
    const pkg = await Bun.file(`${REPO_ROOT}package.json`).json();
    expect(Object.keys(pkg.scripts).sort()).toEqual([
      "hook-server",
      "probe",
      "report",
      "test",
      "typecheck",
    ]);
  });
});
