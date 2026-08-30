#Requires -Version 7.0
#Requires -Modules Pester

<#
  Invoke-DoneHousekeeping.ps1 has no exit-calling wrapper - it runs to completion and
  returns its report object on the pipeline - so these tests invoke it end-to-end via `&`
  against real git repos under $TestDrive, including a real second `git worktree`, the same
  "not worth mocking" reasoning Sync-Kit.Tests.ps1 gives for its own script.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Invoke-DoneHousekeeping.ps1'

    function New-GitRepo {
        param([Parameter(Mandatory)][string] $Path)
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        & git init --quiet -b main $Path | Out-Null
        & git -C $Path -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'initial' | Out-Null
        $Path
    }

    function New-MergedWorktreeBranch {
        # Creates 'feature/foo' off main, merges it back into main with a real merge
        # commit (so it shows up in --merged without being a fast-forward no-op), then
        # checks it out in a second worktree - reproducing the '+ feature/foo' decoration
        # `git branch --merged` only adds to a branch checked out somewhere other than the
        # current worktree.
        param([Parameter(Mandatory)][string] $RepoPath, [Parameter(Mandatory)][string] $WorktreePath)
        & git -C $RepoPath checkout --quiet -b feature/foo | Out-Null
        & git -C $RepoPath -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'feature work' | Out-Null
        & git -C $RepoPath checkout --quiet main | Out-Null
        & git -C $RepoPath -c user.email='test@example.com' -c user.name='Test' merge --no-ff --quiet feature/foo -m 'merge feature/foo' | Out-Null
        & git -C $RepoPath worktree add --quiet $WorktreePath feature/foo *>$null
    }

    function New-UnmergedBranch {
        # A branch with a commit that never lands on main, so `git branch --merged` cannot
        # confirm it and it falls through to the squash-merge cross-check - the only path
        # where the headRefOid comparison runs.
        param([Parameter(Mandatory)][string] $RepoPath, [Parameter(Mandatory)][string] $Branch)
        & git -C $RepoPath checkout --quiet -b $Branch | Out-Null
        & git -C $RepoPath -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'squashed work' | Out-Null
        & git -C $RepoPath checkout --quiet main | Out-Null
        (& git -C $RepoPath rev-parse $Branch).Trim()
    }

    function New-FakeGh {
        # Invoke-DoneHousekeeping.ps1 shells out to `gh` directly, so there is no seam to
        # Mock - it is invoked end-to-end via `&`. Put a stub named `gh` first on PATH
        # instead: PowerShell resolves a bare `gh` through PATH and will run a .ps1 found
        # there. The stub answers only the merged-PR query the script makes, from two
        # environment variables the test sets.
        param([Parameter(Mandatory)][string] $BinDir)
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
        $stub = @'
param()
$argv = $args
$headIdx = [array]::IndexOf($argv, '--head')
$branch = if ($headIdx -ge 0) { $argv[$headIdx + 1] } else { $null }
if ($branch -and $branch -eq $env:FAKE_GH_BRANCH) {
    $oid = $env:FAKE_GH_HEAD_OID
    Write-Output "[{""number"":1,""url"":""https://example.invalid/pr/1"",""mergeCommit"":{""oid"":""abc123""},""headRefOid"":""$oid""}]"
} else {
    Write-Output '[]'
}
exit 0
'@
        Set-Content -LiteralPath (Join-Path $BinDir 'gh.ps1') -Value $stub -Encoding utf8NoBOM
        $BinDir
    }
}

