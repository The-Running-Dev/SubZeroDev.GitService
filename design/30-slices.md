# Slices — SubZeroDev.Git

Derived from `10-design.md` and `20-contract.md`. Twenty-two vertical slices. Each one ends
runnable: it goes from an entry point to persistence and leaves nothing half-wired.

## Criterion ids

Every acceptance criterion carries a stable `S<n>.<m>` id. `/track` compares ids rather than prose,
so a reworded criterion does not read as drift and a ticked checkbox keeps meaning what it meant.

**The ids are positional from 1 within each slice, and that was not a free choice.** The test suite
had already been citing them — `S3.4`, `S4.7`, `S9.2`, `S10.4` — derived positionally by whoever
wrote each test, against a document that contained no `S<n>.<m>` token anywhere. Numbering any other
way would have silently re-pointed every one of those test names at a criterion it does not prove.
The positional reading was checked against each cited id before numbering, and each resolves to the
criterion its test name describes. This resolves the open decision of 2026-08-04, in the `/slices`
session that entry said it needed.

**Ids are never reused and never renumbered.** Removing a criterion leaves a gap; the next one takes
the next free number. A criterion added later is **appended, even when it has to run first** —
`S12.8` and `S18.8` are both of that kind, and each says so in its own text. Renumbering to put them
in logical order would rewrite what an existing issue's checkbox refers to, which is the single
failure this scheme exists to prevent.

## Why this order

The two bets the design cannot control are proven first, because both are cheap to test and both
invalidate a great deal if false.

**S1 proves the contract-first spine.** Deliverable 1 is new construction against a document that
states nothing in it is implemented. If the compiler, the fingerprint and the boot refusal do not
hold together, every capability claim downstream is decoration.

**S2 proves the volume honours an exclusive advisory lock.** This is a Linux container on a Windows
host, where the design records that advisory locking has historically been unreliable enough for
two instances to both believe they hold the lease. Definition-of-done item 9 rests on a property of
the filesystem, not of this code. If the target volume fails the child-process self-test, single
instance ownership needs rethinking — and that is worth learning in week one rather than after the
journal, the clone store and the audit chain have all been written against it.

The capability lattice is the design's spine but is not observable until a session can list tools,
so it lands in two parts: the instance-scoped layers in S5, where declaration-management routes
first need them, and discovery filtering in S6.

## Contract gates

Items in `20-contract.md` § Unresolved block specific slices. Each is a contract amendment,
committed separately and before the handler work depending on it. **No slice may introduce a
signature absent from the contract** — where a slice needs tools, amending the contract is its
first acceptance criterion, not an implementation detail.

| Gate | Blocks | Answered by |
|---|---|---|
| **U9** — the audit record's canonical serialisation | S3 and everything after | S3, before the first line is appended. The trail is unbackfillable |
| **U1** — the registry tool inventory and per-tool schemas | S6, S7, S9, S10, S12, S15, S16 | Incrementally: each slice amends the contract with only the tools it ships |
| **U8** — the pre-state digest serialisation | S7 and everything after | S7, before the first journal entry is written |
| **U3** — whether `JournalStepState` has a value beyond `applied` | S12 | S12, before the first composite journals a sub-step |
| **U2** — the operator scope vocabulary | S13 | S13 |
| **U4** — the HTTP route table | S18 | S18 |
| **U5** — OAuth endpoint paths and metadata document | S14 | S14 |
| **U6** — the deferred operational numbers | S15, S17 | S15 for `hatchSeconds`, S17 for the rest |
| **U7** — the console element type and build entry | S19 | S19 |

## A contradiction found while slicing, since resolved

Writing S1's acceptance criteria surfaced a conflict between contract invariant **E8** — no HTTP
route unauthenticated — and the design's own item 15 companion check polling `/healthz`
unauthenticated. **Resolved 2026-08-03 by splitting the payload**, not by picking a reading: the
probe carries `LivenessReport`, which is `ready` and `commitSha` and nothing else, and the operator
health report is a separate authenticated route. Both documents are amended and the decision log
carries the reasoning. S1 below reflects the resolution.

---

## S1 — The contract compiles, and the service refuses to start on a mismatch

Delivers: a build that turns tool declarations into a fingerprinted registry, and a service that
starts, answers `/healthz` with readiness and its running commit, reports its contract fingerprint
on an authenticated version route, and refuses to start when the registry does not match.

Touches: Contract types (L0), Compiler (L0), Clock and the result envelope (L1), Lifecycle (L1 —
boot steps 2 and 3 only), Surfaces (L5 — health and version routes only), composition root.

Depends on: none.

Acceptance:
- S1.1 `compile([])` returns a `CompiledRegistry` with `entries` empty and a `Sha256Hex`
  fingerprint.
- S1.2 Compiling the same declaration array twice returns an identical fingerprint; reordering the
  array before compiling returns the same fingerprint again. Three runs, one value.
- S1.3 Compiling a fixture set emits a registry artifact, a `SanitisedManifest` carrying no
  `inputSchema` and no `outputSchema`, and generated documentation.
- S1.4 Each of the eight `CompilerError` variants rejects at least one crafted fixture and the build
  exits non-zero. **The build prints the count of rejected fixtures and the count of accepted ones**
  — definition-of-done item 2 asks for stated counts, and a validator that has never failed is not
  known to constrain anything.
