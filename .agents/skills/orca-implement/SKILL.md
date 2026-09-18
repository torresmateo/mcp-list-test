---
name: orca-implement
description: Run the Orca implementer role by hand for one issue in the current worktree, following .orca/implementer.md verbatim. Use when you want to build a slice yourself in a Claude terminal instead of through the driver, or to rehearse the role. Args - issue number, then optionally the branch (defaults to the current branch).
disable-model-invocation: true
---

# Implement, by hand

`.orca/implementer.md` is the role. This skill fills its placeholders from
your surroundings and then hands you over to it. Nothing in the role is
restated here on purpose: one source of truth.

## Fill the placeholders

- `{{N}}` — the first argument. If none was given, ask.
- `{{BRANCH}}` — the second argument, else `git branch --show-current`. If
  that is the default branch, stop: implementers never work on it. Suggest
  `orca worktree create` or a new branch.
- `{{REPO}}` — `gh repo view --json nameWithOwner -q .nameWithOwner`.
- `{{EXTRA}}` — anything the human added after the arguments; else empty.

## Preflight

- `test -f .env.local` — if missing, run `bash scripts/orca-setup.sh` so you
  own a port block like every other worker.
- `grep -c '<' .orca/project.md` should be 0. If not, you are about to work in
  an undescribed project; tell the human.

## Then

Print the filled-in prompt once, so the human can see exactly what you are
acting on. Then **follow it exactly**, including its "Finish" section. The one
difference from a dispatched worker: there is no live Orca dispatch, so instead
of `worker_done` you end by telling the human the PR number and that the driver
will need to dispatch a reviewer for it, or that they can run `/orca-review` in
a fresh worktree themselves.
