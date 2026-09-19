/**
 * Capture-time redaction — the one place that decides what a credential looks
 * like once it has been taken off a wire.
 *
 * **This repository is public and its run files are committed as evidence.** A
 * secret that reaches `results/<run>.json` or `results/hook-log.jsonl` is not a
 * failing test, it is a published secret, so the rule here is not "scrub before
 * writing" but **replace before holding**: every caller redacts on the way in,
 * once, and no unredacted copy is ever put in a field, a store or a log line. A
 * scrub pass that runs later can be skipped, reordered, or miss a path that was
 * added after it.
 *
 * Two shapes of the same rule, because the two things being protected are
 * different:
 *
 *  - {@link redactValue} walks a **structure we own** — the access decision this
 *    hook builds — and returns a new structure. It never mutates its input,
 *    which matters because the decision shares sub-objects with the request
 *    payload, and that payload is deliberately stored unfiltered.
 *  - {@link redactJsonText} walks **raw JSON text off a wire** and returns text.
 *    It replaces only the spans that are credential values and leaves every
 *    other byte exactly where it was — duplicate keys, key order, whitespace and
 *    all. That is what lets a recorded frame stay the frame rather than becoming
 *    a re-serialisation of a parse of it (issue #31 criterion 3).
 *
 * In both, **the key name stays and only the value is replaced.** That an
 * `authorization` key was present is part of the evidence; what it held is not.
 *
 * The match is on names, case-insensitively, and on nothing else. No value is
 * pattern-matched: a gateway's `traceparent`, `user-agent` or anything we have
 * never seen is exactly what this instrument exists to discover, and guessing at
 * values would start redacting the evidence.
 *
 * ## What this deliberately does not cover
 *
 * The hook hit's `payload` and the run's `toolsListResult` are the **gateway's
 * own description of its catalogue**, and they are stored unfiltered on purpose
 * (DESIGN.md decision 17). A key named `authorization` in tool metadata there
 * names a *requirement of a tool* — what it needs in order to run — not a
 * secret, and key-based redaction cannot tell the two apart. Redacting them
 * would delete the measurement to protect something that was never a
 * credential.
 *
 * The protection for those is value-based and already exists: `RUNBOOK.md`
 * step 10 greps the operator's actual key, gateway URL, bearer and tunnel host
 * across the whole evidence directory before anything is committed, with a
 * positive control (step 10.4) that plants a secret and proves the grep can
 * find one before a `clean` verdict is believed. That catches a real credential
 * wherever it landed, including inside a payload.
 *
 * Key-based redaction here, value-based sweeping there. The split is the point:
 * what this file protects is the values **we** put on a record — our own
 * answer, and the frames we captured — where an `authorization` key is by
 * definition carrying the thing it is named after.
 */
import { createHash } from "node:crypto";

/**
 * Field and header names whose value is a credential. Matched by name,
 * case-insensitively, at any depth.
 *
 * Deliberately short and about *names only*: these are the names that carry a
 * secret by definition.
 */
export const CREDENTIAL_FIELDS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

/**
 * The subset whose value begins with an auth scheme (RFC 7235). The scheme is
 * kept in the clear because it is shape, not secret. A cookie has no scheme —
 * its first token is already a value — so it is redacted whole.
 */
const SCHEMED_CREDENTIAL_FIELDS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
]);

/** `Bearer <token>` -> scheme and credential; no match means "no scheme". */
const AUTH_SCHEME = /^([A-Za-z][A-Za-z0-9._~+-]*)[ \t]+(\S[\s\S]*)$/;

/** True when a field or header of this name carries a credential. */
export function isCredentialField(name: string): boolean {
  return CREDENTIAL_FIELDS.has(name.toLowerCase());
}

/** First 8 hex of SHA-256: stable across hits, useless for recovering the value. */
function shortDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

/**
 * What a redacted value becomes: `<redacted len=43 sha256=1f3a9c2b>`.
 *
 * A descriptor rather than a bare `<redacted>`, because the three things we
 * actually need from a credential survive it — it was present, it had a
 * plausible shape, and it was *the same value every time*. That last one is the
 * only diagnostic the raw bytes would have given us, and a constant placeholder
 * would throw it away. `len` is the byte length of the portion that was removed,
 * and the digest is over that same portion, so the original length is still
 * recoverable from the record.
 */
export function redact(secret: string): string {
  return `<redacted len=${Buffer.byteLength(secret, "utf8")} sha256=${shortDigest(secret)}>`;
}

/**
 * One credential value, redacted the way its name calls for.
 *
 * The same function for a header and for a field buried in a body, so the same
 * bearer produces the same descriptor wherever it was found — which is what
 * makes "the same value arrived every time" readable across both.
 */
export function redactFieldValue(name: string, value: string): string {
  const schemed = SCHEMED_CREDENTIAL_FIELDS.has(name.toLowerCase())
    ? AUTH_SCHEME.exec(value)
    : null;
  return schemed === null ? redact(value) : `${schemed[1]} ${redact(schemed[2] as string)}`;
}

/**
 * Every header that arrived, with credential values replaced before the record
 * exists. There is no path by which the raw secret is stored and cleaned up
 * later: it is replaced here, once, on the way in.
 *
 * No allow-list decides *which* headers are captured: we do not yet know which
 * ones a real Arcade gateway sends, and a hit that cannot be tied back to the
 * request that caused it is a hit we can only count, not explain.
 */
