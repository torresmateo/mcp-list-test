# Setting this folder up in Orca

**Shortcut:** open a Claude terminal in this folder and run `/orca-setup`. It
executes every step below that can be run from a terminal, fills
`.orca/local/env.md` from real output, and stops only at the UI-only hook step
and at facts only you know. The manual steps remain here as the reference.

Do these in order the first time you open this folder in Orca. Steps 1–4 are
one-time per machine; steps 5–9 are one-time per project; step 10 is every
driver session. Each step ends with a check so you know it took.

## 0. Prerequisites

- Orca desktop app installed, and the `orca` CLI on your PATH
  (`which orca` prints a path).
- `gh` installed and logged in: `gh auth status` shows the account the agents
  will commit as.
- This folder is a git repo with a GitHub remote and at least one commit:

  ```sh
  git init -b main            # if not already a repo
  git add -A && git commit -m "Orca orchestration scaffold"
  gh repo create <owner>/<repo> --private --source . --push
  ```

- The toolchain your project needs (bun, uv, node, docker…) installed on this
  machine. Worker worktrees inherit the host's PATH.

## 1. Start Orca and confirm the runtime

```sh
orca open
orca status --json
```

Check: `status` reports the app and runtime as reachable. If not, nothing else
below will work.

## 2. Register the agents Orca will launch

```sh
orca account list --json
```

You need a managed account for every agent named in `env.md` (step 6). To add
one:

```sh
orca account add --agent claude
orca account add --agent codex
```

Check: `orca account list` shows each agent you intend to use. An agent with no
managed account falls back to the host's own CLI login; that works, but it is
the first thing to check when a dispatch fails to launch.

## 3. Register this repo

In the Orca app: **Add project** and pick this folder. Or from the terminal:

```sh
orca repo add --path "$(pwd)" --json
orca repo list --json
```

Check: `repo list` shows this path with an `id`. Copy that UUID; it goes in
`env.md`. Note: if you ever remove and re-add the repo in the UI, the UUID
changes and every place it is written must be updated.

## 4. Wire the hooks

In the Orca app, open this repo's **settings → hooks**:

| Field           | Value                          |
| --------------- | ------------------------------ |
| Setup script    | `bash scripts/orca-setup.sh`   |
| Archive script  | `bash scripts/orca-archive.sh` |
| Setup policy    | **wait-for-setup**             |

`wait-for-setup` matters. With `start-immediately` the agent starts while
dependencies are still installing, sees module-resolution errors, and starts
"fixing" a repo that is not broken.

Check: run the setup hook once by hand in this main worktree and read the
`.env.local` it writes.

```sh
bash scripts/orca-setup.sh
cat .env.local
```

Expected: a `PORT_BASE`, `PORT_WEB`, `PORT_DB` and `COMPOSE_PROJECT_NAME`, and
either a successful dependency install or the line
`no recognised lockfile; skipping install`. If your project needs derived
values (a `DATABASE_URL` built from `PORT_DB`, say), add them in the block
marked `PROJECT-SPECIFIC` in `scripts/orca-setup.sh` now, then re-run. The
script is idempotent and keeps the same block.

## 5. Create the local directories

```sh
mkdir -p .orca/local/human .orca/local/state
cp .orca/env.example.md .orca/local/env.md
cp .orca/workers.example.json .orca/local/workers.json
```

Check: `git status` does **not** list anything under `.orca/local/`. If it
does, `.gitignore` did not take.

## 6. Create a Run and fill `env.md`

A Run is the namespace the driver and every worker share. Create it from a
terminal **inside this folder**:

```sh
orca orchestration run-create --objective "<one line: what this Run should finish>" --json
```

Copy the `run_…` id from the output. Then edit `.orca/local/env.md` and fill:

- **GitHub** `<owner>/<repo>`
- **Orca repo selector** the UUID from step 3
- **Orca Run** the id you just got
- **Worker models** are not in `env.md`. Copy `.orca/workers.example.json` to
  `.orca/local/workers.json` and set `roles.implementer` and `roles.reviewer`
  to presets; `/orca-workers` shows and switches them. Use different vendors
  if you can. Effort is one of `low | medium | high | max`.
