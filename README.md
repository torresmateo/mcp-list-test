# mcp-list-test

A throwaway harness that answers one question with evidence:

> How many times does an Arcade MCP gateway call a configured **contextual-access
> hook** per `tools/list` request, how much does it send each time, and what
> does that cost in latency?

A prior, unrelated project observed a call volume it did not expect. This repo
does not restate that expectation: `DESIGN.md` decision 1 is to characterise
rather than prejudge, because a number stated in advance becomes the thing the
measurement gets read against. What comes out is a profile measured from
outside — invocations, payload size, toolkit and tool counts, how many
`tools/list` requests the client actually issued, and the wall-clock time the
hook round trips added. The audience is the Arcade engine team, who need a
reproducible measurement rather than an opinion. `DESIGN.md` is the
authoritative record of the architecture and the contracts.

Scope today is the `2025-11-25` revision, taken end to end against the real
Arcade gateway; `2026-07-28` is a different protocol *era* and is deferred
(decision 15).

## How the pieces fit together

```
probe ──MCP over Streamable HTTP──▶ Arcade gateway ──POST /access──▶ ngrok ──▶ hook counter
  │                                                                              │
  └──────────────────── GET /hits?user_id= ◀─────────────────────────────────────┘
  └──▶ results/<ts>-<revision>-<n>.json ──▶ report ──▶ results/report.html
```

- **Probe** (`bun run probe`) opens a fresh MCP session per repetition against
  the gateway with the official v2 MCP SDK (`@modelcontextprotocol/client`),
  sends `initialize` then one `tools/list`, and after each request polls the
  hook counter for hits keyed by that repetition's generated user id. One JSON
  file per run lands in `results/`.
- **Hook counter** (`bun run hook-server`) is the local HTTP server the gateway
  calls. It implements Arcade's access-hook contract at `POST /access` on
  `$PORT_WEB`, verifies a bearer token, counts every hit by `user_id`, appends
  raw payloads to `results/hook-log.jsonl`, and answers
  `GET /hits?user_id=` for the probe. Its policy is fixed: deny the Gmail
  toolkit, allow everything else, expressed as the contract's `deny` list —
  zero Gmail tools in a `tools/list` result is how you know the hook was
  consulted at all.
- **Report** (`bun run report`) reads `results/*.json` and writes a
  self-contained `results/report.html`: requests sent versus hook hits, what
  each hit carried and what it cost, per revision and per run, with the raw
  hook payloads attached. `--in <dir>` and `--out <file>` point it elsewhere.
  Hook hits for a method are the difference between consecutive
  `hookHitsAfter` snapshots, and runs whose status is not `ok` are counted in
  the version-mismatch and error columns but kept out of min/max/mean. With no
  run files to read it exits non-zero with `no run files in <dir>` rather than
  writing an empty report. Nothing in the HTML is fetched over the network, so
  it opens from a directory with no connection; PDF is the browser's print
  dialog. See **The report** below.

The gateway is remote and the hook counter is local, so Arcade's cloud has to
reach your machine over a tunnel (ngrok or similar). Registering that tunnel URL
as the extension endpoint is Dashboard-only work, and it belongs to the
operator.

## Fresh-worktree quickstart

```sh
bun install --frozen-lockfile              # already done by the setup hook
set -a; . ./.env.local; set +a             # bun does NOT auto-load .env.local
bun run hook-server                        # access-hook counter on $PORT_WEB
bun test                                   # unit tests; must not need network
bun run probe --protocol 2025-11-25        # live probe, 5 fresh sessions
bun run probe --protocol 2026-07-28
bun run report                             # results/*.json -> results/report.html
# nothing to stop except the hook server (Ctrl-C); ngrok is the operator's
```

`scripts/orca-setup.sh` runs before you do: it claims this worktree's port block,
writes `.env.local`, and runs `bun install --frozen-lockfile`. Never hard-code a
port — the hook server listens on `$PORT_WEB` from that file.

