---
description: Produce or revise the design doc from the brief
---

<!-- companion:start -->
**Per-repo companion:** `.claude/commands/design-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`, `extra-steps`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:end -->

## Stop if `design/` is frozen

If `design/FROZEN.md` exists, **stop before doing anything else.** Report its `Frozen because` and `Lifts when` lines verbatim and write nothing. The rule and the marker's format live in `AGENTS.md`, *The design freeze* — not restated here.

Read `design/00-brief.md`. Write `design/10-design.md`.

This is the stage where irreversible decisions get made. Data model, module boundaries and error semantics are expensive to change later; code is not. Spend the reasoning here.

Required sections, in this order:

## Data model
Entities, their fields with types, ownership, lifecycle, and identity. State which fields are derived and from what. State what is persisted vs in-memory.

## Module boundaries
Each module: what it owns, what it depends on, what it exposes. Draw the dependency direction explicitly and confirm it is acyclic.

## Control flow
The two or three main paths through the system, end to end, named by what triggers them.

## Failure modes
For each external dependency and each boundary: what can fail, how it is detected, what the system does, what the user sees. Include partial failure and retry semantics. Include what state is left behind on failure.

## Concurrency and ordering
What can happen simultaneously, what must not, and what enforces that. If the answer is "nothing is concurrent," say so and say what enforces it.

## Alternatives considered
At least three architectural choices where a different option was viable. For each: what was chosen, what was rejected, and the specific reason for rejection. **A section with no rejected alternatives means the decision was not actually made — go back and make it.**

## Open questions
Things that cannot be resolved without information I have not given you. Ask them here rather than assuming.

Rules:
- No code. No file layouts. No package names beyond what a decision required.
- Every decision that survives goes into `design/90-decisions.md` in the logged format.
- If the brief is too thin to design against, stop and say what is missing rather than inventing requirements.

## Re-run

Rewrites `design/10-design.md` in full from the current brief — there is no partial
regeneration. Check `design/90-decisions.md` before restating a choice; a decision already
logged there is not made fresh on a re-run, only re-expressed. `## Open questions` only ever
shrinks as the brief answers them — a question the brief now answers must not reappear.
