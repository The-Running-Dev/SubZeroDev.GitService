---
description: Reconcile the kit into every SubZeroDev.* repository, unattended. Usage - /install-all, or /install-all SubZeroDev.GameEngine,SubZeroDev.Platform
argument-hint: [repo name[,repo name...]]
---

<!-- companion:declared:start -->
**Per-repo companion:** `.claude/commands/install-all-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `extra-steps`, `tightened-authorization`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:declared:end -->

Run `INSTALL.md`'s reconciliation against every sibling repository, in one unattended pass. **$1**, if given, is an explicit ordered list of repo names (comma-separated) — only those run, in that order. Bare, it discovers every `SubZeroDev.*` sibling of this kit and runs them alphabetically.

This command does not replace `/install`; it orchestrates it. Discovery, ordering, and one run per target — each following `INSTALL.md` exactly through phase 2. The one thing it changes is phase 3: there is no one here to answer a fork, so **it never guesses one**. Read `INSTALL.md` before doing anything else; this file only adds what running it unattended, across many repos, requires on top.

## Phase 0 — Discover

```powershell
$kitRoot = git rev-parse --show-toplevel
Get-ChildItem (Split-Path $kitRoot -Parent) -Directory -Filter 'SubZeroDev.*'
```

Run this from the repository that holds the installed kit; `$kitRoot` is that repository's
resolved Git root.

- Drop the kit itself.
- **Resolve every candidate's real root** with `git -C <candidate> rev-parse --show-toplevel` before adding it to the list. Two paths resolving to the same root — a junction, a symlink, a Dropbox-synced duplicate — are one repository; keep the first, report the rest as skipped duplicates. A stray `SubZeroDev.Platform;C` sitting next to `SubZeroDev.Platform` is exactly this case: check before assuming two candidates differ.
- **Not a git repository** — report and skip it. Do not stop the run for one bad candidate, and **do not
  initialize one here.** `INSTALL.md` phase 4 creates an absent repository under a sign-off this command
  never collects; unattended, across a directory of candidates, that turns a stray or mistyped sibling into
  a repository holding a copy of the kit. Attended `/install` is where an absent repository is created.
- Order: the explicit list in `$1` if given, else alphabetical.

## Phase 1 — Per target, run `INSTALL.md` phases 0 through 2 unmodified

Orient, classify, reconcile — exactly as `INSTALL.md` states them. Running several targets in one session changes nothing about what a state means or how a divergence is proposed to be resolved.

## Phase 2 — Apply without a human in the loop

`INSTALL.md` phase 3 exists because some proposals have no single correct resolution. That has not stopped being true just because no one is here to ask, so this command does not resolve those on its own authority either. Split every proposal from phase 1 in two:

**Has one deterministic resolution already stated in `INSTALL.md`** — apply it and move on, the same action an interactive run would take once you approved it. This covers: absent → create, identical → skip, **every core command file and `.claude/COMPANIONS.md`, which the kit owns outright and which therefore have no fork to reach an unattended run at all**, the default reconciliation for `AGENTS.md`/`CLAUDE.md` and `agent.md` when one side is clearly a pointer or clearly holds content and the other is absent or agrees, `codex/PROFILES.md`'s skip-unless-evidence default, and writing `.claude/kit.json`.

That is most of what this command used to carry across nineteen files per repository, and it is the whole reason the core/companion split exists — read `.claude/COMPANIONS.md` before running against anything.

**Is a named fork with no default** — `INSTALL.md` phase 1's *Occupied* state, `design/` occupied or ambiguous against an existing plans/ADR home, both `AGENTS.md` and `CLAUDE.md` holding content, `.github/ISSUE_TEMPLATE/` already present, a same-named command already present, an `Unmigrated-Blocked` core, and the `settings.json` hooks — `SessionEnd` and `UserPromptSubmit`, both of which `INSTALL.md` requires proposing and waiting on, unconditionally, with no automatic path at all. **Skip that artifact — or, if it blocks classifying the rest, that whole repository — record it as needing a decision, and continue to the next target.** Never pick the answer an unattended run cannot ask about, and never write either hook here.

**`Unmigrated-Blocked` is a fork even though its recommended resolution never varies.** Writing the companion is authoring that repository's policy for that command, which is exactly the class of thing an unattended pass does not do on its own authority. Report it and move on.

**Run the companion validator alongside the write-surface guard**, on the same per-target boundary:

```powershell
pwsh ./tools/Test-Companion.ps1 -TargetRepo <target>
```

**Exit 1 aborts that target's pass** the same way `OutOfSurface` does, and for the same reason — a core with no declaration block, or a companion overriding a category its core forbids, is a repository left in a state the next run cannot classify. **Exit 2 (`NotEvaluated`)** is not a pass either: it means `.claude/COMPANIONS.md` never landed, so nothing was actually checked.

**Run the write-surface guard immediately after each target's files are written, before moving on to the next target:**

```powershell
pwsh ./tools/Test-WriteSurface.ps1 -TargetRepo <target>
```

This is the mechanical backstop for everything above — the phase-2 rules say what an unattended pass is allowed to write, and `tools/Test-WriteSurface.ps1` is what actually checks the target's working tree against that, path by path, rather than trusting that the rules above were followed correctly this run (research/oz-for-oss.md, F2/P7: ported from `oz/repo_local.py::assert_write_surface`, adapted from gating a push — this command never pushes — to gating this per-target apply). The allowed-prefix list is defined once, in that script, and is not restated here.

**Exit 1 (`OutOfSurface`) aborts that target's pass**, right there — do not run this target's remaining phase-2 steps or move on to the next target's writes until it is resolved for this one. Revert the offending paths with `-Revert`, record the repo under "Aborted" in the phase 4 report with the offending path(s) named, and continue to the next target. **Exit 2 (`NotEvaluated`)** — the guard could not read the target's git status at all — is not a pass; treat it the same as `OutOfSurface` and report it, rather than assuming clean because nothing was flagged.

## Phase 3 — What must not happen, in any target

Same list as `INSTALL.md`'s, and unattended does not relax it — if anything it matters more, since nothing here waits for a human to notice a mistake before it repeats across the next repository:

- No commit, no push, no pull request, in any target.
- No `git add -A`, `git add .`, or bare-directory add — this command does not stage anything at all.
- No deletion without approval, including proposed `agent.md` prunes — leave those unpruned and listed, not silently applied.
- No write to a target's `settings.json`, `settings.local.json`, or `launch.json` beyond the (skipped, per phase 2) `SessionEnd` and `UserPromptSubmit` hooks.
- **No target left with a write outside `tools/Test-WriteSurface.ps1`'s allowed-prefix list.** Phase 2's guard step is what makes this checkable rather than aspirational.
- **No `.claude/commands/*-local.md` written, rewritten, or deleted, in any target.** A companion is the repository's own policy for a command; an unattended pass that authors one has decided something nobody asked it to decide.

## Phase 4 — One consolidated report, then stop

Per target, in the order run:

```
## <repo>
Applied:            <paths, what changed>
Skipped, identical: <paths>
Needs a decision:   <fork> — <what's blocking it, and what /install alone would ask>
Unmigrated cores:   <path> — local edit, no companion; names the -local.md it belongs in
Aborted:            <offending path(s)> — write-surface guard or companion validator
Worktree status:    <git status --short, so the user can see what to review>
```

Then one summary line: how many repos ran clean, how many have at least one item needing a decision, how many were aborted by the write-surface guard, and how many were skipped outright (not a git repository, or a duplicate root already handled under another candidate).

**Re-run `/install <repo>` by hand for anything listed under "needs a decision"** — that is the interactive path this command deliberately does not take on its own.

## Re-run

Same as `/install`, per target: each run reclassifies every artifact from scratch, so nothing
is remembered across runs or across repositories. An artifact already reconciled in a prior
pass reports identical and is skipped; a fork still unresolved keeps landing under "needs a
decision" on every subsequent run until the target's own tree resolves it — this command never
guesses at one just because it saw it before.