One line of that quickstart does not work yet, and says so rather than
pretending: `--protocol 2026-07-28` is the `modern` era, deferred by
`DESIGN.md` decision 15 until there is a live number for `2025-11-25`. The
probe exits non-zero naming the revision and the ones it can request, instead
of quietly measuring `2025-11-25` and labelling the file `2026-07-28`.

## Configuration

`.env.local` is never committed. `scripts/orca-setup.sh` writes the port block;
the operator adds the four credentials by hand. A fifth entry is optional. The
names are fixed by the Environment table in `DESIGN.md`:

| Variable                | Written by              | Meaning                                             |
| ----------------------- | ----------------------- | --------------------------------------------------- |
| `PORT_WEB`              | `scripts/orca-setup.sh` | Hook counter listen port                            |
| `ARCADE_API_KEY`        | operator                | Bearer for the gateway                              |
| `ARCADE_MCP_URL`        | operator                | Streamable HTTP endpoint of the test gateway        |
| `HOOK_BEARER_TOKEN`     | operator                | Token the gateway sends; hook rejects anything else |
| `HOOK_PUBLIC_URL`       | operator                | ngrok URL, recorded in run JSON for provenance      |
| `ARCADE_USER_ID_PREFIX` | operator, **optional**  | Replaces `probe` in the generated `user_id`. Unset or empty, the default applies and nothing else changes. Supplied and invalid — `" "` included — is an exit, not a fallback |

Nothing skips when a variable is absent. Every command that needs one loads it
through `loadEnv()` in `src/env.ts`, which exits non-zero and prints
`missing <VARIABLE>` on stderr, naming the first one it could not find in the
order of the table above:

```console
$ bun run probe --protocol 2025-11-25
missing ARCADE_API_KEY
```

`ARCADE_USER_ID_PREFIX` is the one optional entry, and it is the only one whose
*absence* is not an error. A value it cannot use still is:

```console
$ ARCADE_USER_ID_PREFIX="my probe" bun run probe --protocol 2025-11-25
invalid ARCADE_USER_ID_PREFIX="my probe": must match ^[A-Za-z0-9._-]+$

$ ARCADE_USER_ID_PREFIX=" " bun run probe --protocol 2025-11-25
invalid ARCADE_USER_ID_PREFIX=" ": must match ^[A-Za-z0-9._-]+$
```

Two cases, and the line between them is the whole point:

| `.env.local` says | What happens |
| --- | --- |
| nothing, or `ARCADE_USER_ID_PREFIX=` | The variable was not supplied. `probe` applies and nothing about the run changes |
| `ARCADE_USER_ID_PREFIX=" "`, or anything else failing the rule | The variable *was* supplied and is wrong. Exit 1 naming it |

A lone space is the second case. It is the easiest version of this mistake to
make and the hardest to spot in a `.env.local`, and treating it as an omission
would produce a completed run under `probe` with every number looking healthy.

The alphabet is narrow because the prefix ends up in two places that do not
agree on what survives: the Arcade user header, and the `GET /hits?user_id=`
query the probe polls the counter with. A space is legal in a header value and
becomes `%20` or `+` in a query; `%` starts an escape on one path and means
nothing on the other. A prefix the two encode differently has the hook called
under one id and polled under another, and the run reports `hookHits: []` — a
clean zero indistinguishable from "the hook never fired", which is the thing
this repo exists to measure. So a bad value is a non-zero exit naming the
variable, and it never falls back to `probe`: a run that quietly measured the
default while the operator believed it measured their prefix is the same wrong
answer wearing a different hat — and `probe` is a real key that really works, so
nothing in the output would look wrong.

## The probe

`bun run probe --protocol <revision>` is the measurement. Per repetition it
generates a fresh user id — `<prefix>-<revision>-<timestamp>-<n>`, where
`<prefix>` is `$ARCADE_USER_ID_PREFIX` or `probe`, and the trailing `-<n>` is
**not configurable**, because five repetitions have to be five distinct end
users or a cached session can hide the behaviour being measured — opens a new
MCP session against `$ARCADE_MCP_URL`
over Streamable HTTP with the v2 SDK client, sends `initialize` then one
`tools/list`, and writes one JSON file to `results/`.

