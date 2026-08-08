#Requires -Version 7.0
#Requires -Modules Pester

<#
  Covers the -TranscriptPath, -Hook, and -Watch paths against fixture JSONL,
  since those are the three ways the script is actually invoked (report,
  SessionEnd hook, UserPromptSubmit hook). Resolve-TranscriptDirectory's
  $HOME-derived auto-discovery is not covered here: it needs a real
  ~/.claude/projects layout to exercise honestly, and every other code path
  reaches the same logic through -TranscriptPath.

  -Hook and -Watch read real console stdin (Console.In.ReadToEnd()), which a
  PowerShell pipeline into `& $script` does not feed - that binds to $input
  instead. Those two are invoked as `pwsh -File` child processes instead, the
  same way Claude Code actually launches them as hooks.

  -Hook tests run against a copy of the script under a fake tools/ so its
  hardcoded log path (../.claude/session-costs.tsv relative to the script)
  lands in TestDrive instead of this repository's real log.
#>

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot 'Measure-Session.ps1'
}

Describe 'Measure-Session -TranscriptPath' {
    BeforeAll {
        function New-TranscriptFile {
            param([string]$Name, [string[]]$Lines)
            $path = Join-Path $script:FixtureDir $Name
            Set-Content -LiteralPath $path -Value $Lines -Encoding utf8NoBOM
            return $path
        }
    }

    BeforeEach {
        $script:FixtureDir = Join-Path $TestDrive 'transcripts'
        New-Item -ItemType Directory -Path $script:FixtureDir -Force | Out-Null
    }

    It 'emits JSON by default with the session total' {
        New-TranscriptFile -Name 'sess-a.jsonl' -Lines @(
            '{"type":"user","timestamp":"2026-01-01T10:00:00Z","message":{"role":"user","content":"hi"}}'
            '{"type":"assistant","timestamp":"2026-01-01T10:00:05Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":40}}}'
            '{"type":"assistant","timestamp":"2026-01-01T10:00:15Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}}'
        )

        $json = (& $script:ScriptPath -TranscriptPath $script:FixtureDir) -join "`n" | ConvertFrom-Json

        $json.sessions.Count | Should -Be 1
        $json.sessions[0].total.calls | Should -Be 2
        $json.sessions[0].total.input | Should -Be 11
        $json.sessions[0].total.cacheCreate | Should -Be 22
        $json.sessions[0].total.cacheRead | Should -Be 33
        $json.sessions[0].total.output | Should -Be 44
        $json.sessions[0].PSObject.Properties.Name | Should -Not -Contain 'segments'
    }

    It 'sums usage across calls into a session total (-Human)' {
        New-TranscriptFile -Name 'sess-a.jsonl' -Lines @(
            '{"type":"user","timestamp":"2026-01-01T10:00:00Z","message":{"role":"user","content":"hi"}}'
            '{"type":"assistant","timestamp":"2026-01-01T10:00:05Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":40}}}'
            '{"type":"assistant","timestamp":"2026-01-01T10:00:15Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}}'
        )

        $text = (& $script:ScriptPath -TranscriptPath $script:FixtureDir -Human) -join "`n"

        $text | Should -Match 'session total\s+2\s+11\s+22\s+33\s+44'
    }

    It 'includes segments in JSON only in -Detail mode, attributing follow-up calls to the command' {
        New-TranscriptFile -Name 'sess-b.jsonl' -Lines @(
            '{"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}'
            '{"type":"user","timestamp":"2026-01-01T10:00:05Z","message":{"role":"user","content":"<command-name>foo</command-name>"}}'
            '{"type":"assistant","timestamp":"2026-01-01T10:00:10Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}'
        )

        $json = (& $script:ScriptPath -TranscriptPath $script:FixtureDir -Detail) -join "`n" | ConvertFrom-Json

        $segments = ($json.sessions | Where-Object id -eq 'sess-b').segments
        ($segments | Where-Object label -eq '(no command)').input | Should -Be 10
        ($segments | Where-Object label -eq 'foo').input | Should -Be 1
    }

    It 'splits segments on slash commands in -Detail -Human mode, attributing follow-up calls to the command' {
        New-TranscriptFile -Name 'sess-b.jsonl' -Lines @(
            '{"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}'
            '{"type":"user","timestamp":"2026-01-01T10:00:05Z","message":{"role":"user","content":"<command-name>foo</command-name>"}}'
            '{"type":"assistant","timestamp":"2026-01-01T10:00:10Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}'
        )

        $text = (& $script:ScriptPath -TranscriptPath $script:FixtureDir -Detail -Human) -join "`n"

        $text | Should -Match '\(no command\)\s+1\s+10\s+0\s+0\s+0'
        $text | Should -Match 'foo\s+1\s+1\s+0\s+0\s+0'
    }

    It 'throws when -SessionId matches no transcript' {
        New-TranscriptFile -Name 'sess-c.jsonl' -Lines @(
            '{"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":1}}}'
        )

        { & $script:ScriptPath -TranscriptPath $script:FixtureDir -SessionId 'nope' } | Should -Throw '*No transcripts matched*'
    }
}