- S1.5 Editing one byte of the emitted registry artifact makes boot exit non-zero with
  `fingerprint-mismatch` naming the expected and found hashes, and no transport starts.
- S1.6 `/healthz` returns 200 with a `LivenessReport` carrying exactly two fields, `ready` and
  `commitSha`. A test asserts the serialised body contains no other key — this is the route the
  contradiction above was resolved against, and the guard is what keeps operator data from accreting
  onto it later.
- S1.7 The version route returns `contractFingerprint` equal to the value the build printed, and
  answers `401` without a credential.
- S1.8 A check fails the build if any runtime module imports the compiler (invariant B8).

Out of scope: declaring any product tool — the inventory is U1 and nothing before S6 needs one; the
module and http adapters; the deployment ceiling check (S5); the console asset manifest (S19); the
full `HealthReport` payload, which needs subsystems that do not exist until S3 and S11.

---

## S2 — One instance owns the volume, and a second refuses to start

Delivers: exclusive ownership of a named volume, a created schema, and a second instance that
refuses to start naming the holder.

Touches: Structured store (L1), Lifecycle (L1 — boot steps 1, 4 and 8), Surfaces (L5 — readiness).

Depends on: S1.

Acceptance:
- S2.1 Against a fresh volume, migration `0001` applies and all sixteen tables in `StoreTableName`
  exist with the declared indexes. `schema_migration` holds one row.
- S2.2 A second process started against the same volume exits non-zero naming `instanceId`,
  `hostName` and `startedAt` read from the lease file.
- S2.3 After `SIGKILL` of the holder, a new process starts and reports the takeover in its boot
  report. No manual lock clearing is required.
- S2.4 The child-process self-test runs on every boot: a spawned child attempting the same lock is
  refused and boot proceeds. **On a volume that grants both, boot exits non-zero with
  `lease-not-exclusive` naming the volume configuration.** Both paths are demonstrated — the second
  by pointing the service at a bind-mounted host path, which is the configuration a Windows operator
  is most likely to choose.
- S2.5 `backupBeforeMigration` produces a timestamped copy **before** `migrate` runs; a migration
  induced to fail leaves the copy intact and the service refusing to start.
- S2.6 A store corrupted on disk makes boot exit with `corrupt` naming the newest snapshot **and its
  age in seconds**, alongside the pre-migration copy, as two distinct offers.
- S2.7 Readiness passes only after the lease is held and migrations have applied.

Out of scope: the audit trail (S3) — the lease-takeover record lands there; retention, scheduled
snapshots and incremental vacuum (S17); clone directories (S5); recovery (S8).

---

## S3 — The audit trail, hash-chained and verified at boot

Delivers: an append-only trail that survives corruption of the structured store, whose chain boot
verifies and whose state the health endpoint reports. Its first records are the boot and
lease-takeover events S2 produces.

Touches: Audit (L1), Structured store (L1 — `audit_chain_head`, `audit_retained_anchor`), Lifecycle
(L1), Surfaces (L5 — health).

Depends on: S2. **Gated on U9.**

Acceptance:
- S3.1 The canonical serialisation is fixed in `20-contract.md` in a commit preceding any append.
- S3.2 Appending N records produces N JSONL lines with contiguous `sequence` values, each
  `previousHash` equal to its predecessor's `hash`, and `audit_chain_head` equal to the last line's
  hash.
- S3.3 500 concurrent appends produce 500 lines with no duplicate sequence number and a chain that
  verifies — the single-writer queue holding under overlap that a lock-free path would break.
- S3.4 Deleting one line from the middle of a segment makes `verify` return an `AuditChainBreak`
  naming the sequence, the expected hash and the found hash; the authenticated health report shows
  it; **boot still starts and serves.**
- S3.5 Truncating the file at any point produces the same outcome. Editing one field of one line
  produces the same outcome.
- S3.6 Rotation at `auditSegmentBytes` opens a new segment beginning with the previous segment's
  terminal hash, and `verify` spans the boundary.
- S3.7 `append` returns `{ appended: false }` rather than throwing when the volume is full, and the
  calling path completes.
- S3.8 A lease takeover writes a `lease-takeover` record naming the previous holder.

Out of scope: the audit console view (S18); retention and the anchors it writes (S17 — the table
exists here, the pruning does not); any `call` or `hatch-*` record, since nothing dispatches yet.

---

## S4 — The operator can log in, and only the operator

Delivers: first provisioning from a file on the volume, local login with enforced TOTP, both
lockout-recovery paths, and a persisted session that survives a restart and can be invalidated
server-side.

Touches: Operator identity (L4), Structured store (L1), Audit (L1), Surfaces (L5 — console session,
cookie, CSRF, enrolment and login routes).

Depends on: S3.

Acceptance:
- S4.1 With no operator credential, readiness passes, every console route answers `401`, and the
  status endpoint reports `provisioningPending: true`.
- S4.2 Enrolment with the wrong secret answers `401` and does **not** burn the provisioning file.
  Enrolment with the correct secret sets the password, enrols TOTP, returns exactly ten recovery
  codes once, and deletes the file. A second attempt answers `401` with `already-provisioned`.
- S4.3 Login with a correct password and no TOTP code fails. TOTP is never optional — demonstrated
  by the absence of any field in `DeploymentConfig` that could disable it.
- S4.4 A recovery code authenticates once; the same code again answers `401` with
  `recovery-code-used`; a successful use writes an `identity-event` record and sets
  `totp_reenrol_required`.
