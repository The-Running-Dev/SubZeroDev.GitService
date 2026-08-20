---
description: Create design/FROZEN.md so design/ stops drifting while implementation is the bottleneck
---

<!-- companion:declared:start -->
**Per-repo companion:** `.claude/commands/freeze-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:declared:end -->

Write `design/FROZEN.md`. Its existence is the whole mechanism — the rule, what it gates, and the marker's format are owned by `AGENTS.md`, *The design freeze*; this command only produces the file correctly and does not restate the rule.

## Refuse if already frozen

If `design/FROZEN.md` already exists, stop. Report its current `Frozen because` and `Lifts when` verbatim and take no action — freezing again would silently overwrite a reason and a condition someone else set.

## Get the two lines that matter

`Frozen because` and `Lifts when` are judgement calls, not facts this command can derive from the tree. **Do not invent them.** If the user has already stated them in this conversation, use those words. Otherwise ask, in plain language:

- What is the freeze escaping — what loop or drift is this stopping?
- What is the checkable condition that lifts it? A condition someone can later confirm true or false ("tier one is code-complete") — not an intention ("when we are ready").

## Write the marker

```powershell
git rev-parse --short HEAD
```

Write `design/FROZEN.md` in exactly this format — no additional sections:

```markdown
# design/ is frozen

Frozen at: <sha>, <YYYY-MM-DD>
Frozen because: <what the freeze is escaping>
Lifts when: <the checkable condition>

To lift: run `/unfreeze`, or delete this file by hand and run `/reconcile`, then `/track`.
```

Use today's date and the short SHA from above.

## Commit it

Stage `design/FROZEN.md` by name — never a broad add. Commit and push per `AGENTS.md`, *Git and delivery*: on a non-default branch this is delegated, commit and push without a separate ask; on the default branch, ask before pushing.

## Report

State the file was written, quote `Frozen because` and `Lifts when` back, and name the five commands that now refuse (`/design`, `/contract`, `/slices`, `/reconcile`, `/track`).
