#Requires -Version 7.0
#Requires -Modules Pester

<#
  Update-DesignProjection.ps1 exits the process on real invocation, so these tests dot-source it
  purely to reuse its functions and skip its own invocation block - the same guard shape
  Test-DesignState.ps1, Read-DesignState.ps1 and Test-DesignDrift.ps1 already use.

  Every fixture below is written into $TestDrive under a throwaway root; the final Describe
  block is explicit about reading the containing checkout's own tree instead - it asserts on
  adopted design-state content, which only this repository has: the 2026-08-19 compatibility
  promise (design/90-decisions.md) leaves the installed targets unmigrated, and this file is
  copied into every one of them. So it is skipped wherever design/state/units/ is absent - false and
  unevaluated rather than a false pass or a false failure, the same way Test-DesignState.ps1
  itself reports StateSetAbsent and exits 2 rather than a silent 0.
#>

$script:DesignProjectionSelfTestRoot = Split-Path $PSScriptRoot -Parent
$script:SkipDesignProjectionSelfTests = -not (Test-Path (Join-Path $script:DesignProjectionSelfTestRoot 'design/state/units'))

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Update-DesignProjection.ps1'
    . $script:ScriptPath -Path $TestDrive

    function New-StateFile {
        param([Parameter(Mandatory)][string] $RelativePath, [Parameter(Mandatory)][string] $Content)
        $full = Join-Path $TestDrive (Join-Path 'design/state' $RelativePath)
        New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
        Set-Content -LiteralPath $full -Value $Content -Encoding utf8NoBOM
        $full
    }

    function New-TreeFile {
        param([Parameter(Mandatory)][string] $RelativePath, [Parameter(Mandatory)][string] $Content)
        $full = Join-Path $TestDrive $RelativePath
        New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
        Set-Content -LiteralPath $full -Value $Content -Encoding utf8NoBOM
        $full
    }

    function Clear-Drive {
        Get-ChildItem $TestDrive -ErrorAction SilentlyContinue -Recurse -File | Remove-Item -Force -ErrorAction SilentlyContinue
        Get-ChildItem $TestDrive -ErrorAction SilentlyContinue -Recurse -Directory | Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
    }

    function New-UnitFixture {
        New-StateFile -RelativePath 'units/command/track.md' -Content @'
# unit/command/track
Kind: command
Status: active
Anchor: .claude/commands/track.md
Binds: I28

## Owns
Syncs design/ into issues.
'@
        New-StateFile -RelativePath 'invariants/I28.md' -Content @'
# I28
Kind: invariant
Status: active
Anchor: I28
Owner: unit/command/track
Enforcement: instruction

## Statement
GitHub is the authority.
'@
    }
}