- S4.5 A break-glass token written to the volume authenticates once, is audited, and does not work
  twice. It works with no TOTP device **and** no remaining recovery codes — the case neither other
  path covers.
- S4.6 A session survives a process restart. Explicit logout invalidates it server-side: the same
  cookie replayed after logout answers `401`.
- S4.7 A cross-site `POST` to a mutating console route without the double-submit token is rejected,
  and the same request with a mismatched `Origin` is rejected.
- S4.8 The cookie carries `HttpOnly`, `Secure`, `SameSite=Lax` and is host-scoped.

Out of scope: OIDC federation (S18) — the local path must stand alone, which is the whole reason
recovery codes exist; the grants view and operator API tokens (S13); any repository route.

---

## S5 — A repository is declared, and clones itself on first use

Delivers: declaring a managed repository through the console, and a clone that materialises on
first use without a restart. This is definition-of-done item 5's mechanism.

Touches: Declarations (L1), Clone store (L1), Locks (L1), Exec (L1), Lifecycle (L1 — boot step 8),
Surfaces (L5 — declaration routes and the landing view).

Depends on: S4.

Acceptance:
- S5.1 Boot exits non-zero with `ceiling-outside-contract` when the deployment ceiling names a
  capability absent from the registry's `contractCapabilitySet`.
- S5.2 Declaring with an id violating `^[a-z0-9][a-z0-9-]{0,62}$` returns `validation`; with a
  `cloneUrl` whose host is off the allowlist returns `remote-host-not-allowed`; a `generic` host
  granted `host.pr.write` returns `capability-unsupported-by-host`. Positive and negative counts
  stated.
- S5.3 A declared repository has no clone, and is servable in that state: `describe` reports
  `absent` rather than erroring. The first operation touching it clones on demand.
- S5.4 A clone whose `observedRemote` differs from `cloneUrl` returns `remote-mismatch` and **does
  not repoint the checkout** — the directory is byte-identical before and after.
- S5.5 A clone exceeding the 300 s cap returns `timeout` and leaves the clone `absent` with the
  partial directory removed.
- S5.6 A directory git will not read returns `corrupt-tree` naming `clone.remove` as the exit.
- S5.7 Two concurrent operations against the same materialising repository produce exactly one
  clone; the second waits on the materialisation lock.
- S5.8 A clone of repository A does not block a read of repository B.
- S5.9 Orphaning marks the declaration `orphaned` and leaves the clone directory untouched on disk.
- S5.10 Re-declaring an id whose orphaned clone is dirty returns `adoption-refused` naming the
  blockers.
- S5.11 `declaration.remove` refuses while a clone remains. `clone.remove` refuses a tree holding
  commits unreachable from `origin/<base>`, override or not — the override permits only a tree git
  cannot read.

Out of scope: the rest of the orphaning cascade — grants, jobs and drop directories do not exist
yet, and each is added by the slice that creates them; any registry tool (S6); mutations (S7);
eviction (S17).

---

## S6 — Reads, dispatched through the pipeline, filtered by capability

Delivers: the first registry tools, reachable over the HTTP API, with discovery that varies by the
declaration's grant. The lattice becomes observable.

Touches: Dispatch pipeline (L4), Module adapter (L3), Git operations (L2 — the five read
operations), Declarations (L1 — `effectiveGrant`), Audit (L1), Surfaces (L5).

Depends on: S5. **Gated on U1** for `status`, `log`, `branches`, `health` and `diff`.

Acceptance:
- S6.1 The tool declarations this slice ships are written into `20-contract.md` in a commit
  preceding any handler.
- S6.2 Boot exits with `executor-missing` when a registry entry has no registered executor.
- S6.3 `visibleTools` for a declaration granting only `repo.read` contains the five read tools and
  no others. Removing `repo.read` makes the list empty — **the tools are absent, not refused.**
- S6.4 A by-name call for a tool absent from `visibleTools` returns `authorization`, writes an
  `authorization-rejection` record, and reaches no handler. Asserted by a handler that records
  having been entered.
- S6.5 Input failing the declared schema returns `validation` with findings and no handler runs.
- S6.6 A handler returning a value the output schema rejects returns `infrastructure`.
- S6.7 A result exceeding `maxResultBytes` returns `infrastructure` rather than a truncated payload.
- S6.8 `log` with no `ref` reads `origin/<baseBranch>`, not `HEAD` — demonstrated on a clone
  deliberately parked on a different branch.
- S6.9 A repository with no config file returns defaults for all four `RepositoryConfig` fields and
  every read tool succeeds.
- S6.10 Every read result carries a `ReadStamp`. Reads take neither lock: two reads of the same
  repository run concurrently, proven by overlapping timestamps.

Out of scope: MCP transport (S14) — this slice drives the pipeline over the HTTP API only; mutating
tools and the mutation lock (S7); the grant epoch (S14); monitoring waits (S10).

---

## S7 — Local mutations, serialised, with intent recorded before the first side effect

Delivers: stage, commit and restore-paths, under the path allowlist, the two-lock protocol and the
journal. The riskiest concurrency and durability machinery in the design.

Touches: Git operations (L2), Journal (L1), Locks (L1), Clone store (L1), Dispatch pipeline (L4).

Depends on: S6. **Gated on U8 and U1.**

Acceptance:
- S7.1 The pre-state digest serialisation is fixed in `20-contract.md` before the first entry is
  written.
