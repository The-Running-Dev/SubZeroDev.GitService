#Requires -Version 7.0
<#
.SYNOPSIS
    Assembles a reduced-context prompt for one slice, sized for a smaller or
    local target model instead of the full-context prompt `/slice` hands to
    a frontier one.

.DESCRIPTION
    `/slice` hands over `AGENTS.md`, `agent.md` and the design docs regardless
    of what is receiving them (issue #12). That is right for a large-context
    frontier model and hostile to a small local one. This script emits an
    alternative: the target slice's own block from `design/30-slices.md`,
    `design/20-contract.md` **verbatim** (it is the authoritative surface and
    is never trimmed), and only the `AGENTS.md` sections `.claude/commands/slice.md`
    itself cites by name as binding a slice — `agent.md` is dropped entirely.

    Which `AGENTS.md` sections count as "binding" is not guessed: it is read
    mechanically off `.claude/commands/slice.md`'s own citations, of the form
    `` `AGENTS.md`, *Section Name* ``. That keeps the reduced set traceable to
    the command that actually governs `/slice`, and it stays correct if that
    command's citations change without this script's own logic changing.

    This is a standalone tool, not a step `/slice` runs itself
    (`design/90-decisions.md`, 2026-08-04, "per-target prompt sizing ...
    does not belong bundled into a command file") — run it by hand, or from
    whatever launches a session against a smaller model, before invoking that
    model on a slice.

    Writes nothing. Emits the assembled prompt on the success stream (or to
    -OutFile), the same way `Read-DesignState.ps1` emits its graph.

.PARAMETER SliceId
    The slice to size a prompt for, e.g. `S4`. Matched against a `## S<n> —`
    heading in `design/30-slices.md`.

.PARAMETER RepoRoot
    Repository root to read from. Defaults to the current directory.

.PARAMETER CommandFile
    The command file whose `AGENTS.md` citations decide which sections are
    "binding". Defaults to `.claude/commands/slice.md`, relative to -RepoRoot.

.PARAMETER OutFile
    Write the assembled prompt here instead of the success stream.

.EXAMPLE
    ./tools/New-ReducedPrompt.ps1 -SliceId S4

.EXAMPLE
    ./tools/New-ReducedPrompt.ps1 -SliceId S4 -OutFile reduced-S4.md
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SliceId,

    [string]$RepoRoot = (Get-Location).Path,

    [string]$CommandFile,

    [string]$OutFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-MarkdownSection {
    <#
      Returns the lines of the first heading whose trimmed text equals
      $HeadingText, up to (excluding) the next heading whose level is the
      same as or shallower than the one matched. $Lines is the whole file,
      already split.
    #>
    param([string[]]$Lines, [string]$HeadingText, [string]$SourceName)

    $startIndex = -1
    $level = 0
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match '^(#{1,6})\s+(.*?)\s*$') {
            if ($Matches[2] -eq $HeadingText) {
                $startIndex = $i
                $level = $Matches[1].Length
                break
            }
        }
    }
    if ($startIndex -lt 0) {
        throw "No section '$HeadingText' in $SourceName. The reduced prompt cannot assemble a rule it cannot find."
    }

    $endIndex = $Lines.Count
    for ($i = $startIndex + 1; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match "^(#{1,$level})\s") {
            $endIndex = $i
            break
        }
    }

    return $Lines[$startIndex..($endIndex - 1)]
}

function Get-BoundSectionNames {
    <#
      Reads every `` `AGENTS.md`, *Section Name* `` (or `AGENTS.md, *Section
      Name*` without backticks) citation out of the command file, in first-
      appearance order, de-duplicated. This is the mechanical stand-in for
      "only the rules binding that slice" - the set a slice's own command
      file already says it depends on, not a fresh judgement made here.
    #>
    param([string]$CommandText)

    $names = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $pattern = '`?AGENTS\.md`?,?\s*\*([^*]+)\*'
    foreach ($m in [regex]::Matches($CommandText, $pattern)) {
        $name = $m.Groups[1].Value.Trim()
        if ($seen.Add($name)) { [void]$names.Add($name) }
    }
    return $names
}

