---
name: orca-slice
description: Turn a description, PRD section, or DESIGN.md decision into one or more GitHub issues in the exact shape the Orca driver parses — numbered runnable acceptance criteria and a "Blocked by" line — cross-checked against DESIGN.md. Use to add work to the DAG, to split a slice after a third request_changes, or to convert a plan into slices.
disable-model-invocation: true
---

# Slice

The driver rebuilds its DAG from open issues, and it reads exactly two things:
the `Blocked by` line and the acceptance criteria. An issue without them is
invisible to the driver or gets dispatched with nothing to verify. Your job is
to make every slice born correct.

## 1. Understand before drafting

- Read `DESIGN.md` and `.orca/project.md`. A slice that contradicts a numbered
  decision in `DESIGN.md` is wrong before it starts; say so instead of filing.
- `gh issue list --state open --json number,title,body` — know the current DAG
  so blockers reference real numbers and you do not duplicate an open slice.
- Read the input the human gave you. If it describes more than one deliverable
  a single implementer could finish in 30-120 minutes, split it.

## 2. Shape each slice

Rules the driver and the reviewer depend on:

- **Vertical and thin.** One slice = one implementer = one PR that could merge
  alone. Prefer a tracer bullet that touches every layer over a layer-complete
  horizontal.
- **Acceptance criteria are commands, not adjectives.** Each one must be
  something a reviewer in a fresh worktree can run and get a yes or no. "Works
  correctly" is not a criterion. "`<test command>` runs `<suite>` and it
  reports N passed, 0 skipped" is.
- **Name the silent failure.** If `.orca/project.md` lists a characteristic
  failure this slice could trigger, add a criterion that proves it did not
  happen (an excerpt, a count that ran, a denied request).
- **Blocked by is exhaustive.** Every issue whose merged output this slice
  needs. `Blocked by: none` when it can start now. Never leave the line out.
- **Gate hints.** If the slice touches anything in the driver's stop-and-gate
  list (architecture, first-run experience, access model, spend, key fields,
  project non-negotiables), add a `Gate: <why>` line so the driver knows to
  gate before merge.

Use the template in `.github/ISSUE_TEMPLATE/slice.md`. Keep the body under
about 40 lines; the comments will grow it later.

## 3. Show, then file

Print every drafted issue in full and the resulting DAG edges (`#new ← #a, #b`).
Wait for the human's go-ahead, then:

```sh
gh issue create --title "<title>" --body-file <tmp> --label slice
```

Filing is outward-facing; never file without confirmation.

## 4. Report

List the new issue numbers with their blockers, and say whether any is ready
now. If the driver is running, note that it will pick them up on its next wave
without being told.
