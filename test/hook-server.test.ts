/**
 * Hook counter behaviour, driven entirely over HTTP — the same surface the
 * Arcade gateway and the probe use. Nothing here reaches inside the server.
 *
 * Two rules shape this file:
 *
 *  - **Ephemeral ports.** Every server binds port 0. A test that waited for
 *    `$PORT_WEB` would fail whenever the operator had the real hook server up.
 *  - **A private log per test.** `results/hook-log.jsonl` is shared mutable
 *    state; if these tests appended to it, criterion 5 (`wc -l` matches the
 *    count) would pass or fail on execution order and on what a previous run
 *    left behind. Each test gets a temp directory it creates and removes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HookServer, startHookServer } from "../src/hook-server/server.ts";

const TOKEN = "s3cret-hook-token";

/**
 * `Response.json()` is `unknown`, and these tests do know the contract shapes —
 * `DESIGN.md` Contracts -> Hook counter HTTP API. Toolkit values stay loose so
 * a test can reach into the nested tool metadata it posted.
 */
interface HitsResponse {
  count: number;
  hits: { receivedAt: string; payload: unknown }[];
}
/** Arbitrary gateway JSON; `any` here is what keeps a nested assertion readable. */
type Loose = Record<string, any>;

async function accessBody(response: Response): Promise<Loose> {
  return (await response.json()) as Loose;
}

/**
 * The exact payload from acceptance criterion 2: a denied toolkit and an
 * allowed one in the same body, so "Gmail is gone" and "Slack survived" are
 * both statements about a payload that demonstrably carried both.
 */
function mixedPayload(userId: string) {
  return {
    user_id: userId,
    toolkits: {
      Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } },
      Slack: { tools: { Post: [{ version: "1.0.0" }] } },
    },
  };
}

