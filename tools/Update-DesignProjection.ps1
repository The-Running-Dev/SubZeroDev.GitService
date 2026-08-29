#Requires -Version 7.0
<#
.SYNOPSIS
    The projector: renders design/state/ records into marked regions
    (design/20-contract.md § tools/Update-DesignProjection.ps1).

.DESCRIPTION
    Reads design/state/ via Read-DesignState.ps1 and renders every projection in the minimum
    set (design/20-contract.md § tools/Update-DesignProjection.ps1).

    Seven projections target a marked region in a tracked document and are written there:
    `units`, `bound-by`, `consumers`, `decision-affects`, `question-affects` and `outstanding`
    render into design/state-index.md; `invariants` renders into design/20-contract.md's own
    § Invariants region. `outstanding` renders only `WorkRef` records whose `State` is `OPEN`,
    ordered by `Rank` - it is a projection of the mirror, never a second read of the tracker
    (I14: input is records, never a live gh call). `agent` has no document region - GitHub is
    where an issue's agent block lives, this script never calls `gh`, so `agent` is rendered per
    WorkRef record and returned to the caller only (S7.10).

    Writes only between the markers of a projected region (I18, I29): never a byte outside one,
    never a new region, never a document with no region for the id, and never inside a
    `:declared:` region. A region that is malformed, declared, or simply absent from its target
    document is refused rather than repaired - the caller sees it in `.Refusals` and (on direct
    invocation) as a non-zero exit, which is what makes ProjectorFailed fire honestly instead of
    silently skipping the write.

    Idempotent and order-independent (I25): every projection is computed from records alone and
    never from a document's current region content (I14), so regenerating twice, or in any
    order, produces identical bytes.

.PARAMETER Path
    Repository root. Defaults to the current directory.

.PARAMETER DryRun
    Renders to the success stream (as JSON, one object per region, on direct invocation) and
    writes nothing. This is the checker's entry point.

.EXAMPLE
    pwsh ./tools/Update-DesignProjection.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string] $Path = (Get-Location).Path,
    [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ReaderPath = Join-Path $PSScriptRoot 'Read-DesignState.ps1'
if (-not (Test-Path -LiteralPath $script:ReaderPath)) {
    throw "tools/Read-DesignState.ps1 not found beside tools/Update-DesignProjection.ps1 at $script:ReaderPath"
}
. $script:ReaderPath -Path $Path

# ---------------------------------------------------------------------------------------------
# Rendering. Every function below reads only from $Records (in-memory, from the reader) and
# returns an array of Markdown lines - never a document's own tree copy (I14).
# ---------------------------------------------------------------------------------------------
function Format-IdList {
    param([string[]] $Ids)
    if (-not $Ids -or $Ids.Count -eq 0) { return '—' }
    ($Ids | Sort-Object -Unique | ForEach-Object { "``$_``" }) -join ', '
}

function Get-UnitsProjectionContent {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records)
    $units = @($Records | Where-Object { $_.Kind -eq 'Unit' -and $_.Scalars['Status'] -eq 'active' } | Sort-Object Id)
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('| Id | Kind | Anchor |')
    $lines.Add('|---|---|---|')
    if ($units.Count -eq 0) {
        $lines.Add('| _(no active unit records yet)_ | | |')
    }
    foreach ($u in $units) {
        $lines.Add("| ``$($u.Id)`` | $($u.Scalars['Kind']) | ``$($u.Scalars['Anchor'])`` |")
    }
    ,@($lines)
}

function Get-BoundByProjectionContent {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records)
    $invariants = @($Records | Where-Object { $_.Kind -eq 'Invariant' -and $_.Scalars['Status'] -eq 'active' } | Sort-Object { [int]($_.Id -replace '^I', '') })
    $units = @($Records | Where-Object { $_.Kind -eq 'Unit' })
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('| Invariant | Bound by |')
    $lines.Add('|---|---|')
    if ($invariants.Count -eq 0) {
        $lines.Add('| _(no invariant records yet)_ | |')
    }
    foreach ($inv in $invariants) {
        $binders = @($units | Where-Object { $_.Lists.ContainsKey('Binds') -and $inv.Id -in $_.Lists['Binds'] } | ForEach-Object { $_.Id })
        $lines.Add("| $($inv.Id) | $(Format-IdList -Ids $binders) |")
    }
    ,@($lines)
}

function Get-ConsumersProjectionContent {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records)
    $contracts = @($Records | Where-Object { $_.Kind -eq 'Contract' -and $_.Scalars['Status'] -eq 'active' } | Sort-Object Id)
    $units = @($Records | Where-Object { $_.Kind -eq 'Unit' })
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('| Contract | Consumers |')
    $lines.Add('|---|---|')
    if ($contracts.Count -eq 0) {
        $lines.Add('| _(no contract records yet)_ | |')
    }
    foreach ($c in $contracts) {
        $consumers = @($units | Where-Object { $_.Lists.ContainsKey('Consumes') -and $c.Id -in $_.Lists['Consumes'] } | ForEach-Object { $_.Id })
        $lines.Add("| $($c.Id) | $(Format-IdList -Ids $consumers) |")
    }
    ,@($lines)
}

