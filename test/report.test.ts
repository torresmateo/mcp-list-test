import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hitsForMethod, parseRun } from "../src/report.ts";
import {
  TOOLS_LIST_RESULT,
  sharedPayloads,
  smallPayload,
  writeShape,
} from "./fixtures/body-kinds.ts";
import {
  CATALOGUE_BODY_BYTES,
  CATALOGUE_STORED_CHARS,
  CATALOGUE_TOOLS,
  CATALOGUE_TOOLKITS,
  SMALL_BODY_BYTES,
  writeRealShapeRuns,
} from "./fixtures/real-shape.ts";

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

/**
 * One run's wire timeline: the header labels, and one entry per event row with
 * the detail block that follows it.
 *
 * Issue #25 replaced the separate request-timeline and hook-hit tables with a
 * single ordered table, so the tests that used to read those two read this one.
 * Columns are looked up by label rather than counted.
 */
function wireTimeline(html: string, file: string) {
  const section = sectionFor(html, file);
  const table = /<table class="wire"[^>]*>([\s\S]*?)<\/table>/.exec(section);
  if (table === null) throw new Error(`no wire table in ${file}`);
  const header = [...table[1]!.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    stripTags(m[1]!),
  );
  const rows = table[1]!.split('<tr class="event')
    .slice(1)
    .map((chunk) => {
      const side = /^ ([a-z]+)">/.exec(chunk)?.[1] ?? "";
      const [rowHtml, detailHtml] = chunk.split('<tr class="detail">');
      return {
        side,
        cells: [...rowHtml!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
          stripTags(m[1]!),
        ),
        detail: detailHtml ?? "",
      };
    });
  const column = (label: string): number => {
    // Exact match first: "what" contains "at", and a substring search would
    // quietly hand back the wrong column.
    const exact = header.indexOf(label);
    const index = exact >= 0 ? exact : header.findIndex((cell) => cell.includes(label));
    if (index < 0) throw new Error(`no wire column matching "${label}"`);
    return index;
  };
  const cellAt = (row: number, label: string): string => rows[row]!.cells[column(label)]!;
  return { header, rows, column, cellAt };
}

/** The `hook hits by method` value from a run's meta list. */
function methodSplitOf(html: string, file: string): string {
  const match = /<dt>hook hits by method<\/dt><dd>([^<]*)<\/dd>/.exec(sectionFor(html, file));
  if (match === null) throw new Error(`no method split in ${file}`);
  return match[1]!;
}

