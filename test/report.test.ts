import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hitsForMethod, parseRun } from "../src/report.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** Relative on purpose: it is what a reader types, and what the CLI echoes back. */
const FIXTURE_DIR = "test/fixtures/runs";

/**
 * The profile fixtures issue #16 added, one directory per case.
 *
 * Separate from FIXTURE_DIR on purpose. Those runs predate the profile fields
 * and are pinned key-for-key by the suite below; keeping them that way is what
 * proves the renderer still reads a run file that carries none of this, and
 * says `not recorded` rather than `0`.
 *
 * These three were produced by the real pipeline — `bun run probe` against the
 * fake gateway and the real hook counter — and then trimmed to one case each,
 * so their shape is the probe's, not a second guess at it. `varied` is the one
 * exception, and it is edited rather than generated because the fake gateway
 * sends the whole catalogue on every hook call: its three hits carry different
 * slices, which is what a per-toolkit fan-out would look like.
 */
const PROFILE_DIRS = {
  identical: "test/fixtures/profile/identical",
  varied: "test/fixtures/profile/varied",
  paged: "test/fixtures/profile/paged",
} as const;

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

/** The rows of a table with the given class, as plain-text cells. */
function tableRows(html: string, className: string): string[][] {
  const table = new RegExp(`<table class="${className}">([\\s\\S]*?)</table>`).exec(html);
  if (table === null) throw new Error(`no ${className} table`);
  return [...table[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => stripTags(cell[1]!)),
  );
}

/** The `tools/list`-request banner, as plain text. */
function banner(html: string): string {
  const match = /<div class="callout[^"]*" id="tools-list-requests">([\s\S]*?)<\/div>/.exec(html);
  if (match === null) throw new Error("no tools/list banner in the report");
  return stripTags(match[0]);
}

/** Renders one directory of run files and returns the HTML. */
async function renderDir(dir: string, name: string) {
  const out = join(scratch, name);
  const result = await runReport(["--in", dir, "--out", out]);
  expect(result.exitCode, result.stderr).toBe(0);
  return { html: await Bun.file(out).text(), out, ...result };
}

/** Every run file in a directory, parsed. */
async function loadDir(dir: string) {
  const glob = new Bun.Glob("*.json");
  const files: string[] = [];
  for await (const name of glob.scan({ cwd: `${REPO_ROOT}${dir}` })) files.push(name);
  files.sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      run: parseRun(file, await Bun.file(`${REPO_ROOT}${dir}/${file}`).text()),
    })),
  );
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
    // Issue #25 criterion 5 rendered byte-identical repeats once, so "every
    // payload is in the document" is now a statement about distinct bodies:
    // each one appears in full exactly once, and every occurrence that is not
    // the first names the hit that carries it. The count of `<pre>` blocks
    // still pins it — it is just the distinct count now, not the hit count.
    const bodies = new Set<string>();
    let occurrences = 0;

    for (const file of await fixtureFiles()) {
      const run = await loadFixture(file);
      const section = sectionFor(html, file);
      for (const hit of run.hookHits) {
        const pretty = JSON.stringify(hit.payload, null, 2);
        expect(pretty).toContain("\n  "); // pretty-printed, not one line
        expect(html, `${file} payload`).toContain(escaped(pretty));
        expect(section).toContain(hit.receivedAt);
        bodies.add(JSON.stringify(hit.payload));
        occurrences += 1;
      }
    }

    expect(occurrences).toBeGreaterThan(0);
    expect(bodies.size).toBeLessThan(occurrences); // the fixtures do repeat
    expect(html.match(/<pre>/g)?.length ?? 0).toBe(bodies.size);
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

// ---------------------------------------------------------------------------
// Issue #16: the report shows payload shape, size, pages and latency
// ---------------------------------------------------------------------------

/** The toolkit and tool names one hook payload carried, as a sorted list. */
function toolSetOf(payload: unknown): string[] {
  const toolkits = (payload as { toolkits?: Record<string, { tools?: Record<string, unknown> }> })
    .toolkits;
  return Object.entries(toolkits ?? {})
    .flatMap(([toolkit, entry]) => Object.keys(entry.tools ?? {}).map((tool) => `${toolkit}:${tool}`))
    .sort();
}

