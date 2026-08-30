#Requires -Version 7.0
#Requires -Modules Pester

<#
  Regression coverage for #44: /reconcile, /contract and /design each cited "the record-writing
  sequence in design/10-design.md § Record" - a citation that only ever resolved in this
  repository. design/10-design.md is repository-specific content (the design of whatever this
  particular repository's design/ describes), never overwritten by /kit-sync, so an installed
  target has no reason to carry a "Record" heading there at all. A session in a target repository
  had to guess the sequence instead of following a rule, and a guess that happens to pass the
  gates looks identical to one that followed the rule.

  The fix points all three at AGENTS.md § Writing a design-state record instead - AGENTS.md is
  the one document a target repository does carry, seeded by /install and reconciled by
  /kit-sync's own divergence handling, unlike design/10-design.md which is never kit-installed.

  This only checks that the citation resolves to a real heading, not that the sequence itself is
  followed correctly - that is exercised generically by Test-DesignState.Tests.ps1 and
  Update-DesignProjection.Tests.ps1 against this repository's own state set.
#>

Describe 'the record-writing sequence citation resolves to a real AGENTS.md heading (#44)' {

    BeforeAll {
        $script:RepoRoot = Split-Path $PSScriptRoot -Parent
        $script:AgentsPath = Join-Path $script:RepoRoot 'AGENTS.md'
        $script:AgentsHeadings = (Get-Content -LiteralPath $script:AgentsPath) |
            Select-String -Pattern '^#{1,3} ' |
            ForEach-Object { ($_.Line -replace '^#{1,3}\s*', '').Trim() }
    }

    It 'AGENTS.md carries a "Writing a design-state record" heading' {
        $script:AgentsHeadings | Should -Contain 'Writing a design-state record'
    }

    It '/reconcile, /contract and /design each cite AGENTS.md, not design/10-design.md, for the sequence' {
        $commandPaths = @(
            '.claude/commands/reconcile.md',
            '.claude/commands/contract.md',
            '.claude/commands/design.md'
        ) | ForEach-Object { Join-Path $script:RepoRoot $_ }

        foreach ($path in $commandPaths) {
            $content = Get-Content -LiteralPath $path -Raw
            $content | Should -Match 'record-writing sequence in `AGENTS\.md` § \*Writing a design-state record\*' -Because "$path should cite the AGENTS.md home, not design/10-design.md"
            $content | Should -Not -Match 'record-writing sequence in `design/10-design\.md`' -Because "$path should no longer cite a section that only resolves in this repository"
        }
    }
}
