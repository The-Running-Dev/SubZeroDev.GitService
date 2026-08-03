# Design — SubZeroDev.Git

Designed against `00-brief.md` (ratified 2026-08-03). Where this document decides something
the brief left open, the decision is logged in `90-decisions.md` on the same date. Where it
could not decide, the question is in `## Open questions` rather than assumed away.

**The spine of this design is one idea: a four-layer capability lattice that only ever
narrows.** Build time fixes which operations can exist. Deploy time narrows to what this
instance may do. A declaration narrows to what may be done to one repository. A session
narrows to what one caller may do. Nothing at runtime can widen anything. Every open question
the brief handed to `/design` — build-versus-deploy locking, per-repository narrowing versus
session-level discovery, the escape hatch versus the lock, host-varying tool sets — resolves
to a position on that lattice.

---

## Data model

### Storage kinds

Three, each chosen for a different reason.

| Kind | Holds | Why |
|---|---|---|
| **Structured store** — SQLite on the named volume | Declarations, clone metadata, OAuth clients/grants/tokens, operator credentials, scheduled jobs, operation journal, notification outbox | Transactional. Recovery classification and grant durability both require reading and writing several rows atomically. |
| **Append-only audit log** — JSONL on the volume | One scrubbed line per mutating call and per escape-hatch use | Must survive corruption of the structured store. An audit trail that shares a failure mode with the thing it audits is not an audit trail. |
| **Working clones** — directories on the volume | One git working copy per materialised declaration | They are git repositories; nothing else can represent them. |

Migrations on the structured store are explicit and forward-only, and the store is copied to a
timestamped backup **before** each migration runs. Definition-of-done item 18 requires a tested
rollback to a previous image; a forward-only schema makes that impossible without a
pre-migration copy to restore alongside it.

### Entities

#### `Declaration` — a managed repository

Operator-owned authority. Persisted. Identity is `id`, chosen by the operator, immutable.

| Field | Type | Notes |
|---|---|---|
| `id` | string, `^[a-z0-9][a-z0-9-]{0,62}$` | Identity. Appears in the MCP resource URI and every API path, so it is URL-safe by validation rather than by escaping. Renaming is delete-then-create. |
| `cloneUrl` | string | Operator intent. Its host must be on the deployment's remote-host allowlist. |
| `host` | `github` \| `generic` | Determines which host capabilities the grant may contain. `generic` gets local git only. |
| `credentialRef` | string | A *name*, never a value. Resolved at point of use. Carries its own allowed-host constraint. |
| `capabilityGrant` | set of capability names | The per-repository layer of the lattice. Must be a subset of the deployment ceiling at write time. |
| `writablePathPrefixes` | string[] | Path allowlist for every write against this repository. Operator-side, because this is authority and not a repository fact. |
| `pinned` | boolean | When true the clone is never evictable. |
| `identity` | `{ gitUserName, gitUserEmail }` | Commit author for operations this service performs. |
| `state` | `active` \| `orphaned` | Deleting a declaration marks it `orphaned` and leaves the clone alone. |
| `createdAt`, `updatedAt` | ISO 8601 UTC | |

Mutable at runtime by the operator, which is what makes definition-of-done item 5 — onboarding
by declaration alone, no restart — reachable at all.

Re-declaring an `id` whose orphaned clone points at a different remote is refused. Removing
that clone is a separate, explicitly flagged, audited operation that itself refuses when the
clone holds unpushed work.

#### `RepositoryConfig` — repository-supplied facts

**Derived, in-memory, cached, never persisted as truth.** Read from a file in the target
repository's working tree, generalising `.config/blog.json`.

| Field | Type | Source |
|---|---|---|
| `baseBranch` | string | repository, default `main` |
| `requiredChecks` | string[] | repository |
| `deployWorkflow` | string | repository |
| `branchPrefixes` | string[] | repository |

Nothing here grants authority. The invariant that makes this safe is stated once, here, and is
checkable: **any field a caller could set that widens what the service will do lives in the
`Declaration`, not in `RepositoryConfig`.** The brief records the same rule and the condition
under which it must be revisited; `/contract` verifies no permission-shaped field has drifted
into the repository-side format.

A missing config file is not an error — every field defaults, and a declaration with no config
file at all is fully operable. That is what keeps the format from encoding `SubZeroDev.*`
habits.

#### `Clone` — a materialised working copy

Metadata persisted in the structured store; the tree itself is a directory.

| Field | Type | Derived? |
|---|---|---|
| `declarationId` | string | identity, 1:1 with `Declaration` |
| `state` | `absent` \| `materialising` \| `ready` \| `dirty` \| `needs-attention` \| `evicted` | derived from disk at boot, then maintained |
| `path` | string | derived from `declarationId` |
| `sizeBytes` | number | derived, refreshed after each mutation |
| `lastOperationAt` | ISO 8601 UTC | eviction ordering key |
| `observedRemote` | string | read from the clone; cross-checked against `Declaration.cloneUrl` at every materialisation |
| `safeToEvict` | boolean | **derived, never stored** — recomputed at eviction time only |
| `attentionReason` | string? | set when recovery could not classify, or when the tree is dirty from outside |

