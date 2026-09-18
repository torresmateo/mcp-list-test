---
name: orca-review
description: Run the Orca reviewer role by hand for one PR in the current worktree, following .orca/reviewer.md verbatim. Use in a FRESH worktree checked out at the PR branch, to verify a slice yourself or to rehearse the role. Args - PR number, then optionally the round (defaults to the count of existing VERDICT comments plus one).
disable-model-invocation: true
---

# Review, by hand

`.orca/reviewer.md` is the role. This skill fills its placeholders and hands you
over to it. Nothing in the role is restated here: one source of truth.

## Fill the placeholders

- `{{PR}}` — the first argument. If none, ask.
- `{{N}}` — the issue: parse `Closes #<n>` from `gh pr view <pr> --json body`.
- `{{REPO}}` — `gh repo view --json nameWithOwner -q .nameWithOwner`.
- `{{ROUND}}` — the second argument, else one more than the number of
  `**[reviewer]** VERDICT:` comments already on the PR.
- `{{DELTA}}` — if round > 1, the text of the previous round's verdict comment
  under a heading `## Previous round`, so you check the findings were
  addressed; else empty.

## Preflight — the fresh-worktree rule

The reviewer's value is that nothing from the implementer reaches it. Check:

- `git status --porcelain` is empty and `git branch --show-current` is the PR
  branch. If either fails, stop and tell the human to review from a clean
  worktree (`orca worktree create --base-branch <pr branch>`).
- `test -f .env.local`; if missing, `bash scripts/orca-setup.sh`.
- `grep -c '<' .orca/project.md` should be 0.

## Then

Print the filled-in prompt once, then **follow it exactly**, including the
single VERDICT comment. Instead of `worker_done`, end by telling the human the
verdict and that the driver reads it from the PR comment on its next cycle.
