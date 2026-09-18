---
name: orca-workers
description: View or switch which harness and model each Orca role (implementer, reviewer) uses, via presets in .orca/local/workers.json. Use between driver waves when one provider runs out of quota or misbehaves, to add a preset for a new harness (cursor later), or to check that the chosen agents have managed accounts. Args - none to show; "<role> <preset>" to switch; "add <preset> <agent> <model> <effort>" to define one.
disable-model-invocation: true
---

# Workers

`.orca/local/workers.json` decides which harness and model each role runs on.
The driver reads it **before every dispatch**, so a change here takes effect on
the next worker it starts, with no driver restart. This skill is a safe editor
for that file.

## No arguments — show

1. If the file is missing, copy `.orca/workers.example.json` to it and say so.
2. Parse it. Print two tables:
   - **Roles**: role, preset, agent, model, effort.
   - **Presets**: every preset, marked `active` if a role uses it.
3. `orca account list --json`. Mark each preset's agent as `managed account`,
   `host CLI login` (no managed account; works if the CLI is logged in), or
   `unknown agent`. A role pointing at an agent with neither is the most likely
   cause of "dispatch failed to launch"; say so plainly.
4. Warn if implementer and reviewer share the same agent **and** model: the
   reviewer then shares the implementer's blind spots.

## `<role> <preset>` — switch

- Validate: role is `implementer` or `reviewer`; preset exists. Refuse
  otherwise and print the preset list.
- Write the change with a JSON-preserving edit (keep key order and comments).
- Print before → after for that role.
- Then say exactly when it takes effect, because this is the part people get
  wrong:
  - **Reviewer**: next review round, on every slice. Reviewers are fresh
    worktrees each round, so the switch is immediate.
  - **Implementer**: next *new slice* only. Fix rounds reuse the existing
    implementer terminal, which keeps the old agent. If the human wants the
    switch for an in-flight slice, they must tell the driver to release that
    terminal and re-dispatch, and that costs the worker's context.
- If the driver is running, remind the human it needs no restart.

## `add <preset> <agent> <model> <effort>` — define

- `effort` must be one of `low | medium | high | max`.
- `agent` is free-form (claude, codex, cursor, …) but if `orca account list`
  has never heard of it, say so as a warning, not an error: a new harness is
  exactly why this command exists.
- Do not switch a role to it; that is a separate, deliberate command.

## Never

- Never edit `.orca/env.example.md` or `.orca/workers.example.json`; those are
  the committed templates.
- Never start, stop, or release a worker. Report; the driver acts.