Describe 'Update-DesignProjection: rendering' {

    BeforeEach { Clear-Drive }

    It 'S7.1: renders the units projection as a table of id, kind, anchor' {
        New-UnitFixture
        $graph = Read-DesignStateGraph -Path $TestDrive
        $content = (Get-UnitsProjectionContent -Records $graph.Records) -join "`n"
        $content | Should -Match '\| `unit/command/track` \| command \| `\.claude/commands/track\.md` \|'
    }

    It 'S7.1: bound-by lists the units that bind each invariant' {
        New-UnitFixture
        $graph = Read-DesignStateGraph -Path $TestDrive
        $content = (Get-BoundByProjectionContent -Records $graph.Records) -join "`n"
        $content | Should -Match '\| I28 \| `unit/command/track` \|'
    }

    It 'S7.1: consumers, decision-affects and question-affects render an honest empty table with no records' {
        New-UnitFixture
        $graph = Read-DesignStateGraph -Path $TestDrive
        (Get-ConsumersProjectionContent -Records $graph.Records) -join "`n" | Should -Match 'no contract records yet'
        (Get-DecisionAffectsProjectionContent -Records $graph.Records) -join "`n" | Should -Match 'no decision records yet'
        (Get-QuestionAffectsProjectionContent -Records $graph.Records) -join "`n" | Should -Match 'no question records yet'
    }

    It 'S7.1: invariants renders Statement, Owner, Enforcement and Evidence from the record' {
        New-UnitFixture
        $graph = Read-DesignStateGraph -Path $TestDrive
        $content = (Get-InvariantsProjectionContent -Records $graph.Records) -join "`n"
        $content | Should -Match '\*\*I28\*\* \| GitHub is the authority\. \| `unit/command/track` \| instruction \| — \|'
    }

    It 'S7.10: the agent projection renders from a WorkRef''s own fields and calls no gh' {
        Mock -CommandName gh -MockWith { throw 'gh must never be called by the projector' }
        $record = New-DesignRecord -Id 'work/7' -Kind 'WorkRef' -Path 'design/state/work/7.md' `
            -Scalars @{ Issue = '7'; Title = 'S7 — test slice'; MirroredAt = 'deadbeef' } `
            -Lists @{ Criteria = @('S7.1', 'S7.2') } -Prose @{}
        $content = (Get-AgentProjectionContent -Record $record) -join "`n"
        $content | Should -Match 'Run `/slice S7`\.'
        $content | Should -Match 'S7 @ `deadbeef`'
        $content | Should -Match 'S7\.1, S7\.2'
    }

    It 'S14.8: outstanding renders an honest empty table with no WorkRef records' {
        New-UnitFixture
        $graph = Read-DesignStateGraph -Path $TestDrive
        (Get-OutstandingProjectionContent -Records $graph.Records) -join "`n" | Should -Match 'no outstanding WorkRef records yet'
    }

    It 'S14.8: outstanding renders an OPEN WorkRef''s rank, issue, title, criteria and mirror commit' {
        $record = New-DesignRecord -Id 'work/57' -Kind 'WorkRef' -Path 'design/state/work/57.md' `
            -Scalars @{ Issue = '57'; Title = 'S14 — Work state'; State = 'OPEN'; Rank = '3'; MirroredAt = 'abc1234' } `
            -Lists @{ Criteria = @('S14.1', 'S14.2') } -Prose @{}
        $content = (Get-OutstandingProjectionContent -Records @($record)) -join "`n"
        $content | Should -Match '\| 3 \| #57 \| S14 — Work state \| S14\.1, S14\.2 \| `abc1234` \|'
    }

    It 'S14.8: outstanding excludes a CLOSED WorkRef - closed work is not outstanding' {
        $open = New-DesignRecord -Id 'work/1' -Kind 'WorkRef' -Path 'design/state/work/1.md' `
            -Scalars @{ Issue = '1'; Title = 'Open one'; State = 'OPEN'; Rank = '1'; MirroredAt = 'sha' } -Lists @{} -Prose @{}
        $closed = New-DesignRecord -Id 'work/2' -Kind 'WorkRef' -Path 'design/state/work/2.md' `
            -Scalars @{ Issue = '2'; Title = 'Closed one'; State = 'CLOSED'; Rank = '2'; MirroredAt = 'sha' } -Lists @{} -Prose @{}
        $content = (Get-OutstandingProjectionContent -Records @($open, $closed)) -join "`n"
        $content | Should -Match 'Open one'
        $content | Should -Not -Match 'Closed one'
    }

    It 'S14.8: outstanding orders numeric ranks low-to-high, with a non-numeric rank sorting after every numeric one' {
        $third  = New-DesignRecord -Id 'work/30' -Kind 'WorkRef' -Path 'design/state/work/30.md' `
            -Scalars @{ Issue = '30'; Title = 'Third'; State = 'OPEN'; Rank = '5'; MirroredAt = 'sha' } -Lists @{} -Prose @{}
        $first  = New-DesignRecord -Id 'work/10' -Kind 'WorkRef' -Path 'design/state/work/10.md' `
            -Scalars @{ Issue = '10'; Title = 'First'; State = 'OPEN'; Rank = '1'; MirroredAt = 'sha' } -Lists @{} -Prose @{}
        $last   = New-DesignRecord -Id 'work/20' -Kind 'WorkRef' -Path 'design/state/work/20.md' `
            -Scalars @{ Issue = '20'; Title = 'Last'; State = 'OPEN'; Rank = 'milestone/9'; MirroredAt = 'sha' } -Lists @{} -Prose @{}
        $content = (Get-OutstandingProjectionContent -Records @($third, $first, $last)) -join "`n"
        (($content -split "`n") | Where-Object { $_ -match 'First|Third|Last' }) | Should -Be @(
            '| 1 | #10 | First | — | `sha` |'
            '| 5 | #30 | Third | — | `sha` |'
            '| milestone/9 | #20 | Last | — | `sha` |'
        )
    }
}