export function captureHeaders(headers: Headers): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const [name, value] of headers) {
    // The runtime lower-cases header names; `toLowerCase` makes the match
    // independent of that rather than dependent on it.
    captured[name] = isCredentialField(name) ? redactFieldValue(name, value) : value;
  }
  return captured;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A structure with every credential value replaced, at any depth.
 *
 * Returns new objects and arrays and **never mutates the input**. The hook's
 * access decision carries `ToolkitInfo` objects taken straight from the request
 * payload, and that payload is stored unfiltered on purpose (DESIGN.md decision
 * 17) — redacting in place would reach back into it.
 *
 * A credential key whose value is not a string — an object, an array, a number —
 * is replaced whole, with the descriptor measured over its compact JSON. There
 * is no shape a credential key is allowed to hide behind.
 */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isPlainObject(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (!isCredentialField(key)) {
      redacted[key] = redactValue(field);
      continue;
    }
    redacted[key] =
      typeof field === "string"
        ? redactFieldValue(key, field)
        : redact(JSON.stringify(field) ?? "null");
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// The text walk
// ---------------------------------------------------------------------------

/**
 * A scanner rather than a parser. It finds where each value *starts and ends* in
 * the source and touches nothing else, so the text that comes back out is the
 * text that went in with a few spans swapped.
 *
 * `JSON.parse` followed by `JSON.stringify` would be far shorter and would
 * silently drop a duplicate key, normalise whitespace and reorder nothing but
 * re-emit everything — which is precisely the loss issue #31 criterion 3 exists
 * to prevent. The round trip is the bug, so there is no round trip.
 *
 * Recursion depth follows the nesting depth of the document. JSON that nests
 * thousands deep would exhaust the stack; the bodies here are JSON-RPC frames
 * and access decisions, which nest single digits.
 */

/** Index of the first character at or after `i` that is not JSON whitespace. */
function skipWhitespace(text: string, i: number): number {
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) {
    i += 1;
  }
  return i;
}

/** `i` is at the opening quote; returns the index just past the closing quote. */
function endOfString(text: string, i: number): number {
  i += 1;
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === '"') return i + 1;
    i += 1;
  }
  return text.length;
}

/** `i` is at the first character of a value; returns the index just past it. */
function endOfValue(text: string, i: number): number {
  const char = text[i];
  if (char === '"') return endOfString(text, i);
  if (char !== "{" && char !== "[") {
    // A number, `true`, `false` or `null`: everything up to the next structural
    // character. Malformed input simply ends the value where the structure does.
    while (i < text.length && !",}] \t\n\r".includes(text[i] as string)) i += 1;
    return i;
  }
  let depth = 0;
  while (i < text.length) {
    const here = text[i] as string;
    if (here === '"') {
      i = endOfString(text, i);
      continue;
    }
    if (here === "{" || here === "[") depth += 1;
    else if (here === "}" || here === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** One span of `text` that is a credential value, and the key that named it. */
interface CredentialSpan {
  key: string;
  start: number;
  end: number;
}

/**
 * Every credential value in `text`, as spans.
 *
 * A string token is a **key** when the next non-whitespace character after it is
 * a colon. That is the whole rule, and it is enough: a string that is a value
 * cannot be followed by a colon in well-formed JSON, and this scanner is only
 * ever handed JSON that a `JSON.parse` elsewhere has already accepted.
 */
function credentialSpans(text: string): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      i += 1;
      continue;
    }
    const stringEnd = endOfString(text, i);
    const afterString = skipWhitespace(text, stringEnd);
    if (text[afterString] !== ":") {
      // A value, not a key. Skip past it so a string *inside* it cannot be
      // mistaken for a key of the enclosing object.
      i = stringEnd;
      continue;
    }
    let key: string;
    try {
      key = JSON.parse(text.slice(i, stringEnd)) as string;
    } catch {
      i = stringEnd;
      continue;
    }
    const valueStart = skipWhitespace(text, afterString + 1);
    const valueEnd = endOfValue(text, valueStart);
    if (isCredentialField(key)) {
      spans.push({ key, start: valueStart, end: valueEnd });
      // Nothing inside a redacted value needs scanning — it is going away whole.
      i = valueEnd;
      continue;
    }
    i = valueStart;
  }
  return spans;
}

/**
 * `text` with every credential value replaced by its descriptor, and every other
 * byte where it was.
 *
 * The replacement is always a JSON string, so the result still parses; the key
 * that named it is untouched, so a reader still sees that the field was there.
 */
export function redactJsonText(text: string): string {
  const spans = credentialSpans(text);
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(text.slice(cursor, span.start));
    const raw = text.slice(span.start, span.end);
    let descriptor: string;
    if (raw.startsWith('"')) {
      // Measured over the *decoded* string, so the same bearer in a header and
      // in a body produce the same descriptor.
      let decoded: string;
      try {
        decoded = JSON.parse(raw) as string;
      } catch {
        decoded = raw;
      }
      descriptor = redactFieldValue(span.key, decoded);
    } else {
      descriptor = redact(raw);
    }
    parts.push(JSON.stringify(descriptor));
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/**
 * The raw text of each element of a top-level JSON array, or `null` when the
 * text is not one.
 *
 * A JSON-RPC batch is one HTTP body carrying several messages, and a row must be
 * shown its own message rather than the batch it travelled in. Slicing the
 * source is the only way to do that without re-serialising the element, which
 * would undo the whole point of keeping the raw text.
 */
export function splitTopLevelJsonArray(text: string): string[] | null {
  let i = skipWhitespace(text, 0);
  if (text[i] !== "[") return null;
  i += 1;
  const elements: string[] = [];
  for (;;) {
    i = skipWhitespace(text, i);
    if (i >= text.length) return elements;
    if (text[i] === "]") return elements;
    const end = endOfValue(text, i);
    elements.push(text.slice(i, end));
    i = skipWhitespace(text, end);
    if (text[i] === ",") i += 1;
  }
}
