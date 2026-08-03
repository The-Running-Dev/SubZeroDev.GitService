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

**Retention, because everything here appends and the lifespan is years.** Four things grow
without a natural bound and each gets a stated policy, since the disk-pressure machinery only
knows how to evict clones and would otherwise name innocent declarations as the blockers for
growth that is not theirs.

| What grows | Policy |
|---|---|
| Audit log (JSONL) | Rotated by size, retained for a configured window, oldest segment removed only after the window passes. Never truncated to make room — a trail that discards itself under pressure is not one. |
| Operation journal | `settled` entries older than the window are deleted; `attention` entries are never deleted, because they are the ones an operator still has to resolve. |
| Notification outbox | Delivered rows deleted after the window; failed rows retained until the operator clears them from the health view. |
| Pre-migration store backups | The most recent *n* retained, older ones removed after a successful boot on the new schema — the rollback target item 18 needs is the latest one, not all of them. |

Retention runs on the same maintenance pass as eviction, and the disk-full path reports which of
the five — clones, audit, journal, outbox, backups — is actually consuming the volume.

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

**Orphaning is detachment, not removal, so every subsystem keyed by `declarationId` needs a
stated answer.** Without one, each invents its own and the ghost declaration keeps being acted
on in four different ways.

| Dependent | On orphaning |
|---|---|
| Clone | Left on disk, untouched, and becomes evictable under the ordinary safety interlock. |
| Pending `ScheduledJob`s | Moved to `cancelled` with a reason naming the orphaning. Not fired, and not silently dropped. |
| `Grant`s and `Token`s whose resource is `/mcp/{id}` | Revoked, and the declaration's `grantEpoch` bumped, so live sessions bound to it close on their next call rather than continuing against a repository the operator has retired. |
| Unsettled journal entries | Retained and reported. They are the record of work that may still be in the clone. |

**Re-declaring the same `id` does not inherit any of it.** A new declaration gets a fresh
`grantEpoch` and no authorization records, and unsettled journal entries from the previous era
are not recovery candidates for it — recovery would otherwise classify an interruption belonging
to a declaration this one only shares a name with.

#### `RepositoryConfig` — repository-supplied facts

**Derived, in-memory, cached, never persisted as truth.** Read from a file in the target
repository's working tree, generalising `.config/blog.json`.

| Field | Type | Source |
|---|---|---|
| `baseBranch` | string | repository, default `main` |
| `requiredChecks` | string[] | repository |
| `deployWorkflow` | string | repository |
| `branchPrefixes` | string[] | repository |

**Read from `origin/<base>`, never from the working tree.** The tree of a long-lived clone is
wherever the last operation parked it, including a branch the calling agent created moments ago,
so a working-tree read would let a caller author the configuration that governs its own call.
`requiredChecks` grants no capability, but it defines what "green" means to the unwatched
end-to-end flow of definition-of-done item 13 — a caller that commits `requiredChecks: []` on its
own branch and is then told its change passed has defeated the gate without ever exceeding its
grant. Reading from the base ref is the prior art's rule for `blog_log`, adopted here for the
same reason. **The config path is excluded from `writablePathPrefixes` by default**, so changing
it is an operator act on the base branch rather than a side effect of an agent's own commit.

The cache is invalidated on every fetch of the declaration and on any operation that moves
`origin/<base>`, because an honest upstream change to `requiredChecks` must not sit stale
behind a cached copy indefinitely.

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
| `state` | `absent` \| `materialising` \| `ready` \| `dirty` \| `recovery-pending` \| `needs-attention` \| `evicted` | derived from disk at boot, then maintained. `recovery-pending` means unsettled journal entries exist and lazy recovery has not reached this declaration yet; it serves reads and refuses mutations |
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
| `auth.manage` | list and revoke OAuth clients, grants and live sessions |
| `attention.resolve` | inspect a parked journal entry, resolve it, return a clone to `ready` |
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
| `grant` | set of capability names | Layer 4, computed at session establishment and frozen for the session's lifetime — frozen against *widening*. See the grant epoch for how a narrowing still reaches a live session. |
| `frozenAtEpoch` | number | The declaration's `grantEpoch` when the grant was computed. Compared on every dispatch. |

