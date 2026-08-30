#Requires -Version 7.0
<#
.SYNOPSIS
    The mechanical half of /clean (.claude/commands/clean.md): switch to the default branch,
    prune stale remote-tracking refs, and report which local branches are safe to delete.

.DESCRIPTION
    Everything clean.md does before its "Ask, once" step is a fact-gathering and
    non-destructive git sequence with no judgement call in it - is the tree dirty, what is
    the default branch, does the current branch have unmerged commits, which local branches
    does `--merged` confirm, and (cross-checked via `gh`) which of the rest merged by squash.
    That is exactly the kind of repeated, mechanical scan AGENTS.md's own model-work table
    calls out as not needing a model call at all, which is why /clean is routed `sonnet/medium`
    rather than higher - this script removes even that call for the part that never needed
    judgement.

    Deletion is the one step this script will not decide on its own. Called with no
    -DeleteBranches, it only switches, prunes, and reports candidates - nothing is deleted.
    AGENTS.md's *Git and delivery* is explicit that deleting a branch is not carved out of
    the authorization rule, so the actual delete list has to come from the one-time chat
    approval clean.md's "Ask, once" step gets - this script executes that approved list, it
    does not produce it.

.PARAMETER RepoRoot
    Repository to operate on. Defaults to the current directory.

.PARAMETER DefaultBranch
    Override the default branch instead of resolving it from `git remote show origin`.

.PARAMETER SkipPull
    Check out the default branch without pulling. For environments with no network access
    to the remote, or for testing against a local-only fixture.

.PARAMETER DeleteBranches
    Branch names to delete with `git branch -d` (never `-D`) after everything else has run.
    Only ever the branches named here - never inferred, never "everything --merged found."

.PARAMETER ForceDeleteBranches
    Branch names to delete with `git branch -D` after everything else has run. Only ever
    honoured for a branch this same run independently confirmed in SquashMergeCandidates,
    which now requires the local tip to equal the merged PR's headRefOid - a branch carrying
    commits the merged PR does not account for lands in TipAheadOfMergedPr instead and is
    never force-deleted. Only ever
    i.e. `--merged` did not see it, but `gh` found a merged PR whose head was this branch.
    A name not in that list is refused, never force-deleted, even if passed here.

.PARAMETER AutoStash
    Instead of stopping on a dirty tree, run `git stash push -u` and continue. The stash is
    never popped by this script - it is left on the stash list and reported back
    (StashRef), so the caller can restore it explicitly rather than having it silently
    reappear on whatever branch happens to be checked out next.

.EXAMPLE
    ./tools/Invoke-DoneHousekeeping.ps1
    Switch, prune, and report candidates. Deletes nothing.

.EXAMPLE
    ./tools/Invoke-DoneHousekeeping.ps1 -DeleteBranches 'feature/foo','fix/bar'
    Also delete these two branches, once approval for exactly this list has been given.

.EXAMPLE
    ./tools/Invoke-DoneHousekeeping.ps1 -SkipPull -ForceDeleteBranches 'fix/squashed'
    Force-delete a branch this run's own gh check found squash-merged in
    SquashMergeCandidates - a list whose entries have each had their local tip confirmed
    equal to the head the PR merged, which is the evidence that replaced the confirmation
    prompt this list used to require.
#>
[CmdletBinding()]
param(
    [string] $RepoRoot = (Get-Location).Path,
    [string] $DefaultBranch,
    [switch] $SkipPull,
    [string[]] $DeleteBranches = @(),
    [string[]] $ForceDeleteBranches = @(),
    [switch] $AutoStash
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RepoRoot)) {
    throw "RepoRoot '$RepoRoot' does not exist."
}
$repoRootResolved = (Resolve-Path -LiteralPath $RepoRoot).Path

function Invoke-Git {
    param([string[]]$GitArgs, [string]$WorkingDir)
    $out = & git -C $WorkingDir @GitArgs 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
}

function Get-WorktreeBlockingPath {
    # `git branch -d` refuses a branch checked out in another worktree with
    # "cannot delete branch '<name>' used by worktree at '<path>'" - distinct from
    # refusing an unmerged branch, and the remedy (`git worktree remove <path>`) is
    # different too, so callers need the path, not just a generic failure.
    param([string]$GitOutput)
    if ($GitOutput -match "used by worktree at '([^']+)'") {
        return $Matches[1]
    }
    return $null
}

$stashed = $false
$stashRef = $null

$statusResult = Invoke-Git -GitArgs @('status', '--short') -WorkingDir $repoRootResolved
if ($statusResult.Output.Trim()) {
    if (-not $AutoStash) {
        [pscustomobject]@{
            Stopped        = $true
            Reason         = 'DirtyTree'
            Detail         = $statusResult.Output
            DefaultBranch  = $null
            Pulled         = $false
            PrunedCount    = 0
            Candidates     = @()
            SquashMergeCandidates = @()
            TipAheadOfMergedPr    = @()
            Deleted        = @()
            Refused        = @()
            Stashed        = $false
            StashRef       = $null
        }
        return
    }
    $stashResult = Invoke-Git -GitArgs @('stash', 'push', '-u', '-m', 'Invoke-DoneHousekeeping auto-stash') -WorkingDir $repoRootResolved
    if ($stashResult.ExitCode -ne 0) {
        throw "AutoStash was requested but 'git stash push -u' failed: $($stashResult.Output)"
    }
    $stashed = $true
    $stashRef = 'stash@{0}'
}

