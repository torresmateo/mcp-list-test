# Design record

Workers treat this file as law and never edit it. The driver refuses to dispatch
without it. Decisions were made in a grilling session on 2026-09-18; the
reasoning is recorded so a worker can tell when a decision no longer applies.

## Purpose

Answer one question with evidence the Arcade engine team can act on: **how many
times does an Arcade MCP gateway call a configured contextual-access hook per
`tools/list` request, how much does it send each time, and what does that cost
in latency?**

**Scope today: the `2025-11-25` revision, taken end to end against the real
Arcade gateway.** `2026-07-28` was originally in scope alongside it and is
deferred to a follow-up, for the reason recorded in decision 15: it is not a
different version string but a different protocol **era**, with a different
handshake. Everything here is written so that adding it later is a parameter and
a slice, not a rewrite.

A prior, unrelated project observed a call volume it did not expect. A
conclusive result is a set of JSON run files plus an HTML report showing, per
revision and per fresh session, requests sent versus hook hits, how many
toolkits and tools each hit carried, how large each payload was, how many
`tools/list` requests the client actually issued, and how much wall-clock time
the hook round trips added — with raw hook payloads attached.

The test gateway is deliberately small: **two toolkits, roughly fifty tools.**
That size is a measurement instrument, not an accident. It is large enough that
a payload carrying the whole set is obviously distinguishable from one carrying
a single tool, and small enough that any per-tool or per-toolkit fan-out would
stand out immediately against a per-request call.

## Architecture

Four parts. Workers build the first three; the operator owns the fourth.

1. **Probe** (`src/probe.ts`, `bun run probe`). For each repetition it
   generates a fresh user id, opens a new MCP session against the gateway with
   the official MCP TypeScript client over Streamable HTTP, sends `initialize`
   then one `tools/list`, and after each request polls the hook counter for hits
   keyed by that user id. It writes one JSON file per run to `results/`.
   The `initialize`-then-`tools/list` shape is the **legacy era** flow and is
   what we measure today; see decision 15.
2. **Hook counter** (`src/hook-server/`, `bun run hook-server`). An HTTP
   server on `$PORT_WEB` that implements Arcade's access-hook contract at
   `POST /access`, verifies a bearer token, records every hit in memory keyed
   by `user_id`, appends the raw payload to `results/hook-log.jsonl`, and
   exposes `GET /hits?user_id=` for the probe. Its policy is fixed: deny every
   tool in the Gmail toolkit, allow everything else.
3. **Report** (`src/report.ts`, `bun run report`). Reads every
   `results/*.json` and writes a self-contained `results/report.html`: a
   summary table across revisions, then per-run detail with raw hook payloads.
4. **Operator-owned environment.** A dedicated Arcade test project with one MCP
   gateway exposing Gmail plus at least one other toolkit, and one access-hook
   extension pointing at an ngrok tunnel to the local hook counter. Configured
   in the Arcade Dashboard only. Credentials live in `.env.local`.

```
probe ──MCP over Streamable HTTP──▶ Arcade gateway ──POST /access──▶ ngrok ──▶ hook counter
  │                                                                              │
  └──────────────────── GET /hits?user_id= ◀─────────────────────────────────────┘
  └──▶ results/<ts>-<revision>-<n>.json ──▶ report ──▶ results/report.html
```

## Contracts

Interfaces other slices inherit. Change them only by amending this file.

### Environment (`.env.local`, never committed)

| Variable            | Written by          | Meaning                                              |
| ------------------- | ------------------- | ---------------------------------------------------- |
| `PORT_WEB`          | `scripts/orca-setup.sh` | Hook counter listen port                          |
| `ARCADE_API_KEY`    | operator            | Bearer for the gateway                               |
| `ARCADE_MCP_URL`    | operator            | Streamable HTTP endpoint of the test gateway         |
| `HOOK_BEARER_TOKEN` | operator            | Token the gateway sends; hook rejects anything else  |
| `HOOK_PUBLIC_URL`   | operator            | ngrok URL, printed in run JSON for provenance only   |
| `ARCADE_USER_ID_PREFIX` | operator, optional | Replaces `probe` in the generated `user_id`. Defaults to `probe`. |

Anything needed by the live probe that is missing makes it exit non-zero with
the variable name. Nothing skips. `ARCADE_USER_ID_PREFIX` is the one optional
entry: absent, the default applies; it never causes an exit.

### Probe CLI

```
bun run probe --protocol <2025-11-25|2026-07-28> [--repetitions N] [--out results/]
```

Default repetitions: 5. Runs are serial. Exit code is 0 only if every
repetition negotiated the requested revision. Per repetition the probe:

1. Generates `user_id = <prefix>-<revision>-<timestamp>-<n>`, where `<prefix>`
   is `$ARCADE_USER_ID_PREFIX` or `probe`. **The `-<n>` suffix is not
   configurable**: each repetition must be a distinct end user, or a cached
   session or reused authorization can hide the behaviour being measured.
2. Sends it in the Arcade user header on every request, with
   `Authorization: Bearer $ARCADE_API_KEY`.
3. Requests `protocolVersion = <revision>` in `initialize` and sets the
   `MCP-Protocol-Version` header. If the server returns a different version
   the repetition is recorded with `status: "version-mismatch"` and the run
   fails at the end.
4. Wraps the SDK transport's `fetch` to log every outbound JSON-RPC request
   (id, method, timestamp) so SDK retries are visible.
5. After `initialize` and after `tools/list`, polls `GET /hits?user_id=` until
   the count is stable for a quiescence window (default 2 s), then snapshots.
6. Records the number of Gmail tools in the `tools/list` result. Not a failure
   condition; the report shows it.

### Run JSON (`results/<timestamp>-<revision>-<n>.json`)

```json
{
  "schema": 1,
  "revisionRequested": "2025-11-25",
  "revisionNegotiated": "2025-11-05",
  "status": "ok | version-mismatch | error",
  "userId": "probe-2025-11-25-1758210000000-1",
  "hookPublicUrl": "https://....ngrok.app",
  "requests": [
    { "id": 0, "method": "initialize", "sentAt": "ISO", "hookHitsAfter": 0 },
    { "id": 1, "method": "tools/list", "sentAt": "ISO", "hookHitsAfter": 3 }
  ],
  "hookHits": [ { "receivedAt": "ISO", "payload": { "user_id": "...", "toolkits": {} } } ],
  "toolsListed": 42,
  "gmailToolsListed": 0,
  "toolsListResult": [ { "name": "Slack_PostMessage", "...": "as the gateway returned it" } ],
  "toolsNotOfferedToHook": ["Some_Default", "Another_Default"],
  "error": null
}
```

`hookHitsAfter` is cumulative for that user id at snapshot time. Hook hits per
method = difference between consecutive snapshots.

**Both sides of the comparison are recorded** (decision 18). `hookHits` is what
the gateway told the hook; `toolsListResult` is what the same gateway returned
to the client for the same session. A reader can derive the difference rather
than take a count on trust.

`toolsNotOfferedToHook` is the derived set: tool names present in
`toolsListResult` that appear in **no** hook payload. It is `null` — never `[]` —
when `hookHits` is empty, because a run with no hook hits says nothing about
what was offered, and an empty array would read as "nothing bypassed the hook".

### Hook counter HTTP API

- `POST /access` — Arcade access-hook contract. Requires
  `Authorization: Bearer $HOOK_BEARER_TOKEN`, else 401 and **not counted**.
  Body per Arcade schema (`AccessHookRequest`):
  `{ user_id, toolkits: { <Toolkit>: { tools: { <Tool>: [ { version, metadata } ] } } } }`.
  Response per Arcade schema (`AccessHookResult`): `{ only?: Toolkits, deny?: Toolkits }`,
  where `Toolkits` is the **same** map shape as the request's `toolkits`.
  This hook returns `{ "deny": { <Toolkit>: <ToolkitInfo as received> } }` naming
  every toolkit whose name matches `/^gmail$/i`, and `{}` when the request
  carried none. It does **not** echo the request body.
  Reply immediately, no artificial delay.
- Every hit also records **the response this hook sent back**: its status and
  body (decision 19). A hook that records only what it was asked, and not what
  it answered, cannot show that the deny it believes it issued was issued.
- `GET /hits?user_id=<id>` → `{ "count": n, "hits": [ { "receivedAt", "payload" } ] }`.
- `GET /healthz` → 200.
- Every accepted hit is also appended as one JSON line to
  `results/hook-log.jsonl`.

### Report

```
bun run report [--in results/] [--out results/report.html]
```

Self-contained HTML, no external assets, no headless browser. Summary table
columns: revision, repetitions, min/max/mean hook hits on `tools/list`, hook
hits on `initialize`, version-mismatch count, Gmail tools listed. Per-run
sections follow with the request timeline and raw hook payloads. PDF is the
browser's print dialog.

## Decisions