/** The renderer escapes what it prints; a header value read back is escaped too. */
function escaped(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Milliseconds the way the renderer prints them, re-derived rather than imported. */
function ms(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Column index of a summary header, found by its label rather than by counting. */
function columnOf(html: string, label: string): number {
  const index = summaryTable(html)[0]!.findIndex((cell) => cell.includes(label));
  if (index < 0) throw new Error(`no summary column matching "${label}"`);
  return index;
}

function cell(html: string, revision: string, label: string): string {
  return summaryRow(html, revision)[columnOf(html, label)]!;
}

describe("profile fixtures", () => {
  // Second implementation of the shape `src/probe/run.ts` writes and
  // `src/hook-server/server.ts` records. If these drift from the real writers,
  // both slices pass their own tests while the report mis-renders real runs.
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
    "toolsListRequests",
    "cursorFollowed",
    "toolsListDurationMs",
    "protocolEra",
    "startedAt",
    "finishedAt",
  ].sort();

  const REQUEST_KEYS = [
    "id",
    "jsonRpcId",
    "method",
    "sentAt",
    "finishedAt",
    "durationMs",
    "status",
    "userIdHeader",
    "authorizationScheme",
    "responseObserved",
    "hookHitsAfter",
  ].sort();

  const HIT_KEYS = [
    "receivedAt",
    "headers",
    "toolkitCount",
    "toolCount",
    "versionCount",
    "bodyBytes",
    "handlingMs",
    "payload",
  ].sort();

  test("carry the fields the probe and the hook counter actually write", async () => {
    for (const dir of Object.values(PROFILE_DIRS)) {
      const loaded = await loadDir(dir);
      expect(loaded.length, dir).toBeGreaterThan(0);

      for (const { file } of loaded) {
        const raw = await Bun.file(`${REPO_ROOT}${dir}/${file}`).json();
        expect(Object.keys(raw).sort(), `${file} top-level keys`).toEqual(RUN_KEYS);

        for (const request of raw.requests) {
          // `cursor` is written only when the request followed one, so it is
          // the one key that may be absent.
          const keys = Object.keys(request).filter((key) => key !== "cursor");
          expect(keys.sort(), `${file} request keys`).toEqual(REQUEST_KEYS);
          if ("cursor" in request) expect(request.method).toBe("tools/list");
        }

        for (const hit of raw.hookHits) {
          expect(Object.keys(hit).sort(), `${file} hit keys`).toEqual(HIT_KEYS);
          // A fixture whose `bodyBytes` does not match its own payload would
          // let a renderer that invented the number look right.
          expect(hit.bodyBytes, `${file} bodyBytes vs payload`).toBe(
            Buffer.byteLength(JSON.stringify(hit.payload), "utf8"),
          );
        }

        const last = raw.requests.at(-1)?.hookHitsAfter ?? 0;
        expect(raw.hookHits.length, `${file} hookHits vs last hookHitsAfter`).toBe(last);
      }
    }
  });

  test("cover the three cases issue #16 asks for", async () => {
    const identical = await loadDir(PROFILE_DIRS.identical);
    // The set is the toolkit and tool names, not the whole payload: every
    // repetition carries its own generated `user_id`, so comparing bodies
    // would call two hits different for a reason that is not the tool set.
    const sets = new Set(
      identical.flatMap(({ run }) =>
        run.hookHits.map((hit) => toolSetOf(hit.payload).join(",")),
      ),
    );
    expect(sets.size, "every hit in the identical fixture carries one set").toBe(1);
    expect([...sets][0]).not.toBe("");

    const varied = await loadDir(PROFILE_DIRS.varied);
    const sizes = varied.flatMap(({ run }) => run.hookHits.map((hit) => hit.bodyBytes));
    expect(new Set(sizes).size, "the varied fixture's payload sizes differ").toBeGreaterThan(1);

    const paged = await loadDir(PROFILE_DIRS.paged);
    expect(paged.some(({ run }) => (run.toolsListRequests ?? 0) > 1)).toBe(true);
    // …and one that did not, so "more than one" is this run's fact and not the
    // directory's.
    expect(paged.some(({ run }) => run.toolsListRequests === 1)).toBe(true);
  });
});

describe("summary profile columns", () => {
  test("say every hit carried the same set, rather than leaving it to be inferred", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "profile-identical.html");
    const loaded = await loadDir(PROFILE_DIRS.identical);
    const hits = loaded.flatMap(({ run }) => run.hookHits);

    expect(cell(html, "2025-11-25", "tool set")).toBe(`identical on all ${hits.length} hits`);
    // The counts are still there, and they are the same number — which is
    // exactly the rendering the sentence above exists because it is not enough.
    expect(cell(html, "2025-11-25", "toolkits")).toBe("2");
    expect(cell(html, "2025-11-25", "tools per hook hit")).toBe("3");
  });

  test("report tools and toolkits as a range when the hits differ", async () => {
    const { html } = await renderDir(PROFILE_DIRS.varied, "profile-varied.html");
    const { run } = (await loadDir(PROFILE_DIRS.varied))[0]!;

    expect(cell(html, "2025-11-25", "toolkits")).toBe("1–2");
    expect(cell(html, "2025-11-25", "tools per hook hit")).toBe("1–3");
    expect(cell(html, "2025-11-25", "tool set")).toBe(
      `varies across ${run.hookHits.length} hits`,
    );
  });

  test("total bytes to the hook is the sum of the hits' bodyBytes", async () => {
    const { html } = await renderDir(PROFILE_DIRS.varied, "profile-bytes.html");
    const { run } = (await loadDir(PROFILE_DIRS.varied))[0]!;
    const total = run.hookHits.reduce((sum, hit) => sum + (hit.bodyBytes ?? 0), 0);

    expect(total).toBeGreaterThan(0);
    expect(cell(html, "2025-11-25", "bytes sent")).toBe(String(total));
  });

  test("the hook server's handling time and the client's wall clock are two numbers, never one", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "profile-latency.html");
    const loaded = await loadDir(PROFILE_DIRS.identical);

    const handling = loaded
      .flatMap(({ run }) => run.hookHits)
      .reduce((sum, hit) => sum + (hit.handlingMs ?? 0), 0);
    const client = loaded.reduce((sum, { run }) => sum + (run.toolsListDurationMs ?? 0), 0);

    expect(cell(html, "2025-11-25", "hook server")).toBe(ms(handling));
    expect(cell(html, "2025-11-25", "client-observed")).toBe(ms(client));

    // They measure different things — the hook counter's own received-to-
    // answered time (which excludes its JSONL append) and the round trip the
    // client waited on — so their sum is meaningless and must appear nowhere.
    expect(handling).not.toBe(client);
    expect(html).not.toContain(ms(handling + client));
    expect(html).toContain("never summed");
  });

  test("a run file without the profile fields reads `not recorded`, never 0", async () => {
    // The #5 fixtures predate every field this slice renders. A renderer that
    // defaulted them to 0 would report a hook that sent no bytes and cost no
    // time — a measurement, from a run that never made one.
    const { html } = await renderFixtures("profile-absent.html");

    for (const label of [
      "toolkits per hook hit",
      "tools per hook hit",
      "bytes sent",
      "tools/list requests issued",
      "hook server",
      "client-observed",
    ]) {
      expect(cell(html, "2025-11-25", label), label).toBe("not recorded");
    }
  });

  test("a partly-recorded revision says how many of its hits it could read", async () => {
    // One run with the profile fields, one without, in one directory: the sum
    // is over half the hits, and a bare total would hide that.
    const mixed = join(scratch, "mixed-in");
    const legacy = "20260918T120000Z-2025-11-25-1.json";
    const profiled = (await loadDir(PROFILE_DIRS.identical))[0]!.file;
    await Bun.write(
      join(mixed, legacy),
      await Bun.file(`${REPO_ROOT}${FIXTURE_DIR}/${legacy}`).text(),
    );
    await Bun.write(
      join(mixed, profiled),
      await Bun.file(`${REPO_ROOT}${PROFILE_DIRS.identical}/${profiled}`).text(),
    );

    const { html } = await renderDir(mixed, "profile-mixed.html");
    expect(cell(html, "2025-11-25", "bytes sent")).toContain("(3 of 6 hits)");
    expect(cell(html, "2025-11-25", "tools/list requests issued")).toContain("(1 of 2 runs)");
  });
});

