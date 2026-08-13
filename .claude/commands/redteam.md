---
description: Adversarial review of the design doc. Run in a fresh session, ideally on a different vendor's model.
---

<!-- companion:start -->
**Per-repo companion:** `.claude/commands/redteam-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:end -->

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

## Stopping rule

**A red-team pass is a phase gate, not an iterative design loop.**

- One invocation authorizes **exactly one complete pass**. At most one pass per materially changed design revision.
- **Never automatically recommend or start another pass.** Repeat only when I ask and the design has materially changed since the last one.
- After a pass, stop. Present findings **one at a time** for adjudication, and classify each as I rule on it: **defect**, **accepted risk**, **brief conflict**, or **not sustained**.
- **Recommend a classification for each, but never a fix.** The general rule is that a reconciliation ends in a decision rather than a report (`AGENTS.md`, *Working with me*); this command is the one place it is narrowed. Naming a fix invites me to accept your framing of the problem — naming a *severity and category* does not.
- **A known-and-retained decision is not a new defect.** It becomes one only if new evidence shows it contradicts a higher-precedence source, or creates a consequence not already recorded. Name that evidence or consequence — without one, it is the same finding again.
- For a local correction, verify the correction. Do not reread and re-attack the whole design because wording changed.
