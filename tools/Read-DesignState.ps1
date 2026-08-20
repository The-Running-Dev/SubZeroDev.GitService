#Requires -Version 7.0
<#
.SYNOPSIS
    Reads design/state/ into a graph. Never throws, never writes, never skips a line.

.DESCRIPTION
    The state set (design/20-contract.md § Persisted schemas) is constrained Markdown: one
    record per file, an H1 naming the id, scalar and list fields as colon lines, prose fields
    as `## Field` sections. This is the one place that grammar is read. A line matching no
    production is a parse failure (I24) - reported with its file, line number, and verbatim
    text - never dropped and never a terminating error, because a caller that got an exception
    would lose every record that did parse, which is the part a report is made of.

    A record's kind - Unit, Invariant, Contract, Decision, Question, WorkRef - is read from
    which directory under design/state/ the file lives in, per the id-to-path table in
    design/20-contract.md. Each kind has its own closed field vocabulary; a name outside it -
    including the derived-edge names Consumers, BoundBy and Affects (I17) - matches no
    production and is reported the same as any other unrecognised line.

    A record's own H1 id is taken literally, even when it disagrees with the id the file's path
    implies (S4.7) - the graph carries both, because the path is already in memory and the
    id-to-path mapping recovers the path-implied id from it without a second read. Which of the
    two is wrong is the graph validator's call, not the reader's.

    Reads only. Writes nothing, ever (I18). An absent design/state/ is a graph with an empty
    Root and zero records, not an error - deciding what absence means belongs to the checker,
    not the reader.

.PARAMETER Path
    Repository root. design/state/ is resolved beneath it. Defaults to the current directory.

.EXAMPLE
    ./tools/Read-DesignState.ps1

.EXAMPLE
    $graph = . ./tools/Read-DesignState.ps1 -Path 'unused'; Read-DesignStateGraph -Path $repo
#>
[CmdletBinding()]
param(
    [string] $Path = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-DesignRecord {
    param(
        [Parameter(Mandatory)][string]   $Id,
        [Parameter(Mandatory)][string]   $Kind,
        [Parameter(Mandatory)][string]   $Path,
        [Parameter(Mandatory)][hashtable] $Scalars,
        [Parameter(Mandatory)][hashtable] $Lists,
        [Parameter(Mandatory)][hashtable] $Prose
    )
    [pscustomobject]@{
        Id      = $Id
        Kind    = $Kind
        Path    = $Path
        Scalars = $Scalars
        Lists   = $Lists
        Prose   = $Prose
    }
}

function New-DesignStateGraph {
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]       $Root,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Records,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]] $Failures
    )
    [pscustomobject]@{
        Root     = $Root
        Records  = @($Records)
        Failures = @($Failures)
    }
}

function New-DesignStateFailure {
    param(
        [Parameter(Mandatory)][string] $Reason,
        [Parameter(Mandatory)][string] $Path,
        [int]    $Line,
        [string] $Text
    )
    [pscustomobject]@{
        Reason = $Reason
        Path   = $Path
        Line   = $Line
        Text   = $Text
    }
}

<#
    One closed vocabulary per top-level kind, built from design/10-design.md § Data model. An
    Invariant record specialises the Unit fields on the same record (design/20-contract.md,
    "A unit of kind invariant is one record, not two"), so its table is the Unit table plus
    Owner, Enforcement and Statement rather than a fresh one.

    Consumers, BoundBy and Affects are deliberately absent from every table - they are derived
    reverse edges and design/10-design.md is explicit that writing one is forbidden (I17). Their
    absence here, not a denylist checked separately, is what makes them fail the same way any
    other unrecognised field would.
#>
$script:FieldTables = @{
    Unit      = @{
        Scalar = @('Kind', 'Status', 'Anchor')
        List   = @('Consumes', 'Exposes', 'Binds', 'Live', 'Archival', 'Questions', 'Work', 'Evidence')
        Prose  = @('Owns')
    }
    Invariant = @{
        Scalar = @('Kind', 'Status', 'Anchor', 'Owner', 'Enforcement')
        List   = @('Consumes', 'Exposes', 'Binds', 'Live', 'Archival', 'Questions', 'Work', 'Evidence')
        Prose  = @('Statement')
    }
    Contract  = @{
        Scalar = @('Status', 'Owner', 'Declaration')
        List   = @()
        Prose  = @('Semantics')
    }
    Decision  = @{
        Scalar = @('Date', 'Anchor', 'Status', 'SupersededBy')
        List   = @()
        Prose  = @('Claim')
    }
    Question  = @{
        Scalar = @('Status', 'AnsweredBy')
        List   = @()
        Prose  = @('Text')
    }
    WorkRef   = @{
        Scalar = @('Issue', 'Title', 'State', 'Rank', 'MirroredAt')
        List   = @('Criteria')
        Prose  = @()
    }
}