- S7.2 `indexDigest` is computed without `git write-tree`: a repository with a deliberately unmerged
  index captures pre-state successfully rather than failing. This is the case that would otherwise
  make every mutating tool abort permanently on the one declaration most needing attention.
- S7.3 A write path of `-A`, `--all`, `.`, `../x` or `a;b` returns `validation`. A well-formed path
  outside `writablePathPrefixes` returns `authorization` **and writes an audit record**. Counts
  stated for both classes.
- S7.4 The intent record commits before the first side effect: with the journal write forced to
  fail, the operation returns `infrastructure` and `git status` is byte-identical before and after.
- S7.5 Two concurrent mutations — same repository and different repositories — never overlap.
  Instrumented so an overlap fails the test rather than being inferred from timing.
- S7.6 A mutation waiting past the acquire timeout returns `conflict` naming the holding operation's
  `operationId`, `tool` and `declarationId`.
- S7.7 The materialisation lock is held for a mutation's whole duration and released **after** the
  mutation lock. Release order asserted, not assumed.
- S7.8 An operation begun against an already-dirty tree that changes one path and is then killed
  leaves a `preState` whose digests differ from the observed state. **This is the case boolean clean
  flags cannot represent**, and it is tested directly.
- S7.9 No reset, clean, force-push, rebase or branch-delete operation exists on `GitOperations`.
  Attempting all six through the typed surface fails, with counts stated — definition-of-done item
  7.

Out of scope: recovery from the entries this slice writes (S8) — this slice proves they are written
correctly, not that they are acted on; remote operations (S9); `git.raw` (S15).

---

## S8 — A restart mid-operation recovers, or parks and says so

Delivers: definition-of-done item 14. Boot classifies every unsettled entry, resumes what it can,
parks what it cannot, and the operator has a route out that does not require host access.

Touches: Journal (L1 — `classify`), Clone store (L1 — observation), Recovery catalogue (L1),
Lifecycle (L1), Surfaces (L5 — parked-operations view).

Depends on: S7.

Acceptance:
- S8.1 `classify` is pure: called twice with identical arguments it returns identical verdicts, and
  a test asserts it performs no I/O.
- S8.2 Killing the process between the intent write and the first side effect leaves an entry that
  classifies `nothing-happened` and settles.
- S8.3 Killing it after the operation completed but before the settle leaves an entry that
  classifies `completed` and settles.
- S8.4 An entry carrying an `applied` step never classifies `nothing-happened`, **even when every
  pre-state field matches** — the case a local-only comparison gets wrong.
- S8.5 An entry whose tool has no descriptor in the catalogue parks as `attention`.
- S8.6 Readiness passes and transports start **before** any recovery work runs. A declaration with
  unsettled entries is `recovery-pending`, serves reads, and refuses mutations.
- S8.7 Recovery on first use completes before the triggering call acquires the mutation lock, and
  the resume takes the lock in its own right. Asserted by acquisition order, not by timing.
- S8.8 A parked declaration admits **every `mutating` registry entry carrying `git.local.write`** to
  a session holding `attention.resolve` — today stage, restore-paths and commit — each audited with
  `context: 'repair'`, while ordinary traffic gets reads only. The gate is a predicate, not a list
  of tool names, because branch preparation is a composite that does not exist until S12 and an
  enumerated allowlist would withhold it from the repair session at the moment an operator most
  needs it. It is scoped to `git.local.write` rather than to `mutating` alone because `10-design.md`
  § capabilities maps that capability to exactly the four tools the repair session names — "branch
  preparation, stage, commit, restore-paths" — so the predicate reproduces the design's list rather
  than widening it. `git_push` is a mutating entry too, and a parked declaration must not admit one.
- S8.9 Resolving a parked entry returns the clone to `ready` and the declaration to ordinary
  service.
- S8.10 Recovery discards nothing: a test asserts no commit, stash, untracked file or unpushed
  branch is removed on any path.

Out of scope: notification of terminal states (S11) — the hooks are placed, delivery is not; resume
steps touching a host (S12, once composites exist); the scheduler's boot job resolution (S16).

---

## S9 — Credentials resolve, and the service reaches a remote

Delivers: fetch, push and base-sync against a real remote, with the credential resolved at point of
use and never returned to a handler.

Touches: Credentials (L1), Exec (L1), Git operations (L2), Structured store (L1 —
`credential_failure_mark`).

Depends on: S8. **Gated on U1** for `push`, `fetch` and `sync_base`.

Acceptance:
- S9.1 A reference naming a file in the mount resolves; one naming a missing file returns
  `reference-not-found` naming the reference and the declaration and **never the value**.
- S9.2 The resolved secret appears in no `ToolResult`, no audit record, no log line and no process
  argument vector. Asserted by scanning captured output and the child's command line for the known
  fixture value.
- S9.3 Replacing the secret file takes effect on the next operation with no restart.
- S9.4 A push rejected for authentication marks the reference failing **for that declaration only**:
  a second declaration sharing the reference continues to work. This is the case a reference-wide
  mark breaks, turning one repository's misconfiguration into an unrelated outage.
- S9.5 The mark clears when the resolver observes a changed secret, and by hand from the health
  view.
- S9.6 The service never retries with a different credential — asserted by counting resolutions per
  operation.
- S9.7 A push takes the global mutation lock and holds it across the transfer; a concurrent commit
  on another repository queues rather than interleaving.
