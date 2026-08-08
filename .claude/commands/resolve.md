---
description: Triage a pull request's review comments, fix what is valid, and resolve the threads that fix satisfies
argument-hint: [pr number]
---

Work the review comments on pull request **$1** — the current branch's PR if no number is given.

**Resolving a thread is an external write, and it is not covered by the issue carve-out** (`AGENTS.md`, *Tracking work* — that covers opening issues, not commenting on or resolving anyone else's thread). Read this repository's own instruction file first: some delegate resolution after a validated fix so a thread cannot block auto-merge, some forbid replying or resolving without authorization. **Follow what it says. Where it is silent, ask before resolving anything.**

## Find every thread

`gh pr view --json reviewRequests,latestReviews` **does not show conversation threads.** An automated reviewer can leave threads that block merge and appear nowhere in that listing — this has cost real time, and it is why the query is written out here:

```bash
gh api graphql -f query='
{ repository(owner:"OWNER", name:"REPO") {
    pullRequest(number:N) {
      reviewThreads(first:100) { nodes {
        id isResolved isOutdated path line
        comments(first:10) { nodes { author { login } body } }
      } } } } }'
```

Count unresolved threads before you start and say the number. If `required_review_thread_resolution` is on, that count *is* the merge blocker.

## Classify every comment, then act

Produce one scannable table — every thread, one row. **Volume from a bot is not authority**; classify on the merit of the claim, not on who filed it or how confidently it is worded.

| Class | Meaning | Action |
|---|---|---|
| **Defect** | The claim is correct and in scope for this PR | Fix it |
| **Out of scope** | Correct, but not this PR's job | **File an issue, reply with the link.** Do not widen the change — *one slice at a time* |
| **Not sustained** | The claim is wrong, or the code is right for a reason the reviewer could not see | Reply explaining why. Do not change code to silence a reviewer |
| **Already decided** | Contradicts a recorded decision | Reply, link the decision-log entry or ADR. Do not relitigate |
| **Ambiguous** | Two readings are both defensible | **Bring to me individually.** Do not guess |

Act on the four clear classes without further prompting. **Bring only the ambiguous ones for sign-off, one at a time** — that is proportionate: a twenty-comment automated review must not become twenty round trips, but nothing debatable gets resolved on your judgement alone.

## Order of operations

This sequence is the safeguard. Do not reorder it.

1. **Fix** the defects. Nothing else — no adjacent tidying, no refactors.
2. **Push.** A fix that is not pushed does not exist as far as the reviewer or CI is concerned.
3. **Confirm the checks are green on the new head SHA.** Not the old one.
4. **Only then resolve**, and only the threads a validated fix actually satisfies.

**Never resolve a thread you did not address.** Resolving is how a blocking finding becomes invisible — it is the one action here that cannot be noticed afterwards. Leave anything ambiguous, contested, or merely replied-to **open**, and say so in your report.

Where the repository requires authorization to resolve: fix and push, then report which threads are now satisfied, and stop.

## Report

- Threads found, and how many were unresolved at the start
- The classification table
- What was fixed, and the pushed SHA
- Checks on that SHA — including any that **did not run**, per `/verify`
- Threads resolved, and threads deliberately left open with the reason
- Issues filed for out-of-scope findings, with numbers

**Then ask.** Anything left open is unresolved work, and *a reconciliation ends in a decision, not a report* (`AGENTS.md`, *Working with me*). If every thread was clear-cut and nothing remains, say so and stop — do not manufacture a question.

## Never

- Change code purely to make a reviewer stop objecting. If the claim is wrong, say so.
- Resolve a thread on someone else's PR without being asked.
- Merge. That is `/pr`'s territory and this repository's convention, not this command's.
- Treat an outdated thread as resolved. `isOutdated` means the line moved, not that the point was answered.