describe("tools/list requests the client actually issued", () => {
  test("a paged run is announced at the top of the report, not left to be derived", async () => {
    const { html } = await renderDir(PROFILE_DIRS.paged, "profile-paged.html");
    const loaded = await loadDir(PROFILE_DIRS.paged);
    const paged = loaded.find(({ run }) => (run.toolsListRequests ?? 0) > 1)!;
    const single = loaded.find(({ run }) => run.toolsListRequests === 1)!;

    const text = banner(html);
    expect(text).toContain("1 of 2 runs issued more than one");
    expect(text).toContain(paged.file);
    expect(text).toContain(`${paged.run.toolsListRequests} tools/list requests`);
    expect(text).toContain("following a cursor");
    expect(text).not.toContain(single.file);

    // The banner comes before the summary table, so a reader cannot reach the
    // hit counts without having read what they are counts of.
    expect(html.indexOf('id="tools-list-requests"')).toBeLessThan(
      html.indexOf('<table id="summary">'),
    );

    // …and the same fact is inside the run it belongs to, not only at the top.
    expect(sectionFor(html, paged.file)).toContain(
      `This run issued ${paged.run.toolsListRequests} <code>tools/list</code> requests`,
    );
    expect(sectionFor(html, single.file)).not.toContain("This run issued");
  });

  test("the summary column separates requests from runs", async () => {
    const { html } = await renderDir(PROFILE_DIRS.paged, "profile-paged-summary.html");
    const loaded = await loadDir(PROFILE_DIRS.paged);
    const requests = loaded.reduce((sum, { run }) => sum + (run.toolsListRequests ?? 0), 0);

    // 3 requests over 2 runs is not the same measurement as 3 over 3, and the
    // per-run spread is what says which one this is.
    expect(cell(html, "2025-11-25", "tools/list requests issued")).toBe(
      `${requests} (1–2 per run) — paged in 1`,
    );
    expect(summaryRow(html, "2025-11-25").slice(2, 5)).toEqual(["2", "4", "3"]);
  });

  test("a run that never recorded the number says so instead of implying one", async () => {
    const { html } = await renderFixtures("profile-no-requests.html");
    expect(banner(html)).toContain("No run records how many");
    expect(banner(html)).toContain("the client may have paged");
  });

  test("every run issuing exactly one request is stated too", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "profile-single.html");
    expect(banner(html)).toContain("issued exactly one");
    expect(banner(html)).toContain("hook hits per request");
  });
});

