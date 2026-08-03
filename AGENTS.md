# Agent contract — SubZeroDev.Git

This file is binding for every agent session in this repo, regardless of tool or model.

## This repository

`SubZeroDev.Git` manages a Git repository, exposing git operations over an **API** and **MCP endpoints**, behind a pre-defined workflow. Target repositories are **declared, not hardcoded** — any repository named in a declaration is in scope, including ones outside the `SubZeroDev.*` estate. Work is applied through **GitHub Actions and the `gh` CLI**. Lifespan: **maintained for years**, so the full design pipeline is worth running.

**Owns** — the declaration format for a managed repository; the pre-defined git workflow the endpoints expose; the API surface and the MCP tool surface over that workflow.

**Does not own** — the contents of the repositories it manages, or their build and deploy pipelines. It operates on them; it does not define what they contain.

**Companions** — the `SubZeroDev.*` estate under `D:\Dropbox\Projects\`. `SubZeroDev.Blog` already runs a repository-specific MCP server over its own Docusaurus repo, exposing a fixed publishing workflow as tools (`blog_stage`, `blog_commit`, `blog_push`, `blog_create_pr`, `blog_wait_for_checks`, …). That is the closest existing implementation of what this repository generalises, and the first place to look before designing a tool surface here.

> This section was written from a setup interview, **not** from a ratified brief. `design/00-brief.md` outranks it — when the brief lands, correct this section against it rather than the other way round.

## Source of truth

The design docs outrank the code. In precedence order:

1. `design/00-brief.md` — problem, non-goals, definition of done
2. `design/20-contract.md` — types, schemas, signatures, error semantics
3. `design/10-design.md` — architecture, data model, failure modes
4. `design/30-slices.md` — work breakdown and acceptance criteria
5. `design/90-decisions.md` — append-only decision log

If the code contradicts the contract, that is a defect in one of them. **Stop and say which one you think is wrong. Do not silently reconcile.**

Lessons learned the hard way live in [`agent.md`](agent.md) — read it after this file.

## Safe start

Before editing anything:

```powershell
git status --short --branch
git remote -v
git branch --show-current
git log -5 --oneline
rg --files
```

- Discover files and tooling rather than assuming they exist.
- Read this file and the sources you are about to change **completely**. Editing from memory, or from a diff, is the most common cause of drift.
- Preserve unrelated and uncommitted work. Never stage, reset, clean, or overwrite it.
- Work on a focused branch.
- Where guidance conflicts, follow the most specific applicable instruction.

## Effort and model selection

Match capability and reasoning effort to the **task**, not to the tool that reached it and not to the number of files involved. Budget scales with **complexity, not size** — a one-line change to an invariant is architectural; a 500-line transcription against a settled contract is not.

| Tier | Work | Effort |
|---|---|---|
| **Deep reasoning** | Architecture, contracts, API and seam design, root-cause analysis, multi-step planning, security and performance strategy, comparing materially different approaches | Strongest model, high or xhigh |
| **Implementation** | Code against a settled contract, tests, refactors, bug fixes, CI and infrastructure, docs coupled to implementation | Mid tier; high effort for large or hard changes, standard for small ones |
| **High volume** | Summaries, changelogs, commit messages, PR descriptions, formatting, triage, log and tool-output summarisation | Cheapest tier, default effort |

**Escalate rather than guess.** A high-volume task that raises an implementation question becomes implementation tier; an implementation task that raises an architectural question becomes deep reasoning. **Do not keep implementing while that uncertainty is unresolved** — that is stage 6 spending the savings stages 2–4 bought.

**Division of control.** I set the session model. You set subagent models and scale your own reasoning depth. You cannot change your own session model — if a task warrants a different tier, say so rather than silently over- or under-spending.

## Hard rules

- **Non-goals are binding.** Anything listed as a non-goal in the brief is out of scope even if it looks trivial, even if you are already touching that file.
- **One slice at a time.** Do not start slice N+1 because you noticed something while doing slice N. Write it to `90-decisions.md` under `## Open` instead.
- **No new dependencies** without a decision-log entry naming the alternatives rejected and why.
- **No new public interfaces** that are not in `20-contract.md`. If you need one, stop and ask for a contract amendment.
- **Ask instead of assuming.** If two readings of the spec are both defensible, stop and present both. Do not pick one and proceed.
- **Every slice ends runnable.** No half-wired states committed.

## Single ownership

