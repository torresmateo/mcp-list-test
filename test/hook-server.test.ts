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
interface Hit {
  receivedAt: string;
  headers: Record<string, string>;
  toolkitCount: number;
  toolCount: number;
  versionCount: number;
  bodyBytes: number;
  handlingMs: number;
  payload: unknown;
}
interface HitsResponse {
  count: number;
  hits: Hit[];
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

describe("POST /access — the answer is Arcade's deny list (issue #21)", () => {
  /**
   * The whole point of this slice. `AccessHookResult` is
   * `{ only?: Toolkits, deny?: Toolkits }` — see DESIGN.md decision 6 as
   * amended — and the engine reads a response carrying neither field as
   * *no change*. The hook used to answer with the request body minus Gmail:
   * that carries neither field, so it denied nothing at all while looking to a
   * human exactly like a deny.
   */
  test("names the denied toolkit under `deny`, carrying its tools as received", async () => {
    const h = harness();
    const sent = mixedPayload("u1");
    expect(Object.keys(sent.toolkits)).toEqual(["Gmail", "Slack"]);

    const response = await h.post(sent);
    expect(response.status).toBe(200);

    const body = await accessBody(response);
    // The whole body, not a spot check: an extra key here is a different
    // contract, and `deny`'s value has to be the ToolkitInfo that arrived.
    expect(body).toEqual({ deny: { Gmail: { tools: { SendEmail: [{ version: "1.0.0" }] } } } });
  });

  test("the response is not the request body: no user_id, no toolkits, no passthrough", async () => {
    // The old bug, stated as the assertion that would have caught it. Every
    // line below passed *before* this slice under the "Gmail is denied"
    // reading, because a filtered echo looks like a deny — and none of them
    // passes against the echo itself.
    const h = harness();
    const response = await h.post({ ...mixedPayload("u1"), trace_id: "abc-123" });

    const body = await accessBody(response);
    expect(Object.keys(body)).toEqual(["deny"]);
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("toolkits");
    expect(body).not.toHaveProperty("trace_id");
    expect(body).not.toHaveProperty("only");
    // The allowed toolkit is absent from the answer entirely — `deny` names
    // what is denied, and an allow list would be the `only` field instead.
    expect(JSON.stringify(body)).not.toContain("Slack");
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
      // The key is the toolkit name exactly as the gateway spelled it: the
      // engine matches what it sent us, not a normalised copy.
      expect(Object.keys(body.deny)).toEqual([name]);
      expect(body.deny[name]).toEqual({ tools: { SendEmail: [{ version: "1.0.0" }] } });
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
      // Nothing matched, so nothing is denied — and criterion 2's empty answer
      // is the one asserted below.
      expect(body).toEqual({});
    },
  );

  test("a request carrying no denied toolkit answers exactly `{}`", async () => {
    // Criterion 2. `{}` is the choice — it is what DESIGN.md's Contracts entry
    // pins — and it means "no change", which is the same thing the old bug
    // accidentally said about *every* request. Deliberate here: a payload with
    // no Gmail in it is one this policy has no opinion about. Pinned so a
    // future edit cannot drift it into `{"deny":{}}` or a filtered echo
    // unnoticed.
    const h = harness();
    for (const sent of [
      { user_id: "u1", toolkits: { Slack: { tools: { Post: [{ version: "1.0.0" }] } } } },
      { user_id: "u2", toolkits: {} },
      { user_id: "u3", toolkits: "not-an-object" },
      { user_id: "u4" },
    ]) {
      const body = await accessBody(await h.post(sent));
      expect(body).toEqual({});
      expect(Object.keys(body)).toEqual([]);
    }
  });

  test("denies every matching toolkit and only those, from a three-toolkit payload", async () => {
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
    expect(Object.keys(body.deny)).toEqual(["Gmail"]);
    // Nested metadata rides along untouched: the engine denies the versions it
    // told us about, not a reconstruction of them.
    expect(body.deny.Gmail.tools.SendEmail[0].metadata).toEqual({ scope: "send" });
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

/**
 * The fixture is the criterion (issue #15, criterion 4): two toolkits, four
 * tools, and one tool carrying two version entries, so the three counts are
 * three *different* numbers.
 *
 *   toolkitCount 2, toolCount 4, versionCount 5
 *
 * The three plausible-but-wrong readings of `versionCount` all miss:
 * "tools that carry versions" is 4 (= toolCount), "distinct version strings"
 * is 3 (1.0.0, 2.0.0, 3.1.0), "toolkits" is 2. A payload where every tool has
 * exactly one version makes all of them agree and would pass against any of
 * the wrong implementations.
 */
function shapedPayload(userId: string) {
  return {
    user_id: userId,
    toolkits: {
      Slack: {
        tools: {
          PostMessage: [
            { version: "1.0.0", metadata: { scope: "chat:write" } },
            { version: "2.0.0", metadata: { scope: "chat:write" } },
          ],
          ListChannels: [{ version: "1.0.0" }],
        },
      },
      GitHub: {
        tools: {
          ListRepos: [{ version: "1.0.0" }],
          CreateIssue: [{ version: "3.1.0" }],
        },
      },
    },
  };
}

/** Post with full control of the headers, the bearer included. */
function postWith(url: string, headers: Record<string, string>, body: string): Promise<Response> {
  return fetch(`${url}/access`, { method: "POST", headers, body });
}

describe("the recorded profile — derived counts (criteria 1, 4)", () => {
  test("toolkitCount, toolCount and versionCount are three different numbers", async () => {
    const h = harness();
    expect((await h.post(shapedPayload("u1"))).status).toBe(200);

    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.toolkitCount).toBe(2);
    expect(hit.toolCount).toBe(4);
    expect(hit.versionCount).toBe(5);

    // Stated as inequalities too, so a future fixture that let the three
    // collide would fail here rather than quietly weaken the test.
    expect(hit.versionCount).not.toBe(hit.toolCount);
    expect(hit.versionCount).not.toBe(hit.toolkitCount);
    expect(hit.toolCount).not.toBe(hit.toolkitCount);
  });

  test("versionCount counts entries, not tools with versions or distinct strings", async () => {
    const h = harness();
    await h.post({
      user_id: "u1",
      toolkits: {
        Slack: {
          tools: {
            // Three entries on one tool, two of them the same version string.
            Post: [{ version: "1.0.0" }, { version: "1.0.0" }, { version: "2.0.0" }],
          },
        },
        GitHub: { tools: { ListRepos: [{ version: "1.0.0" }] } },
      },
    });

    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.toolCount).toBe(2); // "tools that carry versions" would say 2
    expect(hit.versionCount).toBe(4); // distinct strings would say 2
  });

  test("the counts describe the payload that arrived, not the filtered answer", async () => {
    const h = harness();
    const response = await h.post(mixedPayload("u1"));
    // Gmail is the toolkit the answer denies...
    expect(Object.keys((await accessBody(response)).deny)).toEqual(["Gmail"]);

    // ...and still counted in the profile: the measurement is of what the
    // gateway sent us, not of what we sent back.
    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.toolkitCount).toBe(2);
    expect(hit.toolCount).toBe(2);
    expect(hit.versionCount).toBe(2);
  });

  test("a payload shaped like a real gateway's — fifty tools across two toolkits", async () => {
    const h = harness();
    // DESIGN.md: the test gateway is two toolkits, roughly fifty tools. The
    // profile has to stay right at the size someone will actually read.
    const slack = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`SlackTool${i}`, [{ version: "1.0.0" }]]),
    );
    const github = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `GitHubTool${i}`,
        i === 0 ? [{ version: "1.0.0" }, { version: "2.0.0" }] : [{ version: "1.0.0" }],
      ]),
    );
    const body = JSON.stringify({
      user_id: "u1",
      toolkits: { Slack: { tools: slack }, GitHub: { tools: github } },
    });
    expect((await h.post(body)).status).toBe(200);

    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.toolkitCount).toBe(2);
    expect(hit.toolCount).toBe(50);
    expect(hit.versionCount).toBe(51);
    expect(hit.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
    // ~1.9 kB for this fixture: a number a reader can act on, not a flag.
    expect(hit.bodyBytes).toBeGreaterThan(1500);
  });

  test("a payload with nothing to count records zeroes rather than failing", async () => {
    const h = harness();
    await h.post({ user_id: "empty", toolkits: {} });
    // A toolkits value the contract does not describe must not lose the hit:
    // a malformed payload from the gateway is evidence too.
    await h.post({ user_id: "junk", toolkits: "not-an-object" });
    await h.post({ user_id: "absent" });

    for (const user of ["empty", "junk", "absent"]) {
      const hit = (await h.hits(user)).hits[0]!;
      expect([hit.toolkitCount, hit.toolCount, hit.versionCount]).toEqual([0, 0, 0]);
    }
  });
});