function Get-DecisionAffectsProjectionContent {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records)
    $decisions = @($Records | Where-Object { $_.Kind -eq 'Decision' } | Sort-Object Id)
    $units = @($Records | Where-Object { $_.Kind -eq 'Unit' })
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('| Decision | In force for |')
    $lines.Add('|---|---|')
    if ($decisions.Count -eq 0) {
        $lines.Add('| _(no decision records yet)_ | |')
    }
    foreach ($d in $decisions) {
        $affects = @($units | Where-Object { $_.Lists.ContainsKey('Live') -and $d.Id -in $_.Lists['Live'] } | ForEach-Object { $_.Id })
        $lines.Add("| $($d.Id) | $(Format-IdList -Ids $affects) |")
    }
    ,@($lines)
}

function Get-QuestionAffectsProjectionContent {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records)
    $questions = @($Records | Where-Object { $_.Kind -eq 'Question' } | Sort-Object Id)
    $units = @($Records | Where-Object { $_.Kind -eq 'Unit' })
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('| Question | Blocks |')
    $lines.Add('|---|---|')
    if ($questions.Count -eq 0) {
        $lines.Add('| _(no question records yet)_ | |')
    }
    foreach ($q in $questions) {
        $affects = @($units | Where-Object { $_.Lists.ContainsKey('Questions') -and $q.Id -in $_.Lists['Questions'] } | ForEach-Object { $_.Id })
        $lines.Add("| $($q.Id) | $(Format-IdList -Ids $affects) |")
    }
    ,@($lines)
}

function Get-InvariantsProjectionContent {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records)
    $invariants = @($Records | Where-Object { $_.Kind -eq 'Invariant' -and $_.Scalars['Status'] -eq 'active' } | Sort-Object { [int]($_.Id -replace '^I', '') })
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('| | Statement | Owner | Enforcement | Evidence |')
    $lines.Add('|---|---|---|---|---|')
    foreach ($inv in $invariants) {
        $statement = ($inv.Prose['Statement'] -replace '\s*\n\s*', ' ').Trim()
        $owner = $inv.Scalars['Owner']
        $enforcement = $inv.Scalars['Enforcement']
        $evidence = @(if ($inv.Lists.ContainsKey('Evidence')) { @($inv.Lists['Evidence'] | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) } else { @() })
        $evidenceCell = if ($evidence.Count -eq 0) { '—' } else { ($evidence -join ', ') }
        $lines.Add("| **$($inv.Id)** | $statement | ``$owner`` | $enforcement | $evidenceCell |")
    }
    ,@($lines)
}

function Get-RankSortKey {
    param([string] $Rank)
    if ($Rank -match '^\d+$') { return [double]$Rank }
    [double]::MaxValue
}

function Get-OutstandingProjectionContent {
    <#
        Renders WorkRef records whose State is OPEN, ordered by Rank - a numeric Rank (project
        position, or a bare issue number) sorts first and low-to-high; a non-numeric Rank
        (`milestone/<n>`) has no board position to compare against a numeric one, so it sorts
        after every numeric Rank and ties are broken by issue number (S14.3 does not promise a
        single total order across sources, only that Rank is never absent).

        A closed WorkRef is not "outstanding work" and is left out here - it stays in
        design/state/work/ as a record, per I16, but this projection only ever renders the
        mirror's live half.
    #>
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records)
    $refs = @($Records | Where-Object { $_.Kind -eq 'WorkRef' -and $_.Scalars['State'] -eq 'OPEN' } |
        Sort-Object -Property @{ Expression = { Get-RankSortKey -Rank $_.Scalars['Rank'] } }, @{ Expression = { [int]$_.Scalars['Issue'] } })
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('| Rank | Issue | Title | Criteria | Mirrored at |')
    $lines.Add('|---|---|---|---|---|')
    if ($refs.Count -eq 0) {
        $lines.Add('| _(no outstanding WorkRef records yet)_ | | | | |')
    }
    foreach ($ref in $refs) {
        $issue = $ref.Scalars['Issue']
        $title = $ref.Scalars['Title']
        $rank = $ref.Scalars['Rank']
        $criteria = @(if ($ref.Lists.ContainsKey('Criteria')) { @($ref.Lists['Criteria'] | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) } else { @() })
        $criteriaCell = if ($criteria.Count -eq 0) { '—' } else { ($criteria -join ', ') }
        $mirroredAt = $ref.Scalars['MirroredAt']
        $lines.Add("| $rank | #$issue | $title | $criteriaCell | ``$mirroredAt`` |")
    }
    ,@($lines)
}

