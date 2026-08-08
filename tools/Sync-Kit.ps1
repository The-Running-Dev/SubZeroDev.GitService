#Requires -Version 7.0
<#
.SYNOPSIS
    Syncs the kit-owned files (.claude/commands/*.md, tools/*.ps1) into a target repository
    by diffing against the sha the target was installed from, without reading any of them.

.DESCRIPTION
    Per design/90-decisions.md (2026-08-05, "Kit-owned files sync by git diff against the
    recorded install sha"): .claude/kit.json already records the kit sha a target was
    installed from, and that sha is a merge base, so a three-way comparison exists in every
    target already and needs no new machinery. Git is used as a diff engine, not as transport
    - nothing is cloned into the target, no submodule, no subtree.

    For every kit-owned path (present at the kit's current HEAD, or at the recorded sha, or
    both), three git blobs decide the outcome:

      recorded  = blob at <recorded-sha> (what the target was given)
      head      = blob at kit HEAD (what the kit has now)
      target    = the file currently on disk in the target

    recorded -eq head            No upstream change. Nothing to do, regardless of target.
    target -eq recorded          Target never touched this file locally -> safe to take head.
                                    head present  -> write it (Added / Updated)
                                    head absent   -> upstream deleted it; delete target's copy
                                                      only with -Force (RemovedUpstream)
    target -ne recorded          Target has local content this script did not put there.
                                    Reported and left alone, never merged (Divergent /
                                    Collision). This is real modification and it is
                                    /install's job to reconcile it by hand, not this script's.

    This is the mechanism that entry recorded as "not yet built." Scope is exactly the two
    directories INSTALL.md calls kit-owned (`.claude/commands/*.md`, `tools/*.ps1`) - every
    other artifact (AGENTS.md, agent.md, design/, .claude/settings.json,
    .github/ISSUE_TEMPLATE/) stays target-wins and stays /install's, per that entry's
    "Narrows" note on 2026-08-02.

.PARAMETER TargetRepo
    Repository to sync into. Defaults to the current directory.

.PARAMETER KitRoot
    Path to the kit checkout to diff against. Defaults to this script's own repository if
    it is running from inside the kit, otherwise ~/.agent-kit (the location /kit-sync
    maintains).

.PARAMETER RecordedSha
    The sha to diff from. Defaults to the target's `.claude/kit.json`: its `syncedCommit`
    field if present (the sha this script last synced kit-owned files from), else its
    `commit` field (the sha /install last reconciled the whole kit from). Required one way
    or the other - there is no safe default merge base without it.

    On success, this script writes its own progress back as `syncedCommit` - never
    `commit`, which stays /install's field and means "the whole kit is reconciled as of
    this sha," a claim this script (scoped to two directories) has no basis to make.

.PARAMETER Force
    Also apply RemovedUpstream deletions. Without it they are reported and left in place -
    deleting a file the target still has a use for is not this script's call to make alone.

.PARAMETER IncludeUnchanged
    Include NoUpstreamChange rows in the printed report. Suppressed by default since on a
    healthy repeat sync that is most of the file list.

.PARAMETER DryRun
    Compute and print the same report without writing anything - no file update, no
    deletion, no kit.json advance. INSTALL.md's phase 1-2 write nothing until phase 3
    sign-off; this is what a command following that procedure calls during classification,
    then calls again without -DryRun in phase 4 once approved.

.EXAMPLE
    ./tools/Sync-Kit.ps1
    Sync the current repository's kit-owned files against its recorded install sha.

.EXAMPLE
    ./tools/Sync-Kit.ps1 -TargetRepo D:\Projects\Some.Repo -Force
    Sync another repository and also apply any upstream file removals.
#>
[CmdletBinding()]
param(
    [string] $TargetRepo = (Get-Location).Path,
    [string] $KitRoot,
    [string] $RecordedSha,
    [switch] $Force,
    [switch] $IncludeUnchanged,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-KitRoot {
    param([string] $Explicit)

    if ($Explicit) {
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $selfHosted = Split-Path -Parent $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $selfHosted '.git')) {
        return $selfHosted
    }

    $synced = Join-Path $HOME '.agent-kit'
    if (Test-Path -LiteralPath (Join-Path $synced '.git')) {
        return $synced
    }

    throw "Could not find a kit checkout under '$selfHosted' or '$synced'. Pass -KitRoot explicitly."
}

function Invoke-GitRaw {
    <#
    Runs git and returns raw stdout text via StreamReader, bypassing PowerShell's
    native-command capture - which splits output into lines and rejoins them, silently
    dropping the exact trailing-newline byte a git blob and an on-disk file must agree on
    for the content comparisons below to mean anything.
    #>
    param([string[]]$GitArgs, [string]$WorkingDir)
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'git'
    $psi.WorkingDirectory = $WorkingDir
    foreach ($a in $GitArgs) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.StandardError.ReadToEnd() | Out-Null
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) {
        return $null
    }
    return $stdout
}

function Get-GitOutput {
    param([string[]]$GitArgs, [string]$WorkingDir)
    $raw = Invoke-GitRaw -GitArgs $GitArgs -WorkingDir $WorkingDir
    if ($null -eq $raw) { return $null }
    return $raw.Trim()
}

function Test-GitPathExists {
    param([string]$Sha, [string]$Path, [string]$WorkingDir)
    & git -C $WorkingDir cat-file -e "${Sha}:${Path}" 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Test-GitRefExists {
    param([string]$Sha, [string]$WorkingDir)
    & git -C $WorkingDir cat-file -e $Sha 2>$null
    return ($LASTEXITCODE -eq 0)
}

$kitRootResolved = Resolve-KitRoot -Explicit $KitRoot
if (-not (Test-Path -LiteralPath (Join-Path $kitRootResolved '.git'))) {
    throw "'$kitRootResolved' is not a git checkout - Sync-Kit.ps1 diffs against git history, it cannot run against a plain copy."
}

if (-not (Test-Path -LiteralPath $TargetRepo)) {
    throw "TargetRepo '$TargetRepo' does not exist."
}
$targetRepoResolved = (Resolve-Path -LiteralPath $TargetRepo).Path

$kitJsonPath = Join-Path $targetRepoResolved '.claude/kit.json'
$advanceKitJson = $false
if (-not $RecordedSha) {
    if (-not (Test-Path -LiteralPath $kitJsonPath)) {
        throw "No -RecordedSha given and '$kitJsonPath' does not exist. This target has never had the kit installed - run /install first."
    }
    $kitJson = Get-Content -LiteralPath $kitJsonPath -Raw | ConvertFrom-Json
    if ($kitJson.PSObject.Properties.Name -contains 'syncedCommit' -and $kitJson.syncedCommit) {
        $RecordedSha = $kitJson.syncedCommit
    } elseif ($kitJson.commit) {
        $RecordedSha = $kitJson.commit
    } else {
        throw "'$kitJsonPath' has neither 'syncedCommit' nor 'commit' to diff from."
    }
    # Only advance kit.json when its own recorded sha was the baseline - an explicit
    # -RecordedSha is the caller's own comparison and not this script's baseline to move.
    $advanceKitJson = $true
}

$headSha = (Get-GitOutput -GitArgs @('rev-parse', 'HEAD') -WorkingDir $kitRootResolved)
if (-not $headSha) {
    throw "Could not resolve HEAD in '$kitRootResolved'."
}
if (-not (Test-GitRefExists -Sha $RecordedSha -WorkingDir $kitRootResolved)) {
    throw "Recorded sha '$RecordedSha' is not reachable in '$kitRootResolved'. Fetch it, or pass -KitRoot at a checkout that has it."
}

$kitOwnedDirs = @('.claude/commands', 'tools')

function Get-TreePaths {
    param([string]$Sha, [string[]]$Dirs, [string]$WorkingDir)
    $paths = [System.Collections.Generic.List[string]]::new()
    foreach ($dir in $Dirs) {
        $listing = & git -C $WorkingDir ls-tree -r --name-only $Sha -- $dir 2>$null
        if ($LASTEXITCODE -eq 0 -and $listing) {
            foreach ($line in $listing) { $paths.Add($line) }
        }
    }
    return $paths
}

$headPaths = @(Get-TreePaths -Sha $headSha -Dirs $kitOwnedDirs -WorkingDir $kitRootResolved)
$recordedPaths = @(Get-TreePaths -Sha $RecordedSha -Dirs $kitOwnedDirs -WorkingDir $kitRootResolved)
$scopePaths = [System.Collections.Generic.List[string]]::new()
$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($p in ($headPaths + $recordedPaths)) {
    if ($seen.Add($p)) { $scopePaths.Add($p) }
}

function New-SyncReport {
    param([string]$Path, [string]$Status, [string]$Detail = '')
    [pscustomobject]@{ Path = $Path; Status = $Status; Detail = $Detail }
}

$report = [System.Collections.Generic.List[object]]::new()

foreach ($relPath in ($scopePaths | Sort-Object)) {
    $headExists = Test-GitPathExists -Sha $headSha -Path $relPath -WorkingDir $kitRootResolved
    $recordedExists = Test-GitPathExists -Sha $RecordedSha -Path $relPath -WorkingDir $kitRootResolved

    $headContent = if ($headExists) { Invoke-GitRaw -GitArgs @('show', "${headSha}:${relPath}") -WorkingDir $kitRootResolved } else { $null }
    $recordedContent = if ($recordedExists) { Invoke-GitRaw -GitArgs @('show', "${RecordedSha}:${relPath}") -WorkingDir $kitRootResolved } else { $null }

    if ($headExists -eq $recordedExists -and $headContent -ceq $recordedContent) {
        if ($IncludeUnchanged) { $report.Add((New-SyncReport $relPath 'NoUpstreamChange')) }
        continue
    }

    $targetPath = Join-Path $targetRepoResolved $relPath
    $targetExists = Test-Path -LiteralPath $targetPath
    $targetContent = if ($targetExists) { Get-Content -LiteralPath $targetPath -Raw } else { $null }

    $targetMatchesRecorded = ($targetExists -eq $recordedExists) -and ($targetContent -ceq $recordedContent)

    if (-not $targetMatchesRecorded) {
        if (-not $recordedExists -and $targetExists) {
            # New-to-the-kit path, but the target already has an unrelated file there.
            $report.Add((New-SyncReport $relPath 'Collision-Skipped' 'Target has an unrelated file at this new kit path.'))
        } else {
            $report.Add((New-SyncReport $relPath 'Divergent-Skipped' 'Target modified this file locally; never merged.'))
        }
        continue
    }

    if (-not $headExists) {
        if ($Force) {
            $status = if ($DryRun) { 'RemovedUpstream-WouldDelete' } else { 'RemovedUpstream-Deleted' }
            if (-not $DryRun) { Remove-Item -LiteralPath $targetPath -Force }
            $report.Add((New-SyncReport $relPath $status))
        } else {
            $report.Add((New-SyncReport $relPath 'RemovedUpstream-Skipped' 'Kit removed this file; re-run with -Force to delete it here too.'))
        }
        continue
    }

    $verb = if ($targetExists) { 'Updated' } else { 'Added' }
    $status = if ($DryRun) { "Would$verb" } else { $verb }
    if (-not $DryRun) {
        $parent = Split-Path -Parent $targetPath
        if (-not (Test-Path -LiteralPath $parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        Set-Content -LiteralPath $targetPath -Value $headContent -NoNewline
    }
    $report.Add((New-SyncReport $relPath $status))
}

if ($DryRun) { Write-Host "DRY RUN - nothing below was written." }

$visible = @(if ($IncludeUnchanged) { $report } else { $report | Where-Object Status -ne 'NoUpstreamChange' })
if ($visible.Count -gt 0) {
    $visible | Format-Table -AutoSize | Out-String | Write-Host
} else {
    Write-Host "No kit-owned files changed upstream since $RecordedSha - nothing to sync."
}

$divergentCount = @($report | Where-Object { $_.Status -in @('Divergent-Skipped', 'Collision-Skipped') }).Count
if ($divergentCount -gt 0) {
    Write-Host "$divergentCount file(s) diverged locally and were left alone - hand these to /install for judgment."
}
$removedCount = @($report | Where-Object Status -eq 'RemovedUpstream-Skipped').Count
if ($removedCount -gt 0) {
    Write-Host "$removedCount file(s) were removed upstream but left in place - re-run with -Force to delete them."
}

if ($advanceKitJson -and -not $DryRun -and $headSha -ne $RecordedSha) {
    $kitJson | Add-Member -NotePropertyName syncedCommit -NotePropertyValue $headSha -Force
    ($kitJson | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $kitJsonPath -NoNewline
}

$report