Describe 'Measure-Session vendor guards' {
    <#
      The negative half of the contract. Every case here is a shape that used
      to produce a table of zeros, which is the one output a measurement tool
      must never emit - it cannot be told apart from a session that was free.

      The Codex fixture is trimmed from a real ~/.codex rollout: a session_meta
      header and a token_count event, keeping the field names that detection
      keys on.
    #>

    BeforeAll {
        function New-TranscriptFile {
            param([string]$Name, [string[]]$Lines)
            $path = Join-Path $script:FixtureDir $Name
            Set-Content -LiteralPath $path -Value $Lines -Encoding utf8NoBOM
            return $path
        }
    }

    BeforeEach {
        $script:FixtureDir = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Path $script:FixtureDir -Force | Out-Null
    }

    It 'refuses a Codex transcript instead of reporting zero' {
        New-TranscriptFile -Name 'rollout-2026-07-30T03-43-51-019fb07a.jsonl' -Lines @(
            '{"timestamp":"2026-07-30T03:43:51.000Z","type":"session_meta","payload":{"session_id":"019fb07a","cwd":"D:\\repo","originator":"Codex Desktop","source":"vscode"}}'
            '{"timestamp":"2026-07-30T03:44:10.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":539135,"cached_input_tokens":493312,"cache_write_input_tokens":0,"output_tokens":2900,"reasoning_output_tokens":693,"total_tokens":542035}}}}'
        )

        { & $script:ScriptPath -TranscriptPath $script:FixtureDir } |
            Should -Throw '*detected: codex*'
    }

    It 'refuses a transcript of no known shape' {
        New-TranscriptFile -Name 'mystery.jsonl' -Lines @(
            '{"who":"knows","what":{"is":"this"}}'
            '{"who":"knows","what":{"is":"that"}}'
        )

        { & $script:ScriptPath -TranscriptPath $script:FixtureDir } |
            Should -Throw '*detected: unknown*'
    }

    It 'names Copilot specifically when pointed at its SQLite store' {
        Set-Content -LiteralPath (Join-Path $script:FixtureDir 'session-store.db') `
            -Value 'SQLite format 3' -Encoding utf8NoBOM

        { & $script:ScriptPath -TranscriptPath $script:FixtureDir } |
            Should -Throw '*Copilot records no token usage*'
    }

    It 'names Copilot from a chatSessions directory holding no transcripts' {
        $chat = Join-Path $script:FixtureDir 'chatSessions'
        New-Item -ItemType Directory -Path $chat -Force | Out-Null

        { & $script:ScriptPath -TranscriptPath $chat } |
            Should -Throw '*Copilot records no token usage*'
    }

    It 'refuses a directory of Claude transcripts that recorded no usage' {
        New-TranscriptFile -Name 'empty-a.jsonl' -Lines @(
            '{"type":"user","timestamp":"2026-01-01T10:00:00Z","message":{"role":"user","content":"hi"}}'
        )
        New-TranscriptFile -Name 'empty-b.jsonl' -Lines @(
            '{"type":"user","timestamp":"2026-01-01T10:00:00Z","message":{"role":"user","content":"hello"}}'
        )

        { & $script:ScriptPath -TranscriptPath $script:FixtureDir } |
            Should -Throw '*none of which recorded any usage*'
    }

    It 'still skips a single empty session when another one has usage' {
        New-TranscriptFile -Name 'empty.jsonl' -Lines @(
            '{"type":"user","timestamp":"2026-01-01T10:00:00Z","message":{"role":"user","content":"hi"}}'
        )
        New-TranscriptFile -Name 'real.jsonl' -Lines @(
            '{"type":"assistant","timestamp":"2026-01-01T10:00:05Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}}'
        )

        $json = (& $script:ScriptPath -TranscriptPath $script:FixtureDir) -join "`n" | ConvertFrom-Json

        $json.sessions.Count | Should -Be 1
        $json.sessions[0].id | Should -Be 'real'
        $json.sessions[0].total.input | Should -Be 7
    }
}