Describe 'Update-DesignProjection: region location and refusal (S7.7, I29)' {

    It 'finds a well-formed bare region' {
        $lines = @('a', '<!-- x:start -->', 'body', '<!-- x:end -->', 'b')
        $loc = Find-BareRegion -Lines $lines -Id 'x'
        $loc.Found | Should -BeTrue
        $loc.StartIndex | Should -Be 1
        $loc.EndIndex | Should -Be 3
    }

    It 'reports Found = $false, Refuse = $false when no region exists for the id' {
        $lines = @('a', 'b')
        $loc = Find-BareRegion -Lines $lines -Id 'x'
        $loc.Found | Should -BeFalse
        $loc.Refuse | Should -BeFalse
    }

    It 'S7.7: refuses a region with two start markers, naming RegionMalformed' {
        $lines = @('<!-- x:start -->', '<!-- x:start -->', '<!-- x:end -->')
        $loc = Find-BareRegion -Lines $lines -Id 'x'
        $loc.Refuse | Should -BeTrue
        $loc.Reason | Should -Be 'RegionMalformed'
    }

    It 'S7.7: refuses a region whose end precedes its start' {
        $lines = @('<!-- x:end -->', '<!-- x:start -->')
        $loc = Find-BareRegion -Lines $lines -Id 'x'
        $loc.Refuse | Should -BeTrue
        $loc.Reason | Should -Be 'RegionMalformed'
    }

    It 'S7.6/I29: refuses (never writes) when the id is a declared region' {
        $lines = @('<!-- x:declared:start -->', 'hand-written', '<!-- x:declared:end -->')
        $loc = Find-BareRegion -Lines $lines -Id 'x'
        $loc.Refuse | Should -BeTrue
        $loc.Reason | Should -Be 'DeclaredRegion'
    }
}