describe("per-hit detail", () => {
  test("one row per hit with what it carried, what it cost and its headers", async () => {
    const { html } = await renderDir(PROFILE_DIRS.varied, "profile-hits.html");
    const { file, run } = (await loadDir(PROFILE_DIRS.varied))[0]!;
    const rows = tableRows(sectionFor(html, file), "hits");
    // Columns are found by their header, not counted, so adding one (issue #25
    // added `caused by`) cannot silently shift what this test is reading.
    const at = (label: string) => {
      const index = rows[0]!.findIndex((cell) => cell.includes(label));
      if (index < 0) throw new Error(`no hits column matching "${label}"`);
      return index;
    };

    expect(rows[0]!.join(" | ")).toContain("received at");
    expect(rows).toHaveLength(run.hookHits.length + 1);

    run.hookHits.forEach((hit, index) => {
      const cells = rows[index + 1]!;
      expect(cells[at("received at")]).toBe(hit.receivedAt);
      expect(cells[at("toolkits")]).toBe(String(hit.toolkitCount));
      expect(cells[at("tools")]).toBe(String(hit.toolCount));
      expect(cells[at("versions")]).toBe(String(hit.versionCount));
      expect(cells[at("bodyBytes")]).toBe(String(hit.bodyBytes));
      expect(cells[at("handling")]).toBe(ms(hit.handlingMs!));
      for (const [name, value] of Object.entries(hit.headers!)) {
        expect(cells[at("captured request headers")], `${name} on hit ${index + 1}`).toContain(
          `${name} : ${escaped(value)}`,
        );
      }
    });

    // The sizes differ hit to hit, so the column is reading each hit rather
    // than repeating one number.
    const sizes = rows.slice(1).map((cells) => cells[at("bodyBytes")]!);
    expect(new Set(sizes).size).toBeGreaterThan(1);
  });

  test("the credential header renders as the counter's descriptor, on every hit", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "profile-headers.html");
    const loaded = await loadDir(PROFILE_DIRS.identical);
    const descriptors = loaded.flatMap(({ run }) =>
      run.hookHits.map((hit) => hit.headers!["authorization"]!),
    );

    expect(descriptors.length).toBeGreaterThan(1);
    for (const descriptor of descriptors) {
      // Shape, not secret: scheme in the clear, then length and digest.
      expect(descriptor).toMatch(/^Bearer <redacted len=\d+ sha256=[0-9a-f]{8}>$/);
    }
    // The same descriptor on every hit is a finding — the same value arrived
    // every time — so it is printed in full each time, never collapsed into a
    // "same as above" that would destroy it.
    const rendered = html.split("Bearer &lt;redacted").length - 1;
    expect(rendered).toBe(descriptors.length);
  });

  test("the raw payload is still pretty-printed JSON under the table", async () => {
    const { html } = await renderDir(PROFILE_DIRS.paged, "profile-payloads.html");
    const bodies = new Set<string>();
    let occurrences = 0;

    for (const { run } of await loadDir(PROFILE_DIRS.paged)) {
      for (const hit of run.hookHits) {
        const pretty = JSON.stringify(hit.payload, null, 2);
        expect(pretty).toContain("\n  ");
        expect(html).toContain(escaped(pretty));
        bodies.add(JSON.stringify(hit.payload));
        occurrences += 1;
      }
    }

    expect(occurrences).toBeGreaterThan(0);
    // The hit table still adds no `<pre>` of its own; since issue #25 the count
    // is one per *distinct* payload, byte-identical repeats having become a
    // digest and a link.
    expect(html.match(/<pre>/g)?.length ?? 0).toBe(bodies.size);
  });

  test("the request timeline carries the client-observed round trip per request", async () => {
    const { html } = await renderDir(PROFILE_DIRS.paged, "profile-timeline.html");
    const paged = (await loadDir(PROFILE_DIRS.paged)).find(
      ({ run }) => (run.toolsListRequests ?? 0) > 1,
    )!;
    const rows = tableRows(sectionFor(html, paged.file), "timeline");

    expect(rows).toHaveLength(paged.run.requests.length + 1);
    paged.run.requests.forEach((request, index) => {
      expect(rows[index + 1]![5]).toBe(ms(request.durationMs!));
    });
  });
});

