---
name: orca-drive
description: Become the Orca driver for this repo. Runs preflight (env.md, project.md, DESIGN.md, Run binding), adopts a HANDOFF.md left by a previous driver session, then follows .orca/driver.md verbatim. Use in a Claude terminal in the MAIN worktree to start or resume driving; the resume path after /orca-handoff and /clear.
disable-model-invocation: true
---

# Drive

You are about to become the **driver** described in `.orca/driver.md`. That
file is the protocol and you will follow it word for word. This skill only adds
a preflight, a resume path, and the bundled CLI reference.

## 1. Load references

- `cat .orca/driver.md` — read all of it, every session, even if you think you
  remember it.
- `orca skills get orchestration` — the raw verbs, liveness and settlement
  rules. `driver.md` wins where they seem to disagree on *policy*; the bundled
  skill wins on *command syntax*.

## 2. Preflight — refuse to dispatch if any fails

| Check | Command | On failure |
| --- | --- | --- |
| In main worktree | `orca worktree current --json` shows the repo root, not a child | stop; tell the human where you are |
| env.md exists and has no `<...>` | `grep -c '<' .orca/local/env.md` is 0 | tell the human to run `/orca-setup` |
| project.md filled | `grep -c '<' .orca/project.md` is 0 (code fences aside) | gate: workers cannot be sent into an undescribed project |
| workers.json valid | `jq -e .roles.implementer,.roles.reviewer .orca/local/workers.json` and both name existing presets | tell the human to run `/orca-workers` |
| DESIGN.md exists | `test -f DESIGN.md` | gate: human writes the first version |
| Run bound | `orca orchestration run-current --json` matches env.md | `run-use --id <from env.md>`; if the Run is gone, tell the human to run `/orca-setup` step 6 |
| Hooks wired | `orca repo show --repo id:<uuid> --json` lists setup + archive scripts | tell the human: SETUP.md step 4 |

## 3. Adopt a handoff, if one exists

If `.orca/local/state/HANDOFF.md` exists, a previous driver froze cleanly:

1. Read it. It contains **intent only**: what was about to happen, open
   escalations, findings not yet propagated to GitHub, and the list of
   dispatch ids that were live at freeze time.
2. Re-derive every fact it mentions from `orca` and `gh` before acting on it:
   `worker-list`, `task-list`, `gate-list`, and the `**[reviewer]** VERDICT:`
   count on each open PR. Where the file and reality disagree, reality wins.
3. Reconcile every dispatch it lists: settled ones get processed per
   `driver.md`; live ones are monitored.
4. Propagate any unpropagated finding to its GitHub issue **now**.
5. Rename the file to `HANDOFF-<timestamp>-adopted.md` so a later resume does
   not adopt it twice.

If there is no `HANDOFF.md` but `DRIVER-STATE.md` exists, treat it the same way
but with less trust: it may be mid-wave.

## 4. Drive

Follow `.orca/driver.md` from its "Start here" section. Everything about
limits, settlement monitoring, escalation, per-issue protocol, hard rules and
the journal is defined there, not here.

Two additions for the human's benefit:

- At every wave boundary print a **five-line status**: ready issues, active
  dispatches with round numbers, open gates, briefs waiting in
  `.orca/local/human/`, and the next thing you intend to do.
- If the human runs `/orca-handoff` in this terminal, stop dispatching and
  follow that skill. Do not resist it.