describe("the recorded profile — headers (criteria 1, 5)", () => {
  test("an arbitrary custom header the server has never heard of is captured", async () => {
    const h = harness();
    const response = await postWith(
      h.server.url,
      {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        // Nothing in the server knows this name exists. That is the point:
        // an allow-list would drop it, and we do not yet know which headers a
        // real Arcade gateway sends.
        "x-orca-arbitrary-header": "captured-verbatim-42",
        "x-request-id": "req-abc-123",
      },
      JSON.stringify(shapedPayload("u1")),
    );
    expect(response.status).toBe(200);

    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.headers["x-orca-arbitrary-header"]).toBe("captured-verbatim-42");
    expect(hit.headers["x-request-id"]).toBe("req-abc-123");
  });

  test("the capture is not a subset — every header name is there, the bearer included", async () => {
    const h = harness();
    await h.post(shapedPayload("u1"));

    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.headers["host"]).toBe(new URL(h.server.url).host);
    // No allow-list decides which headers are captured, so `authorization` is
    // present — as a descriptor, never as the token. See the redaction block.
    expect(hit.headers).toHaveProperty("authorization");
    expect(hit.headers["authorization"]).not.toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(hit.headers).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the recorded profile — bodyBytes (criterion 1)", () => {
  test("is the byte length of the raw body, not its character count", async () => {
    const h = harness();
    // Multi-byte characters: a length-in-characters implementation reports a
    // smaller number and every other assertion in this file would still pass.
    const body = JSON.stringify({ ...shapedPayload("u1"), note: "héllo — ✅ 五十" });
    const bytes = Buffer.byteLength(body, "utf8");
    expect(bytes).toBeGreaterThan(body.length);

    expect((await h.post(body)).status).toBe(200);
    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.bodyBytes).toBe(bytes);
    expect(hit.bodyBytes).not.toBe(body.length);
  });

  test("measures what arrived, not a re-serialised copy", async () => {
    const h = harness();
    // Whitespace a pretty-printer would add, or a compactor would remove.
    const body = JSON.stringify(shapedPayload("u1"), null, 2);
    expect(body).toContain("\n");
    await h.post(body);

    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(hit.bodyBytes).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(shapedPayload("u1")), "utf8"),
    );
  });
});

