---
description: Break the contract into vertical slices with acceptance criteria
---

Read `design/10-design.md` and `design/20-contract.md`. Write `design/30-slices.md`.

Slices are **vertical**: each one goes from entry point to persistence and leaves the system runnable. A slice that only adds a layer ("build the data access layer") is wrong — it cannot be run, so it cannot be verified, so it accumulates undetected error.

Per slice:

```
## S<n> — <name>
Delivers: <what a user or caller can now do that they could not before>
Touches: <files or modules, from the contract>
Depends on: <slice numbers, or none>
Acceptance:
  - <criterion, stated as an observable behaviour with concrete inputs and outputs>
  - <...>
Out of scope: <the adjacent thing an agent will be tempted to also do>
```

Rules:
- Acceptance criteria must be checkable without judgement. "Handles errors gracefully" is not a criterion. "Returns `NotFound` and leaves the record untouched when the id does not exist" is.
- Every slice needs an explicit `Out of scope` line. This is the single most effective constraint on an implementing agent.
- Order slices so the riskiest assumption in the design gets exercised earliest. If the design bets on something working, slice 1 or 2 should prove it.
- Target a slice a coding agent can finish in one session without compaction. If a slice needs more, split it.
- No slice may introduce a signature absent from the contract.
