#Requires -Version 7.0
<#
.SYNOPSIS
    The mirror generator: refreshes WorkRef records from the tracker
    (design/20-contract.md § tools/Update-WorkMirror.ps1).

.DESCRIPTION
    Writes design/state/work/<issue>.md records and nothing else - never an issue, never a
    label, never a milestone, never git (S14.1). `/track`'s alone; no other command invokes it
    and no other command writes a WorkRef.

    One WorkRef per currently-open issue. `Rank` degrades rather than failing: the issue's
    position in the per-repository GitHub Project when one places it, otherwise its milestone
    number, otherwise the issue number itself - falling through is not a finding, and an
    emitted WorkRef never lacks a Rank (S14.3). `Criteria` is read from `- [ ] **<id>**`
    checkbox lines in the issue body, the same shape every issue template in this kit uses; an
    issue with none yields an empty list, not an absent field.

    A record is written only when a mirrored field - `Title`, `State`, `Rank`, or `Criteria` -
    changed since the last write; `MirroredAt` is not itself a mirrored field and never triggers
    a write by itself (S14.2). `MirroredAt` is stamped with the current commit on every write
    that does happen - that stamp is the mirror's only claim to currency, and
    Test-DesignState.ps1's MirrorStale class is what a stale one costs (S14.7).

    Two ways this run does not touch the mirror at all: `design/FROZEN.md` present (S14.5,
    because `/track` does not run during a freeze either), and `gh` missing or unauthenticated
    (S14.4) - the second is could-not-evaluate, and never an empty mirror standing in for one
    that could not be read.

.PARAMETER RepoPath
    Repository root. Defaults to the current directory.

.PARAMETER Repository
    owner/repo. Defaults to the current git remote, via gh's own resolution.

.EXAMPLE
    pwsh ./tools/Update-WorkMirror.ps1
#>
[CmdletBinding()]
param(
    [string] $RepoPath = (Get-Location).Path,
    [string] $Repository
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Both gh-dependent helpers below read a native command's *exit code* as part of their answer,
# which $PSNativeCommandUseErrorActionPreference = $true (the 7.3+ default) would turn into a
# terminating error under Stop. Test-DesignDrift.ps1 and Test-DesignState.ps1 both assign this
# for the same reason; assigning it is inert on versions that predate the preference.
$PSNativeCommandUseErrorActionPreference = $false

function New-WorkMirrorFailure {
    param([Parameter(Mandatory)][string] $Reason, [Parameter(Mandatory)][string] $Detail)
    [pscustomobject]@{ Reason = $Reason; Detail = $Detail }
}

function New-WorkMirrorResult {
    param(
        [Parameter(Mandatory)][string]   $State,
        [object[]] $Written = @(),
        [object[]] $CouldNotEvaluate = @()
    )
    [pscustomobject]@{
        State            = $State
        Written          = @($Written)
        CouldNotEvaluate = @($CouldNotEvaluate)
    }
}

<#
    Every checkbox under a "Done when" section in an issue template carries its id as the
    entire bolded lead of the line - `- [ ] **S14.1** ...` - regardless of the id's own scheme
    (slice criteria, or anything a future template invents). A bug or story issue with no ids
    yields an empty list, which is the grammar's own distinction between "empty" and "absent"
    (design/20-contract.md § The state set) - this always emits the field, never omits it.
#>
function Get-IssueCriteriaIds {
    param([string] $Body)
    if ([string]::IsNullOrWhiteSpace($Body)) { return @() }

    $ids = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($Body -split "`r?`n")) {
        if ($line -match '^\s*-\s*\[[ xX]\]\s*\*\*([^\*]+)\*\*') {
            $ids.Add($Matches[1].Trim())
        }
    }
    @($ids)
}

