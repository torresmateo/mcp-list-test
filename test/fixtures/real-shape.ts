/**
 * The shape the live run actually produced, rebuilt on demand.
 *
 * Issue #25 was filed against measured evidence: five runs against the real
 * Arcade gateway produced a 26.09 MB `results/report.html`. Per session there
 * are **four hook hits** — `initialize` causes two, one 15,340 B hit carrying
 * 2 toolkits and 40 tools and one 1,598,220 B hit carrying 125 toolkits and
 * 8,258 tools; `tools/list` causes two, both 15,340 B — and three of the four
 * payloads in a session are byte-identical to each other.
 *
 * **Corrected 2026-09-19.** An earlier version of this file encoded the claim
 * that the catalogue payload is *byte-identical across all five runs*. It is
 * not. Verified on the operator's real run files:
 *
 * ```
 * full payload sha : 6745972720, 7df6d57d53, 4b72142c07, ec99e22d00, 0711875b38
 * toolkits sha     : da65f51679 x5
 * payload keys     : ["toolkits", "user_id"]
 * ```
 *
 * The five payloads differ, and they differ **only in `user_id`** — their
 * `toolkits` objects are identical. Whole-payload deduplication is therefore
 * right to decline collapsing them, and the saving comes from storing the
 * shared `toolkits` object once instead. The old fixture measured a shape that
 * does not occur and flattered the feature, which is worse than having no
 * fixture at all.
 *
 * This is a builder rather than committed JSON because the files are ~1.7 MB
 * each: committing five of them would put 8 MB of generated data in a repo
 * whose whole point is a handful of run files. A test that needs the data
 * creates it, which is also what makes it exist in a fresh worktree.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** The measured byte sizes, from `results/report.html` of the live run. */
export const SMALL_BODY_BYTES = 15_340;
export const CATALOGUE_BODY_BYTES = 1_598_220;

export const SMALL_TOOLKITS = 2;
export const SMALL_TOOLS = 40;
export const CATALOGUE_TOOLKITS = 125;
export const CATALOGUE_TOOLS = 8_258;

/**
 * What one catalogue payload costs the report as a stored `<pre>`: compact JSON
 * with the HTML escape applied, measured at 2,610,190 characters on the real
 * file (five of them, 13.05 MB of a 13.37 MB report).
 *
 * Compact size alone does not predict that — escaping charges five characters
 * for every `"` — so the generated catalogue is calibrated to land on it, by
 * giving a deterministic fraction of tools an extra field. Without the
 * calibration the fixture would understate what the real file pays and so
 * understate what the saving is worth.
 */
export const CATALOGUE_STORED_CHARS = 2_610_190;

/** How often a tool carries the extra `tags` field. See {@link CATALOGUE_STORED_CHARS}. */
const TAGGED_EVERY = 9;

type ToolVersions = {
  version: string;
  metadata: {
    scopes: string[];
    category: string;
    deprecated: boolean;
    description: string;
    tags?: string[];
  };
}[];
type Toolkits = Record<string, { tools: Record<string, ToolVersions> }>;

interface Payload {
  user_id: string;
  toolkits: Toolkits;
}

function toolkits(toolkitCount: number, toolCount: number): Toolkits {
  const built: Toolkits = {};
  for (let index = 0; index < toolCount; index += 1) {
    const toolkit = `Toolkit_${String(index % toolkitCount).padStart(3, "0")}`;
    built[toolkit] ??= { tools: {} };
    built[toolkit]!.tools[`Tool_${String(index).padStart(4, "0")}`] = [
      {
        version: "1.0.0",
        metadata: {
          scopes: ["read", "write"],
          category: "operations",
          deprecated: false,
          description: "",
          // Not every tool carries the same fields in a real catalogue, and the
          // quote count is what the HTML escape charges for. See
          // CATALOGUE_STORED_CHARS.
          ...(index % TAGGED_EVERY === 0 ? { tags: ["beta"] } : {}),
        },
      },
    ];
  }
  return built;
}

/**
 * Builds a payload whose compact JSON is **exactly** `bodyBytes` long.
 *
 * The filler is spread across every tool's `description` rather than heaped on
 * one, and that is not cosmetic. What the report emits is the payload
 * *pretty-printed and HTML-escaped*, and both of those inflate structure — one
 * indent per nesting level, six characters per `"` — not bulk text. A payload
 * padded with one long run of `x` would serialise to the right number of bytes
 * and then inflate barely at all, which would make this fixture understate the
 * very saving it exists to measure.
 *
 * Every character used is ASCII, so one added character is one added byte, and
 * the measured size is hit exactly: issue #25's criterion 9 is a claim about
 * how much a report shrinks, and an approximate fixture would make it an
 * approximate claim.
 */