- S9.8 `push` has no force option in its input schema.
- S9.9 A fetch failing mid-transfer leaves refs unchanged.

Out of scope: pull requests and checks (S10); the escape hatch's remote-operand rules (S15);
per-credential request budgets (S10).

---

## S10 — Pull requests, checks and bounded waits

Delivers: the GitHub surface behind the host adapter — open a pull request, read its status and
comments, enable auto-merge, read checks — with monitoring waits that are lock-free and capped.

Touches: Host adapter (L2), Exec (L1 — `gh`), Locks (L1 — the active-operation count and admission
limits), Dispatch pipeline (L4).

Depends on: S9. **Gated on U1** for the host tools.

Acceptance:
- S10.1 Every host mutation writes an `applied` journal step **before** the network call. Killing
  the process between the step and the call leaves an entry that parks rather than settling — the
  case that would otherwise open a second pull request on retry.
- S10.2 A rate limit returns `upstream` with a retry-after, **never `precondition`** — asserted
  against a fixture, because the design records this exact misclassification as a defect it had.
- S10.3 A 5xx retries up to three times for reads and **zero times** for mutations. Retry counts
  asserted.
- S10.4 A merge conflict is terminal: `precondition` naming the branch and both heads, and no merge
  or rebase method exists on `HostAdapter`.
- S10.5 A monitoring wait takes neither lock: a wait in flight on repository A does not delay a
  mutation on repository B, and does not hold A's materialisation lock.
- S10.6 A wait requesting 3600 s is capped at 1800 s.
- S10.7 Exceeding `concurrentWaitsPerSession` or `concurrentLockFreeOperations` returns `conflict`.
- S10.8 Returned comment bodies are carried as data, and the tool is annotated `untrustedOutput`.

Out of scope: published-URL verification and deploy monitoring (S12); notification of terminal
states (S11); driving auto-merge unattended (S17).

---

## S11 — Terminal states reach the operator

Delivers: the outbox, its two severities, and delivery that never blocks the operation it describes.
Without this, "unwatched" means "unnoticed".

Touches: Notifier (L1), Journal (L1 — the settle transaction), Structured store (L1), Surfaces (L5 —
health view).

Depends on: S10.

Acceptance:
- S11.1 The outbox row and the journal settle commit in **one transaction**: with the process killed
  between them, no state exists in which the entry is `settled` and the row is missing. Asserted by
  forcing a crash inside the transaction and inspecting both tables.
- S11.2 Boot re-drives every undelivered row.
- S11.3 A merge conflict, a failed required check and a wait timeout each enqueue at `attention`.
- S11.4 Delivery failure retries with backoff, bounded, then marks the row `failed` and surfaces it
  in the health view. **The row is never deleted.**
- S11.5 With no webhook configured, rows accumulate as `pending` and are visible; nothing throws.
- S11.6 A notifier endpoint that hangs does not delay the operation that enqueued the notification —
  asserted by comparing the operation's `durationMs` against the endpoint's delay.
- S11.7 Recovery settling an entry that reached a terminal state the caller never saw **fires the
  notification**. The caller's connection died with the process, so suppressing it here would
  recreate the failure one level up.

Out of scope: the `info` severity and the maintenance summary (S17); a second transport — one
webhook ships and no more.

---

## S12 — Composites, and a change carried end to end

Delivers: branch preparation and reconcile-after-merge as handwritten transactional sequences, each
with its recovery descriptor — plus published-URL verification, which is the http adapter's only
consumer.

Touches: Composites (L2), Http adapter (L3), Recovery catalogue (L1), Host adapter (L2).

Depends on: S11. **Gated on U1.**

Acceptance:
- S12.1 The seven protected-base invariants are each demonstrated by an operation violating them
  being refused, with counts stated. The stranded-commit incident that produced them is a regression
  test, verified by reverting the fix and confirming it fails.
- S12.2 Branch preparation bases fresh from `origin/<base>` regardless of what is checked out.
- S12.3 A base diverged from local returns `precondition` naming both SHAs and changes nothing;
  every commit remains reachable afterwards.
- S12.4 Each composite journals every sub-step and registers exactly one `RecoveryDescriptor`.
  Killing the process at each sub-step boundary in turn produces a classification that is `resume`
  or `park` — **never `nothing-happened`**. Every boundary is exercised.
- S12.5 A resume touching the host runs through the pipeline under its own mutation lock, and
  **not** during boot. Asserted by an exec spy recording zero host calls during boot.
- S12.6 Published-URL verification returns `precondition` naming both SHAs when a 200 serves a
  commit other than the expected merge commit, `upstream` when unreachable or non-2xx, and `timeout`
  at the cap. **No success envelope contains a URL without a confirmed deploy for that exact
  commit.**
- S12.7 The http adapter carries no credential dependency — asserted by its import graph.
- S12.8 **U3 is resolved in `20-contract.md` before the first composite journals a sub-step** —
  either `JournalStepState` admits a second value and the recovery ladder gains a branch reading it,
  or the field is redundant and the contract says so. This criterion is numbered last and runs
  first: a composite that journals sub-steps is precisely what U3 says it cannot determine, and
  S12.4's "never `nothing-happened`" is unverifiable while a completed step and an unfinished one
  are indistinguishable on disk.

Out of scope: definition-of-done item 15's self-verification, which is a companion script and not a
registry tool (S22); driving auto-merge unattended (S17).

---

## S13 — Durable grants, and revocation that means something