1. **Characterise, do not prejudge.** It is tempting to assert that one list
   request should mean one access decision and treat anything else as the
   finding. We do not assert it. The deliverable is a *profile* of what the
   gateway actually does — invocations, payload size, tool and toolkit counts,
   pages fetched, and added latency — measured from outside with no assumption
   about the implementation. A number stated in advance becomes the thing the
   measurement is read against, and a measurement that only reports agreement
   or disagreement with a guess is worth less than one that reports what
   happened.
2. **Probe issues `initialize` and one `tools/list` only.** Minimal surface
   gives the cleanest attribution. Repeat lists, prompts, resources and
   `tools/call` are out of scope until this number is known.
3. **Official MCP TypeScript SDK, Streamable HTTP only.** It is what real
   clients use, so the count reflects what users experience. The SDK may issue
   requests behind the caller's back, so decision 4 exists.
   The package is the **v2 scoped set** — `@modelcontextprotocol/client`,
   `@modelcontextprotocol/server`, `@modelcontextprotocol/core` — not the frozen
   v1 `@modelcontextprotocol/sdk`. See decision 16.
4. **Log every outbound request via an injected `fetch`.** Requests sent and
   hook hits are reported side by side. An SDK retry shows up as two requests,
   not as a mysterious extra hit.
5. **Fresh generated user id per repetition, serial runs, quiescence polling.**
   The hook payload carries `user_id` and little else, so the id is the
   correlation key. Serial execution plus a stable-count window attributes hits
   to the right method without gateway-side identifiers. Revisit when the
   hook-side interrogation (open question 1) says what else reaches the hook.
6. **Hook policy: deny the Gmail toolkit, allow the rest**, expressed as the
   contract's `deny` list. A visible effect in the listed tools proves the hook
   was consulted at all. Gmail count is recorded, not asserted, because a
   non-zero value is a different bug.

   **Amended 2026-09-18 (operator ruling, gate `gate_e8a9f8ad9971`).** This
   decision previously specified the response as *the request body with Gmail
   removed*. That was wrong, and wrong in the fail-open direction. The canonical
   contract — `AccessHookResult` in `logic_extensions/http/1.0/schema.yaml` of
   ArcadeAI/schemas, linked from Arcade's "build your own" guide — is
   `{ only?: Toolkits, deny?: Toolkits }`, and the engine treats a response
   carrying **neither** field as *no change*: every tool stays allowed. The old
   response carried neither, so a filtered body that looked like a deny
   expressed no opinion at all, and Gmail would have remained listed.

   Found by the #6 reviewer while reviewing the runbook, and verified against
   the published schema rather than the prose. The measurement this project
   exists to take — how many times the hook fires on `tools/list` — is
   unaffected either way: the hook is called, counts, and records its profile
   regardless of what it answers. What it changes is whether the live run's
   `gmailToolsListed` is interpretable. A non-zero value under the old response
   would have meant "we never expressed a deny", which is far too easy to
   misread as "the gateway ignored our deny".
7. **Hook verifies a bearer token and does not count rejects.** The tunnel URL
   is public; scanners must not become hook hits.
8. **In-memory store plus JSONL append.** The probe polls a read endpoint; the
   file survives a crash. SQLite is overkill for a counter.
9. **Repetitions configurable, default 5.** Enough to separate a systematic
   double-fire from a one-off without hammering a shared gateway.
10. **Fail on version mismatch, record what was negotiated.** A silent
    downgrade would make both runs test the same revision.
11. **Results are gitignored; the operator commits curated evidence.** Raw runs
    are noisy. A conclusive run is copied into `evidence/` by hand.
12. **Report is JSON-first with an HTML renderer.** Runs are machine-readable
    for the engine team; the HTML is for humans and needs no extra dependency.
13. **Dedicated Arcade test project, Dashboard-configured by the operator.**
    Workers never touch the Dashboard. Fail-closed and short timeouts are safe
    because nothing else depends on the project.
14. **Unit tests run against a fake gateway and the real hook counter.** The
    fake MCP server calls the hook N times per `tools/list`; tests assert the
    probe reports N and the negotiated version. The live probe is a separate
    command and is never mocked.
15. **`2026-07-28` is a different era, not a different version string, and is
    deferred.** The SDK names two behaviour families: `legacy`, covering
    `2024-10-07` through `2025-11-25`, which opens with the `initialize`
    handshake; and `modern`, starting at `2026-07-28`, which has **no
    `initialize`** — it opens with a `server/discover` probe and carries a
    `_meta` envelope on every request. That makes the two legs different flows
    rather than one flow under two labels, so the probe contract, the run JSON
    `requests[]` and the report's *hits on initialize* column are all
    legacy-shaped today. Deferred so we get a real number against the live
    gateway first. It also sharpens the eventual question: two different
    handshakes may invoke the hook a different number of times, which is more
    interesting than the same handshake twice.