```console
$ set -a; . ./.env.local; set +a
$ bun run probe --protocol 2025-11-25 --repetitions 2
probe: 2 repetitions of 2025-11-25 against https://api.arcade.dev/v1/mcps/...
probe: hook counter http://127.0.0.1:3411, quiescence 2000 ms
results/20260918T203958539Z-2025-11-25-1.json
  probe-2025-11-25-1789763998538-1  [ok]  negotiated 2025-11-25
    method          hits  duration
    initialize         0  13.0 ms
    tools/list         3  6.6 ms
    tools/list: 1 request, no cursor; 1 tools listed, 0 Gmail
    not offered to the hook: none; every listed tool was in a hook payload
```

| Flag                 | Default      | Meaning                                                      |
| -------------------- | ------------ | ------------------------------------------------------------ |
| `--protocol`         | *required*   | Revision to request. Validated against what the client can ask for |
| `--repetitions`      | `5`          | Fresh sessions, run serially                                  |
| `--out`              | `results`    | Where the run JSON lands                                      |
| `--quiesce-ms`       | `2000`       | How long the hook count must hold still before a snapshot     |
| `--poll-interval-ms` | a quarter of the window | Gap between reads of `GET /hits`                   |
| `--hook-url`         | `http://127.0.0.1:$PORT_WEB` | Where to read the counter. `HOOK_PUBLIC_URL` is the tunnel *Arcade* calls and is recorded for provenance only |

Every outbound JSON-RPC request goes through a wrapping `fetch`, so the run
records what the client actually sent rather than what it was asked to send.
That matters in three places a count alone would mislead you:

- **Pagination is a number, not something you infer.** The SDK walks
  `tools/list` pages for you, so one call can be three requests. `requests[]`
  has a row per request with its own hook snapshot, and `toolsListRequests` and
  `cursorFollowed` say so outright.
- **Latency is measured to the reply, not to the response headers.** A hook
  that filters a tool list has to answer before the list can come back, so its
  round trip is on the critical path; `durationMs` per request is where the
  cost of that shows up against the hook server's own handling time.
- **The tool list is recorded, not just counted.** `toolsListResult` is the
  `tools/list` result as the gateway put it on the wire — whole, in order,
  across every page, and including fields the MCP spec does not name, which the
  SDK's own parse would have dropped on the way to the caller. It sits beside
  `hookHits`, which is what the same gateway told the hook in the same session,
  so the two sides of the comparison are both in the file and a reader can
  derive the difference instead of taking a count on trust
  (`DESIGN.md` decision 18).

`toolsNotOfferedToHook` is that difference, named: the tools the gateway listed
that appear in **no** hook payload, sorted. No policy can deny a tool that was
never submitted to access control, and the live run of 2026-09-19 found two of
them among 42 — a gap the instrument could count but not name. It is **`null`,
never `[]`**, when the run has nothing to derive it from: no hook hits, or no
`tools/list` result. An empty array would read as "nothing bypassed the hook",
which is a false statement dressed as a measurement.

Matching the two sides means reassembling a name: MCP names a tool
`Toolkit_Tool` in one string, the hook payload names toolkit and tool apart. The
comparison drops separators and case rather than assuming one spelling, because
a wrong assumption makes *every* tool fail to match and the run reports that the
whole catalogue bypassed the hook — a dramatic finding that would be entirely an
artefact of the join. When nothing matches at all, the probe says so in place of
reporting it as a discovery.

Nothing falls back to a plausible value. A missing credential, a revision the
client cannot request, an unreachable gateway, an unreachable hook counter and
a gateway that negotiates a different revision are each a non-zero exit that
names what happened — and every one of them, bar the first two, still writes
the run JSON so the failure is evidence rather than a message that scrolled
past. `status` is `ok`, `version-mismatch` or `error`; `revisionNegotiated` is
`null` when nothing was negotiated, and `error` is `null` only when `status` is
`ok`.

## The hook counter

`bun run hook-server` reads `PORT_WEB` and `HOOK_BEARER_TOKEN` and serves
exactly three endpoints (`DESIGN.md` Contracts -> Hook counter HTTP API):

