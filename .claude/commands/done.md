---
description: Switch back to the default branch, delete local branches already merged into it, and prune stale remote-tracking refs
---

<!-- companion:start -->
**Per-repo companion:** `.claude/commands/done-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `extra-steps`, `tightened-authorization`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:end -->

Housekeeping for the end of a piece of work: get back to the default branch, remove the local branches that are done, and drop remote-tracking refs for branches deleted on the remote.

**Branch deletion here is carved out of the authorization rule** (`AGENTS.md`, *Git and delivery*) — but only for branches this command independently confirms via `git branch --merged`. It runs automatically, without waiting to be asked, and does not block on a confirmation prompt for that list.

## Run automatically, don't wait to be asked

Run this command's housekeeping as soon as a merge is on the table — either because a PR was just merged in this session (e.g. as `/pr`'s or `/resolve`'s outcome), or because a `git log` / `gh pr list` check surfaces a branch that merged some other way. Don't wait for the user to type `/done`.

## Run the mechanical half

Everything through building the candidate list has no judgement call in it — dirty-tree check, default-branch resolution, the unmerged-current-branch check, the switch, the prune, `--merged`, and the `gh` cross-check for squash-merges are all facts, not decisions. `tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo> -AutoStash` does all of it in one call and deletes nothing:

```powershell
tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo> -AutoStash
```

- **`Stopped: true`** means it refused to switch at all — the only remaining `Reason` is `UnmergedCurrentBranch` (the current branch has commits not on the default branch and no merged PR accounts for them, checked via `gh pr list --state merged --head <branch>`). Report `Detail` and stop; this is real unaccounted-for work and stays a hard stop, not something to guess past.
- **`-AutoStash`** means a dirty tree no longer stops the run: the script runs `git stash push -u` first (never a discard) and reports `Stashed: true` / `StashRef`. **Always report the stash** so it doesn't get silently lost on whatever branch is checked out next — tell the user a stash was made and how to get it back (`git stash pop`, or `git stash apply stash@{0}` if something else has since been stashed on top).
- **Otherwise** it has already checked out `DefaultBranch`, pulled (unless it failed), pruned remote-tracking refs (`PrunedCount`), and built `Candidates` — every branch `--merged <default>` confirms, each with its `MergedPr` where `gh` found one. **`--merged` is a genuine merge check**, so a squash-merged branch (GitHub's squash produces a new commit `--merged` cannot see as "the same") will not appear here even though `gh` shows it merged — if you know of one, name it when deleting anyway, with the PR link, same as any other candidate.

## Delete the confirmed candidates — don't block on a prompt

Call the same script again, passing every candidate `--merged` confirmed:

```powershell
tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo> -SkipPull -DeleteBranches <branch1>,<branch2>
```

### Gates for automatic deletion

A branch is deleted without a chat confirmation only if **both** named gates pass. Uncertainty on either one counts as failure — it moves the branch out of the automatic path, not into it:

| Gate | What it checks | Failure means |
|---|---|---|
| **Merged** | `git branch --merged <default>` lists the branch (`$mergedBranches` in the script) | Not a candidate at all — `gh pr list` showing it merged (e.g. by squash) does not satisfy this gate; report and ask separately |
| **SafeDelete** | `git branch -d` (never `-D`) exits 0 | The branch is a confirmed candidate but git itself refuses the delete (typically unmerged-relative-to-upstream in a way `--merged` didn't catch) |

Proceed straight to the delete call; do not stop and wait for a chat confirmation first — the candidate list itself is the authorization, since every entry on it independently passed **Merged**. A name that is not in `--merged`'s list fails **Merged** and is refused, not deleted, even if you pass it.

**When a gate fails, name it.** The script's `Refused` entries already carry the failing reason (`$refused` in the script) — report each one as `<branch>: failed <gate name> — <Reason text>`, not just "left alone" or "delegation didn't apply". A **SafeDelete** failure is outside this carve-out — report it and ask separately, one at a time, before ever running `-D` on that branch. Never escalate to a force delete without that separate ask.

## Report

Report after acting, not before — this is a summary of what happened, not a request for permission:

- Default branch confirmed and checked out
- Remote-tracking refs pruned, and how many (`PrunedCount`)
- A stash made and how to restore it, if `Stashed: true`
- Branches deleted, and the PR each merged through where known (`Deleted`)
- Any branch left alone, and which named gate it failed — **Merged** or **SafeDelete** (`Refused`), or unmerged work that stopped the run before candidates were even built

## Never

- Delete a branch `--merged` does not confirm without a separate ask, even if `gh pr list` shows it merged.
- Touch a remote branch. This command prunes local refs to already-deleted remotes; it does not delete anything on `origin` itself.
- Discard uncommitted changes. Stashing is the only concession `-AutoStash` makes, and it is never popped automatically.

## Re-run

Safe to run any time a merge is on the table, including right after a prior run — every list
(`--merged` candidates, `Refused` entries) is recomputed from the tree's current state, and
nothing is cached between runs. A run with nothing newly merged reports an empty candidate
list and deletes nothing; it never re-deletes a branch a prior run already removed.