function Invoke-GhRaw {
    <#
        gh writes UTF-8. PowerShell's native-command capture (`& gh @args`) decodes that
        stdout using [Console]::OutputEncoding, which on a Windows host - this CI runner
        included - defaults to the OEM code page (ibm437) rather than UTF-8. A non-ASCII
        byte in an issue title (an em dash, a section mark) then decodes to the wrong
        character and gets baked into the WorkRef record on disk - the same class of bug
        Sync-Kit.ps1's Invoke-GitRaw fixed for git's output (#20), never applied to gh.
        Routing through ProcessStartInfo with an explicit UTF-8 StandardOutputEncoding
        sidesteps the console entirely.
    #>
    param([string[]] $GhArgs)
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'gh'
    foreach ($a in $GhArgs) { $psi.ArgumentList.Add($a) }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.StandardError.ReadToEnd() | Out-Null
    $proc.WaitForExit()
    [pscustomobject]@{ Output = $stdout; ExitCode = $proc.ExitCode }
}

function Get-OpenIssueList {
    param([string] $Repository)

    $ghArgs = @('issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,state,body,milestone')
    if ($Repository) { $ghArgs += @('-R', $Repository) }

    try {
        $result = Invoke-GhRaw -GhArgs $ghArgs
        if ($result.ExitCode -ne 0) {
            return [pscustomobject]@{ Issues = @(); Failure = (New-WorkMirrorFailure -Reason 'GhUnavailable' -Detail "gh exited $($result.ExitCode)") }
        }
        $json = $result.Output
    } catch {
        return [pscustomobject]@{ Issues = @(); Failure = (New-WorkMirrorFailure -Reason 'GhUnavailable' -Detail $_.Exception.Message) }
    }

    if ([string]::IsNullOrWhiteSpace($json)) {
        return [pscustomobject]@{ Issues = @(); Failure = $null }
    }

    try {
        $parsed = $json | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{ Issues = @(); Failure = (New-WorkMirrorFailure -Reason 'TrackerUnreadable' -Detail $_.Exception.Message) }
    }

    [pscustomobject]@{ Issues = @($parsed); Failure = $null }
}

<#
    Best-effort only, per the same convention track.md already states for the `project` scope:
    a repository with no matching project, or a `gh project` call that fails for any reason
    (missing scope among them), is not a could-not-evaluate here - it is the ordinary case that
    sends Rank to the next tier down (S14.3). Returns $null on any of those; a hashtable of
    issue number -> 1-based board position otherwise.
#>
function Get-ProjectItemPositions {
    param([Parameter(Mandatory)][string] $Owner, [Parameter(Mandatory)][string] $RepoName)

    try {
        $projResult = Invoke-GhRaw -GhArgs @('project', 'list', '--owner', $Owner, '--format', 'json')
        if ($projResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($projResult.Output)) { return $null }
        $projects = $projResult.Output | ConvertFrom-Json
    } catch {
        return $null
    }

    $project = @($projects.projects) | Where-Object { $_.title -eq $RepoName } | Select-Object -First 1
    if (-not $project) { return $null }

    try {
        $itemsResult = Invoke-GhRaw -GhArgs @('project', 'item-list', "$($project.number)", '--owner', $Owner, '--format', 'json')
        if ($itemsResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($itemsResult.Output)) { return $null }
        $items = $itemsResult.Output | ConvertFrom-Json
    } catch {
        return $null
    }

    $positions = @{}
    $rank = 1
    foreach ($item in @($items.items)) {
        if ($item.content -and $item.content.number) {
            $positions[[int]$item.content.number] = $rank
        }
        $rank++
    }
    $positions
}

function Get-CurrentRepoOwnerName {
    param([string] $Repository)

    if ($Repository -and $Repository.Contains('/')) {
        $parts = $Repository -split '/', 2
        return [pscustomobject]@{ Owner = $parts[0]; Name = $parts[1] }
    }

    try {
        $result = Invoke-GhRaw -GhArgs @('repo', 'view', '--json', 'owner,name')
        if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Output)) { return $null }
        $parsed = $result.Output | ConvertFrom-Json
    } catch {
        return $null
    }
    if (-not $parsed.owner -or -not $parsed.owner.login) { return $null }
    [pscustomobject]@{ Owner = $parsed.owner.login; Name = $parsed.name }
}

function Get-IssueRank {
    param([Parameter(Mandatory)] $Issue, $ProjectPositions)

    if ($ProjectPositions -and $ProjectPositions.ContainsKey([int]$Issue.number)) {
        return "$($ProjectPositions[[int]$Issue.number])"
    }
    if ($Issue.milestone -and $Issue.milestone.number) {
        return "milestone/$($Issue.milestone.number)"
    }
    return "$($Issue.number)"
}

function Get-CurrentWorkMirrorSha {
    param([Parameter(Mandatory)][string] $RepoPath)
    try {
        Push-Location $RepoPath
        $sha = (& git rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -ne 0) { return $null }
        return $sha.Trim()
    } finally {
        Pop-Location
    }
}

function ConvertTo-WorkRefLines {
    param([Parameter(Mandatory)] $Issue, [Parameter(Mandatory)][string] $Rank, [Parameter(Mandatory)][string] $Sha)

    $criteria = Get-IssueCriteriaIds -Body $Issue.body
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("# work/$($Issue.number)")
    $lines.Add("Issue: $($Issue.number)")
    $lines.Add("Title: $($Issue.title)")
    $lines.Add("State: $($Issue.state)")
    $lines.Add("Rank: $Rank")
    $lines.Add("MirroredAt: $Sha")
    $lines.Add("Criteria: $($criteria -join ', ')")
    ,@($lines)
}

