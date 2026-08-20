---
description: Check the design docs against the tree, and decide the differences that are decisions
---

<!-- companion:declared:start -->
**Per-repo companion:** `.claude/commands/reconcile-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`, `extra-steps`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:declared:end -->

## Stop if `design/` is frozen

If `design/FROZEN.md` exists, **stop before doing anything else.** Report its `Frozen because` and `Lifts when` lines verbatim and take no other action. The rule and the marker's format live in `AGENTS.md`, *The design freeze* — not restated here.

This command is the one the freeze ends *with*, which is exactly why it does not end the freeze itself: the marker is deleted by hand first, and then this runs as the single reconciliation pass. **Never delete `design/FROZEN.md` yourself**, and never treat "the freeze looks finished" as authorization to proceed — `Lifts when` names a checkable condition, and confirming it is the user's call, not this command's.

Compare the working tree against `design/10-design.md` and `design/20-contract.md`.

This is the step that stops the docs becoming fiction. A stale design doc is worse than none, because every future agent session gets confidently briefed on a system that does not exist.

## What is no longer this command's

**This is a check, not a rewrite.** Two things were taken off it deliberately, and taking either back is how it becomes generative again — which is the loop `AGENTS.md`, *The design freeze* exists to escape.

- **Descriptive drift is already gone.** A declaration, parameter list, field name, path or count that disagreed with the tree was corrected in the slice that found it, in that slice's commit (`AGENTS.md`, *Hard rules*). Anything of that kind still here is a slice that missed it: correct it, in one line, and move on. **Do not open it as a fork** — there is no decision in a transcription error, and turning one into a question is most of what made this command expensive.
- **`design/30-slices.md` is out of scope entirely, and an unlanded slice's acceptance criteria are never edited here.** Landing slice N and then rewriting slice N+1's criteria is the first link in the churn loop, and it is the one link this command owns. A problem found with an unlanded slice's criteria is escalated to `/slices` or written to `## Open` in `90-decisions.md` — never resolved in this pass. `/track` compares the tracker against that document; if this command has just rewritten it, the two were never independent.

Produce a drift report first, before editing anything:

## Contract drift
Places where the code and `20-contract.md` disagree **about meaning**: an error variant raised under conditions the contract does not describe, a documented retry story the caller does not implement, a field the contract says is meaningful only under one state being populated under another, an invariant no longer held. For each: which is currently correct, and what the other should become.

`20-contract.md` no longer restates declarations, so a signature difference is not reportable here — it is either a descriptive correction (above) or, where a public interface genuinely changed, a contract amendment that belongs to `/contract`. Say which; do not absorb it.

## Design drift
Places where the implemented structure differs from `10-design.md` — module boundaries crossed, control flow changed, a failure mode handled differently or not at all.

## Undocumented decisions
Choices made during implementation that are not in `90-decisions.md`. These are the ones that silently become load-bearing.

## Invalidated assumptions
Anything the design assumed that implementation showed to be false.

## Generated-guide drift
If `docs/docs/guide.md` (or `guide.md`) exists, compare it against the design and contract. It is generated, so it goes stale silently. Report only **semantic** divergence — behaviour it describes that the design no longer specifies, or design changes it does not reflect. Do not report wording differences; a regenerated file is never byte-identical. If it is stale, say so and recommend `/make-human-docs`; do not regenerate it as part of this command.

## Lessons
Things that cost time and would cost it again. Each one must name what it actually cost — a lesson with no cost attached is a preference, and preferences go in `AGENTS.md`, not `agent.md`. Propose these for `agent.md`; do not append them yourself. If nothing here would have changed a decision, say "none" rather than padding.

## Then ask — do not stop at the report

**A reconciliation ends in a decision, not a report** (`AGENTS.md`, *Working with me*). Having listed the drift, close by asking me to resolve it — one divergence at a time, each with a recommendation and what the alternatives cost.

For each: which direction you recommend — the code changing to match the doc, or the doc changing to match the code — **and why that one**. Do not assume the code is right just because it runs; a passing test proves the code does what it does, not that it does what was agreed.

If a section found nothing, say "none" and move on. Do not manufacture a fork to have something to ask about.

Once I have decided, apply the edits and append the decision-log entries — following the full record-writing sequence in `design/10-design.md` § *Record* where this repository's own `design/state/` exists. Nothing else beyond that sequence.

## Re-run

Every run re-derives every section from the tree and `design/` as they currently stand —
nothing from a prior pass is cached or assumed still true, and every section is checked again
even where a previous run said "none." A divergence already decided and applied should not
reappear as a fresh question; if it does, that is drift in what got applied, not a re-ask, and
is itself a finding worth naming. A decision I already made and recorded in `90-decisions.md`
is not relitigated (`AGENTS.md`, *Budget discipline*).
