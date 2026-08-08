---
description: Sync design/ into GitHub issues and milestones. Idempotent - safe to re-run.
argument-hint: [milestone name]
---

Reconcile `design/` against this repository's GitHub tracker. This command is the kit's single home for GitHub writes, and the authorization carve-out that permits them is in `AGENTS.md`, *Tracking work* — read it before writing anything.

Re-running must be a no-op when nothing has changed. That is the property that makes this safe to run often, and it is the first thing to get right.

## Before anything

```powershell
gh auth status
gh repo view --json nameWithOwner,owner,hasIssuesEnabled,viewerPermission
```

- **Only write to a repository the user owns** and has push permission on. Stop otherwise.
- If issues are disabled, stop and say so.
- If the remote is not the repository you think it is, stop.

## Issue body — human first, agent detail second

Every issue this command writes has the same two parts, in this order.

1. **A narrative a human reads.** Two or three sentences: what someone can do afterwards that they cannot do now, and why it matters. No implementation vocabulary, no file paths, no type names.
2. **`### Done when`** — the acceptance criteria as checkboxes. These are the tracking surface; a pointer cannot be ticked off.
3. **A collapsed `<details>` block** holding the agent detail.

```markdown
**S3 — Host registration, heartbeat, and the split-brain surface**

A caller can register a host, watch it heartbeat, and see when two hosts claim
the same identity.

### Done when
- [ ] **S3.1** `RegisterAsync` returns `AlreadyRegistered` and leaves the record untouched when the id exists
- [ ] **S3.2** A missed heartbeat window marks the host `Stale` within one interval

---
<details><summary><b>Agent instructions</b></summary>
<!-- agent:start -->

Run `/slice S3`.

- **Scope and criteria:** `design/30-slices.md` § S3 @ `a1b2c3d`
- **Signatures:** `design/20-contract.md`
- **Out of scope here:** redrive (S7), telemetry (S8)

Stop conditions and procedure: `.claude/commands/slice.md`. Not restated here.
<!-- agent:end -->
</details>
```

Four properties make this work, and each is load-bearing:

- **The narrative is `Delivers:` verbatim.** Never invent prose for it. If it reads badly, that is a `/slices` defect — fix the doc, where the slice set is reviewed, and re-run.
- **The block is fenced.** `<!-- agent:start -->` and `<!-- agent:end -->` are a boundary, not a request. Everything between them is regenerable; everything outside is human-owned and never touched.
- **The block is thin.** Only what is specific to this issue: which slice, where authority lives, this slice's out-of-scope. **Generic stop conditions stay in `.claude/commands/slice.md`.** Copying them here would freeze a stale copy into every issue, and this command cannot edit issues to fix them.
- **Authority is pinned to a commit.** `§ S3 @ <sha>` is the sha of the last commit touching `design/30-slices.md`. It tells a reader whether the doc moved since the issue was written.

The rules this shape obeys — human-first, agent block is not a copy, never rewrite a checkbox — are stated in `AGENTS.md`, *Tracking work*. This section is the format; that one is why.

## What syncs

### Slices → issues

For each `## S<n> — <name>` in `design/30-slices.md`:

- Search existing issues, **open and closed**, for a title beginning `S<n> —`. A closed issue means the slice is done — do not reopen it and do not open a second one.
- If none exists, open one in the shape above. `Delivers:` becomes the narrative; `Acceptance:` becomes the `Done when` checkboxes, ids included; `Out of scope:` goes in the agent block.
- If one exists, **compare criterion ids, not prose.** Read `S<n>.<m>` from the issue's checkboxes and from the slice's `Acceptance:` lines:
  - **Ids match** — nothing to report, even if the wording differs. Reworded criteria are the common case and are not drift.
  - **An id is in the doc but not the issue** — a criterion was added after the issue was opened. Report it.
  - **An id is in the issue but not the doc** — a criterion was removed or, worse, renumbered. Report it and say which; a renumber means an existing checkbox now refers to something else.
- **Change nothing on a mismatch** — not the issue, not the doc. Which side is wrong is the user's call.
- **Never rewrite anything outside the `<!-- agent:start -->` … `<!-- agent:end -->` fence.** A ticked checkbox is progress someone recorded and an edited narrative is someone's deliberate wording. Inside the fence, regenerating is safe and is how a stale commit pin gets refreshed.

`design/30-slices.md` stays authoritative for what a slice *is*. The issue tracks whether it is *done*.

### Open items → issues

For each bullet under `## Open` in `design/90-decisions.md`:

- Title from the bolded lead sentence. The bullet's own prose is already human-readable — it becomes the narrative unchanged.
- `Done when` is whatever closing the item would require. If the item is a question rather than a task, the single criterion is that the question is answered and the answer recorded.
- The agent block carries: **Authority** — this issue, since the bullet no longer lives in `90-decisions.md`; and **Stop if** it turns out to need a contract or schema change.
- Match on title to avoid duplicates.
- After opening the issue, **remove the bullet from `## Open`** and say you did. That section exists so items do not rot; once an item is tracked, leaving it in both places is the duplication this kit's contract forbids.
- An item that is a *decision* rather than a *todo* does not belong in an issue. Leave it and say why.

### Milestone

`$1` names the milestone; with no argument, do not invent one — ask.

**Creating a milestone needs explicit approval.** Propose the name and which issues would attach, then wait. Milestones are structural and few; issues are cheap and many, which is why only the latter is carved out.

## Bugs and stories are not synced

`/track` only syncs *from* `design/`. A **bug** has no upstream document — the issue is its origin — and a **story** that is not a slice of an existing design has none either. Both are filed by hand from `.github/ISSUE_TEMPLATE/`, which carries the same narrative-then-agent-block shape pre-filled.

**Do not open bug or story issues from this command**, and do not treat one you find as drift. If work you were asked to track is really a bug, say so and point at the template rather than inventing a slice for it.

## Labels

Use `slice` and `open` if they exist. Create them if missing — say that you did. Do not invent a wider taxonomy; `bug` and `enhancement` come from the issue templates, not from here.

## Projects

The convention is **one project per repository, named after it**.

- Look for a project whose title matches this repository's name. If one exists, **add every issue you opened to it** and say so.
- If none exists, **say so and carry on.** Do not create one — board structure is columns, fields and views, and a command gets that generically wrong. Creating it is an approval step, and a bare project is worth less than the thirty seconds it saves.
- Never remove an issue from a project, change its status field, or reorder a board. Adding is the only project write.

GitHub Projects v2 needs the `project` token scope, which `repo` does not include. If `gh project list --owner <owner>` fails on scope, **say so and continue with issues and milestones** — a missing board is not a reason to abandon the sync. The fix is the user running `gh auth refresh -s project` in an interactive terminal; you cannot complete an OAuth flow.

## Report

- Issues opened, with numbers and titles
- Issues that already existed, skipped
- Slices whose criteria drifted from their issue
- Open items removed from `90-decisions.md`
- Whether a matching project was found, and what was added to it
- Anything skipped, and why

**Then ask.** Drift between a slice and its issue is a reconciliation, and **a reconciliation ends in a decision, not a report** (`AGENTS.md`, *Working with me*). For each mismatch, put the resolution to the user with a recommendation — amend the doc, amend the issue, or accept the difference — and say what each costs. Report a clean run as clean; do not invent a question to close on.

## Never

- Close an issue. Work being finished is not something this command can observe.
- Comment on, edit, or label an issue opened by someone else.
- Write to a repository the user does not own.
- Delete a milestone or a label.