`state` is authoritative in memory and re-derived from disk at boot. Persisting it is a
convenience for reporting, not a source of truth: an unclean kill can make the stored value a
lie, and boot must not trust it.

#### `CapabilityProfile` and the lattice

Capabilities are the single vocabulary for "may this happen". Four layers, each a subset of the
one above:

1. **Contract set** — every capability named by any tool in the compiled registry. Fixed at
   image build, covered by the contract fingerprint.
2. **Deployment ceiling** — configured per deployment. Startup is fatal if it names a capability
   the contract set does not contain.
3. **Declaration grant** — `Declaration.capabilityGrant`, intersected with the host-supported
   set implied by `Declaration.host`. Writing a grant outside the ceiling is refused.
4. **Session grant** — the actor profile (operator console, MCP client, scheduler, watcher)
   intersected with the OAuth scopes actually granted.

The effective set for a call is the intersection of all four. There is no operation anywhere
that adds a capability to a set.

| Capability | Covers |
|---|---|
| `repo.read` | status, log, branches, health, diff |
| `git.local.write` | branch preparation, stage, commit, restore-paths |
| `git.raw` | the escape hatch |
| `host.pr.read` | PR status, list, comments |
| `host.pr.write` | create PR, enable auto-merge, reconcile after merge |
| `host.checks.read` | check status, bounded waits, deploy status, published-URL verification |
| `scheduler.manage` | create, list, cancel held operations |
| `declaration.manage` | declare, amend, orphan a repository |
| `content.*` | reserved for consumer domains; the blog consumer adds its own under this prefix |

`host.*` capabilities are only ever present in a grant when `Declaration.host` supports them.
That is how a per-declaration tool set varies by host without the contract varying by
declaration: the tool exists in every image and simply has no session that can reach it for a
`generic` declaration.

Scopes stay orthogonal and coarse — `read`, `write`, `raw`, `schedule` — because the OAuth
resource indicator already carries the repository. Scopes are what the resource owner granted;
capabilities are what the server side enabled; both must permit the call.

#### `Session`

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `kind` | `operator` \| `mcp` \| `scheduler` \| `watcher` | |
| `actorRef` | `{ kind, subject, clientId? }` | Passed by value into every context. Audit and journal never import the authorization module — see Module boundaries. |
| `repositoryBinding` | string? | **Set for `mcp`, absent for `operator`.** |
| `grant` | set of capability names | Layer 4, computed at session establishment and frozen for the session's lifetime. |

An MCP session binds to exactly one repository at `initialize`, because the MCP resource
indicator *is* the repository: the canonical URI is `/mcp/{declarationId}`. That is what lets
capability filtering affect **discovery as well as dispatch**, which the prior art requires and
which a repository-agnostic session cannot deliver. An operator session spans every
declaration, because the console has to aggregate across them.

Freezing the grant at session establishment inherits the prior art's rule that a token tier is
fixed at `initialize` for the session's lifetime.

#### `OperationJournalEntry` — the recovery record

Written **before the first side effect** of a mutating operation. This is the material
departure from the prior art that definition-of-done item 14 demands: nothing recovers from an
interruption whose intent was never recorded.

| Field | Type | Notes |
|---|---|---|
| `operationId` | string | identity |
| `declarationId` | string | |
| `tool` | string | registry name |
| `input` | JSON | scrubbed |
| `actorRef` | `{ kind, subject, clientId? }` | |
| `preState` | `{ branch, headSha, indexClean, treeClean, upstreamSha }` | captured under the lock, before acting |
| `steps` | array of `{ name, state, at }` | composites journal each sub-step |
| `state` | `intended` \| `applied` \| `settled` \| `attention` | |
| `startedAt`, `updatedAt` | ISO 8601 UTC | |

`settled` means the outcome has been observed and reported. Any entry not `settled` at boot is
a recovery candidate.

#### `ScheduledJob` — generalised hold-and-act

The publish-shaped scheduler becomes an operation-shaped one — a redesign rather than a move.

| Field | Type | Notes |
|---|---|---|
| `id` | string | identity |
| `declarationId` | string | |
| `tool` | string | **must name a tool in the compiled registry annotated schedulable** |
| `input` | JSON | validated against that tool's input schema *at creation*, not at fire time |
| `notBefore` | ISO 8601 UTC | |
| `onMissed` | `{ mode: 'catch_up' }` \| `{ mode: 'skip_if_older_than', seconds }` | explicit per job, never an implicit default — inherited whole |
| `frozenGrant` | set of capability names | the creator's effective set, captured at creation |
| `status` | `pending` \| `running` \| `done` \| `skipped` \| `cancelled` \| `needs-attention` | |
| `reason` | string? | set on `skipped` or `needs-attention` |
| `createdBy` | `actorRef` | |