Describe 'Measure-Session -Hook' {
    BeforeAll {
        function New-TranscriptFile {
            param([string]$Name, [string[]]$Lines)
            $path = Join-Path $script:FixtureDir $Name
            Set-Content -LiteralPath $path -Value $Lines -Encoding utf8NoBOM
            return $path
        }
    }

    BeforeEach {
        $script:FixtureDir = Join-Path $TestDrive 'transcripts'
        New-Item -ItemType Directory -Path $script:FixtureDir -Force | Out-Null

        # Isolate the hook's hardcoded log path: it writes to
        # (parent of $PSScriptRoot)/.claude/session-costs.tsv, so the script
        # under test must live under its own fake tools/ inside TestDrive.
        # $TestDrive is shared across every It in this run, so each test gets
        # its own repo root rather than colliding on a shared log file.
        $repoRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        $toolsDir = Join-Path $repoRoot 'tools'
        New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
        $script:IsolatedScript = Join-Path $toolsDir 'Measure-Session.ps1'
        Copy-Item -LiteralPath $script:ScriptPath -Destination $script:IsolatedScript
        $script:Log = Join-Path $repoRoot '.claude/session-costs.tsv'
    }

    It 'writes one header row and one data row per session' {
        $transcript = New-TranscriptFile -Name 'hook-sess.jsonl' -Lines @(
            '{"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}'
        )
        $payload = (@{ transcript_path = $transcript } | ConvertTo-Json -Compress)

        $payload | pwsh -NoProfile -File $script:IsolatedScript -Hook

        Test-Path $script:Log | Should -BeTrue
        $rows = Get-Content $script:Log
        $rows.Count | Should -Be 2
        $rows[1] | Should -Match 'hook-sess'
    }

    It 'replaces the existing row rather than duplicating it when the same session ends twice' {
        $transcript = New-TranscriptFile -Name 'hook-sess2.jsonl' -Lines @(
            '{"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}'
        )
        $payload = (@{ transcript_path = $transcript } | ConvertTo-Json -Compress)
        $payload | pwsh -NoProfile -File $script:IsolatedScript -Hook

        Add-Content -LiteralPath $transcript -Value '{"type":"assistant","timestamp":"2026-01-01T10:00:05Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}'
        $payload | pwsh -NoProfile -File $script:IsolatedScript -Hook

        $rows = Get-Content $script:Log
        $rows.Count | Should -Be 2
        ($rows[1] -split "`t")[3] | Should -Be '2'
    }
}

Describe 'Measure-Session -Watch' {
    BeforeAll {
        function New-TranscriptFile {
            param([string]$Name, [string[]]$Lines)
            $path = Join-Path $script:FixtureDir $Name
            Set-Content -LiteralPath $path -Value $Lines -Encoding utf8NoBOM
            return $path
        }
    }

    BeforeEach {
        $script:FixtureDir = Join-Path $TestDrive 'transcripts'
        New-Item -ItemType Directory -Path $script:FixtureDir -Force | Out-Null
    }

    It 'stays silent below -WarnAtTokens' {
        $transcript = New-TranscriptFile -Name 'watch-low.jsonl' -Lines @(
            '{"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}'
        )
        $payload = (@{ transcript_path = $transcript } | ConvertTo-Json -Compress)

        $output = $payload | pwsh -NoProfile -File $script:ScriptPath -Watch

        $output | Should -BeNullOrEmpty
    }

    It 'warns once the newest call''s context crosses -WarnAtTokens' {
        $transcript = New-TranscriptFile -Name 'watch-high.jsonl' -Lines @(
            '{"type":"assistant","timestamp":"2026-01-01T10:00:00Z","message":{"model":"claude-sonnet-5","usage":{"input_tokens":200,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}'
        )
        $payload = (@{ transcript_path = $transcript } | ConvertTo-Json -Compress)

        $output = $payload | pwsh -NoProfile -File $script:ScriptPath -Watch -WarnAtTokens 100

        ($output -join ' ') | Should -Match 'Context is 200 tokens'
    }
}
