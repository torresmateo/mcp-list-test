/**
 * The probe's reader for the hook counter — DESIGN.md decision 5, step 5.
 *
 * The hook payload carries `user_id` and little else, so the generated id is
 * the only correlation key, and "which request caused this hit" is answered by
 * running serially and waiting for the count to stop moving. That is the
 * quiescence window: read `GET /hits?user_id=`, and keep reading until the
 * count has not changed for `quiesceMs`.
 *
 * Every failure here is loud. A counter that cannot be reached, a non-200, or
 * a body that is not the documented shape all throw, because the alternative
 * is returning 0 — and a 0 that means "I could not ask" is indistinguishable
 * from a 0 that means "the hook never fired", which is the exact thing this
 * project exists to measure.
 */

/**
 * One hit exactly as `GET /hits` returned it. Never projected or reshaped.
 *
 * The index signature is the point. `receivedAt` is the only field the probe
 * itself reads, and the counter keeps growing what it records per hit —
 * slice #15 added the request headers, `toolkitCount`, `toolCount`,
 * `versionCount`, `bodyBytes` and `handlingMs`, and more may follow. Naming
 * those here would invite the next reader to build a hit field by field, and a
 * field nobody thought to copy is a field the engine team never sees. The probe
 * is a courier: it hands on what arrived.
 */
export interface HookHit {
  receivedAt: string;
  [field: string]: unknown;
}

/** A settled reading of the counter for one user id. */
export interface HitsSnapshot {
  count: number;
  hits: HookHit[];
  /** How long the quiescence poll took, in milliseconds. */
  waitedMs: number;
  /** How many reads it took to settle. */
  reads: number;
}

export class HitsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HitsError";
  }
}

export interface HitsClientOptions {
  /** Base URL of the hook counter, e.g. `http://127.0.0.1:3411`. */
  baseUrl: string;
  /** How long the count must hold still. DESIGN.md default is 2000 ms. */
  quiesceMs?: number;
  /** Gap between reads. Defaults to a quarter of the window, at most 250 ms. */
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class HitsClient {
  readonly hitsUrl: string;
  private readonly quiesceMs: number;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HitsClientOptions) {
    this.hitsUrl = `${options.baseUrl.replace(/\/+$/, "")}/hits`;
    this.quiesceMs = options.quiesceMs ?? 2000;
    this.pollIntervalMs =
      options.pollIntervalMs ?? Math.max(10, Math.min(250, Math.floor(this.quiesceMs / 4)));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** One read of the counter. Anything unexpected throws rather than returning 0. */
  async read(userId: string): Promise<{ count: number; hits: HookHit[] }> {
    const url = `${this.hitsUrl}?user_id=${encodeURIComponent(userId)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch (error) {
      throw new HitsError(`hook counter unreachable at ${url}: ${describe(error)}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new HitsError(`hook counter answered ${response.status} for ${url}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new HitsError(`hook counter returned a non-JSON body for ${url}`, { cause: error });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new HitsError(`hook counter returned ${JSON.stringify(body)} for ${url}`);
    }
    const record = body as Record<string, unknown>;
    const count = record["count"];
    const hits = record["hits"];
    if (typeof count !== "number" || !Array.isArray(hits)) {
      throw new HitsError(`hook counter answer for ${url} has no { count, hits }`);
    }
    return { count, hits: hits as HookHit[] };
  }

  /**
   * Reads until the count has held still for the quiescence window.
   *
   * The window starts over every time the count moves, so a gateway that fans
   * a request out to several hook calls is waited out rather than caught
   * mid-flight.
   */
  async snapshot(userId: string): Promise<HitsSnapshot> {
    const startedAt = performance.now();
    let reads = 0;
    let latest = await this.read(userId);
    reads += 1;
    let stableSince = performance.now();

    for (;;) {
      const elapsed = performance.now() - stableSince;
      if (elapsed >= this.quiesceMs) break;
      await sleep(Math.min(this.pollIntervalMs, this.quiesceMs - elapsed));
      const next = await this.read(userId);
      reads += 1;
      if (next.count !== latest.count) stableSince = performance.now();
      latest = next;
    }

    return {
      count: latest.count,
      hits: latest.hits,
      waitedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      reads,
    };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}