describe("the profile report is still self-contained", () => {
  test("nothing is fetched off-file and every link is a fragment", async () => {
    const { html } = await renderDir(PROFILE_DIRS.paged, "profile-self-contained.html");

    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b[^>]*\bhref\s*=/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/<(iframe|object|embed)\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\s*\(/i);

    const hrefs = [...html.matchAll(/\bhref\s*=\s*"([^"]*)"/g)].map((m) => m[1]!);
    // The banner links to the paged run, so there is more than the run index.
    expect(hrefs.length).toBeGreaterThan(1);
    for (const href of hrefs) expect(href).toStartWith("#");
  });

  test("an empty directory still exits non-zero with `no run files in <dir>`", async () => {
    const emptyDir = join(scratch, "empty-profile-in");
    await Bun.write(join(emptyDir, ".keep"), "");
    const { exitCode, stderr } = await runReport([
      "--in",
      emptyDir,
      "--out",
      join(scratch, "x.html"),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`no run files in ${emptyDir}`);
  });
});

// ---------------------------------------------------------------------------
// Issue #25: hits are attributed to a method, and payloads are navigable
// ---------------------------------------------------------------------------

/**
 * Fixtures this slice added. Neither is a variant of the #16 set: `attribution`
 * carries a run whose last hit falls past the final `hookHitsAfter` snapshot,
 * and `dedupe/differs` carries two payloads that agree on every number the
 * report prints and still differ.
 */
const ISSUE_25_DIRS = {
  attribution: "test/fixtures/attribution",
  differs: "test/fixtures/dedupe/differs",
} as const;

/**
 * Which method caused each hit, worked out a second time here.
 *
 * `hookHitsAfter` is cumulative, so hit `i` belongs to the first request whose
 * snapshot is greater than `i`, and to nothing at all when no request's is.
 * Deriving it independently is the point — importing the renderer's own
 * `attributeHits` would only assert that it equals itself.
 */
function expectedAttribution(run: {
  requests: { method: string; hookHitsAfter: number }[];
  hookHits: unknown[];
}): (string | null)[] {
  return run.hookHits.map((_hit, index) => {
    const request = run.requests.find((candidate) => candidate.hookHitsAfter > index);
    return request?.method ?? null;
  });
}

/** The `caused by` cells of a run's hit table, in order. */
function causedBy(html: string, file: string): string[] {
  const rows = tableRows(sectionFor(html, file), "hits");
  const column = rows[0]!.findIndex((header) => header.includes("caused by"));
  expect(column).toBeGreaterThan(-1);
  return rows.slice(1).map((cells) => cells[column]!);
}

/** The `hook hits by method` value from a run's meta list. */
function methodSplitOf(html: string, file: string): string {
  const match = /<dt>hook hits by method<\/dt><dd>([^<]*)<\/dd>/.exec(sectionFor(html, file));
  if (match === null) throw new Error(`no method split in ${file}`);
  return match[1]!;
}

/** Every `<details class="payload…">` block in a run section, as raw HTML. */
function payloadBlocks(html: string, file: string): string[] {
  return [
    ...sectionFor(html, file).matchAll(/<details class="payload[^"]*"[\s\S]*?<\/details>/g),
  ].map((match) => match[0]);
}

function summaryLineOf(block: string): string {
  const match = /<summary>([\s\S]*?)<\/summary>/.exec(block);
  if (match === null) throw new Error("no summary in payload block");
  return stripTags(match[1]!);
}

describe("every hit says which method caused it", () => {
  test("the hit table names the method, derived from the hookHitsAfter snapshots", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "attribution.html");

    for (const { file, run } of await loadDir(ISSUE_25_DIRS.attribution)) {
      const expected = expectedAttribution(run).map((method) => method ?? "not attributed");
      expect(causedBy(html, file), file).toEqual(expected);
    }

    // …and the fixture is discriminating: it contains both methods, so a
    // renderer that printed one constant would not pass.
    const first = (await loadDir(ISSUE_25_DIRS.attribution))[0]!;
    expect(new Set(causedBy(html, first.file)).size).toBeGreaterThan(1);
  });

  test("a hit no request accounts for reads `not attributed`, never the first method", async () => {
    const loaded = await loadDir(ISSUE_25_DIRS.attribution);
    const orphaned = loaded.find(
      ({ run }) => run.hookHits.length > (run.requests.at(-1)?.hookHitsAfter ?? 0),
    );
    expect(orphaned, "a fixture with a hit past the last snapshot").toBeDefined();

    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "attribution-orphan.html");
    const cells = causedBy(html, orphaned!.file);
    const last = cells.at(-1)!;

    expect(last).toBe("not attributed");
    // The two readings this criterion exists to rule out: folding the hit into
    // the first method, and silently giving it the nearest one.
    expect(last).not.toBe("initialize");
    expect(last).not.toBe("tools/list");
    // The hits that *can* be attributed still are, so `not attributed` is this
    // hit's answer and not a blanket fallback for the run.
    expect(cells.slice(0, -1)).toEqual(
      expectedAttribution(orphaned!.run).slice(0, -1).map((method) => method!),
    );

    // The payload block says it too, so a reader who scrolled past the table
    // still cannot mistake the hit for an attributed one.
    expect(summaryLineOf(payloadBlocks(html, orphaned!.file).at(-1)!)).toContain(
      "not attributed",
    );
  });

  test("the per-method split is stated inside each run, not only in the summary", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "attribution-split.html");
    const loaded = await loadDir(ISSUE_25_DIRS.attribution);
    const clean = loaded[0]!;
    const orphaned = loaded[1]!;

    expect(methodSplitOf(html, clean.file)).toBe("initialize 1 · tools/list 2");
    expect(methodSplitOf(html, orphaned.file)).toBe(
      "initialize 1 · tools/list 2 · not attributed 1",
    );

    // Counting the rows of that run's hit table gives the same numbers, which
    // is the check a reader would do.
    const cells = causedBy(html, clean.file);
    expect(cells.filter((method) => method === "initialize")).toHaveLength(1);
    expect(cells.filter((method) => method === "tools/list")).toHaveLength(2);
  });

  test("a method that was issued and caused no hits keeps its zero", async () => {
    // The #16 fixture snapshots 0 after `initialize`: the request went out and
    // the hook did not fire. Dropping the entry would read like the handshake
    // never happened, which is a different result.
    const { html } = await renderDir(PROFILE_DIRS.identical, "attribution-zero.html");
    const { file, run } = (await loadDir(PROFILE_DIRS.identical))[0]!;

    expect(run.requests.find((request) => request.method === "initialize")!.hookHitsAfter).toBe(0);
    expect(methodSplitOf(html, file)).toBe("initialize 0 · tools/list 3");
  });
});

