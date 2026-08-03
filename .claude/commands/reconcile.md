---
description: Write implementation reality back into the design docs
---

Compare the working tree against `design/10-design.md` and `design/20-contract.md`.

This is the step that stops the docs becoming fiction. A stale design doc is worse than none, because every future agent session gets confidently briefed on a system that does not exist.

Produce a drift report first, before editing anything:

## Contract drift
Signatures, types, schemas or error variants where the code and `20-contract.md` disagree. For each: which is currently correct, and what the other should become.

## Design drift
Places where the implemented structure differs from `10-design.md` — module boundaries crossed, control flow changed, a failure mode handled differently or not at all.

## Undocumented decisions
Choices made during implementation that are not in `90-decisions.md`. These are the ones that silently become load-bearing.

## Invalidated assumptions
Anything the design assumed that implementation showed to be false.

## Lessons
Things that cost time and would cost it again. Each one must name what it actually cost — a lesson with no cost attached is a preference, and preferences go in `AGENTS.md`, not `agent.md`. Propose these for `agent.md`; do not append them yourself. If nothing here would have changed a decision, say "none" rather than padding.

Then wait. I decide which direction each drift resolves — the code changing to match the doc, or the doc changing to match the code. Do not assume the code is right just because it runs.

Once I have decided, apply the edits and append the decision-log entries. Nothing else.