interface Harness {
  server: HookServer;
  post(body: unknown, init?: RequestInit): Promise<Response>;
  hits(userId: string): Promise<HitsResponse>;
  count(userId: string): Promise<number>;
  logLines(): string[];
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** A server on an ephemeral port writing to a temp log, torn down after the test. */
function harness(token: string = TOKEN): Harness {
  const dir = mkdtempSync(join(tmpdir(), "hook-counter-"));
  const server = startHookServer({ port: 0, token, logPath: join(dir, "hook-log.jsonl") });
  cleanups.push(() => {
    void server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown, init: RequestInit = {}) =>
    fetch(`${server.url}/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    });

  const hits = async (userId: string): Promise<HitsResponse> => {
    const response = await fetch(`${server.url}/hits?user_id=${encodeURIComponent(userId)}`);
    expect(response.status).toBe(200);
    return (await response.json()) as HitsResponse;
  };

  return {
    server,
    post,
    hits,
    count: async (userId) => (await hits(userId)).count,
    logLines: () =>
      readFileSync(server.logPath, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
  };
}

describe("GET /healthz", () => {
  test("answers 200 (criterion 1)", async () => {
    const { server } = harness();
    const response = await fetch(`${server.url}/healthz`);
    expect(response.status).toBe(200);
  });
});

describe("POST /access — the Gmail deny (criterion 2)", () => {
  test("removes Gmail and keeps Slack, from a payload that carried both", async () => {
    const h = harness();
    const sent = mixedPayload("u1");
    expect(Object.keys(sent.toolkits)).toEqual(["Gmail", "Slack"]);

    const response = await h.post(sent);
    expect(response.status).toBe(200);

    const body = await accessBody(response);
    // Both halves. "No Gmail" alone cannot tell a working filter from a
    // payload that never mentioned Gmail.
    expect(Object.keys(body.toolkits)).toEqual(["Slack"]);
    expect(body.toolkits.Slack).toEqual({ tools: { Post: [{ version: "1.0.0" }] } });
    expect(body.toolkits).not.toHaveProperty("Gmail");
    expect(body.user_id).toBe("u1");
  });

  test.each(["Gmail", "gmail", "GMAIL", "GmAiL"])(
    "denies %p — the match is case-insensitive",
    async (name) => {
      const h = harness();
      const response = await h.post({
        user_id: "u1",
        toolkits: { [name]: { tools: { SendEmail: [{ version: "1.0.0" }] } }, Slack: { tools: {} } },
      });
      const body = await accessBody(response);
      expect(Object.keys(body.toolkits)).toEqual(["Slack"]);
    },
  );

  test.each(["Gmailish", "gmail-labs", "NotGmail", "my.gmail", "gmai", " Gmail"])(
    "allows %p — the match is exact, not a substring",
    async (name) => {
      const h = harness();
      const response = await h.post({
        user_id: "u1",
        toolkits: { [name]: { tools: { Thing: [{ version: "1.0.0" }] } }, Slack: { tools: {} } },
      });
      const body = await accessBody(response);
      expect(Object.keys(body.toolkits).sort()).toEqual([name, "Slack"].sort());
    },
  );

  test("keeps every other toolkit and every other top-level field intact", async () => {
    const h = harness();
    const response = await h.post({
      user_id: "u1",
      trace_id: "abc-123",
      toolkits: {
        Gmail: { tools: { SendEmail: [{ version: "1.0.0", metadata: { scope: "send" } }] } },
        Slack: { tools: { Post: [{ version: "2.1.0", metadata: { scope: "chat" } }] } },
        GitHub: { tools: { ListRepos: [{ version: "1.0.0" }] } },
      },
    });
    const body = await accessBody(response);
    expect(Object.keys(body.toolkits).sort()).toEqual(["GitHub", "Slack"]);
    expect(body.toolkits.Slack.tools.Post[0].metadata).toEqual({ scope: "chat" });
    expect(body.trace_id).toBe("abc-123");
  });

  test("the denial is in the response only — the stored payload stays raw", async () => {
    const h = harness();
    const sent = mixedPayload("u1");
    await h.post(sent);

    const { hits } = await h.hits("u1");
    // DESIGN.md run JSON attaches raw hook payloads as evidence; a filtered
    // copy would quietly destroy the thing the engine team needs to see.
    expect(hits[0]?.payload).toEqual(sent);
    expect((hits[0]?.payload as typeof sent).toolkits).toHaveProperty("Gmail");
  });
});

describe("POST /access — the bearer check fails closed (criterion 3)", () => {
  const rejected: [string, RequestInit][] = [
    ["no Authorization header at all", { headers: { "content-type": "application/json" } }],
    ["an empty Authorization header", { headers: { authorization: "" } }],
    ["Bearer with an empty token", { headers: { authorization: "Bearer " } }],
    ["Bearer with only whitespace", { headers: { authorization: "Bearer    " } }],
    ["a misspelled token", { headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}x` } }],
    ["a token with the wrong case", { headers: { authorization: `Bearer ${TOKEN.toUpperCase()}` } }],
    ["a truncated token", { headers: { authorization: `Bearer ${TOKEN.slice(0, 5)}` } }],
    ["a token with trailing junk", { headers: { authorization: `Bearer ${TOKEN}extra` } }],
    ["the right token under the wrong scheme", { headers: { authorization: `Basic ${TOKEN}` } }],
    ["the bare token with no scheme", { headers: { authorization: TOKEN } }],
  ];

  for (const [label, init] of rejected) {
    test(`401s on ${label}, and the count is unchanged`, async () => {
      const h = harness();
      // Establish a non-zero baseline first: asserting "still 0" cannot tell a
      // rejected request from a server that counts nothing at all.
      const accepted = await h.post(mixedPayload("u1"));
      expect(accepted.status).toBe(200);
      const before = await h.count("u1");
      expect(before).toBe(1);
      const linesBefore = h.logLines().length;

      const response = await h.post(mixedPayload("u1"), init);
      expect(response.status).toBe(401);

      expect(await h.count("u1")).toBe(before);
      expect(h.logLines().length).toBe(linesBefore);
    });
  }

  test("a rejected request is not counted even under a fresh user id", async () => {
    const h = harness();
    const response = await h.post(mixedPayload("scanner"), { headers: {} });
    expect(response.status).toBe(401);
    expect(await h.count("scanner")).toBe(0);
    expect(h.logLines()).toHaveLength(0);
  });

  test("a 401 body carries no toolkit data back to the caller", async () => {
    const h = harness();
    const response = await h.post(mixedPayload("u1"), { headers: {} });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("Slack");
  });

  test("the server refuses to start with a blank token", () => {
    // Otherwise `Bearer <anything>` — or a blank bearer — would be a valid hit
    // on a URL that is public by design (DESIGN.md decision 7).
    expect(() => startHookServer({ port: 0, token: "" })).toThrow(/non-empty bearer token/);
    expect(() => startHookServer({ port: 0, token: "   " })).toThrow(/non-empty bearer token/);
  });
});

describe("GET /hits (criterion 4)", () => {
  test("after two accepted posts the count is 2 with receivedAt and the raw payload", async () => {
    const h = harness();
    const first = mixedPayload("u1");
    const second = { ...mixedPayload("u1"), trace_id: "second" };
    expect((await h.post(first)).status).toBe(200);
    expect((await h.post(second)).status).toBe(200);

    const body = await h.hits("u1");
    expect(body.count).toBe(2);
    expect(body.hits).toHaveLength(2);
    expect(body.hits.map((hit) => hit.payload)).toEqual([first, second]);
    for (const hit of body.hits) {
      expect(typeof hit.receivedAt).toBe("string");
      expect(new Date(hit.receivedAt).toISOString()).toBe(hit.receivedAt);
    }
  });

  test("counts are keyed by user_id and do not leak between users", async () => {
    const h = harness();
    await h.post(mixedPayload("u1"));
    await h.post(mixedPayload("u2"));
    await h.post(mixedPayload("u2"));

    expect(await h.count("u1")).toBe(1);
    expect(await h.count("u2")).toBe(2);
    expect((await h.hits("u2")).hits.every((hit) => (hit.payload as { user_id: string }).user_id === "u2")).toBe(true);
  });

  test("an unknown user id is an explicit empty answer, not an error", async () => {
    const h = harness();
    await h.post(mixedPayload("u1"));
    const body = await h.hits("never-seen");
    expect(body).toEqual({ count: 0, hits: [] });
  });

  test("a request with no user_id is a 400, not a silent zero", async () => {
    const h = harness();
    // A zero here would read as "this user had no hits" and mislead the probe.
    expect((await fetch(`${h.server.url}/hits`)).status).toBe(400);
    expect((await fetch(`${h.server.url}/hits?user_id=`)).status).toBe(400);
  });
});

