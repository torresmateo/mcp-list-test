---
name: orca-gate
description: The human's side of an Orca decision gate. Lists pending gates, shows each brief from .orca/local/human/, asks for the decision with a recommendation, then resolves it in Orca and on GitHub. Use when the driver says it has gated something, when a needs-human label appears, or to check whether anything is waiting on you.
disable-model-invocation: true
---

# Gate

You are acting **for the human**, not as the driver. Sign GitHub comments
`**[human]**`. You never dispatch workers.

## 1. Find what is waiting

```sh
orca orchestration gate-list --json
gh issue list --label needs-human --state open --json number,title,url
ls -t .orca/local/human/
```

A gate has three parts and they can drift: the Orca gate, the `needs-human`
label plus `**[driver]**` comment on the issue, and the brief file. Match them
up by issue number. Report anything with only one or two parts: it means the
driver was interrupted, and the next `/orca-drive` should be told.

If nothing is pending, say so and stop.

## 2. Present each gate, one at a time

For each pending gate:

1. Print the brief (`.orca/local/human/<issue>-<topic>.md`) in full.
2. Print the driver's latest `**[driver]**` comment on the issue.
3. If the gate is about a PR, show `gh pr diff <pr> --stat` and the latest
   `**[reviewer]** VERDICT:` comment.
4. Give **your recommendation in one paragraph**, grounded in `DESIGN.md` and
   `.orca/project.md`, and name what would change your mind.
5. Ask the human for the decision. Options are usually `approve`, `reject`,
   or `approve with conditions`; let them type anything.

Do not batch decisions. One gate, one answer.

## 3. Resolve, both places

```sh
orca orchestration gate-resolve --id <gate_id> --resolution "<verbatim decision>" --json
gh issue comment <n> --body "**[human]** Gate resolved: <decision>. <conditions or reasoning, one or two lines>"
gh issue edit <n> --remove-label needs-human
```

If the decision changes `DESIGN.md` (a new architectural decision), say so
explicitly in the comment and note that the **driver** records it, not you.
Do not edit `DESIGN.md` here.

Move the brief to `.orca/local/human/resolved/` so the directory shows only
what is still open.

## 4. Report

One line per gate: issue, decision, where it is recorded. Then remind the
human that the driver picks it up on its next `check --wait` cycle, and that
if the driver session is idle they may need to nudge it with one message.