An MCP session binds to exactly one repository at `initialize`, because the MCP resource
indicator *is* the repository: the canonical URI is `/mcp/{declarationId}`. That is what lets
capability filtering affect **discovery as well as dispatch**, which the prior art requires and
which a repository-agnostic session cannot deliver. An operator session spans every
declaration, because the console has to aggregate across them.

Freezing the grant at session establishment inherits the prior art's rule that a token tier is
fixed at `initialize` for the session's lifetime.

#### `OAuthClient`, `Grant`, `Token` — the authorization records

Durable grants are definition-of-done item 12's headline departure from the prior art, and item
20 requires revocation to be documented — which requires it to exist. All three are persisted in
the structured store.

| Entity | Identity | Notes |
|---|---|---|
| `OAuthClient` | `clientId` | Dynamically registered. Redirect URIs, registration time, `revokedAt`. |
| `Grant` | `grantId` | `clientId`, subject, `resource` (the `/mcp/{declarationId}` URI), granted scopes, `createdAt`, `lastUsedAt`, `revokedAt`. Durable, so a client reconnects after a restart without re-authorising. |
| `Token` | `jti` | `grantId`, `kind` (`access` \| `refresh`), `expiresAt`, `revokedAt`. Access tokens are short-lived; refresh tokens are durable, which is the half of item 12 that survives a restart. |

Three rules govern them:

- **Revocation is a timestamp, never a delete.** A store that forgets what was revoked cannot
  answer the question the revocation was raised to answer.
- **Cascade is evaluated at check time, not written as a batch.** A revoked client's grants and a
  revoked grant's tokens are dead because the check walks upward, so there is no partially
  applied cascade to recover from.
- **A revoked grant's resource is released, but its history is not.** Orphaning a declaration
  revokes every grant whose resource names it — see the orphaning cascade.

**The grant epoch — how a frozen session still narrows.** Freezing at establishment is what makes
"nothing at runtime widens" true, and on its own it also means nothing narrows: an operator
watching an agent misbehave could remove a capability and watch the live session keep using it.
Both properties are wanted, so the freeze is kept and a version counter is added. Every
declaration carries a `grantEpoch`, incremented on any change to `capabilityGrant`, on orphaning,
and on any revocation naming that resource. A session records the epoch it froze at; dispatch
compares before invoking a handler. If the epoch has moved the session recomputes its grant, and
because that computation is an intersection of four layers it can only ever narrow — a widened
declaration grant does not reach a live session, while a narrowed one takes effect on the very
next call. A call the recomputed grant no longer admits returns `authorization`. If the grant or
its client was revoked outright, the session is closed and the transport answers `401` with the
resource-metadata challenge, because the caller now needs to re-authorise rather than retry.

Revocation is reachable only from the console, under `auth.manage`, for the same structural
reason declaration management is: an MCP session is bound to one repository and revoking the
authority of *other* sessions is not an operation on that repository.

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
| `input` | JSON | validated against that tool's input schema at creation **and again at fire time**, because the scheduler dispatches through the same pipeline as everyone else and the registry can change under a pending job. Boot re-validates pending jobs too — see the boot path |
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

One scrubbed JSON line per mutating call: timestamp, `operationId`, `declarationId`, `tool`,
`actorRef`, result kind and changed paths. Best-effort append that never fails the call it
describes, per the prior art. `actorRef` is what makes definition-of-done item 8's "attributable"
true rather than asserted.

