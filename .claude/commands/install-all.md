---
description: Reconcile the kit into every SubZeroDev.* repository, unattended. Usage - /install-all, or /install-all SubZeroDev.GameEngine,SubZeroDev.Platform
argument-hint: [repo name[,repo name...]]
---

Run `INSTALL.md`'s reconciliation against every sibling repository, in one unattended pass. **$1**, if given, is an explicit ordered list of repo names (comma-separated) — only those run, in that order. Bare, it discovers every `SubZeroDev.*` sibling of this kit and runs them alphabetically.

This command does not replace `/install`; it orchestrates it. Discovery, ordering, and one run per target — each following `INSTALL.md` exactly through phase 2. The one thing it changes is phase 3: there is no one here to answer a fork, so **it never guesses one**. Read `INSTALL.md` before doing anything else; this file only adds what running it unattended, across many repos, requires on top.

## Phase 0 — Discover

```powershell
Get-ChildItem (Split-Path <kit-root> -Parent) -Directory -Filter 'SubZeroDev.*'
```

- Drop the kit itself.
- **Resolve every candidate's real root** with `git -C <candidate> rev-parse --show-toplevel` before adding it to the list. Two paths resolving to the same root — a junction, a symlink, a Dropbox-synced duplicate — are one repository; keep the first, report the rest as skipped duplicates. A stray `SubZeroDev.Platform;C` sitting next to `SubZeroDev.Platform` is exactly this case: check before assuming two candidates differ.
- **Not a git repository** — report and skip it. Do not stop the run for one bad candidate.
- Order: the explicit list in `$1` if given, else alphabetical.

## Phase 1 — Per target, run `INSTALL.md` phases 0 through 2 unmodified

Orient, classify, reconcile — exactly as `INSTALL.md` states them. Running several targets in one session changes nothing about what a state means or how a divergence is proposed to be resolved.

## Phase 2 — Apply without a human in the loop

`INSTALL.md` phase 3 exists because some proposals have no single correct resolution. That has not stopped being true just because no one is here to ask, so this command does not resolve those on its own authority either. Split every proposal from phase 1 in two:

**Has one deterministic resolution already stated in `INSTALL.md`** — apply it and move on, the same action an interactive run would take once you approved it. This covers: absent → create, identical → skip, the default reconciliation for `AGENTS.md`/`CLAUDE.md` and `agent.md` when one side is clearly a pointer or clearly holds content and the other is absent or agrees, `codex/PROFILES.md`'s skip-unless-evidence default, and writing `.claude/kit.json`.

**Is a named fork with no default** — `INSTALL.md` phase 1's *Occupied* state, `design/` occupied or ambiguous against an existing plans/ADR home, both `AGENTS.md` and `CLAUDE.md` holding content, `.github/ISSUE_TEMPLATE/` already present, a same-named command already present, and the `settings.json` hooks — `SessionEnd` and `UserPromptSubmit`, both of which `INSTALL.md` requires proposing and waiting on, unconditionally, with no automatic path at all. **Skip that artifact — or, if it blocks classifying the rest, that whole repository — record it as needing a decision, and continue to the next target.** Never pick the answer an unattended run cannot ask about, and never write either hook here.

## Phase 3 — What must not happen, in any target

Same list as `INSTALL.md`'s, and unattended does not relax it — if anything it matters more, since nothing here waits for a human to notice a mistake before it repeats across the next repository:

- No commit, no push, no pull request, in any target.
- No `git add -A`, `git add .`, or bare-directory add — this command does not stage anything at all.
- No deletion without approval, including proposed `agent.md` prunes — leave those unpruned and listed, not silently applied.
- No write to a target's `settings.json`, `settings.local.json`, or `launch.json` beyond the (skipped, per phase 2) `SessionEnd` and `UserPromptSubmit` hooks.

## Phase 4 — One consolidated report, then stop

Per target, in the order run:

```
## <repo>
Applied:            <paths, what changed>
Skipped, identical: <paths>
Needs a decision:   <fork> — <what's blocking it, and what /install alone would ask>
Worktree status:    <git status --short, so the user can see what to review>
```

Then one summary line: how many repos ran clean, how many have at least one item needing a decision, and how many were skipped outright (not a git repository, or a duplicate root already handled under another candidate).

**Re-run `/install <repo>` by hand for anything listed under "needs a decision"** — that is the interactive path this command deliberately does not take on its own.
