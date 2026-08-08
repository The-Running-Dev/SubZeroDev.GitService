---
description: Open a pull request for the current branch, following this repository's own convention
---

Open a pull request for the work on the current branch.

**This repository's convention outranks any default in this command.** They genuinely differ — one sibling enables auto-merge as standard practice, another forbids it outright, a third leaves every merge to its owner. **Read the repository's own instruction file before doing anything**, and follow what it says. If it is silent, open the PR and leave the merge alone.

> Three rules below — push before announcing, no AI attribution, and no deployed URL before the deploy succeeds — are stated canonically in `AGENTS.md` (*Git and delivery*, *House conventions*, *Verification*). They are repeated here because this file is injected on its own and the rules fire at exactly these moments. If they ever disagree, `AGENTS.md` is correct and this file has drifted.

## Before opening

```powershell
git status --short --branch
git log --oneline @{u}..HEAD
git diff --check
```

- **Every commit must be pushed first.** Announcing a PR invites an immediate merge, and a commit pushed after that lands on a branch nobody merges. Check `@{u}..HEAD` is empty before you announce anything.
- **Never open a PR from the default branch.** If that is where the work is, stop and say so — moving commits to a branch is the user's call.
- **Run `/verify` first, or say that you did not.** A PR description claiming green checks without having run them is the exact failure `AGENTS.md` names.
- Stage by explicit named path. Never `git add -A`, `git add .`, or a bare directory.

## The description

Same shape as an issue — human first, agent detail fenced:

```markdown
**What changed, and why.** Two or three sentences someone reviewing can follow without
reading the diff. State what was decided and why it was not the obvious alternative.

Closes #<n>

### Verified
- `npm run check` — passed
- Documentation build — **did not run**, Docker unavailable; relying on the CI check

---
<details><summary><b>Agent detail</b></summary>
<!-- agent:start -->

- **Slice:** S3 — `design/30-slices.md` § S3 @ `a1b2c3d`
- **Criteria met:** S3.1, S3.2
- **Left undone:** S3.3 — <why>
<!-- agent:end -->
</details>
```

- **Do not claim a check passed that did not run.** Carry `/verify`'s third list into the description verbatim.
- Long-form reasoning belongs in the decision log or the plan, not the PR body. Say what changed and why; link the rest.
- **No AI attribution** — no `Co-Authored-By` naming an assistant, no "Generated with" footer.

## Reviews

**Check review *threads*, not requested reviewers.** An automated reviewer can leave conversation threads that block merge and do **not** appear in `gh pr view --json reviewRequests,latestReviews`.

**Working those threads is `/resolve`, not this command** — it holds the GraphQL query and the triage rules. Here, only report the unresolved count: if `required_review_thread_resolution` is on, that count is the merge blocker regardless of what the checks say.

## Merging

**Merging is an external write and is not yours to do** unless this repository's instruction file explicitly delegates it. Where it does, follow that wording exactly — including which checks must be green first, and whether auto-merge is enabled against a specific head SHA.

Where it does not: open the PR, report the check outcomes, and stop.

**Never state a deployed URL** until the deploy for that exact merge commit reports success. A merged PR is not a deployed site.