**`git.raw` writes two lines, not one, because one line cannot do the job.** Result kind and
changed paths are post-execution facts, so a single line containing them cannot also be written
before execution — and "refuses to run if its line cannot be written" is only meaningful for a
line written first. The hatch therefore appends an **intent** line carrying the argument vector
before the child process starts, and an **outcome** line carrying the result once it finishes,
correlated by `operationId`. The intent append is the one that can abort the call. A failed
outcome append leaves the use recorded and its result unknown, which is a gap in the trail rather
than an unlogged execution, and the state left behind is whatever the command did — not the
"none" a pre-execution refusal leaves.

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
| **Locks** (L1) | The global mutation mutex, the per-declaration materialisation mutex, and the per-declaration active-operation count. | Nothing. | Two acquire functions with bounded waits, and a non-blocking pin. |
| **Declarations** (L1) | The declaration table, the lattice intersection, the remote-host allowlist. | Structured store, result. | Read, write, and the effective-grant computation. |
| **Credentials** (L1) | Reference-to-secret resolution and the allowed-host constraint on each reference. | The configured resolver. | Resolution that returns a value only into an exec environment, never to a handler. |
| **Clone store** (L1) | Materialisation, the safe-to-evict predicate, eviction, disk-pressure watermarks, remote cross-check, and the maintenance pass that applies eviction and retention outside any mutation-locked region. | Exec, declarations, locks, journal, audit. | Ensure, evict-if-safe, describe, request-maintenance. |
| **Journal** (L1) | Intent records and the boot recovery classification. | Structured store, clock. | Begin, step, settle, recover. |
| **Audit** (L1) | The append-only scrubbed log. | Exec's scrubber, clock. | Append. Never throws. |
| **Git operations** (L2) | Every repository-generic git behaviour: status, log, branches, health, diff, stage, commit, restore-paths, push, and the seven protected-base invariants. | L1. | Domain functions returning `ToolResult`. |
| **Composites** (L2) | Handwritten, fixed-sequence transactional operations — branch preparation, reconcile-after-merge. Each declares its journal steps and its resume behaviour. | Git operations, host adapter, journal. | Domain functions. |
| **Host adapter** (L2) | Pull requests, checks, merges, deploy monitoring; the per-credential request budget and backoff. One implementation, GitHub via `gh`. | Exec, credentials. | A host-shaped interface a second implementation could satisfy. |
| **Scheduler** (L2) | Due-job selection, missed-tick policy, grant re-intersection. | Declarations, journal, notifier — and the dispatch pipeline **by injection**, never by import. | A tick engine. |
| **Notifier** (L2) | Terminal-state notification, bounded retry, outbox. | Structured store. | Notify. Never blocks a caller. |
| **Module adapter** (L3) | Invoking a registry entry whose execution target is in-process. Holds a handler catalogue keyed by target name, **populated by registration at composition time, never by importing a handler.** | L1, contract types. | Register, and an invoke the pipeline calls. |
| **Http adapter** (L3) | Invoking a registry entry whose execution target is a declared HTTP endpoint: request shaping, the declared timeout, response mapping into the envelope. | L1, contract types. | Invoke. |
| **Dispatch pipeline** (L4) | The one canonical call path: identify, authenticate, enforce scopes, enforce capabilities, validate input, apply limits and cancellation, invoke adapter, validate output, scrub, audit, envelope. | L3, L1, the registry artifact. **Not L2** — see the acyclicity argument. | Dispatch. |
| **Authorization** (L4) | Resource-server token verification, the embedded provider, durable clients and grants, revocation and the grant-epoch check. | Structured store. | MCP session establishment, and revocation the console calls. |
| **Operator identity** (L4) | Password, enforced TOTP, recovery codes, break-glass, OIDC relying party, subject allowlist. | Structured store. | Operator session establishment. |
| **Surfaces** (L5) | Transport framing, routing, session lifecycle, cookie attributes, CSRF defence, static console assets. | L4 only. | Nothing inward. |

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

**The composition root is what makes that rule satisfiable.** The dispatch pipeline has to end up
calling a git operation without importing one, so a single module — the program entry point, not
a layer — imports both the domain and the runtime, registers every L2 handler into the module
adapter's catalogue by target name, injects the pipeline into the scheduler, and starts the
surfaces. It is the only file exempt from the dependency-direction check, and the exemption is by
path, so widening it is a visible diff rather than a habit. Everything above L2 therefore reaches
the domain through a name resolved at startup instead of a symbol resolved at compile time, which
is the same mechanism already chosen for the scheduler's identical problem.

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
5. `tools/call` arrives. The pipeline compares the declaration's `grantEpoch` against the one the
   session froze at and recomputes the grant if it moved — a recomputation that can only narrow.
   It then re-checks capabilities (a stale catalogue or a by-name call must not reach a handler),
   validates input against the schema, and applies the declared timeout and result-size limits.
6. The clone store ensures materialisation, taking the **materialisation** lock for this
   declaration and **holding it for the rest of the operation**. If the clone is absent it clones
   — outside the global mutation lock, so every other repository keeps serving, which is what
   definition-of-done item 5 requires. The observed remote is cross-checked against
   `Declaration.cloneUrl`; a mismatch refuses rather than repointing an existing checkout. The
   declaration's active-operation count is incremented here, which is what stops an eviction pass
   removing this clone while the operation runs.
