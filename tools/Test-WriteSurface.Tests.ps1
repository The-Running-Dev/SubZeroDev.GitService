#Requires -Version 7.0
#Requires -Modules Pester

<#
  Test-WriteSurface.ps1 exits the process on every path (0/1/2), same reason as
  Test-DesignDrift.ps1 and Wait-PullRequestCheck.ps1: dot-sourcing skips the exit-calling
  wrapper and defines its functions in this scope instead.

  Unlike those two, the seam here is `git status` in a real target repository, not something
  worth mocking - the whole point of this script is parsing that output correctly, so these
  tests run real `git init`/`git status` against throwaway repos under $TestDrive.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Test-WriteSurface.ps1'
    $script:PreDotSourceErrorActionPreference = $ErrorActionPreference
    . $script:ScriptPath -TargetRepo $TestDrive

    function New-TestRepo {
        param([string] $Name = 'repo')
        $path = Join-Path $TestDrive $Name
        New-Item -ItemType Directory -Path $path -Force | Out-Null
        & git -C $path init --quiet -b main | Out-Null
        & git -C $path -c user.email='test@example.com' -c user.name='Test' commit --allow-empty -m 'initial' --quiet | Out-Null
        $path
    }
}

AfterAll {
    $ErrorActionPreference = $script:PreDotSourceErrorActionPreference
    Set-StrictMode -Off
}

Describe 'Test-WriteSurface' {

    It 'changes only within the allowed prefixes are InSurface, exit 0' {
        $repo = New-TestRepo -Name 'clean'
        Set-Content -LiteralPath (Join-Path $repo 'AGENTS.md') -Value 'updated'
        New-Item -ItemType Directory -Path (Join-Path $repo 'tools') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $repo 'tools/New-Thing.ps1') -Value '# new'

        $r = Invoke-WriteSurfaceCheck -TargetRepo $repo

        $r.State | Should -Be 'InSurface'
        $r.OffendingPaths.Count | Should -Be 0
        $r.ChangedPaths.Count | Should -Be 2
        Get-WriteSurfaceExitCode -State $r.State | Should -Be 0
    }

    It 'a change outside the allowed prefixes is OutOfSurface, names the path, exit 1' {
        $repo = New-TestRepo -Name 'dirty'
        New-Item -ItemType Directory -Path (Join-Path $repo 'src') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $repo 'src/App.cs') -Value 'class App {}'

        $r = Invoke-WriteSurfaceCheck -TargetRepo $repo

        $r.State | Should -Be 'OutOfSurface'
        $r.OffendingPaths.Path | Should -Contain 'src/App.cs'
        Get-WriteSurfaceExitCode -State $r.State | Should -Be 1
    }

    It 'a mixed change reports only the offending path, not the allowed one' {
        $repo = New-TestRepo -Name 'mixed'
        Set-Content -LiteralPath (Join-Path $repo 'AGENTS.md') -Value 'updated'
        Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'not kit-owned'

        $r = Invoke-WriteSurfaceCheck -TargetRepo $repo

        $r.State | Should -Be 'OutOfSurface'
        $r.OffendingPaths.Path | Should -Be @('README.md')
    }

    It 'a path not a git repository at all is NotEvaluated, exit 2, never a silent pass' {
        $notARepo = Join-Path $TestDrive 'not-a-repo'
        New-Item -ItemType Directory -Path $notARepo -Force | Out-Null

        $r = Invoke-WriteSurfaceCheck -TargetRepo $notARepo

        $r.State | Should -Be 'NotEvaluated'
        Get-WriteSurfaceExitCode -State $r.State | Should -Be 2
    }

    It '-Revert removes an untracked offending file and a re-check comes back clean' {
        $repo = New-TestRepo -Name 'revert-untracked'
        New-Item -ItemType Directory -Path (Join-Path $repo 'src') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $repo 'src/App.cs') -Value 'class App {}'

        $before = Invoke-WriteSurfaceCheck -TargetRepo $repo
        Invoke-WriteSurfaceRevert -TargetRepo $repo -OffendingItems $before.OffendingPaths

        Test-Path -LiteralPath (Join-Path $repo 'src/App.cs') | Should -BeFalse
        (Invoke-WriteSurfaceCheck -TargetRepo $repo).State | Should -Be 'InSurface'
    }

    It '-Revert restores a tracked offending file to HEAD' {
        $repo = New-TestRepo -Name 'revert-tracked'
        Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'original'
        & git -C $repo add README.md
        & git -C $repo -c user.email='test@example.com' -c user.name='Test' commit -m 'seed README' --quiet | Out-Null
        Set-Content -LiteralPath (Join-Path $repo 'README.md') -Value 'mutated by mistake'

        $before = Invoke-WriteSurfaceCheck -TargetRepo $repo
        $before.State | Should -Be 'OutOfSurface'
        Invoke-WriteSurfaceRevert -TargetRepo $repo -OffendingItems $before.OffendingPaths

        (Get-Content -LiteralPath (Join-Path $repo 'README.md') -Raw).Trim() | Should -Be 'original'
        (Invoke-WriteSurfaceCheck -TargetRepo $repo).State | Should -Be 'InSurface'
    }

    Context 'exit code map' {
        It 'maps each state, and refuses an unknown one rather than defaulting to 0' {
            Get-WriteSurfaceExitCode -State 'InSurface'    | Should -Be 0
            Get-WriteSurfaceExitCode -State 'OutOfSurface' | Should -Be 1
            Get-WriteSurfaceExitCode -State 'NotEvaluated' | Should -Be 2
            { Get-WriteSurfaceExitCode -State 'Something' } | Should -Throw
        }
    }
}
