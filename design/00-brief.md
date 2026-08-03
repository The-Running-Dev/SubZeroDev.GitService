# Brief — SubZeroDev.Git

> Written by me, not by a model. A model may interrogate it (`/brief-check`) but not author it.
>
> **Transcription note.** The content below was captured by interview on 2026-08-03. The model asked; the answers are mine. Selections are recorded as facts and prose is transcribed rather than restyled. This file is not ratified until I have read it back.

## Problem

> Transcribed verbatim:
>
> "The problem is this, I want to make my git repos accessible through a common place, one that will provide git operations, ui, but also expose MCP and API endpoints, and allow me to to lock deployements to pre defined worflows."

> Earlier framing, transcribed verbatim, one typo corrected (`SubZroDev.Blog` → `SubZeroDev.Blog`):
>
> "This repo is called .Git but it has to do with generalizing serving any Git repo with a UI and MCP server, work already proven in SubZeroDev.Blog mcp project."

What is wrong now, restated from the above:

- **There is no common place.** Repositories are reached one at a time, each by whatever means that repository happens to have. There is no single surface that answers for all of them.
- **What exists does not generalise.** `SubZeroDev.Blog` runs a repository-specific MCP server exposing a fixed publishing workflow as tools. The approach is proven, but it is bound to one repository — serving a second means building a second server.
- **A deployed instance is not constrained in what it can do.** Nothing fixes which operations an instance pointed at a repository is permitted to execute.

## What this repository is

**The extraction point for the generic runtime that `blog-mcp/MCP-NEXT.md` anticipates**, plus the git domain operations layered on it.

That document specifies a contract-first MCP runtime — one contract compiled at build time into an immutable registry, discovery and dispatch consuming the same artifact, undeclared tools simply not existing. It states that the reusable pieces move out only once a second consumer exists, and its Phase 8 is titled "extraction decision." This repository is that second consumer and that destination. `SubZeroDev.Blog` becomes a consumer of the runtime rather than its owner.

**Flows are a later layer.** Generic, declarative multi-step workflows are explicitly *not* part of this. `MCP-NEXT.md` §3 declines to become a general workflow engine, and that boundary is inherited here: each repository's workflow stays handwritten domain code behind the contract. What this project generalises is **serving and locking** — not authoring workflows. A flows layer sits on top of this later, out of scope until the brief changes.

## Scope

> Clarified verbatim: "To clarify the scope here, two fold. 1 extract the generic mcp server. 2. implement a generic git access, already proven in the blog repo."

**Deliverable 1 — the generic MCP server. This is new construction, not extraction.** The contract schema, compiler, normalized registry and fingerprint, module and HTTP adapters, scope and capability enforcement, the OAuth resource server, and the transports. `MCP-NEXT.md` specifies all of it and states plainly at the top: "Status: proposed; no behavior described in this document is implemented until the corresponding phase is merged and validated." It is an eight-phase plan, not a codebase. Building it here is the larger half of this project and carries design risk, not merely migration risk.

**Deliverable 2 — generic git access. This is extraction.** The repository operations already proven in `blog-mcp`, generalised from one repository to any declared repository. The behaviour exists and is tested; the risk sits in the seam.

The two halves therefore have different risk profiles and should not be planned as though they were the same kind of work.

### The split is three ways, not two

Counted against the running implementation's 46 registered tools. Roughly two-thirds are already repo-generic and merely carry a `blog_` prefix.

| Destination | Source | Count |
|---|---|---|
| **Generic git** — this repository | `localGit.ts` (`sync_base`, `create_branch`, `prepare_publish_branch`, `stage`, `commit`, `diff`, `reset_stage`, `restore_paths`) | 8 |
| | `remote.ts` (`push`, `create_pr`, `auto_merge`, `reconcile_after_merge`, `pr_status`, `list_prs`, `pr_comments`) | 7 |
| | `monitor.ts` (`check_status`, `wait_for_checks`, `wait_for_merge`, `deploy_status`, `wait_for_deploy`, `verify_published_url`, `publish_report`) | 7 |
| | `repoInfo.ts` (`log`, `branches`, `repo_health`) | 3 |
| | `scheduler.ts` (`schedule_publish`, `list_scheduled_jobs`, `cancel_scheduled_job`) — **generalised**: a hold-and-act mechanism taking the operation as a parameter, not a publish-shaped tool. A redesign rather than a move. | 3 |
| | `authoring.ts` (`repo_status`) | 1 |
| **Blog domain** — stays in `SubZeroDev.Blog` | `authoring.ts` — posts, tags, authors, hubs, validation, doc gates, preflight | 16 |

