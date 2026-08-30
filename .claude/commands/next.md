---
description: Work out what this repository owes next, and do it - stopping at any session boundary rather than crossing it
---

<!-- companion:declared:start -->
**Per-repo companion:** `.claude/commands/next-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`, `extra-steps`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:declared:end -->

`/kit-help` answers "where am I and what runs next" and then stops, so the answer has to be typed
back in by hand every time. This command answers the same question and then **runs it** — with one
rule that keeps it from breaking the contract it operates under.

## The rule

**Act where the next step is legal in this session. Stop where it is not.**

`AGENTS.md` § *Session boundaries* is the authority on which is which, and this command does not
restate the table. Read it, decide which side the next step falls on, and then:

- **Same session** — run the command. `/pr` after `/slice`, `/resolve` after `/pr`, `/clean` after
  a merge. No confirmation, no announcement first; act and report.
- **Fresh session** — do **not** run it. Emit the boundary banner in the form `AGENTS.md` defines
  and stop. Merge → `/track`, implementation → `/reconcile`, `/design` → `/redteam`, and every
  artifact-writing stage to the one after it, all land here.
- **Deep-reasoning tier** — do not run it under this command's `sonnet`/`medium` routing even
  where no boundary applies. Name the command and its tier, and stop. The work-start banner in
  `AGENTS.md` § *Model, effort, and review budget* is what gates that, and it gates this command
  the same as any other.

**Nothing is ever assumed owed.** Every step below is decided from something read, not from what
usually comes next. This is the whole reason the command exists: `/clean` used to name `/track`
unconditionally, `/track` opened a pull request for its own mirror refresh, and the merge brought
the session straight back to `/clean`. A handoff that never checks is a loop.

## Orient

`/kit-help` owns the stage map and this command reads it rather than carrying a copy — go there
for what stage 0 through 6 mean and which command belongs to each. What this command adds is a
check of what is *outstanding*, which orientation alone does not answer:

```powershell
git status --short --branch
git branch --show-current
gh pr list --state open --json number,title,headRefName 2>$null
gh pr list --state merged --limit 5 --json number,title,mergedAt 2>$null
pwsh ./tools/Test-DesignDrift.ps1
pwsh ./tools/Test-DesignState.ps1
```

**Say which signal you used.** A step taken on evidence nobody can see reads the same as a step
taken from habit.

## Decide, in this order

Take the **first** row that matches. Do not batch — one action per invocation, then report and
stop, so the next invocation decides against a tree that has actually moved.

| If | Then |
|---|---|
| `design/FROZEN.md` exists **and** the next step is `/design`, `/contract`, `/slices`, `/reconcile` or `/track` | Report `Frozen because` and `Lifts when` **verbatim** and stop. Do not route around a freeze |
| The tree is dirty with work in progress | Report what is uncommitted and stop. Guessing whose work it is, is how it gets lost |
| A branch is checked out with an open pull request | `/pr` — same session, run it |
| A branch is checked out with unpushed commits and no pull request | Commit by named path, push, open the pull request. `AGENTS.md` § *Git and delivery* delegates all four |
| A pull request merged and its local branch still exists | `/clean` — same session, run it |
| `/clean` just ran, or a merge landed with nothing local left to clean | **Boundary.** Banner for `/track`, fresh session, `sonnet`/`medium`. Stop |
| `Test-DesignDrift.ps1` or `Test-DesignState.ps1` reports a blocking finding | Report the finding and name the command that owns it. Do not fix it here |
| An issue exists with unticked `Done when` boxes and no branch in flight | `/slice S<n>` — **boundary**, one slice per session. Banner and stop |
| `design/30-slices.md` § *Outstanding* is empty and every issue is closed | Say the slice set is exhausted, and name `/reconcile` (**boundary**, `opus`/`high`) as what follows |
| Nothing above matches | Say so plainly. "Nothing is owed" is a valid answer and is the one this command exists to be able to give |

## Report

One short block, in this order: **what you read**, **what you concluded**, **what you did or why
you stopped**. Where you stopped at a boundary, the banner is the last thing in the response, set
off as `AGENTS.md` requires — not folded into a closing sentence.

## Never

- **Cross a session boundary because the next step is small.** Size is not what the boundary
  measures; carried context is.
- **Run more than one routed command per invocation.** Each one changes the state the next
  decision is made from.
- **Invent a step.** Where the table above matches nothing and `/kit-help`'s stage map matches
  nothing either, say the state matches no stage and ask. An invented next step in the command
  whose entire job is naming the next step is the one that gets followed.
- **Run `/redteam`.** Its routing requires a different vendor from the design author, which this
  session cannot satisfy by construction. Name it, banner it, stop.

## Re-run

Stateless. Every decision is re-derived from the tree, the tracker, and the gates as they stand
at the moment it runs, so two calls in a row legitimately give different answers when something
moved in between — and give the same answer, harmlessly, when nothing did.
