---
description: Reproduce and fix a defect that has no slice — from a bug issue number, a description, or a failing test already in context
argument-hint: [issue number, a description, or leave blank to auto-pick the highest-value open bug]
---

Fix the defect named by **$1** — an issue number, a description, a failing test already in this session's context, or (with no argument and none of those) the highest-value open bug issue, picked automatically. `/slice` needs a slice id and a contract signature; a bug has neither, which is why this command exists as its own front door rather than an extension of `/slice`.

**Command name checked against Claude Code's built-in commands before this file was created — no collision.**

## Reproduce first

Before filing anything, branching, or editing: **reproduce the defect.** Write or run the test, script, or manual steps that show it failing, and keep that evidence — it becomes the issue's `Reproduce` section.

**Where it will not reproduce, stop.** Report a diagnosis task: what was tried, what was expected, what happened instead. No issue is filed, no branch is created, no code is touched. An unreproducible report is not yet a bug.

## Get to an issue

- **Given an issue number:** read it. That issue's `<!-- agent:start -->` block is the specification for the rest of this command — obey its stop conditions without restating them here. `.github/ISSUE_TEMPLATE/bug.md`'s block covers the constraints that apply when no other document does: authority is the failing test, out-of-scope is adjacent defects, contract or schema changes are amendments, and a fix is verified by reverting it.
- **Given a description, or a failing test already in context:** after reproducing, check `.github/ISSUE_TEMPLATE/bug.md` exists. **Where it does not, stop and say the authority document is absent** — this path has nothing to file against. Where it does, file one issue from that template, with the reproduction from above as its `Reproduce` section. State the issue number this command is now implementing against.
- **Given nothing at all — no number, no description, no failing test in context:** pick the open issue worth the most right now, no ask required. Rank by an explicit priority signal first — a `P0`/`P1`/`P2`-style label, or a repository custom field surfaced by `list_issue_fields` — and where none exists, the oldest open `bug` issue. State which issue was picked and why, then reproduce it before doing anything else. **If it will not reproduce, stop as above** — do not fall through to the next-ranked issue without saying so first.

Filing happens **after** reproducing, never before — filing first would put an unreproduced report into the tracker as a bug.

## Branch

Derive `fix/<issue>-<slug>` from the issue number and title, **after the issue exists** — never before, since the branch name needs a real number.

`git status --short` must be clean and on the default branch first, the same guard `/slice` uses (`AGENTS.md`, *Safe start*). Uncommitted work that is not this defect's is not this command's to stash or discard — stop and say so.

## Fix, then hand off

Implement against the issue's agent block. When it is satisfied:

- **Push, then open the pull request. Never as a draft.** Carved out of the authorization rule the same as pushing the branch (`AGENTS.md`, *Git and delivery*).
- **`/pr`** — same session. Writes the real description, runs this repository's gates and writes their three lists into the `Verified` section verbatim, and works the review threads once review lands. Fixing and resolving are delegated there — no ask required.

This command does not carry a second copy of `/pr`'s rules, or of the gate and thread procedures it delegates to — it references them by name and hands off.

## Never

- Edit `design/`. A bug fix is not a design change; where fixing this one turns out to need a contract or schema change, that is `/contract`'s or `/design`'s, and this command stops rather than making it.
- Open a pull request as a draft.
- Resolve a review thread. That is `/pr`'s final phase, under the batch `AGENTS.md` defines.
- Merge.
- File an issue for a defect that did not reproduce.
- Fix an adjacent defect noticed along the way. Note it, do not widen the change — the same discipline `resolve.md` and `AGENTS.md`'s *One slice at a time* already state.
