# Design record

Workers treat this file as law and never edit it. The driver refuses to dispatch
without it. Fill each section before the first slice is filed.

## Purpose

One paragraph: the question this repo answers (how many times the Arcade access
hook fires per `tools/list`, per MCP protocol revision) and what a conclusive
result looks like.

## Architecture

The moving parts and how they connect: bun MCP client, local hook-counter
server, tunnel to the Arcade gateway, the Arcade project and extension config
the operator owns. One diagram or a short list.

## Contracts

Interfaces other slices inherit: the probe CLI flags and output table format,
the hook-counter HTTP API and its in-memory record shape, the per-revision
client interface, the env var names read from `.env.local`.

## Decisions

Numbered. Each with the reasoning, so a worker can tell when a decision no
longer applies.

1. `<decision>` — `<why>`

## Non-goals

What this repo deliberately does not do: no pre/post-execution hooks, no
`tools/call` measurement, no fix to the gateway, no long-lived deployment.

## Open questions

Things the operator has not decided yet that a slice may block on.
