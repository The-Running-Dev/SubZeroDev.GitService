---
description: Discover this repository's gates, run them, and report honestly what did and did not run
---

Run the checks this repository actually has, and report the result without softening it.

**`/pr` runs this as its gate phase**, against the branch and worktree its pull request points at, and writes the report below into that PR's `Verified` section **verbatim** — the same three lists, not a summary. This file owns the procedure; `/pr` owns only where the sequence sits. Invoked on its own, it does the same discovery and the same three lists against whatever tree is checked out, and writes to no pull request.

**The point of this command is the second half of its report — what did *not* run.** Silence is not success, and a gate that could not run is the most likely place a false "everything passes" comes from.

## Discover, do not assume

**Check the cache first.** `tools/Test-GatesCache.ps1 -RepoRoot <repo>` hashes the files this discovery reads (every workflow's content, `package.json`'s content, and whether the known build-script paths exist) and compares it to `.claude/gates.json`. `Fresh` means none of those inputs have changed since the last discovery — skip straight to **Run** with the gates it returns. `Stale` or `Missing` means discover as below, then call `tools/Test-GatesCache.ps1 -Write -GatesJson '<the gates you found, as [{"name","command"}]>'` before running them, so the next `/verify` on this tree does not re-derive the same answer. The cache only remembers gates; it never decides what they are — that judgement stays here.

**CI is the authoritative list.** Read `.github/workflows/*.yml` first: whatever the required checks invoke is the set worth running locally. A gate that exists but CI never runs is optional; a gate CI runs that you skipped is a hole in your report.

Then look for what those workflows call, and for anything else the repository ships:

```powershell
Get-ChildItem .github/workflows -Filter *.yml
Get-Content package.json | Select-String '"scripts"' -Context 0,20
Get-ChildItem . -Filter *.sln, *.csproj -Recurse -Depth 2
Get-ChildItem build -Filter *.ps1
Test-Path docs.ps1
```

Common shapes, none of them assumed:

| Found | Run |
|---|---|
| `package.json` scripts | `npm run check`, or `typecheck` / `lint` / `test` individually if there is no aggregate |
| `*.sln` or `*.csproj` | `dotnet build`, `dotnet test` |
| `build/Test-Documentation.ps1` | run it |
| `build/Test-DocumentationArtifact.ps1` | run it, after a production docs build |
| `docs.ps1` | `./docs.ps1 -BuildOnly` — **needs Docker** |
| any repository | `git diff --check`, `git status --short --branch` |

## Report

Three lists. All three are required, and the second is the one that matters.

```
Ran and passed:   <gate> — <what it covered>
Ran and failed:   <gate> — <the actual output, not a summary>
Did not run:      <gate> — <why: tool missing, Docker down, no such script>
```

- **Quote failures.** Paste the failing output. A summary of a failure is a claim about a failure.
- **Never write "all checks pass"** unless every discovered gate is in the first list. If anything is in the third list, the honest sentence names it: *"the three that ran passed; the documentation build did not run because Docker is unavailable."*
- **A gate that cannot run locally is not a gate you may report on.** Say so, and say that the corresponding CI check on the pull request is where the answer will come from.
- If CI runs a check you could not reproduce locally at all, name it explicitly rather than leaving it out.

## Then ask

**A failing gate ends in a decision, not a report** (`AGENTS.md`, *Working with me*). Do not start fixing. Present each failure with a recommendation — fix here, file an issue, or accept and explain — and what each costs.

A clean run needs no question. Say it is clean, name what ran, and stop.

## Never

- Do not fix a failure as part of this command. Verifying and repairing are different jobs, and doing both means the report describes a tree that no longer exists.
- Do not re-run a gate until it passes. If a check is flaky, that is a finding — say how many runs and what varied. **A fix that only changed the odds is not a fix.**
- Do not skip the full suite in favour of the tests you think are relevant.