describe("raw payloads are collapsed and navigable", () => {
  test("every payload sits in a closed `<details>` whose summary carries size, toolkits and tools", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "collapsed.html");
    const { file, run } = (await loadDir(PROFILE_DIRS.identical))[0]!;
    const blocks = payloadBlocks(html, file);

    expect(blocks).toHaveLength(run.hookHits.length);
    blocks.forEach((block, index) => {
      const hit = run.hookHits[index]!;
      const line = summaryLineOf(block);
      expect(line).toContain(`${hit.bodyBytes} B`);
      expect(line).toContain(`${hit.toolkitCount} toolkits`);
      expect(line).toContain(`${hit.toolCount} tools`);
    });

    // Collapsed by default: no `open` attribute anywhere in the document.
    expect(html).not.toMatch(/<details[^>]*\bopen\b/i);
    // Every `<pre>` is inside one, so nothing is left expanded by accident.
    expect(html.match(/<pre>/g)?.length ?? 0).toBe(
      (html.match(/<\/summary>\n<pre>/g) ?? []).length,
    );
  });

  test("expanding needs no script and nothing off-file", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "collapsed-offline.html");

    expect(html).toContain("<details");
    expect(html).toContain("<summary>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i); // no onclick/ontoggle handlers
    expect(html).not.toMatch(/<link\b[^>]*\bhref\s*=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\s*\(/i);
    for (const href of [...html.matchAll(/\bhref\s*=\s*"([^"]*)"/g)].map((m) => m[1]!)) {
      expect(href).toStartWith("#");
    }
  });

  test("a run file that measured none of it says `not recorded` in the summary line, not 0", async () => {
    const { html } = await renderFixtures("collapsed-absent.html");
    const file = (await fixtureFiles()).find((name) => name.endsWith("2025-11-25-1.json"))!;
    const line = summaryLineOf(payloadBlocks(html, file)[0]!);

    expect(line).toContain("size not recorded");
    expect(line).toContain("toolkits not recorded");
    expect(line).toContain("tools not recorded");
    expect(line).not.toContain("0 B");
    expect(line).not.toContain("0 toolkits");
  });
});

