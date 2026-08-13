---
description: Lift the design freeze — delete design/FROZEN.md, then run one reconciliation pass
---

<!-- companion:start -->
**Per-repo companion:** `.claude/commands/unfreeze-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`, `extra-steps`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:end -->

Lift the freeze `/freeze` set. This command runs unattended, without a confirmation prompt — that is a deliberate policy in this repository (`AGENTS.md`, *The design freeze*), not an oversight, so do not add one back.

**This command owns the sequence. It does not own the procedure of either phase.** Phase 2 is `.claude/commands/reconcile.md` and phase 3 is `.claude/commands/track.md`, run in full, in this same session. Those files stay the single home for how drift is compared and how the tracker is resynced — this one never restates them (`AGENTS.md`, *Single ownership*). Both remain invocable on their own.

## Refuse if not frozen

If `design/FROZEN.md` does not exist, stop and say there is nothing to lift.

## Phase 1 — read and delete the marker

Report `Frozen because` and `Lifts when` verbatim before touching anything — this is the last point they're readable, and the report is the record that the freeze actually ended here rather than just going stale.

Delete `design/FROZEN.md`. This command is the one exception to `/reconcile`'s own rule that it never deletes the marker itself — `/reconcile` still won't, because by the time phase 2 runs here the file is already gone.

## Phase 2 — reconcile

**Run `.claude/commands/reconcile.md` in full** against the now-unfrozen tree. Deep-reasoning tier (`opus`, `high`) — deciding which side of a drift is correct is exactly the judgement call that tier exists for.

## Phase 3 — track

**Run `.claude/commands/track.md` in full** once reconciliation has landed. `sonnet`, `medium` — mechanical sync against whatever `/reconcile` just wrote.

## Commit

If reconciliation touched `design/`, stage those files by name and commit per `AGENTS.md`, *Git and delivery*. The marker's own deletion is part of the same commit, not a separate one.

## Report

State the freeze is lifted, what `/reconcile` found and changed, and what `/track` synced. If `/reconcile` or `/track` surfaced something that needs a decision — a contested drift, a slice that turns out to need a contract amendment — stop there and ask, one item at a time, rather than resolving it inline.

## Re-run

**Refuses outright on a second run** — *Refuse if not frozen*, above — so there is nothing to
skip or refresh across repeated invocations; each successful run consumes the one marker
`/freeze` wrote, and a fresh freeze needs a fresh `/freeze` before this command has anything to
lift again.
