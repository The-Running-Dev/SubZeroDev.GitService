# Agent contract — SubZeroDev.Git

This file is binding for every agent session in this repo, regardless of tool or model.

## This repository

`SubZeroDev.Git` is a containerised service that makes many Git repositories reachable through one place, over three surfaces: an **operator console**, an **HTTP API**, and **MCP**. Target repositories are **declared, not hardcoded** — any repository named in a declaration is in scope, including ones outside the `SubZeroDev.*` estate, and each carries its own descriptive configuration. Lifespan: **maintained for years**, so the full design pipeline is worth running.

**Two deliverables, with different risk profiles.** Do not plan them as one kind of work.

1. **The generic contract-first MCP runtime** — contract, compiler, registry, fingerprint, adapters, scope and capability enforcement, resource server, transports. Specified by `blog-mcp/MCP-NEXT.md`, which is a **plan, not a codebase**: it states "no behavior described in this document is implemented". This is new construction carrying design risk.
2. **Generic git access** — the repository operations proven in `blog-mcp`, generalised from one repository to any declared one. This is extraction; the risk sits in the seam, not the behaviour.

**Owns** — the declaration format for a managed repository; the git operations the surfaces expose; the contract that fixes which operations a deployed instance may execute; the API, MCP and console surfaces over them.

**Does not own** — the contents of the repositories it manages, or their build and deploy pipelines. It operates on them; it does not define what they contain. It is **not a general workflow engine**: multi-step sequences are handwritten transactional composites, not a declarative feature. A flows layer on top is future work.

**Mechanism** — the service performs git operations directly. **GitHub Actions is not the execution mechanism and is a non-goal**; the `gh` CLI is in scope as the route to pull requests, checks and merges. Local git works against any host; pull-request tooling is GitHub-only.