7. Mutating tools acquire the **global mutation** lock, bounded. Reads and monitoring waits skip
   this step entirely.
8. The journal writes intent: pre-state captured under the lock, entry written, **then** the
   first side effect.
9. The domain function runs. Composites journal each sub-step. Credentials resolve at the moment
   of use and reach only a child process's environment, by name.
10. Journal marked `applied`, audit line appended, **locks released in reverse acquisition order**
    — mutation, then materialisation — the active-operation count decremented, envelope returned,
    journal marked `settled`. A disk-pressure watermark reading taken here only *requests* a
    maintenance pass; eviction never runs on this path, because it would acquire a materialisation
    lock after a mutation lock.
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
5. Declaration management is reachable only here, and **structurally so rather than by
   configuration**: an MCP session binds to one declaration at `initialize`, so a tool that
   creates a declaration has nothing to bind to, and amending or orphaning a *different*
   declaration is not an operation on the bound one. `declaration.manage`, `auth.manage` and
   `attention.resolve` are therefore absent from every MCP session profile as a consequence of
   the session model, not as a default a deployment could flip. The reason it is worth stating
   twice: a caller able to declare a repository could point an existing credential reference at a
   remote it controls and harvest the token from the push. The remote-host allowlist is the
   second, independent guard, so an operator slip cannot do it either.
6. **Three operator-only views exist because three states have no other exit.** A grants view
   lists clients, grants and live sessions with last use, and revokes any of them under
   `auth.manage`. A parked-operations view shows every journal entry in `attention` with its
   `preState`, the observed current state and the diff between them, and offers exactly two
   resolutions under `attention.resolve` — mark the entry settled and return the clone to
   `ready`, or keep it parked. Neither resolution touches the repository: the operator fixes the
   tree with ordinary git operations first, then records that it is fixed, because a console
   button that rewrites a working tree is the arbitrary-mutation route the non-goals forbid. A
   health view surfaces failed notification-outbox rows and failing credential references, both
   of which are otherwise only visible in logs.

### 3. Boot and recovery — triggered by process start

1. Open the lease file and take the exclusive advisory OS lock, then **self-test it** — a second
   acquire from this process must fail. A filesystem that grants both is not one this service can
   run on safely, and refusing here is the only way definition-of-done item 9 fails loudly rather
   than silently. While the lease is held a second instance refuses to start; the kernel releases
   it on death including `SIGKILL`, so an unclean kill leaves no stale lock to reason about. The
   refusal names the holder from the lease contents.
2. Load the generated registry, verify its fingerprint, verify the console asset manifest. A
   mismatch is fatal — the service must never start with a smaller accidental tool set.
3. Verify the deployment ceiling names only capabilities in the contract set. Verify every
   registry operation has exactly one executor.
4. Open the structured store; back it up, then run forward-only migrations.
5. **Re-validate every pending scheduled job against the registry just loaded.** An image upgrade
   can rename a tool, remove one, or change its input schema while jobs referencing the old shape
   sit pending; without this sweep the failure surfaces weeks later at fire time, with its cause
   an upgrade nobody is still thinking about. A job whose tool no longer exists, or whose stored
   input no longer validates, becomes `needs-attention` with the reason naming the upgrade, and
   the operator sees it next to the fingerprint checks that caused it rather than at 03:00.
6. Re-derive every clone's state from disk. The stored value is a report, not a source of truth.
7. **Readiness passes and transports start**, before any recovery work runs. Recovery is
   per-declaration and lazy: a declaration with unsettled journal entries is marked
   `recovery-pending` and recovers on first use or on a background sweep, whichever comes first,
   and refuses mutations until it has. Eager recovery across every declaration would make restart
   cost scale with estate size — minutes of total unavailability at a few hundred clones, to
   recover state concerning at most one of them — which would make operators avoid the restart
   that definition-of-done item 14 exists to make safe.
8. **The recovery pass itself, per declaration, before that declaration serves a mutation.** For
   each journal entry not `settled`, re-derive actual state and compare against `preState` and
   the operation's expected post-state:
   - pre-state matches and no step is `applied` — nothing happened; mark `settled`;
   - expected post-state matches — it completed and only the settle was lost; mark `settled`,
     **and fire the notifier if the operation reached a terminal state the caller never saw.**
     The caller's connection died with the process; the notification is the only thing that can
     still reach them, and suppressing it here recreates "unwatched means unnoticed" inside the
     recovery path;
   - neither — the operation either declares a resume step or it does not. If it does, run it
     and re-classify. If it does not, mark the entry `attention`, put the clone in
     `needs-attention`, block mutations against that declaration, report it in status, and
     notify. The operator's route back out is the parked-operations view under
     `attention.resolve`; without it the only exit is hand-editing the store.

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