| Endpoint            | Behaviour                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `POST /access`      | Arcade's access-hook contract. Needs `Authorization: Bearer $HOOK_BEARER_TOKEN`, else 401 — and a 401 is **not** counted. Replies with the contract's `AccessHookResult` — `{"deny": {"<Toolkit>": <ToolkitInfo as received>}}` naming every toolkit whose name matches `/^gmail$/i`, and `{}` when the request carried none. It is **not** an echo of the request: see **The answer is a deny list** below. |
| `GET /hits?user_id=`| `{ "count": n, "hits": [ <hit> ] }` for that user — see **What a hit records** below; an unknown user is `count: 0`, a request with no `user_id` is a 400. |
| `GET /healthz`      | 200.                                                                                        |

```console
$ set -a; . ./.env.local; set +a
$ bun run hook-server
hook-server listening on :3411
appending hits to /path/to/worktree/results/hook-log.jsonl
```

Every accepted hit appends one JSON line to `results/hook-log.jsonl` before the
response goes out, so `wc -l` on that file and the count from `/hits` never
disagree. `--log <path>` points it somewhere else. `PORT_WEB=0` binds an
ephemeral port and the listening line reports the one it got.

### The answer is a deny list

`AccessHookResult` — from `logic_extensions/http/1.0/schema.yaml` in
[ArcadeAI/schemas](https://github.com/ArcadeAI/schemas), which Arcade's
[build-your-own guide](https://docs.arcade.dev/en/operate/governance/contextual-access/build-your-own)
names as canonical — is `{ only?: Toolkits, deny?: Toolkits }`. `Toolkits` is
the same map shape the request's `toolkits` uses, so a deny names toolkits and
their tools:

```json
{ "deny": { "Gmail": { "tools": { "SendEmail": [ { "version": "1.0.0" } ] } } } }
```

Three rules, and the third is the one that bites:

| Response                      | What the engine does                          |
| ----------------------------- | --------------------------------------------- |
| `only` present                | **Only** those tools are allowed; `deny` is ignored |
| `deny` present, no `only`     | Those tools are removed                        |
| **neither present**           | **No change — every tool stays allowed**       |

This hook answers `{"deny": {...}}` when a request carries a Gmail toolkit and
`{}` when it does not. `{}` is row three on purpose: a request with no Gmail in
it is one this policy has no opinion about.

Until #21 the hook answered with *the request body minus Gmail*. That is row
three as well — it carries neither field — so it denied nothing and Gmail
stayed listed. It read like a deny to a human and was a silent fail-open to the
engine, and `gmailToolsListed` in a live run would have been uninterpretable:
non-zero would have meant "we never expressed a deny", which is far too easy to
misread as "the gateway ignored our deny". `DESIGN.md` decision 6 records the
amendment; `test/fake-gateway.test.ts` pins the trap against a rendered
`tools/list`.

### What a hit records

A count alone does not tell the engine team what an access hook costs them, so
every hit carries the *shape and cost* of the invocation (`DESIGN.md`
decision 17). `/hits` and each JSONL line hold the same record:

```json
{
  "receivedAt": "2026-09-18T20:17:14.234Z",
  "headers": { "authorization": "Bearer <redacted len=10 sha256=7c43ef5a>", "content-type": "application/json", "traceparent": "00-4bf9...-01", "x-api-key": "<redacted len=37 sha256=9c0de2fd>", "x-arcade-whatever": "a-header-nobody-allow-listed" },
  "toolkitCount": 2,
  "toolCount": 4,
  "versionCount": 5,
  "bodyBytes": 243,
  "handlingMs": 0.428,
  "payload": { "user_id": "probe-demo-1", "toolkits": { "Slack": { "tools": { "PostMessage": [ { "version": "1.0.0" }, { "version": "2.0.0" } ] } } } }
}
```

| Field | Meaning |
| ----- | ------- |
| `receivedAt`   | ISO-8601 instant the request arrived, taken before any work on it. |
| `headers`      | **Every** request header. No allow-list on which ones; values verbatim except for credential headers, which are redacted — see below. |
| `toolkitCount` | Toolkits in the payload as it arrived. |
| `toolCount`    | Tool names across every toolkit. |
| `versionCount` | **Total version entries across every tool** — not tools-that-have-versions, and not distinct version strings. |
| `bodyBytes`    | Byte length of the raw request body, measured before parsing. |
| `handlingMs`   | The server's *own* handling time: received to response ready. Not client-observed latency — the report shows the two separately. |
| `payload`      | The body exactly as the gateway sent it, unfiltered — Gmail included. |

The counts describe what arrived, not what went back: a Gmail toolkit the
policy names in its `deny` is still counted in the profile.

### Credential headers are redacted at capture

No allow-list decides *which* headers are captured: we do not yet know which
ones a real Arcade gateway sends, and a hit that cannot be tied back to the
request that caused it is a hit you can only count, not explain.

The values of credential-bearing headers are another matter. A recorded hit
travels `GET /hits` → the probe's `hookHits[]` → `results/<run>.json` →
`evidence/`, which is committed to a **public** repository, so the secret is
replaced the moment it is read and is never stored:

| Header | Recorded as |
| ------ | ----------- |
| `authorization`, `proxy-authorization` | `Bearer <redacted len=43 sha256=1f3a9c2b>` — scheme in the clear, credential described |
| `cookie`, `set-cookie`, `x-api-key` | `<redacted len=37 sha256=9c0de2fd>` — no scheme, redacted whole |

`len` is the byte length of what was removed and the digest is the first 8 hex
of its SHA-256, both stable across hits. That is deliberate: it keeps the one
diagnostic the raw value would have given us — *the same value arrived every
time* — while the value itself never lands on disk. Nothing real is lost, since
the server has already verified the bearer: a recorded hit is by definition one
that authenticated.

The list matches header **names**, case-insensitively, and nothing else. No
value is pattern-matched, and `traceparent`, `user-agent`, `x-arcade-user-id`
and anything else a gateway sends stay exactly as they arrived — discovering
them is the point of the instrument.

Other code starts the counter directly instead of shelling out:

```ts
import { startHookServer } from "./src/hook-server/server.ts";

const hook = startHookServer({ port: 0, token, logPath: "/tmp/run/hook-log.jsonl" });
// hook.url -> http://127.0.0.1:<ephemeral>
await hook.close();
```

## The report

`bun run report` turns the run files into one HTML page. The summary table has
a row per protocol revision; each run section below it has **one ordered wire
timeline** — every request the client sent and every hit the counter received,
interleaved oldest first — and every row expands.

| Summary column | What it says |
| -------------- | ------------ |
| min / max / mean hits on `tools/list` | Hook hits attributed to `tools/list`, as the difference between consecutive `hookHitsAfter` snapshots |
| hits on `initialize` | The same attribution for the handshake |
| toolkits / tools per hook hit | `toolkitCount` and `toolCount` across the revision's hits: one number when every hit agreed, `1–3` when they did not |
| tool set across hits | Whether every hit carried the *same* toolkit and tool **names**, said outright — equal counts are not an identical set |
| bytes sent to hook | Total `bodyBytes` over those hits |
| `tools/list` requests issued | How many requests actually went out, and the spread per run |
| hook server handling (ms) | The hook counter's own received-to-answered time, summed |
| client-observed `tools/list` (ms) | The wall clock the client waited on its `tools/list` requests, summed |

### The two latency numbers are never summed

`hook server handling` is the counter's *own* time, and it excludes the
counter's JSONL append, because the number has to be inside the line it writes.
It is therefore neither what the hook cost the gateway nor what the client
waited for. `client-observed tools/list` is the whole round trip, hook calls
included because they sit on the request path.

The gap between the two is the interesting number: the tunnel, the gateway, and
the hook work that falls outside the hook's own measurement. One blended figure
would hide where the time went, so the report prints both and adds them
nowhere.

### Paging is stated, not left to be derived

A hook count that is high because the client fetched three pages is a different
result from one that is high per request. The top of the report says which it
is looking at before the summary table — naming the runs that issued more than
one `tools/list` request, or saying plainly that every run issued exactly one —
and each such run repeats it in its own section.

### Absent is not zero

A run file written before the probe and the counter measured any of this
carries none of these fields, and those cells read `not recorded` rather than
`0`: a zero here would be a measurement, from a run that never made one. When
only some of a revision's runs carry a field, the cell says so —
`612 (3 of 6 hits)`.

### The wire timeline

One table per run, both sides in one sequence. Each row says which side it was
(`client → gateway` or `gateway → hook`), what crossed (`initialize`,
`tools/list`, `POST /access`), when, and how many milliseconds after the run's
first event — so the ordering is legible without arithmetic. Two running totals
accumulate down the table, cumulative hook hits and cumulative bytes sent to the
hook, and they grow on the row that caused them.

The two latency numbers keep separate columns and can never land on the same
row: a request row has no hook handling time and a hit row has no client round
trip. There is nothing to add together.

### Every hook hit names the request that caused it

`hookHitsAfter` is cumulative per user id, so the hits whose index falls between
two consecutive snapshots are the ones that request caused. The report derives
that — no probe field was added and the run JSON is unchanged — and each run
states its own split, `initialize 2 · tools/list 2`, beside its other metadata.

A hit that arrived after the last snapshot reads **`not attributed`**. No
request can be shown to have caused it, and folding it into the first method
would invent an attribution the data does not support.

### Per-row detail

Every row expands, collapsed by default. A hook hit shows its payload and every
captured request header; an MCP request shows what the run JSON holds — method,
JSON-RPC id, status, round trip, the user-id header observed — and says **`body
not recorded`**, because `src/client/request-log.ts` pipes the response through
rather than cloning it and no MCP body was ever captured. An empty object is
never rendered as though it were the payload.

Credential headers arrive already redacted by the counter and are printed
exactly as stored, on every hit — a repeated `Bearer <redacted len=43
sha256=1f3a9c2b>` is the evidence that the same value arrived every time, so
nothing is collapsed into "same as above". That holds whatever happened to the
payloads: deduplication is a statement about payload bodies and nothing else.

### The JSON explorer, and the report that fits in a browser

Payloads open as a collapsible tree. Large objects and arrays are summarised —
`{125 keys}`, `[8258 items]` — until you open them, and each level builds only
when you expand it, so opening one row of a report does not build a tree for the
document. The script is **inline**: the engine team opens this file from a
directory with no network, so nothing is fetched. With scripting off, every
payload is still there, whole, inside `<details><summary>raw JSON</summary>` —
the explorer is an enhancement over evidence that is already on the page.

Each distinct payload is embedded **once**: later hits carrying the same bytes
show their sha-256 and name the hit that carries the copy. The comparison is
over the payload bytes, not over `bodyBytes` or the tool counts — a payload that
differs anywhere, by one tool, is embedded in full, and a test covers exactly
that case, because a report that quietly hid a difference between two hits would
be the failure this whole project exists to catch.

That is not enough on its own, because the live run's five 1.6 MB catalogue
payloads are **not** identical: they differ in `user_id` and nowhere else, so
whole-payload deduplication rightly declines to collapse them and the report
carried five copies of one `toolkits` object for the sake of five id strings. So
a large `toolkits` object shared by more than one payload is stored once too,
and each payload still shows its own fields. Nothing is rewritten — no `$ref` is
invented inside evidence JSON; the payload's own bytes and the shared object's
bytes are both on the page, and the explorer puts them back together into
exactly what the gateway sent. Equality there is computed over the object's
bytes, the same as for a whole payload, and a test covers two same-length
`toolkits` objects that differ by one tool and must both be stored in full.

Above 64 KiB the embedded copy is stored compact rather than pretty-printed.
Compact means whitespace removed and nothing else; nothing is ever truncated.
Below that threshold the stored text is what a person actually reads in the
no-script fallback, so it stays indented. Above it, the explorer does the
formatting and the indentation is weight nobody reads — on the live evidence it
turned a 1,598,220 B payload into 5,061,881 characters.

## The offline fake gateway

`bun test` must be green without network access, so the tests run the probe
against a fake Arcade gateway instead of the real one. It is a Streamable HTTP
MCP server (`@modelcontextprotocol/server`) that imitates the single behaviour
under measurement: it calls the hook counter a configured number of times per
MCP method, forwarding the caller's user id, and lists only the tools the
hook's answer left standing.

```ts
import { startHookServer } from "./src/hook-server/server.ts";
import { startFakeGateway } from "./src/fake-gateway/server.ts";
import { arcadeUserHeaders } from "./src/client/headers.ts";

const hook = startHookServer({ port: 0, token, logPath: "/tmp/run/hook-log.jsonl" });
const gateway = startFakeGateway({ hookUrl: hook.url, hookToken: token, hookCallsPerList: 3 });
// gateway.url -> http://127.0.0.1:<ephemeral>/mcp, for an SDK client whose
// requests carry arcadeUserHeaders(userId)
```

| Option                   | Default                | Meaning                                                     |
| ------------------------ | ---------------------- | ----------------------------------------------------------- |
| `hookCallsPerList`       | `1`                    | Hook calls per `tools/list`, issued serially and awaited     |
| `hookCallsPerInitialize` | `0`                    | Hook calls per `initialize` — configurable, not assumed      |
| `protocolVersion`        | echo the client's      | Version the `initialize` result reports, whatever was asked  |
| `tools`                  | two Gmail, one Slack   | Catalogue, named `Toolkit_Tool`                              |

It applies the hook's answer the way the engine documents `AccessHookResult`:
`only` wins over `deny`, `deny` removes what it names, and a response carrying
**neither** leaves the catalogue untouched. That last case is deliberate — it
is the fail-open the pre-#21 hook triggered, and a fake that could not
reproduce it could not show the bug.

It fails loudly rather than plausibly. A request without the `Arcade-User-Id`
header is an MCP error, never an invented user id. A hook that does not answer
`200` yields an *empty* tool list, never the unfiltered one — a hook we could
not consult is not a hook that allowed everything. And every outbound hook call
is recorded in `gateway.hookCalls` with the HTTP status it got, which is the
only way to tell "the hook rejected us" from "we never called it" — both of
which leave the hit count at `0`.

`src/client/headers.ts` holds the one thing the probe and the fake have to
agree on: `ARCADE_USER_ID_HEADER`, the header carrying the user id the hook
counter keys on. Both read the constant; neither repeats the string. It is
spelled `Arcade-User-Id`, the way the Arcade Dashboard spells it — and every
*reader* of it matches case-insensitively, because header names are
case-insensitive (RFC 9110) and HTTP/2 lowercases them on the wire, so a
case-sensitive reader would see no user header at all against a real gateway.

## Status

Slice #1 was the bootstrap: the bun project, the lockfile, `loadEnv()` and the
package scripts. Slice #2 is the hook counter above, and slice #3 the fake
gateway the offline tests run against. Slice #5 made `bun run report` real — it
renders run JSON into `report.html` and needs no credentials, no network and no
gateway. Slice #11 moved the client onto the v2 scoped SDK packages with no
behaviour change, and slice #4 made `bun run probe` real: it is the measurement
this repo exists for, and every command in the quickstart now does something,
except `--protocol 2026-07-28`, which is deferred. `bun test` is real and must
stay green without network access.

Slice #16 extended the report to decision 17's profile: payload shape and size,
`tools/list` requests actually issued, and the two latency numbers side by side.

Slice #25 reorganised the run sections after the operator's live run produced a
26.0 MB `report.html` that no reader could open and no row of which said which
request had caused a hook hit. The two per-run tables became one ordered wire
timeline, every hit is attributed to the request that caused it, payloads open
in an inline JSON explorer, and each distinct payload is embedded once.

What has not happened yet is the part no test can stand in for: a run against
the real Arcade gateway, with the hook counter behind a tunnel. Until then the
numbers in `results/` come from the fake gateway and are a check on the
instrument, not a finding. `RUNBOOK.md` is the operator's order of play for that
run — hook counter, tunnel, Dashboard, probe, report, curated evidence — with
the checks that tell a broken run from a clean zero.
