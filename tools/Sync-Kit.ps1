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

                                    EXCEPTION: a target synced before #20's fix (a24541e) can
                                    have this row's content mis-decoded, byte for byte, by the
                                    old bug rather than genuinely edited (an em dash becoming
                                    "ΓÇö", for example) - see Test-EncodingCorruptionOf below.
                                    That is not real modification, so it is called out in the
                                    row's Detail either way, and -RepairCorruption takes the
                                    kit's content for it instead of leaving it for /install.

    This is the mechanism that entry recorded as "not yet built." Scope is exactly the two
    directories INSTALL.md calls kit-owned (`.claude/commands/*.md`, `tools/*.ps1`) - every
    other artifact (AGENTS.md, agent.md, design/, .claude/settings.json,
    .github/ISSUE_TEMPLATE/) stays target-wins and stays /install's, per that entry's
    "Narrows" note on 2026-08-02.

    CORE COMMAND FILES ARE THE EXCEPTION TO THE THIRD ROW.

    Per .claude/COMPANIONS.md, a command file is a *core* the consuming repository never edits;
    per-repo behaviour lives in a companion at .claude/commands/<name>-local.md, which the kit
    does not ship and which no path here ever reads, writes or deletes. So for a core the
    third row splits in two:

      companion present    The target has adopted the split, and the companion is where its
                           local content belongs. The core is taken outright and the overwrite
                           is reported as Superseded - never silently, because a core edit
                           made before the companion existed is still real content going away.
      companion absent     The target's edit has not been migrated. Unmigrated-Blocked: left
                           alone, reported, and the fix is to move it into a companion. This is
                           a one-time migration state, not an ongoing reconciliation - once the
                           edit has moved, every later sync takes that core with no pass at all.

    A companion that is missing, empty or frontmatter-only is absent; all three are one case,
    and Test-Companion.ps1 owns that rule rather than this script carrying a second copy of it.

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

.PARAMETER RepairCorruption
    Also take the kit's content for a divergence that exactly matches the encoding
    corruption #20's fix (a24541e) left behind in targets synced before it: a file whose
    on-disk content differs from the recorded blob by nothing more than what git's UTF-8
    output decoded to under some legacy single-byte code page (an em dash becoming
    "ΓÇö", for example). Without this switch such a file is still reported and left alone
    - the detection only narrows what Divergent-Skipped/Unmigrated-Blocked's Detail says,
    it does not change the default of leaving real-looking local content untouched.

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
    [switch] $DryRun,
    [switch] $RepairCorruption
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
    # Without this, .NET picks the OS's OEM code page (e.g. ibm437) instead of the UTF-8
    # git actually writes, so any non-ASCII byte (an em dash, for example) decodes to the
    # wrong character and every comparison below reports a false divergence.
    $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.StandardError.ReadToEnd() | Out-Null
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) {
        return $null
    }
    return $stdout
}

# Windows OEM code pages a target's console could plausibly have had as its default before
# #20's fix (a24541e) - the set Invoke-GitRaw's missing StandardOutputEncoding exposed the
# process to. Not exhaustive of every code page .NET can name, just the ones a real host is
# likely to have had as its OEM default.
$script:LegacyOemCodePages = @(437, 850, 852, 855, 857, 858, 860, 861, 862, 863, 865, 866, 869, 874, 720)