Delivers: the authorization server's record half — clients, grants, opaque tokens verified by stored
hash, the revocation cascade, operator API tokens, and the grants view. Proven over the
`operator-api` path, which needs no MCP transport.

Touches: Authorization (L4), Structured store (L1), Surfaces (L5 — grants view, token routes).

Depends on: S11. **Gated on U2.**

Acceptance:
- S13.1 The `OperatorScope` vocabulary is fixed in `20-contract.md` before any grant is issued.
- S13.2 An operator API token authenticates a bearer route. **Bearer routes reject a cookie and
  cookie routes reject a bearer** — both directions tested.
- S13.3 The token value exists only in the `IssuedToken` returned once. A scan of every store row
  finds no content equal to the issued value.
- S13.4 Verification is constant-time — asserted by the comparison function used, not by timing.
- S13.5 A token survives a process restart and continues to authenticate. This is the half of
  definition-of-done item 12 the prior art does not have.
- S13.6 Revoking a client makes its grants and their tokens dead **without writing to those rows**:
  `revoked_at` is set on the client only, and `grantIsLive` walks upward. Asserted by row inspection
  before and after.
- S13.7 Revocation is never a delete: after revoking a client, a grant and a token, all three rows
  remain and answer "what did that client have".
- S13.8 The grants view lists clients, grants, operator API tokens and operator sessions with last
  use, and revokes any of them.

Out of scope: MCP session establishment and the resource indicator (S14); the grant epoch reaching a
live session (S14); OIDC (S18).

---

## S14 — MCP, bound to one repository, with a grant that can narrow

Delivers: the MCP transport, sessions bound to `/mcp/{declarationId}`, discovery filtered by the
four-layer intersection, and the grant epoch that lets a narrowing reach a live session.

Touches: Surfaces (L5 — MCP transport), Authorization (L4), Dispatch pipeline (L4), Declarations
(L1 — `grantEpoch`).

Depends on: S13. **Gated on U5.**

Acceptance:
- S14.1 A token whose audience does not match the exact resource URI is refused with **`401` and a
  `WWW-Authenticate` resource-metadata challenge, not an envelope**.
- S14.2 A session bound to repository A calling a tool with repository B's id returns
  `authorization`.
- S14.3 `tools/list` for a session whose declaration lacks `git.raw` does not contain it; a by-name
  call for it returns `authorization` and reaches no handler.
- S14.4 **Narrowing** a declaration's `capabilityGrant` during a live session takes effect on the
  next call: the recomputed grant is a strict subset and the removed capability returns
  `authorization`.
- S14.5 **Widening** a declaration's grant during a live session does **not** reach it — the frozen
  session keeps its narrower set until re-established. Both directions asserted; this pair is the
  whole point of the epoch.
- S14.6 Revoking the grant outright closes the session and answers `401` with the challenge.
- S14.7 A client registers dynamically, completes PKCE, and reconnects after a container restart
  without re-authorising — definition-of-done item 12 end to end.
- S14.8 `declaration.manage`, `auth.manage`, `audit.read` and `attention.resolve` are absent from
  every MCP session's grant, and no configuration makes them present.
- S14.9 A stdio process proxies over HTTP, opens no volume, takes no lock and holds no clone.

Out of scope: the escape hatch (S15); scheduled work (S16); the console's remaining views (S18).

---

## S15 — The escape hatch, and the six operations it can reach

Delivers: `git.raw` — default-deny per declaration, argument forms constrained, remote operands
bound to the declaration's own remote, and two audit lines per use. Definition-of-done item 8.

Touches: Git operations (L2 — `raw`), Exec (L1), Audit (L1), Declarations (L1).

Depends on: S14. **Gated on U1**, and on `hatchSeconds` from U6.

Acceptance:
- S15.1 A newly declared repository does not have `git.raw`. It appears in `tools/list` only after
  `capabilityGrant` names it explicitly.
- S15.2 Reaching all six blocked operations — `reset --hard`, `clean`, `push --force`, `rebase`,
  `branch -D`, history rewriting — through the hatch produces **six attributable audit entries**.
  This is the only property claimed for the hatch, and the count is stated.
- S15.3 An argument vector selecting an executable or injecting configuration is rejected with
  `argv-rejected` **before the process starts**.
- S15.4 `git push https://github.com/attacker/sink.git` is rejected even though `github.com` is on
  the allowlist — the case a host-level check passes and the non-goal forbids. `git push origin` and
  an explicit spelling of the declaration's own remote both pass.
- S15.5 `git remote add sink <url>` followed by `git push sink` is closed: the first call is refused
  by subcommand. Both calls attempted, both blocked, because checking operands alone is defeated by
  two individually legal calls.
- S15.6 With the audit append forced to fail, the **intent** line's failure aborts before the child
  starts and leaves the tree byte-identical; the **outcome** line's failure lets the call complete
  and records the attempt.
- S15.7 Exceeding `hatchSeconds` kills the child, returns `timeout`, and parks the journal entry.
- S15.8 The hatch runs with system and global configuration disabled and a neutral home directory,
  while the service's own credential configuration is still supplied — proven by a fetch that
  succeeds.

Out of scope: containing what the child process reaches. The design records this as accepted risk
with a stated inventory, and narrowing it is a brief change, not a slice.

---

## S16 — Held operations fire, or are cancelled with a reason

