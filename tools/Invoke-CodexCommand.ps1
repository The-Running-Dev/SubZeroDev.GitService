#Requires -Version 7.0
<#
.SYNOPSIS
    Launches `codex` with the `--profile` that matches a command's required tier in
    AGENTS.md, so the tier gate in "Model, effort, and review budget" never has to catch
    a mismatch caused by launching on whatever profile the shell happened to have open.

.DESCRIPTION
    codex/PROFILES.md defines three profiles - architect (Sol, deep reasoning), builder
    (Terra, implementation), quick (Codex Spark, high volume) - but nothing picks one from
    a command name. AGENTS.md's *Command routing* table names a tier per command; this
    script is that lookup, exec'd as `codex --profile <profile> [-c model_reasoning_effort=<x>] @CodexArgs`.

    This is exactly the kind of mechanical, repeated lookup AGENTS.md's own "What should
    stop being model work" table calls 🔴 Definitely avoidable - arithmetic over a table,
    not judgement. The judgement (which tier a *novel* task needs) still belongs to
    whoever is running the session; this script only removes the "which profile flag do I
    type for a command I already know the tier of" step.

    -Effort overrides the profile's baked-in reasoning effort via `-c
    model_reasoning_effort=<value>`, for the routing table's documented exceptions (a large
    /slice at high, an /reconcile mechanical-edit pass at medium instead of the profile's
    default). It does not change which profile is selected.

    /redteam's requirement ("strongest model, different vendor from the design author") is
    a constraint this script cannot enforce - it maps /redteam to `architect`, the
    strongest local Codex profile, but vendor diversity is the caller's call to make before
    running it.

.PARAMETER Command
    The command name, with or without a leading slash (e.g. 'kit-help' or '/kit-help').

.PARAMETER Effort
    Override the profile's model_reasoning_effort for this run only (low, medium, high,
    xhigh, max). Passed as `-c model_reasoning_effort=<Effort>`.

.PARAMETER List
    Print the full command-to-profile table and exit. No command required.

.PARAMETER WhatIf
    Print the resolved codex invocation instead of running it.

.PARAMETER CodexArgs
    Everything after the command name/flags is passed through to `codex` verbatim (e.g.
    the prompt text, or `resume <id>`).

.EXAMPLE
    ./tools/Invoke-CodexCommand.ps1 kit-help
    Resolves /kit-help to the 'quick' profile and runs `codex --profile quick`.

.EXAMPLE
    ./tools/Invoke-CodexCommand.ps1 slice -Effort high -- "implement S4"
    Resolves /slice to 'builder' but overrides effort to high for a large slice.

.EXAMPLE
    ./tools/Invoke-CodexCommand.ps1 -List
    Prints the full mapping without launching anything.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $Command,

    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string] $Effort,

    [switch] $List,

    [switch] $WhatIf,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $CodexArgs = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Mirrors AGENTS.md's *Command routing* table. Tier -> profile per codex/PROFILES.md:
# deep reasoning -> architect, implementation -> builder, high volume -> quick.
# Where routing names two tiers for one command (a decide phase and a mechanical phase),
# this maps to the tier of the phase that runs first / gates the rest.
$commandProfiles = [ordered]@{
    'brief-check'      = 'architect'
    'design'           = 'architect'
    'contract'         = 'architect'
    'slices'           = 'architect'
    'redteam'          = 'architect'   # strongest local profile; vendor diversity is on the caller
    'slice'            = 'builder'
    'reconcile'        = 'architect'   # deciding which side is correct gates the mechanical edits
    'make-human-docs'  = 'builder'
    'track'            = 'builder'
    'verify'           = 'builder'
    'pr'               = 'builder'
    'resolve'          = 'builder'
    'fix'              = 'builder'
    'refine'           = 'builder'
    'install'          = 'builder'
    'install-all'      = 'builder'
    'kit-sync'         = 'builder'
    'kit-help'         = 'quick'
    'done'             = 'quick'
    'freeze'           = 'builder'
    'unfreeze'         = 'builder'     # its own reconcile/track sub-phases pick their own profile
}

if ($List) {
    $commandProfiles.GetEnumerator() | ForEach-Object {
        [pscustomobject]@{ Command = "/$($_.Key)"; Profile = $_.Value }
    } | Format-Table -AutoSize
    return
}

if (-not $Command) {
    throw "No command given. Pass a command name (e.g. 'kit-help') or -List to see the table."
}

$normalized = $Command.TrimStart('/')
if (-not $commandProfiles.Contains($normalized)) {
    $known = ($commandProfiles.Keys | ForEach-Object { "/$_" }) -join ', '
    throw "No profile mapping for '/$normalized'. Known commands: $known. Pass --profile to codex directly for anything else."
}

$codexProfile = $commandProfiles[$normalized]

$codexInvocationArgs = @('--profile', $codexProfile)
if ($Effort) {
    $codexInvocationArgs += @('-c', "model_reasoning_effort=$Effort")
}
$codexInvocationArgs += $CodexArgs

if ($WhatIf) {
    Write-Output "codex $($codexInvocationArgs -join ' ')"
    return
}

& codex @codexInvocationArgs
exit $LASTEXITCODE
