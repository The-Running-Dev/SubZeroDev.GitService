#Requires -Version 7.0
#Requires -Modules Pester

<#
  Regression coverage for #62: /track's "Refresh the work mirror" step ran
  tools/Update-WorkMirror.ps1 and stopped. design/state-index.md's outstanding region is a
  projection of the WorkRef records that script writes, and nothing regenerated it - so a
  routine mirror refresh left ProjectionStale (blocking) firing on the very next
  Test-DesignState.ps1 run, red on main for six consecutive commits before PR #61 unredded it
  by hand.

  This only checks that the procedure names the regeneration step, not that running it clears
  ProjectionStale - that behaviour is already covered generically by
  Test-DesignState.Tests.ps1's ProjectionStale tests and Update-DesignProjection.Tests.ps1's own
  idempotency tests. The gap #62 found was in the command's instructions, not in either script.
#>

Describe 'track.md: the work-mirror refresh also regenerates the projection (#62)' {

    BeforeAll {
        $script:TrackPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.claude/commands/track.md'
        $script:Lines = Get-Content -LiteralPath $script:TrackPath
    }

    It 'names Update-DesignProjection.ps1 (a real run, not -DryRun) after the work-mirror refresh' {
        $refreshIndex = ($script:Lines | Select-String -Pattern '^## Refresh the work mirror$').LineNumber
        $refreshIndex | Should -Not -BeNullOrEmpty

        $nextSectionIndex = ($script:Lines | Select-String -Pattern '^## ' |
            Where-Object { $_.LineNumber -gt $refreshIndex } |
            Select-Object -First 1).LineNumber
        $endIndex = if ($nextSectionIndex) { $nextSectionIndex - 1 } else { $script:Lines.Count }
        $sectionBody = $script:Lines[($refreshIndex - 1)..($endIndex - 1)] -join "`n"

        $mirrorLine = ($sectionBody -split "`n" | Select-String -Pattern 'Update-WorkMirror\.ps1' | Select-Object -First 1).LineNumber
        $mirrorLine | Should -Not -BeNullOrEmpty

        $projectionLine = ($sectionBody -split "`n" | Select-String -Pattern 'Update-DesignProjection\.ps1' | Select-Object -First 1).LineNumber
        $projectionLine | Should -Not -BeNullOrEmpty
        $projectionLine | Should -BeGreaterThan $mirrorLine

        # The real run, not the checker's -DryRun entry point - a DryRun writes nothing to
        # design/state-index.md and would leave ProjectionStale exactly as unfixed as before.
        $projectionInvocation = ($sectionBody -split "`n") | Where-Object { $_ -match 'Update-DesignProjection\.ps1' }
        $projectionInvocation | Where-Object { $_ -match '-DryRun' } | Should -BeNullOrEmpty
    }
}