Describe 'Update-DesignProjection: end-to-end write behaviour' {

    BeforeEach {
        Clear-Drive
        New-UnitFixture
        New-TreeFile -RelativePath 'design/state-index.md' -Content @'
# Index

## Units

<!-- units:start -->
<!-- units:end -->

## Bound by

<!-- bound-by:start -->
<!-- bound-by:end -->

## Consumers

<!-- consumers:start -->
<!-- consumers:end -->

## Decision affects

<!-- decision-affects:start -->
<!-- decision-affects:end -->

## Question affects

<!-- question-affects:start -->
<!-- question-affects:end -->
'@
        New-TreeFile -RelativePath 'design/20-contract.md' -Content @'
# Contract

## Invariants

<!-- invariants:start -->
<!-- invariants:end -->

Hand-authored tail, outside every region.
'@
    }

    It 'S7.2: -DryRun renders regions and writes nothing to disk' {
        Push-Location $TestDrive
        try {
            & git init --quiet 2>$null
            & git config user.email 'test@example.com' 2>$null
            & git config user.name 'Test' 2>$null
            & git add -A 2>$null
            & git commit --quiet -m 'seed' 2>$null

            $before = & git status --short
            $result = Invoke-DesignProjection -RepoPath $TestDrive -DryRun
            $after = & git status --short

            $after | Should -Be $before
            ($result.Regions | Where-Object { $_.Id -eq 'units' }).Content | Should -Match 'unit/command/track'
        } finally {
            Pop-Location
        }
    }

    It 'S7.4: a hand edit inside a region is gone after regeneration; a hand edit outside survives' {
        $contractPath = Join-Path $TestDrive 'design/20-contract.md'
        $lines = @(Get-Content -LiteralPath $contractPath)
        $lines = $lines -replace '<!-- invariants:end -->', "stale hand-written row`n<!-- invariants:end -->"
        Set-Content -LiteralPath $contractPath -Value ($lines -join "`n") -NoNewline -Encoding utf8NoBOM

        $null = Invoke-DesignProjection -RepoPath $TestDrive
        $after = Get-Content -LiteralPath $contractPath -Raw

        $after | Should -Not -Match 'stale hand-written row'
        $after | Should -Match 'Hand-authored tail, outside every region\.'
    }

    It 'S7.3: regenerating twice produces byte-identical files' {
        $null = Invoke-DesignProjection -RepoPath $TestDrive
        $pass1 = Get-Content -LiteralPath (Join-Path $TestDrive 'design/state-index.md') -Raw
        $null = Invoke-DesignProjection -RepoPath $TestDrive
        $pass2 = Get-Content -LiteralPath (Join-Path $TestDrive 'design/state-index.md') -Raw
        $pass2 | Should -Be $pass1
    }

    It 'S7.3: regenerating one region leaves every other region''s rendered output unchanged' {
        $null = Invoke-DesignProjection -RepoPath $TestDrive
        $before = Get-Content -LiteralPath (Join-Path $TestDrive 'design/state-index.md') -Raw

        # A second, unrelated record is added and regenerated - only bound-by's row set can grow;
        # units' own render for the pre-existing record must not move.
        New-StateFile -RelativePath 'decisions/2026-01-01-example.md' -Content @'
# decision/2026-01-01-example
Date: 2026-01-01
Anchor: 2026-01-01 - example
Status: accepted

## Claim
An example claim.
'@
        $null = Invoke-DesignProjection -RepoPath $TestDrive
        $after = Get-Content -LiteralPath (Join-Path $TestDrive 'design/state-index.md') -Raw

        # The units table (unaffected by the new decision) is byte-identical between runs.
        $unitsBefore = ($before -split "`n" | Select-String -Pattern 'unit/command/track')
        $unitsAfter = ($after -split "`n" | Select-String -Pattern 'unit/command/track')
        "$unitsAfter" | Should -Be "$unitsBefore"
    }

    It 'S7.5: a document with no region for the target id is refused, not created' {
        Remove-Item -LiteralPath (Join-Path $TestDrive 'design/state-index.md') -Force
        New-TreeFile -RelativePath 'design/state-index.md' -Content "# Index`n`nNo regions here.`n"

        $result = Invoke-DesignProjection -RepoPath $TestDrive
        (@($result.Refusals | Where-Object { $_.Id -eq 'units' -and $_.Reason -eq 'RegionMissing' })).Count | Should -Be 1

        $after = Get-Content -LiteralPath (Join-Path $TestDrive 'design/state-index.md') -Raw
        $after | Should -Not -Match ':start -->'
    }

    It 'S7.6/I29: a declared region for the same id is refused and left untouched' {
        $contractPath = Join-Path $TestDrive 'design/20-contract.md'
        Set-Content -LiteralPath $contractPath -Value @'
# Contract

## Invariants

<!-- invariants:declared:start -->
hand-authored, never overwritten
<!-- invariants:declared:end -->
'@ -Encoding utf8NoBOM

        $before = Get-Content -LiteralPath $contractPath -Raw
        $result = Invoke-DesignProjection -RepoPath $TestDrive
        $after = Get-Content -LiteralPath $contractPath -Raw

        $after | Should -Be $before
        (@($result.Refusals | Where-Object { $_.Id -eq 'invariants' -and $_.Reason -eq 'DeclaredRegion' })).Count | Should -Be 1
    }

    It 'S7.8: rendering into an empty region and into one already holding stale content produces identical bytes' {
        $null = Invoke-DesignProjection -RepoPath $TestDrive
        $freshRender = Get-Content -LiteralPath (Join-Path $TestDrive 'design/20-contract.md') -Raw

        # Re-seed with the SAME empty region, run again (empty -> rendered).
        New-TreeFile -RelativePath 'design/20-contract.md' -Content @'
# Contract

## Invariants

<!-- invariants:start -->
<!-- invariants:end -->

Hand-authored tail, outside every region.
'@
        $null = Invoke-DesignProjection -RepoPath $TestDrive
        $fromEmpty = Get-Content -LiteralPath (Join-Path $TestDrive 'design/20-contract.md') -Raw

        # Re-seed with STALE content already inside the region, run again (stale -> rendered).
        New-TreeFile -RelativePath 'design/20-contract.md' -Content @'
# Contract

## Invariants

<!-- invariants:start -->
| this is stale content that does not match any record |
<!-- invariants:end -->

Hand-authored tail, outside every region.
'@
        $null = Invoke-DesignProjection -RepoPath $TestDrive
        $fromStale = Get-Content -LiteralPath (Join-Path $TestDrive 'design/20-contract.md') -Raw

        $fromEmpty | Should -Be $freshRender
        $fromStale | Should -Be $freshRender
    }
}

