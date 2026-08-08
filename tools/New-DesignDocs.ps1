#Requires -Version 7.0
<#
.SYNOPSIS
    Seeds design/ in a target repository from the kit's templates/design/, mechanically.

.DESCRIPTION
    Writing design/00-brief.md through design/90-decisions.md is a plain file copy with
    one occupied-directory check - no judgement involved - so it does not need an agent
    turn to do it. This is the same seed step INSTALL.md's phase 2 describes for
    templates/design/ (`INSTALL.md` - "the seed is templates/design/, the kit's own
    design/ is never installed"), pulled out so it can run without spending a model call
    on a copy operation.

    Classifies each of the five seed files the same way INSTALL.md classifies every kit
    artifact:

      Missing            Not present in the target. Copied.
      Present-identical  Present and byte-identical to the template. Left alone, reported.
      Divergent          Present and different (the brief has been written on, or another
                          doc has real content). Never touched without -Force - that
                          content is work, not drift.
      Occupied           design/ already exists, holds none of the five seed files, and
                          holds something else (mockups, an unrelated doc set). Stops
                          without writing anything, Force or not - INSTALL.md is explicit
                          that relocating is a decision, not a fix a flag should make.

    Never invents content. 00-brief.md is a fill-in-the-blanks template meant to be
    written by a person (see its own header); 10-design.md, 20-contract.md and
    30-slices.md are seeded empty on purpose - they are /design's, /contract's and
    /slices's to fill, not this script's.

.PARAMETER TargetRepo
    Repository root to seed design/ into. Defaults to the current directory.

.PARAMETER KitRoot
    Path to a checkout holding templates/design/ (the kit itself, or ~/.agent-kit).
    Defaults to this script's own repository if it is running from inside the kit,
    otherwise ~/.agent-kit (the location /kit-sync maintains).

.PARAMETER Force
    Overwrite a Divergent seed file with the template. Never bypasses an Occupied
    directory - that stop is not a flag's to override.

.PARAMETER Quiet
    Suppress the per-file report line; still prints the final summary.

.EXAMPLE
    ./tools/New-DesignDocs.ps1
    Seed design/ in the current repository from the kit checkout.

.EXAMPLE
    ./tools/New-DesignDocs.ps1 -TargetRepo D:\Projects\Some.Repo -Force
    Seed another repository, overwriting any seed file that was reset back to template
    content on purpose.
#>
[CmdletBinding()]
param(
    [string] $TargetRepo = (Get-Location).Path,
    [string] $KitRoot,
    [switch] $Force,
    [switch] $Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-KitRoot {
    param([string] $Explicit)

    if ($Explicit) {
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $selfHosted = Split-Path -Parent $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $selfHosted 'templates/design')) {
        return $selfHosted
    }

    $synced = Join-Path $HOME '.agent-kit'
    if (Test-Path -LiteralPath (Join-Path $synced 'templates/design')) {
        return $synced
    }

    throw "Could not find templates/design/ under '$selfHosted' or '$synced'. Pass -KitRoot explicitly."
}

$kitRootResolved = Resolve-KitRoot -Explicit $KitRoot
$templateDir = Join-Path $kitRootResolved 'templates/design'
if (-not (Test-Path -LiteralPath $templateDir)) {
    throw "templates/design/ not found under '$kitRootResolved'."
}

if (-not (Test-Path -LiteralPath $TargetRepo)) {
    throw "TargetRepo '$TargetRepo' does not exist."
}
$targetRepoResolved = (Resolve-Path -LiteralPath $TargetRepo).Path
$designDir = Join-Path $targetRepoResolved 'design'

$seedFiles = Get-ChildItem -LiteralPath $templateDir -Filter '*.md' -File
if (-not $seedFiles) {
    throw "templates/design/ under '$kitRootResolved' has no .md files - nothing to seed."
}
$seedNames = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]($seedFiles | ForEach-Object { $_.Name }),
    [System.StringComparer]::OrdinalIgnoreCase)

function New-SeedReport {
    param([string]$Name, [string]$Status)
    [pscustomobject]@{ Name = $Name; Status = $Status }
}

$report = [System.Collections.Generic.List[object]]::new()

if (Test-Path -LiteralPath $designDir) {
    if ((Get-Item -LiteralPath $designDir) -isnot [System.IO.DirectoryInfo]) {
        throw "'$designDir' exists and is not a directory. Occupied - resolve by hand."
    }

    $existingEntries = @(Get-ChildItem -LiteralPath $designDir -Force)
    $hasAnySeedFile = $false
    foreach ($entry in $existingEntries) {
        if ($seedNames.Contains($entry.Name)) { $hasAnySeedFile = $true; break }
    }
    if ($existingEntries.Count -gt 0 -and -not $hasAnySeedFile) {
        $names = ($existingEntries | ForEach-Object { $_.Name }) -join ', '
        throw "'$designDir' is occupied - it holds none of the five seed files, only: $names. Stopping without writing anything; relocating design/ is a decision, not something this script makes for you."
    }
} else {
    New-Item -ItemType Directory -Path $designDir | Out-Null
}

foreach ($seed in $seedFiles) {
    $destPath = Join-Path $designDir $seed.Name

    if (-not (Test-Path -LiteralPath $destPath)) {
        Copy-Item -LiteralPath $seed.FullName -Destination $destPath
        $report.Add((New-SeedReport $seed.Name 'Created'))
        continue
    }

    $templateContent = Get-Content -LiteralPath $seed.FullName -Raw
    $existingContent = Get-Content -LiteralPath $destPath -Raw
    if ($existingContent -ceq $templateContent) {
        $report.Add((New-SeedReport $seed.Name 'AlreadyInstalled'))
        continue
    }

    if ($Force) {
        Copy-Item -LiteralPath $seed.FullName -Destination $destPath -Force
        $report.Add((New-SeedReport $seed.Name 'Overwritten'))
    } else {
        $report.Add((New-SeedReport $seed.Name 'Divergent-Skipped'))
    }
}

if (-not $Quiet) {
    $report | Format-Table -AutoSize | Out-String | Write-Host
}

$divergentCount = @($report | Where-Object Status -eq 'Divergent-Skipped').Count
if ($divergentCount -gt 0) {
    Write-Host "$divergentCount file(s) have real content and were left alone. Re-run with -Force only if you mean to discard it."
}

$report
