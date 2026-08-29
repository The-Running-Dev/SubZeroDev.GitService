#Requires -Version 7.0
#Requires -Modules Pester

<#
  Exercises the script against a small fixture repo rather than this
  repository's own AGENTS.md / design docs, so a future edit to either does
  not silently change what these tests assert. The fixture reproduces just
  the shapes the script depends on: a command file citing two AGENTS.md
  sections, an AGENTS.md with those two sections plus a third it must not
  pull in, a slices doc with two slice blocks, and a contract file.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'New-ReducedPrompt.ps1'

    function New-Fixture {
        param([string]$Root)

        New-Item -ItemType Directory -Path (Join-Path $Root '.claude/commands') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $Root 'design') -Force | Out-Null

        Set-Content -LiteralPath (Join-Path $Root '.claude/commands/slice.md') -Encoding utf8NoBOM -Value @'
---
description: fixture
---
Cites (`AGENTS.md`, *Safe start*) once and (AGENTS.md, *Hard rules*) again later.
'@

        Set-Content -LiteralPath (Join-Path $Root 'AGENTS.md') -Encoding utf8NoBOM -Value @'
# Agent contract

## Safe start
Read before touching anything.

## Hard rules
One slice at a time.

## Unrelated section
This must never appear in a reduced prompt - nothing cites it.
'@

        Set-Content -LiteralPath (Join-Path $Root 'design/20-contract.md') -Encoding utf8NoBOM -Value @'
# Contract
Verbatim carry-through content.
'@

        Set-Content -LiteralPath (Join-Path $Root 'design/30-slices.md') -Encoding utf8NoBOM -Value @'
# Slices

## Outstanding

## S1 — First slice
Delivers: the first thing.
Acceptance:
  - S1.1 does a thing

---

## S2 — Second slice
Delivers: the second thing.
Acceptance:
  - S2.1 does another thing

---

## Landed
retired bodies live elsewhere
'@
    }
}

Describe 'New-ReducedPrompt' {
    BeforeEach {
        $script:Root = Join-Path $TestDrive ([guid]::NewGuid())
        New-Item -ItemType Directory -Path $script:Root -Force | Out-Null
        New-Fixture -Root $script:Root
    }

    It 'includes only the AGENTS.md sections the command file cites, in citation order' {
        $result = & $script:ScriptPath -SliceId S1 -RepoRoot $script:Root

        $result | Should -Match '## Safe start'
        $result | Should -Match '## Hard rules'
        $result | Should -Not -Match 'Unrelated section'

        # Citation order is Safe start, then Hard rules - assert the section
        # headings appear in that order, not just that both are present.
        $safeIndex = $result.IndexOf('## Safe start')
        $hardIndex = $result.IndexOf('## Hard rules')
        $safeIndex | Should -BeGreaterThan -1
        $hardIndex | Should -BeGreaterThan $safeIndex
    }

    It 'carries the contract verbatim' {
        $result = & $script:ScriptPath -SliceId S1 -RepoRoot $script:Root

        $result | Should -Match ([regex]::Escape('Verbatim carry-through content.'))
    }

    It 'drops agent.md entirely - the word never appears as a source, only as a stated exclusion' {
        $agentMdPath = Join-Path $script:Root 'agent.md'
        Set-Content -LiteralPath $agentMdPath -Encoding utf8NoBOM -Value 'Lessons that must not leak into the reduced prompt.'

        $result = & $script:ScriptPath -SliceId S1 -RepoRoot $script:Root

        $result | Should -Not -Match 'Lessons that must not leak'
    }

    It 'extracts only the requested slice block, not a neighbour' {
        $result = & $script:ScriptPath -SliceId S1 -RepoRoot $script:Root

        $result | Should -Match '## S1 — First slice'
        $result | Should -Match 'S1\.1 does a thing'
        $result | Should -Not -Match '## S2 — Second slice'
        $result | Should -Not -Match 'S2\.1 does another thing'
    }

    It 'selects the other slice when asked for it' {
        $result = & $script:ScriptPath -SliceId S2 -RepoRoot $script:Root

        $result | Should -Match '## S2 — Second slice'
        $result | Should -Not -Match '## S1 — First slice'
    }

    It 'throws naming the slice when no such heading exists' {
        { & $script:ScriptPath -SliceId S9 -RepoRoot $script:Root -ErrorAction Stop } |
            Should -Throw '*S9*'
    }

    It 'throws naming the missing section when a cited AGENTS.md section does not exist' {
        Set-Content -LiteralPath (Join-Path $script:Root 'AGENTS.md') -Encoding utf8NoBOM -Value @'
# Agent contract

## Safe start
Read before touching anything.
'@
        { & $script:ScriptPath -SliceId S1 -RepoRoot $script:Root -ErrorAction Stop } |
            Should -Throw '*Hard rules*'
    }

    It 'writes to -OutFile instead of the success stream when given one' {
        $outFile = Join-Path $script:Root 'reduced.md'

        $result = & $script:ScriptPath -SliceId S1 -RepoRoot $script:Root -OutFile $outFile

        $result | Should -BeNullOrEmpty
        Test-Path -LiteralPath $outFile | Should -BeTrue
        (Get-Content -LiteralPath $outFile -Raw) | Should -Match '## S1 — First slice'
    }

    It 'writes nothing to the repository - a pure read' {
        & $script:ScriptPath -SliceId S1 -RepoRoot $script:Root | Out-Null

        Get-Content -LiteralPath (Join-Path $script:Root 'AGENTS.md') -Raw |
            Should -Match 'Unrelated section'
        Get-Content -LiteralPath (Join-Path $script:Root 'design/20-contract.md') -Raw |
            Should -Match 'Verbatim carry-through content.'
    }
}
