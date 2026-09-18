# Design record

Workers treat this file as law and never edit it. The driver refuses to dispatch
without it. Decisions were made in a grilling session on 2026-09-18; the
reasoning is recorded so a worker can tell when a decision no longer applies.

## Purpose

Answer one question with evidence the Arcade engine team can act on: **how many
times does an Arcade MCP gateway call a configured contextual-access hook per
`tools/list` request**, for MCP protocol revisions `2025-11-25` and
`2026-07-28`? The expected value is exactly one hook call per `tools/list`.
A prior, unrelated project observed far more. A conclusive result is a set of
JSON run files plus an HTML report showing, per revision and per fresh session,
requests sent versus hook hits, with raw hook payloads attached.

## Architecture

Four parts. Workers build the first three; the operator owns the fourth.

1. **Probe** (`src/probe.ts`, `bun run probe`). For each repetition it
   generates a fresh user id, opens a new MCP session against the gateway with
   the official `@modelcontextprotocol/sdk` over Streamable HTTP, sends
   `initialize` then one `tools/list`, and after each request polls the hook
   counter for hits keyed by that user id. It writes one JSON file per run to
   `results/`.
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

Anything needed by the live probe that is missing makes it exit non-zero with
the variable name. Nothing skips.

### Probe CLI

```
bun run probe --protocol <2025-11-25|2026-07-28> [--repetitions N] [--out results/]
```

Default repetitions: 5. Runs are serial. Exit code is 0 only if every
repetition negotiated the requested revision. Per repetition the probe:

1. Generates `user_id = probe-<revision>-<timestamp>-<n>`.
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
  "error": null
}
```

`hookHitsAfter` is cumulative for that user id at snapshot time. Hook hits per
method = difference between consecutive snapshots.

### Hook counter HTTP API

- `POST /access` — Arcade access-hook contract. Requires
  `Authorization: Bearer $HOOK_BEARER_TOKEN`, else 401 and **not counted**.
  Body per Arcade schema: `{ user_id, toolkits: { <Toolkit>: { tools: { <Tool>: [ { version, metadata } ] } } } }`.
  Response: the same shape with every toolkit whose name matches `/^gmail$/i`
  removed. Reply immediately, no artificial delay.
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

1. **Baseline is exactly one hook call per `tools/list`.** One user, one list
   request, one access decision. Anything above one is the finding.
2. **Probe issues `initialize` and one `tools/list` only.** Minimal surface
   gives the cleanest attribution. Repeat lists, prompts, resources and
   `tools/call` are out of scope until this number is known.
3. **Official `@modelcontextprotocol/sdk`, Streamable HTTP only.** It is what
   real clients use, so the count reflects what users experience. The SDK may
   issue requests behind the caller's back, so decision 4 exists.
4. **Log every outbound request via an injected `fetch`.** Requests sent and
   hook hits are reported side by side. An SDK retry shows up as two requests,
   not as a mysterious extra hit.
5. **Fresh generated user id per repetition, serial runs, quiescence polling.**
   The hook payload carries `user_id` and little else, so the id is the
   correlation key. Serial execution plus a stable-count window attributes hits
   to the right method without gateway-side identifiers. Revisit when the
   hook-side interrogation (open question 1) says what else reaches the hook.
6. **Hook policy: deny the Gmail toolkit, allow the rest.** A visible effect in
   the listed tools proves the hook was consulted at all. Gmail count is
   recorded, not asserted, because a non-zero value is a different bug.
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

## Non-goals

- Pre-execution and post-execution hooks.
- Measuring `tools/call`, `prompts/list`, or `resources/list`.
- Legacy HTTP+SSE transport.
- Fixing the gateway. This repo produces evidence only.
- A long-lived deployment of the hook counter.
- PDF generation via headless browsers.

## Open questions

Answers come from interrogating the hook-side (engine) repo in a separate
session. Until answered, decision 5 stands.

1. Which code paths invoke the access hook, and is `initialize` one of them?
2. Is the hook called once per request, per toolkit, per tool, or per version?
3. Is the access decision cached, keyed by what, with what TTL?
4. Does the gateway retry the hook on timeout or 5xx, and how many times?
5. Can one `tools/list` fan out to parallel hook calls?
6. Do any request-scoped identifiers (trace id, session id) reach the hook that
   would allow exact attribution instead of quiescence windows?
7. Which header or claim becomes `user_id` for an MCP gateway call?
8. Does the `tools/list` path differ between MCP revisions `2025-11-25` and
   `2026-07-28`?
9. Does the gateway emit a per-invocation log or metric we can compare against?
10. Is there an existing ticket about the hook firing too often?
11. Does the test gateway actually offer both revisions? If not, which one
    replaces `2026-07-28`?
