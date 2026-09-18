# mcp-list-test

A throwaway harness that answers one question with evidence:

> How many times does an Arcade MCP gateway call a configured **contextual-access
> hook** per `tools/list` request, for MCP protocol revisions `2025-11-25` and
> `2026-07-28`?

The expected answer is exactly one hook call per `tools/list`. A prior,
unrelated project observed far more. The audience is the Arcade engine team,
who need a reproducible count rather than an opinion. `DESIGN.md` is the
authoritative record of the architecture and the contracts.

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
  self-contained `results/report.html`: requests sent versus hook hits, per
  revision and per run, with the raw hook payloads attached. `--in <dir>` and
  `--out <file>` point it elsewhere. Hook hits for a method are the difference
  between consecutive `hookHitsAfter` snapshots, and runs whose status is not
  `ok` are counted in the version-mismatch and error columns but kept out of
  min/max/mean. With no run files to read it exits non-zero with
  `no run files in <dir>` rather than writing an empty report. Nothing in the
  HTML is fetched over the network, so it opens from a directory with no
  connection; PDF is the browser's print dialog.

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

## The hook counter

`bun run hook-server` reads `PORT_WEB` and `HOOK_BEARER_TOKEN` and serves
exactly three endpoints (`DESIGN.md` Contracts -> Hook counter HTTP API):

| Endpoint            | Behaviour                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `POST /access`      | Arcade's access-hook contract. Needs `Authorization: Bearer $HOOK_BEARER_TOKEN`, else 401 — and a 401 is **not** counted. Replies with the request body minus every toolkit whose name matches `/^gmail$/i`. |
| `GET /hits?user_id=`| `{ "count": n, "hits": [ { "receivedAt", "payload" } ] }` for that user; an unknown user is `count: 0`, a request with no `user_id` is a 400. |
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

Other code starts the counter directly instead of shelling out:

```ts
import { startHookServer } from "./src/hook-server/server.ts";

const hook = startHookServer({ port: 0, token, logPath: "/tmp/run/hook-log.jsonl" });
// hook.url -> http://127.0.0.1:<ephemeral>
await hook.close();
```

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
gateway. `bun run probe` still prints `not implemented` and exits 1, and it
checks its environment first, so the failure you see tells you which one you
hit. `bun test` is real and must stay green without network access.
