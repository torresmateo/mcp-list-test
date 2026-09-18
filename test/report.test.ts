import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hitsForMethod, parseRun } from "../src/report.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Relative on purpose: it is what a reader types, and what the CLI echoes back. */
const FIXTURE_DIR = "test/fixtures/runs";

/** `results/` is runtime output and gitignored — tests never read or write it. */
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "mcp-list-test-report-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Runs the real CLI the README documents. No stubs, no in-process shortcuts. */
async function runReport(args: string[]) {
  const child = Bun.spawn(["bun", "run", "report", ...args], {
    cwd: REPO_ROOT,
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

/** Renders the fixtures to a fresh file in the scratch dir and returns the HTML. */
async function renderFixtures(name: string) {
  const out = join(scratch, name);
  const result = await runReport(["--in", FIXTURE_DIR, "--out", out]);
  // `bun run` echoes the command it spawns on stderr, so the contract asserted
  // here is the exit code, not an empty stderr.
  expect(result.exitCode).toBe(0);
  return { html: await Bun.file(out).text(), out, ...result };
}

function stripTags(html: string): string {
  return html.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim();
}

/** The summary table as rows of plain-text cells, header row first. */
function summaryTable(html: string): string[][] {
  const table = /<table id="summary">([\s\S]*?)<\/table>/.exec(html);
  if (table === null) throw new Error("no summary table in the report");
  return [...table[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) =>
      stripTags(cell[1]!),
    ),
  );
}

function summaryRow(html: string, revision: string): string[] {
  const row = summaryTable(html).find((cells) => cells[0] === revision);
  if (row === undefined) throw new Error(`no summary row for ${revision}`);
  return row;
}

/** The `<section id="...">…</section>` block for one run file. */
function sectionFor(html: string, file: string): string {
  const start = html.indexOf(`<section class="run" id="${file}">`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

async function fixtureFiles(): Promise<string[]> {
  const glob = new Bun.Glob("*.json");
  const names: string[] = [];
  for await (const name of glob.scan({ cwd: `${REPO_ROOT}${FIXTURE_DIR}` })) names.push(name);
  return names.sort();
}

async function loadFixture(file: string) {
  return parseRun(file, await Bun.file(`${REPO_ROOT}${FIXTURE_DIR}/${file}`).text());
}

describe("run fixtures", () => {
  // These fixtures are a second implementation of the run-JSON schema that the
  // probe slice produces. If they drift, both slices pass their own tests and
  // the report mis-renders real runs, so pin them to DESIGN.md Contracts ->
  // Run JSON key for key.
  const RUN_KEYS = [
    "schema",
    "revisionRequested",
    "revisionNegotiated",
    "status",
    "userId",
    "hookPublicUrl",
    "requests",
    "hookHits",
    "toolsListed",
    "gmailToolsListed",
    "error",
  ].sort();

  test("carry exactly the fields DESIGN.md Contracts -> Run JSON specifies", async () => {
    const files = await fixtureFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);

    for (const file of files) {
      const raw = await Bun.file(`${REPO_ROOT}${FIXTURE_DIR}/${file}`).json();
      expect(Object.keys(raw).sort(), `${file} top-level keys`).toEqual(RUN_KEYS);
      expect(raw.schema, `${file} schema`).toBe(1);
      for (const request of raw.requests) {
        expect(Object.keys(request).sort()).toEqual([
          "hookHitsAfter",
          "id",
          "method",
          "sentAt",
        ]);
      }
      for (const hit of raw.hookHits) {
        expect(Object.keys(hit).sort()).toEqual(["payload", "receivedAt"]);
      }
      // `hookHitsAfter` is cumulative for the run's user id, so the last
      // snapshot is how many hits the counter held: a fixture where the two
      // disagree is describing a run the hook server could not have produced.
      const last = raw.requests.at(-1)?.hookHitsAfter ?? 0;
      expect(raw.hookHits.length, `${file} hookHits vs last hookHitsAfter`).toBe(last);
    }
  });

  test("cover both readings of revisionNegotiated", async () => {
    const runs = await Promise.all((await fixtureFiles()).map(loadFixture));
    expect(runs.some((run) => run.revisionNegotiated === null)).toBe(true);
    expect(runs.some((run) => typeof run.revisionNegotiated === "string")).toBe(true);
    // `error` is a string exactly when the status is not ok.
    for (const run of runs) {
      if (run.status === "ok") expect(run.error).toBeNull();
      else expect(typeof run.error).toBe("string");
    }
  });

  test("cover both revisions and all three statuses", async () => {
    const runs = await Promise.all((await fixtureFiles()).map(loadFixture));
    const statuses = runs.map((run) => run.status);
    expect(statuses).toContain("ok");
    expect(statuses).toContain("version-mismatch");
    expect(statuses).toContain("error");

    const ok2025 = runs.filter(
      (run) => run.revisionRequested === "2025-11-25" && run.status === "ok",
    );
    expect(ok2025.map((run) => hitsForMethod(run, "tools/list")).sort()).toEqual([1, 3]);
    expect(
      runs.filter((run) => run.revisionRequested === "2026-07-28" && run.status === "ok").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("include a run where the hookHitsAfter difference and the raw value disagree", async () => {
    const runs = await Promise.all((await fixtureFiles()).map(loadFixture));
    const discriminating = runs.filter((run) => {
      const list = run.requests.find((request) => request.method === "tools/list");
      if (list === undefined) return false;
      return hitsForMethod(run, "tools/list") !== list.hookHitsAfter;
    });
    // Without one of these, "hits = difference" and "hits = raw cumulative
    // value" produce identical tables and the wrong formula passes.
    expect(discriminating.length).toBeGreaterThan(0);
  });
});

describe("bun run report", () => {
  test("exits 0 and writes the HTML file it names on stdout", async () => {
    const { stdout, out } = await renderFixtures("ok.html");
    expect(stdout).toContain(out);
    expect(stdout).toContain(FIXTURE_DIR);
    expect(await Bun.file(out).text()).toStartWith("<!doctype html>");
  });

  test("the generated HTML is self-contained: nothing is fetched off-file", async () => {
    const { html } = await renderFixtures("self-contained.html");

    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b[^>]*\bhref\s*=/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/<(iframe|object|embed)\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\s*\(/i);

    const hrefs = [...html.matchAll(/\bhref\s*=\s*"([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(0); // the run index links somewhere
    for (const href of hrefs) expect(href).toStartWith("#");
  });

  test("summary columns are the ones DESIGN.md -> Report names", async () => {
    const { html } = await renderFixtures("columns.html");
    const header = summaryTable(html)[0]!.join(" | ");
    for (const label of [
      "revision",
      "repetitions",
      "min",
      "max",
      "mean",
      "initialize",
      "version- mismatch",
      "error",
      "Gmail tools listed",
    ]) {
      expect(header).toContain(label);
    }
  });

  test("2025-11-25 reports min 1, max 3, mean 2 over its two ok runs", async () => {
    const { html } = await renderFixtures("summary-2025.html");
    const [revision, repetitions, min, max, mean, initialize, mismatch, errors, gmail] =
      summaryRow(html, "2025-11-25");

    expect(revision).toBe("2025-11-25");
    expect(repetitions).toBe("4"); // two ok runs, one version-mismatch, one error
    expect(min).toBe("1");
    expect(max).toBe("3");
    expect(mean).toBe("2");
    expect(initialize).toBe("2"); // 0 + 2 across the ok runs
    expect(mismatch).toBe("1");
    expect(errors).toBe("1");
    expect(gmail).toBe("0");
  });

  test("2026-07-28 reports its single ok run and counts the errored one", async () => {
    const { html } = await renderFixtures("summary-2026.html");
    const [, repetitions, min, max, mean, initialize, mismatch, errors] = summaryRow(
      html,
      "2026-07-28",
    );

    expect(repetitions).toBe("2");
    expect(min).toBe("2");
    expect(max).toBe("2");
    expect(mean).toBe("2");
    expect(initialize).toBe("1");
    expect(mismatch).toBe("0");
    expect(errors).toBe("1");
  });

  test("hits per method are the difference between snapshots, not the raw value", async () => {
    const { html } = await renderFixtures("difference.html");
    // This run snapshots hookHitsAfter 2 after initialize and 3 after
    // tools/list: the raw value says 3, the difference says 1.
    const section = sectionFor(html, "20260918T120500Z-2025-11-25-2.json");
    const rows = [...section.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => stripTags(cell[1]!)),
    );
    const list = rows.find((cells) => cells[1] === "tools/list");
    expect(list).toBeDefined();
    expect(list![3]).toBe("3"); // hookHitsAfter, cumulative
    expect(list![4]).toBe("1"); // hits attributed to this request

    // …and the summary took the difference: raw values would read min 3 max 3.
    expect(summaryRow(html, "2025-11-25").slice(2, 5)).toEqual(["1", "3", "2"]);
  });

  test("runs that are not ok stay out of min/max/mean", async () => {
    const { html } = await renderFixtures("excluded.html");

    // Neither excluded run is a harmless zero: including the version-mismatch
    // would move 2025-11-25's max from 3 to 7, and including the errored
    // 2026-07-28 run would move that revision's max from 2 to 8.
    const mismatched = await loadFixture("20260918T121000Z-2025-11-25-3.json");
    expect(hitsForMethod(mismatched, "tools/list")).toBe(7);
    const errored = await loadFixture("20260918T124000Z-2026-07-28-2.json");
    expect(hitsForMethod(errored, "tools/list")).toBe(8);

    expect(summaryRow(html, "2025-11-25").slice(2, 5)).toEqual(["1", "3", "2"]);
    expect(summaryRow(html, "2026-07-28").slice(2, 5)).toEqual(["2", "2", "2"]);
  });

  test("a run that negotiated nothing renders an em dash, not a blank or a crash", async () => {
    const { html } = await renderFixtures("negotiated-null.html");
    // This run died before `initialize` returned, so `revisionNegotiated` is
    // JSON null (the ruling recorded on issue #5) and there is nothing to show.
    const section = sectionFor(html, "20260918T121500Z-2025-11-25-4.json");
    expect(section).toContain("<dt>revision negotiated</dt><dd>\u2014</dd>");
    expect(section).toContain("initialize failed: fetch failed (ECONNRESET)");
    expect(section).toContain("No hook hits recorded for this run.");

    // The run it is grouped with still negotiated a revision, so the em dash
    // is this run's, not a blanket fallback.
    const ok = sectionFor(html, "20260918T120000Z-2025-11-25-1.json");
    expect(ok).toContain("<dt>revision negotiated</dt><dd>2025-11-25</dd>");
  });

  test("every run gets a section whose id is its filename", async () => {
    const { html } = await renderFixtures("sections.html");
    for (const file of await fixtureFiles()) {
      expect(html).toContain(`<section class="run" id="${file}">`);
      expect(sectionFor(html, file)).toContain(file);
    }
  });

  test("every hookHits[*].payload is rendered as pretty-printed JSON", async () => {
    const { html } = await renderFixtures("payloads.html");
    let rendered = 0;

    for (const file of await fixtureFiles()) {
      const run = await loadFixture(file);
      const section = sectionFor(html, file);
      for (const hit of run.hookHits) {
        const pretty = JSON.stringify(hit.payload, null, 2);
        expect(pretty).toContain("\n  "); // pretty-printed, not one line
        const escaped = pretty
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
        expect(section, `${file} payload`).toContain(escaped);
        expect(section).toContain(hit.receivedAt);
        rendered += 1;
      }
    }

    expect(rendered).toBeGreaterThan(0);
    expect(html.match(/<pre>/g)?.length ?? 0).toBe(rendered);
  });

  test("an empty input directory exits non-zero with `no run files in <dir>`", async () => {
    const emptyDir = join(scratch, "empty-in");
    await Bun.write(join(emptyDir, ".keep"), "");
    const { exitCode, stderr } = await runReport(["--in", emptyDir, "--out", join(scratch, "x.html")]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`no run files in ${emptyDir}`);
  });

  test("a missing input directory says so too, still naming the directory", async () => {
    const absent = join(scratch, "not-here");
    const { exitCode, stderr } = await runReport(["--in", absent, "--out", join(scratch, "x.html")]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`no run files in ${absent}`);
  });

  test("a run file that is not the DESIGN.md schema fails loudly, naming the file", async () => {
    const badDir = join(scratch, "bad-in");
    await Bun.write(join(badDir, "broken.json"), JSON.stringify({ schema: 1, status: "ok" }));
    const { exitCode, stderr } = await runReport(["--in", badDir, "--out", join(scratch, "x.html")]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("broken.json");
  });

  test("an unknown flag exits non-zero instead of silently rendering defaults", async () => {
    const { exitCode, stderr } = await runReport(["--nope"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown argument --nope");
  });

  test("creates the output directory when it does not exist", async () => {
    const out = join(scratch, "nested", "deeper", "report.html");
    const { exitCode } = await runReport(["--in", FIXTURE_DIR, "--out", out]);
    expect(exitCode).toBe(0);
    expect(await Bun.file(out).exists()).toBe(true);
  });
});