describe("the recorded profile — handlingMs (criterion 1)", () => {
  test("is a real positive measurement, and no artificial delay was added", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) await h.post(shapedPayload("u1"));

    const { hits } = await h.hits("u1");
    expect(hits).toHaveLength(5);
    for (const hit of hits) {
      expect(Number.isFinite(hit.handlingMs)).toBe(true);
      // Not zero: a zero would read as "not measured" rather than "fast".
      expect(hit.handlingMs).toBeGreaterThan(0);
      // DESIGN.md: reply immediately, no artificial delay.
      expect(hit.handlingMs).toBeLessThan(250);
    }
  });

  test("is the server's own time only — never more than the client observed", async () => {
    const h = harness();
    // Same process, so both readings come off the same clock.
    const started = performance.now();
    await h.post(shapedPayload("u1"));
    const observed = performance.now() - started;

    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.handlingMs).toBeLessThanOrEqual(observed);
  });
});

describe("the profile in the JSONL log (criterion 3)", () => {
  test("each accepted hit is one line carrying exactly the fields /hits returns", async () => {
    const h = harness();
    const body = JSON.stringify(shapedPayload("u1"));
    await postWith(
      h.server.url,
      { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-mark": "m1" },
      body,
    );

    const lines = h.logLines();
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Hit;
    const hit = (await h.hits("u1")).hits[0]!;
    expect(record).toEqual(hit);

    expect(Object.keys(record).sort()).toEqual([
      "bodyBytes",
      "handlingMs",
      "headers",
      "payload",
      "receivedAt",
      "toolCount",
      "toolkitCount",
      "versionCount",
    ]);
    expect(record.headers["x-mark"]).toBe("m1");
    expect(record.toolCount).toBe(4);
    expect(record.versionCount).toBe(5);
    expect(record.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
  });
});

describe("a rejected request records no profile at all (criterion 6)", () => {
  test("a 401 leaves no hit, no log line and no trace of its headers", async () => {
    const h = harness();
    // A non-zero baseline first: "still 0" cannot tell a rejected request from
    // a server that records nothing at all.
    await h.post(shapedPayload("u1"));
    expect(await h.count("u1")).toBe(1);
    const linesBefore = h.logLines().length;

    const response = await postWith(
      h.server.url,
      {
        authorization: "Bearer wrong-token",
        "content-type": "application/json",
        "x-scanner-marker": "should-never-be-recorded",
      },
      JSON.stringify(shapedPayload("scanner")),
    );
    expect(response.status).toBe(401);

    expect(await h.count("scanner")).toBe(0);
    expect(await h.count("u1")).toBe(1);
    expect(h.logLines()).toHaveLength(linesBefore);

    // The strongest form of "recorded nothing": the header it sent appears
    // nowhere in the log, so no partial record was written either.
    const log = readFileSync(h.server.logPath, "utf8");
    expect(log).not.toContain("x-scanner-marker");
    expect(log).not.toContain("should-never-be-recorded");

    // And no handling time escaped in the response body.
    expect(await response.text()).not.toContain("handlingMs");
  });

  test("a 400 records no profile either", async () => {
    const h = harness();
    expect((await h.post("{not json")).status).toBe(400);
    expect((await h.post({ toolkits: {} })).status).toBe(400);
    expect(h.logLines()).toHaveLength(0);
  });
});

/**
 * Credential headers are redacted at capture, not cleaned up afterwards.
 *
 * The threat is not the gitignored JSONL on its own: a recorded value travels
 * `GET /hits` -> the probe's `hookHits[]` -> `results/<run>.json` -> `evidence/`,
 * which the operator commits to a **public** repository. So these tests search
 * the *serialised text* of every place a hit is observable, not the object
 * graph — a secret nested somewhere unexpected is still a published secret.
 */
describe("credential headers never reach disk", () => {
  /** Every surface a recorded hit is readable from, as raw text. */
  async function observableText(h: Harness, userId: string): Promise<Record<string, string>> {
    const response = await fetch(`${h.server.url}/hits?user_id=${encodeURIComponent(userId)}`);
    return {
      "GET /hits body": await response.text(),
      "the JSONL log": readFileSync(h.server.logPath, "utf8"),
    };
  }

  test("the bearer is replaced by a descriptor and appears in no recorded text", async () => {
    const h = harness();
    await h.post(shapedPayload("u1"));

    const hit = (await h.hits("u1")).hits[0]!;
    // The scheme survives — it is shape, not secret — and the credential does not.
    expect(hit.headers["authorization"]).toMatch(
      /^Bearer <redacted len=\d+ sha256=[0-9a-f]{8}>$/,
    );
    expect(hit.headers["authorization"]).toContain(`len=${TOKEN.length}`);

    for (const [surface, text] of Object.entries(await observableText(h, "u1"))) {
      expect(`${surface}: ${text}`).not.toContain(TOKEN);
    }
    // And not in the serialised hit itself, wherever it might have been nested.
    expect(JSON.stringify(hit)).not.toContain(TOKEN);
  });

  test.each([
    ["proxy-authorization", "Basic cHJveHktc2VjcmV0LXZhbHVl"],
    ["cookie", "session=cookie-secret-value; theme=dark"],
    ["set-cookie", "session=another-cookie-secret; Path=/"],
    ["x-api-key", "api-key-secret-value"],
    ["X-API-Key", "uppercase-api-key-secret"],
  ])("%s is redacted too, and the match is case-insensitive", async (name, value) => {
    const h = harness();
    await postWith(
      h.server.url,
      {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        [name]: value,
      },
      JSON.stringify(shapedPayload("u1")),
    );

    const hit = (await h.hits("u1")).hits[0]!;
    const captured = hit.headers[name.toLowerCase()];
    expect(captured).toBeDefined();
    expect(captured).toContain("<redacted len=");
    for (const text of Object.values(await observableText(h, "u1"))) {
      expect(text).not.toContain(value);
    }
    // A cookie has no scheme, so it is redacted whole rather than split.
    if (name === "cookie") expect(captured).not.toContain("theme=dark");
  });

  test("the same value yields the same descriptor on every hit", async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      await postWith(
        h.server.url,
        {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "x-api-key": "one-steady-key",
        },
        JSON.stringify(shapedPayload("u1")),
      );
    }

    const { hits } = await h.hits("u1");
    expect(hits).toHaveLength(3);
    // The one diagnostic the raw value would have given us: it was the same
    // token every time. A bare `<redacted>` would have thrown this away.
    const bearers = new Set(hits.map((hit) => hit.headers["authorization"]));
    const keys = new Set(hits.map((hit) => hit.headers["x-api-key"]));
    expect(bearers.size).toBe(1);
    expect(keys.size).toBe(1);
  });

  test("a different value yields a different descriptor", async () => {
    const h = harness();
    for (const key of ["key-alpha", "key-beta-which-is-longer"]) {
      await postWith(
        h.server.url,
        {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "x-api-key": key,
        },
        JSON.stringify(shapedPayload("u1")),
      );
    }

    const { hits } = await h.hits("u1");
    expect(hits[0]!.headers["x-api-key"]).not.toBe(hits[1]!.headers["x-api-key"]);
    // Two bearers need two servers, since only the right one is ever recorded.
    const other = "a-completely-different-hook-token";
    const b = harness(other);
    await postWith(
      b.server.url,
      { authorization: `Bearer ${other}`, "content-type": "application/json" },
      JSON.stringify(shapedPayload("u1")),
    );
    const theirs = (await b.hits("u1")).hits[0]!.headers["authorization"];
    expect(theirs).not.toBe(hits[0]!.headers["authorization"]);
    expect(theirs).toMatch(/^Bearer <redacted len=\d+ sha256=[0-9a-f]{8}>$/);
  });

  test("non-credential headers are untouched, however odd their name or value", async () => {
    const h = harness();
    await postWith(
      h.server.url,
      {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        // What the instrument exists to discover: nothing here is guessed at,
        // and no value is pattern-matched.
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "x-arcade-user-id": "probe-2025-11-25-1758210000000-1",
        "x-authorization-ish": "not-a-credential-header-name",
        "x-orca-arbitrary-header": "captured-verbatim-42",
      },
      JSON.stringify(shapedPayload("u1")),
    );

    const hit = (await h.hits("u1")).hits[0]!;
    expect(hit.headers["traceparent"]).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
    expect(hit.headers["x-arcade-user-id"]).toBe("probe-2025-11-25-1758210000000-1");
    // The list is names, exactly — not substrings of names.
    expect(hit.headers["x-authorization-ish"]).toBe("not-a-credential-header-name");
    expect(hit.headers["x-orca-arbitrary-header"]).toBe("captured-verbatim-42");
  });

  test("a 401 records nothing at all, its credential header included", async () => {
    const h = harness();
    const response = await postWith(
      h.server.url,
      {
        authorization: "Bearer wrong-token-from-a-scanner",
        "content-type": "application/json",
        "x-api-key": "scanner-key-that-must-not-be-stored",
      },
      JSON.stringify(shapedPayload("scanner")),
    );
    expect(response.status).toBe(401);

    expect(await h.count("scanner")).toBe(0);
    const log = readFileSync(h.server.logPath, "utf8");
    expect(log).toBe("");
    // Not even a descriptor: a rejected request is not a measurement.
    expect(log).not.toContain("<redacted");
    expect(log).not.toContain("wrong-token-from-a-scanner");
    expect(log).not.toContain("scanner-key-that-must-not-be-stored");
  });
});
