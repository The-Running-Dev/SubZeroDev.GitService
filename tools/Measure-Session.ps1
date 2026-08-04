#Requires -Version 7.0
<#
.SYNOPSIS
    Reports what a Claude Code session actually cost, from the transcript.

.DESCRIPTION
    Claude Code writes one JSONL transcript per session under
    ~/.claude/projects/<slug>/, with real per-call usage on every assistant
    record. This reads those files. It measures; it does not estimate, and it
    asks the model for nothing.

    Input is reported as four separate numbers because they are priced
    differently and behave differently. Collapsing them into one "tokens in"
    hides the only figure that usually matters: cache_read, which grows with
    conversation length and dominates every long session measured so far.

    No prices. Rates change, and a rate written from memory is exactly the
    fabricated number this script exists to replace. Multiply the columns by
    current published rates yourself.

.PARAMETER Project
    Repository root to report on. Defaults to the current directory.

.PARAMETER TranscriptPath
    Read transcripts from this directory instead of deriving one from -Project.
    For an exported or relocated store, and for testing against a fixture.

.PARAMETER SessionId
    Report one session. Accepts a full id or a unique prefix. Default: all.

.PARAMETER Detail
    Break each session down by slash-command segment.

.PARAMETER Hook
    Run as a SessionEnd hook. Reads the hook's JSON from stdin, measures the
    session it names, and writes one row to .claude/session-costs.tsv beside
    this script's repository. Prints nothing: SessionEnd output is shown to the
    user only on a non-zero exit, so the log is the deliverable.

    Idempotent. SessionEnd also fires on clear and resume, so a session can be
    reported more than once; an existing row for the same id is replaced rather
    than duplicated.

    The log is a convenience, not the record. Transcripts are durable, so a
    session killed before the hook fires is recovered by re-running this script
    without -Hook.

.PARAMETER IdleThresholdMinutes
    Gaps longer than this are treated as idle and excluded from active time.
    Default 5.

.EXAMPLE
    ./tools/Measure-Session.ps1

.EXAMPLE
    ./tools/Measure-Session.ps1 -Detail -SessionId 672430c6