- **Main worktree** the absolute path of this folder
- **Shared account** `yes` if all agents commit through one GitHub login

Check:

```sh
orca orchestration run-use --id run_<id> --json
orca orchestration run-current --json
```

`run-current` should echo the same id.

## 7. Describe the project to the workers

Open `.orca/project.md` and replace every `<...>`. This is the only place the
role prompts get project knowledge from, so be concrete: exact install and test
commands, which tools read `.env.local`, which test suites skip silently, which
files are generated, and what the project's characteristic silent failure looks
like.

Check: `grep -n '<' .orca/project.md` returns nothing but code fences and
markdown.

## 8. Write the design record and the issues

- **`DESIGN.md`** at the repo root. Architecture, contracts, and the reasoning
  behind each decision. Workers treat it as law and never edit it. The driver
  refuses to dispatch without one.
- **GitHub issues**, one per slice. `/orca-slice` files them in the right
  shape; the template is `.github/ISSUE_TEMPLATE/slice.md`. Each body needs:
  - a numbered list of **acceptance criteria** the reviewer can run;
  - a line `Blocked by #<n>, #<m>` (or `Blocked by: none`) — the driver builds
    the DAG from these lines and nothing else.
- Optionally a **PRD** file if the work is large enough to need one; reference
  it from `DESIGN.md`.

Check: `gh issue list --state open --json number,title,body` shows every slice
with a "Blocked by" line.

## 9. Commit the scaffold

First confirm the skills are visible to both agents: `.claude/skills` must be a
symlink to `../.agents/skills` and `ls .claude/skills/` must list the eight
`orca-*` skills. Codex reads repo-level `.agents/skills/` directly.

```sh
git add .gitignore .orca .agents .claude/skills .github scripts DESIGN.md
git status                     # nothing under .orca/local/, no .env.local
git commit -m "Add Orca orchestration scaffold"
git push
```

## 10. Start a driver session

In Orca, open a **Claude** terminal in this main worktree (not a child
worktree). Run `/orca-drive`, or paste the entire contents of `.orca/driver.md` as the
first message.

The driver will run `orca status`, bind the Run from `env.md`, rebuild the DAG
from the open issues, and dispatch up to four ready slices. It writes gate
briefs to `.orca/local/human/` and its journal to `.orca/local/state/`.

Check: the first thing a healthy driver does is report the DAG it derived and
which issues it is about to dispatch. If it instead asks for the repo id, Run id,
or `DESIGN.md`, go back to the step that produces that.

## Every later session

- If the previous driver session was compacted or wiped, start a new Claude
  terminal and run `/orca-drive` again. Better: run `/orca-handoff` in the
  old session first, so its intent is written down before you clear. It will re-derive state from `orca` and
  `gh`; the only thing it trusts from disk is `env.md`.
- If Orca reports the Run no longer exists, repeat step 6 and update `env.md`.
- If a provider runs out of quota mid-run, `/orca-workers <role> <preset>`
  and carry on. The driver reads the file before every dispatch.
- If a worker reports a port collision, the setup hook did not run for its
  worktree: check the hook wiring in step 4 and the setup policy.
- Stale port claims live in `~/.cache/orca-portblocks/`. Each file is named by
  its base port and contains the worktree path that owns it. Delete any whose
  path no longer exists.

## What is committed, what is not

| Path                    | Committed | Why                                        |
| ----------------------- | --------- | ------------------------------------------ |
| `.orca/*.md`            | yes       | roles and rules; public-safe               |
| `.orca/project.md`      | yes       | the project's own facts; workers read it   |
| `scripts/orca-*.sh`     | yes       | hooks every worktree runs                  |
| `DESIGN.md`             | yes       | the contract workers build against         |
| `.agents/skills/`, `.claude/skills` | yes | slash-command wrappers around the prompts |
| `.orca/local/`          | **no**    | repo UUID, Run id, gate briefs, journal    |
| `.env.local`            | **no**    | per-worktree ports, written by the hook    |
