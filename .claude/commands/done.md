---
description: Switch back to the default branch, delete local branches already merged into it, and prune stale remote-tracking refs
---

Housekeeping for the end of a piece of work: get back to the default branch, remove the local branches that are done, and drop remote-tracking refs for branches deleted on the remote.

**Deleting a branch is not carved out of the authorization rule** (`AGENTS.md`, *Git and delivery* — "Do not delete files, branches, or history without explicit authorization"). This command lists every candidate before deleting any of it and asks once, over the whole list — it does not delete branch-by-branch.

## Run the mechanical half

Everything up through building the candidate list has no judgement call in it — dirty-tree check, default-branch resolution, the unmerged-current-branch check, the switch, the prune, `--merged`, and the `gh` cross-check for squash-merges are all facts, not decisions. `tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo>` does all of it in one call and deletes nothing:

```powershell
tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo>
```

- **`Stopped: true`** means it refused to switch at all — `Reason` is `DirtyTree` (uncommitted work; not this command's to stash or discard) or `UnmergedCurrentBranch` (the current branch has commits not on the default branch and no merged PR accounts for them, checked via `gh pr list --state merged --head <branch>`). Report `Detail` and stop; do not proceed past either.
- **Otherwise** it has already checked out `DefaultBranch`, pulled (unless it failed), pruned remote-tracking refs (`PrunedCount`), and built `Candidates` — every branch `--merged <default>` confirms, each with its `MergedPr` where `gh` found one. **`--merged` is a genuine merge check**, so a squash-merged branch (GitHub's squash produces a new commit `--merged` cannot see as "the same") will not appear here even though `gh` shows it merged — if you know of one, name it in the ask below anyway with the PR link, same as any other candidate.

## Ask, once

Present the full candidate list — branch name and, where known, the PR it merged through — and ask once whether to delete all of them. Do not ask per-branch.

## Delete

On yes, call the same script again with the approved list:

```powershell
tools/Invoke-DoneHousekeeping.ps1 -RepoRoot <repo> -SkipPull -DeleteBranches <branch1>,<branch2>
```

It runs `git branch -d`, never `-D`, and only on the names you pass — a name that is not in `--merged`'s list is refused, not deleted, even if you pass it. **`Refused` entries where `--merged` did confirm the branch** are `-d`'s own safety refusal; report those and ask separately before manually running `-D` on that specific branch — do not silently escalate to a force delete.

## Report

- Default branch confirmed and checked out
- Remote-tracking refs pruned, and how many (`PrunedCount`)
- Branches deleted, and the PR each merged through where known (`Deleted`)
- Any branch left alone, and why — dirty tree, unmerged work, or a `-d` refusal not separately authorized (`Refused`)

## Never

- Delete a branch `--merged` does not confirm without a separate ask, even if `gh pr list` shows it merged.
- Touch a remote branch. This command prunes local refs to already-deleted remotes; it does not delete anything on `origin` itself.
- Discard uncommitted changes to force the branch switch.