Two properties make this neither a workflow engine nor a shell adapter. It holds **one**
operation — no sequence, no conditionals, nothing authored by a caller. And `tool` resolves
inside the compiled registry, so an undeclared name does not exist. At fire time the scheduler
re-intersects `frozenGrant` with the current declaration grant and deployment ceiling; a job
can lose capability between creation and firing but can never gain it.

#### `AuditEntry`

One scrubbed JSON line per mutating call and per escape-hatch use: timestamp, `operationId`,
`declarationId`, `tool`, `actorRef`, result kind, changed paths, and — for `git.raw` only — the
argument vector. Best-effort append that never fails the call it describes, per the prior art.
`actorRef` is what makes definition-of-done item 8's "attributable" true rather than asserted.

#### `InstanceLease`

A single file at the volume root holding instance id, boot id, host name, start time, and a
lease timestamp refreshed every 10 seconds. Held open under an exclusive advisory OS lock for
the process's lifetime.

#### `ToolResult` — the one envelope

`{ ok, kind, summary, data?, findings?, diagnostics? }`, inherited intact, with the `kind` union
widened from the prior art's four to eight by merging in `MCP-NEXT.md` §9.3:

| `kind` | `isError` | Meaning |
|---|---|---|
| `success` | false | |
| `validation` | false | Caller input does not satisfy the contract. |
| `precondition` | false | Valid request; repository state prevents it. |
| `conflict` | false | Another operation or state transition conflicts — including a lock-acquire timeout. |
| `authorization` | false | Scope or capability insufficient at dispatch. |
| `upstream` | **true** | A declared external service failed. |
| `timeout` | **true** | The operation exceeded its declared limit. |
| `infrastructure` | **true** | Unexpected runtime or environment failure. |

The rule generating that column, stated once so it does not have to be remembered per kind:
**`isError` is true when the failure is about the service or its dependencies, false when it is
about the request or the repository state.** A gate correctly reporting three bad tags executed
perfectly, and so did a push correctly refused because the branch is protected.

Token, audience and issuer failures never reach this envelope — they are transport-level `401`
with a `WWW-Authenticate` resource-metadata challenge, because the caller has to be told where
to authenticate. Scope and capability failures at dispatch do produce an `authorization`
envelope: reaching one means a stale catalogue or a by-name call for a tool the session was
never shown, and both are worth auditing rather than dropping at the transport.

---

## Module boundaries

Six layers. **Dependencies point downward only.**

```text
L5  Surfaces        MCP transport  |  HTTP API  |  console host
L4  Runtime         dispatch pipeline  |  authorization  |  operator identity
L3  Adapters        module adapter  |  http adapter
L2  Domain          git operations | composites | host adapter | scheduler | notifier
L1  Platform        declarations | credentials | clone store | exec | locks
                    journal | audit | result | errors | clock
L0  Contract        contract types  |  compiler  |  generated registry
```

| Module | Owns | Depends on | Exposes |
|---|---|---|---|
| **Contract types** (L0) | The SDK-neutral shape of a tool declaration: name, schemas, scopes, capabilities, annotations, limits, execution target. | Nothing. | Types and authoring helpers. |
| **Compiler** (L0, build-time only) | Normalisation, semantic safety validation, deterministic emission, SHA-256 fingerprint. | Contract types. | A registry artifact, a sanitised manifest, a fingerprint, generated documentation. **Not present at runtime.** |
| **Result / errors / clock** (L1) | The envelope, the eight kinds, the error classes, injectable time. | Nothing. | Constructors and predicates. |
| **Exec** (L1) | Every subprocess. Fixed executables, argument vectors never strings, no shell, pinned working directory, secret scrubbing of captured output, credentials passed by environment name so they never appear in a process listing. | Result, errors. | Guarded `git` and `gh` runners. |
| **Locks** (L1) | The global mutation mutex and the per-declaration materialisation mutex. | Nothing. | Two acquire functions with bounded waits. |
| **Declarations** (L1) | The declaration table, the lattice intersection, the remote-host allowlist. | Structured store, result. | Read, write, and the effective-grant computation. |
| **Credentials** (L1) | Reference-to-secret resolution and the allowed-host constraint on each reference. | The configured resolver. | Resolution that returns a value only into an exec environment, never to a handler. |
| **Clone store** (L1) | Materialisation, the safe-to-evict predicate, eviction, disk-pressure watermarks, remote cross-check. | Exec, declarations, locks, journal, audit. | Ensure, evict-if-safe, describe. |
| **Journal** (L1) | Intent records and the boot recovery classification. | Structured store, clock. | Begin, step, settle, recover. |
| **Audit** (L1) | The append-only scrubbed log. | Exec's scrubber, clock. | Append. Never throws. |
| **Git operations** (L2) | Every repository-generic git behaviour: status, log, branches, health, diff, stage, commit, restore-paths, push, and the seven protected-base invariants. | L1. | Domain functions returning `ToolResult`. |
| **Composites** (L2) | Handwritten, fixed-sequence transactional operations — branch preparation, reconcile-after-merge. Each declares its journal steps and its resume behaviour. | Git operations, host adapter, journal. | Domain functions. |
| **Host adapter** (L2) | Pull requests, checks, merges, deploy monitoring; the per-credential request budget and backoff. One implementation, GitHub via `gh`. | Exec, credentials. | A host-shaped interface a second implementation could satisfy. |
| **Scheduler** (L2) | Due-job selection, missed-tick policy, grant re-intersection. | Declarations, journal, notifier — and the dispatch pipeline **by injection**, never by import. | A tick engine. |
| **Notifier** (L2) | Terminal-state notification, bounded retry, outbox. | Structured store. | Notify. Never blocks a caller. |
| **Dispatch pipeline** (L4) | The one canonical call path: identify, authenticate, enforce scopes, enforce capabilities, validate input, apply limits and cancellation, invoke adapter, validate output, scrub, audit, envelope. | L3, L2, L1, the registry artifact. | Dispatch. |
| **Authorization** (L4) | Resource-server token verification, the embedded provider, durable clients and grants. | Structured store. | MCP session establishment. |
| **Operator identity** (L4) | Password, enforced TOTP, recovery codes, break-glass, OIDC relying party, subject allowlist. | Structured store. | Operator session establishment. |
| **Surfaces** (L5) | Transport framing, routing, session lifecycle, static console assets. | L4 only. | Nothing inward. |