Describe 'Update-DesignProjection against this repository''s own tree' -Skip:$script:SkipDesignProjectionSelfTests {

    BeforeAll {
        $script:RepoRoot = Split-Path $PSScriptRoot -Parent

        <#
          A real, non-DryRun run against $script:RepoRoot writes real files - if the repo
          is not already at its fixed point, the run's own idempotence assertion is exactly
          the thing that can fail, and without this guard the mutated file would be left
          behind (issue #161). Snapshot the affected files first and restore them in a
          finally, the same pattern S18.6 in Test-DesignState.Tests.ps1 already uses, so a
          failure here can never leave the real checkout dirty.
        #>
        function Backup-RestoreOnFailure {
            param(
                [Parameter(Mandatory)][string[]] $Path,
                [Parameter(Mandatory)][scriptblock] $Body
            )
            $originals = @{}
            foreach ($p in $Path) { $originals[$p] = Get-Content -LiteralPath $p -Raw }
            try {
                & $Body
            } finally {
                foreach ($p in $Path) {
                    Set-Content -LiteralPath $p -Value $originals[$p] -Encoding utf8NoBOM -NoNewline
                }
            }
        }
    }

    It 'S7.2: -DryRun against the real repository writes nothing' {
        $before = & git -C $script:RepoRoot status --short
        $result = Invoke-DesignProjection -RepoPath $script:RepoRoot -DryRun
        $after = & git -C $script:RepoRoot status --short
        $after | Should -Be $before
        $result.Refusals.Count | Should -Be 0
    }

    It 'S7.3: a real, non-DryRun run against this repository is already at its fixed point (idempotent)' {
        $contractPath = Join-Path $script:RepoRoot 'design/20-contract.md'
        $stateIndexPath = Join-Path $script:RepoRoot 'design/state-index.md'
        Backup-RestoreOnFailure -Path @($contractPath, $stateIndexPath) -Body {
            $before = & git -C $script:RepoRoot status --short
            $null = Invoke-DesignProjection -RepoPath $script:RepoRoot
            $after = & git -C $script:RepoRoot status --short
            # The real design/20-contract.md and design/state-index.md are committed already
            # regenerated - a real run must not find anything to change.
            $after | Should -Be $before
        }
    }

    It 'regression (issue #161): Backup-RestoreOnFailure restores the real files even when the wrapped run fails' {
        # A scratch git repo standing in for "the real repository" so this test can force
        # real drift without ever mutating this checkout's own tracked files.
        $scratchRoot = Join-Path $TestDrive 'issue-161-scratch-repo'
        New-Item -ItemType Directory -Path $scratchRoot -Force | Out-Null

        New-Item -ItemType Directory -Path (Join-Path $scratchRoot 'design/state/units/command') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $scratchRoot 'design/state/units/command/track.md') -Encoding utf8NoBOM -Value @'
# unit/command/track
Kind: command
Status: active
Anchor: .claude/commands/track.md
Binds: I28

## Owns
Syncs design/ into issues.
'@
        New-Item -ItemType Directory -Path (Join-Path $scratchRoot 'design/state/invariants') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $scratchRoot 'design/state/invariants/I28.md') -Encoding utf8NoBOM -Value @'
# I28
Kind: invariant
Status: active
Anchor: I28
Owner: unit/command/track
Enforcement: instruction

## Statement
GitHub is the authority.
'@

        # design/20-contract.md seeded with STALE content inside the invariants region: a
        # real, non-DryRun run against this fixture WILL rewrite it - this is the "real
        # drift" case the unguarded S7.3 pattern could not survive.
        $scratchContractPath = Join-Path $scratchRoot 'design/20-contract.md'
        Set-Content -LiteralPath $scratchContractPath -Encoding utf8NoBOM -Value @'
# Contract

## Invariants

<!-- invariants:start -->
| this is stale content that does not match any record |
<!-- invariants:end -->

Hand-authored tail, outside every region.
'@
        $scratchStateIndexPath = Join-Path $scratchRoot 'design/state-index.md'
        Set-Content -LiteralPath $scratchStateIndexPath -Encoding utf8NoBOM -Value @'
# State Index

## Units
<!-- units:start -->
<!-- units:end -->

## Bound by
<!-- bound-by:start -->
<!-- bound-by:end -->

## Consumers
<!-- consumers:start -->
<!-- consumers:end -->

## Decision affects
<!-- decision-affects:start -->
<!-- decision-affects:end -->

## Question affects
<!-- question-affects:start -->
<!-- question-affects:end -->

## Outstanding
<!-- outstanding:start -->
<!-- outstanding:end -->
'@

        $contractBefore = Get-Content -LiteralPath $scratchContractPath -Raw
        $stateIndexBefore = Get-Content -LiteralPath $scratchStateIndexPath -Raw

        {
            Backup-RestoreOnFailure -Path @($scratchContractPath, $scratchStateIndexPath) -Body {
                $null = Invoke-DesignProjection -RepoPath $scratchRoot
                # Confirm the wrapped run actually mutated the file - the drift is real.
                (Get-Content -LiteralPath $scratchContractPath -Raw) | Should -Not -Be $contractBefore
                throw 'forced failure standing in for a failing S7.3 idempotence assertion'
            }
        } | Should -Throw -ExpectedMessage 'forced failure standing in for a failing S7.3 idempotence assertion'

        (Get-Content -LiteralPath $scratchContractPath -Raw) | Should -Be $contractBefore
        (Get-Content -LiteralPath $scratchStateIndexPath -Raw) | Should -Be $stateIndexBefore
    }
}