<#
    Maps a file's path relative to design/state/ to its top-level kind and the id its path
    implies, per the table in design/20-contract.md § Persisted schemas. Returns $null for a
    location the table does not name - the caller reports that as a parse failure rather than
    guessing a kind for it.
#>
function Get-DesignPathInfo {
    param([Parameter(Mandatory)][string] $RelativeToState)

    $parts = @($RelativeToState -split '[\\/]')
    switch ($parts[0]) {
        'units' {
            if ($parts.Count -ne 3) { return $null }
            [pscustomobject]@{ Kind = 'Unit'; PathId = "unit/$($parts[1])/$([IO.Path]::GetFileNameWithoutExtension($parts[2]))" }
        }
        'invariants' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'Invariant'; PathId = [IO.Path]::GetFileNameWithoutExtension($parts[1]) }
        }
        'contracts' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'Contract'; PathId = "contract/$([IO.Path]::GetFileNameWithoutExtension($parts[1]))" }
        }
        'decisions' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'Decision'; PathId = "decision/$([IO.Path]::GetFileNameWithoutExtension($parts[1]))" }
        }
        'questions' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'Question'; PathId = "question/$([IO.Path]::GetFileNameWithoutExtension($parts[1]))" }
        }
        'work' {
            if ($parts.Count -ne 2) { return $null }
            [pscustomobject]@{ Kind = 'WorkRef'; PathId = "work/$([IO.Path]::GetFileNameWithoutExtension($parts[1]))" }
        }
        default { $null }
    }
}

<#
    Parses one record file. Returns @{ Record = <record-or-$null>; Failures = <failure[]> }.

    Two passes over "no valid production": if the first non-blank line is not a well-formed H1,
    nothing in the file can be attributed to a record - there is no id to build one under - so
    every non-blank line is reported and no Record is returned (S4.2's "every line malformed"
    shape). Once the H1 parses, every remaining line is matched against the field grammar for
    this file's kind and reported individually on failure; the record built from what did parse
    is still returned, because a malformed line elsewhere must not cost the ones that were fine.