## Operator identity and the console session

One operator, no second account to let them back in, TOTP enforced rather than offered, on a
publicly reachable origin. That combination makes two things load-bearing that a multi-user
service would treat as routine.

### Lockout recovery

Definition-of-done item 10 requires a working path, and there are two, deliberately independent
of each other and of the identity provider.

- **Recovery codes.** Ten single-use codes generated at first enrolment, displayed exactly once,
  stored only as hashes. Using one authenticates, burns the code, writes an audit line, and
  forces TOTP re-enrolment. They work while the identity provider is down, because they are
  local.
- **Break-glass.** A short-lived single-use token an operator with host access writes into the
  volume, consumed at the next login and audited. This is the path for a lost TOTP device *and*
  lost recovery codes, and it is the reason volume access is the ultimate authority rather than
  re-provisioning the instance.

The case worth naming, because the failure-mode table's answer to a broken identity provider is
"local password plus TOTP still works": that answer is no help when TOTP is precisely what was
lost. Recovery codes cover an unavailable provider, break-glass covers a lost second factor, and
neither depends on the other. No path requires the identity provider to restore local access, and
no path requires a working TOTP device to burn a recovery code.

### Console session

The console is an ambient-authority browser session driving routes that mutate repositories, so
its lifecycle is part of the security design rather than a framework default.

- **Cookie:** `HttpOnly`, `Secure`, `SameSite=Lax`, host-scoped, no subdomain sharing.
- **CSRF:** an `Origin` check plus a double-submit token on every mutating route. The API is an
  explicit route table over repository mutations; without this, a cross-site request from any page
  the operator happens to have open reaches those routes with the operator's own session.
- **Lifetime:** an idle timeout and a shorter absolute lifetime, both configurable, plus an
  explicit logout that invalidates server-side rather than only clearing the cookie.
- **Visibility:** operator sessions appear in the same grants view as MCP sessions and are
  revocable there, so "revoke everything and re-authenticate" is one screen during an incident.

---

## Failure modes

### External dependencies

