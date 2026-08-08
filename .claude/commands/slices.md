---
description: Break the contract into vertical slices with acceptance criteria
---

Read `design/10-design.md` and `design/20-contract.md`. Write `design/30-slices.md`.

Slices are **vertical**: each one goes from entry point to persistence and leaves the system runnable. A slice that only adds a layer ("build the data access layer") is wrong — it cannot be run, so it cannot be verified, so it accumulates undetected error.

Per slice:

```
## S<n> — <name>
Delivers: <one or two sentences, written as a user story: who this is for and what they
          can do afterwards that they could not before. This becomes the issue's narrative
          verbatim, so write it for a human who will never open the design docs — no
          pixel values, breakpoints, file paths, or type names.>
Touches: <files or modules, from the contract>
Depends on: <slice numbers, or none>
Acceptance:
  - S<n>.1 <criterion, stated as an observable behaviour with concrete inputs and outputs>
  - S<n>.2 <...>
Out of scope: <the adjacent thing an agent will be tempted to also do>
```

Rules:
- Acceptance criteria must be checkable without judgement. "Handles errors gracefully" is not a criterion. "Returns `NotFound` and leaves the record untouched when the id does not exist" is. This is where precise, technical detail belongs — measurements, thresholds, exact values — not in `Delivers:`.
- **Every criterion carries a stable id** — `S3.1`, `S3.2`. The id is what `/track` matches on, so drift detection compares ids rather than prose and a reworded criterion stops reading as a new one.
- **Ids are never reused and never renumbered.** Removing `S3.2` leaves a gap; the next criterion is `S3.4`. Renumbering silently rewrites what an existing issue's checkbox refers to, which is the one failure this scheme exists to prevent.
- `Delivers:` is the only line written for a non-implementer, and it is a user story, not a spec summary. If it reads as a label, a measurement list, or an implementer's recap rather than a sentence about a person, the issue narrative will too — fix it here, where the slice set is reviewed, rather than letting `/track` invent prose.
- Every slice needs an explicit `Out of scope` line. This is the single most effective constraint on an implementing agent.
- Order slices so the riskiest assumption in the design gets exercised earliest. If the design bets on something working, slice 1 or 2 should prove it.
- Target a slice a coding agent can finish in one session without compaction. If a slice needs more, split it.
- No slice may introduce a signature absent from the contract.

Write the document only. **Do not open issues** — that is `/track`'s job (`AGENTS.md`, *Tracking work*). Say that it should be run next.
