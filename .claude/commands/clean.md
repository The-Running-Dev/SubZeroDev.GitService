---
description: Switch back to the default branch, delete local branches already merged into it, and prune stale remote-tracking refs
---

<!-- companion:declared:start -->
**Per-repo companion:** `.claude/commands/clean-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `extra-steps`, `tightened-authorization`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:declared:end -->

Housekeeping for the end of a piece of work: get back to the default branch, remove the local branches that are done, and drop remote-tracking refs for branches deleted on the remote. It always ends by handing off to `/next` — see *Hand off to `/next`* below.

**Branch deletion here is carved out of the authorization rule** (`AGENTS.md`, *Git and delivery*) — but only for branches this command independently confirms via `git branch --merged`. It runs automatically, without waiting to be asked, and does not block on a confirmation prompt for that list.

## Run automatically, don't wait to be asked

Run this command's housekeeping as soon as a merge is on the table — either because a PR was just merged in this session (e.g. as `/pr`'s or `/resolve`'s outcome), or because a `git log` / `gh pr list` check surfaces a branch that merged some other way. Don't wait for the user to type `/clean`.

The handoff at the end is part of the same automatic behaviour. `/next` follows every run — it is not asked for, and it is not conditional on how much this run cleaned up. It used to be `/track`, unconditionally, and that is what made the pair self-triggering: `/track` opened a pull request for its own mirror refresh, the merge put a merge back on the table, and this command fired again. `/next` breaks that by *checking what is owed* before running anything.

## Run the mechanical half

Everything through building the candidate list has no judgement call in it — dirty-tree check, default-branch resolution, the unmerged-current-branch check, the switch, the prune, `--merged`, and the `gh` cross-check for squash-merges are all facts, not decisions. `tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo> -AutoStash` does all of it in one call and deletes nothing:

```powershell
tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo> -AutoStash
```

- **`Stopped: true`** means it refused to switch at all — the only remaining `Reason` is `UnmergedCurrentBranch` (the current branch has commits not on the default branch and no merged PR accounts for them, checked via `gh pr list --state merged --head <branch>`). Report `Detail` and stop; this is real unaccounted-for work and stays a hard stop, not something to guess past.
- **`-AutoStash`** means a dirty tree no longer stops the run: the script runs `git stash push -u` first (never a discard) and reports `Stashed: true` / `StashRef`. **Always report the stash** so it doesn't get silently lost on whatever branch is checked out next — tell the user a stash was made and how to get it back (`git stash pop`, or `git stash apply stash@{0}` if something else has since been stashed on top).
- **Otherwise** it has already checked out `DefaultBranch`, pulled (unless it failed), pruned remote-tracking refs (`PrunedCount`), and built `Candidates` — every branch `--merged <default>` confirms, each with its `MergedPr` where `gh` found one. **`--merged` is a genuine merge check**, so a squash-merged branch (GitHub's squash produces a new commit `--merged` cannot see as "the same") never appears in `Candidates` even though `gh` shows it merged. The script cross-checks every branch `--merged` did *not* confirm against `gh` itself and reports the squash-merged ones separately in `SquashMergeCandidates` — you don't need to already know one exists.

## Force-delete a squash-merged candidate — don't ask either

`SquashMergeCandidates` fails the **Merged** gate below by definition, because `git branch --merged` structurally cannot see a squash. It is nonetheless deleted **without a chat confirmation**, on evidence the prompt it replaced never actually checked: the script lists a branch here only when a merged pull request exists for it *and* the local branch tip equals that pull request's `headRefOid`. The branch being force-deleted is therefore exactly the commit that merged. `AGENTS.md` § *Git and delivery* carries the delegation.

Call the script again with every branch on the list:

```powershell
tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo> -SkipPull -ForceDeleteBranches <branch1>,<branch2>
```

Two things this does not cover, and both stay hard stops:

- **`TipAheadOfMergedPr`** — a merged pull request exists, but the local tip is not the head that merged, so commits sit on this branch that nothing accounts for. This is the case a bare `gh pr list --head` reports as merged and `-D` would silently discard. **Report each entry with its `Reason` and ask separately.** Never pass one to `-ForceDeleteBranches`.
- **A name from outside this run.** The script only honours a name its own `SquashMergeCandidates` confirmed — it does not trust one passed in from elsewhere, even one you are certain merged.

## Delete the confirmed candidates — don't block on a prompt

Call the same script again, passing every candidate `--merged` confirmed:

```powershell
tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo> -SkipPull -DeleteBranches <branch1>,<branch2>
```

### Gates for automatic deletion

A branch is deleted without a chat confirmation only if **both** named gates pass. Uncertainty on either one counts as failure — it moves the branch out of the automatic path, not into it:

| Gate | What it checks | Failure means |
|---|---|---|
| **Merged** | `git branch --merged <default>` lists the branch (`$mergedBranches` in the script) | Not a candidate for **this** call — a branch `gh` shows merged by squash lands in `SquashMergeCandidates` instead, and is force-deleted on its own evidence (see above), not after an ask |
| **SafeDelete** | `git branch -d` (never `-D`) exits 0 | The branch is a confirmed candidate but git itself refuses the delete (typically unmerged-relative-to-upstream in a way `--merged` didn't catch) |

Proceed straight to the delete call; do not stop and wait for a chat confirmation first — the candidate list itself is the authorization, since every entry on it independently passed **Merged**. A name that is not in `--merged`'s list fails **Merged** and is refused, not deleted, even if you pass it.

**When a gate fails, name it.** The script's `Refused` entries already carry the failing reason (`$refused` in the script) — report each one as `<branch>: failed <gate name> — <Reason text>`, not just "left alone" or "delegation didn't apply". A **SafeDelete** failure is outside this carve-out — report it and ask separately, one at a time, before ever running `-D` on that branch. The squash-merge path above is the only force delete that needs no ask, and only because the tip comparison is its authorization; a **SafeDelete** failure has no such evidence behind it.

## Report

Report after acting, not before — this is a summary of what happened, not a request for permission:

- Default branch confirmed and checked out
- Remote-tracking refs pruned, and how many (`PrunedCount`)
- A stash made and how to restore it, if `Stashed: true`
- Branches deleted, and the PR each merged through where known (`Deleted`)
- Any branch left alone, and which named gate it failed — **Merged** or **SafeDelete** (`Refused`), or unmerged work that stopped the run before candidates were even built
- Any squash-merged branch force-deleted from `SquashMergeCandidates`, with its PR link — reported after the fact, not asked about first
- Any branch in `TipAheadOfMergedPr`, with its `Reason`, its merged PR, and the ask of what to do about the commits the PR does not account for

## Hand off to `/next` — always

`/next` follows every run of this command. **It is not run here.** `AGENTS.md` § *Session
boundaries* puts a fresh session between a merge and `/track`, and this command normally runs in
the session that just merged the branch it is deleting — precisely the session that boundary
exists to keep out. So end the session rather than chaining, with the banner that boundary
requires:

```
===============================
Session Boundary — Do Not Carry Into /next
Next: /next, Fresh Session, sonnet/medium
===============================
```

Emit it on every run that got past the hard stop, **including a run that deleted nothing**.
Whether a branch was deleted has no bearing on what the repository owes next, and making the
handoff conditional on a non-empty candidate list is how it silently stops happening.

**Name `/next`, not `/track`.** `/next` reads the repository's actual state and runs whatever is
genuinely owed — which is often `/track`, and is often nothing. Naming `/track` directly is what
made this pair loop: it ran unconditionally, wrote a mirror refresh, opened a pull request for it,
and that merge brought the session straight back here. Two cases do not hand off:

- **`Stopped: true`.** Nothing merged was cleaned up and the unaccounted-for work is the only
  thing to report. Report it and stop.
- **`design/FROZEN.md` exists.** `/track` refuses during a freeze (`AGENTS.md` § *The design
  freeze*), and `/next` has nothing else to route to at that point, so pointing the user at
  either is not a handoff. Say the handoff is held by the freeze and report the marker's
  `Frozen because` and `Lifts when` lines verbatim.

## Never

- Delete a branch `--merged` does not confirm without a separate ask, even if `gh pr list` shows it merged.
- Touch a remote branch. This command prunes local refs to already-deleted remotes; it does not delete anything on `origin` itself.
- Discard uncommitted changes. Stashing is the only concession `-AutoStash` makes, and it is never popped automatically.
- Run `/track` or `/next` in this session. The handoff is a banner, not a chain — the fresh session is the whole point of it (`AGENTS.md`, *Session boundaries*).

## Re-run

Safe to run any time a merge is on the table, including right after a prior run — every list
(`--merged` candidates, `Refused` entries) is recomputed from the tree's current state, and
nothing is cached between runs. A run with nothing newly merged reports an empty candidate
list and deletes nothing; it never re-deletes a branch a prior run already removed.