| Dependency | What fails | Detected by | System does | Caller sees | State left behind |
|---|---|---|---|---|---|
| **Remote git host** | Unreachable, DNS, TLS | Non-zero exit from a bounded `git` invocation (clone capped at 300 s) | No retry inside the call | `upstream` | Initial clone: partial directory removed, clone `absent`. Fetch: refs unchanged, since git updates refs atomically. |
| | Auth rejected | Exit code plus scrubbed stderr | Marks the credential reference failing; never retries with a different one. The mark is per reference, so every declaration sharing it fails fast rather than each discovering it in turn. It clears when the resolver observes a changed secret, and the operator can clear it by hand from the health view — a rotated token must not need a restart to be noticed, or the no-restart onboarding property dies quietly | `upstream`, naming the reference, never the secret | Unchanged |
| | Clone timeout | The 300 s cap | Removes the partial directory under the materialisation lock | `timeout` | `absent` |
| | Base diverged from local | Ancestry check in branch preparation | Reports; changes nothing | `precondition` naming both SHAs | Unchanged; every commit still reachable |
| **GitHub via `gh`** | Rate limit | Response headers and exit code | Trips the per-credential budget; monitoring waits back off with jitter | `precondition` with a retry-after — a rate limit is repository-state-shaped, not a service fault | Unchanged |
| | 5xx or transport error | Exit code | Up to three retries with backoff, **read operations only** | `upstream` after exhaustion | Unchanged |
| | Merge conflict | PR state | **Terminal.** No rebase tool exists and by design never will | `precondition` naming the branch and both heads | Branch and commits intact; notifier fires |
| | Required check failed | Check status | Terminal for the operation | `precondition` | PR open, nothing merged; notifier fires |
| **Filesystem / volume** | Disk full | Watermark check before clone and after each mutation | Requests a maintenance pass — **never evicts inline**, which would take a materialisation lock after a mutation lock. The pass evicts safe clones and applies retention; if nothing is safe to release, the operation that needed the space is refused | `precondition` naming what is consuming the volume — clones, audit, journal, outbox or backups — and, when clones are the cause, the declarations blocking eviction | Nothing deleted beyond retention. **The service never deletes repository work to make room.** |
| | Corrupt clone | `rev-parse --git-dir` fails at materialisation | Refuses; does not clone over it | `precondition` telling the operator to inspect or move it aside | Directory untouched |
| | Permission denied | Syscall error | Fatal at boot; `infrastructure` at runtime | `infrastructure` | Unchanged |
| **Structured store** | Locked or busy | SQLite busy | Bounded retry with backoff | `infrastructure` after exhaustion | Transaction rolled back |
| | Corrupt | Integrity check at boot | **Refuses to start**, naming the pre-migration backup | No service | Volume untouched; the audit log is still readable, which is why it does not live in this store |
| | Migration fails | Non-zero from the migration step | Refuses to start; the backup was taken first | No service | The backup is the rollback target for item 18 |
| **Identity provider** | Unreachable, key rotation, clock skew | Discovery or JWKS fetch failure; signature or validity-window failure | Federated login fails; **local password plus TOTP still works** | `401` with a reason | No session |
| **Deploy target** (published-URL verification) | Deploy unfinished, wrong commit serving | Explicit poll for the exact merge commit SHA | Polls to the 1800 s cap | `precondition` classified as `stale-runtime`, `mixed-runtime`, `verification-credential` or `unexpected-profile-or-catalog` | Unchanged. **No code path returns a URL in a success position without a confirmed successful deploy for that exact commit.** |
| **Notifier endpoint** | Unreachable, non-2xx | HTTP status | Outbox retries with backoff, bounded, then stops retrying and **surfaces the row in the health view and the status endpoint**. It is not dropped: an endpoint down overnight is exactly when the 03:00 merge conflict lands, and a notification that fails silently recreates the unwatched-means-unnoticed failure one level up | Nothing — it never blocks the operation it describes | Outbox row marked failed, retained until the operator clears it |

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
| | Cannot append the **`git.raw` intent line** | **Aborts before the child process starts.** A hatch use the service cannot record must not run. The claim is refusal at call time only, not that a recorded use stays recorded — see The escape hatch's residual risk | `infrastructure` | None |
| | Cannot append the **`git.raw` outcome line** | Proceeds; the intent line already records the use and its argument vector | The envelope the command produced | Whatever the command did. The trail says what was attempted, not what it achieved |
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

**What that execution reaches, stated rather than left to be inferred.** The pinned working
directory bounds where `git` operates; it does not confine a child process. Code reached this way
runs as the service, on the volume the service owns, so it can read and write every other
declaration's clone, the structured store, the audit log, and whatever a credential resolver can
resolve. Three consequences follow, and none of them are what the words above appear to promise:

- **Attributability is refusal-time, not durable.** The audit log is append-only by discipline,
  not by storage: nothing in this design stops hatch-reached code rewriting or truncating the
  JSONL after a line lands. The boundary table claims only that an unrecordable hatch use is
  refused. Whether the trail survives the caller it describes is open question 5.
- **The lattice binds the tool surface, not the process.** "No operation anywhere adds a
  capability to a set" is true of every dispatch path. It is not a claim about a process with
  write access to the grant rows.
- **Per-declaration credential isolation stays a lookup convention.** The brief defers whether it
  is ever an enforced boundary and claims only that a credential is not *given* to an operation
  outside its declaration. Reaching one this way is inside what is claimed, not a departure from
  it. The no-cross-repository non-goal is likewise a scope statement about operations, not a
  containment guarantee — the hatch is authority the operator granted, exercised where it was
  granted.

---

## Concurrency and ordering

Two locks, one counter, and a fixed acquisition order.

| Mechanism | Scope | Covers | Held for |
|---|---|---|---|
| **Global mutation mutex** | Process-wide, across every declaration | Working-tree, index, `HEAD` and ref mutations; fetch; pull-request and merge mutations | The whole operation, including its network transfer — see the throughput ceiling below |
| **Per-declaration materialisation mutex** | One declaration | Initial clone, eviction | The whole operation for a caller; up to the 300 s clone cap for a clone |
| **Per-declaration active-operation count** | One declaration | Reads, monitoring waits, and every operation in flight | Not a lock. A non-blocking counter that never makes a caller wait; eviction refuses while it is non-zero |

