# Orca orchestration for this repo

Agent orchestration lives here: a **driver** walks an issue DAG and dispatches
**implementers** and **reviewers** into isolated worktrees. The prompts are the
contract between those roles. They are project-agnostic; everything specific to
this codebase goes in `project.md`.

```
.orca/
  README.md          ← you are here
  SETUP.md           step-by-step: wiring this folder up in Orca
  driver.md          role, limits, protocol, escalation policy
  implementer.md     worker prompt: build one slice
  reviewer.md        worker prompt: verify one PR, fresh worktree
  project.md         what THIS project is and how it fails — fill in before use
  env.example.md     template for the machine-specific bindings
  workers.example.json  template for per-role harness/model presets
  ../.agents/skills/ slash-command wrappers (see "Skills" below)
  local/             GITIGNORED — never committed
    env.md             filled-in copy of env.example.md
    workers.json       which harness/model each role runs; edit between waves
    human/             for the operator: gate briefs, decisions, sittings
    state/             for the next driver: DAG.md, DRIVER-STATE.md, HANDOFF.md
```

## The split, and why it is where it is

Everything in `.orca/` except `local/` is committed and public-safe: it
describes roles and rules, not this machine and not one person's run.

`local/` holds the three things that must not be:

- **`env.md`** — the Orca repo id, the Run id, absolute worktree paths. Not
  secret, but meaningless to anyone who forks this, and it changes whenever the
  Run is recreated.
- **`human/`** — what the driver writes *for you*: a gate brief, a decision to
  make, the commands to verify a merged slice. Named `<issue>-<topic>.md`.
  These accumulate fast and are throwaway.
- **`state/`** — what a driver writes for *the next driver* after a compaction
  or a wipe: `DAG.md`, `DRIVER-STATE.md`, `STATUS.md`, `HANDOFF.md`.

**`env.md` sits at the root of `local/`, not inside `state/`, on purpose.** The
driver prompt says state is never authoritative — re-derive the DAG and round
counts from `orca` and `gh` every wave. The repo id and Run id are the one
exception: they are authoritative and cannot be re-derived. Filing them under
`state/` would put them under a rule that would make a driver throw them away.

## Where the project-specific knowledge goes

The three role prompts never name a framework, a test runner, or a port. They
tell workers to read `.orca/project.md`, which is where you record:

- what the project is, in one paragraph;
- how to install, run, and test it in a fresh worktree;
- the environment facts that bite (which files load which env, which suites
  skip silently, which generated files must not be hand-edited);
- the project's characteristic failure modes — the bugs a reviewer should push
  on hardest.

Keep `project.md` current. It is the one file where a stale line costs a whole
review round.

## Setup

See `SETUP.md`. The short version: register the repo in Orca, wire the two hook
scripts, create a Run, fill `local/env.md` and `project.md`, then paste
`driver.md` into a Claude terminal in the main worktree.

## Skills

The prompts above are the source of truth. The skills under `.agents/skills/`
(symlinked from `.claude/skills/` so Claude and Codex both see them) wrap those
prompts as slash commands; none of them restates a rule.

| Skill             | Run it in                         | What it does                                                    |
| ----------------- | --------------------------------- | --------------------------------------------------------------- |
| `/orca-setup`     | any terminal, main worktree       | executes `SETUP.md`, fills `local/env.md`, stops at UI steps    |
| `/orca-drive`     | Claude terminal, main worktree    | preflight, adopt `HANDOFF.md`, then follow `driver.md`          |
| `/orca-handoff`   | the driver's terminal             | sweep, push findings to GitHub, write `HANDOFF.md`, freeze      |
| `/orca-workers`   | your terminal                     | show or switch harness/model per role; driver picks it up next dispatch |
| `/orca-gate`      | your terminal                     | show pending gate briefs, take your decision, resolve both ways |
| `/orca-slice`     | your terminal                     | file issues in the shape the driver parses                      |
| `/orca-implement` | a worker worktree                 | run `implementer.md` by hand for one issue                      |
| `/orca-review`    | a fresh worktree on the PR branch | run `reviewer.md` by hand for one PR                            |

The context-window loop: when the driver's context climbs, run `/orca-handoff`
in its terminal, wait for `safe to /clear`, clear, run `/orca-drive`. Nothing
is lost because findings go to GitHub before the file is written.