**Companions** — the `SubZeroDev.*` estate under `D:\Dropbox\Projects\`. `SubZeroDev.Blog/tools/blog-mcp` is **load-bearing prior art, not inspiration**: ~40 test files, a React operator console, an OAuth 2.1 authorization server, a scheduler, a watcher, plus `MCP-NEXT.md` and `TODO-NEXT.md`. Read it before designing anything here. Its declaration format, clone-on-demand refusals, repository mutex, capability profiles, path allowlist and result envelope are all inherited. So is its central safety property — **the tool surface itself is the boundary**; see `design/90-decisions.md` for where this brief knowingly departs from that.

> Corrected against `design/00-brief.md` on 2026-08-03, after the brief was ratified and interrogated with `/brief-check`. The brief still outranks this section — correct this against the brief, never the reverse.

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

## Model, effort, and review budget

Model choice follows task complexity. The command being invoked does not determine the model.

Budget scales with **complexity, not size** — a one-line change to an invariant is architectural; a 500-line transcription against a settled contract is not.

Use Claude Code's current model-family aliases rather than pinning an older version:

| Tier | Model | Effort | Work |
|---|---|---|---|
| Deep reasoning | `opus` | `high` | Brief interrogation, architecture, contracts, slice planning, security, concurrency, recovery, root-cause analysis, and adjudicating design findings |
| Exceptional fork | `opus` | `xhigh` | One specific unresolved architectural or security question that remained ambiguous at `high` |
| Implementation | `sonnet` | `medium` by default; `high` when difficult | Code against a settled contract, tests, refactors, bug fixes, CI, infrastructure, and implementation-coupled documentation |
| High volume | `haiku` | `low` | Summaries, formatting, changelogs, commit messages, PR descriptions, and mechanical triage |

Do not use `max` effort unless I explicitly request it. Do not use `xhigh` for an entire design pipeline or as a substitute for a precise question.

If the current session is weaker than the required tier, say which model and effort the task warrants before doing expensive work. If the current session is stronger than required, proceed without interruption.

**Escalate rather than guess.** A high-volume task that raises an implementation question becomes implementation tier; an implementation task that raises an architectural question becomes deep reasoning. **Do not keep implementing while that uncertainty is unresolved** — that is stage 6 spending the savings stages 2–4 bought.

**Division of control.** I set the session model. You set subagent models and scale your own reasoning depth. You cannot change your own session model — if a task warrants a different tier, say so rather than silently over- or under-spending.

### Command routing

- `/brief-check`, `/design`, `/contract`, and `/slices`: `opus`, `high`.
- `/redteam`: preferably a strongest model from a different vendor than the design author. If Claude must be used, use a fresh `opus`, `high` session.
- `/slice`: `sonnet`, normally `medium`; use `high` for a large or difficult slice.
- `/reconcile`: `opus`, `high` while deciding which side of drift is correct; `sonnet`, `medium` for mechanical edits after I decide.
- `/make-human-docs`: `sonnet`, `medium`. Escalate only if the design turns out to be ambiguous — then stop, do not resolve it in prose.
- `/track`: `sonnet`, `medium`. Mechanical sync; escalate only to judge whether a drifted slice is a design change.
- `/verify`: `sonnet`, `medium`. Escalate to deep reasoning only to diagnose a failure, never to run the gates.
- `/pr`: `sonnet`, `medium`.
- `/resolve`: `sonnet`, `medium`. Escalate to judge a contested finding, not to triage the obvious ones.
- `/refine`: `sonnet`, `medium`. Never escalates — an architectural ask is routed to the command that owns it, not refined.
- `/install`: `sonnet`, `medium`.
- `/kit-help`: `haiku`, `low`. Orientation from file existence and a tracker listing; escalate only where the repository's state matches no stage.

### Session boundaries

Routing says which model runs a command. This says **when a session must end.** A boundary exists wherever carrying context would corrupt the next step's judgement, or wherever the next step must read the tree rather than remember it. **The artifact is the handoff, not the conversation** — a stage that writes one has already handed over everything the next stage is entitled to.

| Boundary | Rule | Why |
|---|---|---|
| `/design` → `/redteam` | **Fresh session, and a different vendor.** | A model recognises its own output distribution and defends it. Fresh context on the same model is already the weak form; the same session is not a review at all. |
| Any stage that writes an artifact → the next | Fresh. | The next stage's input is the committed file. A session that also remembers the arguments behind it will design against the arguments. |
| `/slices` → `/slice` | Fresh, and **one slice per session**. | A slice that does not fit one session without compaction is too large — that is a `/slices` defect, so say so rather than pressing on. |
| `/slice` → `/verify` → `/pr` → `/resolve` | **Same session.** | These act on the branch and worktree the slice just produced, and `/pr` must carry `/verify`'s did-not-run list into the description **verbatim**. A fresh session would restate it from a summary, which is the fabricated gate result *Verification* exists to prevent. |
| merge → `/track` | Fresh. | `/track` reads the tracker and `design/` as they now stand. The session that just implemented the slice holds an opinion about whether it is done, and doneness is my mark, not an agent's. |
| implementation → `/reconcile` | Fresh. | It compares the tree against the docs. The session that wrote the code carries what it *intended* to write, which is the one thing the comparison must not be given. |

**Compaction is a boundary you did not choose.** If a session compacts mid-slice, report it — the slice was mis-sized, and the work after the compaction was done against a summary of the contract rather than the contract.

The red-team stopping rule below is a boundary of a different kind — it bounds how many passes a phase gets, not where a session ends. Both apply to `/redteam`.

### Red-team stopping rule

A red-team pass is an independent phase gate, not an iterative design loop.

- One invocation authorizes exactly one complete pass.
- Run at most one full red-team pass per materially changed design revision.
- **Do recommend** another pass when you judge one is warranted, and say why. Never *start* one automatically — running it waits on my explicit request.
- After a pass, stop and present findings one at a time for adjudication.
- Classify each finding as a defect, an accepted risk, a brief conflict, or not sustained.
- A known-and-retained decision is not a new defect unless new evidence shows that it contradicts a higher-precedence source or creates a consequence not already recorded. Name that new evidence or consequence.
- Repeat `/redteam` only when I explicitly request it and the design has materially changed since the previous pass.
- Use targeted verification for local corrections; do not reread and red-team the entire design for wording-only changes.

### Budget discipline

- Full-document reads are for phase boundaries and explicitly requested drift passes.
- Use targeted searches and section reads for routine verification.
- Do not invoke a skill or command merely because it is available.
- Do not spend additional reasoning to manufacture findings, alternatives, or open questions.
- Once a policy decision is signed off and recorded, do not relitigate it without new evidence.
- Spend frontier-model reasoning on decisions that are expensive to reverse, not on producing more prose.

### What should stop being model work

Routing decides *which* model does a job. This decides whether a model should be doing it at all.

| | Work | Where it belongs |
|---|---|---|
| 🟢 **Necessary** | Architecture, contracts, root-cause analysis, design tradeoffs, adjudicating findings | A model, at the tier above |
| 🟡 **Maybe avoidable** | Regenerating context already established, duplicate repository scans, rewriting boilerplate | A model, but the repetition is a signal — say so |
| 🔴 **Definitely avoidable** | Formatting, mechanical text transformation, arithmetic over files, counting, collecting metrics | Code. It should leave the model entirely |

**A red item is a defect in the tooling, not in the run.** Noticing one is worth a line; performing it repeatedly and never saying so is the failure. When a red item recurs, put it in `## Open` in `design/90-decisions.md` so `/track` can turn it into an issue — that is the existing path, and there is no separate mechanism for this.

