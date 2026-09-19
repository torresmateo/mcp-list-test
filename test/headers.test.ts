/**
 * The one constant the probe, the fake gateway and the request log share, and
 * the rule that every reader of it must obey.
 *
 * **Why case-insensitivity is pinned here and not left to good intentions.**
 * HTTP header names are case-insensitive (RFC 9110 §5.1) and HTTP/2 lowercases
 * every one of them on the wire (RFC 9113 §8.2.1). A reader that compared the
 * name exactly would see no user header at all on a real HTTP/2 connection,
 * and the hook would be called under an id the probe never polls: `GET /hits`
 * answers `[]`, `hookHits` is empty, and the run reports a clean zero that is
 * indistinguishable from "the hook never fired" — the measurement itself.
 *
 * That is also why issue #23 is a spelling change and not a fix. `Arcade-User-ID`
 * worked against the live gateway; Arcade matches the name case-insensitively
 * as the RFC requires. `Arcade-User-Id` is the Arcade Dashboard's spelling and
 * nothing more.
 *
 * Note which branch each test exercises. A `Headers` object normalises names
 * itself, so its `get()` would pass whatever we compared against; the branch
 * that can actually regress is the plain-bag one, where this module does the
 * matching. Both are covered, because a future reader must not have to know
 * which shape a server SDK will hand them.
 */
import { describe, expect, test } from "bun:test";
import {
  ARCADE_USER_ID_HEADER,
  arcadeUserHeaders,
  readArcadeUserId,
} from "../src/client/headers.ts";
import { createRequestLog } from "../src/client/request-log.ts";

/** Every spelling a conforming peer is allowed to send the same header as. */
const SPELLINGS = [
  "Arcade-User-Id",
  "Arcade-User-ID",
  "arcade-user-id",
  "ARCADE-USER-ID",
  "aRcAdE-uSeR-iD",
] as const;

/**
 * A `fetch` that always answers one JSON-RPC result, so the log has a reply to
 * settle against without a server. `preconnect` is bun's addition to the
 * `fetch` type and nothing here calls it.
 */
function stubFetch(): typeof fetch {
  const impl = async (): Promise<Response> =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return Object.assign(impl, { preconnect: () => {} }) as unknown as typeof fetch;
}

describe("the header we send", () => {
  test("is spelled the way the Arcade Dashboard spells it", () => {
    // DESIGN.md open question 7, operator ruling 2026-09-18. The previous
    // spelling `Arcade-User-ID` ran against the live gateway and worked.
    expect(ARCADE_USER_ID_HEADER).toBe("Arcade-User-Id");
    expect(arcadeUserHeaders("u-1")).toEqual({ "Arcade-User-Id": "u-1" });
  });

  test("is defined once and built from the constant, never retyped", () => {
    expect(Object.keys(arcadeUserHeaders("u-1"))).toEqual([ARCADE_USER_ID_HEADER]);
  });
});

describe("readArcadeUserId is case-insensitive", () => {
  for (const spelling of SPELLINGS) {
    test(`reads \`${spelling}\` off a plain header bag`, () => {
      // The branch this module matches in itself: a server SDK that hands over
      // a plain object does no normalising, so a case-sensitive compare here
      // would silently drop the identity of every HTTP/2 request.
      expect(readArcadeUserId({ [spelling]: "u-bag" })).toBe("u-bag");
    });

    test(`reads \`${spelling}\` off a \`Headers\``, () => {
      expect(readArcadeUserId(new Headers({ [spelling]: "u-headers" }))).toBe("u-headers");
    });
  }

  test("takes the first value when the header arrived repeated", () => {
    expect(readArcadeUserId({ "ARCADE-USER-ID": ["u-first", "u-second"] })).toBe("u-first");
  });

  test("ignores other headers whose names differ by more than case", () => {
    // The flip side of matching loosely: `x-arcade-user-id` is a different
    // header, and reading it would attribute hits to an id nobody sent.
    expect(readArcadeUserId({ "x-arcade-user-id": "u-wrong" })).toBeUndefined();
    expect(readArcadeUserId({ "arcade_user_id": "u-wrong" })).toBeUndefined();
  });
});

describe("an absent or blank header is undefined, never an invented id", () => {
  test("absent", () => {
    expect(readArcadeUserId({})).toBeUndefined();
    expect(readArcadeUserId(new Headers())).toBeUndefined();
  });

  test("empty or whitespace-only", () => {
    // Both callers treat `undefined` as a loud error. A whitespace id would
    // instead be sent, and the hook filed under a key the probe cannot poll.
    expect(readArcadeUserId({ "arcade-user-id": "" })).toBeUndefined();
    expect(readArcadeUserId({ "arcade-user-id": "   " })).toBeUndefined();
    expect(readArcadeUserId(new Headers({ "Arcade-User-Id": "  " }))).toBeUndefined();
  });
});

describe("the request log records the identity however the name was spelled", () => {
  /**
   * `requests[].userIdHeader` is what tells "the hook never fired" apart from
   * "we never identified ourselves" (`src/probe/run.ts`). If the log read the
   * name case-sensitively, a transport that rewrote it would make every request
   * look anonymous and turn an ok run into an `error` — or, worse, the reverse
   * if the comparison were ever loosened on only one side.
   */
  for (const spelling of SPELLINGS) {
    test(`\`${spelling}\` is recorded as the user id that went out`, async () => {
      const log = createRequestLog({ fetchImpl: stubFetch() });

      const response = await log.fetch("http://127.0.0.1:1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", [spelling]: "u-logged" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      // The log settles a request when its reply has been read, exactly as the
      // transport would read it; leaving the body unread would hang `flush()`.
      await response.text();
      await log.flush();

      expect(log.entries.map(entry => entry.method)).toEqual(["tools/list"]);
      expect(log.entries[0]!.userIdHeader).toBe("u-logged");
    });
  }

  test("a request with no user header is recorded as null, not as an empty string", async () => {
    const log = createRequestLog({ fetchImpl: stubFetch() });

    const response = await log.fetch("http://127.0.0.1:1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    await response.text();
    await log.flush();

    expect(log.entries[0]!.userIdHeader).toBeNull();
  });
});