function Get-SliceBlock {
    param([string[]]$Lines, [string]$SliceId)

    $startIndex = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match "^##\s+$([regex]::Escape($SliceId))\s+—") {
            $startIndex = $i
            break
        }
    }
    if ($startIndex -lt 0) {
        throw "No '## $SliceId —' heading in design/30-slices.md. If $SliceId has landed, its body was retired to the index and this script has nothing to reduce; read it from git history instead."
    }

    $endIndex = $Lines.Count
    for ($i = $startIndex + 1; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match '^##\s') {
            $endIndex = $i
            break
        }
    }

    # Trim a trailing '---' separator and blank lines the source uses between
    # slice blocks; they read as noise once the block stands alone.
    $block = [System.Collections.Generic.List[string]]::new([string[]]$Lines[$startIndex..($endIndex - 1)])
    while ($block.Count -gt 0 -and ($block[$block.Count - 1].Trim() -eq '' -or $block[$block.Count - 1].Trim() -eq '---')) {
        $block.RemoveAt($block.Count - 1)
    }
    return $block.ToArray()
}

$root = (Resolve-Path $RepoRoot).Path
if (-not $CommandFile) { $CommandFile = Join-Path $root '.claude/commands/slice.md' }
elseif (-not [System.IO.Path]::IsPathRooted($CommandFile)) { $CommandFile = Join-Path $root $CommandFile }

$slicesPath = Join-Path $root 'design/30-slices.md'
$contractPath = Join-Path $root 'design/20-contract.md'
$agentsPath = Join-Path $root 'AGENTS.md'

foreach ($required in @($CommandFile, $slicesPath, $contractPath, $agentsPath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required file not found: $required"
    }
}

$commandText = Get-Content -LiteralPath $CommandFile -Raw
$slicesLines = Get-Content -LiteralPath $slicesPath
$agentsLines = Get-Content -LiteralPath $agentsPath
$contractText = Get-Content -LiteralPath $contractPath -Raw

$sliceBlock = Get-SliceBlock -Lines $slicesLines -SliceId $SliceId
$boundSectionNames = Get-BoundSectionNames -CommandText $commandText
if (-not $boundSectionNames.Count) {
    throw "No 'AGENTS.md, *Section Name*' citation found in $CommandFile. Nothing to bind the reduced prompt to - check the command file still cites its own rules by name."
}

$boundSections = foreach ($name in $boundSectionNames) {
    Get-MarkdownSection -Lines $agentsLines -HeadingText $name -SourceName $agentsPath
    ''
}

$commandRelative = [System.IO.Path]::GetRelativePath($root, $CommandFile) -replace '\\', '/'

$output = [System.Collections.Generic.List[string]]::new()
$output.Add("# Reduced-context prompt — $SliceId")
$output.Add('')
$output.Add("Generated by ``tools/New-ReducedPrompt.ps1`` for a target model with less context than " +
    "the full ``/slice`` prompt assumes. It carries ``design/20-contract.md`` verbatim, only the " +
    "``AGENTS.md`` sections ``$commandRelative`` cites as binding a slice, and drops ``agent.md`` " +
    "entirely. Sections bound: $($boundSectionNames -join ', ').")
$output.Add('')
$output.Add('## Rules binding this slice')
$output.Add('')
$output.AddRange([string[]]$boundSections)
$output.Add('## Contract')
$output.Add('')
$output.Add($contractText.TrimEnd())
$output.Add('')
$output.Add('## Slice')
$output.Add('')
$output.AddRange([string[]]$sliceBlock)

$result = ($output -join "`n") + "`n"

if ($OutFile) {
    Set-Content -LiteralPath $OutFile -Value $result -Encoding utf8NoBOM -NoNewline
}
else {
    $result
}
