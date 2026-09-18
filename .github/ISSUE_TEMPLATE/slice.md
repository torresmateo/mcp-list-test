---
name: Slice
about: One unit of work for the Orca driver to dispatch
title: ""
labels: slice
---

## Goal

<One paragraph: what exists after this merges that did not before, and who
notices.>

## Acceptance criteria

Each one is something a reviewer can run in a fresh worktree and answer yes or no.

1. `<command>` → <expected output, with numbers where they matter>
2. ...
3. <If .orca/project.md names a silent failure this slice could cause, the
   criterion that proves it did not: an excerpt, a count that ran, a denied
   request.>

## Blocked by

Blocked by: none
<!-- or: Blocked by #12, #14 — every issue whose merged output this needs -->

## Gate

<!-- delete if not applicable -->
Gate: <why the driver should gate before merge: architecture / first-run
experience / access model / spend / key field / project non-negotiable>

## Notes for the implementer

<Pointers into DESIGN.md decisions and the files to start from. Keep short;
decisions made later go in comments, and the implementer is told to read them.>
