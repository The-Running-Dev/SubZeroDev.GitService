#Requires -Version 7.0
#Requires -Modules Pester

<#
  Invoke-CodexCommand.ps1 maps each command name to a Codex profile per AGENTS.md's
  *Command routing* table. The regression this guards (issue #116): /done was renamed to
  /clean (issue #127) but the map kept the old 'done' key, so /clean fell through to the
  "no profile mapping" error - exactly the manual profile selection the script exists to
  remove. Runs against this repository's own .claude/commands/ rather than a fixture,
  since the defect is staleness against the real command set.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Invoke-CodexCommand.ps1'
    $script:RepoRoot = Split-Path $PSScriptRoot -Parent
    $script:CommandNames = Get-ChildItem (Join-Path $script:RepoRoot '.claude/commands/*.md') |
        ForEach-Object { $_.BaseName }
}

Describe 'Invoke-CodexCommand command map' {
    It 'has a mapping for every command file in .claude/commands/' {
        foreach ($name in $script:CommandNames) {
            { & $script:ScriptPath -Command $name -WhatIf } | Should -Not -Throw -Because "/$name has no profile mapping"
        }
    }

    It 'resolves /clean rather than the retired /done name' {
        $result = & $script:ScriptPath -Command 'clean' -WhatIf
        $result | Should -Match 'gpt-5.3-codex-spark'
    }

    It 'throws for a command name with no mapping' {
        { & $script:ScriptPath -Command 'not-a-real-command' -WhatIf } | Should -Throw
    }
}