`blog_repo_status` living in `authoring.ts` is evidence that the extraction cuts **across** files rather than between them. File boundaries in the prior art do not match domain boundaries, so a move-the-file migration will not work.

### The operator console

> Clarified verbatim: "This will provide a generic container, that can manage git operations, in the base, with a UI that you can see done in the blog, except for the custom pages for managing blog posts, replicate thate."

`blog-mcp`'s React console splits along the same line as the tools.

| Destination | Views | Size |
|---|---|---|
| **Here** | `LoginPage`, `LogView`, `BranchesView`, `HealthView`, `PrStatusView`, plus `Layout` and `lib/` (`api`, `Table`, `formatDate`, `usePrWatcher`, `useRepoOwner`) | ~11 KB views, ~9 KB shared |
| **Stays in `SubZeroDev.Blog`** | `PostsView`, `ComposeView` | ~42 KB — `ComposeView` alone is 38 KB |

The API surface divides identically. Generic: `/api/repo/status`, `/api/repo/health`, `/api/log`, `/api/branches`, `/api/branch`, `/api/stage`, `/api/commit`, `/api/push`, `/api/pr`, `/api/prs`. Blog: `/api/posts`, `/api/tags`, `/api/authors`, `/api/parse-markdown`.

**This is not replication.** Two things make it new work:

1. **Every view and endpoint is repo-implicit.** `useRepoOwner` calls `/api/repo/status` with no repository parameter, because one container binds to one repository. Under one-instance-many-repos, every endpoint and every view gains a repository dimension. The console also needs a repository list or selector as its landing view — `blog-mcp`'s default route is `/posts` and there is nothing to copy.
2. **The base ships an extensible console, not just a console.** `SubZeroDev.Blog` keeps `PostsView` and `ComposeView` and registers them into the base's routing, navigation and layout. One UI, one login, consumer pages appearing as additional views. Nothing in the prior art was built for this, and it makes the base console a framework rather than an application.

**Extension happens at image build.** The base ships as a container image; a consumer builds its own image `FROM` it, adding views and domain tools. The consumer's contract is compiled and fingerprinted during *its* build, with those additions already present — so `MCP-NEXT.md`'s immutable-contract guarantee holds across the extension rather than being punctured by it.

This also settles a tension that looked larger than it was. The contract enumerates **which operations exist** and is fixed per image. Declarations enumerate **which repositories exist** and are runtime data. Operations take a repository as a parameter rather than being compiled per repository. The two are orthogonal, and onboarding a repository by declaration alone requires no rebuild.

### Layering: base plus derived images

> Stated verbatim: "the idea is provide the base git UI and then additional workflows with their own ui as defined in the derived image, blog does this."

The base image provides generic git operations and the base console. A derived image adds workflows and their own views on top. `SubZeroDev.Blog` is the exemplar: it keeps `PostsView`, `ComposeView` and its 16 authoring tools, and inherits everything beneath them.

**Open — deployment topology.** Whether this means one composed image carrying every layer the operator wants, or a base deployment plus one container per derived consumer each with its own console, is **not yet decided**. It bears on what "a common place" means and on what the console aggregates.

### Repository-controlled configuration

> Stated verbatim: "This will be built in such a way that the local repo will specify the config for it's endpoints."

Each managed repository carries its own configuration determining its endpoints, generalising `blog-mcp`'s `.config/blog.json` (`clone_url`, `base_branch`, `required_checks`, `deploy_workflow`, `branch_prefixes`).

**Repository config is descriptive, not an authority grant.** It describes the repository — base branch, required checks, deploy workflow, branch prefixes — in the same way `.config/blog.json` does today. It does not decide what the service is permitted to do. Authority stays operator-side, in deployment configuration and capability profiles, exactly as `blog-mcp` splits it: `.config/blog.json` carries repository facts while `BLOG_MCP_ALLOW_REMOTE` and `BLOG_MCP_READ_ONLY` carry permissions.

