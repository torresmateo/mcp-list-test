# Project context for workers

Implementers and reviewers read this file right after the issue and `DESIGN.md`.
The role prompts are project-agnostic; **everything a worker needs to know about
this codebase goes here.** Fill every section before the first dispatch, and
update it whenever a worker trips on something it should have been told.

---

## What this project is

A throwaway test harness that answers one question: does an Arcade MCP gateway
with a **contextual-access hook** configured call that hook more than once per
`tools/list` request? A prior, unrelated project observed the hook firing far
more often than expected. This repo is a TypeScript (bun) MCP client plus a
local access-hook server that counts every `POST /access` it receives. A run
"works" when, for each MCP protocol revision under test (`2025-11-25` and
`2026-07-28`), it prints one table: MCP method issued, number of hook
invocations observed, and the negotiated protocol version. The operator is
Mateo; the audience is the Arcade engine team, who need a reproducible count,
not an opinion.

## Fresh-worktree quickstart

Exact commands, in order, that go from a clean checkout to a green test run.
`scripts/orca-setup.sh` has already run `bun install --frozen-lockfile` and
written `.env.local` by the time a worker starts.

```sh
bun install --frozen-lockfile              # already done by the setup hook
set -a; . ./.env.local; set +a             # bun does NOT auto-load .env.local
bun run hook-server                        # access-hook counter on $PORT_WEB
bun test                                   # unit tests; must not need network
bun run probe --protocol 2025-11-25        # live probe against the gateway
bun run probe --protocol 2026-07-28
# nothing to stop except the hook server (Ctrl-C)
```

## Environment facts that will bite you otherwise

- **Your worktree owns a port block.** `.env.local` carries `PORT_BASE`,
  `PORT_WEB`, `PORT_DB` and `COMPOSE_PROJECT_NAME`, written by
  `scripts/orca-setup.sh`. Never hard-code a port. The hook server listens on
  `$PORT_WEB`.
- **Which tools read `.env.local` and which do not.** bun loads `.env` and
  `.env.local` automatically for `bun run` and `bun test`, but any shell
  command (curl, ngrok, arcade CLI) does not; export it first with
  `set -a; . ./.env.local; set +a`.
- **The gateway is remote; the hook server is local.** Arcade's cloud gateway
  must reach your hook over the public internet. A tunnel (ngrok or similar)
  is required and its URL is registered in the Arcade Dashboard as the
  extension endpoint. Registration is Dashboard-only; there is no CLI or
  config file for it. Docs:
  https://docs.arcade.dev/en/operate/governance/contextual-access/build-your-own
  Reference hook implementations (Go): https://github.com/ArcadeAI/logic-extensions-examples
- **Credentials are never committed.** `ARCADE_API_KEY`, the gateway URL, and
  the hook bearer token live in `.env.local` only, added by hand by the
  operator. Tests that need them must **fail loudly** when they are missing,
  not skip.
- **Suites that skip instead of fail.** None allowed. If a live probe cannot
  reach the gateway it must exit non-zero with the reason. A skipped test is
  not a passing test.
- **Protocol version is negotiated, not assumed.** The client must send the
  requested revision in `initialize` and in the `MCP-Protocol-Version` header,
  and must **assert** the server echoed the same revision. A silent fallback
  makes both probes test the same thing.
- **Generated files.** None yet. `bun.lock` is the lockfile the setup hook
  detects; commit it.
- **Keys and identity.** The hook counter is keyed by `user_id` from the
  access-hook payload plus the client-side request id. Two probes run against
  the same gateway in parallel will pollute each other's counts; run them
  serially.

## What this project fails at

The reviewer weights its attention by this list.

- **Miscounting hook fires.** Client retries, SSE reconnects, or the SDK
  issuing `tools/list` more than once behind the caller's back inflate the
  count and produce a false positive. Evidence that it did not happen: the
  probe logs every outbound JSON-RPC request with its id, and the count table
  cross-references hook hits to request ids.
- **Wrong protocol version tested.** The SDK negotiates down to a default and
  the two "versions" are identical. Evidence: the negotiated version in the
  `initialize` result is printed and asserted per run.
- **Cached session hides the bug.** A reused session or token skips the access
  path entirely and `tools/list` shows zero hook hits. Evidence: each probe
  starts a fresh session and the hook server shows at least one hit.
- **Green with no gateway.** Tests mock or skip when `ARCADE_API_KEY` or the
  gateway URL is absent and still print green. Evidence: the CI-safe unit
  suite and the live probe are separate commands, and the live one exits
  non-zero without credentials.

## Non-negotiables

- Never commit `ARCADE_API_KEY`, gateway URLs with embedded keys, tunnel URLs,
  or hook bearer tokens.
- Do not create, modify, or delete Arcade projects, gateways, or extensions in
  the Dashboard; that is the operator's job and is gated through the human.
- Do not call any tool via `tools/call` against the gateway unless the slice
  explicitly asks for it; `tools/list` is the surface under test.

## Where things live

- `src/client/` — MCP client wrapper; one entry per protocol revision.
- `src/hook-server/` — local access-hook HTTP server and invocation counter.
- `src/probe.ts` — CLI that runs one probe and prints the count table.
- `test/` — unit tests; no network.
- `scripts/orca-*.sh` — Orca worktree hooks (ports, install).
- `.orca/` — orchestration role prompts; `.orca/local/` is gitignored.
- `DESIGN.md` — architecture and contracts; workers never edit it.
