#Requires -Version 7.0
<#
.SYNOPSIS
    Launches `codex` configured for the tier that matches a command's requirement in
    AGENTS.md, so the tier gate in "Model, effort, and review budget" never has to catch
    a mismatch caused by launching on whatever config the shell happened to have open.

.DESCRIPTION
    codex/PROFILES.md defines three profiles - architect (Sol, deep reasoning), builder
    (Terra, implementation), quick (Codex Spark, high volume) - but nothing picks one from
    a command name. AGENTS.md's *Command routing* table names a tier per command; this
    script is that lookup.

    It does NOT launch via `codex --profile <name>`. That flag layers
    `$CODEX_HOME/<name>.config.toml` on top of the base user config (`codex --help`), and
    codex/PROFILES.md documents those per-profile files as something a person sets up by
    hand on their own machine - the kit's own installer (`INSTALL.md` phase 1, the
    `codex/PROFILES.md` row) refuses to write them into a target repo. A machine without
    them - the common case for a fresh clone - makes every `--profile` flag resolve to
    nothing, silently running the base config regardless of which tier was requested
    (see issue #117). This script instead passes each profile's `model`,
    `model_reasoning_effort`, `approval_policy`, and `sandbox_mode` straight to `codex` via
    `-m`, `-c model_reasoning_effort=<x>`, `-a`, and `-s`, mirroring codex/PROFILES.md's
    0.134+ per-file values below - no `$CODEX_HOME` file needs to exist. Keep
    `$profileConfig` below in sync with codex/PROFILES.md by hand; nothing enforces that
    automatically.

    This is exactly the kind of mechanical, repeated lookup AGENTS.md's own "What should
    stop being model work" table calls 🔴 Definitely avoidable - arithmetic over a table,
    not judgement. The judgement (which tier a *novel* task needs) still belongs to
    whoever is running the session; this script only removes the "which flags do I type
    for a command I already know the tier of" step.

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
    Resolves /kit-help to the 'quick' profile and runs codex with that profile's model,
    effort, approval policy, and sandbox mode passed directly.

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
    'clean'            = 'quick'
    'install-code-review-agent' = 'builder'
    'freeze'           = 'builder'
    'unfreeze'         = 'builder'     # its own reconcile/track sub-phases pick their own profile
}

# Mirrors codex/PROFILES.md's "Codex 0.134.0 and later" per-file values. --profile is not
# used to load these (see .DESCRIPTION) - keep this table in sync with PROFILES.md by hand.
$profileConfig = [ordered]@{
    'architect' = @{ Model = 'gpt-5.6-sol';         Effort = 'xhigh';  Approval = 'on-request'; Sandbox = 'read-only' }
    'builder'   = @{ Model = 'gpt-5.6-terra';       Effort = 'medium'; Approval = 'on-request'; Sandbox = 'workspace-write' }
    'quick'     = @{ Model = 'gpt-5.3-codex-spark'; Effort = 'low';    Approval = 'on-request'; Sandbox = 'workspace-write' }
}

if ($List) {
    $commandProfiles.GetEnumerator() | ForEach-Object {
        $p = $profileConfig[$_.Value]
        [pscustomobject]@{
            Command  = "/$($_.Key)"
            Profile  = $_.Value
            Model    = $p.Model
            Effort   = $p.Effort
            Approval = $p.Approval
            Sandbox  = $p.Sandbox
        }
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
$selectedConfig = $profileConfig[$codexProfile]
$resolvedEffort = if ($Effort) { $Effort } else { $selectedConfig.Effort }

$codexInvocationArgs = @(
    '-m', $selectedConfig.Model,
    '-c', "model_reasoning_effort=$resolvedEffort",
    '-a', $selectedConfig.Approval,
    '-s', $selectedConfig.Sandbox
)
$codexInvocationArgs += $CodexArgs

if ($WhatIf) {
    Write-Output "codex $($codexInvocationArgs -join ' ')"
    return
}

& codex @codexInvocationArgs
exit $LASTEXITCODE
