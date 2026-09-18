---
name: orca-handoff
description: Freeze the current Orca driver session so the human can /clear and resume with /orca-drive in a fresh context. Does a final settlement sweep, pushes every unpropagated finding to GitHub, writes .orca/local/state/HANDOFF.md with intent only, stops dispatching, and prints "safe to clear". Use in the driver's terminal when context is climbing past the useful zone.
disable-model-invocation: true
---

# Handoff — sweep, journal, freeze

The human wants to clear this session and continue with a fresh driver. Your
job is to make that lossless. Order matters: **GitHub first, file second,
freeze last.** The file is a convenience; GitHub is the durable store.

Do not start any new dispatch from this point. Finish in-flight processing of
deliveries you already received, then stop.

## 1. Settlement sweep

Run, and read every result:

```sh
orca orchestration worker-list --json
orca orchestration task-list --json
orca orchestration gate-list --json
orca orchestration check --json          # drain without --wait
```

For every task that has become `completed` since you last looked, process it
now per `.orca/driver.md`: read the PR's latest `**[reviewer]** VERDICT:` or
implementer evidence and take the one action it implies (dispatch review,
dispatch fix, create gate, release). **Exception:** if that action is a new
dispatch, do not start it — record it as the first line of intent below. Merges
and gates you may still do; they are cheap to resume from.

Acknowledge processed messages so the next driver's `check --wait` blocks on
live workers instead of replaying this batch.

## 2. Propagate

Any finding you hold that is not yet on a GitHub issue: post it now as a
`**[driver]**` comment on the issue it belongs to. Any `DESIGN.md` grooming you
were about to commit: commit it now in its own commit, or drop it. Nothing in
your head survives the clear unless it is in git or on GitHub.

## 3. Write HANDOFF.md

Write `.orca/local/state/HANDOFF.md`. **Intent only** — no state that the next
driver can re-derive. The next driver will re-derive it anyway and a stale
mirror is worse than none. Template:

```markdown
# Driver handoff — <ISO timestamp>

## Was about to
- <the next dispatch or action you did not start, with issue and reason>

## Open escalations
- #<issue>: <gate topic>, brief at .orca/local/human/<file>, waiting since <when>

## Findings not yet acted on
- <anything posted to GitHub in step 2 that still needs a follow-up dispatch>

## Live at freeze
- dispatch <id>: <role> #<issue> round <n>, terminal <handle>
  (re-derive before trusting; listed only so nothing is orphaned)

## Judgment calls the next driver should not relitigate
- <decisions already made and why, one line each>
```

Also refresh `DRIVER-STATE.md` to say only: `See HANDOFF.md`.

## 4. Freeze and report

Update each live worktree comment:
`orca worktree set --worktree <sel> --comment "driver handoff <timestamp>; resuming via /orca-drive" --json`.

Then print exactly this block and stop:

```
HANDOFF COMPLETE — safe to /clear
  live dispatches : <n>   (they keep running; the next driver adopts them)
  open gates      : <n>
  briefs waiting  : <n> in .orca/local/human/
  next            : /clear, then /orca-drive in this same terminal
```

Do not take any further action after printing it.