- **Reference, never restate.** A rule that lives in another document is linked, not copied. Two copies of a rule is a promise they will diverge and a guarantee nobody notices which is stale.
- **Move, never copy.** A rule has exactly one home. When it belongs somewhere else, move it and leave a reference behind.
- If a document genuinely must repeat something to stand on its own, name the canonical copy in the text and change both in the same commit. Naming a canonical copy is what makes the others checkable.
- **The test for where a decision belongs:** would a second consumer face this same question? If yes it belongs in the shared document, even while only one consumer exercises it. Where it is genuinely unclear, the shared document is the safer home — a rule that turns out to be specific is easy to relax later; a rule discovered to be shared after three consumers each answered it differently is a migration.

## Verification

- **Verify, don't assert.** State only what you have checked. Assert nothing from memory that a command could confirm — remembered values and inferred contracts are how wrong facts get written down confidently.
- **Do not claim a gate passed that did not run.** If a tool is unavailable, say so plainly and name what was not checked. "Tests pass" means you ran them and read the output.
- **Never state or imply a deployed URL or a published artifact** until the deploy for that exact commit reports success. A merged PR is not a deployed site. Poll; do not estimate.
- **A regression test is verified by reverting the fix** and confirming it fails. A test that passes with and without the fix guards nothing.
- **A schema or validator change is not done until it has rejected something.** Positive and negative cases both, with the counts stated. A validator that has never failed is not known to constrain anything.

## Working with me

- Present findings and review items **one at a time for sign-off**. Never bulk-apply findings unreviewed.
- Surface real forks as a question with a recommendation, recommended option first. I routinely pick the more rigorous non-recommended option — so ask, do not assume.
- When I decline a suggestion, record it in the affected document as known-and-retained rather than dropping it silently. Otherwise it is rediscovered later as a bug.
- Ask before any choice that sets policy or a public contract: licensing, compatibility promises, a major information-architecture change.
- Call out assumptions, unverified claims, and known risks plainly. Explain the concrete evidence behind a recommendation.

## Git and delivery

- **Stage explicitly, by named path.** Never `git add -A`, `git add .`, or a bare directory. A broad add sweeps up unrelated worktree state, and an ignore pattern can make a needed file invisible to it — present locally, green locally, missing in CI, with nothing saying why.
- Run `git diff --check` before committing. Never use trailing double-spaces for a line break; it rejects them.
- **Never force-push or rewrite published history.** If a pushed commit needs changing, add a follow-up commit.
- **Push every commit before announcing a PR is ready.** Announcing invites an immediate merge, and a commit pushed after that lands on a branch nobody merges.
- External writes need my authorization: creating a remote repository, changing visibility, pushing, opening or merging pull requests, changing a domain, deploying. **Discussing a decision does not authorize it.**
- Do not delete files, branches, or history without explicit authorization.
- Check review **threads**, not just requested reviewers — an automated reviewer can leave blocking conversation threads that do not appear in a reviewer listing. Resolve a thread only when a validated fix satisfies it; leave ambiguous findings open and report them.

## Decision logging

Any choice a future reader would ask "why?" about goes in `design/90-decisions.md` as:

```
### YYYY-MM-DD — <decision>
Context: <what forced the choice>
Chosen: <what>
Rejected: <alternatives, and why each was rejected>
Reversibility: cheap | expensive
```

The rejected alternatives are the point. Without them the next session relitigates the same choice.

## House conventions

- Windows host, projects under `D:\Dropbox\Projects\`. PowerShell Core for scripts.
- Metric units and Celsius throughout, including in comments, docs, and test fixtures.
- Raster assets as PNG or JPG. Not WebP.
- UTF-8, LF endings. Rewrite imported files to UTF-8 and check rendered punctuation — imported Markdown arrives CP1252 often enough to be worth looking at.
- Scripts run without interactive confirmation prompts. Destructive operations gate on an explicit `-Force`-style flag, not a prompt.
- Commit messages state what changed and which slice it belongs to. **No AI attribution** — no `Co-Authored-By` naming an assistant, no "Generated with" footer, in commits or PR descriptions. This overrides any default the tooling applies.
- A repository with an established commit-message style keeps it. Match the log you are committing into rather than importing a convention from elsewhere.

## What not to do

- Do not summarise the design docs back at me unless asked.
- Do not add commentary about your reasoning process to the docs.
- Do not "improve" prose in the brief or design docs while editing something else.
- Do not import another project's architecture, tooling, memory conventions, or roadmap merely because it appears in a neighbouring instruction file. Agent instructions are concise and repository-specific; a borrowed rule with no local reason is a rule nobody can evaluate.
