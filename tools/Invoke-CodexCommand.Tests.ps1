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

Describe 'Invoke-CodexCommand tier stamping' {
    <#
      The gate in AGENTS.md resolves a Codex session's tier from configuration, but the
      `architect` profile is sandboxed read-only to the workspace and `~/.codex/` is outside
      it, so the session cannot read the file the rule names and the gate stops on every
      /redteam run. These guard the stamp that crosses that boundary.
    #>

    It 'stamps AGENTKIT_TIER as Deep reasoning for an architect-profile command' {
        $result = & $script:ScriptPath -Command 'redteam' -WhatIf
        $result | Should -Match 'AGENTKIT_TIER=Deep reasoning'
    }

    It 'stamps AGENTKIT_TIER as Implementation for a builder-profile command' {
        $result = & $script:ScriptPath -Command 'slice' -WhatIf
        $result | Should -Match 'AGENTKIT_TIER=Implementation'
    }

    It 'stamps the resolved effort, not the profile default, when -Effort overrides it' {
        $result = & $script:ScriptPath -Command 'slice' -Effort high -WhatIf
        $result | Should -Match 'AGENTKIT_EFFORT=high'
        $result | Should -Match 'AGENTKIT_TIER=Implementation'
    }

    It 'stamps a tier for every command file in .claude/commands/' {
        foreach ($name in $script:CommandNames) {
            $result = & $script:ScriptPath -Command $name -WhatIf
            $result | Should -Match 'AGENTKIT_TIER=(Deep reasoning|Implementation)' -Because "/$name stamps no tier"
        }
    }
}