Delivers: the generalised scheduler — one registry-named operation held until a time, re-checked
against every authority layer at fire time.

Touches: Scheduler (L2), Journal (L1), Lifecycle (L1 — boot step 6), Structured store (L1).

Depends on: S15. **Gated on U1** for the three scheduler tools.

Acceptance:
- S16.1 Creating a job naming a tool without the `schedulable` annotation returns
  `tool-not-schedulable`.
- S16.2 `onMissed` is required: a creation omitting it returns `validation`.
- S16.3 At fire time the grant is re-intersected with the declaration grant, the ceiling and the
  creating grant. A job can lose capability between creation and firing and **never gain it** — both
  directions tested.
- S16.4 **A job whose creating grant was revoked after creation moves to `cancelled` naming the
  revocation and never fires.** The 02:00-created, 03:00-revoked, 06:00-due sequence is the test,
  because this is the actor that runs unwatched.
- S16.5 Orphaning a declaration moves its pending jobs to `cancelled` naming the orphaning.
- S16.6 The pipeline stamps `scheduledJobId` onto the journal entry, and the job carries no
  `operationId`.
- S16.7 A job left `running` by a killed process is resolved from the journal alone at boot: an
  entry that settles makes it `done`, one that parks makes it `needs-attention`, and no entry at all
  returns it to `pending`. **It is never simply fired again.**
- S16.8 Boot's job resolution runs no resume step and performs no git or host I/O — asserted by an
  exec spy that must record zero calls.
- S16.9 An image upgrade removing a tool makes pending jobs referencing it `needs-attention` at
  boot, naming the upgrade, rather than failing weeks later at fire time.

Out of scope: any sequencing, conditional or multi-step feature. This holds exactly one operation,
and the workflow-engine non-goal is binding.

---

## S17 — Files dropped into a directory become pull requests, and the volume stays bounded

Delivers: the content-drop watcher, generalised from `blog-mcp`'s running one, carrying a file
through to a pull request — plus the maintenance pass, because an unattended drop that stops at a
local commit makes every drop-enabled declaration a permanent eviction blocker.

Touches: Watcher (L2), Clone store (L1 — eviction), Lifecycle (L1 — the maintenance pass), every
module's `runRetention`.

Depends on: S16. **Gated on U6.**

Acceptance:
- S17.1 All three switches default off. With any one off, `start` returns `not-permitted` naming
  which.
- S17.2 A dropped file is claimed by rename into `processing/` **before any git or host action**, so
  a second tick cannot pick it up.
- S17.3 A file found in `processing/` at startup is moved to `failed/` with an explanation and
  **never reprocessed** — the case that turns one dropped file into two published ones.
- S17.4 A symlink is never a candidate, asserted with a link-preserving stat against a symlink
  pointing at a readable file outside the drop.
- S17.5 A tick is a no-op when the clone is not clean; when the clone is `needs-attention` the file
  stays in the inbox.
- S17.6 Nothing is ever deleted: every terminal path leaves the file in `processed/` or `failed/`,
  with a sibling error file naming the failing step and its result kind.
- S17.7 The sequence runs to a pull request with auto-merge, each mutating step taking the mutation
  lock for itself; the plan step takes no lock and needs no clone. **No outer lock wraps the
  composite** — asserted, because wrapping it deadlocks against a non-reentrant mutex.
- S17.8 Opened pull requests are re-checked each tick and reconciled once merged. The list is
  written temp-then-rename, and a corrupt list is treated as empty rather than crashing the tick.
- S17.9 The watcher's allowlist strips `.github/workflows/`, `.config/`, `tools/` and `build/`: a
  drop resolving to a workflow path returns `authorization` and is audited.
- S17.10 The maintenance pass calls `runRetention` on each owning module **with no mutation lock
  held**, then evicts only if that was not enough, and emits **one `info` summary per pass** rather
  than one notification per clone.
- S17.11 Store retention ends in an incremental vacuum, and the pass reports **bytes returned to the
  filesystem**, not rows deleted. A pass deleting a year of expired tokens reports a non-zero
  figure.
- S17.12 At the refuse watermark, an operation needing space returns `precondition` naming which of
  the five consumers holds the volume, the store broken down by table, and the declarations blocking
  eviction.
- S17.13 Eviction refuses while a declaration's active-operation count is non-zero, and never runs
  under the mutation lock.
- S17.14 **No clone holding uncommitted or unpushed work is evicted at any pressure**, asserted with
  the volume at 100 %.

Out of scope: a declaration-drop directory for onboarding — declaration management is console-only
and structurally so; a second notification transport.

---

## S18 — The console is complete, and federated login works

Delivers: the repository dimension across every view, the three remaining operator views, and OIDC
against a real issuer.

Touches: Surfaces (L5), Operator identity (L4 — OIDC), Audit (L1 — query), Journal (L1 — parked).

Depends on: S17. **Gated on U4.**

Acceptance:
- S18.1 The route table is written into `20-contract.md` before any route is implemented.
- S18.2 Every view takes a repository, and the landing view lists declarations with clone state,
  current branch, dirty flag and last operation. Selecting one sets the dimension for every
  subsequent view.
- S18.3 The audit view filters by declaration, tool, actor and window, and shows chain state inline:
  verified through which sequence, which anchors cover aged-out segments, and where a break sits.
- S18.4 The health view surfaces failed outbox rows and failing credential references, and clearing
  a failing reference works from it.