No permission-ceiling mechanism and no rule about which ref is authoritative are required, because a descriptive config cannot escalate anything. **This holds only while it stays descriptive.** If a permission-shaped field is ever added — anything a caller could set to widen what the service will do — then commit access to a repository becomes authority over the service's behaviour towards it, and both questions return. Recorded so the condition is checkable rather than remembered.

### Where the workflow lives

Today it lives in the browser: `ComposeView` calls `/api/branch` → `/api/posts` → `/api/stage` → `/api/commit` → `/api/push` → `/api/pr` in sequence. The "pre-defined workflow" is client-side orchestration inside a React component, not a server-enforced sequence. `TODO-NEXT.md` §7.1 records what that cost — a commit stranded on `main` — and §7.3 prescribes the fix.

**After the extraction it lives on the server, as transactional composites.** A caller invokes one operation that performs several git steps atomically — `prepare_publish_branch` is the worked example — rather than sequencing six calls and being trusted to get the order right. A client cannot skip a step it never orchestrates, which is what makes the safety gate enforceable rather than advisory.

**This does not reopen the workflow-engine non-goal.** A transactional composite is handwritten domain code with a fixed, reviewed sequence. It is not a declarative flow definition, has no conditionals or expressions, and is not authored by a caller. The non-goal forbids the engine, not the composites.

### Tool naming and the breaking-change cost

Generic tools should not keep a `blog_` prefix; tool names describe operations (`git_commit`, `repo_declare`). But `MCP-NEXT.md` §7.5 states that tool names are public API identifiers, that renaming or removing one is a breaking change, and that it requires a documented deprecation period or an explicit major version change. Renaming ~30 tools is therefore a real migration cost with a real policy attached, not a rename. `/design` must decide whether `SubZeroDev.Blog` sees a compatibility shim, a deprecation window, or a clean break.

## Prior art

`SubZeroDev.Blog/tools/blog-mcp` is the proven implementation and `MCP-NEXT.md` is the specified successor architecture. Neither is a sketch: ~40 test files, a React operator console, an OAuth 2.1 authorization server, a cron scheduler, a directory watcher, and an eight-phase migration plan. Both are load-bearing input, not inspiration.

### From the running implementation

| Component | What it establishes |
|---|---|
| `src/serve/capabilities.ts` | Named capability profiles per consumer, each granting `write` / `remote` / `monitor` / `scheduler` plus a `writablePathPrefixes` allowlist. |
| `src/config.ts` | Declaration format: `.config/blog.json` in the target repo — `clone_url`, `base_branch`, `required_checks`, `deploy_workflow`, `branch_prefixes`. |
| `src/bootstrap/repo.ts` | Clone-on-demand with hard refusals: never clones over a non-empty directory, never repoints an existing checkout, never `reset --hard` or `clean`. Boots dirty rather than refusing, so the container stays inspectable. |
| `src/exec/repoLock.ts` | In-process promise-chain queue serialising repo-mutating calls. |
| `src/serve/oauth.ts` | OAuth 2.1 for MCP *clients* — Dynamic Client Registration, PKCE, scoped tokens. |
| Two-token tiers | A primary and a read-only bearer token. The tier is fixed at `initialize` for the session's lifetime, and restricted sessions have mutating tools **unregistered**, not merely refused at call time. |

### From `MCP-NEXT.md`

| Concept | What it establishes |
|---|---|
| Contract-first, immutable discovery | One contract compiles to one registry with a SHA-256 fingerprint, verified at startup. Mismatch is fatal — the service must never start with a smaller accidental tool set. |
| Default deny | Undeclared tools and undeclared OpenAPI operations do not exist. Security invariants fail the build; a warning is never sufficient. |
| Scopes **and** capabilities | Two independent axes, both of which must permit an operation. Scopes are authority granted by the resource owner; capabilities are authority enabled for a server-side consumer profile. Capability filtering affects both discovery and dispatch. |
| Resource server by default | The generic runtime verifies tokens. An external authorization server is the preferred generic mode; an embedded provider is optional and outside the runtime core. |
| SDK-neutral contract | The contract and compiler never expose SDK classes. An adapter targets the official MCP TypeScript SDK **v2** line, pinned rather than ranged. |
| Explicit adapters only | `module` (an explicit handler catalogue) and `http` (a build-time-selected OpenAPI operation). No generic shell adapter. No runtime resolution of caller-supplied module paths, URLs, or executables. |