Two distinctions that are easy to get wrong:

- **The mechanical half of a task is red; the judgement half is not.** Opening an issue is an API call, but deciding what warrants one is not. Writing a PR description is a template, but which merge convention governs is not — `/pr` exists because that half is real. Do not classify a whole command by its cheapest step.
- **Do not report a cost you did not measure.** A model is not given its own token counts or elapsed time, so any figure it states about its own run is an estimate presented as a measurement. `tools/Measure-Session.ps1` reads the real per-call usage from the session transcript, and runs as a `SessionEnd` hook. Use it, or say nothing.

This repository is itself a bet on that distinction: a service that makes git operations reachable without a model driving a terminal is red work leaving the model, at estate scale.

## Hard rules

- **Non-goals are binding.** Anything listed as a non-goal in the brief is out of scope even if it looks trivial, even if you are already touching that file.
- **One slice at a time.** Do not start slice N+1 because you noticed something while doing slice N. Write it to `90-decisions.md` under `## Open` instead.
- **No new dependencies** without a decision-log entry naming the alternatives rejected and why.
- **No new public interfaces** that are not in `20-contract.md`. If you need one, stop and ask for a contract amendment.
- **Ask instead of assuming.** If two readings of the spec are both defensible, stop and present both. Do not pick one and proceed.
- **Every slice ends runnable.** No half-wired states committed.

## The design freeze

The pipeline's normal loop keeps `design/` live: a slice lands, `/reconcile` writes reality back, `/track` resyncs the tracker. That is right while the design is still being settled and **wrong once implementation is the bottleneck**, because each pass is generative rather than merely checking — landing slice N rewrites slice N+1's specification, which desyncs the tracker, which needs `/track`, which finds drift, which needs `/reconcile`. The loop has no fixed point. Freezing is how it is escaped.

**`design/FROZEN.md` is the marker, and its existence is the whole mechanism.** It is tracked, not ignored — a freeze is a statement to everyone working in the repository, not local state. While it exists:

- **`/reconcile` and `/track` do not run.** The tracker is deliberately allowed to go stale.
- **`/design`, `/contract` and `/slices` refuse.** Authoring is gated too, so the docs cannot drift forward while the implementation is being checked against them.
- **Slices implement against `20-contract.md` as a fixed artifact**, at the SHA the marker names.
- **A contradiction found while implementing is stated in that slice's pull request and left in the document.** Do not fix it in `design/`. The staleness is the point; recording it in the PR is what makes the eventual reconciliation cheap.

**Lifting it is deliberate and manual: delete the file, then run one reconciliation pass** — `/reconcile`, then `/track`. There is no command that lifts a freeze, because a freeze that something can lift on your behalf is one that gets lifted by habit. A slice that turns out to need a contract amendment stops and says so; that escalation is the user's to answer, and answering it may well be "thaw, amend, re-freeze."