### The acyclicity argument

Two edges would obviously become cycles, and are cut deliberately:

- **Audit and journal need to record who acted**, and identity lives at L4. They do not import
  it. `actorRef` is a plain value carried in the call context, constructed at L4 and passed
  down. L1 never knows an authorization module exists.
- **The scheduler needs to dispatch**, and dispatch lives at L4 above it. It does not import the
  pipeline; the pipeline is injected at composition time. The scheduler is a caller like any
  other and gets no privileged path.

One further boundary is a product decision rather than hygiene: **nothing in L0, L3 or L4 may
import anything from L2.** The runtime is generic; the git domain is a consumer of it. That is
the seam `MCP-NEXT.md` Phase 8 exists to eventually cut, and it stops being cuttable the first
time the dispatch pipeline knows what a branch is. It is enforced by a dependency-direction
check in CI, not by intent.

With those cuts every edge points strictly downward, so the graph is acyclic by construction.

### Where consumer extension attaches

A consumer builds an image `FROM` the base. Two seams:

- **Tools.** The consumer's contract is compiled during *its* build, with its declarations
  present. There is one registry and one fingerprint per image, so the immutability guarantee
  covers the extension rather than being punctured by it.
- **Views.** The base publishes its console as a versioned package — sources, view-registration
  types, build entry. The consumer's build consumes it and produces the bundle. The bundle's
  asset manifest is hashed into a **console fingerprint**, separate from the contract
  fingerprint, and both are verified at startup and reported by the version endpoint. A
  runtime-swapped bundle is fatal, the same shape as a registry mismatch.

A view declares the capabilities it needs. The console renders it for the selected repository
only when that repository's grant contains them. The blog consumer's authoring views therefore
appear for the blog declaration and are absent for every other one, using the same lattice as
the tools rather than a second mechanism.

---

## Control flow

### 1. Agent completes a change — triggered by an MCP `tools/call`

1. Client connects to `/mcp/{declarationId}`. The resource indicator is the repository.
2. Token verified: issuer, signature, expiry, audience against that exact resource URI, scopes.
   Failure is `401` with a resource-metadata challenge, not an envelope.
3. Session established. The grant is the actor profile intersected with scopes, the declaration
   grant, the deployment ceiling and the contract set. Frozen for the session.
4. `tools/list` returns exactly the registry entries whose required capabilities are a subset of
   the grant. A tool the session may not call is not merely refused — it is not there.
5. `tools/call` arrives. The pipeline re-checks capabilities (a stale catalogue or a by-name
   call must not reach a handler), validates input against the schema, and applies the declared
   timeout and result-size limits.
6. The clone store ensures materialisation, taking the **materialisation** lock for this
   declaration. If the clone is absent it clones — outside the global mutation lock, so every
   other repository keeps serving, which is what definition-of-done item 5 requires. The
   observed remote is cross-checked against `Declaration.cloneUrl`; a mismatch refuses rather
   than repointing an existing checkout.
7. Mutating tools acquire the **global mutation** lock, bounded. Reads and monitoring waits skip
   this step entirely.
8. The journal writes intent: pre-state captured under the lock, entry written, **then** the
   first side effect.
9. The domain function runs. Composites journal each sub-step. Credentials resolve at the moment
   of use and reach only a child process's environment, by name.
10. Journal marked `applied`, audit line appended, lock released, envelope returned, journal
    marked `settled`.
11. On a terminal state an unwatched caller cannot see — merge conflict, failed required check,
    wait timeout — the notifier fires.

**The scheduler tick is this path with a different actor.** It selects due jobs, re-intersects
the frozen grant, and calls the same pipeline. It has no privileged route and no second
implementation of any operation.