function Get-AgentProjectionContent {
    <#
        S7.10. Renders only what a WorkRef record actually carries - Issue, Title, Criteria,
        MirroredAt. Today's hand-authored agent blocks also carry Depends on, Out of scope and
        Blocked item text that has no field in the WorkRef schema (design/10-design.md § WorkRef);
        this projection does not invent one, so its output is a smaller, honest render rather
        than a full reconstruction of what is on GitHub today.
    #>
    param([Parameter(Mandatory)] $Record)

    $title = $Record.Scalars['Title']
    $sliceId = $null
    if ($title -and $title -match '^\s*(S\d+)\b') { $sliceId = $Matches[1] }

    $lines = [System.Collections.Generic.List[string]]::new()
    if ($sliceId) {
        $lines.Add("Run ``/slice $sliceId``.")
    } else {
        $lines.Add("Run the work item for issue #$($Record.Scalars['Issue']).")
    }
    $lines.Add('')

    $pin = $Record.Scalars['MirroredAt']
    if ($sliceId -and -not [string]::IsNullOrWhiteSpace($pin)) {
        $lines.Add("- **Scope and criteria:** ``design/30-slices.md`` § $sliceId @ ``$pin``")
    }
    $criteria = @(if ($Record.Lists.ContainsKey('Criteria')) { @($Record.Lists['Criteria'] | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) } else { @() })
    if ($criteria.Count -gt 0) {
        $lines.Add("- **Criteria mirrored:** $($criteria -join ', ')")
    }
    $lines.Add('')
    $lines.Add('Stop conditions and procedure: `.claude/commands/slice.md`. Not restated here.')
    ,@($lines)
}

# ---------------------------------------------------------------------------------------------
# Region location. A bare (projected) region is exactly one start marker and one end marker for
# the given id, start before end. A `:declared:` marker for the same id is a refusal (I29): the
# projector never writes inside a declared region. More than one start, more than one end, or an
# end before its start is RegionMalformed - refused, not repaired (S7.7).
# ---------------------------------------------------------------------------------------------
function Find-BareRegion {
    param([Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]] $Lines, [Parameter(Mandatory)][string] $Id)

    $startPattern = "<!-- $Id`:start -->"
    $declaredStartPattern = "<!-- $Id`:declared:start -->"
    $endPattern = "<!-- $Id`:end -->"
    $declaredEndPattern = "<!-- $Id`:declared:end -->"

    $starts = [System.Collections.Generic.List[int]]::new()
    $ends = [System.Collections.Generic.List[int]]::new()
    $declaredHit = $false

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $t = $Lines[$i].Trim()
        if ($t -eq $declaredStartPattern -or $t -eq $declaredEndPattern) { $declaredHit = $true; continue }
        if ($t -eq $startPattern) { $starts.Add($i) }
        if ($t -eq $endPattern) { $ends.Add($i) }
    }

    if ($declaredHit) {
        return [pscustomobject]@{ Found = $false; Refuse = $true; Reason = 'DeclaredRegion'; Detail = "id '$Id' is a declared region; the projector never writes inside one" }
    }
    if ($starts.Count -eq 0 -and $ends.Count -eq 0) {
        return [pscustomobject]@{ Found = $false; Refuse = $false }
    }
    if ($starts.Count -ne 1 -or $ends.Count -ne 1 -or $ends[0] -le $starts[0]) {
        return [pscustomobject]@{ Found = $false; Refuse = $true; Reason = 'RegionMalformed'; Detail = "region '$Id' is unbalanced or nested" }
    }
    [pscustomobject]@{ Found = $true; Refuse = $false; StartIndex = $starts[0]; EndIndex = $ends[0] }
}

function Set-RegionBody {
    param([Parameter(Mandatory)][AllowEmptyString()][string[]] $Lines, [Parameter(Mandatory)][int] $StartIndex, [Parameter(Mandatory)][int] $EndIndex, [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]] $NewBodyLines)
    $before = @($Lines[0..$StartIndex])
    $after = @($Lines[$EndIndex..($Lines.Count - 1)])
    ,@($before + @($NewBodyLines) + $after)
}

