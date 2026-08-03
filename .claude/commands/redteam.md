---
description: Adversarial review of the design doc. Run in a fresh session, ideally on a different vendor's model.
---

Read `design/00-brief.md` and `design/10-design.md`.

You did not write this design and you are not being asked whether it is good. You are being asked where it breaks.

**Do not produce a verdict, a score, a summary, or a "looks solid overall."** Findings only.

For each finding:

```
[SEV] <one-line claim>
Where: <section or component>
Breaks when: <the specific condition, with concrete values where possible>
Consequence: <what the user or operator experiences>
Cheap to fix now / expensive to fix later: <which, and why>
```

Severity: `BLOCKING` (design cannot ship as written), `STRUCTURAL` (works, but the fix later requires touching many modules), `LOCAL` (contained, fixable in one place).

Attack these specifically:

- **Data model** — what state can become unreachable, orphaned, or internally contradictory? What happens on partial write?
- **Boundaries** — which module knows something it should not? Where will a change ripple further than the design implies?
- **Failure modes** — which listed failure has an unhandled second-order effect? What fails silently?
- **Scale** — what breaks at 100x the stated volume? At 1 item? At 0?
- **Concurrency** — what is assumed serial that is not guaranteed serial?
- **Non-goals** — where does the design quietly build toward something the brief excluded?
- **Absence** — what is not mentioned at all? Missing sections are findings.

Rules:
- Do not propose fixes. Naming the fix invites me to accept your framing of the problem.
- Do not soften. If something is BLOCKING, say BLOCKING.
- If you genuinely find nothing at a severity level, say "none at this level" rather than padding.
- Findings go to stdout, not into the design doc. I decide what gets written back.