The marker's format, which the five gated commands read and must not restate:

```markdown
# design/ is frozen

Frozen at: <sha>, <YYYY-MM-DD>
Frozen because: <what the freeze is escaping>
Lifts when: <the checkable condition — "tier one is code-complete", not "when we are ready">

To lift: delete this file, then run `/reconcile`, then `/track`.
```

A command that refuses reports `Frozen because` and `Lifts when` **verbatim** rather than paraphrasing them — the point of a stated condition is that it can be checked against, and a paraphrase is where it stops being checkable.

## Single ownership

- **Reference, never restate.** A rule that lives in another document is linked, not copied. Two copies of a rule is a promise they will diverge and a guarantee nobody notices which is stale.
- **Move, never copy.** A rule has exactly one home. When it belongs somewhere else, move it and leave a reference behind.
- If a document genuinely must repeat something to stand on its own, name the canonical copy in the text and change both in the same commit. Naming a canonical copy is what makes the others checkable.
- **The test for where a decision belongs:** would a second consumer face this same question? If yes it belongs in the shared document, even while only one consumer exercises it. Where it is genuinely unclear, the shared document is the safer home — a rule that turns out to be specific is easy to relax later; a rule discovered to be shared after three consumers each answered it differently is a migration.

## Verification

- **Verify, don't assert.** State only what you have checked. Assert nothing from memory that a command could confirm — remembered values and inferred contracts are how wrong facts get written down confidently.
- **Do not claim a gate passed that did not run.** If a tool is unavailable, say so plainly and name what was not checked. "Tests pass" means you ran them and read the output. `/verify` exists to make this checkable rather than aspirational — its report has three lists, and the one that matters is *what did not run*.
- **Never state or imply a deployed URL or a published artifact** until the deploy for that exact commit reports success. A merged PR is not a deployed site. Poll; do not estimate.
- **A regression test is verified by reverting the fix** and confirming it fails. A test that passes with and without the fix guards nothing.
- **A schema or validator change is not done until it has rejected something.** Positive and negative cases both, with the counts stated. A validator that has never failed is not known to constrain anything.

## Working with me

- Present findings and review items **one at a time for sign-off**. Never bulk-apply findings unreviewed.
- Surface real forks as a question with a recommendation, recommended option first. I routinely pick the more rigorous non-recommended option — so ask, do not assume.
- **A reconciliation ends in a decision, not a report.** Any time you compare two things and find they disagree — `/reconcile`, `/install`, `/track` drift, or any time I say "reconcile" — the work is not finished at the findings. Close by asking, one divergence at a time, each with a recommendation and what the alternatives cost. **A report I have to turn into questions myself is half the job.** If a comparison genuinely found nothing, say that plainly rather than manufacturing a fork.
  - Recommend the **resolution**, not merely which side you prefer: name what changes, in which file, and what it costs to reverse.
  - `/redteam` is the one exception, and only partly — it must not propose fixes, since naming a fix frames the problem. It still recommends a classification, per the **Red-team stopping rule** above.
- When I decline a suggestion, record it in the affected document as known-and-retained rather than dropping it silently. Otherwise it is rediscovered later as a bug.
- Ask before any choice that sets policy or a public contract: licensing, compatibility promises, a major information-architecture change.
- Call out assumptions, unverified claims, and known risks plainly. Explain the concrete evidence behind a recommendation.

## Git and delivery

