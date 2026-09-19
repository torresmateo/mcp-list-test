/**
 * The shapes that decide which kinds of body a report holds.
 *
 * Two rounds of review found the dedupe sentence wrong, both times because a
 * kind of placement was counted without being named: first `tools/list`
 * results, then shared `toolkits` objects. Neither had a fixture, because both
 * fixtures that existed happened to hold the kinds the sentence already knew
 * about.
 *
 * So these are built by the axes that produce the kinds, not by example:
 * whether a `tools/list` result is present, and whether two hook payloads share
 * a `toolkits` object large enough to be stored once. Every combination,
 * including the empty one. A shape nobody thought to write down is what got
 * through twice.
 *
 * Generated rather than committed because the `shared` shapes need a `toolkits`
 * object over the 64 KiB share threshold, and a repository whose subject is a
 * handful of run files has no business carrying half a megabyte of them.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Comfortably over `TOOLKITS_STORE_MIN_BYTES`, so the share path engages. */
const SHARED_TOOLS = 900;

/**
 * A `toolkits` object big enough to be worth storing once.
 *
 * `extraTool` makes an object that is the same shape and nearly the same size
 * as another and still differs, for the case where two must *not* collapse.
 */
export function largeToolkits(extraTool?: string): Record<string, { tools: Record<string, unknown> }> {
  const tools: Record<string, unknown> = {};
  for (let index = 0; index < SHARED_TOOLS; index += 1) {
    tools[`Tool_${String(index).padStart(4, "0")}`] = [
      { version: "1.0.0", metadata: { description: "a listed tool, described".repeat(3) } },
    ];
  }
  if (extraTool !== undefined) tools[extraTool] = [{ version: "1.0.0" }];
  return { Slack: { tools } };
}

/** A payload small enough that nothing about it is ever stored separately. */
export function smallPayload(userId: string): unknown {
  return {
    user_id: userId,
    toolkits: { Slack: { tools: { PostMessage: [{ version: "1.0.0" }] } } },
  };
}

/** Two payloads that differ only in `user_id`, over one shared `toolkits`. */
export function sharedPayloads(): unknown[] {
  const toolkits = largeToolkits();
  return [
    { user_id: "probe-a", toolkits },
    { user_id: "probe-b", toolkits },
  ];
}

/** The `tools/list` result a run carries when it has one. */
export const TOOLS_LIST_RESULT = [{ name: "Slack_PostMessage", arcadeToolkit: "Slack" }];

export interface ShapeOptions {
  /** Hook payloads the run recorded, in arrival order. */
  hookPayloads: unknown[];
  /** `null` for a run that carries no `toolsListResult` field at all. */
  toolsListResult?: unknown[] | null;
}

/** One schema-1 run file holding exactly the bodies a shape calls for. */
export function shapeRun(options: ShapeOptions): Record<string, unknown> {
  const { hookPayloads, toolsListResult = null } = options;
  const run: Record<string, unknown> = {
    schema: 1,
    revisionRequested: "2025-11-25",
    revisionNegotiated: "2025-11-25",
    status: "ok",
    userId: "probe-2025-11-25-1789768900000-1",
    hookPublicUrl: "https://fixture-tunnel.ngrok.app",
    requests: [
      {
        id: 0,
        method: "initialize",
        sentAt: "2026-09-19T00:00:00.000Z",
        hookHitsAfter: 0,
      },
      {
        id: 1,
        method: "tools/list",
        sentAt: "2026-09-19T00:00:01.000Z",
        hookHitsAfter: hookPayloads.length,
      },
    ],
    hookHits: hookPayloads.map((payload, index) => ({
      receivedAt: `2026-09-19T00:00:0${index + 2}.000Z`,
      payload,
    })),
    toolsListed: 1,
    gmailToolsListed: 0,
    error: null,
  };
  // Absent, not null: a run file that predates #27 carries no key at all, and
  // the two are different statements everywhere else in this renderer.
  if (toolsListResult !== null) run["toolsListResult"] = toolsListResult;
  return run;
}

/** Writes one shape into its own directory and returns the path. */
export async function writeShape(parent: string, name: string, options: ShapeOptions): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "20260919T000000Z-2025-11-25-1.json"),
    JSON.stringify(shapeRun(options)),
  );
  return dir;
}
