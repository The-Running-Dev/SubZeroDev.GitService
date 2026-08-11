---
description: Switch back to the default branch, delete local branches already merged into it, and prune stale remote-tracking refs
---

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

It runs `git branch -d`, never `-D`, and only on the names you pass — a name that is not in `--merged`'s list is refused, not deleted, even if you pass it. Proceed straight to this call; do not stop and wait for a chat confirmation first — the candidate list itself is the authorization, since every entry on it is independently `--merged`-confirmed, not inferred. **`Refused` entries where `--merged` did confirm the branch** are `-d`'s own safety refusal (typically unmerged-relative-to-upstream in a way `--merged` didn't catch); those are outside this carve-out — report them and ask separately, one at a time, before ever running `-D` on a specific branch. Never escalate to a force delete without that separate ask.

## Report

Report after acting, not before — this is a summary of what happened, not a request for permission:

- Default branch confirmed and checked out
- Remote-tracking refs pruned, and how many (`PrunedCount`)
- A stash made and how to restore it, if `Stashed: true`
- Branches deleted, and the PR each merged through where known (`Deleted`)
- Any branch left alone, and why — unmerged work, or a `-d` refusal not separately authorized (`Refused`)

## Never

- Delete a branch `--merged` does not confirm without a separate ask, even if `gh pr list` shows it merged.
- Touch a remote branch. This command prunes local refs to already-deleted remotes; it does not delete anything on `origin` itself.
- Discard uncommitted changes. Stashing is the only concession `-AutoStash` makes, and it is never popped automatically.