/** The `<summary>` of a detail block, as plain text. */
function summaryLineOf(block: string): string {
  const match = /<summary>([\s\S]*?)<\/summary>/.exec(block);
  if (match === null) throw new Error("no summary in detail block");
  return stripTags(match[1]!);
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
  // The minimum schema-1 run file: the keys DESIGN.md Contracts -> Run JSON
  // specified before any profile or result field was added. Pinned key for key
  // because a renderer that only ever saw a modern run file would be free to
  // assume fields that half the evidence does not carry.
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

  test("carry exactly the original schema-1 fields, and none of the later ones", async () => {
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
    const file = "20260918T120500Z-2025-11-25-2.json";
    const { rows, cellAt } = wireTimeline(html, file);

    const listRow = rows.findIndex(
      (row) => row.side === "client" && row.cells.includes("tools/list"),
    );
    expect(listRow).toBeGreaterThan(-1);
    // The cumulative snapshot is still stated, now in the request's own detail.
    expect(rows[listRow]!.detail).toContain(
      "<dt>hookHitsAfter (cumulative)</dt><dd>3</dd>",
    );
    // …and exactly one hook hit is attributed to it, not three.
    const attributed = rows.filter(
      (row) => row.side === "hook" && row.cells.includes("tools/list"),
    );
    expect(attributed).toHaveLength(1);
    expect(methodSplitOf(html, file)).toBe("initialize 2 · tools/list 1");
    // Cumulative hook hits still grow to 3 by the last hit row.
    expect(cellAt(rows.length - 1, "hook hits")).toBe("3");

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
    // It sent `initialize` and got nothing back, so its wire timeline has the
    // one request row and no hook rows at all.
    const timeline = wireTimeline(html, "20260918T121500Z-2025-11-25-4.json");
    expect(timeline.rows).toHaveLength(1);
    expect(timeline.rows[0]!.side).toBe("client");
    expect(timeline.rows.filter((row) => row.side === "hook")).toHaveLength(0);

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
    expect(html.match(/<pre id=/g)?.length ?? 0).toBe(bodies.size);
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

/** The inverse of {@link escaped}, for reading an embedded body back. */
function unescaped(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
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
  // Second implementation of the shape `src/probe/run.ts` wrote **as of #16**,
  // and of what `src/hook-server/server.ts` records.
  //
  // Deliberately frozen there. #27 added `toolsListResult` and
  // `toolsNotOfferedToHook` to what the probe writes, and these fixtures do not
  // carry them — that is the point of keeping them: they are what proves the
  // renderer still reads a run file written before those fields existed, and
  // says `not recorded` rather than inventing one. The guard against drifting
  // from the *current* probe lives on `TOOLS_LIST_DIR` below, which carries the
  // full set; without that one, this list would go on passing while quietly
  // describing a shape nothing writes any more.
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
    // Since issue #25 the per-hit row lives in the one ordered wire timeline,
    // and what it carried moved into the row's own expandable detail. Every
    // number #16 pinned is still asserted here, just read from the new shape.
    const rows = wireTimeline(html, file).rows.filter((row) => row.side === "hook");
    const { cellAt, rows: all } = wireTimeline(html, file);

    expect(rows).toHaveLength(run.hookHits.length);

    run.hookHits.forEach((hit, index) => {
      const row = rows[index]!;
      const at = (label: string) => row.cells[wireTimeline(html, file).column(label)]!;
      expect(at("at")).toBe(hit.receivedAt);
      expect(at("hook server")).toBe(ms(hit.handlingMs!));
      const line = summaryLineOf(row.detail);
      expect(line).toContain(`${hit.bodyBytes} B`);
      expect(line).toContain(`${hit.toolkitCount} toolkit`);
      expect(line).toContain(`${hit.toolCount} tool`);
      for (const [name, value] of Object.entries(hit.headers!)) {
        expect(row.detail, `${name} on hit ${index + 1}`).toContain(
          `<code>${name}</code>: <code>${escaped(value)}</code>`,
        );
      }
    });

    // The sizes differ hit to hit, so the summary line is reading each hit
    // rather than repeating one number.
    const sizes = rows.map((row) => /(\d+) B/.exec(summaryLineOf(row.detail))![1]!);
    expect(new Set(sizes).size).toBeGreaterThan(1);

    // The two latency numbers can never land on the same row: a hook row has no
    // client round trip and a request row has no hook handling time, so there
    // is nothing for a reader to add together.
    all.forEach((row, index) => {
      const client = cellAt(index, "client-observed");
      const hook = cellAt(index, "hook server");
      expect(client === "—" || hook === "—", `row ${index + 1}`).toBe(true);
    });
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
    // "same as above" that would destroy it. Issue #25 moved headers into each
    // row's expandable detail and collapsed duplicate *payloads*; the count is
    // still one descriptor per hit.
    const rendered = html.split("Bearer &lt;redacted").length - 1;
    expect(rendered).toBe(descriptors.length);
    expect(html).not.toContain("same as above");
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
    // The wire table still adds no `<pre>` of its own; since issue #25 the
    // count is one per *distinct* payload, a byte-identical repeat pointing at
    // the copy the first occurrence embedded instead of carrying its own.
    expect(html.match(/<pre id=/g)?.length ?? 0).toBe(bodies.size);
  });

  test("the request timeline carries the client-observed round trip per request", async () => {
    const { html } = await renderDir(PROFILE_DIRS.paged, "profile-timeline.html");
    const paged = (await loadDir(PROFILE_DIRS.paged)).find(
      ({ run }) => (run.toolsListRequests ?? 0) > 1,
    )!;
    const timeline = wireTimeline(html, paged.file);
    const requestRows = timeline.rows.filter((row) => row.side === "client");
    const column = timeline.column("client-observed");

    expect(requestRows).toHaveLength(paged.run.requests.length);
    // Requests appear in the order they were sent, interleaved with the hits
    // they caused, and each still carries its own round trip.
    paged.run.requests.forEach((request, index) => {
      expect(requestRows[index]!.cells[column]).toBe(ms(request.durationMs!));
      expect(requestRows[index]!.cells).toContain(request.method);
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
// Issue #25: one ordered wire timeline per run, with navigable payloads
// ---------------------------------------------------------------------------

/**
 * Fixtures this slice added. Neither is a variant of the #16 set: `attribution`
 * carries a run whose last hit falls past the final `hookHitsAfter` snapshot,
 * and `dedupe/differs` carries two payloads that agree on every number the
 * report prints and still differ by one tool.
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

describe("the wire timeline", () => {
  test("puts both sides in one sequence, oldest first", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "wire-order.html");
    const { file, run } = (await loadDir(ISSUE_25_DIRS.attribution))[0]!;
    const { rows, cellAt } = wireTimeline(html, file);

    // Every request and every hit gets a row — nothing is dropped by merging.
    expect(rows).toHaveLength(run.requests.length + run.hookHits.length);
    expect(rows.filter((row) => row.side === "client")).toHaveLength(run.requests.length);
    expect(rows.filter((row) => row.side === "hook")).toHaveLength(run.hookHits.length);

    // Chronological, and genuinely interleaved rather than one list after the
    // other — a request, the hits it caused, the next request.
    const stamps = rows.map((_row, index) => Date.parse(cellAt(index, "at")));
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(rows.map((row) => row.side)).toEqual(["client", "hook", "client", "hook", "hook"]);

    // The sequence really is the two arrays merged, not one of them repeated.
    const merged = [
      ...run.requests.map((request) => request.sentAt),
      ...run.hookHits.map((hit) => hit.receivedAt),
    ].sort();
    expect(rows.map((_row, index) => cellAt(index, "at"))).toEqual(merged);
  });

  test("each row states its side, what crossed, when, and the offset from the first event", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "wire-identity.html");
    const { file, run } = (await loadDir(ISSUE_25_DIRS.attribution))[0]!;
    const { rows, cellAt } = wireTimeline(html, file);
    const origin = Date.parse(cellAt(0, "at"));

    rows.forEach((row, index) => {
      expect(cellAt(index, "side")).toBe(
        row.side === "client" ? "client → gateway" : "gateway → hook",
      );
      if (row.side === "hook") expect(cellAt(index, "what")).toBe("POST /access");
      else expect(cellAt(index, "what")).not.toBe("");
      // The offset is the arithmetic a reader would otherwise do by hand.
      expect(cellAt(index, "+ms from")).toBe(`+${Date.parse(cellAt(index, "at")) - origin}`);
    });

    // The methods are named on the client rows, not just "request".
    const methods = rows
      .filter((row) => row.side === "client")
      .map((row) => row.cells[wireTimeline(html, file).column("what")]!);
    expect(methods).toEqual(run.requests.map((request) => request.method));
  });

  test("running totals grow down the table at the row that caused them", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "wire-totals.html");
    const { file, run } = (await loadDir(ISSUE_25_DIRS.attribution))[0]!;
    const { rows, cellAt } = wireTimeline(html, file);

    let hits = 0;
    let bytes = 0;
    let hitIndex = 0;
    rows.forEach((row, index) => {
      if (row.side === "hook") {
        hits += 1;
        bytes += run.hookHits[hitIndex]!.bodyBytes!;
        hitIndex += 1;
      }
      expect(cellAt(index, "hook hits"), `hits by row ${index + 1}`).toBe(String(hits));
      expect(cellAt(index, "bytes to hook"), `bytes by row ${index + 1}`).toBe(String(bytes));
    });

    // The totals actually move: a column of one repeated number would pass a
    // weaker assertion than this one.
    expect(hits).toBe(run.hookHits.length);
    expect(new Set(rows.map((_row, index) => cellAt(index, "hook hits"))).size).toBeGreaterThan(1);
    // …and the last row agrees with the run's own cumulative snapshot.
    expect(cellAt(rows.length - 1, "hook hits")).toBe(String(run.hookHits.length));
  });

  test("the two latency numbers keep their own columns and never share a row", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "wire-latency.html");
    const { file, run } = (await loadDir(ISSUE_25_DIRS.attribution))[0]!;
    const { rows, cellAt } = wireTimeline(html, file);

    let requests = 0;
    let hits = 0;
    rows.forEach((row, index) => {
      const client = cellAt(index, "client-observed");
      const hook = cellAt(index, "hook server");
      if (row.side === "client") {
        expect(client).toBe(ms(run.requests[requests]!.durationMs!));
        expect(hook).toBe("—");
        requests += 1;
      } else {
        expect(hook).toBe(ms(run.hookHits[hits]!.handlingMs!));
        expect(client).toBe("—");
        hits += 1;
      }
    });

    // Their sum is meaningless, and with one number per row there is nothing
    // for a reader to add: the sum appears nowhere in the document either.
    const total =
      run.requests.reduce((sum, request) => sum + request.durationMs!, 0) +
      run.hookHits.reduce((sum, hit) => sum + hit.handlingMs!, 0);
    expect(html).not.toContain(ms(total));
    expect(html).toContain("never summed");
  });
});

describe("every hit says which method caused it", () => {
  test("the hook row names the method, derived from the hookHitsAfter snapshots", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "attribution.html");

    for (const { file, run } of await loadDir(ISSUE_25_DIRS.attribution)) {
      const { rows, column } = wireTimeline(html, file);
      const caused = rows
        .filter((row) => row.side === "hook")
        .map((row) => row.cells[column("caused by")]!);
      expect(caused, file).toEqual(
        expectedAttribution(run).map((method) => method ?? "not attributed"),
      );
      // A request row has no "caused by" of its own — it is the cause.
      for (const row of rows.filter((candidate) => candidate.side === "client")) {
        expect(row.cells[column("caused by")]).toBe("—");
      }
    }

    // …and the fixture is discriminating: both methods appear, so a renderer
    // that printed one constant would not pass.
    const first = (await loadDir(ISSUE_25_DIRS.attribution))[0]!;
    const { rows, column } = wireTimeline(html, first.file);
    const caused = rows.filter((row) => row.side === "hook").map((row) => row.cells[column("caused by")]!);
    expect(new Set(caused).size).toBeGreaterThan(1);
  });

  test("a hit no request accounts for reads `not attributed`, never the first method", async () => {
    const loaded = await loadDir(ISSUE_25_DIRS.attribution);
    const orphaned = loaded.find(
      ({ run }) => run.hookHits.length > (run.requests.at(-1)?.hookHitsAfter ?? 0),
    );
    expect(orphaned, "a fixture with a hit past the last snapshot").toBeDefined();

    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "attribution-orphan.html");
    const { rows, column } = wireTimeline(html, orphaned!.file);
    const caused = rows.filter((row) => row.side === "hook").map((row) => row.cells[column("caused by")]!);
    const last = caused.at(-1)!;

    expect(last).toBe("not attributed");
    // The two readings this criterion exists to rule out: folding the hit into
    // the first method, and silently giving it the nearest one.
    expect(last).not.toBe("initialize");
    expect(last).not.toBe("tools/list");
    // The hits that *can* be attributed still are, so `not attributed` is this
    // hit's answer and not a blanket fallback for the run.
    expect(caused.slice(0, -1)).toEqual(
      expectedAttribution(orphaned!.run).slice(0, -1).map((method) => method!),
    );
  });

  test("the per-method split is stated inside each run, not only in the summary", async () => {
    const { html } = await renderDir(ISSUE_25_DIRS.attribution, "attribution-split.html");
    const loaded = await loadDir(ISSUE_25_DIRS.attribution);

    expect(methodSplitOf(html, loaded[0]!.file)).toBe("initialize 1 · tools/list 2");
    expect(methodSplitOf(html, loaded[1]!.file)).toBe(
      "initialize 1 · tools/list 2 · not attributed 1",
    );

    // Counting the rows of that run's timeline gives the same numbers, which is
    // the check a reader would do.
    const { rows, column } = wireTimeline(html, loaded[0]!.file);
    const caused = rows.filter((row) => row.side === "hook").map((row) => row.cells[column("caused by")]!);
    expect(caused.filter((method) => method === "initialize")).toHaveLength(1);
    expect(caused.filter((method) => method === "tools/list")).toHaveLength(2);
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

describe("each row expands", () => {
  test("a hook hit shows its payload and its headers, collapsed by default", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "expand-hit.html");
    const { file, run } = (await loadDir(PROFILE_DIRS.identical))[0]!;
    const rows = wireTimeline(html, file).rows.filter((row) => row.side === "hook");

    expect(rows).toHaveLength(run.hookHits.length);
    rows.forEach((row, index) => {
      const hit = run.hookHits[index]!;
      const line = summaryLineOf(row.detail);
      expect(line).toContain(`${hit.bodyBytes} B`);
      expect(line).toContain(`${hit.toolkitCount} toolkits`);
      expect(line).toContain(`${hit.toolCount} tools`);
      expect(row.detail).toContain(`data-payload="`);
      for (const [name, value] of Object.entries(hit.headers!)) {
        expect(row.detail).toContain(`<code>${name}</code>: <code>${escaped(value)}</code>`);
      }
    });

    // Collapsed by default: no `open` attribute anywhere in the document.
    expect(html).not.toMatch(/<details[^>]*\bopen\b/i);
  });

  test("an MCP request row says `body not recorded`, never an empty object", async () => {
    const { html } = await renderDir(PROFILE_DIRS.paged, "expand-request.html");
    const { file, run } = (await loadDir(PROFILE_DIRS.paged))[0]!;
    const rows = wireTimeline(html, file).rows.filter((row) => row.side === "client");

    expect(rows).toHaveLength(run.requests.length);
    rows.forEach((row, index) => {
      const request = run.requests[index]!;
      expect(summaryLineOf(row.detail)).toContain("body not recorded");
      expect(row.detail).toContain("body not recorded");
      // No MCP body was ever captured, so none is invented.
      expect(row.detail).not.toContain("<pre>{}</pre>");
      expect(row.detail).not.toContain(">{}<");
      // What the run JSON does hold for the request is all there.
      expect(row.detail).toContain(`<dt>method</dt><dd>${request.method}</dd>`);
      expect(row.detail).toContain(`<dt>JSON-RPC id</dt><dd>${request.jsonRpcId}</dd>`);
      expect(row.detail).toContain(`<dt>HTTP status</dt><dd>${request.status}</dd>`);
      expect(row.detail).toContain(
        `<dt>client-observed round trip</dt><dd>${ms(request.durationMs!)} ms</dd>`,
      );
      expect(row.detail).toContain(
        `<dt>user-id header observed</dt><dd>${request.userIdHeader}</dd>`,
      );
      expect(row.detail).toContain(
        `<dt>hookHitsAfter (cumulative)</dt><dd>${request.hookHitsAfter}</dd>`,
      );
    });
  });

  test("a run file that records none of it says `not recorded`, not a blank", async () => {
    // The #5 fixtures carry only id/method/sentAt/hookHitsAfter.
    const { html } = await renderFixtures("expand-absent.html");
    const file = (await fixtureFiles())[0]!;
    const requestRow = wireTimeline(html, file).rows.find((row) => row.side === "client")!;

    for (const term of ["JSON-RPC id", "HTTP status", "user-id header observed"]) {
      expect(requestRow.detail).toContain(
        `<dt>${term}</dt><dd><span class="empty">not recorded</span></dd>`,
      );
    }
    expect(requestRow.detail).not.toContain(`<dt>HTTP status</dt><dd>0</dd>`);

    const hitRow = wireTimeline(html, file).rows.find((row) => row.side === "hook")!;
    const line = summaryLineOf(hitRow.detail);
    expect(line).toContain("size not recorded");
    expect(line).toContain("toolkits not recorded");
    expect(line).toContain("tools not recorded");
    expect(line).not.toContain("0 B");
    expect(line).not.toContain("0 toolkits");
  });
});

describe("byte-identical payloads are stored once", () => {
  test("a repeat carries no second copy and points at the one that does", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "dedupe-identical.html");
    const { file, run } = (await loadDir(PROFILE_DIRS.identical))[0]!;
    const rows = wireTimeline(html, file).rows.filter((row) => row.side === "hook");

    // The fixture's three hits carry one payload, so two of them are repeats.
    expect(new Set(run.hookHits.map((hit) => JSON.stringify(hit.payload))).size).toBe(1);
    expect(rows[0]!.detail).toContain("<pre id=");
    for (const row of rows.slice(1)) {
      expect(row.detail).not.toContain("<pre id=");
      expect(row.detail).toContain("Byte-identical to");
      expect(row.detail).toContain(`href="#${file}--payload-1"`);
      expect(summaryLineOf(row.detail)).toContain(`identical to hit 1 of ${file}`);
      // …and it still expands from the copy that does exist, so a reader does
      // not have to navigate away to see the payload.
      expect(row.detail).toContain(`data-payload="${file}--payload-1"`);
    }
  });

  test("two payloads that agree on every printed number and still differ are both stored", async () => {
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
    const rows = wireTimeline(html, file).rows.filter((row) => row.side === "hook");

    expect(rows[0]!.detail).toContain(escaped(JSON.stringify(first!.payload, null, 2)));
    expect(rows[1]!.detail).toContain("Byte-identical to"); // the real duplicate did collapse
    expect(rows[2]!.detail).not.toContain("Byte-identical to");
    expect(rows[2]!.detail).toContain(escaped(JSON.stringify(third!.payload, null, 2)));
    expect(html.match(/<pre id=/g)?.length ?? 0).toBe(2);

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
    expect(withRepeats).toContain("embedded once each");

    const { html: without } = await renderDir(PROFILE_DIRS.varied, "dedupe-note-none.html");
    expect(without).toContain("No two of them are byte-identical");
    expect(without).not.toContain("byte-identical repeats");
  });

  test("the count sentence names each kind, and never calls a tools/list result a hook payload", async () => {
    // Round 1's finding: `PayloadPlan.occurrences` counted hook payloads and
    // `toolsListResult` arrays together and the sentence called the total
    // "hook payloads", so this fixture — 12 payloads and 4 results — announced
    // "16 hook payloads". A wrong number in a rendered report is the defect
    // this slice exists to remove; prose gets no exemption.
    const { html } = await renderDir(TOOLS_LIST_DIR, "dedupe-note-kinds.html");
    const loaded = await loadDir(TOOLS_LIST_DIR);
    const payloads = loaded.reduce((sum, { run }) => sum + run.hookHits.length, 0);
    const results = loaded.filter(({ run }) => Array.isArray(run.toolsListResult)).length;

    const note = stripTags(/<p class="sub">This report embeds[\s\S]*?<\/p>/.exec(html)![0]);

    expect(payloads).toBe(12);
    expect(results).toBe(4);
    expect(note).toContain(`${payloads} hook payloads`);
    expect(note).toContain(`${results} tools/list results`);
    expect(note).toContain(`${payloads + results} bodies`);
    // The exact wrong sentence, pinned so it cannot come back.
    expect(note).not.toContain(`${payloads + results} hook payloads`);
    expect(note).not.toMatch(/\b16 hook payloads\b/);
  });
});

describe("headers stay per hit, whatever happened to the payloads", () => {
  test("a stored-once payload does not collapse its hit's headers", async () => {
    // Issue #16 renders every hit's headers so the credential descriptor is
    // shown present on *every* hit; issue #25 stores payload bodies once only.
    const { html } = await renderDir(ISSUE_25_DIRS.differs, "dedupe-headers.html");
    const { file, run } = (await loadDir(ISSUE_25_DIRS.differs))[0]!;
    const rows = wireTimeline(html, file).rows.filter((row) => row.side === "hook");

    expect(rows).toHaveLength(run.hookHits.length);
    run.hookHits.forEach((hit, index) => {
      for (const [name, value] of Object.entries(hit.headers!)) {
        expect(rows[index]!.detail, `${name} on hit ${index + 1}`).toContain(
          `<code>${name}</code>: <code>${escaped(value)}</code>`,
        );
      }
    });

    // Two of the three payloads collapsed into one; all three descriptors are
    // still printed in full, never folded into a "same as above".
    expect(html.match(/<pre id=/g)?.length ?? 0).toBe(2);
    expect(html.split("Bearer &lt;redacted").length - 1).toBe(run.hookHits.length);
    expect(html).not.toContain("same as above");
  });
});

// ---------------------------------------------------------------------------
// Issue #25 criterion 6: the inline JSON explorer
// ---------------------------------------------------------------------------

/**
 * The smallest DOM the explorer needs, so the **real** inline script can be
 * driven rather than described.
 *
 * Bun ships no DOM and this harness has no business growing a browser
 * dependency, so the shim implements exactly the surface the script uses —
 * `createElement`, `getElementById`, `querySelectorAll`, `appendChild`,
 * `addEventListener`, `textContent`, and an `open` setter that fires `toggle`
 * the way a real `<details>` does. The script under test is extracted from the
 * rendered report, not pasted here, so this cannot drift from what ships.
 */
class FakeElement {
  tagName: string;
  className = "";
  children: FakeElement[] = [];
  private text = "";
  private attributes = new Map<string, string>();
  private listeners: (() => void)[] = [];
  private isOpen = false;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Setting `open` fires `toggle`, which is what makes the script lazy. */
  set open(value: boolean) {
    if (this.isOpen === value) return;
    this.isOpen = value;
    for (const listener of [...this.listeners]) listener();
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === "toggle") this.listeners.push(listener);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  /** Supports the two selectors the script uses: `tag.class` and `.class`. */
  querySelectorAll(selector: string): FakeElement[] {
    const [tag, className] = selector.split(".");
    const found: FakeElement[] = [];
    const walk = (element: FakeElement): void => {
      const tagOk = tag === "" || element.tagName === tag!.toUpperCase();
      const classOk = className === undefined || element.className.split(" ").includes(className);
      if (tagOk && classOk) found.push(element);
      for (const child of element.children) walk(child);
    };
    for (const child of this.children) walk(child);
    return found;
  }

  /** Every descendant whose summary text contains `needle`. */
  find(needle: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (element: FakeElement): void => {
      if (element.tagName === "DETAILS") {
        const head = element.children[0];
        if (head !== undefined && head.textContent.includes(needle)) found.push(element);
      }
      for (const child of element.children) walk(child);
    };
    walk(this);
    return found;
  }
}

class FakeDocument extends FakeElement {
  private byId = new Map<string, FakeElement>();

  constructor() {
    super("document");
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  register(id: string, element: FakeElement): FakeElement {
    this.byId.set(id, element);
    return element;
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }
}

/** The inline explorer, lifted out of a rendered report. */
function explorerSource(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (match === null) throw new Error("no inline script in the report");
  return match[1]!;
}

/** A document with one collapsed row holding `payload`, wired the way the report wires it. */
function stageExplorer(payload: unknown) {
  const document = new FakeDocument();
  const row = document.appendChild(new FakeElement("details"));
  row.className = "event";
  const mount = row.appendChild(new FakeElement("div"));
  mount.className = "json";
  mount.setAttribute("data-payload", "p1");
  const raw = new FakeElement("pre");
  raw.textContent = JSON.stringify(payload);
  document.register("p1", raw);
  return { document, row, mount };
}

describe("the inline JSON explorer", () => {
  test("renders nothing until the row is opened, then a tree of the payload", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "explorer-lazy.html");
    const payload = { user_id: "probe-1", toolkits: { Gmail: { tools: { SendEmail: [1] } } } };
    const { document, row, mount } = stageExplorer(payload);

    new Function("document", explorerSource(html))(document);

    // Lazy: registering the listener must not have built anything.
    expect(mount.children).toHaveLength(0);

    row.open = true;
    expect(mount.children).toHaveLength(1);
    const root = mount.children[0]!;
    expect(root.tagName).toBe("DETAILS");
    expect(root.open).toBe(true);
    // The root opens one level, so a reader sees the payload's top-level keys
    // without a second click.
    expect(root.textContent).toContain("user_id");
    expect(root.textContent).toContain("toolkits");
    expect(root.textContent).toContain('"probe-1"');
  });

  test("summarises large objects and arrays until they are opened", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "explorer-summary.html");
    // The live evidence's shape, which is the reason the explorer exists: 125
    // toolkits and an array a reader must never have expanded for them.
    const toolkits: Record<string, unknown> = {};
    for (let index = 0; index < 125; index += 1) toolkits[`Toolkit_${index}`] = { tools: {} };
    const payload = { user_id: "probe-1", toolkits, versions: Array.from({ length: 8258 }, (_v, i) => i) };
    const { document, row, mount } = stageExplorer(payload);

    new Function("document", explorerSource(html))(document);
    row.open = true;

    const root = mount.children[0]!;
    const toolkitsNode = root.find("toolkits")[0]!;
    const versionsNode = root.find("versions")[0]!;

    expect(toolkitsNode.children[0]!.textContent).toBe("toolkits: {125 keys}");
    expect(versionsNode.children[0]!.textContent).toBe("versions: [8258 items]");

    // Summarised means not yet built: the closed node holds only its summary.
    expect(toolkitsNode.children).toHaveLength(1);
    expect(versionsNode.children).toHaveLength(1);

    toolkitsNode.open = true;
    expect(toolkitsNode.children).toHaveLength(126); // summary + 125 toolkits
    // …and its children are summarised in turn, one level at a time.
    expect(versionsNode.children).toHaveLength(1);
    versionsNode.open = true;
    expect(versionsNode.children).toHaveLength(8259);
  });

  test("a payload stored in two parts is put back together whole", async () => {
    // The split stores a payload's own fields and its shared `toolkits` object
    // separately. If the explorer showed only the own fields, a reader would
    // open a hook hit and see a payload with no toolkits at all — a report that
    // looks fine and hides everything the hit carried.
    const { html } = await renderDir(PROFILE_DIRS.identical, "explorer-rejoin.html");
    const payload = {
      user_id: "probe-1",
      toolkits: { Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } } },
    };
    const document = new FakeDocument();
    const row = document.appendChild(new FakeElement("details"));
    row.className = "event";
    const mount = row.appendChild(new FakeElement("div"));
    mount.className = "json";
    mount.setAttribute("data-payload", "own");
    mount.setAttribute("data-shared", "shared");
    mount.setAttribute("data-shared-key", "toolkits");

    const own = new FakeElement("pre");
    own.textContent = JSON.stringify({ user_id: payload.user_id });
    document.register("own", own);
    const shared = new FakeElement("pre");
    shared.textContent = JSON.stringify(payload.toolkits);
    document.register("shared", shared);

    new Function("document", explorerSource(html))(document);
    expect(mount.children).toHaveLength(0); // still lazy
    row.open = true;

    const root = mount.children[0]!;
    expect(root.tagName).toBe("DETAILS");
    // Both halves are in the tree, and the payload's own field is not lost to
    // the shared one.
    expect(root.textContent).toContain("user_id");
    expect(root.textContent).toContain('"probe-1"');
    const toolkitsNode = root.find("toolkits")[0]!;
    expect(toolkitsNode.children[0]!.textContent).toBe("toolkits: {1 key}");
    toolkitsNode.open = true;
    expect(toolkitsNode.find("Gmail")).toHaveLength(1);
  });

  test("the shared store is read, not copied, and one payload cannot poison another", async () => {
    // Two payloads sharing one `toolkits` store: the explorer merges into a
    // fresh object rather than mutating the cached own-fields value, so the
    // second payload does not inherit the first one's id.
    const { html } = await renderDir(PROFILE_DIRS.identical, "explorer-rejoin-two.html");
    const document = new FakeDocument();
    const shared = new FakeElement("pre");
    shared.textContent = JSON.stringify({ Slack: { tools: {} } });
    document.register("shared", shared);

    const mounts = ["a", "b"].map((id, index) => {
      const own = new FakeElement("pre");
      own.textContent = JSON.stringify({ user_id: `probe-${index + 1}` });
      document.register(id, own);
      const row = document.appendChild(new FakeElement("details"));
      row.className = "event";
      const mount = row.appendChild(new FakeElement("div"));
      mount.className = "json";
      mount.setAttribute("data-payload", id);
      mount.setAttribute("data-shared", "shared");
      mount.setAttribute("data-shared-key", "toolkits");
      return { row, mount };
    });

    new Function("document", explorerSource(html))(document);
    for (const { row } of mounts) row.open = true;

    expect(mounts[0]!.mount.children[0]!.textContent).toContain('"probe-1"');
    expect(mounts[1]!.mount.children[0]!.textContent).toContain('"probe-2"');
    expect(mounts[1]!.mount.children[0]!.textContent).not.toContain('"probe-1"');
    // …and both still carry the shared object.
    for (const { mount } of mounts) {
      expect(mount.children[0]!.find("toolkits")).toHaveLength(1);
    }
  });

  test("every mount points at an embedded payload that is on the page and parses", async () => {
    const { html } = await renderDir(PROFILE_DIRS.identical, "explorer-wiring.html");
    const loaded = await loadDir(PROFILE_DIRS.identical);
    const hits = loaded.flatMap(({ run }) => run.hookHits);
    const mounts = [...html.matchAll(/<div class="json" data-payload="([^"]*)"><\/div>/g)].map(
      (match) => match[1]!,
    );

    // One mount per hit — a repeat expands too, from the copy that exists.
    expect(mounts).toHaveLength(hits.length);
    const stored = new Map(
      [...html.matchAll(/<pre id="([^"]*)">([\s\S]*?)<\/pre>/g)].map((match) => [
        match[1]!,
        match[2]!,
      ]),
    );
    expect(stored.size).toBeLessThan(mounts.length); // repeats really did share

    for (const id of mounts) {
      const body = stored.get(id);
      expect(body, `no embedded payload for ${id}`).toBeDefined();
      // The text the script parses is the payload, undamaged by escaping.
      const decoded = body!
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll("&gt;", ">")
        .replaceAll("&lt;", "<")
        .replaceAll("&amp;", "&");
      expect(() => JSON.parse(decoded)).not.toThrow();
    }
  });

  test("the evidence is readable with no scripting at all", async () => {
    const { html } = await renderDir(PROFILE_DIRS.varied, "explorer-noscript.html");
    const { run } = (await loadDir(PROFILE_DIRS.varied))[0]!;

    // Every distinct payload is in the document as text, inside a `<details>`
    // a reader can open with no script running.
    for (const hit of run.hookHits) {
      expect(html).toContain(escaped(JSON.stringify(hit.payload, null, 2)));
    }
    expect(html).toContain('<details class="raw"><summary>raw JSON</summary>');
    // Still nothing fetched off-file: the script is inline and there is no
    // other asset of any kind.
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b[^>]*\bhref\s*=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\s*\(/i);
    expect(html).not.toMatch(/<(iframe|object|embed)\b/i);
    expect(html).not.toMatch(/\son(click|toggle|load|error)\s*=/i);
    for (const href of [...html.matchAll(/\bhref\s*=\s*"([^"]*)"/g)].map((m) => m[1]!)) {
      expect(href).toStartWith("#");
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #25 criterion 9: the report on the live-evidence shape
// ---------------------------------------------------------------------------

describe("report size on the live-evidence shape", () => {
  test("the fixture reproduces the shape the real run files actually have", async () => {
    // Corrected in round 2. The issue told me the catalogue payload was
    // byte-identical across all five runs; it is not. On the operator's real
    // files the five payloads have five different digests and one shared
    // `toolkits` digest — they differ in `user_id` and nowhere else. A fixture
    // encoding the wrong premise measures a shape that does not occur and
    // flatters the feature, which is worse than having no fixture.
    const dir = join(scratch, "real-shape-shape");
    const files = await writeRealShapeRuns(dir, 5);
    const loaded = await Promise.all(
      files.map(async (file) => parseRun(file, await Bun.file(join(dir, file)).text())),
    );
    const catalogues = loaded.map(
      (run) => run.hookHits.find((hit) => hit.bodyBytes === CATALOGUE_BODY_BYTES)!.payload,
    ) as Record<string, unknown>[];

    expect(catalogues).toHaveLength(5);
    // Five different payloads…
    expect(new Set(catalogues.map((payload) => JSON.stringify(payload))).size).toBe(5);
    // …one `toolkits` object…
    expect(new Set(catalogues.map((payload) => JSON.stringify(payload["toolkits"]))).size).toBe(1);
    // …and `user_id` is the only field they disagree about.
    expect(new Set(catalogues.map((payload) => JSON.stringify(payload["user_id"]))).size).toBe(5);
    for (const payload of catalogues) expect(Object.keys(payload).sort()).toEqual([
      "toolkits",
      "user_id",
    ]);

    // Calibrated to what one catalogue costs the real report as a stored
    // block, so the saving measured here is the saving the real file gets.
    const stored = escaped(JSON.stringify(catalogues[0]));
    expect(Math.abs(stored.length - CATALOGUE_STORED_CHARS)).toBeLessThan(1_000);
  }, 60_000);

  test("the shared toolkits object is stored once and the report shrinks by the difference", async () => {
    const dir = join(scratch, "real-shape");
    const files = await writeRealShapeRuns(dir, 5);
    const { html } = await renderDir(dir, "real-shape.html");
    const loaded = await Promise.all(
      files.map(async (file) => parseRun(file, await Bun.file(join(dir, file)).text())),
    );
    const hits = loaded.flatMap((run) => run.hookHits);

    expect(hits).toHaveLength(20);
    expect(hits.filter((hit) => hit.bodyBytes === CATALOGUE_BODY_BYTES)).toHaveLength(5);
    expect(hits.filter((hit) => hit.bodyBytes === SMALL_BODY_BYTES)).toHaveLength(15);

    // Whole-payload deduplication correctly declines the five catalogues —
    // they differ — so exactly one `toolkits` store carries what they share.
    const embedded = [...html.matchAll(/<pre id="([^"]*)">([\s\S]*?)<\/pre>/g)];
    const stores = embedded.filter(([, id]) => id!.includes("--toolkits-"));
    expect(stores).toHaveLength(1);
    expect(html.match(/data-shared="[^"]*"/g)).toHaveLength(5);

    // Every catalogue payload still shows its own `user_id`, in its own bytes.
    for (const run of loaded) {
      expect(html).toContain(escaped(`"user_id": "${run.userId}"`));
    }

    const before = hits.reduce(
      (sum, hit) => sum + escaped(JSON.stringify(hit.payload, null, 2)).length,
      0,
    );
    const after = Buffer.byteLength(html, "utf8");
    // A ceiling, not a ratio: a regression guard on the whole document.
    expect(after).toBeLessThan(3_000_000);
    expect(before).toBeGreaterThan(20_000_000);

    // Nothing was truncated to get there: the store parses back to the whole
    // catalogue, and each payload's own fields plus that store reconstruct the
    // payload byte for byte.
    const storedToolkits = JSON.parse(unescaped(stores[0]![2]!));
    expect(Object.keys(storedToolkits)).toHaveLength(CATALOGUE_TOOLKITS);
    expect(
      Object.values(storedToolkits as Record<string, { tools: object }>).reduce(
        (sum, toolkit) => sum + Object.keys(toolkit.tools).length,
        0,
      ),
    ).toBe(CATALOGUE_TOOLS);

    const ownFields = embedded.filter(([, id]) => /--payload-2$/.test(id!));
    expect(ownFields.length).toBeGreaterThan(0);
    const rebuilt = { ...JSON.parse(unescaped(ownFields[0]![2]!)), toolkits: storedToolkits };
    const original = loaded[0]!.hookHits[1]!.payload;
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(original));
    expect(Buffer.byteLength(JSON.stringify(rebuilt), "utf8")).toBe(CATALOGUE_BODY_BYTES);
  }, 60_000);

  test("a toolkits object that differs is never folded into a shared store", async () => {
    // The trap, one level down from the whole-payload one. Run 3's `toolkits`
    // is byte-for-byte the same *length* as the other two and differs by one
    // tool name, so a split that compared sizes — or trusted that catalogues
    // "look alike" — would erase a real difference in a report whose entire
    // subject is a hook whose behaviour is invisible unless measured.
    const dir = join(scratch, "real-shape-differs");
    const files = await writeRealShapeRuns(dir, 3);
    const third = join(dir, files[2]!);
    const run = JSON.parse(await Bun.file(third).text()) as {
      hookHits: { payload: { toolkits: Record<string, { tools: Record<string, unknown> }> } }[];
    };
    const toolkits = run.hookHits[1]!.payload.toolkits;
    const name = Object.keys(toolkits)[0]!;
    const tools = toolkits[name]!.tools;
    const renamed = Object.keys(tools)[0]!;
    // Same length, different name: `Tool_0000` becomes `Tool_9000`.
    const swapped = `Tool_9${renamed.slice(6)}`;
    expect(swapped).toHaveLength(renamed.length);
    tools[swapped] = tools[renamed]!;
    delete tools[renamed];
    await Bun.write(third, JSON.stringify(run));

    const reread = parseRun(files[2]!, await Bun.file(third).text());
    const changed = reread.hookHits[1]!.payload as { toolkits: unknown };
    const original = (
      parseRun(files[0]!, await Bun.file(join(dir, files[0]!)).text()).hookHits[1]!.payload as {
        toolkits: unknown;
      }
    ).toolkits;
    // Equal length, unequal bytes — the whole point of the fixture.
    expect(JSON.stringify(changed.toolkits)).toHaveLength(JSON.stringify(original).length);
    expect(JSON.stringify(changed.toolkits)).not.toBe(JSON.stringify(original));

    const { html } = await renderDir(dir, "real-shape-differs.html");
    const stores = [...html.matchAll(/<pre id="([^"]*--toolkits-[^"]*)">([\s\S]*?)<\/pre>/g)];

    // Runs 1 and 2 share one object, so one store with two references. Run 3
    // shares with nobody, so it is embedded whole and references nothing.
    expect(stores).toHaveLength(1);
    expect(html.match(/data-shared="[^"]*"/g)).toHaveLength(2);
    expect(stores[0]![2]).not.toContain(swapped);

    // …and the tool that differs is on the page, in full, which is what a
    // collapse would have destroyed.
    expect(html).toContain(swapped);
    expect(unescaped(html)).toContain(JSON.stringify(changed.toolkits).slice(0, 200));
  }, 60_000);

  test("large payloads are embedded compact and small ones stay pretty-printed", async () => {
    const dir = join(scratch, "real-shape-threshold");
    await writeRealShapeRuns(dir, 2);
    const { html } = await renderDir(dir, "real-shape-threshold.html");
    const embedded = [...html.matchAll(/<pre id="[^"]*">([\s\S]*?)<\/pre>/g)].map((m) => m[1]!);

    const large = embedded.filter((body) => body.length > 1_000_000);
    const small = embedded.filter((body) => body.length <= 1_000_000);
    expect(large).toHaveLength(1);
    expect(small.length).toBeGreaterThan(0);

    // Compact above the threshold: whitespace removed, nothing else — the
    // explorer does the formatting, and indentation nobody reads is what made
    // the live report three times bigger than the payloads it carried.
    expect(large[0]).not.toContain("\n");
    // Pretty below it, which is what keeps #16's raw-payload test passing on
    // the fixtures a person actually reads.
    for (const body of small) expect(body).toContain("\n  ");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// #27's run-JSON fields, read by this renderer after the rebase onto 973c1ea
// ---------------------------------------------------------------------------

/**
 * Runs carrying `toolsListResult` and `toolsNotOfferedToHook`, one per state.
 *
 * `-1` a result plus one tool that bypassed the hook; `-2` no hook hits, so
 * `toolsNotOfferedToHook` is `null`; `-3` the gateway returned an empty list
 * and every listed tool was offered, so it is `[]`; `-4` no result was
 * assembled; `-5` the same result as `-1`, assembled across two paged
 * requests.
 */
const TOOLS_LIST_DIR = "test/fixtures/tools-list-result";

/** The `tools not offered to hook` value from a run's meta list, as plain text. */
function notOfferedOf(html: string, file: string): string {
  const match = /<dt>tools not offered to hook<\/dt><dd>([\s\S]*?)<\/dd>/.exec(
    sectionFor(html, file),
  );
  if (match === null) throw new Error(`no 'tools not offered to hook' in ${file}`);
  return stripTags(match[1]!);
}

/** The `<h4>tools/list result</h4>` block of one run, as raw HTML. */
function toolsListBlock(html: string, file: string): string {
  const section = sectionFor(html, file);
  const start = section.indexOf("<h4>tools/list result</h4>");
  expect(start, `no tools/list result block in ${file}`).toBeGreaterThan(-1);
  return section.slice(start);
}

describe("a run file carrying #27's fields", () => {
  test("renders, with the tools/list result embedded whole and off the wire", async () => {
    const { html } = await renderDir(TOOLS_LIST_DIR, "tools-list-result.html");
    const loaded = await loadDir(TOOLS_LIST_DIR);
    const first = loaded.find(({ file }) => file.endsWith("-1.json"))!;
    const tools = first.run.toolsListResult as { name: string }[];

    expect(tools).toHaveLength(3);
    const block = toolsListBlock(html, first.file);
    expect(summaryLineOf(block)).toContain("3 tools");
    expect(block).toContain(escaped(JSON.stringify(tools, null, 2)));

    // Whole means whole: a vendor field the MCP spec does not name is exactly
    // what #27 exists to preserve, and trimming it here would undo that.
    expect(block).toContain("arcadeToolkit");
    expect(block).toContain("Default_Ping");
    expect(JSON.parse(JSON.stringify(tools))).toEqual(tools);
  });

  test("the tools/list row stops claiming `body not recorded` once the result is there", async () => {
    const { html } = await renderDir(TOOLS_LIST_DIR, "tools-list-row.html");
    const loaded = await loadDir(TOOLS_LIST_DIR);
    const first = loaded.find(({ file }) => file.endsWith("-1.json"))!;
    const rows = wireTimeline(html, first.file).rows.filter((row) => row.side === "client");

    const listRow = rows.find((row) => row.cells.includes("tools/list"))!;
    const initRow = rows.find((row) => row.cells.includes("initialize"))!;

    // The claim this rebase existed to catch: #27 made request-log capture the
    // result, so saying it was not recorded would be false.
    expect(summaryLineOf(listRow.detail)).toContain("response body recorded for the run");
    expect(summaryLineOf(listRow.detail)).not.toContain("body not recorded");
    expect(listRow.detail).toContain("is</strong> recorded for this run");
    expect(listRow.detail).toContain(`href="#${first.file}--tools-list"`);

    // `initialize` still records no body, and still says so: #27 captured
    // `result.tools`, not request bodies.
    expect(summaryLineOf(initRow.detail)).toContain("body not recorded");
    expect(initRow.detail).toContain("no MCP body is kept per request");
  });

  test("a paged run says the result is the run's list, not the row's page", async () => {
    const { html } = await renderDir(TOOLS_LIST_DIR, "tools-list-paged.html");
    const loaded = await loadDir(TOOLS_LIST_DIR);
    const paged = loaded.find(({ run }) => (run.toolsListRequests ?? 0) > 1)!;

    expect(paged.run.requests.filter((request) => request.method === "tools/list")).toHaveLength(2);
    expect(toolsListBlock(html, paged.file)).toContain(
      "Assembled across 2 <code>tools/list</code> requests, in page order",
    );
    for (const row of wireTimeline(html, paged.file).rows.filter(
      (candidate) => candidate.side === "client" && candidate.cells.includes("tools/list"),
    )) {
      expect(stripTags(row.detail)).toContain("assembled list, concatenated across 2");
      expect(stripTags(row.detail)).toContain("not this row");
    }
  });

  test("an identical result across runs is embedded once, like a hook payload", async () => {
    const { html } = await renderDir(TOOLS_LIST_DIR, "tools-list-dedupe.html");
    const loaded = await loadDir(TOOLS_LIST_DIR);
    const withResult = loaded.filter(({ run }) => Array.isArray(run.toolsListResult));
    const bodies = new Set(withResult.map(({ run }) => JSON.stringify(run.toolsListResult)));

    expect(withResult.length).toBeGreaterThan(bodies.size); // the fixtures repeat
    expect(html.match(/<pre id="[^"]*--tools-list-json">/g) ?? []).toHaveLength(bodies.size);
    expect(html).toContain("identical to the tools/list result of");
  });
});

describe("tools not offered to hook keeps its four states apart", () => {
  test("`null` reads `cannot say`, never 0, never [], never none", async () => {
    // The distinction this whole renderer is an instrument for. `null` means
    // the run saw no hook hits, so it is not evidence about what was offered;
    // "none" would turn that absence into the finding "nothing bypassed the
    // hook", which is a false claim dressed as a measurement.
    const { html } = await renderDir(TOOLS_LIST_DIR, "not-offered-null.html");
    const loaded = await loadDir(TOOLS_LIST_DIR);

    const noHits = loaded.find(
      ({ run }) => run.toolsNotOfferedToHook === null && run.hookHits.length === 0,
    )!;
    const text = notOfferedOf(html, noHits.file);

    expect(text).toBe("cannot say — this run observed no hook hits");
    expect(text).not.toBe("0");
    expect(text).not.toContain("none");
    expect(text).not.toContain("[]");
    expect(text).not.toContain("nothing bypassed");
    expect(sectionFor(html, noHits.file)).not.toContain(
      "<dt>tools not offered to hook</dt><dd>0</dd>",
    );

    // …and the other `null` run, which had hits but no result, names its own
    // reason rather than borrowing that one.
    const noResult = loaded.find(
      ({ run }) => run.toolsNotOfferedToHook === null && run.hookHits.length > 0,
    )!;
    expect(notOfferedOf(html, noResult.file)).toBe(
      "cannot say — this run assembled no tools/list result",
    );
  });

  test("`[]` is a measurement and reads as one", async () => {
    const { html } = await renderDir(TOOLS_LIST_DIR, "not-offered-empty.html");
    const loaded = await loadDir(TOOLS_LIST_DIR);
    const empty = loaded.find(({ run }) => run.toolsNotOfferedToHook?.length === 0)!;

    expect(notOfferedOf(html, empty.file)).toBe(
      "none — every listed tool appeared in a hook payload",
    );
    expect(notOfferedOf(html, empty.file)).not.toContain("not recorded");
    expect(notOfferedOf(html, empty.file)).not.toContain("cannot say");

    // Its `toolsListResult` is `[]` too, and that is also a measurement — the
    // gateway returned an empty list, which is what a hook denying everything
    // produces — not a missing one.
    expect(empty.run.toolsListResult).toEqual([]);
    expect(toolsListBlock(html, empty.file)).toContain("returned an <strong>empty list</strong>");
    expect(toolsListBlock(html, empty.file)).not.toContain("not recorded");
  });

  test("a non-empty list names the tools instead of counting them", async () => {
    const { html } = await renderDir(TOOLS_LIST_DIR, "not-offered-names.html");
    const loaded = await loadDir(TOOLS_LIST_DIR);
    const named = loaded.find(({ run }) => (run.toolsNotOfferedToHook?.length ?? 0) > 0)!;

    // An absence is not evidence: the engine team opens this file to learn
    // *which* tools were never submitted to access control.
    for (const name of named.run.toolsNotOfferedToHook!) {
      expect(notOfferedOf(html, named.file)).toContain(name);
    }
    expect(notOfferedOf(html, named.file)).toContain("Default_Ping");
  });

  test("a run file that predates #27 reads `not recorded`, not `none`", async () => {
    const { html } = await renderFixtures("not-offered-absent.html");
    const file = (await fixtureFiles())[0]!;

    expect(notOfferedOf(html, file)).toBe("not recorded");
    expect(toolsListBlock(html, file)).toContain("predates the");
    // Absent, `null` and `[]` are three different sentences and none of them is
    // this one.
    expect(notOfferedOf(html, file)).not.toContain("cannot say");
    expect(notOfferedOf(html, file)).not.toContain("none");
  });
});

describe("the tools-list-result fixtures track what the probe writes today", () => {
  // The drift guard the rebase onto 973c1ea needed. `test/fixtures/profile`
  // is frozen at #16's shape on purpose, so without this one every key-set
  // assertion in this file would keep passing while describing a run JSON that
  // `src/probe/run.ts` stopped writing — the kind of stale-but-green guard a
  // clean `git rebase` cannot flag.
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
    "toolsListResult",
    "toolsNotOfferedToHook",
    "error",
    "toolsListRequests",
    "cursorFollowed",
    "toolsListDurationMs",
    "protocolEra",
    "startedAt",
    "finishedAt",
  ].sort();

  test("carry every key `src/probe/run.ts` writes, #27's pair included", async () => {
    const loaded = await loadDir(TOOLS_LIST_DIR);
    expect(loaded.length).toBeGreaterThanOrEqual(4);

    for (const { file } of loaded) {
      const raw = await Bun.file(`${REPO_ROOT}${TOOLS_LIST_DIR}/${file}`).json();
      expect(Object.keys(raw).sort(), `${file} top-level keys`).toEqual(RUN_KEYS);
      // `null` has to survive as `null`: writing the key with an explicit null
      // is how the probe says "cannot say", and a fixture that dropped the key
      // would be testing the absent case instead.
      expect(Object.hasOwn(raw, "toolsNotOfferedToHook"), file).toBe(true);
      expect(Object.hasOwn(raw, "toolsListResult"), file).toBe(true);
    }
  });

  test("cover all four states of toolsNotOfferedToHook", async () => {
    const loaded = await loadDir(TOOLS_LIST_DIR);
    const states = loaded.map(({ run }) =>
      run.toolsNotOfferedToHook === undefined
        ? "absent"
        : run.toolsNotOfferedToHook === null
          ? "null"
          : run.toolsNotOfferedToHook.length === 0
            ? "empty"
            : "named",
    );
    expect(new Set(states)).toEqual(new Set(["null", "empty", "named"]));
    // The fourth state, `absent`, is what every pre-#27 fixture in this repo
    // is, so it is covered by `test/fixtures/runs` rather than duplicated here.
    const legacy = await loadFixture((await fixtureFiles())[0]!);
    expect(legacy.toolsNotOfferedToHook).toBeUndefined();
  });
});

describe("every anchor in the document is unique and every mount resolves", () => {
  // The guard for a bug the HTML assertions could not see and a browser found:
  // the `tools/list` result block and the `<pre>` holding its embedded copy
  // were both given `<file>--tools-list`. `document.getElementById` returns the
  // first match, so the explorer read the *block* — summary line included —
  // and every payload silently failed to parse, leaving the report looking
  // fine and working not at all.
  const DIRS = [
    FIXTURE_DIR,
    PROFILE_DIRS.identical,
    PROFILE_DIRS.paged,
    ISSUE_25_DIRS.differs,
    TOOLS_LIST_DIR,
  ];

  for (const dir of DIRS) {
    test(`ids are unique and mounts parse in ${dir}`, async () => {
      const { html } = await renderDir(dir, `ids-${dir.replaceAll("/", "-")}.html`);

      const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((match) => match[1]!);
      const seen = new Set<string>();
      const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
      expect(duplicates, `duplicate ids in ${dir}`).toEqual([]);

      // Every embedded body is reachable by the id the explorer looks up, and
      // what it finds is the payload and nothing else.
      const stored = new Map(
        [...html.matchAll(/<pre id="([^"]*)">([\s\S]*?)<\/pre>/g)].map((match) => [
          match[1]!,
          match[2]!,
        ]),
      );
      const mounts = [...html.matchAll(/data-payload="([^"]*)"/g)].map((match) => match[1]!);
      expect(mounts.length).toBeGreaterThan(0);

      for (const id of mounts) {
        expect(stored.has(id), `${dir}: no <pre id="${id}"> for a mount`).toBe(true);
        const decoded = stored
          .get(id)!
          .replaceAll("&quot;", '"')
          .replaceAll("&#39;", "'")
          .replaceAll("&gt;", ">")
          .replaceAll("&lt;", "<")
          .replaceAll("&amp;", "&");
        expect(() => JSON.parse(decoded), `${dir}: ${id} did not parse`).not.toThrow();
      }

      // …and every fragment link lands on an element that exists.
      const targets = [...html.matchAll(/href="#([^"]*)"/g)].map((match) => match[1]!);
      for (const target of targets) {
        expect(new Set(ids).has(target), `${dir}: dangling link #${target}`).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The dedupe sentence: every counted placement is named, for every shape
// ---------------------------------------------------------------------------

/**
 * The sentence's own arithmetic, read back off the rendered page.
 *
 * Deliberately generic. It does not know which kinds exist — it reads the total
 * the report announces and the parts it names, whatever they are called, so it
 * keeps working when a kind is added and fails when one is counted without
 * being named. Enumerating today's kinds here is what let two of them through.
 */
function bodySentence(html: string): { total: number; parts: { count: number; label: string }[] } {
  const paragraph = /<p class="sub">This report embeds[\s\S]*?<\/p>/.exec(html);
  if (paragraph === null) throw new Error("no body-count sentence in the report");
  const text = stripTags(paragraph[0]);
  const match = /This report embeds (\d+) bod(?:y|ies) — ([^.]+)\./.exec(text);
  if (match === null) throw new Error(`body-count sentence did not parse: ${text.slice(0, 160)}`);
  const parts = match[2]!
    .split(/, | and /)
    .map((part) => /^(\d+) (.+)$/.exec(part.trim()))
    .map((found, index) => {
      if (found === null) throw new Error(`part ${index + 1} is not "<count> <label>": ${text}`);
      return { count: Number(found[1]), label: found[2]! };
    });
  return { total: Number(match[1]), parts };
}

describe("the body-count sentence reconciles", () => {
  /**
   * The two axes that decide which kinds a report holds: whether a `tools/list`
   * result is present, and whether two hook payloads share a large `toolkits`
   * object. Every combination, including neither — round 2's finding was one of
   * these four and had no fixture.
   */
  const SHAPES = [
    { name: "hook-only-no-shared", hookPayloads: [smallPayload("a")], toolsListResult: null },
    {
      name: "both-no-shared",
      hookPayloads: [smallPayload("a")],
      toolsListResult: TOOLS_LIST_RESULT,
    },
    { name: "hook-only-shared", hookPayloads: sharedPayloads(), toolsListResult: null },
    { name: "both-shared", hookPayloads: sharedPayloads(), toolsListResult: TOOLS_LIST_RESULT },
    { name: "neither", hookPayloads: [], toolsListResult: null },
  ] as const;

  /** Renders one shape through the real CLI and returns the page. */
  async function renderShape(shape: (typeof SHAPES)[number]) {
    const dir = await writeShape(join(scratch, "shapes"), shape.name, {
      hookPayloads: [...shape.hookPayloads],
      toolsListResult: shape.toolsListResult === null ? null : [...shape.toolsListResult],
    });
    const { html } = await renderDir(dir, `shape-${shape.name}.html`);
    return html;
  }

  test("a report with no bodies at all says so", async () => {
    const html = await renderShape(SHAPES[4]);
    expect(html).toContain("No payloads in this report.");
    expect(html).not.toContain("This report embeds");
  });

  test.each([
    ["hook-only-no-shared", 1, ["1 hook payload"]],
    ["both-no-shared", 2, ["1 hook payload", "1 tools/list result"]],
    // The two round-2 found false: the shared `toolkits` object was counted in
    // the total and named nowhere, so the sentence announced four bodies and
    // accounted for two.
    ["hook-only-shared", 4, ["2 hook payloads", "2 shared toolkits objects"]],
    [
      "both-shared",
      5,
      ["2 hook payloads", "2 shared toolkits objects", "1 tools/list result"],
    ],
  ] as const)("%s announces %i bodies and names every one", async (name, total, expected) => {
    const shape = SHAPES.find((candidate) => candidate.name === name)!;
    const html = await renderShape(shape);
    const sentence = bodySentence(html);

    expect(sentence.total).toBe(total);
    expect(sentence.parts.map((part) => `${part.count} ${part.label}`)).toEqual([...expected]);
    // The property the two false shapes broke, asserted directly.
    expect(sentence.parts.reduce((sum, part) => sum + part.count, 0)).toBe(sentence.total);
  }, 30_000);

  test("the total is the sum of the named parts, whatever the kinds are", async () => {
    // The structural guard. It names no kind, so a placement kind added later
    // and counted without being named fails here even with no fixture of its
    // own — which is exactly how the last two findings reached a reviewer.
    const dirs = [
      FIXTURE_DIR,
      PROFILE_DIRS.identical,
      PROFILE_DIRS.varied,
      PROFILE_DIRS.paged,
      ISSUE_25_DIRS.differs,
      TOOLS_LIST_DIR,
      await writeShape(join(scratch, "shapes"), "reconcile-shared", {
        hookPayloads: sharedPayloads(),
        toolsListResult: [...TOOLS_LIST_RESULT],
      }),
    ];

    for (const dir of dirs) {
      const { html } = await renderDir(dir, `reconcile-${dir.replaceAll("/", "-")}.html`);
      const { total, parts } = bodySentence(html);

      expect(parts.length, `${dir}: no parts named`).toBeGreaterThan(0);
      expect(parts.reduce((sum, part) => sum + part.count, 0), `${dir} does not reconcile`).toBe(
        total,
      );
      // No kind is named with nothing to show, and none is named twice — either
      // would let the arithmetic agree while the sentence misled.
      for (const part of parts) expect(part.count, `${dir}: "${part.label}"`).toBeGreaterThan(0);
      expect(new Set(parts.map((part) => part.label)).size).toBe(parts.length);
    }
  }, 60_000);
});