- **Stage explicitly, by named path.** Never `git add -A`, `git add .`, or a bare directory. A broad add sweeps up unrelated worktree state, and an ignore pattern can make a needed file invisible to it — present locally, green locally, missing in CI, with nothing saying why.
- Run `git diff --check` before committing. Never use trailing double-spaces for a line break; it rejects them.
- **Never force-push or rewrite published history.** If a pushed commit needs changing, add a follow-up commit.
- **Push every commit before announcing a PR is ready.** Announcing invites an immediate merge, and a commit pushed after that lands on a branch nobody merges.
- External writes need my authorization: creating a remote repository, changing visibility, pushing, opening or merging pull requests, changing a domain, deploying. **Discussing a decision does not authorize it.** One carve-out — see *Tracking work*.
- Do not delete files, branches, or history without explicit authorization.
- **Deleting a *local* branch that `git branch --merged` independently confirms is carved out**, and `/done` may do it without asking. `-d` only, never `-D`; never a remote branch; a `-d` refusal is reported and asked about separately. The confirmation is what makes this safe to automate — the commits are already on the default branch, so the branch is a label rather than work. Nothing else about deletion is carved out.
- Check review **threads**, not just requested reviewers — an automated reviewer can leave blocking conversation threads that do not appear in a reviewer listing. Resolve a thread only when a validated fix satisfies it; leave ambiguous findings open and report them. `/resolve` does this; the query it needs is written out there.
- **Resolving or replying to a review thread is not carved out.** The exception in *Tracking work* covers opening issues and nothing else. Where a repository delegates resolution explicitly, follow its wording; where it is silent, ask.

## Tracking work

**Defer work to the tracker rather than processing it inline.** A finding, a follow-up, or a defect noticed in passing goes to a GitHub issue — not into a running list in the conversation, and not into a section of a document that will rot. Prose is where work goes to be forgotten.

- **Opening and labelling issues is carved out of the authorization rule.** You may open them in a repository I own, without asking. Issues are cheap and reversible, which is the entire justification; the exception is narrow and does not generalise.
- **Closing an issue is not carved out.** Nor is commenting on, editing, or labelling anyone else's, nor writing to a repository I do not own.
- **Milestones and projects still need approval.** They are structural and few, and a wrong one is visible on a public repository.
- **`/track` owns every GitHub write.** No other command creates issues, milestones, or projects. It is idempotent, so run it often rather than batching.
- `design/30-slices.md` stays authoritative for what a slice *is*; its issue tracks whether it is *done*. If the two come to describe the work differently, say so rather than editing either.
- The `## Open` section of `design/90-decisions.md` is a staging area, not a home. Once an item becomes an issue, remove it from there. **This repository's `## Open` is already large and partly struck through** — `/track`'s first run against it is a migration, not a routine sync, and the resolved bullets should leave rather than become issues.
- **Every issue reads human-first.** A narrative anyone can follow, then `### Done when` checkboxes, then the agent detail in a collapsed `<details>` block.
- **The agent block is fenced** by `<!-- agent:start -->` and `<!-- agent:end -->`. Inside the fence is regenerable; **outside it is never touched** — a ticked checkbox is progress someone recorded, an edited narrative is someone's deliberate wording.
- **Where a document already governs, the block points; where none does, it carries.** A slice names `design/30-slices.md § S<n> @ <sha>` and leaves procedure to `.claude/commands/slice.md` — copying stop conditions into an issue freezes a stale copy that nothing can go back and fix. A bug or a story has no upstream document, so its block legitimately holds the constraints. That asymmetry is the rule, not an inconsistency.
- **Criteria carry stable ids** (`S3.1`), and drift is compared on ids, never prose. Reworded criteria are not drift; an added, removed, or renumbered id is.
- **This repository's legacy S1–S22 issues predate the positional criterion ids now fixed in `design/30-slices.md`.** When an existing issue has no ids in its checkboxes, `/track` maps them positionally only if its checkbox count equals the document's criterion count; a count difference is real drift. Preserve the checkbox text and state rather than rewriting them to add ids. New slice issues include ids from the start. **S1 to S5 are merged and are never retrofitted or reopened.**
- **Report drift, change neither side.** Which is wrong is my call.
- **Ticking a checkbox is mine, not yours.** An agent reporting "S3.1 met" and a ticked box are different claims by different parties, and collapsing them removes the only human gate between "the tests pass" and "this is done". `/slice` ends by listing the ids it believes are met so ticking is mechanical.
- **Bugs and stories are filed by hand** from `.github/ISSUE_TEMPLATE/`. `/track` does not open them.
- **This does not suspend one-at-a-time sign-off.** Findings are still presented for adjudication; the tracker is where the ones you accept go, not a way to skip the conversation.

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