if (-not $DefaultBranch) {
    $remoteInfo = Invoke-Git -GitArgs @('remote', 'show', 'origin') -WorkingDir $repoRootResolved
    $headLine = ($remoteInfo.Output -split "`n") | Where-Object { $_ -match 'HEAD branch:\s*(\S+)' }
    if ($headLine -and $headLine -match 'HEAD branch:\s*(\S+)' -and $Matches[1] -ne '(unknown)') {
        $DefaultBranch = $Matches[1]
    } else {
        # '(unknown)' is a real git state, not merely an absent line - it means the
        # remote's own HEAD symref was never set (common on a hand-created bare repo;
        # GitHub always sets it). Either way there is no default to trust silently.
        throw "Could not resolve the default branch from 'git remote show origin' (reported '(unknown)' or no HEAD branch line). Pass -DefaultBranch explicitly."
    }
}

$currentBranch = (Invoke-Git -GitArgs @('branch', '--show-current') -WorkingDir $repoRootResolved).Output.Trim()

if ($currentBranch -and $currentBranch -ne $DefaultBranch) {
    $unmerged = Invoke-Git -GitArgs @('log', "$DefaultBranch..HEAD", '--oneline') -WorkingDir $repoRootResolved
    if ($unmerged.Output.Trim()) {
        # Unmerged relative to a genuine three-dot merge check does not by itself mean
        # abandoned work - a squash-merged PR looks identical to git. Cross-check gh before
        # trusting this as a stop condition.
        $prCheck = & gh pr list --state merged --head $currentBranch --json number,url 2>$null
        $mergedPr = $null
        if ($LASTEXITCODE -eq 0 -and $prCheck) {
            $parsed = $prCheck | ConvertFrom-Json
            if (@($parsed).Count -gt 0) { $mergedPr = $parsed[0] }
        }
        if (-not $mergedPr) {
            [pscustomobject]@{
                Stopped        = $true
                Reason         = 'UnmergedCurrentBranch'
                Detail         = "Branch '$currentBranch' has commits not on '$DefaultBranch' and no merged PR was found for it via gh."
                DefaultBranch  = $DefaultBranch
                Pulled         = $false
                PrunedCount    = 0
                Candidates     = @()
                SquashMergeCandidates = @()
                TipAheadOfMergedPr    = @()
                Deleted        = @()
                Refused        = @()
                Stashed        = $stashed
                StashRef       = $stashRef
            }
            return
        }
    }
}

Invoke-Git -GitArgs @('checkout', $DefaultBranch) -WorkingDir $repoRootResolved | Out-Null
$pulled = $false
if (-not $SkipPull) {
    $pullResult = Invoke-Git -GitArgs @('pull') -WorkingDir $repoRootResolved
    $pulled = ($pullResult.ExitCode -eq 0)
}

$pruneResult = Invoke-Git -GitArgs @('fetch', '--prune', 'origin') -WorkingDir $repoRootResolved
$prunedLines = @(($pruneResult.Output -split "`n") | Where-Object { $_ -match '\[deleted\]' })

# `git branch --merged` prefixes the current branch with "* " and any branch checked
# out in another worktree with "+ " - the latter survived a TrimStart('*', ' ') that
# only stripped the former. for-each-ref has no decoration to strip in the first place.
$mergedResult = Invoke-Git -GitArgs @('for-each-ref', '--format=%(refname:short)', "--merged=$DefaultBranch", 'refs/heads') -WorkingDir $repoRootResolved
$mergedBranches = @(($mergedResult.Output -split "`n") |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and $_ -ne $DefaultBranch })

$candidates = [System.Collections.Generic.List[object]]::new()
foreach ($branch in $mergedBranches) {
    $prInfo = $null
    $prCheck = & gh pr list --state merged --head $branch --json number,url 2>$null
    if ($LASTEXITCODE -eq 0 -and $prCheck) {
        $parsed = @($prCheck | ConvertFrom-Json)
        if ($parsed.Count -gt 0) { $prInfo = $parsed[0].url }
    }
    $candidates.Add([pscustomobject]@{ Branch = $branch; MergedPr = $prInfo })
}

# `--merged` can never see a squash-merge - GitHub's squash produces a new commit on
# the default branch that shares no history with the branch tip, so the branch looks
# permanently unmerged to git even though it is done. Cross-check every local branch
# --merged did NOT confirm against gh, the same way the unmerged-current-branch check
# above already does, so a squash-merged branch is surfaced automatically instead of
# depending on the caller happening to already know about it.
$allBranchesResult = Invoke-Git -GitArgs @('for-each-ref', '--format=%(refname:short)', 'refs/heads') -WorkingDir $repoRootResolved
$allBranches = @(($allBranchesResult.Output -split "`n") |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and $_ -ne $DefaultBranch -and $mergedBranches -notcontains $_ })

