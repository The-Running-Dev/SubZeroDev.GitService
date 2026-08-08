#Requires -Version 7.0
<#
.SYNOPSIS
    The mechanical half of /done (.claude/commands/done.md): switch to the default branch,
    prune stale remote-tracking refs, and report which local branches are safe to delete.

.DESCRIPTION
    Everything done.md does before its "Ask, once" step is a fact-gathering and
    non-destructive git sequence with no judgement call in it - is the tree dirty, what is
    the default branch, does the current branch have unmerged commits, which local branches
    does `--merged` confirm, and (cross-checked via `gh`) which of the rest merged by squash.
    That is exactly the kind of repeated, mechanical scan AGENTS.md's own model-work table
    calls out as not needing a model call at all, which is why /done is routed `haiku/low`
    rather than higher - this script removes even that call for the part that never needed
    judgement.

    Deletion is the one step this script will not decide on its own. Called with no
    -DeleteBranches, it only switches, prunes, and reports candidates - nothing is deleted.
    AGENTS.md's *Git and delivery* is explicit that deleting a branch is not carved out of
    the authorization rule, so the actual delete list has to come from the one-time chat
    approval done.md's "Ask, once" step gets - this script executes that approved list, it
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

.EXAMPLE
    ./tools/Invoke-DoneHousekeeping.ps1
    Switch, prune, and report candidates. Deletes nothing.

.EXAMPLE
    ./tools/Invoke-DoneHousekeeping.ps1 -DeleteBranches 'feature/foo','fix/bar'
    Also delete these two branches, once approval for exactly this list has been given.
#>
[CmdletBinding()]
param(
    [string] $RepoRoot = (Get-Location).Path,
    [string] $DefaultBranch,
    [switch] $SkipPull,
    [string[]] $DeleteBranches = @()
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

$statusResult = Invoke-Git -GitArgs @('status', '--short') -WorkingDir $repoRootResolved
if ($statusResult.Output.Trim()) {
    [pscustomobject]@{
        Stopped        = $true
        Reason         = 'DirtyTree'
        Detail         = $statusResult.Output
        DefaultBranch  = $null
        Pulled         = $false
        PrunedCount    = 0
        Candidates     = @()
        Deleted        = @()
        Refused        = @()
    }
    return
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
                Deleted        = @()
                Refused        = @()
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

$mergedResult = Invoke-Git -GitArgs @('branch', '--merged', $DefaultBranch) -WorkingDir $repoRootResolved
$mergedBranches = @(($mergedResult.Output -split "`n") |
    ForEach-Object { $_.TrimStart('*', ' ') } |
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
        $refused.Add([pscustomobject]@{ Branch = $branch; Reason = $deleteResult.Output })
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
    Deleted        = @($deleted)
    Refused        = @($refused)
}