# ---------------------------------------------------------------------------------------------
# The main entry point. Groups region targets by document so each document is read once and
# written at most once, in the same pass, per target.
# ---------------------------------------------------------------------------------------------
function Invoke-DesignProjection {
    param([Parameter(Mandatory)][string] $RepoPath, [switch] $DryRun)

    $graph = Read-DesignStateGraph -Path $RepoPath
    $records = @($graph.Records)

    $targets = @(
        [pscustomobject]@{ Id = 'units'; Document = 'design/state-index.md'; Render = { Get-UnitsProjectionContent -Records $records } }
        [pscustomobject]@{ Id = 'bound-by'; Document = 'design/state-index.md'; Render = { Get-BoundByProjectionContent -Records $records } }
        [pscustomobject]@{ Id = 'consumers'; Document = 'design/state-index.md'; Render = { Get-ConsumersProjectionContent -Records $records } }
        [pscustomobject]@{ Id = 'decision-affects'; Document = 'design/state-index.md'; Render = { Get-DecisionAffectsProjectionContent -Records $records } }
        [pscustomobject]@{ Id = 'question-affects'; Document = 'design/state-index.md'; Render = { Get-QuestionAffectsProjectionContent -Records $records } }
        [pscustomobject]@{ Id = 'outstanding'; Document = 'design/state-index.md'; Render = { Get-OutstandingProjectionContent -Records $records } }
        [pscustomobject]@{ Id = 'invariants'; Document = 'design/20-contract.md'; Render = { Get-InvariantsProjectionContent -Records $records } }
    )

    $regions = [System.Collections.Generic.List[object]]::new()
    $refusals = [System.Collections.Generic.List[object]]::new()

    foreach ($doc in @($targets | Select-Object -ExpandProperty Document -Unique)) {
        $full = Join-Path $RepoPath $doc
        $docTargets = @($targets | Where-Object { $_.Document -eq $doc })

        if (-not (Test-Path -LiteralPath $full)) {
            foreach ($t in $docTargets) {
                $refusals.Add([pscustomobject]@{ Document = $doc; Id = $t.Id; Reason = 'DocumentMissing'; Detail = "$doc does not exist" })
            }
            continue
        }

        $lines = @(Get-Content -LiteralPath $full)
        $changed = $false

        foreach ($t in $docTargets) {
            $newBody = & $t.Render
            $loc = Find-BareRegion -Lines $lines -Id $t.Id

            if ($loc.Refuse) {
                $refusals.Add([pscustomobject]@{ Document = $doc; Id = $t.Id; Reason = $loc.Reason; Detail = $loc.Detail })
                continue
            }
            if (-not $loc.Found) {
                $refusals.Add([pscustomobject]@{ Document = $doc; Id = $t.Id; Reason = 'RegionMissing'; Detail = "no '$($t.Id)' region found in $doc" })
                continue
            }

            $regions.Add([pscustomobject]@{ Document = $doc; Id = $t.Id; Content = ($newBody -join "`n") })
            $lines = Set-RegionBody -Lines $lines -StartIndex $loc.StartIndex -EndIndex $loc.EndIndex -NewBodyLines $newBody
            $changed = $true
        }

        if ($changed -and -not $DryRun) {
            $text = (($lines -join "`n") + "`n")
            Set-Content -LiteralPath $full -Value $text -NoNewline -Encoding utf8NoBOM
        }
    }

    foreach ($wr in @($records | Where-Object { $_.Kind -eq 'WorkRef' })) {
        $content = ((Get-AgentProjectionContent -Record $wr) -join "`n")
        $regions.Add([pscustomobject]@{ Document = $null; Id = 'agent'; Subject = $wr.Id; Content = $content })
    }

    [pscustomobject]@{
        Regions   = @($regions)
        Refusals  = @($refusals)
    }
}

# Guards the invocation so this script's tests can dot-source it - the same shape
# Test-DesignState.ps1, Read-DesignState.ps1 and Test-DesignDrift.ps1 already use.
if ($MyInvocation.InvocationName -ne '.') {
    <#
        A -DryRun caller (Test-DesignState.ps1's Invoke-Projector) captures this process's
        stdout over a pipe. PowerShell still encodes pipeline output using
        [Console]::OutputEncoding even when stdout is redirected, and that defaults to the
        OS's OEM code page (ibm437 on this host) rather than UTF-8 - so a non-ASCII byte in a
        rendered region (the em dashes design/20-contract.md renders throughout, a mirrored
        issue title) got best-fit-substituted before it ever left this process, no matter how
        correctly the caller decoded it. Setting this here, once, before the only place this
        script writes to stdout, fixes the write side to match Invoke-GhRaw's read-side fix.
    #>
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $Path = (Resolve-Path -LiteralPath $Path).Path
    $result = Invoke-DesignProjection -RepoPath $Path -DryRun:$DryRun

    if ($DryRun) {
        $result.Regions | ConvertTo-Json -Depth 6
    }
    foreach ($r in $result.Refusals) {
        Write-Warning "Update-DesignProjection: refused '$($r.Id)' in $($r.Document): $($r.Reason) - $($r.Detail)"
    }

    if ($result.Refusals.Count -gt 0) { exit 1 }
    exit 0
}
