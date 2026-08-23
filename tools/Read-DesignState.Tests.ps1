#Requires -Version 7.0
#Requires -Modules Pester

<#
  Read-DesignState.ps1 never exits the process - it has no exit-code contract, unlike
  Wait-PullRequestCheck.ps1 or Test-DesignDrift.ps1 - so these tests dot-source it purely to
  reuse its functions and skip its own invocation block, the same guard shape those two scripts
  already use.

  Every fixture below is written into $TestDrive as design/state/... under a throwaway root;
  none of these tests (other than the S4.6 closure checks, which are explicit about reading the
  real one) read the containing checkout's own design/state/. That S4.6 block asserts on adopted
  design-state content, which only this repository has: the 2026-08-19 compatibility promise
  (design/90-decisions.md) leaves the installed targets unmigrated, and this file is copied into
  every one of them. So it is skipped wherever design/state/ is absent - false and unevaluated
  rather than a false pass or a false failure, the same way Test-DesignState.ps1 itself reports
  StateSetAbsent and exits 2 rather than a silent 0.
#>

$script:ReadDesignStateSelfTestRoot = Split-Path $PSScriptRoot -Parent
$script:SkipReadDesignStateSelfTests = -not (Test-Path (Join-Path $script:ReadDesignStateSelfTestRoot 'design/state'))

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Read-DesignState.ps1'
    $script:PreDotSourceErrorActionPreference = $ErrorActionPreference
    . $script:ScriptPath -Path $TestDrive

    function New-StateFile {
        param([Parameter(Mandatory)][string] $RelativePath, [Parameter(Mandatory)][string] $Content)
        $full = Join-Path $TestDrive (Join-Path 'design/state' $RelativePath)
        New-Item -ItemType Directory -Path (Split-Path $full -Parent) -Force | Out-Null
        Set-Content -LiteralPath $full -Value $Content -Encoding utf8NoBOM
        $full
    }
}