describe("results/hook-log.jsonl (criterion 5)", () => {
  test("one line per accepted hit, and the line count matches /hits", async () => {
    const h = harness();
    const sent = [mixedPayload("u1"), mixedPayload("u1"), mixedPayload("u2")];
    for (const payload of sent) expect((await h.post(payload)).status).toBe(200);

    const lines = h.logLines();
    expect(lines).toHaveLength(3);
    expect(lines.length).toBe((await h.count("u1")) + (await h.count("u2")));
  });

  test("every line is one parseable JSON record with receivedAt and the raw payload", async () => {
    const h = harness();
    await h.post(mixedPayload("u1"));
    await h.post({ user_id: "u2", toolkits: { Slack: { tools: {} } }, note: "line\nbreak" });

    const records = h.logLines().map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].payload).toEqual(mixedPayload("u1"));
    expect(new Date(records[0].receivedAt).toISOString()).toBe(records[0].receivedAt);
    // A newline inside a value must not become a second line.
    expect(records[1].payload.note).toBe("line\nbreak");
  });

  test("the log is written before the response, so a reader never sees a stale count", async () => {
    const h = harness();
    await h.post(mixedPayload("u1"));
    expect(h.logLines()).toHaveLength(1);
  });

  test("the log directory and an empty log are created when they do not exist", () => {
    // `results/` is gitignored, so it is absent in a fresh worktree; a test or
    // a `wc -l` that needs the file must not depend on a previous run.
    const dir = mkdtempSync(join(tmpdir(), "hook-counter-nested-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const server = startHookServer({
      port: 0,
      token: TOKEN,
      logPath: join(dir, "deep", "nested", "hook-log.jsonl"),
    });
    cleanups.push(() => void server.close());
    // Zero hits reads as an empty file, not as a missing one.
    expect(readFileSync(server.logPath, "utf8")).toBe("");
  });

  test("restarting against an existing log appends rather than truncating", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-counter-restart-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const logPath = join(dir, "hook-log.jsonl");

    const first = startHookServer({ port: 0, token: TOKEN, logPath });
    await fetch(`${first.url}/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(mixedPayload("u1")),
    });
    await first.close();

    const second = startHookServer({ port: 0, token: TOKEN, logPath });
    cleanups.push(() => void second.close());
    await fetch(`${second.url}/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(mixedPayload("u1")),
    });

    expect(readFileSync(logPath, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    // The in-memory count is per process; the file is the durable record.
    const response = await fetch(`${second.url}/hits?user_id=u1`);
    expect(((await response.json()) as HitsResponse).count).toBe(1);
  });
});

describe("the rest of the HTTP surface", () => {
  test("a body that is not a JSON object is a 400 and is not counted", async () => {
    const h = harness();
    expect((await h.post("{not json")).status).toBe(400);
    expect((await h.post([1, 2, 3])).status).toBe(400);
    expect((await h.post("null")).status).toBe(400);
    expect(await h.count("u1")).toBe(0);
    expect(h.logLines()).toHaveLength(0);
  });

  test("a payload with no usable user_id is a 400 and is not counted", async () => {
    const h = harness();
    expect((await h.post({ toolkits: {} })).status).toBe(400);
    expect((await h.post({ user_id: "", toolkits: {} })).status).toBe(400);
    expect((await h.post({ user_id: 7, toolkits: {} })).status).toBe(400);
    expect(h.logLines()).toHaveLength(0);
  });

  test("there are no endpoints beyond /access, /hits and /healthz", async () => {
    const h = harness();
    for (const path of ["/", "/metrics", "/access/", "/hits/all"]) {
      expect((await fetch(`${h.server.url}${path}`)).status).toBe(404);
    }
  });

  test("the wrong method on a known path is a 405", async () => {
    const h = harness();
    expect((await fetch(`${h.server.url}/access`)).status).toBe(405);
    expect((await fetch(`${h.server.url}/hits?user_id=u1`, { method: "POST" })).status).toBe(405);
  });
});

describe("startHookServer as a library", () => {
  test("binds an ephemeral port and reports the one it got", async () => {
    const a = harness();
    const b = harness();
    expect(a.server.port).toBeGreaterThan(0);
    expect(b.server.port).toBeGreaterThan(0);
    expect(a.server.port).not.toBe(b.server.port);
    // Two counters at once, each with its own log: what slice #3 needs.
    await a.post(mixedPayload("u1"));
    expect(await a.count("u1")).toBe(1);
    expect(await b.count("u1")).toBe(0);
  });

  test("close() stops answering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-counter-close-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const server = startHookServer({ port: 0, token: TOKEN, logPath: join(dir, "log.jsonl") });
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    await server.close();
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
  });
});