describe("byte-identical payloads are rendered once", () => {
  test("a repeat shows its digest and links the hit that carries the body", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "dedupe-identical.html");
    const { file, run } = (await loadDir(PROFILE_DIRS.identical))[0]!;
    const blocks = payloadBlocks(html, file);

    // The fixture's three hits carry one payload, so two of them are repeats.
    expect(new Set(run.hookHits.map((hit) => JSON.stringify(hit.payload))).size).toBe(1);
    expect(blocks[0]).toContain("<pre>");
    for (const block of blocks.slice(1)) {
      expect(block).not.toContain("<pre>");
      expect(block).toContain("Byte-identical to");
      expect(block).toContain(`href="#${file}--payload-1"`);
      expect(summaryLineOf(block)).toContain(`identical to hit 1 of ${file}`);
    }
  });

  test("two payloads that agree on every printed number and still differ are both rendered in full", async () => {
    const { file, run } = (await loadDir(ISSUE_25_DIRS.differs))[0]!;
    const [first, , third] = run.hookHits;

    // The trap: same size, same toolkit count, same tool count. A renderer that
    // collapsed on the summary numbers — or on "the hits look alike" — would
    // hide a payload that differs by one tool, in a report whose whole subject
    // is a hook whose behaviour is invisible unless measured.
    expect(third!.bodyBytes).toBe(first!.bodyBytes);
    expect(third!.toolkitCount).toBe(first!.toolkitCount);
    expect(third!.toolCount).toBe(first!.toolCount);
    expect(JSON.stringify(third!.payload)).not.toBe(JSON.stringify(first!.payload));

    const { html } = await renderDir(ISSUE_25_DIRS.differs, "dedupe-differs.html");
    const blocks = payloadBlocks(html, file);

    expect(blocks[0]).toContain(escaped(JSON.stringify(first!.payload, null, 2)));
    expect(blocks[1]).toContain("Byte-identical to"); // the real duplicate did collapse
    expect(blocks[2]).not.toContain("Byte-identical to");
    expect(blocks[2]).toContain(escaped(JSON.stringify(third!.payload, null, 2)));
    expect(html.match(/<pre>/g)?.length ?? 0).toBe(2);

    // The one tool that differs is on the page, which is the thing collapsing
    // would have destroyed.
    expect(html).toContain("SendMessage");
    expect(html).toContain("PostMessage");
  });

  test("the digest is the sha-256 of the payload bytes, reproducible from the run file", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.differs, "dedupe-digest.html");
    const { run } = (await loadDir(ISSUE_25_DIRS.differs))[0]!;

    for (const hit of run.hookHits) {
      const digest = createHash("sha256").update(JSON.stringify(hit.payload)).digest("hex");
      expect(html).toContain(`sha256 ${digest}`);
    }
    // Two distinct payloads, two distinct digests: the digest is of the body,
    // not of the run or the hit index.
    const digests = new Set(
      run.hookHits.map((hit) =>
        createHash("sha256").update(JSON.stringify(hit.payload)).digest("hex"),
      ),
    );
    expect(digests.size).toBe(2);
  });

  test("the report states whether anything was collapsed, either way", async () => {
    const { html: withRepeats } = await renderDir(PROFILE_DIRS.identical, "dedupe-note.html");
    expect(withRepeats).toContain("byte-identical repeats");
    expect(withRepeats).toContain("is rendered in full");

    const { html: without } = await renderDir(PROFILE_DIRS.varied, "dedupe-note-none.html");
    expect(without).toContain("No two of the 3 raw payloads");
    expect(without).not.toContain("byte-identical repeats");
  });
});

