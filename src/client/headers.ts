/**
 * The header contract between the probe and the gateway.
 *
 * DESIGN.md Contracts -> Probe CLI step 2 says the probe "sends it in the
 * Arcade user header on every request" without writing the literal down, and
 * open question 7 ("which header or claim becomes `user_id`") is still open.
 * The name therefore lives here, in one place, so the probe and the offline
 * fake gateway cannot drift: both read this constant, neither repeats the
 * string. When question 7 is answered, this is the single line that changes.
 *
 * Arcade's documented "Arcade Headers" auth mode is the shape the probe uses:
 * `Authorization: Bearer <api key>` plus `Arcade-User-Id: <end user id>` on
 * every request. HTTP header names are case-insensitive on the wire, so every
 * reader here must match case-insensitively; only the spelling we *send* has
 * to be the documented one.
 *
 * The spelling below is the Arcade Dashboard's (operator ruling, 2026-09-18,
 * DESIGN.md open question 7). `Arcade-User-ID` was what we sent before, and the
 * live gateway accepted it and ran fine — the change is fidelity to the
 * Dashboard, not a fix for a failure. That both spellings work is the finding
 * worth keeping: Arcade matches header names case-insensitively, as RFC 9110
 * requires, and HTTP/2 lowercases them on the wire anyway. A reader here that
 * became case-*sensitive* would therefore be a regression, whatever it matched.
 */

/** The header carrying the end-user id the hook counter keys its hits on. */
export const ARCADE_USER_ID_HEADER = "Arcade-User-Id";

/** Anything a header can arrive as: `Headers`, or a plain bag from a server SDK. */
export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

/** Builds the headers a request must carry for the gateway to see `userId`. */
export function arcadeUserHeaders(userId: string): Record<string, string> {
  return { [ARCADE_USER_ID_HEADER]: userId };
}

/**
 * Reads the user id out of `headers`, case-insensitively.
 *
 * Returns `undefined` when the header is absent or blank — callers decide what
 * that means, and both callers here treat it as a loud error rather than a
 * default, because a gateway that invented a user id would file its hook hits
 * under a key the probe never polls and report a plausible zero.
 */
export function readArcadeUserId(headers: HeaderBag): string | undefined {
  const wanted = ARCADE_USER_ID_HEADER.toLowerCase();
  const raw = headers instanceof Headers ? headers.get(wanted) : pick(headers, wanted);
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

function pick(
  headers: Record<string, string | string[] | undefined>,
  wanted: string,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    // A repeated header arrives as an array; the first value is the one a
    // single-valued header would have had.
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
