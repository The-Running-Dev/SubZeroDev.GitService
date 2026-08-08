---
description: Clone or update the shared kit checkout at ~/.agent-kit, then run INSTALL.md's reconciliation against this repository. Usage - /kit-sync, or /kit-sync <branch>
argument-hint: [branch]
---

Get the kit itself onto disk, then reconcile it into this repository — the two steps `/install` needs, done back to back, without requiring the kit to already be checked out somewhere you point at.

**This repository must be the target, not the kit.** If this tree contains `INSTALL.md` and `.claude/commands/design.md`, it is the kit itself; stop and say so rather than cloning the kit into itself.

## Resolve the source and branch

```powershell
Get-Content .claude/kit.json -ErrorAction SilentlyContinue | ConvertFrom-Json
```

- **Present** — its `source` field is the origin to sync from. Its `branch` field, if recorded, is the default branch when `$1` is not given.
- **Absent** — this repository has never had the kit installed. Ask for the source URL rather than assuming one; it is recorded once, in the target's own `kit.json`, not hardcoded a second place here.

Branch: `$1` if given, else `kit.json`'s recorded `branch`, else `main`. Say which one you are using.

## Clone or update `~/.agent-kit`

```powershell
Test-Path ~/.agent-kit
```

- **Absent** — `git clone <source> -b <branch> ~/.agent-kit`.
- **Present** — confirm it is actually a clone of `<source>` first (`git -C ~/.agent-kit remote get-url origin`). A path occupied by something unrelated is stopped on, not overwritten — the same **Occupied** handling `INSTALL.md` phase 1 gives every other artifact.
  - **Dirty worktree** — stop and report. This is a shared checkout; someone may be working in it directly, and discarding that is not this command's call.
  - **Clean** —

    ```powershell
    git -C ~/.agent-kit fetch origin
    git -C ~/.agent-kit checkout <branch>
    git -C ~/.agent-kit merge --ff-only origin/<branch>
    ```

    **`--ff-only`, never a reset or force-pull.** A fast-forward failure means the local checkout has commits `origin` does not — stop and report that rather than discarding them.

## Reconcile

Read `INSTALL.md` from `~/.agent-kit` and follow it exactly, with `~/.agent-kit` as `<kit-root>` and this repository as `<target>`. It is the same procedure `/install` runs — this command only gets the kit there first. Do not restate its phases here; execute them, and stop at its phase 3 report as instructed.

**One addition to phase 4's `.claude/kit.json` write:** record the branch synced from, alongside the existing `source`, `commit` and `installed` fields:

```json
{ "source": "<source>", "branch": "<branch>", "commit": "<kit HEAD sha>", "installed": "YYYY-MM-DD" }
```

That is the one field this command adds to the schema, so the next run has a default without asking again. It is additive — a `kit.json` written before this command existed simply has no `branch` field, and this command treats that the same as "not recorded."

## Report

Everything `INSTALL.md` phase 3 already requires, plus:

- Branch synced, and whether `~/.agent-kit` was cloned fresh or fast-forwarded
- If the fast-forward was refused: say so, and stop there — do not fall through to reconciliation against a checkout that may not hold the commits `origin` has

## Never

- Force-push, reset, or discard uncommitted work in `~/.agent-kit`. It is shared across every repository that runs this command.
- Hardcode a source URL as a fallback. Absent `kit.json` means asking, once.
- Commit or push anything in *this* repository — same as `/install`, this stops at the phase 3 report, and applies only after sign-off.
