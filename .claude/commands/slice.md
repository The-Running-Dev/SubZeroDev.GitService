---
description: Implement one slice. Usage - /slice S3, or /slice for the next one
argument-hint: [slice id, omit for the next]
---

<!-- companion:declared:start -->
**Per-repo companion:** `.claude/commands/slice-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `vocabulary`, `document-map`, `extra-steps`, `gate-commands`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:declared:end -->

Implement one slice from `design/30-slices.md`. The slice is **$1**, where that names one. Where it is empty — or, invoked outside Claude Code, still the literal `$1` — select it as below first.

## Which slice

**An id given as `$1` wins.** Never substitute a slice you think is more sensible, even for one whose dependencies are unmet or that is plainly out of order. Say so and stop instead. Stop too if `design/30-slices.md` contains no such slice.

**With no id, the next slice is the lowest-numbered one that is not done and whose dependencies are done.** Selection is the whole of the difference — everything after it is identical.

A slice is **done** when its issue is closed, or when every box under `Done when` is ticked. `/slice` ticks a box itself, in the same run it reports the matching criterion met by id (`AGENTS.md`, *Tracking work*), which makes the tracker the only evidence of doneness this kit recognises. **Do not infer it from the working tree, the commit log, or code that appears to already exist** — that is equally what an abandoned attempt looks like.

```powershell
gh issue list --state all --limit 200 --json number,title,state,body
```

Match a slice to its issue on a title beginning `S<n> —`, the same way `/track` does.

- Skip a slice whose `Depends on:` names one that is not done, and say which dependency held it back.
- A slice with some boxes ticked and some not is **in progress, not done**, and it is the next slice. Re-establish which criteria still fail before writing anything. Do not assume the unticked ones are exactly the outstanding work.
- **Say which slice you picked and why it was next, in one line, before doing anything else.** Then proceed as though it had been given.

Stop and ask rather than choosing when:

- `design/30-slices.md` is missing or holds no slices. `/slices` writes it.
- Every slice is done. Say so; do not go looking for adjacent work.
- The tracker cannot be read — `gh` absent, not authenticated, issues disabled. **Do not fall back to the lowest number.** Doneness is unobservable without it, so name the slice you would have picked and wait, rather than starting one that may already be finished.
- Two slices carry the same number. That is a defect in `design/30-slices.md` — report it, do not pick one.

## Implementing it

Before writing code, read `design/20-contract.md` for every signature you will touch. The contract is authoritative — if what you need is not in it, stop.

**Where this repository's own `design/state/` exists**, establishing what is currently true about a unit you are about to touch reads that unit's closure (`design/10-design.md` § *Orient*) rather than the corpus, and `design/90-decisions.md` is not opened to establish it. **Where it is absent** — every installed target, and this repository before the mechanism existed — behaviour is today's: read the files and the contract as this section already describes (I27).

Sequence:

1. **Branch.** `git status --short` must be clean and on the default branch before you touch anything; uncommitted work that is not this slice's is not yours to stash or discard (`AGENTS.md`, *Safe start*) — stop and say so instead. Create and check out `slice/S<n>` from the default branch's latest. **Refuse to implement on the default branch** — `/pr` refuses to open a PR from it, and the branch is one command away.
2. State the slice's acceptance criteria back as a checklist, **by id** — `S3.1`, `S3.2`. One line each. Nothing else.
3. Write the tests that check those criteria. They must fail for the right reason before you write the implementation.
4. Implement against the contract signatures exactly. No signature drift, no added parameters, no widened return types.
5. Run the tests. Run the full suite, not just the new tests.
6. **Commit, then push.** Stage by named path — never `git add -A`, `git add .`, or a bare directory (`AGENTS.md`, *Git and delivery*).
7. **Open the pull request. Never as a draft.** Carved out of the authorization rule the same as pushing the branch (`AGENTS.md`, *Git and delivery*). Title it from the slice name and **write the real description now**, in the shape `.claude/commands/pr.md` § *Phase 1* fixes — not a placeholder telling the reader to run `/pr` for the real one. A PR body that describes nothing is the same split the no-draft rule exists to prevent: "opened" and "actually reviewable" become two states someone has to reconcile by hand, and a reviewer who arrives in between has nothing to read. `Verified` is the one section that legitimately says the gates have not run yet, because they have not; `/pr` replaces it verbatim in this same session and then works the review threads. Check for an existing open PR on this branch first and do not open a second one.
8. **Tick the `Done when` boxes** on the matching issue for every id this run confirms met. Carved out the same way (`AGENTS.md`, *Tracking work*) — the report in step 9 and the tick are the same claim now, not two.
9. Report **by criterion id**: which are met, which are not and why, anything you had to decide that the contract did not determine, and the branch name and PR URL.

## Correcting the document as you go

**Descriptive drift is corrected here, in this slice's commit** — the rule and its boundaries are in `AGENTS.md`, *Hard rules*, and are not restated. What that means in practice:

- A declaration, parameter list, field name, path, or count in `design/` that the tree now states differently is a **transcription error**. Fix the document by named path, in the same commit as the code, and say in step 9 what you corrected. Do not raise it as a fork and do not log a decision — there is no decision in it.
- Materialising a `20-contract.md` scaffold is this same correction: once a declaration exists in the tree, **replace the block in the contract with a pointer to the file that now declares it** and keep only what the declaration cannot say (`.claude/commands/contract.md`, *Semantics, not shape*).
- **An invariant, a non-goal, an acceptance criterion, or a public interface is not descriptive drift.** Those are the stop conditions below, unchanged.
- **`design/30-slices.md` is never edited here**, including this slice's own criteria. A criterion that is wrong is a `/slices` matter.
- **If `design/FROZEN.md` exists, correct nothing.** State the contradiction in the pull request and leave the document alone (`AGENTS.md`, *The design freeze*).

Stop conditions — halt and report rather than proceeding:

- The contract does not contain a signature you need.
- Two readings of an acceptance criterion are both defensible.
- Making the slice work requires changing a signature, schema, or invariant.
- You find a defect outside this slice. Note it, do not fix it.
- The `Out of scope` line is blocking you. That is information, not an obstacle to route around.

Do not:
- Touch files outside `Touches` without saying why first.
- Refactor adjacent code.
- Add dependencies.
- Edit `design/30-slices.md`, or change any invariant, non-goal, or public interface. Descriptive correction is bounded to the section above; everything else is still `/slices`', `/contract`'s, or `/reconcile`'s.

## Not meant to be re-run

**One slice, one session** (`AGENTS.md`, *Session boundaries*). This command does not resume
itself — it has no notion of picking back up mid-implementation, and does not replay or trust
what an earlier session on the same slice did from memory. If a session ends before a slice is
done, the next invocation is a fresh `/slice` (with or without an explicit id) that re-selects
purely from the tracker's current state — issue open or closed, which boxes are ticked — per
*Which slice* above, and re-establishes what still fails rather than assuming the unticked
criteria are exactly the outstanding work. A session that compacted mid-slice is not resumed
either; report it as a mis-sized slice, per `AGENTS.md`, *Session boundaries*.