#>
[CmdletBinding()]
param(
    [string]$Project = (Get-Location).Path,
    [string]$TranscriptPath,
    [string]$SessionId,
    [switch]$Detail,
    [switch]$Hook,
    [int]$IdleThresholdMinutes = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-TranscriptDirectory {
    <#
      Claude Code slugs the project path by replacing every character outside
      [A-Za-z0-9] with '-'. That is derived from observation, not documented,
      so the derived path is verified and a search is the fallback rather than
      the assumption.
    #>
    param([string]$ProjectPath)

    $root = Join-Path $HOME '.claude/projects'
    if (-not (Test-Path $root)) {
        throw "No transcript store at $root. Nothing to measure."
    }

    $full = (Resolve-Path $ProjectPath).Path.TrimEnd('\', '/')
    $slug = ($full -replace '[^A-Za-z0-9]', '-')
    $derived = Join-Path $root $slug
    if (Test-Path $derived) { return $derived }

    # Fall back to matching on the leaf name, and say so rather than guessing silently.
    $leaf = ($full | Split-Path -Leaf) -replace '[^A-Za-z0-9]', '-'
    $candidates = @(Get-ChildItem $root -Directory | Where-Object Name -like "*$leaf")
    if ($candidates.Count -eq 1) {
        Write-Warning "Derived path not found; matched '$($candidates[0].Name)' on leaf name."
        return $candidates[0].FullName
    }
    if ($candidates.Count -gt 1) {
        throw "Ambiguous: $($candidates.Count) transcript directories match '$leaf'. Pass -Project explicitly."
    }
    throw "No transcript directory for $full. Expected $derived."
}

function Read-Session {
    param([System.IO.FileInfo]$File)

    $segments = [System.Collections.Generic.List[object]]::new()
    $current = $null
    $stamps = [System.Collections.Generic.List[datetime]]::new()
    $models = [System.Collections.Generic.HashSet[string]]::new()

    function New-Segment { param([string]$Label)
        [pscustomobject]@{
            Label = $Label; Calls = 0
            Input = 0L; CacheCreate = 0L; CacheRead = 0L; Output = 0L
        }
    }

    $current = New-Segment '(no command)'
    $segments.Add($current)
    $pending = $null

    foreach ($line in [System.IO.File]::ReadLines($File.FullName)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $record = $line | ConvertFrom-Json } catch { continue }

        if ($record.PSObject.Properties.Name -contains 'timestamp' -and $record.timestamp) {
            $stamps.Add([datetime]$record.timestamp)
        }

        $message = if ($record.PSObject.Properties.Name -contains 'message') { $record.message } else { $null }
        if (-not $message) { continue }

        # A slash command arrives as a plain-string user record. It is held
        # pending rather than opening a segment immediately: commands like
        # /model and /config run in the CLI and cost nothing, and attributing
        # the following conversation to them is a metric that lies. A pending
        # command is cancelled by local-command output and committed by the
        # first call that actually costs something.
        if ($message.PSObject.Properties.Name -contains 'content' -and $message.content -is [string]) {
            if ($message.content -match '<command-name>([^<]+)</command-name>') {
                $pending = $Matches[1].Trim()
            }
            elseif ($message.content -match '<local-command-(stdout|caveat)>') {
                $pending = $null
            }
            continue
        }

        $usage = if ($message.PSObject.Properties.Name -contains 'usage') { $message.usage } else { $null }
        if (-not $usage) { continue }

        # A segment runs from here until the next command, so it includes every
        # follow-up turn, approval and correction. It is not the isolated cost
        # of the command.
        if ($pending) {
            $current = New-Segment $pending
            $segments.Add($current)
            $pending = $null
        }

        if ($message.PSObject.Properties.Name -contains 'model' -and $message.model) {
            [void]$models.Add($message.model)
        }

        $current.Calls++
        foreach ($pair in @(
            @('input_tokens', 'Input'),
            @('cache_creation_input_tokens', 'CacheCreate'),
            @('cache_read_input_tokens', 'CacheRead'),
            @('output_tokens', 'Output'))) {
            if ($usage.PSObject.Properties.Name -contains $pair[0]) {
                $current.($pair[1]) += [long]$usage.($pair[0])
            }
        }
    }

    $ordered = $stamps | Sort-Object
    $span = if ($ordered.Count -ge 2) { $ordered[-1] - $ordered[0] } else { [timespan]::Zero }

    $active = [timespan]::Zero
    $limit = [timespan]::FromMinutes($IdleThresholdMinutes)
    for ($i = 1; $i -lt $ordered.Count; $i++) {
        $gap = $ordered[$i] - $ordered[$i - 1]
        if ($gap -le $limit) { $active += $gap }
    }

    [pscustomobject]@{
        Id       = $File.BaseName
        Started  = if ($ordered.Count) { $ordered[0] } else { $null }
        Span     = $span
        Active   = $active
        Models   = ($models | Sort-Object) -join ', '
        Segments = @($segments | Where-Object Calls -gt 0)
    }
}

function Format-Row {
    param([string]$Label, [object]$S)
    '{0,-28} {1,6} {2,10:N0} {3,12:N0} {4,13:N0} {5,10:N0}' -f
        $Label, $S.Calls, $S.Input, $S.CacheCreate, $S.CacheRead, $S.Output
}

if ($Hook) {
    # SessionEnd delivers its JSON on stdin. Failing loudly here would put an
    # error in front of the user at the moment they are closing the session, so
    # this reports a problem and gets out of the way.
    try {
        $payload = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
        $file = Get-Item -LiteralPath $payload.transcript_path
        $session = Read-Session -File $file

        $sum = [pscustomobject]@{ Calls = 0; Input = 0L; CacheCreate = 0L; CacheRead = 0L; Output = 0L }
        foreach ($segment in $session.Segments) {
            foreach ($field in 'Calls', 'Input', 'CacheCreate', 'CacheRead', 'Output') {
                $sum.$field += $segment.$field
            }
        }
        if (-not $sum.Calls) { exit 0 }

        $log = Join-Path (Split-Path $PSScriptRoot -Parent) '.claude/session-costs.tsv'
        $columns = 'started', 'session', 'models', 'calls', 'span', 'active',
                   'input', 'cache_create', 'cache_read', 'output'
        $row = @(
            ('{0:yyyy-MM-ddTHH:mm:ss}' -f $session.Started)
            $session.Id
            $session.Models
            $sum.Calls
            ('{0:hh\:mm\:ss}' -f $session.Span)
            ('{0:hh\:mm\:ss}' -f $session.Active)
            $sum.Input, $sum.CacheCreate, $sum.CacheRead, $sum.Output
        ) -join "`t"

        # Rewrite rather than append: SessionEnd fires on clear and resume too,
        # so the same session can arrive twice and the later reading supersedes.
        # Assigned in two steps deliberately: an if/else returning @() unrolls to
        # $null, which is a null-reference bug waiting under Set-StrictMode.
        $existing = @()
        if (Test-Path $log) {
            $existing = @(Get-Content -LiteralPath $log | Where-Object { $_ -and ($_ -split "`t")[1] -ne $session.Id })
        }
        if (-not $existing.Count) { $existing = @($columns -join "`t") }

        $logDirectory = Split-Path $log -Parent
        if (-not (Test-Path $logDirectory)) { New-Item -ItemType Directory -Path $logDirectory | Out-Null }
        Set-Content -LiteralPath $log -Value (@($existing) + $row) -Encoding utf8NoBOM
        exit 0
    }
    catch {
        [Console]::Error.WriteLine("Measure-Session (line $($_.InvocationInfo.ScriptLineNumber)): $($_.Exception.Message)")
        exit 1
    }
}

$directory = if ($TranscriptPath) {
    if (-not (Test-Path $TranscriptPath)) { throw "No such transcript directory: $TranscriptPath" }
    (Resolve-Path $TranscriptPath).Path
}
else { Resolve-TranscriptDirectory -ProjectPath $Project }
$files = @(Get-ChildItem $directory -Filter *.jsonl -File)
if ($SessionId) { $files = @($files | Where-Object BaseName -like "$SessionId*") }
if (-not $files.Count) { throw "No transcripts matched in $directory." }

$header = '{0,-28} {1,6} {2,10} {3,12} {4,13} {5,10}' -f 'Segment', 'calls', 'input', 'cache_new', 'cache_read', 'output'
$totals = [pscustomobject]@{ Calls = 0; Input = 0L; CacheCreate = 0L; CacheRead = 0L; Output = 0L }

foreach ($file in ($files | Sort-Object LastWriteTime)) {
    $session = Read-Session -File $file
    if (-not $session.Segments.Count) { continue }

    $sum = [pscustomobject]@{ Calls = 0; Input = 0L; CacheCreate = 0L; CacheRead = 0L; Output = 0L }
    foreach ($segment in $session.Segments) {
        foreach ($field in 'Calls', 'Input', 'CacheCreate', 'CacheRead', 'Output') {
            $sum.$field += $segment.$field
            $totals.$field += $segment.$field
        }
    }

    $shortId = if ($session.Id.Length -gt 8) { $session.Id.Substring(0, 8) } else { $session.Id }
    ''
    "Session {0}   {1}" -f $shortId, $session.Models
    "  started {0:yyyy-MM-dd HH:mm}   span {1:hh\:mm\:ss}   active {2:hh\:mm\:ss} (gaps over {3} min excluded)" -f
        $session.Started, $session.Span, $session.Active, $IdleThresholdMinutes
    ''
    $header
    ('-' * $header.Length)
    if ($Detail) {
        foreach ($segment in $session.Segments) { Format-Row -Label $segment.Label -S $segment }
        ('-' * $header.Length)
    }
    Format-Row -Label 'session total' -S $sum
}

if ($files.Count -gt 1) {
    ''
    ('=' * $header.Length)
    Format-Row -Label "all sessions ($($files.Count))" -S $totals
}

''
'cache_read is the term that grows with conversation length. If it dominates,'
'the lever is session boundaries, not per-command waste.'
''