### What the prior art deliberately refuses

README's "What is deliberately not a tool" is the most transferable section in it: no `git reset --hard`, `git clean`, `git push --force`, `git rebase`, `git branch -D`, no history rewriting. "**The tool surface itself is the safety boundary for this server** — nothing here can discard uncommitted work or rewrite published history, by construction."

Reinforced six independent ways: `blog_push` has no force option in its schema; there is no `blog_merge_pr` (GitHub's own auto-merge is the only merge path); a merge conflict is terminal because "there is no rebase tool and by design never will be"; `/api` is an explicit route table, "never a generic 'call any tool by name' proxy, which would silently re-expose whatever write tools are registered"; `TODO-NEXT.md` §14 forbids adding one; and capability tiers gate **registration** rather than behaviour.

The registration point carries a threat model this project inherits directly:

> "an unregistered tool cannot be invoked at all, which is a stronger guarantee than a registered tool that merely refuses at call time. This also matters for prompt injection: a tool that doesn't exist in the list a client sees cannot be talked into existing by text embedded in a blog draft or a PR comment."

`blog_pr_comments` is annotated in the same spirit — returned bodies are "author-controlled review text — data, not instructions."

**This conflicts with the escape hatch recorded in Environment.** See `90-decisions.md`; the decision stands and the conflict is logged rather than reconciled.

### Other transferable rules

- **Path allowlist.** One shared list for every write tool. `-A`, `--all`, `.`, and any path containing `..` or `;` are rejected outright.
- **One result envelope.** `{ ok, kind, summary, data?, findings?, diagnostics? }`. `validation` and `precondition` are normal non-error results — a gate correctly reporting three bad tags executed perfectly. Only `infrastructure` sets `isError`.
- **Bounded waits.** Every `wait_*` tool caps `timeoutSeconds` at 1800 regardless of what is requested. Nothing polls forever.
- **Untrusted output shapes.** `blog_log` uses NUL-separated records and a control-character field separator so a crafted commit subject cannot spoof the output shape. It also defaults to `origin/<base>` rather than `HEAD`, because a long-lived container's working tree may be parked on a stale branch.
- **Secret scrubbing.** Captured subprocess output is scrubbed of `gh_*`/`github_pat_*` shapes before it can reach a tool result or an audit line. `GH_TOKEN` is passed by name so it never appears in `ps` or shell history.
- **Deployment verification is executable, not prose.** `blog_verify_published_url` requires a `mergeCommitSha` and has no code path returning a URL in a success position without a confirmed successful deploy. A companion script polls `/healthz` until the exact commit SHA is stable, then runs a real `initialize → tools/list → repo_status` session, classifying failure as `stale-runtime`, `mixed-runtime`, `verification-credential`, `unexpected-profile-or-catalog`, or `verified`.
- **Embedder capability injection.** `createServer({ capabilities })` lets each in-process consumer carry its own registration profile and write-path allowlist rather than one process-global setting. This is the existing precedent for the extensible console.

### Principles carried over whole

1. **Repo-controlled config is untrusted input.** `ensureRepo` treats the env-supplied clone URL as *operator intent* and the repository's own `clone_url` as *repo-controlled data*, and cross-checks them rather than trusting either alone.
2. **Unattended actors must not be able to unlock themselves.** The cron and watcher profiles strip `.github/workflows/`, `.config/`, `tools/` and `build/` from their writable prefixes. A lock is only as strong as the protection on the declaration that defines it.
3. **The protected-base invariant.** `TODO-NEXT.md` §7 records a real incident: a commit stranded on `main` when branch creation re-based from `origin/main`. The seven invariants and the transactional `prepare_publish_branch` that came out of it are general git-workflow safety, not blog-specific.
4. **One canonical domain service per operation.** `TODO-NEXT.md` §3.1 — MCP, HTTP, the console and any future adapter call the same domain service. No surface reimplements a variant.

## Deployment-time workflow locking

> Clarified verbatim: "I meant when i deploy the container that accesses a git repo, it can only execute predefined worklows."

An instance can execute only the operations predefined for it, and nothing else. The mechanism is the contract: `MCP-NEXT.md`'s compiled registry plus per-consumer capability profiles already express this, and default-deny makes it enforceable rather than advisory.

This concerns **this service's own capability set**. It is not about a target repository's CI/CD, its build pipeline, or how that repository deploys itself.

**Open — build time or deploy time.** `MCP-NEXT.md` fixes the contract at *build* time, baked into the image and fingerprinted. This brief describes the lock as fixed at *deploy* time, per instance. With many repositories declared at runtime those cannot be the same artifact: a contract baked at build cannot enumerate repositories declared later. Something has to give, and `/design` must say which.

## Who it is for

**A single operator — me.** One expert user. No multi-tenancy.

| Surface | Consumer |
|---|---|
| Operator console (UI) | Me — driving git operations across repos, inspecting what an agent did |
| HTTP API | Me, directly |
| MCP | Agent runtimes (Claude Code, Codex, other MCP clients) |

### Authentication

**One operator identity.** A username, not a bare password. No accounts table, no roles, no per-user permissions.

That identity can be proven two ways, both required:

- **Local username and password**, with **TOTP second factor, enforced** — always on for local login, not offered as an option. There is no second operator to recover a lockout, so recovery is a design concern rather than an afterthought.
- **Generic auth providers** — federation over **one standard protocol with a configurable issuer**, so any provider speaking it works without code changes. Vendor-neutral within that protocol; anything not speaking it is out. This matches `MCP-NEXT.md` §5.4's preferred generic mode, where an external authorization server is the default and an embedded provider is the exception.

Separately, and not to be confused with the above, the service is itself an **OAuth authorization server for MCP clients**. The two roles are opposite ends of the same protocol family:

| Role | Direction | Authenticates |
|---|---|---|
| Authorization server | Clients come to us | MCP clients — which tools a given client may call |
| Relying party | We go out to a provider | The operator — who is at the console |

## Non-goals

The binding list. Everything here is out of scope for every agent, permanently, until this file changes.

- **Not a general workflow engine.** Inherited from `MCP-NEXT.md` §3. Multi-step workflows remain domain code behind the contract, not a generic declarative feature. A flows layer on top is future work, not part of this.
- **Not a GitHub API proxy.** No general wrapper over issues, releases, projects, or discussions.
- **Not a workflow dispatcher.** The service performs git operations itself rather than triggering a CI runner and waiting. GitHub Actions is not the execution mechanism. The `gh` CLI remains in scope as the route to pull requests, checks and merges.
- **No multi-tenancy.** No user accounts, no roles, no per-user permissions. One operator identity.
- **No distributed or multi-node concurrency.** A single instance serialising its own work in process. `blog-mcp`'s mutex is per-process only — two containers against one working tree race, and the README says so explicitly.
- **No generic shell adapter.** Per `MCP-NEXT.md` §5.3, command execution stays behind typed domain handlers that control arguments, working directory, scrubbing and errors.
- **Git only.** No Mercurial, Subversion, or any other version control system — permanently, not merely initially.
- **No cross-repository operations.** A change spanning two declared repositories is never treated as one unit. Each repository is operated on independently. This rules out coordinated multi-repository releases.
- **No caller-supplied credentials or remote URLs.** A caller can never hand the service a token or a repository URL at call time. Both come only from operator configuration. This closes the obvious route by which a compromised or injected agent redirects the service at something new.
- **No rate limiting or quotas on callers.** Serial mutation already bounds throughput. A runaway agent is noticed by the operator, not throttled by the service.

### Considered and deliberately *not* made non-goals

In scope, or at least not excluded. Recorded so each reads as a decision rather than an omission.

- **A web UI** — in scope, a first-class surface.
- **Arbitrary git** — in scope behind an escape hatch. See Definition of done.
- **The `gh` CLI** — in scope. Bundled with Actions in an earlier draft; the two are separable and were separated.
- **Locking and queueing** — in scope, and required. An earlier draft made "no queue, no locking" a non-goal. That was wrong: one-operation-at-a-time is the *outcome* a lock produces, not the absence of one.
- **Creating, deleting, renaming or changing visibility of a repository** — offered as a non-goal and declined.
- **Deleting or force-updating remote branches and tags** — declined, consistent with the escape hatch reaching any git operation.
- **Viewing or editing file contents in the console** — declined; a content view or editor is not ruled out.
- **Being a git host itself** — declined.
- **Outbound notifications** (email, chat, webhook) — **in scope.** Declined as a non-goal, then explicitly reopened: an unwatched run that stops at a terminal state must be able to reach the operator, otherwise "unwatched" means "unnoticed". Mechanism undecided.
- **Backing up the managed clones** — declined; they remain rebuildable from their remotes either way.
- **Offline operation** — declined, though clone-on-demand assumes reachable remotes throughout.
- **Consumers restyling the console** — declined; a derived image is not forbidden from changing look and layout.

## Definition of done

Twenty checkable statements. Nothing here is aspirational; each is either demonstrated or it is not.

### The runtime

1. **The contract compiles and is enforced.** Contract, compiler, normalized registry and fingerprint exist, and the service refuses to start on a mismatch rather than starting with a smaller accidental tool set.
2. **Default-deny has rejected something.** Unsafe, contradictory and incomplete contracts fail the build, with the rejection counts stated. A validator that has never failed is not known to constrain anything.

### Generalisation

3. **`SubZeroDev.Blog` runs as a consumer**, with no loss of capability. Its ~16 authoring tools remain its own domain code; the runtime, the contract and all repository-generic git operations come from here. No bespoke MCP server, no duplicated git layer.
4. **A second repository, end to end.** Some repository other than `SubZeroDev.Blog` is declared and driven through a full change. Generalisation is the justification for the whole project; one consumer is not evidence of it.
5. **A new target repository is onboarded by declaration alone** — no code changes, no rebuild, no new server, no restart. A running instance picks it up and clones it while continuing to serve every other repository.
6. **The repository dimension is complete.** Every endpoint and every view takes a repository, and the console lists and selects across them.

### Safety

7. **Unsafe operations are provably blocked on the default path.** The set is exactly the six the prior art refuses by construction: `reset --hard`, `clean`, `push --force`, `rebase`, `branch -D`, and history rewriting. Each has been attempted and rejected, with counts stated. This gate tests the default path only.
8. **Escape-hatch use is logged and attributable.** Reaching all six blocked operations through the hatch produces six attributable entries. This is the only property claimed for the hatch.
9. **A second instance refuses to start** against the same storage volume, including after an unclean kill left a stale lock.

### Authentication

10. **Local login with enforced TOTP**, including a working lockout-recovery path. There is no second operator to let you back in.
11. **Federation against a real provider** — the operator authenticates through an external identity provider over the chosen protocol, proven against a real issuer rather than a fixture.
12. **An MCP client authorises and reconnects.** Dynamic registration, scoped tokens, refresh, and — given durable grants — reconnection after a container restart without re-authorising. This is the departure from the prior art, so it is proven rather than assumed.

### Operation

13. **An agent completes a change end-to-end unwatched, for `SubZeroDev.Blog`** — branch through merged PR — without me touching git and without me supervising. A standing property, not a single demonstration: every terminal state is defined and reachable without me, including merge conflict, failed required check, timeout and restart mid-operation. "Unwatched" means it stops safely and says so, not that it always succeeds.
14. **Restart mid-operation recovers**, rather than merely detecting that something was interrupted. Killing the container mid-operation leaves recoverable state.
15. **The deployment serves the expected build.** An executable check confirms the exact commit is serving the expected tool catalogue, classifying failure rather than reporting a bare pass.
16. **Health, readiness, running revision and contract fingerprint** are reported.

### Handover

17. **Blog parity is proven, not asserted.** Tool metadata compared against captured fixtures per profile, so "no loss of capability" is measured.
18. **Rollback is tested.** Returning `SubZeroDev.Blog` to its current server is documented and has been done once.
19. **The console is verified in a real browser**, every view driven end to end against a real repository. The prior art records two genuine bugs found only this way, because its tests drove the API directly and never exercised client-side sequencing.
20. **Operator documentation exists** — configuration, onboarding a repository, backup and recovery, revocation, rollback.

## Environment

- **Ships as a container app.** A service performing git operations directly. Not a workflow dispatcher, not a wrapper around a runner. `blog-mcp`'s image ships PowerShell 7, git and `gh`, and deliberately no Docker.
- **One instance serves many repositories.** This departs from `blog-mcp`, which binds one container to one repository. Consequences: per-repo declarations, per-repo capability profiles, per-repo credentials in one process, and a console that aggregates.
- **Target repositories are cloned on demand** from their remotes when a declaration is exercised. Nothing pre-existing on the host is assumed; the service manages its own storage lifecycle. Headless operation is the point — a caller with no local checkout at all can drive the full pipeline.
- **Credentials are per-declaration.** Each declaration names its own. **Open — whether isolation is a scoped-lookup convention or an enforced boundary is deliberately deferred.** Until that is decided the brief claims only that a credential is *not given* to an operation outside its declaration, not that it *cannot be reached*.
- **Any git repository, unbounded in count and host.** Local git operations work against any host. Pull requests, checks, merges and deploy monitoring are GitHub-only and are simply unavailable elsewhere — a declaration states its host and gets the tool set that host supports. The declaration format must not encode `SubZeroDev.*` habits.
- **Serialised, for mutations.** Repo-mutating operations run one at a time, globally across all repositories, enforced by an in-process lock. Reads and monitoring waits run outside it, as in the prior art — otherwise a single `wait_for_checks` would hold every repository for up to its 1800-second cap. A crash leaves exactly one mutating operation half-done.
- **Operation surface:** full git is reachable, but the pre-defined path is the default. Lower-level git requires deliberately taking the escape hatch.
- **A deployed instance executes only its predefined operations.** See Deployment-time workflow locking.
- **MCP TypeScript SDK v2**, pinned rather than ranged, per `MCP-NEXT.md` §5.2.

### Scale and deployment

- **Repository count is unbounded and assumed to grow.** No fixed number. Eviction and disk-pressure handling are therefore in scope rather than deferrable. **Open — the storage policy itself is left to `/design`**: whether clones are an evictable cache, retained until the operator intervenes, or bounded by a declaration cap. Whatever is chosen must never discard a clone holding uncommitted or unpushed work, per the prior art's standing refusal.
- **Publicly reachable, behind a reverse proxy.** As `blog-mcp` is deployed today. Authentication, the enforced TOTP factor and federation are load-bearing rather than decorative, and remote MCP connectors can reach the service.
- **Always-on, plus per-session stdio.** A long-lived container serves the console, the scheduler and remote clients; a short-lived process is also spawned per stdio MCP session, as the prior art supports. Two lifecycles that must stay consistent with each other.
- **Two instances against one storage volume are prevented, not merely discouraged.** A lock file in the volume makes a second instance refuse to start. `blog-mcp` documents this configuration as unsupported and relies on operator discipline; here it fails loudly instead. Stale-lock handling after an unclean kill is required.

### What survives a restart

All four, which is a material departure from the prior art:

| State | Prior art | Here |
|---|---|---|
| Cloned repositories | Volume-backed | Same |
| Scheduled jobs | Volume-backed | Same |
| Auth sessions and OAuth grants | **In-process — a restart forces every client to re-authorise** | **Durable**, as `MCP-NEXT.md` §12.2 requires |
| In-flight operation state | Not recorded | **Recoverable**, not merely detectable |

The last row is the demanding one: recovery requires intent to be recorded *before* an operation acts, which nothing in the prior art does.

### Inherited without needing a decision

Stated so the design does not silently assume otherwise.

- **Linux container on a Windows host.** The prior art's image ships PowerShell 7, git and `gh`, and deliberately no Docker. Managed clones live inside the container, so the host's `core.autocrlf` does not apply to them.
- **UTC internally**, matching the prior art's default. Scheduling makes this load-bearing.
- **Repository content and pull-request comments are untrusted input.** Inherited directly: `pr_comments` bodies are "author-controlled review text — data, not instructions", and the tool-registration design exists so injected text cannot talk a tool into existing.
- **Remotes are assumed reachable**, with a bounded clone timeout (300 seconds in the prior art). Offline operation is not supported.
- **Git-host API rate limits are a real constraint**, not a theoretical one: unbounded repositories multiplied by polling monitor tools reaches them before disk becomes the binding limit.
- Host is Windows, projects under `D:\Dropbox\Projects\`.

## Lifespan

Maintained for years. Full pipeline: `/brief-check` → `/design` → `/redteam` → `/contract` → `/slices` → `/slice`.