function payload(
  userId: string,
  toolkitCount: number,
  toolCount: number,
  bodyBytes: number,
): Payload {
  const built: Payload = { user_id: userId, toolkits: toolkits(toolkitCount, toolCount) };
  const versions = Object.values(built.toolkits).flatMap((toolkit) =>
    Object.values(toolkit.tools),
  );
  const short = JSON.stringify(built).length;
  const padding = bodyBytes - short;
  if (padding < 0) {
    throw new Error(
      `cannot reach ${bodyBytes} bytes: ${toolCount} tools already serialise to ${short}`,
    );
  }
  const each = Math.floor(padding / versions.length);
  versions.forEach((version, index) => {
    const extra = index === versions.length - 1 ? padding - each * versions.length : 0;
    version[0]!.metadata.description = description(each + extra);
  });
  return built;
}

/**
 * `n` characters of plausible tool description.
 *
 * Words and punctuation rather than one repeated character, so the pretty-print
 * and the HTML escape behave the way they do on a real catalogue.
 */
function description(n: number): string {
  const words = "Sends reads lists updates deletes the resource for the calling user ";
  return words.repeat(Math.ceil(n / words.length)).slice(0, n);
}

/**
 * The catalogue `toolkits` object, built once and shared by every session — the
 * one thing the real runs genuinely have in common.
 *
 * Padded against a reference `user_id`, and every generated id is the same
 * length, so each session's catalogue payload serialises to exactly
 * {@link CATALOGUE_BODY_BYTES} while differing from the others in that field
 * alone. That is the measured shape: five payloads, five digests, one
 * `toolkits`.
 */
const catalogueToolkits = payload(
  probeUserId(1),
  CATALOGUE_TOOLKITS,
  CATALOGUE_TOOLS,
  CATALOGUE_BODY_BYTES,
).toolkits;

/** One session's catalogue payload: its own id, everyone's `toolkits`. */
function cataloguePayload(userId: string): Payload {
  return { user_id: userId, toolkits: catalogueToolkits };
}

function hit(receivedAt: string, body: Payload, toolkitCount: number, toolCount: number) {
  return {
    receivedAt,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer <redacted len=43 sha256=1f3a9c2b>",
      "user-agent": "arcade-engine/1.0",
    },
    toolkitCount,
    toolCount,
    versionCount: toolCount,
    bodyBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
    handlingMs: 0.5,
    payload: body,
  };
}

/**
 * The generated user id for one repetition.
 *
 * Fixed width on purpose: the catalogue payloads must differ in this field and
 * agree on their byte count, which is exactly what the real run files do.
 */
function probeUserId(repetition: number): string {
  return `probe-2025-11-25-178976880000${repetition}-${repetition}`;
}

/** One run file in the measured shape: 4 hits, 2 on `initialize`, 2 on `tools/list`. */
export function realShapeRun(repetition: number) {
  const userId = probeUserId(repetition);
  const small = payload(userId, SMALL_TOOLKITS, SMALL_TOOLS, SMALL_BODY_BYTES);
  const stamp = (offsetMs: number) =>
    new Date(Date.UTC(2026, 8, 18, 22, 0, repetition, offsetMs)).toISOString();

  return {
    schema: 1,
    revisionRequested: "2025-11-25",
    revisionNegotiated: "2025-11-25",
    status: "ok",
    userId,
    hookPublicUrl: "https://fixture-tunnel.ngrok.app",
    protocolEra: "legacy",
    startedAt: stamp(0),
    finishedAt: stamp(900),
    requests: [
      {
        id: 0,
        jsonRpcId: 0,
        method: "initialize",
        sentAt: stamp(10),
        finishedAt: stamp(240),
        durationMs: 230.5,
        status: 200,
        userIdHeader: userId,
        authorizationScheme: "Bearer",
        responseObserved: true,
        hookHitsAfter: 2,
      },
      {
        id: 1,
        jsonRpcId: 1,
        method: "tools/list",
        sentAt: stamp(300),
        finishedAt: stamp(620),
        durationMs: 320.25,
        status: 200,
        userIdHeader: userId,
        authorizationScheme: "Bearer",
        responseObserved: true,
        hookHitsAfter: 4,
      },
    ],
    hookHits: [
      hit(stamp(60), small, SMALL_TOOLKITS, SMALL_TOOLS),
      hit(stamp(120), cataloguePayload(userId), CATALOGUE_TOOLKITS, CATALOGUE_TOOLS),
      hit(stamp(380), small, SMALL_TOOLKITS, SMALL_TOOLS),
      hit(stamp(440), small, SMALL_TOOLKITS, SMALL_TOOLS),
    ],
    toolsListed: 40,
    gmailToolsListed: 0,
    toolsListRequests: 1,
    cursorFollowed: false,
    toolsListDurationMs: 320.25,
    error: null,
  };
}

/**
 * Writes `repetitions` run files in the measured shape into `dir` and returns
 * their filenames, sorted the way the renderer loads them.
 */
export async function writeRealShapeRuns(dir: string, repetitions = 5): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const run = realShapeRun(repetition);
    const file = `2026091822000${repetition}Z-2025-11-25-${repetition}.json`;
    await Bun.write(join(dir, file), JSON.stringify(run));
    files.push(file);
  }
  return files.sort();
}