### The lock protocol

The deadlock argument depends on all four rules, not on the order alone. Stated separately
because three of them are the ones an implementer would otherwise have to invent.

1. **Acquisition order is always materialisation before mutation, never the reverse.**
2. **A caller holds the materialisation lock for the whole operation**, not just for the ensure
   step, and releases in reverse acquisition order. Releasing it early would let eviction remove
   the clone between the ensure and the journal write, producing an intent record for a working
   tree that no longer exists — a state recovery cannot classify, because its pre-state is no
   longer re-derivable.
3. **Eviction never runs while the global mutation lock is held.** The disk-pressure watermark
   check after a mutation records the pressure and requests a maintenance pass; the pass runs
   with no mutation lock held and takes materialisation locks in its own right. Without this
   rule the post-mutation check acquires materialisation *after* mutation, which is exactly the
   reverse the order forbids, and the bounded waits would degrade the resulting cycle into
   spurious `conflict`s rather than a visible hang.
4. **Eviction refuses while a declaration's active-operation count is non-zero.** Reads take no
   lock, so nothing else stops eviction deleting a directory a read's subprocess has open. The
   counter is checked on the eviction side precisely because the read side cannot afford to
   block: an evicting pass that finds a non-zero count skips that declaration and moves on.

With the order fixed over two lock classes and no path that acquires them in reverse, no cycle
can form.

What runs simultaneously:

- **Reads and monitoring waits.** Lock-free. A bounded wait capped at 1800 s must not hold every
  repository for half an hour. They increment the active-operation count, which blocks eviction
  but never blocks another caller.
- **Initial clone of one declaration and mutation of another.** Required by definition-of-done
  item 5. Safe because a clone takes only that declaration's materialisation lock and never the
  global mutation lock, and any operation against the cloning declaration queues behind that same
  materialisation lock. It is **not** safe because the declaration is unservable — under
  clone-on-demand a session names a declaration precisely in order to materialise it. See
  Servability of an unmaterialised declaration.
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
- **Throughput is one mutation at a time across the whole estate, and the lock is held across
  network transfers.** Fetch and push take the global mutex and carry their own caps — 300 s
  each, alongside the 300 s clone cap — so the worst-case hold is a slow transfer, not the
  milliseconds a local commit takes. At a hundred declarations with several active callers, a
  one-line commit on an idle repository can queue behind a transfer in flight on any other one,
  and a full queue returns `conflict` on repositories that are themselves doing nothing.
  Accepted rather than fixed: a per-declaration mutation lock would raise throughput and would
  also break the invariant every other part of this design is written against — that a crash
  leaves exactly one half-done operation, which is what makes the journal's recovery
  classification tractable. Revisit only with that invariant reopened.
- **The advisory OS lock protects one host, and only on a filesystem that implements it.** A
  volume bind-mounted from two hosts is not protected — the "no distributed or multi-node
  concurrency" non-goal, restated where it bites. Less obviously, the storage volume **must be a
  container-managed named volume, not a bind mount of a host path**: this is a Linux container on
  a Windows host, and advisory locking over a bind-mounted Windows path has historically been
  unreliable enough that two instances can both believe they hold the lease. Boot therefore
  self-tests the lock — acquire, verify a second acquire from the same process fails, release —
  and refuses to start if the filesystem does not honour it, because definition-of-done item 9
  otherwise fails silently in the configuration a Windows operator is most likely to choose.
- **Node is single-threaded**, so the mutation mutex only has to serialise await points, not real
  parallel execution. A promise-chain queue is sufficient, as it is in the prior art.

### Servability of an unmaterialised declaration

**A session may name a declaration whose clone does not exist yet.** Definition-of-done item 5
requires onboarding by declaration alone, and clone-on-demand means the `tools/call` *is* the
trigger — so the alternative reading, that nothing is servable until its clone is `ready`, would
leave item 5 with no trigger at all and headless onboarding would fail.

What that costs is one paragraph of analysis the ordering argument used to get for free. Session
establishment, `tools/list` and capability filtering all run against a declaration with no tree,
and all three are well-defined without one, because every input they use is declaration data
rather than repository data: the grant is the four-layer intersection, and none of its layers
reads the working copy. `RepositoryConfig` is the one repository-supplied input, and a missing
config file already defaults every field, so discovery against an unmaterialised declaration
yields the same tool list it will yield once the clone lands.