- S18.5 The parked-operations view shows `preState`, the observed state and the diff, and drives the
  repair session from S8.
- S18.6 OIDC against a real issuer authenticates the operator; a returned subject off the allowlist
  is refused. **With the issuer unreachable, local password plus TOTP still works.**
- S18.7 Every view is driven end to end in a real browser against a real repository —
  definition-of-done item 19, which the prior art records as the only way two genuine bugs were
  found.
- S18.8 An operator whose `totp_reenrol_required` is set re-enrols TOTP from the console, the flag
  clears, and an `identity-event` record carrying `'totp-reenrolled'` is written. The signature is
  added to `20-contract.md` first, since none exists. S4 only ever sets the flag, so before this
  criterion the enum member is unreachable and the flag is write-only for the life of the
  credential — a recovery code burned once leaves the operator permanently marked and no route back.

Out of scope: consumer views (S19); restyling.

---

## S19 — A consumer can extend the console

Delivers: the base's console published as a versioned package, a derived build that consumes it, and
a console fingerprint verified at startup.

Touches: Surfaces (L5), Lifecycle (L1 — boot step 2), build tooling.

Depends on: S18. **Gated on U7.**

Acceptance:
- S19.1 The element type and build entry are fixed in `20-contract.md` before the package is
  published.
- S19.2 A derived image's build produces a bundle whose asset manifest hashes into a console
  fingerprint distinct from the contract fingerprint. Both are reported by the version endpoint.
- S19.3 A runtime-swapped bundle makes boot exit with `console-manifest-mismatch` — the same shape
  as a registry mismatch.
- S19.4 A registered view declares its capabilities and receives the selected declaration. It
  renders for a declaration whose grant contains them and is **absent** for one whose grant does
  not.
- S19.5 No registered view names a declaration it belongs to — asserted by the absence of any such
  field in `ConsoleViewRegistration`.

Out of scope: the blog consumer's own views (S20).

---

## S20 — `SubZeroDev.Blog` runs as a consumer, with parity measured

Delivers: definition-of-done items 3 and 17. The blog's sixteen authoring tools stay its own domain
code; the runtime, the contract and every repository-generic git operation come from here.

Touches: the derived image, the blog repository's own tools, parity fixtures.

Depends on: S19.

Acceptance:
- S20.1 The blog's authoring tools compile into the derived image's registry alongside the base's,
  under one fingerprint.
- S20.2 Tool metadata is compared against captured fixtures **per capability profile**, and the
  comparison reports zero differences. "No loss of capability" is measured, not asserted.
- S20.3 Every generic tool carries an operation-descriptive name and no `blog_` prefix, and the blog
  migrates to the new names in the same cutover — no aliases, no deprecation window.
- S20.4 The blog's content capabilities appear under the `content.*` prefix and are absent from
  every other declaration's grant.
- S20.5 The blog's authoring views render for the blog declaration and are absent for every other
  one.
- S20.6 The blog's content drop dispatches its own authoring tool, which decides the repository path
  from the file's front matter. The watcher chooses no path.

Out of scope: changing blog domain behaviour. This is a migration, and any behaviour change makes
the parity comparison meaningless.

---

## S21 — A second repository, driven end to end, unwatched

Delivers: definition-of-done items 4 and 13. Generalisation is the justification for the whole
project, and one consumer is not evidence of it.

Touches: nothing new — this is a proof, not a build.

Depends on: S20.

Acceptance:
- S21.1 A repository outside the `SubZeroDev.*` estate is declared and driven through a full change:
  branch, edit, commit, push, pull request, merged.
- S21.2 An agent completes that change **without a human touching git and without supervision**.
- S21.3 Every terminal state is reached at least once without intervention, and each stops safely
  and says so: merge conflict, failed required check, wait timeout, and a restart mid-operation.
- S21.4 A `generic`-host declaration performs local git and push, and its `host.*` tools are
  **absent from the listing** rather than failing at call time.
- S21.5 A new repository is onboarded by declaration alone — no code change, no rebuild, no restart
  — while the instance continues serving every other repository. Other repositories' operations are
  timed across the onboarding to prove they were not blocked.

Out of scope: adding a tool to make the second repository easier. If it needs one, that is a contract
amendment and evidence of a gap in the generalisation.

---

## S22 — The deployment is verifiable, reversible and documented

Delivers: definition-of-done items 15, 18 and 20.

Touches: the companion check script, operator documentation.

Depends on: S21.

Acceptance:
- S22.1 The companion check polls `/healthz` until the commit SHA is stable, then runs a real
  `initialize → tools/list → repo_status` session, classifying its outcome as `stale-runtime`,
  `mixed-runtime`, `verification-credential`, `unexpected-profile-or-catalog` or `verified`. It is
  **an executable check shipped alongside the service, not a registry tool** — asserted by its
  absence from the registry.
- S22.2 Each of the five classifications is produced at least once against a deliberately broken
  deployment. A check that has only ever returned `verified` is not known to classify anything.
- S22.3 Returning `SubZeroDev.Blog` to its current server is documented **and has been done once**,
  with the pre-migration store copy as the rollback target.
- S22.4 Operator documentation covers configuration, onboarding a repository, backup and recovery,
  revocation and rollback.
- S22.5 The volume-loss table is restated in the operator documentation as an accepted risk with its
  costs, because no off-volume backup ships.

Out of scope: an off-volume audit sink. Deferred by decision; reopening it is a brief change, not a
slice.