<#
    Title, State, Rank and Criteria are the mirrored fields (contract/update-workmirror §
    Semantics) - MirroredAt is deliberately excluded, since it is what this comparison decides
    whether to restamp in the first place. Returns $null for a record that does not exist yet,
    which never compares equal to a real one.
#>
function Read-ExistingWorkRefFields {
    param([Parameter(Mandatory)][string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }

    $fields = @{}
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        if ($line -match '^(Title|State|Rank|Criteria):\s?(.*)$') {
            $fields[$Matches[1]] = $Matches[2]
        }
    }
    $fields
}

function Test-WorkRefFieldsChanged {
    param([hashtable] $Existing, [Parameter(Mandatory)] $Issue, [Parameter(Mandatory)][string] $Rank, [Parameter(Mandatory)][AllowEmptyCollection()][string[]] $Criteria)

    if (-not $Existing) { return $true }
    if ($Existing['Title'] -ne $Issue.title) { return $true }
    if ($Existing['State'] -ne $Issue.state) { return $true }
    if ($Existing['Rank'] -ne $Rank) { return $true }
    if ($Existing['Criteria'] -ne ($Criteria -join ', ')) { return $true }
    return $false
}

<#
    The main entry point. RepoPath scopes both the freeze check and where records land;
    Repository (owner/repo) is passed through to gh exactly as Test-DesignDrift.ps1 does, and
    left empty to let gh resolve the current remote itself.
#>
function Invoke-WorkMirrorUpdate {
    param([Parameter(Mandatory)][string] $RepoPath, [string] $Repository)

    $frozenMarker = Join-Path $RepoPath 'design/FROZEN.md'
    if (Test-Path -LiteralPath $frozenMarker) {
        return New-WorkMirrorResult -State 'Frozen'
    }

    $issueList = Get-OpenIssueList -Repository $Repository
    if ($issueList.Failure) {
        return New-WorkMirrorResult -State 'NotEvaluated' -CouldNotEvaluate @($issueList.Failure)
    }

    $sha = Get-CurrentWorkMirrorSha -RepoPath $RepoPath
    if (-not $sha) {
        return New-WorkMirrorResult -State 'NotEvaluated' -CouldNotEvaluate @((New-WorkMirrorFailure -Reason 'ShallowCheckout' -Detail 'no history to resolve HEAD'))
    }

    $repoInfo = Get-CurrentRepoOwnerName -Repository $Repository
    $projectPositions = if ($repoInfo) { Get-ProjectItemPositions -Owner $repoInfo.Owner -RepoName $repoInfo.Name } else { $null }

    $workDir = Join-Path $RepoPath 'design/state/work'

    $written = [System.Collections.Generic.List[object]]::new()
    foreach ($issue in $issueList.Issues) {
        $rank = Get-IssueRank -Issue $issue -ProjectPositions $projectPositions
        $criteria = Get-IssueCriteriaIds -Body $issue.body
        $file = Join-Path $workDir "$($issue.number).md"
        $existing = Read-ExistingWorkRefFields -Path $file
        if (-not (Test-WorkRefFieldsChanged -Existing $existing -Issue $issue -Rank $rank -Criteria @($criteria))) {
            continue
        }

        if (-not (Test-Path -LiteralPath $workDir)) {
            New-Item -ItemType Directory -Path $workDir -Force | Out-Null
        }
        $lines = ConvertTo-WorkRefLines -Issue $issue -Rank $rank -Sha $sha
        $text = (($lines -join "`n") + "`n")
        Set-Content -LiteralPath $file -Value $text -NoNewline -Encoding utf8NoBOM
        $written.Add([pscustomobject]@{ Id = "work/$($issue.number)"; Path = $file })
    }

    New-WorkMirrorResult -State 'Clean' -Written @($written)
}

# Guards the invocation so this script's tests can dot-source it - the same shape
# Test-DesignState.ps1, Read-DesignState.ps1 and Test-DesignDrift.ps1 already use.
if ($MyInvocation.InvocationName -ne '.') {
    $RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path
    $result = Invoke-WorkMirrorUpdate -RepoPath $RepoPath -Repository $Repository

    switch ($result.State) {
        'Frozen'       { Write-Host "design/FROZEN.md is present; the mirror is not refreshed." }
        'NotEvaluated' { foreach ($f in $result.CouldNotEvaluate) { Write-Warning "Update-WorkMirror: $($f.Reason) - $($f.Detail)" } }
        'Clean'        { Write-Host "Wrote $($result.Written.Count) WorkRef record(s)." }
    }

    $result
    if ($result.State -eq 'NotEvaluated') { exit 2 }
    exit 0
}