Three states are therefore distinct and must not be conflated: a declaration with no clone is
**servable and will materialise on first use**; a declaration whose clone is materialising makes
callers wait on its materialisation lock; a declaration in `needs-attention` is servable for
reads and refuses mutations until the parked entry is resolved.

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

**Declaration management is operator-only, structurally.** Rejected: *declaration tools exposed
over MCP* — the symmetric reading of "one canonical service per operation", and it hands an
injected agent a route to attach an existing credential reference to a remote it controls and
harvest the token from the push. The remote-host allowlist is the second, independent guard, so
the property does not rest on the capability alone. Also rejected: *presenting this as a
deployment default that could be flipped* — it cannot be, because a repository-bound session has
nothing to bind a declaration-creating call to, and the honest statement is that the session model
forbids it. Calling it a default invites someone to enable it later and either fail or punch a
non-repository resource URI through the model to make it work.

**One lock protocol, stated as four rules rather than one ordering.** Rejected: *the acquisition
order alone is the deadlock argument* — how this design read before review, and it is false: the
post-mutation disk-pressure check evicts under a materialisation lock taken after a mutation lock,
which is the reverse of the stated order. Also rejected: *releasing the materialisation lock after
the ensure step* — the intuitive reading of a lock that guards materialisation, and it opens a
window where eviction removes a clone between the ensure and the journal write, leaving an intent
record whose pre-state is no longer re-derivable. Also rejected: *making reads take the
materialisation lock so eviction cannot race them* — correct and unaffordable, since it
reintroduces the blocking the read exemption exists to remove; the exclusion lives on the eviction
side as a counter instead.

**Boot starts transports first and recovers lazily.** Rejected: *recover every declaration before
readiness* — the stronger guarantee, and it makes restart cost scale with estate size, so at a few
hundred clones the operator stops doing the restart that item 14 exists to make safe. A
declaration carrying unsettled entries is `recovery-pending`, serves reads, and refuses mutations
until it has recovered — which keeps the guarantee where it is load-bearing and drops it where it
was only tidy.

**A frozen session grant plus a declaration grant epoch.** Rejected: *recompute the grant on every
call* — simplest to describe, and it discards the prior-art rule that a token tier is fixed at
`initialize`, so a widened declaration grant would reach a live session. Also rejected: *freeze
and accept that revocation waits for the session to end* — what this design said before review,
and it leaves the operator restarting the container as their only revocation mechanism during an
incident. The epoch keeps the freeze's one-way property and still lets a narrowing land on the
next call.

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

5. **Should the audit log be tamper-evident?** Definition-of-done item 8 wants hatch use
   attributable, and the hatch is the one surface that can rewrite the log recording it. The brief
   declined a hard floor, but it never considered whether the evidence survives — so this is
   unanswered rather than settled. Recommended: **a per-line hash chain, verified at boot and by
   an operator-visible check**, which detects truncation and rewriting without needing storage the
   service cannot reach. Alternatives: append the trail to an external sink the container cannot
   edit, which is the only option that also survives volume loss and adds a deployment dependency
   the brief has not scoped; or accept refusal-time attributability as the whole claim and say so
   in the definition of done. This wants deciding before `/contract`, because the answer fixes the
   audit line format, and retrofitting a chain over a written trail is a migration.

6. **What is the real disk budget, and is eviction expected to fire?** "Unbounded and assumed to
   grow" sets the design constraint, and the eviction machinery follows from it. The watermark
   values, the retention windows for the audit log, journal, outbox and pre-migration backups,
   and whether eviction is a routine event or a last resort that should notify you, all depend
   on a number only you have. If the real answer is twenty repositories on a volume with room for
   two hundred, the interlock still earns its place but the thresholds and the notification
   posture are different.

7. **Do the blog authoring views gain a repository dimension, or stay pinned to one declaration?**
   `ComposeView` is 38 KB of repository-implicit code. Under this design a view renders for the
   selected repository when the grant permits, which implies parameterising it. Pinning it to the
   blog declaration instead is less work and less general, and is defensible because blog
   authoring genuinely applies to exactly one repository. The answer changes the shape of the
   view-registration seam — whether a registered view receives the selected repository or declares
   the one it belongs to — so it is a contract question rather than a preference.
