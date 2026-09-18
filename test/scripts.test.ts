import { describe, expect, test } from "bun:test";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

describe("package scripts", () => {
  // No stub is left for this file to guard, and now none is left in the repo.
  // `hook-server` became real in the hook-counter slice and has its own suites
  // (`hook-server.test.ts`, `hook-server-cli.test.ts`); it must not be started
  // from here, because it does not exit. `report` became real in the report
  // slice and is driven by `test/report.test.ts` against fixtures — running it
  // with no arguments would read `results/`, which is gitignored runtime
  // output. `probe` became real in the probe slice: `probe-cli.test.ts` covers
  // its environment contract (it has to pass the variables explicitly) and
  // `probe.test.ts` drives it end to end against the fake gateway.
  //
  // The bite this comment predicted has now happened and been paid. The
  // `not implemented` assertion in `probe-cli.test.ts` was replaced, not
  // deleted: the contract underneath it — a command that cannot do its job
  // exits non-zero and says why — is asserted there against a gateway that is
  // not listening, and in `probe.test.ts` for a missing `ARCADE_MCP_URL`, an
  // unreachable hook counter and a revision the client cannot request.

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