describe("headers stay per hit, whatever happened to the payloads", () => {
  test("a collapsed payload does not collapse its hit's headers", async () => {
    // Issue #16 renders every hit's headers so the credential descriptor is
    // shown present on *every* hit; issue #25 collapses payload bodies only.
    const { html } = await renderDir(ISSUE_25_DIRS.differs, "dedupe-headers.html");
    const { file, run } = (await loadDir(ISSUE_25_DIRS.differs))[0]!;
    const rows = tableRows(sectionFor(html, file), "hits");
    const column = rows[0]!.findIndex((header) => header.includes("captured request headers"));

    expect(rows).toHaveLength(run.hookHits.length + 1);
    run.hookHits.forEach((hit, index) => {
      for (const [name, value] of Object.entries(hit.headers!)) {
        expect(rows[index + 1]![column], `${name} on hit ${index + 1}`).toContain(
          `${name} : ${escaped(value)}`,
        );
      }
    });

    // Two of the three payloads collapsed into one; all three descriptors are
    // still printed in full, never folded into a "same as above".
    expect(html.match(/<pre>/g)?.length ?? 0).toBe(2);
    expect(html.split("Bearer &lt;redacted").length - 1).toBe(run.hookHits.length);
    expect(html).not.toContain("same as above");
  });
});
