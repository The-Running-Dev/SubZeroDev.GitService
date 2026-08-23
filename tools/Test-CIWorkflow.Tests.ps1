#Requires -Version 7.0
#Requires -Modules Pester

<#
  Regression coverage for #79: the "Run Pester tests" CI step calls the real design-state
  check (S12.5, tools/Test-DesignState.Tests.ps1) against this repository, which needs an
  authenticated gh exactly as the later "Check the design state against the tree" step
  already does - so it needs the same GH_TOKEN. Without it, an unauthenticated gh turns
  S12.5 into a could-not-evaluate (TrackerUnavailable) rather than a check of anything this
  step is meant to gate.

  The comparison only has a second step to compare against once design-state tracking is
  adopted and verify.yml has grown that "Check the design state against the tree" step. The
  2026-08-19 compatibility promise (design/90-decisions.md) does not migrate it to the installed
  targets this file is copied into, so where verify.yml is absent or carries no such step the
  test is skipped rather than failed - its absence there is the promise being kept, not a
  divergence to report.
#>

$script:CIWorkflowPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.github/workflows/verify.yml'
$script:SkipCIWorkflowGhTokenTest = -not (Test-Path $script:CIWorkflowPath) -or
    -not (Select-String -LiteralPath $script:CIWorkflowPath -Pattern '- name: Check the design state against the tree' -Quiet)

Describe 'CI workflow: the Run Pester tests step is authenticated (#79)' {

    BeforeAll {
        # Recomputed rather than reused from the discovery-time variable above: Pester runs
        # discovery and run as separate passes, and a $script: variable set during discovery is
        # not in scope here. Only -Skip: may read that one, because -Skip: is evaluated during
        # discovery.
        $script:WorkflowPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.github/workflows/verify.yml'
        $script:Lines = Get-Content -LiteralPath $script:WorkflowPath
    }

    It 'the "Run Pester tests" step carries a GH_TOKEN env, the same as "Check the design state against the tree"' -Skip:$script:SkipCIWorkflowGhTokenTest {
        $stepIndex = ($script:Lines | Select-String -Pattern '- name: Run Pester tests').LineNumber
        $stepIndex | Should -Not -BeNullOrEmpty

        # The step body runs from its `- name:` line to the line before the next `- name:`
        # (or end of file), so this only inspects this one step's own env block.
        $nextStepIndex = ($script:Lines | Select-String -Pattern '^\s*- name:' |
            Where-Object { $_.LineNumber -gt $stepIndex } |
            Select-Object -First 1).LineNumber
        $endIndex = if ($nextStepIndex) { $nextStepIndex - 1 } else { $script:Lines.Count }
        $stepBody = $script:Lines[($stepIndex - 1)..($endIndex - 1)] -join "`n"

        $stepBody | Should -Match 'GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}'
    }
}