### 2. Operator drives the console — triggered by an HTTP request

1. Login: username, password and TOTP — enforced, not offered. Or OIDC against the configured
   issuer, with the returned subject matched against the allowlist that reduces a provider's
   many identities to the one operator.
2. Operator session established with no repository binding. Its grant spans every active
   declaration; per-repository narrowing still applies per call, because the effective set is
   computed against the declaration named in the request.
3. The landing view lists declarations with clone state, current branch, dirty flag and last
   operation. Selecting one sets the repository dimension for every subsequent view.
4. Each view calls a repository-scoped API route, which calls **the same dispatch pipeline and
   the same domain functions** as the MCP path. No surface reimplements a variant of an
   operation. The API is an explicit route table, never a call-any-tool-by-name proxy.
5. Declaration management is reachable only here. `declaration.manage` is withheld from every
   MCP session profile by deployment default, because a caller able to declare a repository
   could point an existing credential reference at a remote it controls and harvest the token
   from the push. The remote-host allowlist is the second, independent guard, so an operator
   slip cannot do it either.

### 3. Boot and recovery — triggered by process start

1. Open the lease file and take the exclusive advisory OS lock. While held, a second instance
   refuses to start; the kernel releases it on death including `SIGKILL`, so an unclean kill
   leaves no stale lock to reason about. The refusal names the holder from the lease contents.
2. Load the generated registry, verify its fingerprint, verify the console asset manifest. A
   mismatch is fatal — the service must never start with a smaller accidental tool set.
3. Verify the deployment ceiling names only capabilities in the contract set. Verify every
   registry operation has exactly one executor.
4. Open the structured store; back it up, then run forward-only migrations.
5. Re-derive every clone's state from disk. The stored value is a report, not a source of truth.
6. **Recovery pass, per declaration, before that declaration serves anything.** For each journal
   entry not `settled`, re-derive actual state and compare against `preState` and the
   operation's expected post-state:
   - pre-state matches and no step is `applied` — nothing happened; mark `settled`;
   - expected post-state matches — it completed and only the settle was lost; mark `settled`;
   - neither — the operation either declares a resume step or it does not. If it does, run it
     and re-classify. If it does not, mark the entry `attention`, put the clone in
     `needs-attention`, block mutations against that declaration, report it in status, and
     notify.
7. Readiness passes. **Only then** do transports start.

Recovery never discards work to reach a clean state. "Recovers" here means the interruption is
deterministically classified and either resumed or safely parked — never rolled back by
throwing away a commit, because the standing refusal against discarding uncommitted or unpushed
work outranks tidiness.

**Per-session stdio processes own no state.** A stdio process is a thin transport that proxies
to the always-on instance over its HTTP surface, authenticating as an MCP client. It never opens
the volume, never takes a lock and holds no clone. That is how the two lifecycles the brief
requires stay consistent with each other: there is exactly one owner of storage, and the
short-lived process is not it.

---

## Failure modes

### External dependencies

| Dependency | What fails | Detected by | System does | Caller sees | State left behind |
|---|---|---|---|---|---|
| **Remote git host** | Unreachable, DNS, TLS | Non-zero exit from a bounded `git` invocation (clone capped at 300 s) | No retry inside the call | `upstream` | Initial clone: partial directory removed, clone `absent`. Fetch: refs unchanged, since git updates refs atomically. |
| | Auth rejected | Exit code plus scrubbed stderr | Marks the credential reference failing; never retries with a different one | `upstream`, naming the reference, never the secret | Unchanged |
| | Clone timeout | The 300 s cap | Removes the partial directory under the materialisation lock | `timeout` | `absent` |
| | Base diverged from local | Ancestry check in branch preparation | Reports; changes nothing | `precondition` naming both SHAs | Unchanged; every commit still reachable |
| **GitHub via `gh`** | Rate limit | Response headers and exit code | Trips the per-credential budget; monitoring waits back off with jitter | `precondition` with a retry-after — a rate limit is repository-state-shaped, not a service fault | Unchanged |
| | 5xx or transport error | Exit code | Up to three retries with backoff, **read operations only** | `upstream` after exhaustion | Unchanged |
| | Merge conflict | PR state | **Terminal.** No rebase tool exists and by design never will | `precondition` naming the branch and both heads | Branch and commits intact; notifier fires |
| | Required check failed | Check status | Terminal for the operation | `precondition` | PR open, nothing merged; notifier fires |
| **Filesystem / volume** | Disk full | Watermark check before clone and after each mutation | Attempts eviction of safe clones only; if none are safe, refuses the operation that needed the space | `precondition` naming the declarations blocking eviction | Nothing deleted. **The service never deletes to make room.** |
| | Corrupt clone | `rev-parse --git-dir` fails at materialisation | Refuses; does not clone over it | `precondition` telling the operator to inspect or move it aside | Directory untouched |
| | Permission denied | Syscall error | Fatal at boot; `infrastructure` at runtime | `infrastructure` | Unchanged |
| **Structured store** | Locked or busy | SQLite busy | Bounded retry with backoff | `infrastructure` after exhaustion | Transaction rolled back |
| | Corrupt | Integrity check at boot | **Refuses to start**, naming the pre-migration backup | No service | Volume untouched; the audit log is still readable, which is why it does not live in this store |
| | Migration fails | Non-zero from the migration step | Refuses to start; the backup was taken first | No service | The backup is the rollback target for item 18 |
| **Identity provider** | Unreachable, key rotation, clock skew | Discovery or JWKS fetch failure; signature or validity-window failure | Federated login fails; **local password plus TOTP still works** | `401` with a reason | No session |
| **Deploy target** (published-URL verification) | Deploy unfinished, wrong commit serving | Explicit poll for the exact merge commit SHA | Polls to the 1800 s cap | `precondition` classified as `stale-runtime`, `mixed-runtime`, `verification-credential` or `unexpected-profile-or-catalog` | Unchanged. **No code path returns a URL in a success position without a confirmed successful deploy for that exact commit.** |
| **Notifier endpoint** | Unreachable, non-2xx | HTTP status | Outbox retries with backoff, bounded, then drops and logs | Nothing — it never blocks the operation it describes | Outbox row marked failed |

