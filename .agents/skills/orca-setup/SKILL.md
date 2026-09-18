---
name: orca-setup
description: Guided first-time setup of this repo for Orca orchestration. Walks .orca/SETUP.md step by step, runs every command it can, fills .orca/local/env.md from real output, and stops only for UI-only steps and facts only the human knows. Use when opening this folder in Orca for the first time, when /orca-drive reports setup is incomplete, or when the Orca repo id or Run has changed.
disable-model-invocation: true
---

# Orca setup, guided

You are setting this repo up for the driver / implementer / reviewer protocol in
`.orca/`. `.orca/SETUP.md` is the authoritative checklist; this skill executes
it. Read `SETUP.md` first, then work through the steps below. **Detect before
you do**: every step starts with a check, and a step whose check already passes
is reported as done and skipped. Re-running this skill must be safe.

Load the bundled Orca skill for CLI details when needed: `orca skills get orca-cli`.

## Rules

- Run commands yourself. Do not tell the human to run something you can run.
- Stop and ask only for: UI-only steps (hook wiring in the Orca app), and facts
  only the human knows (GitHub owner/repo if no remote, Run objective, worker
  agents/models, whether the GitHub account is shared).
- Never write a credential anywhere. Never edit `.orca/*.md` except
  `project.md` placeholders when the human gives you the content.
- Report each step as `done`, `skipped (already done)`, or `needs you: <what>`.

## Steps

**0. Prerequisites.** Check `which orca`, `gh auth status`, `git rev-parse
--is-inside-work-tree`, `git remote get-url origin`. If not a repo, `git init -b
main`. If no remote, ask for `<owner>/<repo>` and offer to run
`gh repo create ... --private --source . --push`. Do not create the remote
without confirmation: it is outward-facing.

**1. Runtime.** `orca status --json`. If unreachable, `orca open`, wait, retry.

**2. Accounts.** `orca account list --json`. Record which agents have a managed
account. Do not run `account add` yourself; it is an interactive login. Tell the
human the exact command if one is missing for an agent they intend to use.

**3. Repo.** `orca repo list --json`; match on this folder's path. If absent,
`orca repo add --path "$(pwd)" --json`. Capture the id.

**4. Hooks.** UI-only. Show the human the three values from `SETUP.md` step 4
and wait for confirmation. Then run `bash scripts/orca-setup.sh` here and show
the resulting `.env.local`. If the project needs derived values (a database
URL from `PORT_DB`, say), ask and add them in the `PROJECT-SPECIFIC` block of
the script, then re-run.

**5. Local dirs.** `mkdir -p .orca/local/human .orca/local/state`; copy
`env.example.md` to `local/env.md` and `workers.example.json` to
`local/workers.json` if absent. Confirm `git status --porcelain
.orca/local` is empty.

**6. Run and env.md.** `orca orchestration run-current --json`. If unbound or
the Run in `env.md` no longer exists (`run-show` fails), ask for the objective
and `run-create --objective "..." --json`. Fill every field in
`.orca/local/env.md` from the captured values; ask for shared-account only.
Then open `local/workers.json`, show the presets, ask which preset each role
uses (cross-check `orca account list`), and write `roles`. Verify with `run-use` then `run-current`.

**7. project.md.** `grep -n '<' .orca/project.md`. For each remaining
placeholder section, look at the repo first (lockfiles, compose files, test
config, README) and propose content; ask only what the code cannot tell you,
especially "What this project fails at". Write the answers in.

**8. Design record and issues.** If `DESIGN.md` is missing, write a skeleton
with these headings and one line under each saying what belongs there:
`Purpose`, `Architecture`, `Contracts` (interfaces other slices inherit),
`Decisions` (numbered, each with reasoning), `Non-goals`, `Open questions`.
Then tell the human to fill it and to create slices with `/orca-slice`. Check
`gh issue list --state open --json number,body`; report how many issues carry a
`Blocked by` line.

**9. Skills visible to workers.** Confirm `.claude/skills` is a symlink to
`../.agents/skills` and lists the eight `orca-*` skills. If Codex is one of
the worker agents, note that Codex reads repo-level `.agents/skills/`; suggest
the human confirm once from a Codex terminal in a worktree.

**10. Commit.** `git add .gitignore .orca .agents .claude/skills scripts
DESIGN.md .github`; show `git status`; confirm nothing under `.orca/local/` or
`.env.local` is staged. Commit with a message like `Add Orca orchestration
scaffold`. Ask before pushing.

## Finish

Print a table of the ten steps and their status, then the one line the human
does next: open a Claude terminal in this main worktree and run `/orca-drive`.