function Test-EncodingCorruptionOf {
    <#
    $true when $Candidate is exactly what you get from mis-decoding $Correct's UTF-8 bytes
    under some single-byte legacy code page - the pattern a24541e's missing
    StandardOutputEncoding baked into target files on disk before that fix landed (an em
    dash becoming "ΓÇö" under code page 437, for example). Identical strings never match
    (nothing to explain), and content that is pure ASCII can never trigger a false positive
    here either - every byte below 0x80 round-trips unchanged through every code page in the
    list, so a real edit confined to ASCII cannot masquerade as this corruption.
    #>
    param([string] $Correct, [string] $Candidate)
    if ($Correct -ceq $Candidate) { return $false }
    $utf8Bytes = [System.Text.Encoding]::UTF8.GetBytes($Correct)
    foreach ($codePage in $script:LegacyOemCodePages) {
        $legacyEncoding = $null
        try { $legacyEncoding = [System.Text.Encoding]::GetEncoding($codePage) } catch { continue }
        if ($legacyEncoding.GetString($utf8Bytes) -ceq $Candidate) { return $true }
    }
    return $false
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

# Test-CompanionAbsent is COMPANIONS.md's *Absence* rule in code - missing, empty and
# frontmatter-only as one case. Dot-sourced rather than reimplemented: two copies of that rule
# would diverge, and the divergence would be invisible because both would still return $true
# for the common case. The guard in that script means dot-sourcing defines its functions
# without running its body or exiting.
#
# Dot-sourcing also re-runs the other script's `param()` block in *this* scope, so any
# parameter the two share is silently reset to the other script's default - and both of them
# quite reasonably call their input -TargetRepo. Snapshot this script's own parameters across
# the call. The list is explicit rather than derived so that a parameter added to either script
# later is a visible edit here, not a silent overwrite; Sync-Kit.Tests.ps1 guards it either way.
$companionScript = Join-Path $PSScriptRoot 'Test-Companion.ps1'
if (-not (Test-Path -LiteralPath $companionScript)) {
    throw "'$companionScript' is missing. It owns the companion-absence rule this script needs; both ship together as kit-owned files in tools/."
}
$ownParams = @{}
foreach ($name in @('TargetRepo', 'KitRoot', 'RecordedSha', 'Force', 'IncludeUnchanged', 'DryRun', 'RepairCorruption')) {
    $ownParams[$name] = (Get-Variable -Name $name -ValueOnly)
}
. $companionScript
foreach ($name in $ownParams.Keys) {
    Set-Variable -Name $name -Value $ownParams[$name]
}

function Test-CoreCommandPath {
    param([string]$RelPath)
    $p = $RelPath -replace '\\', '/'
    return ($p -like '.claude/commands/*.md') -and ($p -notlike '*-local.md')
}

function Get-CompanionPathFor {
    param([string]$RelPath)
    $p = $RelPath -replace '\\', '/'
    return ($p -replace '\.md$', '-local.md')
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

# `.claude/COMPANIONS.md` is a path rather than a directory; `git ls-tree -r -- <path>` treats
# both the same way. It is kit-owned for the same reason the two directories are: it is the
# mechanism, and COMPANIONS.md § *Never* forbids a companion from changing it, so there is no
# per-repo variant of it to protect.
$kitOwnedDirs = @('.claude/commands', 'tools', '.claude/COMPANIONS.md')

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

    # $targetContent preserves whatever line endings are on disk (CRLF under
    # core.autocrlf=true); $recordedContent is the git blob, normally LF-only. Normalise
    # both before comparing so a target that never touched the file's content - just
    # checked it out with CRLF - isn't reported as a local edit.
    $targetContentNormalized = if ($null -ne $targetContent) { $targetContent -replace "`r`n", "`n" } else { $targetContent }
    $recordedContentNormalized = if ($null -ne $recordedContent) { $recordedContent -replace "`r`n", "`n" } else { $recordedContent }

    $targetMatchesRecorded = ($targetExists -eq $recordedExists) -and ($targetContentNormalized -ceq $recordedContentNormalized)

    $isCore = Test-CoreCommandPath -RelPath $relPath
    $companionPresent = $isCore -and -not (Test-CompanionAbsent -Path (Join-Path $targetRepoResolved (Get-CompanionPathFor -RelPath $relPath)))
    $supersede = $false

    # Only a real target-vs-recorded divergence with both blobs present can be this pattern -
    # a brand-new or upstream-deleted path has nothing recorded to have been corrupted from.
    $isEncodingCorruption = (-not $targetMatchesRecorded) -and $recordedExists -and $targetExists -and
        (Test-EncodingCorruptionOf -Correct $recordedContentNormalized -Candidate $targetContentNormalized)
    $repairingCorruption = $isEncodingCorruption -and $RepairCorruption
    $corruptionNote = if ($isEncodingCorruption) {
        " Matches the pre-#20 (a24541e) encoding-corruption pattern baked in by writes under the old bug, not a genuine edit - re-run with -RepairCorruption to take the kit's content."
    } else { '' }

    if (-not $targetMatchesRecorded -and -not $repairingCorruption) {
        if (-not $recordedExists -and $targetExists) {
            # New-to-the-kit path, but the target already has an unrelated file there. Tested
            # before the core branches below: a same-named file the kit never installed is not
            # an unmigrated edit to a core, it is a different file that happens to collide.
            $report.Add((New-SyncReport $relPath 'Collision-Skipped' 'Target has an unrelated file at this new kit path.'))
            continue
        }
        if (-not $isCore) {
            $report.Add((New-SyncReport $relPath 'Divergent-Skipped' "Target modified this file locally; never merged.$corruptionNote"))
            continue
        }
        if (-not $companionPresent) {
            $report.Add((New-SyncReport $relPath 'Unmigrated-Blocked' "Target edited this core and has no $(Get-CompanionPathFor -RelPath $relPath). Move the edit there, then re-sync.$corruptionNote"))
            continue
        }
        # Companion present: the split is adopted here, so the core is the kit's outright. Falls
        # through to the write below rather than skipping, reported as Superseded so an
        # overwritten core edit is never lost silently.
        $supersede = $true
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

    $verb = if ($repairingCorruption) { 'RepairedCorruption' } elseif ($supersede) { 'Superseded' } elseif ($targetExists) { 'Updated' } else { 'Added' }
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
$unmigratedCount = @($report | Where-Object Status -eq 'Unmigrated-Blocked').Count
if ($unmigratedCount -gt 0) {
    Write-Host "$unmigratedCount core command file(s) carry local edits with no companion beside them - see .claude/COMPANIONS.md. Move each edit into .claude/commands/<name>-local.md and re-run; nothing was overwritten."
}
$supersededCount = @($report | Where-Object { $_.Status -in @('Superseded', 'WouldSuperseded') }).Count
if ($supersededCount -gt 0) {
    Write-Host "$supersededCount core command file(s) had local edits overwritten by the kit's copy because a companion exists for them - the companion is where per-repo content belongs, and was not touched."
}
$removedCount = @($report | Where-Object Status -eq 'RemovedUpstream-Skipped').Count
if ($removedCount -gt 0) {
    Write-Host "$removedCount file(s) were removed upstream but left in place - re-run with -Force to delete them."
}
$repairedCount = @($report | Where-Object { $_.Status -in @('RepairedCorruption', 'WouldRepairedCorruption') }).Count
if ($repairedCount -gt 0) {
    Write-Host "$repairedCount file(s) had pre-#20 encoding corruption repaired with the kit's correct content."
}

if ($advanceKitJson -and -not $DryRun -and $headSha -ne $RecordedSha) {
    $kitJson | Add-Member -NotePropertyName syncedCommit -NotePropertyValue $headSha -Force
    ($kitJson | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $kitJsonPath -NoNewline
}

$report