### Boundaries

| Boundary | What fails | System does | Caller sees | State left behind |
|---|---|---|---|---|
| **Input validation** | Schema mismatch | Rejects before any handler runs | `validation` with findings | None |
| **Scope / capability at dispatch** | Session lacks a capability | Rejects before any handler runs; audits it | `authorization` | None |
| **Global mutation lock** | Held past the acquire timeout | Gives up waiting | `conflict`, naming the holding operation and its repository | None — the queued call never started |
| | Queue depth exceeded | Immediate refusal | `conflict` | None |
| **Materialisation lock** | Another caller is cloning the same declaration | Waits, bounded by the clone timeout | `conflict`, or the successful clone | The clone completes exactly once |
| **Path allowlist** | `-A`, `--all`, `.`, a path containing `..` or `;`, or a path outside `writablePathPrefixes` | Rejects outright | `validation` | None |
| **Journal** | Cannot write the intent record | **Aborts the operation before acting.** An unrecoverable mutation is worse than a refused one | `infrastructure` | None |
| **Audit** | Cannot append | Proceeds. Best-effort by design — a logging failure must never fail the call it describes | Nothing | Call completed, line missing |
| | Cannot append **for `git.raw`** | **Aborts the hatch call.** Item 8 claims exactly one property for the hatch, and an unlogged use forfeits it | `infrastructure` | None |
| **Output validation** | Handler returns something the schema does not admit | Rejects before any structured content reaches the client | `infrastructure` | Side effects already happened; the journal records them |
| **Instance lease** | Second instance, live holder | Refuses to start, naming the holder | No service | Untouched |
| | Lease file present, OS lock free | Takes over, audits the takeover, runs recovery | No service until ready | Recovered per the boot path |

### Partial failure and retry

Retries happen **only** on operations that are safe to repeat: host reads, store-busy, and
notifier delivery. Nothing that mutates a repository or a pull request is retried automatically,
because a partially applied git sequence retried blind is how work gets stranded — which is the
incident that produced the protected-base invariants in the first place. A mutating operation
that fails leaves a journal entry that is either resumable or parked for the operator; it is
never silently re-run.

Output-validation failure is the one place where the caller sees an error after side effects
landed. The journal records what happened, so the state is inspectable rather than lost.

### The escape hatch's residual risk

`git.raw` runs a fixed executable with an argument vector, never a string, never a shell, with
the working directory pinned to the declaration's clone. That is what keeps it a typed domain
handler rather than the generic shell adapter the non-goals forbid. It is not sufficient on its
own: `git` can be turned into a command executor through configuration and helper options, so
the handler additionally runs with system and global configuration disabled and a neutral home
directory, and rejects argument forms that select an executable or inject configuration.

**This narrows the risk; it does not eliminate it.** A sufficiently determined caller with
`git.raw` can still reach command execution inside the container through git's own extension
points. The brief considered and declined a hard floor no surface can cross, so this is recorded
as known and retained rather than reopened. The mitigations that follow from it are the ones
already in this design: `git.raw` is withheld by default at every layer, is unregistered wherever
withheld, and refuses to run at all if its audit line cannot be written.

---

## Concurrency and ordering

Two locks, and a fixed acquisition order.

| Lock | Scope | Covers | Held for |
|---|---|---|---|
| **Global mutation mutex** | Process-wide, across every declaration | Working-tree, index, `HEAD` and ref mutations; fetch; pull-request and merge mutations | Milliseconds to seconds |
| **Per-declaration materialisation mutex** | One declaration | Initial clone, eviction | Up to the 300 s clone cap |

**Acquisition order is always materialisation before mutation, never the reverse.** That is the
whole deadlock argument: with a fixed order over two lock classes, no cycle can form.

What runs simultaneously:

- **Reads and monitoring waits.** Lock-free. A bounded wait capped at 1800 s must not hold every
  repository for half an hour.
- **Initial clone of one declaration and mutation of another.** Required by definition-of-done
  item 5. Safe because a materialising declaration is not yet servable — no session can name it
  until its clone reaches `ready`.
- **Any number of MCP sessions, the console, the scheduler tick and the watcher.** They contend
  for the same mutation lock and are ordered FIFO by arrival. There is no priority and no
  fairness beyond arrival order.

What must not, and what enforces it:

- **Two mutations against any repository, ever.** The global mutex. Global rather than
  per-repository so a crash leaves exactly one half-done operation, not several.
- **Two clones of the same declaration.** The materialisation mutex.
- **A fetch concurrent with a mutation on the same repository.** Fetch takes the global mutex;
  only the initial clone is exempt, and only because nothing can observe the repository yet.
- **Two instances against one storage volume.** The exclusive advisory OS lock on the lease file.
- **A stdio process racing the always-on container.** Structurally impossible: stdio processes
  own no storage and proxy over HTTP.

Honest limits, stated rather than left to be discovered:

- **A lock-free read can observe a repository mid-mutation.** Every read result carries the
  `operationId` of the last settled mutation and a `mutationInFlight` flag, so a caller can tell
  whether what it read was stable. Reads are not made atomic, because taking the lock to read
  reintroduces exactly the blocking the read exemption exists to avoid.
- **The advisory OS lock protects one host.** A volume bind-mounted from two hosts is not
  protected. That is the "no distributed or multi-node concurrency" non-goal, restated where it
  bites.
- **Node is single-threaded**, so the mutation mutex only has to serialise await points, not real
  parallel execution. A promise-chain queue is sufficient, as it is in the prior art.

---

## Alternatives considered

**MCP sessions bind to one repository.** Rejected: *a repository-agnostic session with the
repository as a parameter only* — simpler, and it matches the HTTP surface exactly. Rejected
because one `tools/list` would then have to serve every declaration in the session, so
per-repository narrowing could only happen at dispatch. That is strictly weaker than the prior
art's rule that capability filtering affects discovery and dispatch, and it forfeits the property
that carries the actual threat model: a tool absent from the list a client sees cannot be talked
into existing by text embedded in a PR comment. Also rejected: *making the repository field
optional and defaulted from the session binding* — better ergonomics, but the input schema would
then mean different things on different surfaces. The field is required everywhere, and a scoped
session passing the wrong repository gets `authorization`.

**One composed image, one deployment.** Rejected: *a base deployment plus one container per
derived consumer, each with its own console* — cleaner separation of consumer code, and the
reading the layered-image model suggests first. Rejected because it produces two consoles, two
logins and two URLs, which is precisely the "no common place" problem the project exists to
solve, and because it fragments "one instance, many repositories" into one instance per consumer.
The composed image keeps one login, one console, one storage volume and one lock. The cost is
that the blog consumer's authoring tools and views are present in the image for every repository
— paid for by the capability lattice, which withholds them from every declaration whose grant
lacks the corresponding content capabilities.

**Deploy-time locking narrows a build-time maximum.** Rejected: *the contract is compiled per
deployment* — would make the lock exactly what the brief describes, and breaks the fingerprint,
since a contract baked at build cannot enumerate repositories declared later. Also rejected:
*deploy-time configuration widens what the image ships* — the obvious way to make one image serve
differently-privileged deployments, and it destroys default-deny, because the running tool set
would no longer be a subset of the reviewed one. Narrowing-only is what makes both timings true
at once.

**The escape hatch is a capability, not a bypass.** Rejected: *the hatch sits outside the lattice*
— the literal reading of "full git is reachable", and it would give the deployment lock an
exception large enough to contain every operation the safety gate blocks. Also rejected: *a hard
floor the hatch cannot cross* — the most falsifiable guarantee, already considered and declined
in the brief, recorded here as known and retained rather than re-litigated. As a capability,
`git.raw` can be withheld at deploy, per declaration or per session, and where withheld the tool
is **not registered**, preserving registration-as-boundary for every session that lacks it.

**Clones are an evictable cache with a safety interlock.** Rejected: *retained until the operator
intervenes* — never surprises anyone, and it makes unbounded repository count a disk outage
waiting to happen, arriving as a write error mid-operation. Rejected: *a per-declaration size
cap* — bounds total size predictably, and evicts by an arbitrary rule rather than by what is safe
to lose. The interlock is the part that matters: a clone is evictable only when its tree is clean,
no branch is ahead of its upstream, no commits are unreachable from `origin/<base>`, no stash
exists and no journal entry is open. When nothing is safe to evict, the operation that needed
space is refused and names what is blocking it.

**Restart recovery is an intent journal.** Rejected: *infer state at boot from the repository
alone* — no new persistence, and it cannot distinguish "never started" from "half applied" for
any operation whose first step is idempotent, which is most of them. Rejected: *detect and report
only* — the prior art's behaviour, and what definition-of-done item 14 explicitly rules out. The
journal costs a write before every mutation and an abort if that write fails; accepted, because
an unrecoverable mutation is worse than a refused one.