#>
function Read-DesignRecordFile {
    param(
        [Parameter(Mandatory)][string] $FullPath,
        [Parameter(Mandatory)][string] $RelativePath,
        [Parameter(Mandatory)][string] $Kind
    )

    $failures = [System.Collections.Generic.List[object]]::new()
    $lines = @(Get-Content -LiteralPath $FullPath)
    $table = $script:FieldTables[$Kind]

    function Test-KnownField {
        param([string] $Name)
        $table.Scalar -contains $Name -or $table.List -contains $Name -or $table.Prose -contains $Name
    }

    # Find the first non-blank line and test it as the H1 production.
    $firstIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if (-not [string]::IsNullOrWhiteSpace($lines[$i])) { $firstIndex = $i; break }
    }

    if ($firstIndex -lt 0) {
        # An empty (or all-blank) file names no id and carries no content to report as a failure.
        return @{ Record = $null; Failures = @() }
    }

    $id = $null
    if ($lines[$firstIndex] -match '^#\s+(\S+)\s*$') {
        $id = $Matches[1]
    }

    if (-not $id) {
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ([string]::IsNullOrWhiteSpace($lines[$i])) { continue }
            $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line ($i + 1) -Text $lines[$i]))
        }
        return @{ Record = $null; Failures = @($failures) }
    }

    $scalars = @{}
    $lists = @{}
    $prose = @{}
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $pastFirstHash = $false
    $currentProseField = $null
    $proseBody = [System.Collections.Generic.List[string]]::new()

    function Close-ProseSection {
        if ($currentProseField) {
            $prose[$currentProseField] = ($proseBody -join "`n").TrimEnd()
        }
    }

    for ($i = $firstIndex + 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $lineNumber = $i + 1

        if (-not $pastFirstHash) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }

            if ($line -match '^##\s+(\S+)\s*$') {
                $name = $Matches[1]
                $pastFirstHash = $true
                if (-not ($table.Prose -contains $name)) {
                    $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                    $currentProseField = $null
                    continue
                }
                if ($seen.Contains($name)) {
                    $failures.Add((New-DesignStateFailure -Reason 'DuplicateField' -Path $RelativePath -Line $lineNumber -Text $line))
                    $currentProseField = $null
                    continue
                }
                [void]$seen.Add($name)
                $currentProseField = $name
                $proseBody = [System.Collections.Generic.List[string]]::new()
                continue
            }

            if ($line -match '^([A-Za-z]+):(.*)$') {
                $name = $Matches[1]
                $value = $Matches[2].TrimStart()

                if (-not (Test-KnownField -Name $name)) {
                    $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                    continue
                }
                if ($seen.Contains($name)) {
                    $failures.Add((New-DesignStateFailure -Reason 'DuplicateField' -Path $RelativePath -Line $lineNumber -Text $line))
                    continue
                }
                if ($table.Prose -contains $name) {
                    # A prose field written as a colon line is not the `## Field` production.
                    $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                    continue
                }

                [void]$seen.Add($name)
                if ($table.List -contains $name) {
                    $lists[$name] = if ([string]::IsNullOrWhiteSpace($value)) { @() } else { @($value -split ',' | ForEach-Object { $_.Trim() }) }
                }
                else {
                    $scalars[$name] = $value
                }
                continue
            }

            $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
            continue
        }

        # Past the first `##`: only a new `## Field` header re-enters field territory. Anything
        # else is prose body, except a line that reuses a known field name in colon form - that
        # is a field line arriving too late (S4.8), not a coincidence of free Markdown.
        if ($line -match '^##\s+(\S+)\s*$') {
            Close-ProseSection
            $name = $Matches[1]
            if (-not ($table.Prose -contains $name)) {
                $failures.Add((New-DesignStateFailure -Reason 'Unparseable' -Path $RelativePath -Line $lineNumber -Text $line))
                $currentProseField = $null
                continue
            }
            if ($seen.Contains($name)) {
                $failures.Add((New-DesignStateFailure -Reason 'DuplicateField' -Path $RelativePath -Line $lineNumber -Text $line))
                $currentProseField = $null
                continue
            }
            [void]$seen.Add($name)
            $currentProseField = $name
            $proseBody = [System.Collections.Generic.List[string]]::new()
            continue
        }

        if ($line -match '^([A-Za-z]+):(.*)$' -and (Test-KnownField -Name $Matches[1])) {
            $failures.Add((New-DesignStateFailure -Reason 'LateField' -Path $RelativePath -Line $lineNumber -Text $line))
            continue
        }

        if ($currentProseField) { $proseBody.Add($line) }
    }
    Close-ProseSection

    $record = New-DesignRecord -Id $id -Kind $Kind -Path $RelativePath -Scalars $scalars -Lists $lists -Prose $prose
    @{ Record = $record; Failures = @($failures) }
}

function Read-DesignStateGraph {
    param([Parameter(Mandatory)][string] $Path)

    $stateDir = Join-Path $Path 'design/state'
    if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) {
        return New-DesignStateGraph -Root '' -Records @() -Failures @()
    }

    $records = [System.Collections.Generic.List[object]]::new()
    $failures = [System.Collections.Generic.List[object]]::new()

    $files = @(Get-ChildItem -LiteralPath $stateDir -Recurse -File -Filter '*.md' | Sort-Object FullName)
    foreach ($file in $files) {
        $relFromState = $file.FullName.Substring($stateDir.Length + 1) -replace '\\', '/'
        $relPath = "design/state/$relFromState"

        $info = Get-DesignPathInfo -RelativeToState $relFromState
        if (-not $info) {
            $failures.Add((New-DesignStateFailure -Reason 'UnrecognisedLocation' -Path $relPath))
            continue
        }

        $parsed = Read-DesignRecordFile -FullPath $file.FullName -RelativePath $relPath -Kind $info.Kind
        foreach ($f in $parsed.Failures) { $failures.Add($f) }
        if ($parsed.Record) { $records.Add($parsed.Record) }
    }

    New-DesignStateGraph -Root $stateDir -Records @($records) -Failures @($failures)
}

# Guards the invocation so this script's tests can dot-source it instead - that defines every
# function above in the caller's scope and skips straight past this block, the same shape
# Test-DesignDrift.ps1 and Wait-PullRequestCheck.ps1 already use.
if ($MyInvocation.InvocationName -ne '.') {
    Read-DesignStateGraph -Path $Path
}
