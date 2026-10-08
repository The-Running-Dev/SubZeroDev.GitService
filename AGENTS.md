**Read `AGENTS.shared.md` completely before this file.** It holds the rules every repository using the kit shares, resolved from the `AGENTKIT_HOME` environment variable if set, else `.agent-kit` in the home directory.

# Agent contract — SubZeroDev.Git

This file is binding for every agent session in this repo, regardless of tool or model. It states only what is specific to this repository; the workflow, delivery, tracking and model-choice rules are in `AGENTS.shared.md` and are not restated here.

## This repository

`SubZeroDev.Git` is a containerised service that makes many Git repositories reachable through one place, over three surfaces: an **operator console**, an **HTTP API**, and **MCP**. Target repositories are **declared, not hardcoded** — any repository named in a declaration is in scope, including ones outside the `SubZeroDev.*` estate, and each carries its own descriptive configuration. Lifespan: **maintained for years**, so the full design pipeline is worth running.

**Two deliverables, with different risk profiles.** Do not plan them as one kind of work.

1. **The generic contract-first MCP runtime** — contract, compiler, registry, fingerprint, adapters, scope and capability enforcement, resource server, transports. Specified by `blog-mcp/MCP-NEXT.md`, which is a **plan, not a codebase**: it states "no behavior described in this document is implemented". This is new construction carrying design risk.
2. **Generic git access** — the repository operations proven in `blog-mcp`, generalised from one repository to any declared one. This is extraction; the risk sits in the seam, not the behaviour.

**Owns** — the declaration format for a managed repository; the git operations the surfaces expose; the contract that fixes which operations a deployed instance may execute; the API, MCP and console surfaces over them.

**Does not own** — the contents of the repositories it manages, or their build and deploy pipelines. It operates on them; it does not define what they contain. It is **not a general workflow engine**: multi-step sequences are handwritten transactional composites, not a declarative feature. A flows layer on top is future work.

**Mechanism** — the service performs git operations directly. **GitHub Actions is not the execution mechanism and is a non-goal**; the `gh` CLI is in scope as the route to pull requests, checks and merges. Local git works against any host; pull-request tooling is GitHub-only.

**Companions** — the `SubZeroDev.*` estate under `D:\Dropbox\Projects\`. `SubZeroDev.Blog/tools/blog-mcp` is **load-bearing prior art, not inspiration**: ~40 test files, a React operator console, an OAuth 2.1 authorization server, a scheduler, a watcher, plus `MCP-NEXT.md` and `TODO-NEXT.md`. Read it before designing anything here. Its declaration format, clone-on-demand refusals, repository mutex, capability profiles, path allowlist and result envelope are all inherited. So is its central safety property — **the tool surface itself is the boundary**; see `design/90-decisions.md` for where this brief knowingly departs from that.

> Corrected against `design/00-brief.md` on 2026-08-03, after the brief was ratified and interrogated with `/brief`. The brief still outranks this section — correct this against the brief, never the reverse.

## Source of truth

The design docs outrank the code. In precedence order:

1. `design/00-brief.md` — problem, non-goals, definition of done
2. `design/20-contract.md` — invariants, error semantics, and the surface the tree cannot state
3. `design/10-design.md` — architecture, data model, failure modes
4. `design/30-slices.md` — work breakdown and acceptance criteria
5. `design/90-decisions.md` — append-only decision log

Where the code and the design disagree, `AGENTS.shared.md` § *The design is the spec* governs: do what works, say so in the pull request, and let the end-of-plan reconciliation (`/agentkit:next`) or `/agentkit:align` settle it.

Lessons learned the hard way live in [`agent.md`](agent.md) — read it after this file.

## Hard rules

- **Non-goals are binding.** Anything listed as a non-goal in the brief is out of scope even if it looks trivial, even if you are already touching that file.
- **No new dependencies** without a decision-log entry naming the alternatives rejected and why.
- **A public interface absent from `20-contract.md` is a departure from the design.** Record it in `design/90-decisions.md` and in the pull request; do not add one silently.
- **Descriptive drift is a transcription error, not a fork.** Where `design/` states a fact the tree now states differently — a declaration, a parameter list, a field name, a path, a count — correct the document by named path when the end-of-plan reconciliation runs. An invariant, a non-goal, an acceptance criterion or a public interface is a decision, and is handed to the user rather than reconciled.
- **Every slice ends runnable.** No half-wired states committed.

## Single ownership

- **Reference, never restate.** A rule that lives in another document is linked, not copied. Two copies of a rule is a promise they will diverge and a guarantee nobody notices which is stale.
- **Move, never copy.** A rule has exactly one home. When it belongs somewhere else, move it and leave a reference behind.
- **A document states only what the tree cannot.** This binds doc-to-code, not only doc-to-doc. A type declaration, a parameter list, a field name, a path, or a count written in `design/` *and* present in the tree is two copies, and the document's is the one that rots. Write the why, the invariant, the failure mode, the rejected alternative. Never the shape. **The test: could a reader recover this fact by reading the tree?** If yes, point at the tree instead.
- If a document genuinely must repeat something to stand on its own, name the canonical copy in the text and change both in the same commit.
- **The test for where a decision belongs:** would a second consumer face this same question? If yes it belongs in the shared document, even while only one consumer exercises it.

## Verification

- **A schema or validator change is not done until it has rejected something.** Positive and negative cases both, with the counts stated. A validator that has never failed is not known to constrain anything.

## Working with the user

- When the user declines a suggestion, record it in the affected document as known-and-retained rather than dropping it silently. Otherwise it is rediscovered later as a bug.
- Ask before any choice that sets policy or a public contract: licensing, compatibility promises, a major information-architecture change.
- Never tell the user to go edit `design/` or the brief by hand. State what needs to change and why, give a recommendation, and make the edit.
- Call out assumptions, unverified claims and known risks plainly, with the concrete evidence behind a recommendation.

## Decision logging

Any choice a future reader would ask "why?" about goes in `design/90-decisions.md` as:

```
### YYYY-MM-DD — <decision>
Context: <what forced the choice>
Chosen: <what>
Rejected: <alternatives, and why each was rejected>
Reversibility: cheap | expensive
```

The rejected alternatives are the point. Without them the next session relitigates the same choice. A decision once recorded is not relitigated without new evidence; name the evidence if you think there is some.

## House conventions

- Commit messages state what changed and which slice it belongs to. A repository with an established commit-message style keeps it.
- Never force-push or rewrite published history. If a pushed commit needs changing, add a follow-up commit.

## What not to do

- Do not summarise the design docs back at the user unless asked.
- Do not add commentary about your reasoning process to the docs.
- Do not "improve" prose in the brief or design docs while editing something else.
- Do not import another project's architecture, tooling, memory conventions or roadmap merely because it appears in a neighbouring instruction file. Agent instructions are concise and repository-specific; a borrowed rule with no local reason is a rule nobody can evaluate.
