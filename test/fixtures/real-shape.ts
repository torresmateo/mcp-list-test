/**
 * The shape the live run actually produced, rebuilt on demand.
 *
 * Issue #25 was filed against measured evidence, not a hunch: five runs against
 * the real Arcade gateway produced a 26.0 MB `results/report.html` with twenty
 * `<pre>` blocks, five of them 5,061,881 characters each. Per session there are
 * **four hook hits**:
 *
 * - `initialize` causes two — one 15,340 B hit carrying 2 toolkits and 40
 *   tools, and one 1,598,220 B hit carrying 125 toolkits and 8,258 tools;
 * - `tools/list` causes two, both 15,340 B.
 *
 * Three of the four payloads in a session are byte-identical to each other (the
 * small ones, which carry the session's own `user_id`), and **the catalogue
 * payload is byte-identical across runs** — that last property is the one the
 * 20 MB of duplication came from, and it is reproduced here deliberately: the
 * catalogue hit carries a `user_id` that does not vary by session, because that
 * is what "byte-identical across all five runs" means. Why the gateway sends it
 * that way is a question for the engine team, not for the renderer.
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
 * The `user_id` on the catalogue payload.
 *
 * Constant across sessions on purpose — see the file header. Without it the
 * catalogue payloads would differ by one field and the cross-run duplication
 * issue #25 measured could not be reproduced at all.
 */
const CATALOGUE_USER_ID = "probe-2025-11-25-catalogue";

type ToolVersions = { version: string; metadata: { scopes: string[]; description: string } }[];
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
        metadata: { scopes: ["read", "write"], description: "" },
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
 * the measured size is hit exactly: issue #25's criterion 7 is a claim about
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

/** The catalogue payload, built once: every session sends the same bytes. */
const cataloguePayload = payload(
  CATALOGUE_USER_ID,
  CATALOGUE_TOOLKITS,
  CATALOGUE_TOOLS,
  CATALOGUE_BODY_BYTES,
);

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

/** One run file in the measured shape: 4 hits, 2 on `initialize`, 2 on `tools/list`. */
export function realShapeRun(repetition: number) {
  const userId = `probe-2025-11-25-178976880000${repetition}-${repetition}`;
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
      hit(stamp(120), cataloguePayload, CATALOGUE_TOOLKITS, CATALOGUE_TOOLS),
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
