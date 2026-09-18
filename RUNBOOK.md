# Runbook — the live run against the real Arcade gateway

For the operator (Mateo), who owns the Arcade Dashboard, the tunnel and the four
credentials. Workers never do any of it.

What this produces: a set of run JSON files and an HTML report measuring **how
many times an Arcade MCP gateway calls a contextual-access hook per `tools/list`
request, how much it sends each time, and what it costs in latency**, copied
into `evidence/<date>/` with a `NOTES.md`. That is the deliverable the Arcade
engine team reads.

Budget about 45 minutes, most of it in the Dashboard. Two terminals: one for the
hook counter, one for ngrok, plus the one you work in.

**Scope is one protocol revision, `2025-11-25`.** `2026-07-28` is a different
protocol *era* and is deferred (`DESIGN.md` decisions 15–17). There is exactly
one probe invocation in this runbook. Do not try to add a second. See
[step 5](#step-5--run-the-probe).

Read the steps in order. Each one says what you should see and what it means if
you do not, because in this harness **a broken run and a clean zero look the
same**: an empty `hookHits` reads as "the hook never fired", which is the very
thing we came to measure. Steps 2 and 6 exist to tell those two apart, and they
are not optional.

---

## Contents

- [Step 0 — pre-flight, offline](#step-0--pre-flight-offline)
- [Step 1 — start the hook counter](#step-1--start-the-hook-counter)
- [Step 2 — start ngrok and prove the tunnel works](#step-2--start-ngrok-and-prove-the-tunnel-works)
- [Step 3 — Dashboard: project, gateway, extension](#step-3--dashboard-project-gateway-extension)
- [Step 4 — fill the four env vars](#step-4--fill-the-four-env-vars)
- [Step 5 — run the probe](#step-5--run-the-probe)
- [Step 6 — the verification gate: before you trust any count](#step-6--the-verification-gate-before-you-trust-any-count)
- [Step 7 — generate the report](#step-7--generate-the-report)
- [Step 8 — curate evidence and check it for secrets](#step-8--curate-evidence-and-check-it-for-secrets)
- [Step 9 — write NOTES.md](#step-9--write-notesmd)
- [Step 10 — shut everything down and rotate the tunnel](#step-10--shut-everything-down-and-rotate-the-tunnel)
- [Troubleshooting](#troubleshooting)

---

## Step 0 — pre-flight, offline

Two minutes, no credentials, no network. It rules out "the harness was broken all
along" before you spend anything in the Dashboard.

```sh
cd <this worktree>
set -a; . ./.env.local; set +a     # ngrok and curl do not read .env.local on their own
echo "PORT_WEB=$PORT_WEB"
bun test
```

**You should see** a port number, and a green suite. It is `138 pass`, `0 fail`
today. `bun test` needs no network and no credentials.

**If you do not:** an empty `PORT_WEB` means `scripts/orca-setup.sh` has not run
in this worktree; run it. A failing suite is a code problem, not an operator
problem. Stop here and open an issue rather than running against Arcade.

You also need, before step 1, a **hook bearer token**. You invent it; the
Dashboard is told about it in step 3. Any long random string:

```sh
openssl rand -hex 32
```

Put it in `.env.local` now as `HOOK_BEARER_TOKEN=...`. The hook counter will not
start without it. The other three variables come in step 4.

> **`.env.local` is rewritten, not merged.** `scripts/orca-setup.sh` truncates
> the file every time it runs (`scripts/orca-setup.sh` writes it with `>`), so
> re-running setup deletes all four credentials. If a command suddenly reports
> `missing ARCADE_API_KEY` mid-run, that is the first thing to check.

---

## Step 1 — start the hook counter

In terminal 1, and leave it running:

```sh
set -a; . ./.env.local; set +a
bun run hook-server
```

**You should see**, with your own `PORT_WEB` and path:

```console
hook-server listening on :3420
appending hits to /path/to/worktree/results/hook-log.jsonl
```

Confirm locally before you tunnel anything:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT_WEB/healthz"   # 200
```

**If you do not:** `missing HOOK_BEARER_TOKEN` means step 0's token never made it
into `.env.local`. `EADDRINUSE` means something else owns your port block. This
worktree owns `$PORT_WEB`, and nothing here should ever be given a hard-coded
port.

---

## Step 2 — start ngrok and prove the tunnel works

Arcade's gateway is in the cloud and the counter is on your machine, so the hook
has to be reachable from the public internet.

In terminal 2:

```sh
set -a; . ./.env.local; set +a
ngrok http "$PORT_WEB"
```

**You should see** a `Forwarding` line: `https://<something>.ngrok.app -> http://localhost:3420`.
That HTTPS URL is your `HOOK_PUBLIC_URL`. If you prefer to read it as data:

```sh
curl -s http://127.0.0.1:4040/api/tunnels | bun -e 'console.log((await Bun.stdin.json()).tunnels.map(t => t.public_url).join("\n"))'
```

### Now prove it end to end. This is the step that catches the expensive bug

A tunnel that is registered but not actually delivering produces a perfectly
clean run with zero hook hits. Do not discover that after the Dashboard work.
Substitute your own URL and token:

```sh
HOOK_PUBLIC_URL="https://<something>.ngrok.app"    # the one ngrok just printed

# 1. reachable from outside at all
curl -s -o /dev/null -w '%{http_code}\n' "$HOOK_PUBLIC_URL/healthz"

# 2. the real endpoint, with the real token, through the public URL
curl -s -X POST "$HOOK_PUBLIC_URL/access" \
  -H "Authorization: Bearer $HOOK_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"runbook-tunnel-check","toolkits":{"Gmail":{"tools":{"SendEmail":[{"version":"1.0.0"}]}},"Slack":{"tools":{"PostMessage":[{"version":"1.0.0"}]}}}}'

# 3. it was counted, under that user id
curl -s "http://127.0.0.1:$PORT_WEB/hits?user_id=runbook-tunnel-check"
```

**You should see** `200`; then a body with the **Gmail toolkit removed** and
Slack still present (that is the hook's fixed policy, `DESIGN.md` decision 6);
then `"count": 1` with the hit recorded.

**If you do not:**

| What you got | What it means |
| --- | --- |
| `curl` cannot connect / DNS fails | ngrok is not running, or you typed a stale URL from an earlier session. |
| HTML instead of JSON | You reached ngrok's browser interstitial rather than the counter. Re-check it is the `Forwarding` URL, not the web-inspector URL (`127.0.0.1:4040`). |
| `401` | The token in the `Authorization` header is not `$HOOK_BEARER_TOKEN`. **A 401 is not counted** (`DESIGN.md` decision 7), so this failure is silent in the numbers. |
| `200` but `"count": 0` | The request reached *something*, but not this counter. Check terminal 1 is still the server you are curling. |

Only when all three succeed is the tunnel real. Do not restart ngrok after this
point: a free-tier URL changes on every start, and the Dashboard would be
pointing at a dead one.

---

## Step 3 — Dashboard: project, gateway, extension

All of this is in the Arcade Dashboard. There is no CLI or config file for it.
Reference: <https://docs.arcade.dev/en/operate/governance/contextual-access/build-your-own>

1. **Create a dedicated test project.** Do not reuse a project that anything
   else depends on. The extension below is configured to **fail closed**, which
   blocks tool listing for the whole project if the hook is down
   (`DESIGN.md` decision 13). Note its API key; it becomes `ARCADE_API_KEY`.
2. **Create one MCP gateway in that project**, exposing **Gmail plus at least one
   other toolkit** (Slack, GitHub, anything). Two toolkits and roughly fifty
   tools is a measurement instrument, not an accident: a payload carrying the
   whole catalogue is obviously distinguishable from one carrying a single tool,
   so any per-tool or per-toolkit fan-out shows up immediately. Copy the
   gateway's Streamable HTTP endpoint; it becomes `ARCADE_MCP_URL`.
3. **Create one extension**, a contextual-access hook, and configure:
   - **URL / endpoint**: your `HOOK_PUBLIC_URL` from step 2. The access hook
     itself is served at **`/access`** on that host, which is the documented
     default path; if the Dashboard asks for the base URL, give the host, and if
     it asks for the full access-hook URL, give `<HOOK_PUBLIC_URL>/access`. The
     endpoint path is configurable in the Dashboard. Whatever you set there
     must end at `/access`, because that is the only path this counter serves.
   - **Auth**: bearer token = the `HOOK_BEARER_TOKEN` you generated in step 0.
     The counter rejects anything else with a 401 and does not count it.
   - **Failure mode**: **fail closed**. A hook that silently fails open would let
     a run complete with no hits and look like an answer.
   - **Timeout**: short. The documented default is 5 s and that is fine. The
     counter replies immediately with no artificial delay, so a timeout here
     means a real problem, not a slow policy.
   - Enable the **access** hook. Pre-execution and post-execution hooks are
     explicitly out of scope (`DESIGN.md` non-goals), so leave them off.
4. **Attach the extension to the gateway** from step 2 and make sure it is
   enabled.

**Sanity check before you leave the Dashboard:** terminal 1 may already show
traffic. It is normal for it to show none yet, because nothing has called
`tools/list`.

---

## Step 4 — fill the four env vars

`.env.local` is **never committed** (it is gitignored) and is the only place
these live. The names are fixed by `DESIGN.md` → Contracts → Environment:

```sh
# append to .env.local, below the block scripts/orca-setup.sh wrote
ARCADE_API_KEY=...            # the test project's key
ARCADE_MCP_URL=...            # the gateway's Streamable HTTP endpoint
HOOK_BEARER_TOKEN=...         # already there from step 0
HOOK_PUBLIC_URL=...           # the ngrok URL from step 2, no trailing /access
```

Then, in your working terminal:

```sh
set -a; . ./.env.local; set +a
```

**You should see** nothing. That is success.

**If you do not:** every command in this repo that needs one of these exits
non-zero and prints `missing <VARIABLE>`, naming the first it could not find, in
the order of the table above. Nothing skips, nothing defaults. A variable set to
an empty value counts as missing, so a stray `ARCADE_API_KEY=` is the same as no
line at all.

---

## Step 5 — run the probe

One invocation. Five fresh sessions, run serially, each with a generated user id:

```sh
bun run probe --protocol 2025-11-25
```

**You should see** a header naming the gateway and the hook counter, then one
block per repetition: file path, negotiated revision, and a small table of hook
hits and duration per method. Exit code is `0` only if every repetition
negotiated `2025-11-25`. Five files land in `results/`.

Useful flags, all optional: `--repetitions N` (default 5), `--out <dir>`
(default `results`), `--quiesce-ms MS` (default 2000, how long the hook count
must hold still before a snapshot), `--poll-interval-ms MS`, `--hook-url URL`
(default `http://127.0.0.1:$PORT_WEB`; `HOOK_PUBLIC_URL` is the tunnel *Arcade*
calls and is recorded for provenance only).

**If you do not:** the probe never falls back to a plausible value. A missing
credential, an unreachable gateway, an unreachable counter, and a gateway that
negotiates a different revision are each a distinct non-zero exit that says which
happened. All but the credential cases still write the run JSON, so the
failure is evidence rather than a message that scrolled past.

> ### There is no `--protocol 2026-07-28` step, on purpose
>
> That revision is a different protocol **era**, with no `initialize` at all and
> a `server/discover` probe instead, and it is deferred, not cancelled
> (`DESIGN.md` decisions 15–17). This client cannot request it, so the command
> refuses before sending a byte:
>
> ```console
> $ bun run probe --protocol 2026-07-28
> unsupported protocol revision 2026-07-28; this client can request 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07
> ```
>
> Exit 1, no run file, no hook call. That is deliberate: a file labelled
> `2026-07-28` holding a `2025-11-25` measurement is exactly the failure this
> harness exists to prevent. **This is a limit of our client, not a refusal by
> Arcade**. Step 9 has the wording.

---

## Step 6 — the verification gate: before you trust any count

The counter is keyed entirely on `user_id` from the hook payload
(`DESIGN.md` decision 5). If the gateway does not populate that from the
`Arcade-User-ID` header the probe sends, the hook is called under a different id
or none, `GET /hits?user_id=` finds nothing, and the probe reports a clean zero,
**indistinguishable from "the hook never fired"**. Check this on the first run,
before reading a single number as a finding.

```sh
bun -e '
const dir = Bun.argv[1] ?? "results";
for (const name of new Bun.Glob("*-*.json").scanSync(dir)) {
  const run = await Bun.file(`${dir}/${name}`).json();
  const ids = [...new Set(run.hookHits.map((h) => h?.payload?.user_id))];
  console.log([
    name,
    `  status=${run.status} negotiated=${run.revisionNegotiated} era=${run.protocolEra}`,
    `  userId=${run.userId}`,
    `  hookHits=${run.hookHits.length} from user_id ${ids.join(",") || "(none)"} -> ${ids.length === 1 && ids[0] === run.userId ? "MATCH" : "MISMATCH"}`,
    `  toolsListed=${run.toolsListed} gmailToolsListed=${run.gmailToolsListed} toolsListRequests=${run.toolsListRequests} cursorFollowed=${run.cursorFollowed}`,
  ].join("\n"));
}' results
```

Four things to read, in this order:

1. **`hookHits` is non-empty in at least one run.** That, and only that, proves
   the tunnel and the token worked. If every run is `hookHits=0`, you have not
   measured "the gateway never calls the hook". You have measured nothing. Go
   back to step 2 and re-run the three curls; then check the extension is
   enabled and attached to *this* gateway.
2. **`MATCH`.** The payload's `user_id` equals the run's `userId`. A `MISMATCH`
   with a non-empty id means the gateway is keying on something other than the
   header we send, and every count in the run is attributed to the wrong key.
   Record it and stop; it is a finding in its own right and invalidates the
   counts.
3. **`status=ok` and `negotiated=2025-11-25`.** A different negotiated revision
   is a `version-mismatch` run: it is kept as evidence but is not a measurement
   of the revision you asked for.
4. **`gmailToolsListed`.** Record whatever it is, every run. Zero is the expected
   value and is how you know the hook was consulted at all (decision 6). A
   **non-zero** value must be called out in `NOTES.md` (step 9). Do not read
   it as "the hook never fired": `hookHits` is the evidence for that question,
   and the two can disagree.

Cross-check against the raw log, which the counter appends to before each
response goes out:

```sh
wc -l results/hook-log.jsonl
```

It is cumulative across everything the counter has ever accepted, including
your step 2 tunnel check, so it should be **at least** the total `hookHits`
across the run files. Fewer lines than that means a run file and the log
disagree, which is a bug in the harness rather than a finding about Arcade.

---

## Step 7 — generate the report

```sh
bun run report
```

Reads every `results/*.json` and writes a self-contained `results/report.html`:
no network, no external assets, no headless browser. `--in <dir>` and
`--out <file>` point it elsewhere. With no run files to read it exits non-zero
with `no run files in <dir>` rather than writing an empty report. PDF, if you
want one, is the browser's print dialog.

Open it and read it before committing anything. You are looking for the numbers
to be consistent with what step 6 told you.

---

## Step 8 — curate evidence and check it for secrets

`results/` is gitignored; `evidence/` is committed by hand, and **this repository
is public**. Work on copies, redact, verify, then generate the report *from the
redacted copies* so it cannot carry anything the copies do not.

```sh
DATE=$(date -u +%Y-%m-%d)
mkdir -p "evidence/$DATE"
cp results/*-*.json "evidence/$DATE/"
```

### 8a. Look at a hook hit before you trust the redaction

The counter records **every** request header of every hit, on purpose: nobody
knows yet which headers a real Arcade gateway sends, and that is part of what
this instrument is for. Credential-bearing header values (`authorization`,
`proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`) are replaced *at
capture*, so the secret never reaches disk. Know what that looks like, so a leak
and a redaction are distinguishable at a glance:

```sh
bun -e 'const r = await Bun.file(Bun.argv[1]).json(); console.log(JSON.stringify(r.hookHits[0]?.headers, null, 2))' "evidence/$DATE"/*-1.json
```

**Correctly redacted.** This is what you want to see:

```json
{
  "authorization": "Bearer <redacted len=27 sha256=46450112>",
  "content-type": "application/json",
  "host": "your-tunnel.ngrok.app",
  "x-api-key": "<redacted len=18 sha256=7fd38348>"
}
```

The scheme (`Bearer`) stays in the clear because it is shape, not secret; `len`
is the byte length of what was removed and the digest is the first 8 hex of its
SHA-256, both stable across hits, so you can still tell *the same value arrived
every time* without the value being anywhere.

**A leak looks like the opposite**: a readable token after `Bearer`, or your hook
token appearing verbatim anywhere. If you see that, stop and do not commit;
redaction is not doing its job and that is a bug to file, not something to clean
up by hand.

Note `host` above: it is **not** a credential header, so it is recorded verbatim
and through a tunnel it is your public ngrok hostname. Step 8b handles that.

### 8b. Redact the tunnel URL

`HOOK_PUBLIC_URL` is sensitive in its own right: it is a live route to a service
on your machine. It appears in every run file by design (`hookPublicUrl`, kept
for provenance) and can also show up inside captured headers. **The decision for
this repository: the committed evidence does not keep it.** Provenance is
preserved by the fact that a tunnel was used and by `NOTES.md`, not by the
literal host. A URL that is public and rotated afterwards is worth nothing to a
reader and something to a scanner.

```sh
set -a; . ./.env.local; set +a
host=${HOOK_PUBLIC_URL#https://}; host=${host%%/*}
grep -rlF "$host" "evidence/$DATE" | while read -r f; do
  sed -i '' "s|$host|TUNNEL-REDACTED.invalid|g" "$f"
done
grep -n hookPublicUrl "evidence/$DATE"/*-1.json
```

**You should see** `"hookPublicUrl": "https://TUNNEL-REDACTED.invalid"`.

### 8c. Grep for every secret, and prove the grep works

```sh
: "${ARCADE_API_KEY:?not set; an empty pattern matches everything and the check is meaningless}" \
  "${ARCADE_MCP_URL:?not set}" "${HOOK_BEARER_TOKEN:?not set}" "${HOOK_PUBLIC_URL:?not set}" \
  "${host:?not set; re-run the two lines at the top of 8b in this shell}"

grep -rFn -e "$ARCADE_API_KEY" -e "$ARCADE_MCP_URL" -e "$HOOK_BEARER_TOKEN" -e "$host" "evidence/$DATE"
echo "exit=$?"
```

**You should see** no output and `exit=1`. That is clean.

**No output is only evidence if the command can find something**, so confirm the
grep is actually looking. Search for a string you know is in there and watch it
match:

```sh
grep -rFn -e 'hookPublicUrl' "evidence/$DATE" | head -3
```

If that prints nothing either, your grep is not reading the files (wrong `$DATE`,
empty directory) and the clean result above meant nothing.

### 8d. Render the report from the redacted copies, then commit

```sh
bun run report --in "evidence/$DATE" --out "evidence/$DATE/report.html"
grep -c 'TUNNEL-REDACTED' "evidence/$DATE/report.html"    # > 0 if a run mentioned the tunnel
```

Re-run the grep from 8c over `evidence/$DATE` one last time now that
`report.html` exists. It is generated output and deserves the same check.

Then write `NOTES.md` (step 9) and commit **only** `evidence/$DATE/`. Never
`results/`, never `.env.local`, never `hook-log.jsonl` (it is raw, unredacted for
`hookPublicUrl`, and gitignored for that reason).

---

## Step 9 — write NOTES.md

`evidence/<date>/NOTES.md` is what a reader on the engine team reads first. It
must contain, at minimum:

1. **What was run**: date, gateway toolkits, number of repetitions, the revision
   (`2025-11-25`), and that the hook was fail-closed with a 5 s timeout.
2. **The headline numbers** in a sentence: hook hits per `tools/list` across the
   repetitions, whether it was stable, how large the payloads were and what the
   hook round trip cost. Characterise; do not compare against a number anyone
   expected beforehand (`DESIGN.md` decision 1).
3. **`gmailToolsListed` for every ok run**, and if any value is **non-zero**, say
   so explicitly and prominently. Zero is expected; non-zero is a different bug
   and must not be buried.
4. **The `2026-07-28` note**, worded precisely. It resolves criterion 2's second
   branch, and the distinction is the whole point:

   > `2026-07-28` was not exercised. It is a different protocol era, with no
   > `initialize` and a `server/discover` probe instead, and this client cannot
   > request it, so the question was never put to the gateway. This is a
   > client-side limit, not a refusal by Arcade. `DESIGN.md` open question 11
   > remains open.

   **Do not write "the gateway refused `2026-07-28`".** Nothing in this run
   supports a claim about what Arcade would have done.
5. **Whether the gateway advertises `2026-07-28` at all.** Open question 11 from
   the gateway side, and the cheapest moment to find out is while you are
   authenticated against it. Record only what you actually observed: a revision
   list shown in the Dashboard, or an error from the gateway naming the versions
   it supports. **If nothing showed you, write "not observed"** rather than
   inferring it from our client's behaviour.

   *Optional, and unverified: no one has run this against Arcade.* A raw
   request, bypassing our client, is the only way to ask directly:

   ```sh
   curl -sS -X POST "$ARCADE_MCP_URL" \
     -H "Authorization: Bearer $ARCADE_API_KEY" \
     -H "Arcade-User-ID: runbook-era-check" \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -H 'MCP-Protocol-Version: 2026-07-28' \
     -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}'
   ```

   Whatever comes back, paste it verbatim and label it as a one-off curl, not a
   measurement. It is outside the probe's contract and nothing in the report
   accounts for it.
6. **Anything that surprised you**, including a `MISMATCH` from step 6, a
   retried request, or a `tools/list` that paged (`toolsListRequests > 1`).

---

## Step 10 — shut everything down and rotate the tunnel

```sh
# terminal 2: Ctrl-C ngrok
# terminal 1: Ctrl-C the hook counter
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT_WEB/healthz"   # expect a connection failure
```

Then, in the Dashboard: the extension still points at a tunnel URL that was in
the evidence trail until you redacted it, and the gateway is fail-closed against
a hook that is now down. Either disable the extension or leave the test project
idle. Do not leave a live extension pointing at a dead endpoint on anything
that matters. Start a fresh tunnel next time; treat the old URL as spent.

---

## Troubleshooting

| Symptom | Most likely cause | What to check |
| --- | --- | --- |
| `missing ARCADE_API_KEY` (or any other) | `.env.local` was rewritten by `scripts/orca-setup.sh`, or you never ran `set -a; . ./.env.local; set +a` in this shell | Re-read step 4. Empty values count as missing. |
| Probe runs clean, every `hookHits=0` | The gateway never reached the counter | Re-run step 2's three curls *now*, without restarting ngrok. Then check the extension is enabled and attached to this gateway. |
| `hookHits` non-empty but `MISMATCH` on `user_id` | The gateway is not deriving `user_id` from the `Arcade-User-ID` header | Nothing to fix locally. Record it. The counts in that run are attributed to the wrong key and are not usable. |
| Hits in terminal 1 but `count: 0` from `/hits` | You are polling a different user id, or a second probe is running | Runs must be serial; two probes against one gateway pollute each other's counts. |
| `401` in terminal 1's output | The Dashboard's bearer token and `HOOK_BEARER_TOKEN` differ | A 401 is **not counted**, so this looks like silence in the numbers. Fix the token in the Dashboard. |
| `tools/list` returns Gmail tools | Not necessarily anything | Record `gmailToolsListed` and call it out in `NOTES.md`. It does not mean the hook never fired; `hookHits` answers that. |
| Probe exits non-zero with a negotiated revision that is not `2025-11-25` | The gateway downgraded | The run file is still written with `status: "version-mismatch"`. Keep it; it is evidence. |
| `no run files in results` from `bun run report` | The probe wrote somewhere else, or never wrote | Check `--out`; the probe refuses to overwrite an existing run file rather than replacing evidence. |
| `unsupported protocol revision 2026-07-28` | Working as intended | See step 5. Do not work around it. |
