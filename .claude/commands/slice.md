---
description: Implement one slice. Usage - /slice S3, or /slice for the next one
argument-hint: [slice id, omit for the next]
---

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

Sequence:

1. **Branch.** `git status --short` must be clean and on the default branch before you touch anything; uncommitted work that is not this slice's is not yours to stash or discard (`AGENTS.md`, *Safe start*) — stop and say so instead. Create and check out `slice/S<n>` from the default branch's latest. **Refuse to implement on the default branch** — `/pr` refuses to open a PR from it, and the branch is one command away.
2. State the slice's acceptance criteria back as a checklist, **by id** — `S3.1`, `S3.2`. One line each. Nothing else.
3. Write the tests that check those criteria. They must fail for the right reason before you write the implementation.
4. Implement against the contract signatures exactly. No signature drift, no added parameters, no widened return types.
5. Run the tests. Run the full suite, not just the new tests.
6. **Commit, then push.** Stage by named path — never `git add -A`, `git add .`, or a bare directory (`AGENTS.md`, *Git and delivery*).
7. **Open the pull request. Never as a draft.** Carved out of the authorization rule the same as pushing the branch (`AGENTS.md`, *Git and delivery*). Title it from the slice name; the body can be minimal, since `/pr` writes the real description in this same session and runs the gates and the review threads after it. Check for an existing open PR on this branch first and do not open a second one.
8. **Tick the `Done when` boxes** on the matching issue for every id this run confirms met. Carved out the same way (`AGENTS.md`, *Tracking work*) — the report in step 9 and the tick are the same claim now, not two.
9. Report **by criterion id**: which are met, which are not and why, anything you had to decide that the contract did not determine, and the branch name and PR URL.

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
- Update the design docs. That is `/reconcile`.