16. **Use the v2 scoped packages, from npm, not a vendored copy.** The SDK was
    restructured at v2: `@modelcontextprotocol/sdk` is the frozen v1 name
    (1.30.0, no `2026-07-28`), and the current published packages are
    `@modelcontextprotocol/client`, `/server` and `/core` at 2.0.0, which carry
    both revisions plus `versionNegotiation`, `mode: { pin: '2026-07-28' }` and
    `getProtocolEra()`. Vendoring the SDK was considered and rejected: it is
    published, and a local fork would undercut decision 3's justification that
    we measure what real clients experience. Migrating is its own slice, done
    before the probe is written, because the probe is the file the migration
    would otherwise force a rewrite of.
19. **Record both directions on both wires.** The probe holds every MCP request
    and response frame and the hook holds its own answer; both were being
    reduced to metadata. The operator asked to inspect what actually crossed the
    wire and the report could only print `body not recorded`, because the data
    was never kept. Four directions, all recorded: probe->gateway request,
    gateway->probe response, gateway->hook request (already kept), and
    **hook->gateway response**, which is the one that shows the deny we believe
    we issued was actually issued. Operator decision, 2026-09-19.

18. **Record the MCP side, not only the hook side.** The probe holds the
    `tools/list` result already and reduced it to two integers. The live run of
    2026-09-19 showed why that is not enough: the gateway listed 42 tools while
    offering the hook 40, so two tools were never submitted to access control —
    and the instrument could report the *count* of the gap but not *which*
    tools, which is the project's own "an absence is not evidence; an excerpt,
    not a count" rule turned against itself. Storing the result makes the
    comparison checkable by a reader instead of asserted by whoever ran it.
    Operator decision, 2026-09-19.

17. **Measure size and latency, not just count.** A bare invocation count does
    not tell the engine team what an access hook costs them. Each recorded hit
    carries how many toolkits, tools and tool-versions arrived and how many
    bytes the payload was; each probe records how many `tools/list` requests
    actually went out, whether a cursor was followed, and the wall-clock time
    the call took. Hook round trips are synchronous on the request path and the
    hook in this harness is on the far side of a tunnel, so latency is a real
    number a reader will care about — and a count that doubles matters more if
    each call also carries the whole tool set.

## Non-goals

- Pre-execution and post-execution hooks.
- Measuring `tools/call`, `prompts/list`, or `resources/list`.
- Legacy HTTP+SSE transport.
- The `modern` era (`2026-07-28`) for now — deferred per decision 15, not
  abandoned.
- Fixing the gateway. This repo produces evidence only.
- A long-lived deployment of the hook counter.
- PDF generation via headless browsers.

## Open questions

Answers come from interrogating the hook-side (engine) repo in a separate
session. Until answered, decision 5 stands.

1. Which code paths invoke the access hook, and is `initialize` one of them?
   Era-specific: `initialize` exists only in the legacy era. The modern-era
   form of this question is whether `server/discover` invokes the hook.
2. Is the hook called once per request, per toolkit, per tool, or per version?
3. Is the access decision cached, keyed by what, with what TTL?
4. Does the gateway retry the hook on timeout or 5xx, and how many times?
5. Can one `tools/list` fan out to parallel hook calls?
6. Do any request-scoped identifiers (trace id, session id) reach the hook that
   would allow exact attribution instead of quiescence windows?
7. Which header or claim becomes `user_id` for an MCP gateway call?
   **Header name answered** (operator, 2026-09-18): `Arcade-User-Id`, as spelled
   in the Arcade Dashboard. An earlier confirmation said `Arcade-User-ID`; the
   live gateway accepted that spelling and ran fine, so the correction is
   fidelity to the Dashboard, **not** a fix for a failure — and it is itself a
   small finding: Arcade matches the header case-insensitively, as RFC 9110
   requires. The remaining half — whether the gateway derives the hook payload's
   `user_id` from that header — is what the live run's step 6 `MATCH`/`MISMATCH`
   check answers, and cannot be shown offline because the fake reads the same
   constant the probe sends.
8. Does the `tools/list` path differ between MCP revisions `2025-11-25` and
   `2026-07-28`? Note these are different eras (decision 15), so any difference
   may be the handshake rather than the list path itself.
9. Does the gateway emit a per-invocation log or metric we can compare against?
10. Is there an existing ticket about the hook firing too often?
11. Does the test gateway actually offer `2026-07-28` at all? Answerable only
    against the real gateway, and it decides whether the deferred modern-era
    leg has anything to talk to. Record it in the live run's notes.
