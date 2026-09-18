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
  the gateway with the official `@modelcontextprotocol/sdk`, sends `initialize`
  then one `tools/list`, and after each request polls the hook counter for hits
  keyed by that repetition's generated user id. One JSON file per run lands in
  `results/`.
- **Hook counter** (`bun run hook-server`) is the local HTTP server the gateway
  calls. It implements Arcade's access-hook contract at `POST /access` on
  `$PORT_WEB`, verifies a bearer token, counts every hit by `user_id`, appends
  raw payloads to `results/hook-log.jsonl`, and answers
  `GET /hits?user_id=` for the probe. Its policy is fixed: deny the Gmail
  toolkit, allow everything else — zero Gmail tools in a `tools/list` result is
  how you know the hook was consulted at all.
- **Report** (`bun run report`) reads `results/*.json` and writes a
  self-contained `results/report.html`: requests sent versus hook hits, per
  revision and per run, with the raw hook payloads attached.

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

## Status

Slice #1 (this one) is the bootstrap: the bun project, the lockfile, `loadEnv()`
and the package scripts. `bun run probe`, `bun run hook-server` and
`bun run report` currently print `not implemented` and exit 1; the probe checks
its environment first, so the failure you see tells you which one you hit.
`bun test` is real and must stay green without network access.