AfterAll {
    $ErrorActionPreference = $script:PreDotSourceErrorActionPreference
    Set-StrictMode -Off
    Get-ChildItem (Join-Path $TestDrive 'design') -ErrorAction SilentlyContinue -Recurse -File |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

Describe 'Read-DesignState' {

    BeforeEach {
        Get-ChildItem (Join-Path $TestDrive 'design') -ErrorAction SilentlyContinue -Recurse -File |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    It 'S4.4: an absent design/state/ yields empty Root, zero Records, zero Failures' {
        $emptyRoot = Join-Path $TestDrive 'no-state-here'
        New-Item -ItemType Directory -Path $emptyRoot -Force | Out-Null

        $graph = Read-DesignStateGraph -Path $emptyRoot

        $graph.Root | Should -BeExactly ''
        $graph.Records.Count | Should -Be 0
        $graph.Failures.Count | Should -Be 0
    }

    It 'S4.2/S4.3: a well-formed record parses into exactly one record with zero failures' {
        New-StateFile -RelativePath 'units/command/track.md' -Content @'
# unit/command/track
Kind: command
Status: active
Anchor: .claude/commands/track.md
Consumes:
Exposes:
Binds: I28
Live: decision/2026-08-03-track-adds-to-existing-project
Archival:
Questions:
Work:
Evidence:

## Owns
Syncs design/ into GitHub issues.
'@

        $graph = Read-DesignStateGraph -Path $TestDrive

        $graph.Records.Count | Should -Be 1
        $graph.Failures.Count | Should -Be 0
        $graph.Records[0].Id | Should -Be 'unit/command/track'
        $graph.Records[0].Scalars['Status'] | Should -Be 'active'
        $graph.Records[0].Lists['Binds'] | Should -Be @('I28')
        $graph.Records[0].Prose['Owns'] | Should -Be 'Syncs design/ into GitHub issues.'
    }

    It 'S4.2: a record in which every line is malformed yields one Failures entry per unrecognised line and does not throw' {
        New-StateFile -RelativePath 'units/command/broken.md' -Content @'
this is not an id line
neither: is: this
   also not valid ##
'@

        { $script:Result = Read-DesignStateGraph -Path $TestDrive } | Should -Not -Throw

        $script:Result.Records.Count | Should -Be 0
        $script:Result.Failures.Count | Should -Be 3
        $script:Result.Failures | ForEach-Object { $_.Reason | Should -Be 'Unparseable' }
    }

    It 'S4.3: an unmatched line is reported with file, line number, and byte-for-byte text' {
        New-StateFile -RelativePath 'units/command/track.md' -Content @'
# unit/command/track
Kind: command
this line matches no production at all
Status: active
'@

        $graph = Read-DesignStateGraph -Path $TestDrive

        $graph.Failures.Count | Should -Be 1
        $f = $graph.Failures[0]
        $f.Path | Should -Be 'design/state/units/command/track.md'
        $f.Line | Should -Be 3
        $f.Text | Should -Be 'this line matches no production at all'
    }

    It 'S4.7: an Id line disagreeing with the path-implied id still parses, and the record path recovers the path id' {
        New-StateFile -RelativePath 'units/command/track.md' -Content @'
# unit/command/wrong-slug
Kind: command
Status: active
'@

        $graph = Read-DesignStateGraph -Path $TestDrive

        $graph.Records.Count | Should -Be 1
        $graph.Failures.Count | Should -Be 0
        $graph.Records[0].Id | Should -Be 'unit/command/wrong-slug'
        $graph.Records[0].Path | Should -Be 'design/state/units/command/track.md'
        $info = Get-DesignPathInfo -RelativeToState 'units/command/track.md'
        $info.PathId | Should -Be 'unit/command/track'
    }

    It 'S4.8: a field line after the first ## is reported as unparseable, not accepted as a late field' {
        New-StateFile -RelativePath 'units/command/track.md' -Content @'
# unit/command/track
Kind: command

## Owns
Some prose.
Status: active
'@

        $graph = Read-DesignStateGraph -Path $TestDrive

        $graph.Failures.Count | Should -Be 1
        $graph.Failures[0].Reason | Should -Be 'LateField'
        $graph.Failures[0].Text | Should -Be 'Status: active'
        $graph.Records[0].Scalars.ContainsKey('Status') | Should -BeFalse
    }

    It 'S4.8: a field name appearing twice in one record is reported' {
        New-StateFile -RelativePath 'units/command/track.md' -Content @'
# unit/command/track
Kind: command
Status: active
Status: retired
'@

        $graph = Read-DesignStateGraph -Path $TestDrive

        $graph.Failures.Count | Should -Be 1
        $graph.Failures[0].Reason | Should -Be 'DuplicateField'
        $graph.Records[0].Scalars['Status'] | Should -Be 'active'
    }

    It 'S4.9: a list field with nothing after the colon parses as an empty list, distinct from an omitted one' {
        New-StateFile -RelativePath 'units/command/track.md' -Content @'
# unit/command/track
Kind: command
Consumes:
Binds: I28
'@

        $graph = Read-DesignStateGraph -Path $TestDrive
        $record = $graph.Records[0]

        $record.Lists.ContainsKey('Consumes') | Should -BeTrue
        $record.Lists['Consumes'] | Should -BeNullOrEmpty
        $record.Lists.ContainsKey('Exposes') | Should -BeFalse
    }

    It 'S4.10: Consumers, BoundBy and Affects fields are unparseable - the grammar has no production for a derived edge' {
        New-StateFile -RelativePath 'units/command/track.md' -Content @'
# unit/command/track
Kind: command
Consumers: unit/command/slice
'@
        New-StateFile -RelativePath 'invariants/I17.md' -Content @'
# I17
Kind: invariant
BoundBy: unit/command/track
'@
        New-StateFile -RelativePath 'decisions/2026-08-03-x.md' -Content @'
# decision/2026-08-03-x
Affects: unit/command/track
'@

        $graph = Read-DesignStateGraph -Path $TestDrive

        $graph.Failures.Count | Should -Be 3
        $graph.Failures | ForEach-Object { $_.Reason | Should -Be 'Unparseable' }
        foreach ($record in $graph.Records) {
            $record.Scalars.ContainsKey('Consumers') | Should -BeFalse
            $record.Lists.ContainsKey('Consumers') | Should -BeFalse
            $record.Scalars.ContainsKey('BoundBy') | Should -BeFalse
            $record.Lists.ContainsKey('BoundBy') | Should -BeFalse
            $record.Scalars.ContainsKey('Affects') | Should -BeFalse
            $record.Lists.ContainsKey('Affects') | Should -BeFalse
        }
    }

    It 'writes nothing (I18): git status is empty after a run against a state set, including an all-failed one' {
        # This checks the real repository's tree, so it exercises the reader against the real
        # design/state/ this slice adds - the point is that reading it, however it parses,
        # leaves the tree exactly as it was.
        $repoRoot = Split-Path $PSScriptRoot -Parent
        $before = & git -C $repoRoot status --short
        Read-DesignStateGraph -Path $repoRoot | Out-Null
        $after = & git -C $repoRoot status --short
        $after | Should -Be $before
    }
}

Describe 'Read-DesignState against this repository''s own state set' -Skip:$script:SkipReadDesignStateSelfTests {

    BeforeAll {
        $script:RepoRoot = Split-Path $PSScriptRoot -Parent
        $script:StatusBefore = & git -C $script:RepoRoot status --short
        $script:RepoGraph = Read-DesignStateGraph -Path $script:RepoRoot
    }

    It 'S4.5: git status is unchanged by the run - including this run, whose state set may carry parse failures' {
        $after = & git -C $script:RepoRoot status --short
        $after | Should -Be $script:StatusBefore
    }

    It 'S4.6: unit/command/track and unit/document/agents-md exist and their closures are complete' {
        $byId = @{}
        foreach ($r in $script:RepoGraph.Records) { $byId[$r.Id] = $r }

        $byId.ContainsKey('unit/command/track') | Should -BeTrue
        $byId.ContainsKey('unit/document/agents-md') | Should -BeTrue

        foreach ($unitId in @('unit/command/track', 'unit/document/agents-md')) {
            $record = $byId[$unitId]
            $named = [System.Collections.Generic.List[string]]::new()
            foreach ($field in 'Consumes', 'Exposes', 'Binds', 'Live', 'Questions', 'Work') {
                if ($record.Lists.ContainsKey($field)) {
                    foreach ($id in @($record.Lists[$field])) { $named.Add([string]$id) }
                }
            }
            foreach ($id in $named) {
                $byId.ContainsKey($id) | Should -BeTrue -Because "$unitId names $id directly, so its closure needs a record for it"
            }
        }
    }
}