**stdio processes proxy to the always-on instance.** Rejected: *each stdio process opens the
volume* — matches the prior art, and it is the second-instance case wearing a different hat;
either it defeats the instance lock or the lock defeats it. Rejected: *stdio gets its own volume*
— no contention, and two divergent sets of clones and grants for the same repositories is a
consistency problem with no upside.

**Bounded queue with a `conflict` timeout, rather than reject-on-contention.** Rejected: *reject
the second caller immediately* — a live option in the decision log, and better for agents, which
handle an explicit error more gracefully than a long block. Rejected because the console issues
short bursts of quick mutations where an immediate refusal is pure friction. The bounded queue is
both: short waits succeed, and a long wait becomes the explicit `conflict` an agent wanted.

**`gh` behind a host-adapter interface.** Rejected: *call GitHub's REST and GraphQL APIs
directly* — one less binary in the image, and the honest shape for a GitHub-only feature set.
Rejected for now because parity against captured fixtures is a definition-of-done item, and
swapping the host client during the parity migration adds risk with no stated benefit; the
interface keeps the swap additive. Rejected: *a host abstraction proven against a second
implementation* — the only thing that would make "no assumptions about host" fully true, and
materially the largest option, with no second host in evidence.

**Console extension via a versioned package consumed at the derived build.** Rejected: *the
prebuilt bundle discovers views at runtime* — no consumer build step, and it puts the UI outside
anything fingerprinted, which defeats the reason image-build extension was chosen. Rejected: *the
consumer forks the base console* — nothing to maintain across the seam, and every base
improvement becomes a merge.

**Declaration management is operator-only.** Rejected: *declaration tools exposed over MCP* — the
symmetric reading of "one canonical service per operation", and it hands an injected agent a route
to attach an existing credential reference to a remote it controls and harvest the token from the
push. The remote-host allowlist is the second, independent guard, so the property does not rest on
the capability alone.

**SQLite for structured state, JSONL for audit.** Rejected: *JSON files for everything* — no new
dependency, matching the prior art's `schedule.json`, and it cannot give the journal and the grant
store the atomic multi-row updates recovery classification needs. Rejected: *SQLite for audit too*
— one store to back up, and it makes the audit trail share a failure mode with the thing it audits.

---

## Open questions

1. **How does a credential reference resolve without a restart?** Definition-of-done item 5
   requires onboarding a repository by declaration alone, with no restart. If credentials come
   from the container environment, a new declaration needs a new secret needs a restart, and item
   5 fails. This design fixes the *shape* — a named reference and a pluggable resolver — but not
   which resolver ships as the default. Recommended: **a mounted secrets directory read at point
   of use**, so no secret enters the structured store and no restart is needed. Alternatives:
   encrypt-at-rest in the store with a key from the environment; an external secret store, which
   the decision log already holds as a live option. This blocks `/contract`, because the
   declaration format has to name the reference syntax the resolver accepts.

2. **Should `git.raw` be reachable from MCP sessions in the default deployment?** This design
   makes it withholdable at every layer, and the brief has already declined making it structurally
   console-only. What neither says is what the *default* should be. Recommended: **withheld from
   every MCP session profile, granted to the operator console only**, changeable per declaration.
   This is a configuration default either way, not a design change.

3. **Is there an endpoint the notifier should target?** The brief puts outbound notification in
   scope with the mechanism undecided, because an unwatched run stopping at a terminal state must
   be able to reach you. This design assumes an HTTP webhook as the first and only shipped
   transport. If you already run a chat webhook or a mail relay, that changes which one is worth
   building first, and whether one is enough.

4. **Who backs up the volume?** Item 18 requires a tested rollback and item 20 requires backup and
   recovery documentation. This design takes a pre-migration copy of the structured store, which
   covers image rollback. It does not cover volume loss. If the host snapshots the volume the
   service needs nothing more; if it does not, the service needs an online-backup operation, and
   that is scope neither the brief nor this document has allocated.

5. **What is the real disk budget, and is eviction expected to fire?** "Unbounded and assumed to
   grow" sets the design constraint, and the eviction machinery follows from it. The watermark
   values, and whether eviction is a routine event or a last resort that should notify you, depend
   on a number only you have. If the real answer is twenty repositories on a volume with room for
   two hundred, the interlock still earns its place but the thresholds and the notification
   posture are different.

6. **Do the blog authoring views gain a repository dimension, or stay pinned to one declaration?**
   `ComposeView` is 38 KB of repository-implicit code. Under this design a view renders for the
   selected repository when the grant permits, which implies parameterising it. Pinning it to the
   blog declaration instead is less work and less general, and is defensible because blog
   authoring genuinely applies to exactly one repository. The answer changes the shape of the
   view-registration seam — whether a registered view receives the selected repository or declares
   the one it belongs to — so it is a contract question rather than a preference.