# A merged PR alone is NOT sufficient evidence to force-delete. `gh pr list --head <branch>`
# matches on branch NAME, so it still reports the PR after commits have been pushed on top of
# the merged tip - and -D on that branch discards those commits with nothing said. Compare the
# local tip against the PR's own headRefOid and only list a branch whose tip is exactly what
# merged. A tip that does not match is reported separately as TipAheadOfMergedPr, never as a
# force-delete candidate; that comparison is what replaced the confirmation prompt this list
# used to require.
$squashMergeCandidates = [System.Collections.Generic.List[object]]::new()
$tipAheadOfMergedPr = [System.Collections.Generic.List[object]]::new()
foreach ($branch in $allBranches) {
    $prCheck = & gh pr list --state merged --head $branch --json number,url,mergeCommit,headRefOid 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $prCheck) { continue }
    $parsed = @($prCheck | ConvertFrom-Json)
    if ($parsed.Count -eq 0) { continue }

    $tipResult = Invoke-Git -GitArgs @('rev-parse', $branch) -WorkingDir $repoRootResolved
    $localTip = if ($tipResult.ExitCode -eq 0) { ($tipResult.Output -split "`n")[0].Trim() } else { $null }
    $mergedHead = $parsed[0].headRefOid

    if (-not $localTip -or -not $mergedHead -or $localTip -ne $mergedHead) {
        $tipAheadOfMergedPr.Add([pscustomobject]@{
            Branch     = $branch
            MergedPr   = $parsed[0].url
            LocalTip   = $localTip
            MergedHead = $mergedHead
            Reason     = if (-not $mergedHead) {
                "PR $($parsed[0].url) reported no headRefOid - cannot confirm the local tip is what merged."
            } elseif (-not $localTip) {
                "Could not resolve the local tip of '$branch' - cannot confirm it is what merged."
            } else {
                "Local tip $localTip is not the head that merged in $($parsed[0].url) ($mergedHead) - commits exist on this branch that no merged PR accounts for."
            }
        })
        continue
    }

    $squashMergeCandidates.Add([pscustomobject]@{
        Branch     = $branch
        MergedPr   = $parsed[0].url
        MergedHead = $mergedHead
    })
}

$deleted = [System.Collections.Generic.List[object]]::new()
$refused = [System.Collections.Generic.List[object]]::new()
foreach ($branch in $DeleteBranches) {
    if ($mergedBranches -notcontains $branch) {
        $refused.Add([pscustomobject]@{ Branch = $branch; Reason = "Not in --merged '$DefaultBranch' - not deleted." })
        continue
    }
    $deleteResult = Invoke-Git -GitArgs @('branch', '-d', $branch) -WorkingDir $repoRootResolved
    if ($deleteResult.ExitCode -eq 0) {
        $deleted.Add($branch)
    } else {
        $blockingPath = Get-WorktreeBlockingPath -GitOutput $deleteResult.Output
        if ($blockingPath) {
            $refused.Add([pscustomobject]@{
                Branch = $branch
                Reason = "Checked out in another worktree at '$blockingPath' - run 'git worktree remove $blockingPath' first, not deleted."
            })
        } else {
            $refused.Add([pscustomobject]@{ Branch = $branch; Reason = $deleteResult.Output })
        }
    }
}

# Force-delete is only ever honoured for a branch this same run independently found
# in SquashMergeCandidates - never for an arbitrary name the caller passes, even one
# that really is merged, because that confirmation has to come from this run's own
# gh check, not from the caller's say-so.
$squashMergeBranchNames = @($squashMergeCandidates | ForEach-Object { $_.Branch })
foreach ($branch in $ForceDeleteBranches) {
    if ($squashMergeBranchNames -notcontains $branch) {
        $refused.Add([pscustomobject]@{ Branch = $branch; Reason = "Not in this run's SquashMergeCandidates - not force-deleted." })
        continue
    }
    $deleteResult = Invoke-Git -GitArgs @('branch', '-D', $branch) -WorkingDir $repoRootResolved
    if ($deleteResult.ExitCode -eq 0) {
        $deleted.Add($branch)
    } else {
        $blockingPath = Get-WorktreeBlockingPath -GitOutput $deleteResult.Output
        if ($blockingPath) {
            $refused.Add([pscustomobject]@{
                Branch = $branch
                Reason = "Checked out in another worktree at '$blockingPath' - run 'git worktree remove $blockingPath' first, not deleted."
            })
        } else {
            $refused.Add([pscustomobject]@{ Branch = $branch; Reason = $deleteResult.Output })
        }
    }
}

[pscustomobject]@{
    Stopped        = $false
    Reason         = $null
    Detail         = $null
    DefaultBranch  = $DefaultBranch
    Pulled         = $pulled
    PrunedCount    = $prunedLines.Count
    Candidates     = $candidates
    SquashMergeCandidates = @($squashMergeCandidates)
    TipAheadOfMergedPr    = @($tipAheadOfMergedPr)
    Deleted        = @($deleted)
    Refused        = @($refused)
    Stashed        = $stashed
    StashRef       = $stashRef
}
