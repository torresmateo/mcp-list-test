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
  toolkit, allow everything else — zero Gmail tools in a `tools/list` result is
  how you know the hook was consulted at all.
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
the operator adds the four credentials by hand. The names are fixed by the
Environment table in `DESIGN.md`:

| Variable            | Written by              | Meaning                                             |
| ------------------- | ----------------------- | --------------------------------------------------- |
| `PORT_WEB`          | `scripts/orca-setup.sh` | Hook counter listen port                            |
| `ARCADE_API_KEY`    | operator                | Bearer for the gateway                              |
| `ARCADE_MCP_URL`    | operator                | Streamable HTTP endpoint of the test gateway        |
| `HOOK_BEARER_TOKEN` | operator                | Token the gateway sends; hook rejects anything else |
| `HOOK_PUBLIC_URL`   | operator                | ngrok URL, recorded in run JSON for provenance      |

Nothing skips when a variable is absent. Every command that needs one loads it
through `loadEnv()` in `src/env.ts`, which exits non-zero and prints
`missing <VARIABLE>` on stderr, naming the first one it could not find in the
order of the table above:

```console
$ bun run probe --protocol 2025-11-25
missing ARCADE_API_KEY
```

## The probe

`bun run probe --protocol <revision>` is the measurement. Per repetition it
generates a fresh user id, opens a new MCP session against `$ARCADE_MCP_URL`
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
That matters in two places a count alone would mislead you:

- **Pagination is a number, not something you infer.** The SDK walks
  `tools/list` pages for you, so one call can be three requests. `requests[]`
  has a row per request with its own hook snapshot, and `toolsListRequests` and
  `cursorFollowed` say so outright.
- **Latency is measured to the reply, not to the response headers.** A hook
  that filters a tool list has to answer before the list can come back, so its
  round trip is on the critical path; `durationMs` per request is where the
  cost of that shows up against the hook server's own handling time.

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
| `POST /access`      | Arcade's access-hook contract. Needs `Authorization: Bearer $HOOK_BEARER_TOKEN`, else 401 — and a 401 is **not** counted. Replies with the request body minus every toolkit whose name matches `/^gmail$/i`. |
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

The counts describe what arrived, not what went back: a Gmail toolkit that the
policy strips from the response is still counted in the profile.

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
a row per protocol revision; the run sections below it have the request
timeline, a row per hook hit, and the raw payloads.

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

### Per-hit detail

Each run section lists its hits: `receivedAt`, toolkit/tool/version counts,
`bodyBytes`, the hook server's `handlingMs`, and every captured request header.
Credential headers arrive already redacted by the counter and are printed
exactly as stored, on every hit — a repeated `Bearer <redacted len=43
sha256=1f3a9c2b>` is the evidence that the same value arrived every time, so
nothing is collapsed into "same as above". The raw payload still follows as
pretty-printed JSON.

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

It fails loudly rather than plausibly. A request without the `Arcade-User-ID`
header is an MCP error, never an invented user id. A hook that does not answer
`200` yields an *empty* tool list, never the unfiltered one. And every outbound
hook call is recorded in `gateway.hookCalls` with the HTTP status it got, which
is the only way to tell "the hook rejected us" from "we never called it" — both
of which leave the hit count at `0`.

`src/client/headers.ts` holds the one thing the probe and the fake have to
agree on: `ARCADE_USER_ID_HEADER`, the header carrying the user id the hook
counter keys on. Both read the constant; neither repeats the string.

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

What has not happened yet is the part no test can stand in for: a run against
the real Arcade gateway, with the hook counter behind a tunnel. Until then the
numbers in `results/` come from the fake gateway and are a check on the
instrument, not a finding.
