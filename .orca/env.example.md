# Orca bindings — template

Copy to `.orca/local/env.md` and fill in. That path is gitignored.

These are the facts a driver cannot re-derive from `orca` or `gh`, which is why
they live in a file rather than in a driver's memory. Everything else — the DAG,
round counts, which worker is alive — **must** be re-derived every wave.

---

## Repo

- GitHub: `<owner>/<repo>`
- Orca repo selector: `--repo id:<uuid>`
  Get it from `orca repo list --json`. Always pass it with `--worktree new-top-level`.
  If the repo is ever removed and re-added in the Orca UI it gets a new id;
  update this line and note the date.

## Run

- Orca Run: `run_<id>`
- Bind with: `orca orchestration run-use --id run_<id> --json`
- Objective: `<one line: what this Run is trying to finish>`
- If the Run is gone, create a new one and **update this file** — a stale Run id
  is the one error here that looks like a broken Orca rather than a stale note.

## Worker models

Not here. They live in `.orca/local/workers.json` (copy of
`.orca/workers.example.json`) so they can be switched between waves without
touching this file. View or change with `/orca-workers`. The driver re-reads
that file before every dispatch.

## Local paths

- Main worktree: `<absolute path>`

## Account note

If every agent commits through the same GitHub account, GitHub refuses a formal
approval from the PR author. Verdicts are then PR **comments** headed
`**[reviewer]** VERDICT: approve|request_changes`, and no green check will ever
appear. Record here which applies:

- Shared account: `yes | no`
