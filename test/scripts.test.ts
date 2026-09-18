import { describe, expect, test } from "bun:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

describe("package scripts", () => {
  // No stub is left for this file to guard. `hook-server` became real in the
  // hook-counter slice and has its own suites (`hook-server.test.ts`,
  // `hook-server-cli.test.ts`); it must not be started from here, because it
  // does not exit. `report` became real in the report slice and is driven by
  // `test/report.test.ts` against fixtures — running it with no arguments
  // would read `results/`, which is gitignored runtime output. The probe is
  // still a stub, and `probe-cli.test.ts` covers it there because it has to
  // pass the environment explicitly.
  //
  // Expect this to bite once more. `probe-cli.test.ts` asserts the probe still
  // prints `not implemented`, and slice #4 makes the probe real — which
  // falsifies that assertion exactly the way the hook-counter and report slices
  // falsified each other's entries in the stub list that used to live here.
  // When it does, the resolution is to delete the assertion, not to keep it:
  // it became false because the slice succeeded.

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
