---
description: Install Anthropic's Claude Code GitHub Action into a repository so pull requests get automated Claude review. Usage - /install-code-review-agent, or /install-code-review-agent D:\Projects\Some.Repo
argument-hint: [target repo path]
---

<!-- companion:declared:start -->
**Per-repo companion:** `.claude/commands/install-code-review-agent-local.md`. Read it now, if it exists — an absent,
empty, or frontmatter-only file is no companion, and this file then stands alone.
It may override: `extra-steps`, `tightened-authorization`. It may never override anything in
[`.claude/COMPANIONS.md`](../COMPANIONS.md) § *Never*, which is also where these categories are defined.
<!-- companion:declared:end -->

Install Anthropic's official `claude-code-action` into a GitHub repository, so pull requests get an automated Claude review. **$1** is the target repository path; default to the current repository if not given.

This installs three things, and only one of them is this command's to do:

1. **The workflow file** — `.github/workflows/claude-code-review.yml`. This command writes it.
2. **The GitHub App** (`https://github.com/apps/claude`) — grants Claude's GitHub identity access to the target repository. This is a browser consent flow on the user's GitHub account; it cannot be scripted or driven headlessly, and this command does not attempt it (`AGENTS.md`, top-level: *bypassing or completing CAPTCHAs or other bot-detection* and *granting OAuth/SSO permissions* are never automated).
3. **The `ANTHROPIC_API_KEY` repository secret** (or `CLAUDE_CODE_OAUTH_TOKEN` for a Claude Pro/Max/Team subscription, via `claude setup-token`) — this command never enters the value itself, under any circumstance, even if it is pasted into chat. Entering an API key into a field is a prohibited action at the top level of this session, and no per-repo authorization changes that.

## Resolve the target

`$1` if given, else the current repository. Confirm it is a GitHub repository (`gh repo view` succeeds) before doing anything else.

## Check prerequisites

```powershell
gh auth status
```

Not authenticated, or `gh` missing entirely — stop and report. This command does not attempt to install or authenticate `gh` on the user's behalf.

## Classify the workflow file

```powershell
Test-Path <target>/.github/workflows/claude-code-review.yml
```

- **Absent** — proceed to *Choose a mode*.
- **Present** — read it. If its `uses:` line already pins `anthropics/claude-code-action`, report **Identical** (or note a version difference) and stop; re-running this command is not how an existing installation is upgraded. If it is a different workflow that happens to occupy this filename, this is **Occupied** — stop and ask, the same as `INSTALL.md` phase 1 treats any other occupied artifact. Never overwrite a workflow file this command did not write.

## Choose a mode

Ask which mode, recommending automatic review first:

- **Automatic review (recommended)** — triggers on `pull_request` (`opened`, `synchronize`, `ready_for_review`, `reopened`) and runs `/code-review:code-review --comment` against the PR, posting findings as inline comments. This is what "install the code review agent" means in the common case.
- **Mention-only** — triggers on `issue_comment` and `pull_request_review_comment` containing `@claude`, and only acts when someone asks.

Both need `contents: write`, `pull-requests: write`, `issues: write`, `id-token: write`, `actions: read` permissions on the job, and an `actions/checkout` step ahead of the `anthropics/claude-code-action@v1` step.

## Write the workflow file

Write `<target>/.github/workflows/claude-code-review.yml` with the chosen trigger and `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` (or `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` if the user said they use a subscription token instead of an API key — ask which, do not guess).

## Report — and stop

- Whether the workflow file was created, and its path
- Whether the GitHub App is already installed on the target (`gh api /repos/{owner}/{repo}/installation` if reachable; otherwise say it could not be checked) — if not, give the user the install URL and ask them to do it and confirm back
- Whether `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) already exists as a repository secret (`gh secret list` — this shows names only, never values, so checking existence is safe) — if not, give the user the exact `gh secret set <NAME>` command to run **themselves**, in their own terminal
- **Do not commit, push, or open a pull request.** This command stops at the report for sign-off. `/install` and `/kit-sync` no longer do (`INSTALL.md` phase 4 step 8) and this one still does, on its own reason rather than theirs: a workflow file that grants CI a repository secret is not something to land before the user has confirmed the App install and the secret exist.

## Never

- Enter, echo, or infer an API key or OAuth token value, in any field, under any authorization.
- Attempt to drive the GitHub App installation's browser consent screen.
- Overwrite a workflow file this command did not write.
- Commit, push, or open a pull request. That is the user's call once the report is reviewed.

## Re-run

Re-running against a target that already has the workflow file reports **Identical** and stops rather than rewriting it — upgrading the action version or changing the mode is a manual edit to the workflow file, not this command's job.