Describe 'Invoke-DoneHousekeeping' {

    Context 'a merged branch checked out in another worktree' {

        It 'parses to its bare name in Candidates, not the "+ " decoration git branch --merged adds' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-candidates')
            $wt = Join-Path $TestDrive 'wt-candidates'
            New-MergedWorktreeBranch -RepoPath $repo -WorktreePath $wt

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull

            $result.Stopped | Should -Be $false
            $branchNames = @($result.Candidates | ForEach-Object Branch)
            $branchNames | Should -Contain 'feature/foo'
            $branchNames | Should -Not -Contain '+ feature/foo'
        }

        It 'is refused on delete with a reason naming the blocking worktree path, distinct from a not-merged refusal' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-delete')
            $wt = Join-Path $TestDrive 'wt-delete'
            New-MergedWorktreeBranch -RepoPath $repo -WorktreePath $wt

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull -DeleteBranches 'feature/foo'

            $result.Deleted | Should -Not -Contain 'feature/foo'
            $refusal = $result.Refused | Where-Object Branch -eq 'feature/foo'
            $refusal | Should -Not -BeNullOrEmpty
            # git's own "used by worktree at '<path>'" output always uses forward slashes,
            # even on Windows where $wt (built from $TestDrive) uses backslashes - normalise
            # both sides before comparing rather than asserting on separator-sensitive text.
            $refusal.Reason.Replace('\', '/') | Should -Match ([regex]::Escape($wt.Replace('\', '/')))
            $refusal.Reason | Should -Not -Match "Not in --merged"
        }

        It 'is deleted once the blocking worktree is removed' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-clean')
            $wt = Join-Path $TestDrive 'wt-clean'
            New-MergedWorktreeBranch -RepoPath $repo -WorktreePath $wt
            & git -C $repo worktree remove --force $wt | Out-Null

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull -DeleteBranches 'feature/foo'

            $result.Deleted | Should -Contain 'feature/foo'
            @($result.Refused | Where-Object Branch -eq 'feature/foo') | Should -BeNullOrEmpty
        }
    }

    Context 'a squash-merged branch, cross-checked against the merged PR head' {

        BeforeEach {
            $script:SavedPath = $env:PATH
            $script:Bin = New-FakeGh -BinDir (Join-Path $TestDrive ([guid]::NewGuid().ToString('n')))
            $env:PATH = "$script:Bin$([IO.Path]::PathSeparator)$env:PATH"
            $env:FAKE_GH_BRANCH = 'fix/squashed'
        }

        AfterEach {
            $env:PATH = $script:SavedPath
            Remove-Item Env:FAKE_GH_BRANCH -ErrorAction SilentlyContinue
            Remove-Item Env:FAKE_GH_HEAD_OID -ErrorAction SilentlyContinue
        }

        It 'is a force-delete candidate when the local tip is exactly the head that merged' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-tip-match')
            $env:FAKE_GH_HEAD_OID = New-UnmergedBranch -RepoPath $repo -Branch 'fix/squashed'

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull

            @($result.SquashMergeCandidates | ForEach-Object Branch) | Should -Contain 'fix/squashed'
            @($result.TipAheadOfMergedPr | ForEach-Object Branch) | Should -Not -Contain 'fix/squashed'
        }

        It 'is NOT a force-delete candidate when commits sit on top of the merged head' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-tip-ahead')
            $mergedHead = New-UnmergedBranch -RepoPath $repo -Branch 'fix/squashed'
            $env:FAKE_GH_HEAD_OID = $mergedHead
            # One more commit after the PR merged - the exact case `gh pr list --head` still
            # reports as merged and `-D` would silently discard.
            & git -C $repo checkout --quiet 'fix/squashed' | Out-Null
            & git -C $repo -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'after the merge' | Out-Null
            & git -C $repo checkout --quiet main | Out-Null

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull

            @($result.SquashMergeCandidates | ForEach-Object Branch) | Should -Not -Contain 'fix/squashed'
            $ahead = $result.TipAheadOfMergedPr | Where-Object Branch -eq 'fix/squashed'
            $ahead | Should -Not -BeNullOrEmpty
            $ahead.MergedHead | Should -Be $mergedHead
            $ahead.Reason | Should -Match 'no merged PR accounts for'
        }

        It 'refuses -ForceDeleteBranches for a branch whose tip is ahead of the merged head' {
            $repo = New-GitRepo -Path (Join-Path $TestDrive 'repo-tip-ahead-force')
            $env:FAKE_GH_HEAD_OID = New-UnmergedBranch -RepoPath $repo -Branch 'fix/squashed'
            & git -C $repo checkout --quiet 'fix/squashed' | Out-Null
            & git -C $repo -c user.email='test@example.com' -c user.name='Test' commit --allow-empty --quiet -m 'after the merge' | Out-Null
            & git -C $repo checkout --quiet main | Out-Null

            $result = & $script:ScriptPath -RepoRoot $repo -DefaultBranch main -SkipPull -ForceDeleteBranches 'fix/squashed'

            $result.Deleted | Should -Not -Contain 'fix/squashed'
            (& git -C $repo rev-parse --verify 'fix/squashed' 2>$null) | Should -Not -BeNullOrEmpty
            $refusal = $result.Refused | Where-Object Branch -eq 'fix/squashed'
            $refusal | Should -Not -BeNullOrEmpty
        }
    }
}
