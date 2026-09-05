# Contract — SubZeroDev.Git

Derived from `10-design.md`. Where this document fixes something the design left to the contract,
the choice is logged in `90-decisions.md` on the same date.

The language is **TypeScript**, targeting Node with ESM. That follows from the brief: MCP
TypeScript SDK v2 pinned, and a prior art that is TypeScript throughout. Declarations here are
types and signatures only.

Two conventions carry the whole document and are stated once.

**Nominal strings.** Every constrained string is a branded type, so a raw `string` never reaches a
field that has an invariant. A brand's constructor is the only way to make one, and the
constructor is where the invariant is checked. `HttpsUrl` is the one deliberate exception, for the
reasons given under *Identifiers and constrained strings*. Declared in `src/shared/brands.ts`; the
two lines below are repeated as the notation the rest of this document is written in.

```ts
declare const BRAND: unique symbol;
type Brand<T, B extends string> = T & { readonly [BRAND]: B };
```

**Typed failure, not thrown failure.** L2 domain functions return `ToolResult`, per the design.
Every other module returns `Outcome<T, E>` with an enumerated `E`. Nothing in this contract
throws as a control-flow mechanism, and no function returns a bare `Error` or a string. Declared
in `src/shared/outcome.ts`, and likewise repeated below as notation.

```ts
type Outcome<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

`null` is used for "absent" everywhere a value is persisted or crosses a module boundary. Optional
members (`?`) appear only in `ToolResult`, whose shape the design fixes verbatim.

---

## Types

### Identifiers and constrained strings

Declared in `src/shared/brands.ts`, along with `Brand` itself, every constructor named below, and
the `ValidationFailure` a failed construction returns.

A brand is a claim that a value has already been checked. The declaration cannot say what was
checked, or by whom, and that is the only part worth writing down:

| Brand | Invariant | Checked by |
|---|---|---|
| `DeclarationId` | `^[a-z0-9][a-z0-9-]{0,62}$` | `declarationId()` |
| `Generation` | integer, `>= 1` | `generation()` |
| `GrantEpoch` | integer, `>= 0` | `grantEpoch()` |
| `CredentialRef` | `^[a-z0-9][a-z0-9._-]{0,63}$` | `credentialRef()` |
| `RegistryToolName` | `^[a-z][a-z0-9_]{0,63}$`, no `blog_` prefix on a base tool | compiler (**B7**) |
| `IsoUtcTimestamp` | RFC 3339, `Z` suffix, millisecond precision | `isoUtcTimestamp()` |
| `Sha256Hex` | `^[0-9a-f]{64}$` | `sha256Hex()` |
| `GitSha` | `^[0-9a-f]{40}$` | `gitSha()` |
| `RepoRelativePath` | non-empty, no leading `/`, no `..` segment, no `;`, not `.`, `-A` or `--all` | `repoRelativePath()` |
| `PathPrefix` | a `RepoRelativePath`; any valid one reads as both a directory prefix and a single file | `pathPrefix()` |
| `WatchedFileName` | non-empty basename, no separator, not `.` or `..` | `watchedFileName()` |
| `CloneUrl` | parses as an https or scp-style remote, and its host is on the deployment allowlist | `cloneUrl()` |
| `McpResourceUri` | `/mcp/{DeclarationId}` | `mcpResourceUri()` |
| `BranchName` | a ref name git will not read as an option — see the defect note below | **nothing — see below** |
| `SaltedHash` | opaque, and never equal to the value it hashes | authorization, operator identity |

`cloneUrlHost()` is exported beside `cloneUrl()` because a clone URL's host is checked twice against
two different lists — the deployment allowlist here, and the credential reference's own allowed-host
list in remote operations. There is one host-reading function so the two guards cannot come to
disagree about what the host *is*.

Every remaining brand — `OperationId`, `SessionId`, `ClientId`, `GrantId`, `TokenId`, `OutboxRowId`,
`ScheduledJobId`, `ModuleTargetName`, `HttpOperationName`, `ConsoleViewId`, `Subject`, `ClonePath`,
`RemoteHost`, `BearerToken`, `EnvVarName` — carries no format rule. Each is minted by `randomUUID()`
or read back from the row it was stored in, and the brand exists only so one identifier cannot be
passed where another is meant. A constructor for these would have nothing to check.

**`HttpsUrl` is constructed by cast, and that is the contract's position rather than an oversight**
(amended 2026-08-20; see `design/90-decisions.md`). It has no constructor. Its five production sites
divide into two kinds and neither is improved by one: the deployment webhook is checked for an
`https://` scheme at load and the process exits fatally if it is not, and the OIDC authorize URL is
built from a `URL` object and is well-formed by construction. The remaining three are values GitHub's
API reported — a pull request URL, a check's details URL — which the service echoes and displays but
never executes. A constructor there would restate a claim the upstream already made, and would have
no safe branch to take when it failed. **E5** is unaffected: it constrains *when* a published URL may
be returned in a success position, not whether the string parses.

**`BranchName` has no constructor and should have one.** This is a defect in the tree, not in the
contract. The gap matters because a branch name is not merely displayed — it reaches a git argument
vector directly, and `RepositoryConfig.baseBranch` is read from the managed repository's own config
file, which this service explicitly does not own. Argument vectors prevent shell injection but not
git's own option parsing: a value beginning with `-` is read by git as a flag rather than a ref.
Sites that interpolate into `refs/heads/${branch}` are incidentally safe; a bare positional is not.
`branchName()` must therefore reject any value git would not accept as a ref name, and must reject a
leading `-` whether or not git would. Until it exists, no caller may assume a `BranchName` has been
checked.

```ts
interface ValidationFailure {
  readonly field: string;
  readonly rule: string;
  readonly received: string;
}
```

`ValidationFailure` stays written out here because it is the one shape a caller pattern-matches on
across every module boundary that constructs a brand, and its three fields are a promise about
diagnosis: which field, which rule, and the value as received — never a rendered message, so the
surface that reports it decides the wording.

### JSON

Declared in `src/contract/json.ts`.

`JsonValue` is the wire type: what crosses a surface boundary, what a tool schema describes, and
what a persisted blob holds. `JsonSchema` is branded rather than a bare `JsonObject` because the
brand records that the compiler accepted the object *as a schema* — it stops an arbitrary object
being passed where a validated schema is meant. Canonical serialisation of these values is the
compiler's, and it is load-bearing twice over: the registry fingerprint and the audit record hash
are both taken over it, so a change to canonicalisation changes both (see **S1**, **B3**).

### Capabilities and the lattice

Declared in `src/contract/capabilities.ts`.

Five branded capability sets exist so the lattice layers cannot be substituted for one another. They
are the same underlying set type, and the brands are the only thing preventing a ceiling from being
passed where an effective grant is expected — the mistake would otherwise typecheck and silently
widen authority. The intersection rule itself is **A1**: an effective set is a subset of
`contract ∩ ceiling ∩ session`, and of the declaration grant for every capability whose scope is
`declaration`. No code path adds a member at runtime.

`ContentCapability` is an open template type rather than an enumeration because content families are
named by the consumer's own declarations, not by this service. It is the one capability class this
document cannot enumerate, and that openness is deliberate — it is also why `capabilityScopeOf` must
be total over `CapabilityName` rather than a lookup table that could miss a case.

**Openness is bounded at the tail, not at the head.** A content capability's *family* is the
consumer's to name; its final segment is not, and must be `read` or `write`. The constraint is not
decoration: it is the only thing that lets a rule decide, for a name this document has never seen,
which coarse scope reaches it — see `### Scopes` below, and **A10**. Without it an open capability
class is unreachable from any scope-bearing surface by construction, which is not a restriction
anyone chose but the absence of a decision, and it fails silently: the tool compiles, the ceiling
admits it, the declaration grants it, and the `mcp` and `operator-api` surfaces still cannot see it.
The console, scheduler and watcher can, because those three build a grant from the contract set
directly and never pass through a scope — which is why the gap survived review and needed a
measurement to surface.

The tail rule is **already load-bearing and was so before it was written down**. `compiler.ts`'s
`isReadCapability` decides read-ness by that same suffix, and `annotation-contradiction` rejects a
`read` execution class declaring a capability that fails it. Fixing the rule here does not impose a
convention on consumers; it states one the compiler has been enforcing against for a class it could
not name, and makes the type carry what a predicate was inferring.

It is enforced at two points, and neither is sufficient alone. `ContentCapability`'s own declaration
constrains the tail, so a malformed name written as a literal — which is how every tool declaration
in this repository and in a consumer package is authored — fails to typecheck. A name that reached
the declaration array as a widened `string` typechecks anyway, and is caught at compile time by
`capability-unscopable` (see `### Compiler` under *Error semantics*). The type is the cheap check and
the compiler is the total one.

The rule binds the tail only. `content.post.read` and `content.gitUtility.write` are well-formed
however deep the family goes, and nothing constrains what sits between the prefix and the tail. A
family needing neither a read nor a write — an escape hatch, a scheduled hold — is not expressed as
a content capability at all: `git.raw` and `scheduler.manage` already exist for exactly those, and
inventing a third tail would put a second escape hatch outside **A6**'s default-deny.

`capabilityScopeOf` decides which of the two enforcement paths a capability takes: declaration-scoped
capabilities are additionally checked against the declaration's own grant, instance-scoped ones are
not, because no declaration grants them. `hostSupportedCapabilities` carries **A5** — every `host.*`
capability is present for `'github'` and absent for `'generic'`, so a generic-host declaration cannot
hold one however it was written.

### Scopes

Declared in `src/contract/capabilities.ts`. `OperatorScope` is an alias of `McpScope`, not a parallel
vocabulary — adding a value to one adds it to both, which is the intended coupling rather than an
accident to be refactored apart.

**U2, resolved 2026-08-09 by S13.** `OperatorScope` carries the same four values as `McpScope` —
`read`, `write`, `raw`, `schedule` — gating the same declaration-scoped capability classes an
`operator-api` grant reaches through the HTTP API's route (which carries the repository) rather
than through a resource indicator. The four instance-level capabilities (`declaration.manage`,
`auth.manage`, `audit.read`, `attention.resolve`) stay reachable only from the console, per their
existing "console-only" language above — no `OperatorScope` value names them, and no operator-api
token can exercise them. See `design/90-decisions.md`, 2026-08-09.

**A scope expands to capabilities by a total rule, not by a lookup table.** `expandScopes`
(`src/authorization/authorization.ts`) is the single place a granted scope becomes a capability set,
and it is the only scope enforcement that exists in the tree: `ToolDeclaration.scopes` is
canonicalised into the fingerprint and published in `SanitisedManifest`, and `dispatch-pipeline.ts`
reads it nowhere. Its shape is deliberately the same two-branch shape as `capabilityScopeOf`: a
closed listed set for the nine fixed declaration-scoped literals, and a rule over the open remainder.

A scope therefore exists only at the boundary. `Session` carries a `grant` and no scopes at all, so
the conversion `expandScopes` performs at establishment is one-way and total: everything a scope is
going to mean has already been decided by the time any handler runs. Two consequences a reader may
rely on. A capability-less entry is gated by nothing at dispatch, whatever its `scopes` field says —
the file-watcher plan entry under `### Contract types (L0)` is the only such entry today, and that is
its intended reading. And `operator`, `scheduler` and `watcher` sessions are issued no scopes
whatsoever; they build a grant from the contract set directly, which is why a dispatch-time scope
check has nothing to check for three of the four profiles and was rejected rather than added. See
`design/90-decisions.md`, 2026-08-23.

The two branches cannot be collapsed into one, and the reason is worth stating because it looks like
an inconsistency. `scheduler.read` ends in `read` and belongs to the `schedule` scope, not the `read`
one — for the fixed literals the scope follows the *operation family*, which only coincides with the
tail seven times out of nine. Deriving all nine from their tails would silently move `scheduler.read`
and `scheduler.manage` into `read` and `write`, widening what a `read`-scoped token reaches. So the
nine keep the explicit mapping they already have, unchanged, and the rule applies to `content.*`
alone: the tail fixed under `### Capabilities and the lattice` selects the scope, `read` to `read`
and `write` to `write`. A content family has no operation family of its own for a table to key on,
which is precisely why a rule is the right instrument there and the wrong one for the other nine.

Consequences a reader may rely on. Every `content.*` capability in the contract set is reachable from
exactly one of the four scopes, so the `mcp` and `operator-api` surfaces see a consumer's own tools
on the same terms the console, scheduler and watcher already do. `read` and `write` stay separable
for content, so a resource owner can grant read-only access to a consumer domain — a fifth
content-shaped scope was rejected for collapsing exactly that distinction, and for keying a scope on
a capability family when the design's four are keyed on the operation. No content capability is
reachable from `raw` or `schedule`; the escape hatch and the scheduler stay gated by their own
capabilities, and a consumer cannot reach either by naming a family after one.

This resolves a gap that measurement found rather than reading did: `content.*` was admitted by the
type, by the ceiling and by a declaration's grant, and reachable from no MCP scope, so a consumer's
entire tool surface was invisible to the one client kind the brief's definition-of-done 13 requires
it for. See `design/90-decisions.md`, 2026-08-23.

### Declaration

Declared in `src/declarations/types.ts`.

A `Declaration` is the unit of authority. Everything a caller could set that widens what the service
will do lives here and nowhere else — that is **A8**, and it is re-checked at every amendment.

`Declaration.capabilityGrant` is a branded `DeclarationGrant`, while `DeclareInput` and `AmendInput`
take a plain array of declaration-scoped capabilities. The asymmetry is the point: branding happens
at the boundary, under the module's own validation, so a caller cannot hand in a set that already
claims to be a grant. For the same reason the inputs admit only `DeclarationScopedCapability` — the
four instance-scoped capabilities are unreachable from a declaration by construction, not by check.

`AmendInput.fileWatcher` is three-valued on purpose: `undefined` leaves it alone, `null` removes it,
a value sets it. `id`, `generation`, `host` and `state` are absent from `AmendInput` because the
design makes each immutable for the life of a generation — changing any of them is a new generation,
not an amendment.

`OrphanReport` enumerates what orphaning actually did, and its shape is an argument against reading
orphaning as deletion. `cloneLeftOnDisk` and `retainedJournalEntries` exist because **R7** forbids
discarding work: an orphaned declaration stops being operable, but its clone, its journal history and
its audit trail remain. A report where those fields were absent would let a caller assume a cleanup
that never happens.

### RepositoryConfig

Declared in `src/declarations/types.ts`, with `REPOSITORY_CONFIG_DEFAULTS` beside it.

This is the one configuration the service reads from *inside* the managed repository, which fixes
both its power and its limits. Every field defaults, so a declaration whose repository carries no
config file at all is fully operable. It carries no capability, scope, path prefix, credential
reference or remote — **A8**. It is re-read from the working tree on every operation that needs it
and never cached — **D3** — so a repository can change its own base branch without the service being
restarted or amended.

Because the file is repository-controlled and this service does not own repository contents, every
field here is untrusted input. `baseBranch` is typed `BranchName` in this contract and is the same
defect the brand table records: the tree currently declares it `string`, which is why its consumers
cast at each point of use, and one of those points passes it to a git argument vector as a bare
positional. The contract's typing is the correct one; the field is untrusted precisely because of
where it comes from, so it is exactly the field that should be constructed and checked rather than
asserted.

### Clone

Declared in `src/clone/types.ts`.

`CloneState` is re-derived from disk at boot and the stored value is never trusted as a source of
truth — **D1**. That is the whole reason the state is persisted at all: it is a cache for reporting,
not a fact. Three of the seven states are terminal only in the sense that something outside the clone
must act — `recovery-pending` waits on a resume step, `needs-attention` waits on an operator, and
`evicted` waits on the next materialisation. `attentionReason` is free text because it is shown to a
person and never branched on.

`safeToEvict` is deliberately absent from this type. It is derived by `CloneStore.isSafeToEvict` at
eviction time and never stored — see invariant D2.

Declared in `src/clone/types.ts`. `ObservedGitState` is `PreState` plus the moment it was observed;
the split exists because a journal entry stores the pre-state without the observation time, while a
live comparison needs to know how stale the reading is.

**U8's resolution, 2026-08-08.** `indexDigest` and `worktreeDigest` are each `SHA256_hex(canonical(entries))`,
reusing the same deep key-sorted-JSON canonicalisation U9 fixed for the audit record hash
(`shared/canonical-json.ts`), over an array of plain objects rather than the design's own prose —
array order is content under that canonicalisation, so the ordering below is part of the contract,
not an implementation detail:

- `indexDigest` covers one entry per index record, in the order `git ls-files --stage` emits them
  (lexicographic by path — deterministic across platforms because git defines it, not the OS),
  each `{ path, mode, blobId, stage }` read straight off that command's output. Never `git
  write-tree`: that command can fail on a deliberately unmerged index (a real state a mutating tool
  must still be able to capture pre-state for), and it writes a tree object to the object database,
  which pre-state capture may never do.
- `worktreeDigest` covers one entry per line of `git status --porcelain=v1`, in the order that
  command emits them, each `{ path, workingTreeStatus }` where `workingTreeStatus` is the
  porcelain line's second column (`M`, `D`, …) for a tracked path or `?` for an untracked one — "
  tracked paths differing from the index plus the untracked set", read directly off the column the
  design already names rather than re-derived by a second command.

Both commands read the index and the working tree; neither writes to the object database.

Declared in `src/clone/types.ts`, with `LockHandle` and `ActivePin` in `src/locks/types.ts`.

`SafeToEvictVerdict` carries its blockers rather than returning a bare boolean because every one of
the eight blockers names work that would be destroyed by evicting — and **R7** forbids discarding a
commit, a stash, an untracked file or an unpushed branch. The list is what lets an operator see why a
clone is holding disk rather than being told only that it is. `safeToEvict` is deliberately absent
from `Clone` itself: it is computed at eviction time and never stored — **D2** — because a stored
verdict is wrong the moment anything writes to the tree.

`corrupt-tree` is the one blocker that can be overridden, via `CorruptTreeOverride`. That asymmetry is
intentional: the other seven name recoverable work, so overriding them would destroy it, whereas a
corrupt tree names work that is already unreadable. The override is a separate type rather than a
boolean parameter so it cannot be passed positionally by mistake.

`CloneHandle` bundles the clone with the locks held over it, so the two cannot be separated by a
caller. **C3** governs how long they are held — a mutating operation holds the materialisation lock
for its whole duration, a read releases it once the clone is `ready`.

### Actors, profiles and sessions

Declared across `src/shared/actor.ts` (`ActorKind`, `ActorRef`), `src/declarations/types.ts`
(`SessionKind`, `ActorProfile`, `STRIPPED_FOR_UNATTENDED`) and `src/shared/session.ts` (`Session`).

`ActorKind` has five members and `SessionKind` four: `recovery` is an actor that never holds a
session, because a resume step runs as an ordinary dispatch under the lifecycle module's authority
rather than under anyone's grant — **R8**. Any code treating the two as the same enumeration is
wrong, and the separate declarations are what prevent it.

`Session.frozenAtEpoch` is what makes a grant a snapshot rather than a live query. It is compared
against the declaration's `grantEpoch` before every handler invocation, and a moved epoch forces a
recomputation that can only narrow — **A3** with **A2**. A session therefore cannot gain authority
between calls, only lose it.

`STRIPPED_FOR_UNATTENDED` is `.github/workflows/`, `.config/`, `tools/`, `build/`. It is the
`strippedPathPrefixes` of the `mcp`, `scheduler` and `watcher` profiles; the `operator` profile's
is empty. `repositoryBinding` is non-null for `mcp` and `watcher`, null for `operator`, and null
for `scheduler` because a scheduler session binds per job rather than per session.

Declared in `src/operator-identity/operator-identity.ts`.

An `OperatorSession` is distinct from `Session` above: this is the console's cookie-authenticated
sitting, whereas `Session` is the per-call authority snapshot. It expires two ways at once — idle and
absolute — and revocation is a written timestamp rather than a deleted row, per **S7**, so a revoked
session stays visible in the audit of what happened.

### Authorization records

Declared in `src/authorization/types.ts`. `GrantView` is additionally mirrored console-side in
`console/src/api.ts`, which is a deliberate second copy across the HTTP seam rather than a shared
import — the console must not import from L4.

`resource`, `declarationId` and `generation` are non-null exactly when `kind` is `mcp`, and null
exactly when it is `operator-api`; `clientId` is null for an `operator-api` grant. That correlation is
not expressible in the declaration and is the field discipline a reader most needs: an `mcp` grant is
bound to one repository at one generation, an `operator-api` grant is bound to neither and takes its
repository from the route instead.

**`IssuedToken` is the only value-bearing type in this contract, and nothing persists it** — **S6**.
`Token` holds a `verifierHash` and never a token value; the value is returned once, at issue, and is
irrecoverable afterwards. Revocation writes a timestamp and never deletes a row, and no cascade is
written as a batch — liveness is walked upward at check time, per **S7**. `GrantView`'s `activeTokens`
and `liveSessions` are therefore counts computed at read time, not stored columns that could disagree
with the rows they describe.

### Operation journal

Declared in `src/journal/types.ts`.

The journal is what makes recovery possible, so its ordering guarantees matter more than its shape.
`begin` commits before the first side effect, and if it fails no side effect occurs — **R1**. Every
call mutating state outside the local clone appends a step and commits it *before* the call it
describes — **R2**. Both are write-ahead rules: the record of intent always precedes the act.

`JournalStepState` admits only `applied`, because that is the only step state the design names and
the only one recovery reads. A step's **name**, rather than a second state, records how far an
operation progressed — this is U3's resolution, and `resume` predicates read `entry.tool`,
`entry.input` and `entry.preState` rather than any step state. An entry whose `steps` contains an
`applied` step never classifies as `nothing-happened` — **R5**.

`input` is scrubbed by `Exec.scrubJson` before it reaches this type, which is where **S5** is
enforced for the journal: no secret value reaches a persisted row.

`unsettled` selects on `(declarationId, generation)`, so an entry from a previous era is never a
recovery candidate — **R4**. That is why `generation` is on the entry at all.

### Recovery

Declared in `src/recovery/types.ts`, with `TerminalState` in `src/journal/types.ts`.

A `RecoveryDescriptor` is registered per tool, and the catalogue is populated by registration rather
than by import so that L1 does not depend on L2 — **B2**. `expectedPostState` is a pure predicate
over the journalled entry and a fresh observation; `resume` is `null` for an operation that cannot be
safely re-driven, and a `null` resume is what turns an ambiguous entry into `park` rather than a
retry.

The four verdicts are exhaustive and ordered by how much is known: `nothing-happened` and `completed`
are decided, `resume` is decided and actionable, `park` is the honest admission that neither could be
established. **R7** is why `park` exists at all — no recovery path may discard work, so when the
classifier cannot prove what happened it must stop rather than guess. Classification itself reads no
git state and performs no I/O, and the same arguments always yield the same verdict — **R3**.

### Scheduled jobs

Declared in `src/scheduler/types.ts`.

`frozenGrant` is the field that makes a scheduled job safe. A job carries the capability set as it
stood when the job was created, so a job cannot gain authority by sitting in the queue while a
declaration is amended. It is a `CapabilitySet` rather than a branded layer because it is not a
lattice layer — it is a captured snapshot that the dispatch intersection then treats as one more
bound.

`onMissed` has no default and is required at creation. That is a deliberate refusal to choose for the
caller: `catch_up` and `skip_if_older_than` differ in whether a late fire is better than no fire, and
that is a judgement about the operation, not about scheduling.

`ScheduledJob` carries no `operationId` — the correlation runs the other way, through
`OperationJournalEntry.scheduledJobId`, so one job can produce several journalled attempts without
the job row being rewritten. `ScheduledJobCreateInput` carries no `declarationId`: the
declaration-scoped dispatch context is the only source of that binding, so a caller cannot name a
different declaration in the payload. `ScheduledJobListInput.status` is null to list every status.
`ScheduledJobCancelInput.reason` must contain at least one non-whitespace character.
`ScheduledJob.reason` is set for `skipped`, `cancelled` and `needs-attention`, and null otherwise.

`tool` names a registry entry annotated `schedulable`, checked at creation, at fire time and at boot
re-validation — **B6**. Checking three times is not redundancy: a declaration can be amended between
any two of them. At boot, a `running` job is never simply fired again — **R10** — and
`resolveRunningAtBoot` performs no git or host I/O deciding what to do with it — **R9**.

### Audit

Declared in `src/audit/types.ts`.

`AuditRecord` is `AuditRecordBase` intersected with a discriminated `AuditRecordBody`, and
`AuditRecordForm` is that discriminant. The intersection is what makes the record flat rather than
nested, which matters because the canonical serialisation below hashes the flattened form — a nested
body would hash differently and the two representations must never both exist.

`AuditAppendInput` omits `sequence`, `previousHash` and `hash` because a caller may not supply them.
Every append passes through one writer, which assigns all three; sequence numbers are contiguous
within a segment and each record's `previousHash` equals its predecessor's `hash` — **S1**. A caller
that could set them could forge a chain.

**`Audit.append` never throws and never rejects** — **S3**. It returns `AuditAppendOutcome`, and
`appended: false` is an ordinary value, because an audit failure must not convert a successful
operation into a failed one. The single exception is the `git.raw` intent line, whose caller treats
`appended: false` as fatal to the call: **S9** requires that line to be written before the child
process starts, so if it cannot be written the process must not start.

`RetainedAnchor` is what makes retention safe. A segment is never deleted before its terminal hash is
written as an anchor — **S2** — so pruning old audit data shortens the chain without breaking the
ability to verify what remains. `AuditChainBreak` is reported and never fatal — **S4** — which is why
`AuditChainState` is a field on `HealthReport` and on every `AuditPage` rather than a boot failure:
an operator must be able to read the trail that reveals the break.

`AuditQuery.cursor` is an opaque string; a caller may compare it for equality and pass it back, and
may not parse it. `limit` has no null form because an unbounded audit query is not offered.

**Canonical serialisation (resolves U9).** `hash` is `SHA256_hex(canonical(record))`, where
`record` is the full flattened `AuditRecord` — `AuditRecordBase` merged with whichever
`AuditRecordBody` variant applies, exactly as the type appears — with its own `hash` field omitted
and every other field present, `sequence` and `previousHash` included. `SHA256_hex` hashes the
UTF-8 byte encoding of the string `canonical()` returns.

`canonical(value)` is defined operationally, over ECMAScript values, not by a named external
format:

1. If `value` is an array, map `canonical` over its elements and join with `,`, wrapped in `[` `]`.
   Element order is preserved — an array like `changedPaths` or `argv` is ordered content, not a
   set.
2. If `value` is an object, take `Object.keys(value)`, sort it with the default `Array.prototype.sort`
   comparator (each key converted to a string, compared by UTF-16 code unit), and for each key in
   that order emit `JSON.stringify(key)`, `:`, `canonical(value[key])`, joined with `,`, wrapped in
   `{` `}`.
3. Otherwise (`string`, `number`, `boolean`, `null`), emit `JSON.stringify(value)` — one JSON token,
   no added whitespace.

This is exactly `JSON.stringify` applied to `value` after every object's own keys have been
re-inserted in sorted order at every nesting level, with no `space` argument, so no whitespace is
ever inserted around a delimiter — the same algorithm `src/contract/fingerprint.ts` implements for
the compiler's registry fingerprint, restated here byte-precisely because two independent
implementations disagreeing here is exactly what U9 exists to prevent. It is a TypeScript
definition because the contract itself is: `20-contract.md`'s opening line fixes the language, and
`JSON.stringify`'s string-escaping and number formatting are themselves the specification, not a
convention layered on top of one.

The genesis record (`previousHash: null`, the first line of the first segment) hashes the same way;
`null` is step 3, like any other value, with no special case.

Every field participates in the hash except `hash` itself. Including `sequence` means a record
whose sequence number alone was edited is still caught by the hash, redundantly with invariant S1's
separate contiguity check.

File storage is a distinct concern the hash does not fix: each line is `JSON.stringify(record)` in
whatever key order, compact and one record per line, so segment-byte accounting against
`auditSegmentBytes` is exact. `verify` parses each line, re-derives the canonical form, and
re-hashes — the on-disk encoding never has to match the hashed encoding, only round-trip through
the same parser.

### File watcher

Declared in `src/watcher/types.ts`, except `WatchedFileOutcome`, which lives in `src/audit/types.ts`
because an audit record body carries it — the outcome is a thing the trail records, and the watcher is
only its producer.

`WatchedFileStage` names four directories, and the directory *is* the state: there is no separate
status column, so a crash cannot desynchronise the two. **D6** is what makes that safe — during
delivery and interrupted-claim recovery a watched file is never deleted, and every terminal path moves
it to `processed/` or `failed/`. Retention may delete only `processed/` files past their window, never
`failed/` ones. A file found in `processing/` at startup is moved to `failed/` and never reprocessed —
**D8** — because the process that claimed it cannot be asked what it managed to do.

`WatchedFileCandidate.isSymlink` exists so the candidate can be *refused* rather than silently
skipped: the stat is link-preserving, so a symlink is never a candidate — **D7**.

`FileWatcherPlanData` and `FileWatcherApplyInput` are generic in `TPlan` because the plan is the
consumer's, not this service's. The service fixes the envelope — branch, commit message, pull request,
permitted paths — and treats `plan` as opaque JSON it carries from one tool to the other without
inspecting.

`FileWatcherConfig.planTool` and `applyTool` are two registry entries that together form the one
logical target described by the design. The plan tool consumes the claimed file after strict UTF-8
decoding and returns all consumer-selected branch, commit, pull-request and path data plus an opaque
JSON plan. Its handler is pure: dispatch supplies `CallContext.cloneRoot: null`, does not materialise
a clone, and does not take either repository lock or begin a mutation journal entry. The apply tool
receives that opaque plan unchanged together with the plan's permitted paths and performs the
repository mutation.

The plan tool's output schema and the apply tool's input schema may specialise `TPlan`, but the JSON
Schemas at their respective `plan` properties must be byte-for-byte equal after compiler canonical
serialisation. Declaration creation, amendment and boot re-validation reject a pair that does not
match. `permittedPaths` is sorted and duplicate-free, every member must pass the watcher's effective
write allowlist before `applyTool` is dispatched, and `applyTool.changedPaths` is also sorted and
duplicate-free.

`permittedPaths` narrows what the apply tool may write; it never establishes it. The bound is the
declaration's own path allowlist, enforced inside the apply handler: every path the handler is about
to write passes `validateWritePath` before any side effect, exactly as `git_stage` and
`git_restore_paths` do, with `malformed` mapping to `validation` and `outside-allowlist` and
`stripped-by-profile` mapping to `authorization` and writing an audit record naming the rejected
path. A path that survives that check and is absent from `permittedPaths` is refused the same way.
Both checks are the handler's, because `applyTool` is an ordinary registry entry that any session
holding `git.local.write` and the `write` scope may dispatch directly — a bound that lives only in
the watcher is not a bound, and the allowlist is what keeps a write out of `.git/`, which
`RepoRelativePath` alone permits.

The watcher independently dispatches `repo_status` after apply: its complete changed path set must
equal `changedPaths`, and that set must be a subset of `permittedPaths`, before the watcher
dispatches `git_stage`. After staging, a second `repo_status` must report exactly the same path set
and every entry staged before commit may begin. A mismatch is a failed watched file, never a partial
success; no later git or host step is dispatched.

### Instance lease

Declared in `src/lifecycle/lease.ts`.

Written once at acquisition and never refreshed. Exclusion is the OS lock; the contents only name
the holder.

**The lock and the contents are two files**, not one. The runtime has no `flock` binding, so the
advisory lock is carried by a dedicated file that exists only to be locked, and `InstanceLease` is
written beside it while that lock is held. A reader that finds the JSON has learned who *claims*
the volume; only the lock decides who holds it. That split is why a lease file left by a dead
instance is a takeover to be reported rather than a refusal — see the boot path in `10-design.md`.

### The result envelope

Declared across `src/shared/result-kind.ts` (`ResultKind`, `Finding`, `isError`) and
`src/result/envelope.ts` (`Diagnostics`, `ToolResult`, `ReadStamp`, and the eight constructors).
The split is a layering one: `ResultKind` is named by modules that must not depend on the envelope,
so the kind lives lower than the type that carries it.

`ToolResult` is the one type in this contract whose optional members are `?` rather than `| null`,
because the design fixes its shape verbatim as the wire form an MCP client receives. Everything else
uses `null` for "absent".

**`ok` and `kind` are not independent**: `result.ok === (result.kind === 'success')` — **E1**. They
both exist because `ok` is what a client branches on and `kind` is what it reports, and the invariant
is what stops them drifting apart.

**`isError` is true exactly for `upstream`, `timeout` and `infrastructure`** — **E2** — and false for
the other five. The division is not severity but *attribution*: the five non-error kinds say the call
was understood and refused, the three error kinds say the service or something upstream of it failed.
A client may retry the second group and must not blindly retry the first.

The eight constructors exist so that no call site assembles an envelope by hand — each fixes the
`kind`/`ok` pairing and the shape of what accompanies it, which is what makes **E1** and **E2**
structural rather than a rule to be remembered. `conflict` takes the lock holder, `authorization` the
missing capabilities, `upstream` a retry hint, `timeout` the limit that was hit: the accompanying data
is the part a caller needs to act, and a bare summary string would lose it.

Every read operation's `TData` includes a `ReadStamp`, and its `mutationInFlight` is scoped to the
declaration being read rather than to the process-wide mutex — **E4**. A reader of one repository must
not be told a mutation is in flight because an unrelated repository is being written.

### Notification

Declared in `src/journal/types.ts` (`NotificationSeverity`, `TerminalState`, `MaintenanceSummary`,
`NotificationRequest`) and `src/notifier/types.ts` (`OutboxRowStatus`, `OutboxRow`, `DeliveryReport`),
with `RetentionReport` in `src/shared/retention.ts`.

The split follows the transaction boundary rather than the subject matter. A `NotificationRequest` is
written *with* the state change it describes, in one transaction — **R6** — so it belongs to the
journal; the outbox row is what the notifier later delivers, and delivery is a separate concern that
must never be able to fail the operation.

Every `TerminalState` is `attention` severity; `MaintenanceSummary` is `info`, one per pass rather
than one per clone. `TerminalState` is the closed set of ways an operation can end with nothing
further the service can do on its own — each variant names what a person would need to know to unblock
it, which is why each carries its own identifying detail rather than a shared free-text reason.

**`in-flight` is a claim, not a report of progress.** A delivery pass is `SELECT` → send → write back,
and the send is the slow part, so a row stays `pending` on disk for the whole webhook round trip. Two
passes overlapping in that window both select it and both send it. `Notifier` already serialises its
own passes in-process, which closes that window — but only while exactly one process owns the volume.
That is the instance lease's guarantee (S2), and it is the *only* thing standing between a
misconfiguration and an operator paged twice for the same merge conflict. A pass therefore also moves
each row `pending` → `in-flight` with a compare-and-set before sending, and sends only the rows whose
set it won. Losing the set means another pass owns the row; the loser skips it silently and counts
nothing, because the winner will count it.

The two mechanisms answer different questions and both are kept deliberately. In-process serialisation
stops a redundant pass from starting at all, which is the ordinary case and costs nothing; the claim
is what makes correctness independent of the lease holding, which is the case nobody notices until it
has already happened. **The claim is the correctness boundary; serialisation is an optimisation in
front of it.**

The claim is durable, so a process that dies mid-send leaves the row `in-flight` rather than `pending`,
and nothing can distinguish that from a live claim by inspection. `redriveUndelivered` therefore sweeps
`in-flight` back to `pending` before it selects — boot is the one moment at which no pass of this
instance can be running, which is what makes the sweep safe there and unsafe anywhere else. The sweep
itself is the one part that still rests on the lease: a second live instance would sweep rows the first
is still sending.

**`DeliveryReport.errors` is where three of the four `NotifierError` variants become reachable.**
`deliverPending` and `redriveUndelivered` return a report rather than an `Outcome`, because one row
failing must not fail the pass — the other rows still have to be attempted. Without `errors` that
leaves `no-transport-configured`, `delivery-failed` and `retries-exhausted` with nowhere to surface,
and a variant nothing can construct constrains nothing. It carries them **as data, not as a thrown
failure**, which preserves the rule that delivery never blocks the operation it describes: a caller
that ignores `errors` behaves exactly as before.

Reporting, not raising, is also what the error table already asks for. `delivery-failed` says the
caller does "nothing"; `retries-exhausted` says "mark the row `failed` and surface it, never drop
it". Both are descriptions of a pass that continues, which is what a report is.

### Volume, retention and maintenance

Declared across `src/store/volume-usage.ts` (`VolumeConsumer`, `VolumeUsage`),
`src/store/structured-store.ts` (`StoreTableName`), `src/shared/retention.ts` (`MaintenanceReason`,
`RetentionReport`) and `src/lifecycle/boot.ts` (`MaintenanceReport`).

`VolumeConsumer` and `StoreTableName` are closed sets so that usage accounting is total: every byte on
the volume is attributed to exactly one consumer, and adding a table without adding it here is a
compile error rather than a silent gap in the report. That is the point of enumerating them.

`RetentionReport.skipped` carries *why* rows survived a pass, and it exists because a retention pass
that deletes nothing is indistinguishable from one that failed unless it says what it declined to
touch. Store retention ends in an incremental vacuum, and the pass reports bytes returned to the
filesystem rather than rows deleted — **D4** — because rows deleted is not what an operator watching a
full volume needs to know. Every automatically-pruning window has exactly one owning module, and the
lifecycle module calls each with no mutation lock held — **D5**.

`MaintenanceReport` carries usage before and after so a pass's effect is legible without a second
query, and `evictions` are `EvictionOutcome`s rather than a count — an eviction that was refused, and
what blocked it, is the part worth reading.

### Deployment configuration

These stay written out rather than becoming pointers, because **there is no `DeploymentConfig` in the
tree to point at**. No composition root assembles one yet; each module instead carries a local,
overridable default citing this section by name — `src/journal/journal.ts`'s `journalSettledDays`,
`src/notifier/notifier.ts`'s `outboxDeliveredDays`, `src/scheduler/scheduler.ts`'s `terminalJobDays`,
and the `remoteHostAllowlist`, `ceiling`, `admission` and `notifierWebhook` values read from the
environment in `src/composition-root/compose.ts`. This is the "entity with no code representation" case, and the
scaffold below is the only statement of the shape those defaults are converging on. When a real
`DeploymentConfig` is wired, this block becomes a pointer and the local defaults stop being local.

Two members have since acquired real declarations, and **those are the canonical copies**:
`DiskWatermarks` in `src/store/volume-usage.ts` and `AdmissionLimits` in `src/locks/types.ts`. They
are still written out below because this block is what the tree's own `DeploymentConfig.*` doc
comments cite as the naming authority, and splitting two members out would break the single place
the family can be read as one converging shape. Both declarations cite this section back, so the
duplication is checkable in either direction rather than silent. Change them together.
```ts
interface RetentionWindows {
  readonly auditSegmentBytes: number;
  readonly auditDays: number;
  readonly journalSettledDays: number;
  readonly outboxDeliveredDays: number;
  readonly preMigrationBackupsRetained: number;
  readonly storeSnapshotsRetained: number;
  readonly operatorSessionDays: number;
  readonly processedFileDays: number;
  readonly tokenDays: number;
  readonly revokedGrantDays: number;
  readonly terminalJobDays: number;
}

interface DiskWatermarks {
  readonly maintenanceAtPercent: number;
  readonly refuseAtPercent: number;
}

interface TimeoutBudget {
  readonly cloneSeconds: number;
  readonly fetchSeconds: number;
  readonly pushSeconds: number;
  readonly hatchSeconds: number;
  readonly monitoringWaitCapSeconds: number;
  readonly mutationLockAcquireMs: number;
  readonly materialisationLockAcquireMs: number;
}

interface AdmissionLimits {
  readonly mutationQueueDepth: number;
  readonly concurrentWaitsPerSession: number;
  readonly concurrentLockFreeOperations: number;
}

interface WatcherConfig {
  readonly enabled: boolean;
  readonly pollIntervalSeconds: number;
}

/** The three durable-credential lifetimes `authorization.ts` mints. Joined 2026-08-13 — previously two were hardcoded constants with no override, and the third had only a code comment. */
interface TokenLifetimes {
  readonly mcpAccessSeconds: number;
  readonly mcpRefreshSeconds: number;
  readonly operatorApiSeconds: number;
}

interface DeploymentConfig {
  readonly ceiling: DeploymentCeiling;
  readonly remoteHostAllowlist: readonly RemoteHost[];
  readonly remoteOperationsPermitted: boolean;
  readonly watcher: WatcherConfig;
  readonly retention: RetentionWindows;
  readonly watermarks: DiskWatermarks;
  readonly timeouts: TimeoutBudget;
  readonly admission: AdmissionLimits;
  readonly tokens: TokenLifetimes;
  readonly notifierIntervalSeconds: number;
  readonly maintenanceIntervalSeconds: number;
  readonly notifierWebhook: HttpsUrl | null;
  readonly oidcIssuer: HttpsUrl | null;
  readonly oidcSubjectAllowlist: readonly Subject[];
  /** S31 — the client identity every OIDC authorization request carries. `null` until configured, the same direction as `oidcIssuer`. */
  readonly oidcClientId: string | null;
  /** S31 — `null` for a public client (no secret, e.g. PKCE); set for a confidential client. */
  readonly oidcClientSecret: string | null;
  readonly sessionIdleSeconds: number;
  readonly sessionAbsoluteSeconds: number;
}
```

Defaults the design fixes: `auditSegmentBytes` 67108864, `auditDays` 90, `journalSettledDays` 30,
`outboxDeliveredDays` 14, `preMigrationBackupsRetained` 3, `storeSnapshotsRetained` 7,
`operatorSessionDays` 7, `processedFileDays` 14, `tokenDays` 7, `revokedGrantDays` 180,
`terminalJobDays` 30, `maintenanceAtPercent` 85, `refuseAtPercent` 95, `cloneSeconds` 300,
`fetchSeconds` 300, `pushSeconds` 300, `hatchSeconds` 60, `monitoringWaitCapSeconds` 1800,
`mutationLockAcquireMs` 30000, `materialisationLockAcquireMs` 30000, `mutationQueueDepth` 32,
`concurrentWaitsPerSession` 4, `concurrentLockFreeOperations` 16, `pollIntervalSeconds` 15,
`watcher.enabled` false, `remoteOperationsPermitted` false, `sessionIdleSeconds` 3600,
`sessionAbsoluteSeconds` 43200, `mcpAccessSeconds` 3600, `mcpRefreshSeconds` 2592000 (30 days),
`operatorApiSeconds` 31536000 (365 days), `notifierIntervalSeconds` 30 and
`maintenanceIntervalSeconds` 86400. Configuration-backed values stay deployment-overridable; these
are the values the service uses when it is not told otherwise. The session bounds are additionally
bounded by `operatorSessionDays`, which retention fixes at 7.

Notifier delivery makes at most five attempts. Each attempt has a 10-second timeout. After failed
attempt number `n`, counted from one, the delay before another attempt is
`min(1000 * 2 ** n, 30000)` milliseconds; five attempts therefore wait 2000, 4000, 8000 and 16000 ms.
There is no global default `maxResultBytes`: every `ToolDeclaration` must carry an explicit positive
limit, so adding a tool can never silently inherit a result-size budget.

### Contract types (L0)

Declared in `src/contract/tool-declaration.ts`.

This is L0, the layer the whole authority model rests on: a `ToolDeclaration` is the *only* place a
tool's capabilities, scopes and limits are stated, and the compiled registry is what a deployment
executes. Nothing at runtime may add to it — **A1** — so a capability absent here is unreachable.

`CompiledRegistry.fingerprint` is verified at boot alongside the console asset manifest, and a
mismatch refuses to start — **B3**. That is what makes the registry a released artifact rather than
something assembled per process. Every entry has exactly one executor registered for its
`ExecutionTarget`, also verified at boot — **B5** — so a declaration cannot name a target nothing
implements. The compiler itself is absent from the runtime image — **B8**.

`SanitisedManifest` is the *outward* view and deliberately carries less than `CompiledRegistry`: names,
capabilities, scopes and execution class, with no schemas, limits or targets. It exists so a client can
be told what a deployment offers without being told how it dispatches.

`ExecutionTarget` is a discriminated union rather than a string because the two kinds are dispatched by
different adapters at different layers, and collapsing them to a name would put the routing decision in
a string comparison at the call site.

`ToolLimits.maxResultBytes` has no default anywhere in the system — every declaration must carry an
explicit positive limit, so adding a tool can never silently inherit a result-size budget.
`ToolAnnotations.untrustedOutput` marks a tool returning author-controlled text; `schedulable` is what
**B6** checks a scheduled job's tool against; `fileWatcher` carries the phase, and a plan entry's
no-clone dispatch behaviour follows from that annotation rather than from its target name.

A file-watcher plan entry has a `module` target, `executionClass: 'read'`, no capabilities,
`scopes: ['write']`, `capabilityScope: 'declaration'`, and annotations `{ schedulable: false,
fileWatcher: 'plan', untrustedOutput: true }`. An apply entry has a `module` target,
`executionClass: 'mutating'`, includes `git.local.write`, has `scopes: ['write']`,
`capabilityScope: 'declaration'`, and annotations `{ schedulable: false, fileWatcher: 'apply',
untrustedOutput: true }`. `false` preserves the ordinary-tool annotation used by the base registry.
The compiler rejects every other combination; a plan entry's special no-clone dispatch behaviour
follows from the phase annotation rather than from its target name.

Both entries are `capabilityScope: 'declaration'` because a watched file always belongs to one
declared repository. The plan entry states it explicitly rather than deriving it, since it carries
no capabilities for `capability-scope-mismatch` to check it against. That empty capability array is
deliberate — a pure parse of an already-claimed file reaches nothing a capability guards — and it
means **the plan entry is gated by nothing at dispatch**, which is the intended reading and not an
omission. `scopes: ['write']` is a compile-time shape the compiler enforces and `SanitisedManifest`
publishes; it is not a runtime gate, because `Session` carries no scopes for dispatch to compare it
against (`### Scopes` above). An earlier draft of this paragraph called the `write` scope "the plan
tool's only gate", which was never true of the tree; it is withdrawn. See `design/90-decisions.md`,
2026-08-23. The apply tool is where the repository bound sits, and it enforces its own, per D14.

`untrustedOutput` is the annotation the prior art puts on a tool returning author-controlled text.

### Tool registry extension (L0/L1, published build entry)

The tool half of the consumer-extension seam (`design/10-design.md` § *Where consumer extension
attaches*), fixed by S35 as the console half's counterpart, mirroring § *Console view
registration*'s shape rather than inventing a second one.

Published from `src/composition-root/compose.ts`, exporting `composeAndStart(options?:
ComposeOptions)`. `src/server.ts` is the base's own consumption of this entry — it calls
`composeAndStart()` with no options — the same relationship `console/src/main.tsx` has to
`createConsole()`. A consumer's own composition root imports `composeAndStart` directly and
supplies its own `ComposeOptions`; it does not go through `src/server.ts`.

```ts
export interface ComposeOptions {
  readonly buildDir?: string;
  readonly consoleDir?: string;
  readonly extraToolDeclarations?: readonly ToolDeclaration[];
  readonly extraModuleHandlers?: readonly { readonly target: ModuleTargetName; readonly handler: ModuleHandler }[];
  readonly extraRecoveryDescriptors?: readonly RecoveryDescriptor[];
}
```

`extraToolDeclarations` is unioned with `PRODUCTION_TOOL_DECLARATIONS` before compilation — there
is no field for removing or replacing a base declaration, which is what keeps the base's own set
unchanged by any extension. A consumer's own `build-registry`-equivalent script compiles that
union through the same `compiler` the base's `scripts/build-registry.ts` uses (imported at build
time only — **B8** holds across the extension, since `compose.ts` itself never imports the
compiler, only the already-compiled artifact its `buildDir` option points at) and emits its own
`registry.json`/`registry.json.sha256` under a `buildDir` distinct from the base's own — so a
derived image reports one registry fingerprint covering both sets, and that fingerprint differs
from the base image's own (S35.3) unless the consumer added nothing.

`extraModuleHandlers` and `extraRecoveryDescriptors` are registered into the module adapter and
the recovery catalogue *after* every base registration, so a target or tool name colliding with a
base one is refused by the same fatal `duplicate-registration` a base-internal collision already
is, rather than silently shadowing it.

`consoleDir` lets a consumer's own console build (built against the published
`@subzerodev-git/console` package, per § *Console view registration*) sit at a different path than
the base's `console/dist`; `buildDir` does the same for the registry artifact. Both default to the
base's own layout, which is what `src/server.ts`'s no-options call relies on.

### Console view registration (L5, published package)

Declared in `console/src/view-registry.ts`, exported from the package's build entry
(`console/src/index.ts`). `TElement` is fixed to React's `ReactElement`, resolving U7's remaining
question — S18 already fixed the framework binding, so the design's own generic closes to the one
type React's `render` can return. `ConsoleViewId` and `CapabilityName` are plain `string` on this
side of the seam, the same JSON-shaped-not-branded convention every other console-side type already
follows (`console/src/api.ts`'s `DeclarationListRow`).

A view declares the capabilities it needs and receives the selected declaration. It never names a
declaration it belongs to — `console/src/view-registry.ts`'s `ConsoleViewRegistration` carries no
such field, and `console/src/view-registry.test.ts` asserts it via `satisfies`.

The build entry also exports `eligibleViews(views, capabilityGrant)`, the pure filter a consumer's
own shell (or the base console's `Landing`) applies to decide which registered views to offer for
the selected declaration — a view is eligible when the grant passed in contains every capability it
declares.

---

## Persisted schemas

Three storage kinds, per the design. Only the structured store has a schema; the audit log is JSONL
holding one `AuditRecord` per line, and the working clones are directories.

**This section is source, not description, and is the one place in this document where shape stays
deliberately.** `scripts/generate-migration-0001.ts` reads the markdown between the
*Persisted schemas* and *Public signatures* headings, extracts the `sql` blocks below in order,
and renders `src/store/migration-0001.ts` from them; `npm run check:migration` verifies in CI that
the committed migration still matches this text verbatim. The heading names, the block count and the
block contents are therefore load-bearing — replacing these blocks with a pointer to the migration
would invert the dependency and break the check. The generator runs by hand rather than in the
build, because migration 0001 is immutable once released: its checksum is recorded in
`schema_migration`, so regenerating it against an amended contract would silently change a released
migration.

**The *Public signatures* heading deliberately retains the older kit name.** `.claude/commands/contract.md` now calls this document's third section *Public surface*. Renaming it here would break the extraction above, because the generator locates this section's end by that literal string and `npm run check:migration` gates the build on the result; the rename would also have to churn the toolchain around a released, checksummed migration to buy nothing. The divergence from the kit is known and retained, not an oversight — a kit sync must not silently correct it. Prose in this section refers to both headings in italics and never with their `#` markers, because the generator's search would match the mention rather than the heading and silently truncate the extracted region. See `design/90-decisions.md`, 2026-08-20.

**The migration story, stated once because it is the same for every table.** Migrations are
explicit, numbered and forward-only. The store is copied to a timestamped backup **before** any
migration runs, and the three most recent copies are retained — **D9**. Every table below is created
by migration `0001` against an empty store, so for the first release "what happens to existing data"
is: there is none. Thereafter a migration may add a table, add a nullable column, or add an index;
it may not drop or narrow a column that a retained pre-migration copy's schema depends on, because
definition-of-done item 18's rollback restores that copy alongside the previous image.

A contract amendment after release is therefore written as the next hand-written migration rather
than as an edit to the blocks below. `src/store/migration-0002.ts` is the first of these: it adds
`operator_credential.totp_pending_secret_sealed` for S31, documented in prose beside the
`operator_credential` block rather than inside it, since that block is migration 0001's frozen text.

```sql
CREATE TABLE schema_migration (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT    NOT NULL,
  checksum    TEXT    NOT NULL
) STRICT;

CREATE TABLE declaration (
  id                      TEXT    NOT NULL,
  generation              INTEGER NOT NULL,
  clone_url               TEXT    NOT NULL,
  host                    TEXT    NOT NULL CHECK (host IN ('github','generic')),
  credential_ref          TEXT    NOT NULL,
  capability_grant        TEXT    NOT NULL,
  writable_path_prefixes  TEXT    NOT NULL,
  pinned                  INTEGER NOT NULL CHECK (pinned IN (0,1)),
  file_watcher_plan_tool  TEXT,
  file_watcher_apply_tool TEXT,
  file_watcher_auto_merge INTEGER CHECK (file_watcher_auto_merge IN (0,1)),
  git_user_name           TEXT    NOT NULL,
  git_user_email          TEXT    NOT NULL,
  state                   TEXT    NOT NULL CHECK (state IN ('active','orphaned')),
  grant_epoch             INTEGER NOT NULL,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  PRIMARY KEY (id, generation),
  CHECK (generation >= 1),
  CHECK (
    (file_watcher_plan_tool IS NULL) = (file_watcher_apply_tool IS NULL)
    AND (file_watcher_plan_tool IS NULL) = (file_watcher_auto_merge IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX declaration_active_id ON declaration (id) WHERE state = 'active';
CREATE INDEX declaration_by_state ON declaration (state);
CREATE INDEX declaration_with_file_watcher ON declaration (id) WHERE file_watcher_plan_tool IS NOT NULL;
```

`(id, generation)` is the primary key because the id alone is not an identity. The partial unique
index is what makes "at most one active generation per id" a constraint rather than a convention.

```sql
CREATE TABLE clone (
  declaration_id    TEXT    PRIMARY KEY,
  generation        INTEGER NOT NULL,
  state             TEXT    NOT NULL CHECK (state IN
                      ('absent','materialising','ready','dirty',
                       'recovery-pending','needs-attention','evicted')),
  path              TEXT    NOT NULL,
  size_bytes        INTEGER NOT NULL,
  last_operation_at TEXT,
  observed_remote   TEXT,
  attention_reason  TEXT
) STRICT;

CREATE INDEX clone_eviction_order ON clone (last_operation_at);
```

`clone` is keyed by `declaration_id` alone rather than by the pair, because the directory is
deliberately shared across generations. `generation` records the era currently holding it; adoption
advances the field, and adoption is refused unless the tree is clean.

```sql
CREATE TABLE oauth_client (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  revoked_at    TEXT
) STRICT;

CREATE TABLE "grant" (
  grant_id       TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('mcp','operator-api')),
  client_id      TEXT    REFERENCES oauth_client(client_id),
  subject        TEXT    NOT NULL,
  resource       TEXT,
  declaration_id TEXT,
  generation     INTEGER,
  scopes         TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT,
  CHECK ((kind = 'mcp') = (resource IS NOT NULL)),
  CHECK ((kind = 'mcp') = (declaration_id IS NOT NULL)),
  CHECK ((kind = 'mcp') = (generation IS NOT NULL)),
  CHECK ((kind = 'operator-api') = (client_id IS NULL))
) STRICT;

CREATE INDEX grant_by_resource ON "grant" (declaration_id, generation);
CREATE INDEX grant_by_client ON "grant" (client_id);
CREATE INDEX grant_live ON "grant" (grant_id) WHERE revoked_at IS NULL;

CREATE TABLE token (
  jti           TEXT PRIMARY KEY,
  grant_id      TEXT NOT NULL REFERENCES "grant"(grant_id),
  kind          TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  verifier_hash TEXT NOT NULL,
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
) STRICT;

CREATE UNIQUE INDEX token_by_verifier ON token (verifier_hash);
CREATE INDEX token_by_grant ON token (grant_id);
CREATE INDEX token_retention ON token (expires_at, revoked_at);
```

`token` holds no token value. `token_by_verifier` is unique so a lookup by presented secret is one
indexed probe; the comparison that decides acceptance is still constant-time. `token_retention` is
the index the fastest-growing table's pruning runs on.

```sql
CREATE TABLE operator_credential (
  singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
  subject               TEXT    NOT NULL,
  password_hash         TEXT    NOT NULL,
  totp_secret_sealed    TEXT    NOT NULL,
  totp_reenrol_required INTEGER NOT NULL CHECK (totp_reenrol_required IN (0,1)),
  enrolled_at           TEXT    NOT NULL
) STRICT;

CREATE TABLE operator_recovery_code (
  code_hash TEXT PRIMARY KEY,
  issued_at TEXT NOT NULL,
  used_at   TEXT
) STRICT;

CREATE TABLE operator_session (
  id                  TEXT PRIMARY KEY,
  subject             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  idle_expires_at     TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at          TEXT
) STRICT;

CREATE INDEX operator_session_retention ON operator_session (absolute_expires_at, revoked_at);
```

`operator_credential` is a singleton table. The `CHECK` is what makes "one operator identity, no
accounts table" enforceable rather than asserted.

**Migration 0002** (`src/store/migration-0002.ts`, hand-written — migration 0001 above is immutable
once released, per `scripts/generate-migration-0001.ts`) adds `totp_pending_secret_sealed TEXT` to
`operator_credential`: the not-yet-committed secret `beginTotpReenrol` (S31.1) seals, read back and
committed by `completeTotpReenrol` on a correct code. `NULL` whenever no re-enrolment is in progress.

**`password_hash` is a one-way hash; `totp_secret_sealed` is not, and cannot be.** Verifying a
password compares hashes, but verifying a TOTP code recomputes `HMAC-SHA1(secret, timeStep)` on
every login and therefore needs the secret's bytes back. A one-way hash would make the factor
enrollable once and unverifiable thereafter, which is why the column is sealed rather than hashed.

The seal is authenticated symmetric encryption (AES-256-GCM), and **its key is a file in the
credential mount, never on the data volume**. That placement is forced by two rules this document
already carries: invariant S5 forbids a secret value in a persisted row, and the design's credential
resolution requires that the structured store hold no secret so the pre-migration backups do not
inherit secret handling. Those backups live on the data volume, so a key stored there would put the
sealed secret and the means to open it in the same copy, and neither rule would hold.

The key's reference name begins with `_`, which `CredentialRef`'s own pattern
(`^[a-z0-9][a-z0-9._-]{0,63}$`) cannot produce. A declaration therefore **cannot** name it, by
construction rather than by a rule somebody has to remember.

When the key is absent or unreadable, `loginLocal` fails with `totp-key-unavailable`. This is not
fatal at boot: the operator's route back in is break-glass, which needs the service running, and
refusing to start would remove the recovery path for the very misconfiguration that caused it.

```sql
CREATE TABLE scheduled_job (
  id                 TEXT    PRIMARY KEY,
  declaration_id     TEXT    NOT NULL,
  generation         INTEGER NOT NULL,
  tool               TEXT    NOT NULL,
  input              TEXT    NOT NULL,
  not_before         TEXT    NOT NULL,
  on_missed_mode     TEXT    NOT NULL CHECK (on_missed_mode IN ('catch_up','skip_if_older_than')),
  on_missed_seconds  INTEGER,
  frozen_grant       TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN
                       ('pending','running','done','skipped','cancelled','needs-attention')),
  reason             TEXT,
  created_by_kind    TEXT    NOT NULL,
  created_by_subject TEXT    NOT NULL,
  created_by_client  TEXT,
  created_by_grant   TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  CHECK ((on_missed_mode = 'skip_if_older_than') = (on_missed_seconds IS NOT NULL))
) STRICT;

CREATE INDEX scheduled_job_due ON scheduled_job (not_before) WHERE status = 'pending';
CREATE INDEX scheduled_job_by_declaration ON scheduled_job (declaration_id, generation);
CREATE INDEX scheduled_job_retention ON scheduled_job (status, updated_at);
```

`created_by_grant` is nullable and non-null wherever a grant existed. It is what the fire-time
revocation check reads.

```sql
CREATE TABLE journal_entry (
  operation_id        TEXT    PRIMARY KEY,
  declaration_id      TEXT    NOT NULL,
  generation          INTEGER NOT NULL,
  tool                TEXT    NOT NULL,
  input               TEXT    NOT NULL,
  actor_kind          TEXT    NOT NULL,
  actor_subject       TEXT    NOT NULL,
  actor_client        TEXT,
  actor_grant         TEXT,
  scheduled_job_id    TEXT,
  context             TEXT    NOT NULL CHECK (context IN ('normal','repair','recovery','hatch')),
  pre_branch          TEXT,
  pre_head_sha        TEXT,
  pre_upstream_sha    TEXT,
  pre_index_digest    TEXT    NOT NULL,
  pre_worktree_digest TEXT    NOT NULL,
  state               TEXT    NOT NULL CHECK (state IN ('intended','applied','settled','attention')),
  attention_reason    TEXT,
  started_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
) STRICT;

CREATE INDEX journal_unsettled ON journal_entry (declaration_id, generation) WHERE state <> 'settled';
CREATE UNIQUE INDEX journal_by_job ON journal_entry (scheduled_job_id) WHERE scheduled_job_id IS NOT NULL;
CREATE INDEX journal_retention ON journal_entry (state, updated_at);

CREATE TABLE journal_step (
  operation_id TEXT    NOT NULL REFERENCES journal_entry(operation_id),
  ordinal      INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  state        TEXT    NOT NULL CHECK (state IN ('applied')),
  at           TEXT    NOT NULL,
  PRIMARY KEY (operation_id, ordinal)
) STRICT;
```

`journal_unsettled` is the index recovery selects on, keyed by the pair — which is what makes "an
entry from a previous era never matches" a property of the query rather than of a filter someone
remembered to write. `journal_by_job` is unique so boot's lookup by job id cannot find two.

```sql
CREATE TABLE notification_outbox (
  id              TEXT    PRIMARY KEY,
  severity        TEXT    NOT NULL CHECK (severity IN ('attention','info')),
  declaration_id  TEXT,
  payload         TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('pending','in-flight','delivered','failed')),
  attempts        INTEGER NOT NULL,
  last_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT    NOT NULL,
  delivered_at    TEXT
) STRICT;

CREATE INDEX outbox_pending ON notification_outbox (created_at) WHERE status = 'pending';
CREATE INDEX outbox_retention ON notification_outbox (status, delivered_at);

CREATE TABLE audit_chain_head (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  sequence   INTEGER NOT NULL,
  head_hash  TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
) STRICT;

CREATE TABLE audit_retained_anchor (
  segment           INTEGER PRIMARY KEY,
  terminal_sequence INTEGER NOT NULL,
  terminal_hash     TEXT    NOT NULL,
  retained_at       TEXT    NOT NULL
) STRICT;

CREATE TABLE credential_failure_mark (
  credential_ref TEXT NOT NULL,
  declaration_id TEXT NOT NULL,
  reason         TEXT NOT NULL,
  marked_at      TEXT NOT NULL,
  PRIMARY KEY (credential_ref, declaration_id)
) STRICT;
```

The composite primary key on `credential_failure_mark` is the schema-level statement of the design's
rule that a failing credential is marked for one declaration and never reference-wide.

**Files on the volume, not rows.** Each has a fixed shape and no migration:

| File | Holds | Written |
|---|---|---|
| Instance lease lock | nothing readable — it exists only to carry the exclusive advisory OS lock | opened and locked at acquisition, held for the process's lifetime |
| Instance lease | `InstanceLease` as JSON | once at acquisition, while the lock above is held |
| Audit segment | one `AuditRecord` JSON per line | append-only, rotated at `auditSegmentBytes` |
| — its path | `audit/NNNNNN.jsonl` under the volume root, six zero-padded digits, numbered from `000001` | created on first append to that segment |
| Provisioning file | an enrolment secret | by an operator with host access; burned at enrolment |
| Break-glass file | a single-use token | by an operator with host access; consumed at next login |
| TOTP sealing key — **in the credential mount, not on this volume** | 32 random bytes | by the deployment, before first enrolment; read at every local login, never written by the service |
| Pending pull-request list, one per declaration | `PendingPullRequestList` as JSON | temp-then-rename on each tick |

A missing or unparseable pending pull-request list is treated as empty and never thrown — a bad
read must not crash a tick.

**The audit segments are the trail; `audit_chain_head` is an advisory mirror.** The row exists so
the head can be read without walking the files, and so a cleanly truncated tail is detectable. It
is never the source of truth: the head is re-derivable from the last parseable record of the
highest-numbered segment, and `Audit.append` and `Audit.verify` both fall back to that when the
structured store is unreadable. That is what makes the log outlive the store's corruption, which is
the reason it is a separate storage kind rather than another table. A segment is rotated **before**
a record that would exceed `auditSegmentBytes` is written, so a segment only exceeds the cap when a
single record does.

---

## Public signatures

Grouped by module, in the layer order the design fixes. Internal helpers are out of scope.

### L1 — clock

Declared in `src/clock/clock.ts`. Two readings, not one: `now()` is wall-clock and may jump, and is
what gets persisted; `monotonicMs()` never jumps and is what durations and timeouts are measured
with. Nothing may derive a duration by subtracting two `now()` readings.

The envelope constructors and `isError` are declared under `### The result envelope`.

### L1 — exec

Declared in `src/exec/exec.ts`. This is the only module in the service that starts a child process,
which is what makes it the enforcement point for **S5**.

`argv` is a vector, never a string, and there is no shell. The executable is fixed by which runner
is called, never by an element of `argv`. `credential` names an environment variable; the value is
placed in the child's environment by the resolver and never returned to a caller. Its optional
username is placed in the child environment too and never in `argv`. Exec supplies the
credential-helper configuration itself, ahead of every element of `argv`, and disables system and
global configuration with a neutral home directory.

### L1 — locks

Declared in `src/locks/locks.ts`, with `LockHolder`, `LockHandle`, `ActivePin` and `WaitAdmission` in
`src/locks/types.ts`.

Three separate mechanisms live here and they are not interchangeable. The two locks are mutual
exclusion — at most one mutation lock is held process-wide at any instant (**C1**), and whenever both
are held the materialisation lock was acquired first and they are released in reverse order (**C2**).
The pin is not a lock at all: it is a refcount that keeps a clone from being evicted underneath a
running operation (**C4**), which is why it never awaits and never fails (**C5**) — a pin that could
block would be a lock, and a pin that could fail would leave a caller with no safe action. Admission
is a third thing again: a counter, taking neither mutex, gating how many lock-free monitoring waits a
session may hold.

Every handle releases by method rather than by the caller tracking state, and each `release` is
idempotent, because the unwind path after a failure must be safe to run twice.

`pinActiveOperation` never waits and never fails. `currentMutationHolder` is what scopes
`ReadStamp.mutationInFlight` to a declaration rather than to the mutex.

**S10 adds `admitLockFreeWait`.** `LockError`'s `admission-refused` variant and
`AdmissionLimits`' `concurrentWaitsPerSession` and `concurrentLockFreeOperations` were fixed from
the outset with nothing that raised or read them; this is the method that does. It takes neither
mutex — a monitoring wait holds no lock, which is the whole point of the execution class — and its
only job is the two counters. It never awaits: admission is refused outright rather than queued,
because a caller queueing for permission to wait is indistinguishable from the wait itself. The
limits are supplied to `createLocks` from `DeploymentConfig.admission`, which the composition root
reads from the deployment rather than allowing a library default to stand in silently, so the
counters live beside
`activeOperationCount` rather than in a second module that would have to be kept consistent with it.
`WaitAdmission.release` is idempotent, on the same grounds as `ActivePin.release`.

### L1 — declarations

Declared in `src/declarations/declarations.ts`, with `DeclarationFilter` in
`src/declarations/types.ts`.

This module owns the authority model, and six of the nine **A** invariants name it as responsible.
`effectiveGrant` takes all four layers and returns a set rather than a boolean, because the epoch
check needs the recomputed set and not just a verdict. Each capability's own scope decides whether
layer 3 participates in its intersection; an instance-scoped capability intersects layers 1, 2 and 4
only, which is why `declaration` may be null — a null declaration is a legitimate call, not a missing
argument.

`effectiveWritablePrefixes` may only narrow: its result is a subset of the declaration's own prefixes
and contains nothing under the profile's stripped set — **A4**. No layer adds a prefix.

`bumpGrantEpoch` takes a `StoreTransaction` rather than opening its own, because an epoch bump must
commit with the amendment that caused it; a bump that could land separately would leave sessions
frozen at an epoch that never corresponded to a stored grant.

`revalidateFileWatchers` re-checks every active declaration's plan/apply tool pair against the current
registry at boot. It returns the first mismatch found, not a full report, because boot fails closed on
the first one either way.

`effectiveGrant` takes all four layers and returns a set rather than a boolean, because the epoch
check needs the recomputed set and not just a verdict. Each capability's own scope decides whether
layer 3 participates in its intersection; an instance-scoped capability intersects layers 1, 2 and
4 only, which is why `declaration` may be null.

`revalidateFileWatchers` re-checks every active declaration's plan/apply tool pair against the
current registry at boot, per the file-watcher boot re-validation this contract already requires
(§ "File watcher", "Checked at creation, at fire time, and at boot re-validation"). It returns the
first mismatch found, not a full report, because boot fails closed on the first one either way.

### L1 — credentials

Declared in `src/credentials/credentials.ts`, with `MutableEnv` and `CredentialFailureMark` in
`src/credentials/types.ts`.

**`clearFailing`'s `actor` is `null` on its one internal caller (S34).** `resolveInto` clears a mark
itself the moment it observes a secret rewritten since the mark was taken — no operator is involved,
so there is nothing to audit. The health view's own clear, added by S34, always carries the
operator's `ActorRef` and is the one path that appends an `identity-event` record.

No signature here returns a secret value. `resolveInto` writes into a `MutableEnv` that only `Exec`
consumes, and hands back a `CredentialBinding` naming the variable. Resolution happens at the
moment of use, so a replaced file takes effect on the next operation with no restart.

**The mount's layout, fixed by S9.** A reference name is a file name directly under the credential
mount, and that file's contents — trimmed of a trailing newline — are the secret. The per-reference
allowed-host constraint the design gives each reference lives in one manifest at the mount root:

```
<mount>/_allowed-hosts.json     { "<ref>": ["github.com", ...], ... }
<mount>/_<ref>.username         optional username, UTF-8 text with one trailing newline trimmed
<mount>/<ref>                   the secret
```

The manifest and optional username file begin with `_`, which `CredentialRef`'s own pattern forbids
as a first character, so neither can collide with a reference — the same device the TOTP sealing
key already uses. A missing username file means `username: null`, and Exec retains its existing
`x-access-token` fallback; a host that requires a particular account or deploy-token username must
supply the file. After the one trailing newline is removed, a username must be non-empty and contain
no CR, LF or NUL; otherwise resolution returns `reference-unreadable`. **A reference absent from the
manifest permits no host**, and `allowedHosts` returns the empty list rather than every host: the
design calls this a second guard independent of the deployment's `remoteHostAllowlist`, and a guard
that defaults open is not one.

`EnvVarName` for a resolved binding is derived from the reference, uppercased with every character
outside `[A-Z0-9]` replaced by `_`, under a fixed `SZG_CREDENTIAL_` prefix. It is an internal
channel name between the resolver and `Exec`, never operator-configured, so nothing depends on the
particular spelling beyond its being stable within one call.

### L1 — structured store

Declared in `src/store/structured-store.ts`.

`SqlParameter` is a closed union rather than `unknown` because it is the boundary where a value stops
being a domain type and becomes a bound parameter; widening it would let an object reach the driver
and be coerced in a way no invariant covers.

`incrementalVacuum` returns the bytes actually returned to the filesystem, which is what the
maintenance pass reports rather than the rows it deleted.

**`StoreTransaction` carries `run`, and that is what makes every `tx`-taking member honest.** Four
members take one — `Notifier.enqueue`, `Declarations.bumpGrantEpoch`, `Scheduler.cancelForDeclaration`
and `Authorization.revokeGrantsForResource` — and each promises its write commits with the caller's.
An opaque `{ id }` token cannot deliver that: a participant holding only an identifier has no way to
reach the open transaction, so it opens its own connection instead and the write lands outside. It
then either survives the caller's rollback, or is refused as busy and lost silently. Participants
therefore write through `run`; `bumpGrantEpoch` additionally returns an `Outcome` so a missing row
or failed read cannot masquerade as epoch zero.

**`all` is there because writing is only half of participating.** Three of the four members have to
read inside the transaction to produce what they return: `bumpGrantEpoch` returns the epoch it just
incremented, and `cancelForDeclaration` and `revokeGrantsForResource` each return the ids they just
affected. A second connection cannot answer any of those — it cannot see the caller's uncommitted
write, and it may be refused as busy against the write lock the caller already holds. A member given
`run` alone is therefore still forced outside the transaction to compute its own return value, which
is the same defect wearing a different shape.

It exposes no `BEGIN`, `COMMIT` or `ROLLBACK` **by design**: the module that opened the transaction
is the only one permitted to end it. A participant that could commit its caller's transaction is a
worse defect than the one this replaces. `all` does not widen that: reading cannot end a transaction,
and a participant that can already write can already observe its own effects.

### L1 — clone store

Declared in `src/clone/clone-store.ts`.

`ensure` returns a `CloneHandle` rather than a `Clone` because possession of the clone and possession
of the locks over it cannot be separated — see **C3**. `deriveAllStatesFromDisk` is what **D1** names:
boot re-derives every state from disk and never trusts the stored value.

`acrossAllGenerations` is `true` for the adoption check and `false` for eviction: adoption asks
whether any era left work in the tree, eviction asks about the current one.

`requestMaintenance` returns `void` and never awaits, because it is called on the post-mutation
path, where eviction must not run.

`remove` with `permitCorruptTree` still refuses when the tree holds commits unreachable from
`origin/<base>`. It is never a way to discard unpushed work.

### L1 — journal

Declared in `src/journal/journal.ts`.

`classify` is pure, reads no git state and performs no I/O — the clone store owns the observation,
the journal owns the rule. `settle` takes the notification because the outbox row and the state
change commit in one transaction; `null` is the ordinary case. `appendStep` writes the step in the
`applied` state, before the call it describes.

### L1 — recovery catalogue

Declared in `src/recovery/catalogue.ts`.

Populated by the composition root. It never imports a domain module.

### L1 — audit

Declared in `src/audit/audit.ts`.

`append` returns `AuditAppendOutcome` rather than an `Outcome`, and that difference is deliberate: an
audit failure is data the caller reads, never a failure that propagates — **S3**. `verify` walks the
chain and `chainState` reports the last known result; they are separate members because verification
is expensive and boot must be able to report a state without repeating it.

`close` releases the module's own handle on the structured store, mirroring `StructuredStore.close`.
The lifecycle module calls it during shutdown: a module that opens a resource is the module that
releases it, and leaving the handle to process exit makes an in-process restart hold a file open on
a host that refuses to unlink open files.

`append` never throws and never rejects. Every append passes through one writer inside the module,
which is what assigns `sequence`, `previousHash` and `hash`.

### L1 — notifier

Declared in `src/notifier/notifier.ts`.

`enqueue` is synchronous and takes a transaction, so the row and the settle commit together.
Delivery happens afterwards and never blocks the operation it describes.

`clearFailed`'s `actor` was accepted from the start but never recorded anywhere but a log line
(S11) — none of the seven `AuditRecordBody` forms described an operator clearing an outbox row.
S34 gives it one: `clearFailed` appends an `identity-event` record carrying `'outbox-row-cleared'`
once the row's write-back has actually landed, the same order `authorization.ts`'s revocations
already audit in.

### L1 — lifecycle

Declared in `src/lifecycle/boot.ts`, with `BootJobReport` composed from the scheduler's own types in
`src/scheduler/types.ts`.

`BootReport` is a record of what boot found and decided, not a status: every field names something
that could have gone differently, and boot returning successfully with a non-empty
`revalidation.entriesParked` or `recoveryPending` is an ordinary outcome rather than a warning. That
is why they are lists rather than counts — an operator needs to know *which*.

`leaseSelfTestPassed` is reported separately from the lease itself because holding the lease and
having proved the volume excludes are different facts, and only the second is evidence **C7** holds.

`recoverDeclaration` is the lazy pass, called on first use and by the background sweep. Any resume
step it runs goes through the injected dispatch and takes the global mutation lock for itself,
completing before the triggering call acquires anything.

Boot step 1's lock is taken through an injected seam, because the failure it must detect is a
property of the volume rather than of this code, and a volume that does not exclude cannot be
produced on demand in a test:

Declared in `src/lifecycle/lease.ts`.

`childIsRefused` spawns a **real second process** that attempts the same lock and reports whether
it was refused. A child rather than a second acquire from this process, because the property
relied on is cross-process exclusion: a same-process re-acquire tests the locking API, and can
pass on a broken volume and fail on a sound one. An acquirer whose `childIsRefused` returns false
makes boot fatal with `lease-not-exclusive`.

The deployment supplies one implementation. Everything else the lifecycle and store modules export
— factories, options records and the migration list — is an internal helper and out of scope here,
per this section's opening rule.

### L2 — git operations

Declared in `src/git/git-operations.ts`, with `CallContext` and `DomainOperation` in
`src/shared/call-context.ts` and the input/output and rejection types in `src/git/types.ts`.

`CallContext` is the whole of a call's authority, assembled by the dispatch pipeline and never
amended by a handler. Three of its fields admit `null` and each `null` means something specific
rather than "missing": a null `declarationId` and `generation` mark an instance-scoped call, and a
null `cloneRoot` marks a call dispatched with no clone materialised — the file-watcher plan phase,
which takes neither lock (**C3**, **D11**). A handler receiving a null `cloneRoot` may not fall back
to a default path; there is no repository to fall back to.

`capabilities` is an `EffectiveGrant`, already intersected. A handler checks membership and never
recomputes the intersection, which is what keeps **A1** in one place.

`DomainOperation` returns `ToolResult` rather than `Outcome` because L2 is the layer the design fixes
as envelope-returning; every other module returns `Outcome` with an enumerated error. That boundary is
deliberate and is the one place the two conventions meet.

`PathRejection`'s three variants exist because they map to *different result kinds*: `malformed` maps
to `validation`, while `outside-allowlist` and `stripped-by-profile` map to `authorization` and are
audited. Collapsing them to one rejection would lose that distinction, and the audit record naming the
rejected path is the signal of an unattended actor probing its unlock paths.

`validateWritePath` returns `malformed` for `-A`, `--all`, `.`, and any path containing `..` or
`;`, which the pipeline maps to `validation`. The other two map to `authorization` and are audited,
because that refusal is the signal of an unattended actor probing its unlock paths.

`loadRepositoryConfig` reads from the working tree on every call and caches nothing.

The twelve operations' input and output types were initially **named above but not defined here**,
because the design did not determine them. The slice-specific U1 resolutions below are their
complete declarations. What the design and the brief fixed before those resolutions:

Declared in `src/git/types.ts`.

`GitLogInput.ref` defaults to `origin/<baseBranch>` when null, never to `HEAD`. `GitRawInput.argv`
is rejected before the process starts when it selects an executable, injects configuration, writes
configuration, carries a password-bearing remote URL, carries a remote operand that does not
normalise to this declaration's own `cloneUrl`, names a **remote-helper transport** — git's
`<transport>::<address>` form, which never parses as a URL and so is invisible to the remote-operand
rule, and whose `ext::` case runs the address as a command outright — or invokes a subcommand that
persists a remote: `remote add`, `remote set-url`, or `submodule add`. Remote-valued options such as
`--remote` are remote operands too; an opaque remote name is accepted only when it is `origin`.
`--template` is refused in every position, because a template directory can carry hooks and a hook is
an executable the vector never has to name. Configuration reads remain reachable except for the file,
blob, global, system and editor forms that escape the declaration's repository-local configuration.
There is no force flag anywhere in `GitPushInput`, and there is no reset, clean, rebase or
branch-delete operation on this interface.

**A refused vector is audited exactly as an executed one is.** The `hatch-intent` line is written
before the argv is judged, not after, and a refusal writes the matching `hatch-outcome`; both carry
the scrubbed vector and the actor. An attempt at one of the six operations the default path exists to
withhold is the most attributable thing the hatch ever sees, and auditing only vectors that pass left
exactly that attempt invisible while the registry entry promised every use is separately audited.
**S9** carries the rule; a failed intent append is the one thing that stops the pair being written,
and it refuses the call rather than executing unlogged. See `design/90-decisions.md`, 2026-08-31.

**S6 resolves U1 for the five read operations.** Their input and output types are declared in
`src/git/types.ts`.

`RepoHealthData` carries no GitHub-derived field — no PR count, deploy status or check pass rate.
`GitOperations` (L2) depends on L1 only; folding host data into this tool would give it a dependency
the module table does not grant it. A combined local-plus-host view, if wanted, is a composite, not
this tool.

The five registry entries S6 ships, naming the tools by the brief's own convention (`git_commit`,
`repo_declare`):

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `repo_status` | `{ kind: 'module', target: 'git.status' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |
| `git_log` | `{ kind: 'module', target: 'git.log' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: true }` | `{ timeoutSeconds: 30, maxResultBytes: 1048576 }` |
| `git_branches` | `{ kind: 'module', target: 'git.branches' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 262144 }` |
| `repo_health` | `{ kind: 'module', target: 'git.health' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |
| `git_diff` | `{ kind: 'module', target: 'git.diff' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: true }` | `{ timeoutSeconds: 30, maxResultBytes: 4194304 }` |

Every entry has `capabilityScope: 'declaration'`. `git_log` and `git_diff` carry
`untrustedOutput: true`: commit subjects and diff bodies are written by repository contributors,
not the operator, which is exactly the "author-controlled text as data" case the annotation exists
for elsewhere on `HostComment.body`. `repo_status`, `git_branches` and `repo_health` carry only
branch names and counts, and stay `false`. None is `schedulable` — a periodic read has no
declared consumer yet, and the annotation is easy to flip on a future tool that wants one.
`timeoutSeconds` is short because all five run against the local clone only, with no network call.

**S7 resolves U1 for the three local mutating operations** — `git_stage`, `git_commit`,
`git_restore_paths`. `GitStageInput`, `RestorePathsInput` and `GitCommitInput` are already fixed
above; their output types are declared alongside them in `src/git/types.ts`.

None of the three carries a `ReadStamp` — that field exists so a caller can tell whether what it
read was stable under a concurrent mutation, and a mutating call is itself the thing every read's
`mutationInFlight` would be reporting on, not a consumer of the same signal.

Every path in `GitStageInput.paths` and `RestorePathsInput.paths` is checked with
`validateWritePath` before any side effect: `malformed` maps to `validation`, `outside-allowlist`
and `stripped-by-profile` both map to `authorization` and write an audit record naming the rejected
path. `git_commit` takes no path and needs no such check; it commits whatever is already staged.

The three registry entries S7 ships:

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `git_stage` | `{ kind: 'module', target: 'git.stage' }` | `['git.local.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |
| `git_commit` | `{ kind: 'module', target: 'git.commit' }` | `['git.local.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |
| `git_restore_paths` | `{ kind: 'module', target: 'git.restorePaths' }` | `['git.local.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |

Every entry carries `capabilityScope: 'declaration'`, the same as every S6 entry. None is
`schedulable` — a scheduled job naming a bare local mutation with no commit message or path input
of its own has no declared consumer yet — and none is `fileWatcher`, which S17's watcher tools claim
for themselves. `timeoutSeconds` matches the five read tools': all three run against the local
clone only, with no network call, and the design's per-declaration path-allowlist and two-lock
machinery is what bounds their cost, not a longer cap.

**S9 resolves U1 for the three remote operations** — `git_push`, `git_fetch`, `sync_base`. Their
input and output types are declared in `src/git/types.ts`.

`GitPushInput.branch` defaults to the checked-out branch when null. **It carries no force option**,
and no other field of any of the three admits one — the absence is a fixed property of the input
schema, not a runtime refusal, which is what makes it checkable by reading the compiled registry.

`sync_base` brings the *local* base branch up to `origin/<base>` and never rewrites history: it
fast-forwards, and refuses with `precondition` when the local base carries commits the remote does
not. `SyncBaseData.fastForwarded` is false when the branch was already current — a no-op is a
success, not a failure. There is no reset, rebase or force path out of a divergence here; the
operator resolves it, which is the same rule the local mutations already follow.

`GitFetchData.updatedRefs` names the remote-tracking refs whose value changed, observed by
comparing `refs/remotes/origin/*` either side of the fetch rather than by parsing transfer output.

None of the three carries a `ReadStamp`, for the reason the S7 three do not: each is itself a
mutation, not a consumer of the signal `mutationInFlight` reports.

The three registry entries S9 ships:

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `git_push` | `{ kind: 'module', target: 'git.push' }` | `['git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |
| `git_fetch` | `{ kind: 'module', target: 'git.fetch' }` | `['git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |
| `sync_base` | `{ kind: 'module', target: 'git.syncBase' }` | `['git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |

Every entry carries `capabilityScope: 'declaration'`. All three are `mutating` rather than `read`,
`git_fetch` included: it moves remote-tracking refs, and the global mutation lock is what keeps a
transfer from interleaving with another declaration's commit. `timeoutSeconds` is ten times the
local tools' because these are the first operations that cross a network — the cap has to bound a
transfer, not a local `git add`. None is `schedulable`: a scheduled bare push with no branch of its
own has no declared consumer, and S16's held operations are where that question is actually
answered.

**S15 resolves U1 for `git_raw`.** Its input was fixed above; `GitRawData` is declared in
`src/git/types.ts`.

`stdout` and `stderr` are scrubbed before they enter the result. A successful `GitRawData` carries
`exitCode: 0`; a non-zero child exit maps to an error envelope rather than successful data.
`changedPaths` is the sorted, duplicate-free set of repository-relative paths whose index or
worktree status differs between the journaled pre-state and the observation after the child exits.
It is the same list written into the `hatch-outcome` audit record. If the initial status observation
fails, the caller-authored child is not started, the operation returns `infrastructure`, and the
outcome carries `changedPaths: []` because that child caused no change. If the post-state observation
fails after the child ran, the outcome record carries `changedPaths: null`, meaning unknown — never
an empty set — and a child that otherwise succeeded returns `infrastructure`. A primary timeout,
cancellation or non-zero child result remains the returned result kind while the outcome summary
also records that post-state observation failed.

The registry entry S15 ships:

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `git_raw` | `{ kind: 'module', target: 'git.raw' }` | `['git.raw']` | `['raw']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: true }` | `{ timeoutSeconds: 60, maxResultBytes: 4194304 }` |

It carries `capabilityScope: 'declaration'`. It is neither schedulable nor a file-watcher target:
the hatch is deliberately invoked, never an unattended execution surface. Its output is untrusted
because the caller chooses an operation whose output may contain repository-authored text. The
60-second limit is `TimeoutBudget.hatchSeconds`; it is shorter than the 300-second transfer caps
because caller-authored work holds the estate-wide mutation lock. The 4 MiB result limit matches
`git_diff`, the existing local operation whose caller-selected output can likewise contain
repository-authored content.

### L2 — composites

Declared in `src/composites/composites.ts`.

Each operation's `RecoveryDescriptor` is held separately and registered into the recovery catalogue
by the composition root, matching `GitOperations` and `HostOperations`. Every sub-step that mutates
outside the local clone calls `Journal.appendStep` before making the call.

**S12 resolves U1 for the two composites.** Their input and output types are declared in
`src/composites/types.ts`.

`PrepareBranchInput` carries only the branch name — not `TODO-NEXT.md` §7.3's `slug`/`kind`, which is
blog-specific branch-naming policy this repository does not own (`00-brief.md`: "general git-workflow
safety, not blog-specific"). `preservedCommits` is non-empty only for `rebased-preserved-commits`.

The seven protected-base invariants S12.1 requires (`TODO-NEXT.md` §7.2, the incident doc
`00-brief.md`'s "protected-base invariant" paragraph names — not itself present in this repository;
it is `SubZeroDev.Blog/tools/blog-mcp/TODO-NEXT.md`, load-bearing prior art per `AGENTS.md`):

1. A publishing commit cannot be created on the configured base branch. Owned by `git_commit`
   (`git/git-operations.ts`) — S12 amends it even though `Git operations (L2)` is outside this
   slice's own `Touches` line, because nothing else in the design owns it and demonstrating all
   seven, not six, is S12.1's own text. See the deviation note under `## Unresolved` § U1 history.
2. Branch preparation fetches and evaluates ancestry before any content write. Owned by
   `prepareBranch`.
3. A clean local-only commit on base is preserved on the requested branch. Owned by `prepareBranch`.
4. The branch is based on the latest `origin/<base>`. Owned by `prepareBranch`.
5. Uncommitted changes are never carried implicitly; branch preparation refuses them. Owned by
   `prepareBranch`.
6. A rebase conflict stops safely without losing the original commits. Owned by `prepareBranch`.
7. After merge, reconciliation fetches, switches to base, and fast-forwards to the merged remote
   commit. Owned by `reconcileAfterMerge`.

The two registry entries S12 ships:

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `prepare_branch` | `{ kind: 'module', target: 'composites.prepareBranch' }` | `['git.local.write', 'git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |
| `reconcile_after_merge` | `{ kind: 'module', target: 'composites.reconcileAfterMerge' }` | `['git.local.write', 'git.remote.write', 'host.pr.read']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |

Both carry `capabilityScope: 'declaration'`, matching every other L2 tool.

**Resume, not a narrower step (S12.4, S12.5).** Both descriptors' `resume` re-dispatches the *same*
composite tool with the journal entry's original input, rather than a finer-grained step — safe only
because both composites are written to be idempotent from any partial state (see
`composites/recovery-descriptors.ts`'s doc comment). `expectedPostState` always returns `false` for
both, the same honest-absence reasoning `sync_base`'s own descriptor already gives: neither
composite's effect is fully visible in `ObservedGitState`.

### L2 — host adapter

Declared in `src/host/host-operations.ts` and `src/host/types.ts`, with the GitHub implementation in
`src/host/github-adapter.ts`.

**The absence of a merge method is the contract's most load-bearing statement about this module**, and
it is a property of the interface rather than a runtime refusal: there is no merge or rebase member to
call, so the host's own auto-merge is the only path by which anything merges. A future amendment adding
one would be a change of policy, not an addition of convenience.

The adapter is the only module that reaches a host API, which is why `host.*` capabilities are absent
from `hostSupportedCapabilities('generic')` — **A5**. A generic-host declaration cannot hold one, so
nothing here is reachable for it.

`HostComment.body` is author-controlled text carried as data; the tool returning it is annotated
`untrustedOutput`. There is no merge method and no rebase method on this interface, and by design
there never will be — the host's own auto-merge is the only merge path.

**S10 resolves U1 for the host tools**, `CreatePullRequestInput` included. Their input and output
types are declared in `src/host/types.ts`.

`CreatePullRequestInput` carries **no base branch**. The base is the declaration's `baseBranch`, for
the reason `git_push` takes no remote: an input-supplied base would let a caller open a pull request
against a branch the declaration never named, which is authority the declaration is supposed to
bound. `headBranch` defaults to the checked-out branch when null, matching `GitPushInput.branch`.
`draft` is carried because a draft pull request is strictly less dangerous than a ready one — it
cannot auto-merge — so omitting the field would make the *more* permissive state the only reachable
one.

`ChecksStatusInput.ref` and `ChecksAwaitInput.ref` default to the clone's current head when null.
`ChecksAwaitData.concluded` is false when the wait returned because it hit its cap rather than
because every check reached a conclusion; a wait that times out is a `timeout` envelope, so
`concluded: false` is reachable only where the cap and the poll interval race, and callers read it
rather than inferring conclusion from the check list.

The seven registry entries S10 ships:

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `pr_open` | `{ kind: 'module', target: 'host.createPullRequest' }` | `['host.pr.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 120, maxResultBytes: 65536 }` |
| `pr_status` | `{ kind: 'module', target: 'host.readPullRequest' }` | `['host.pr.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 60, maxResultBytes: 65536 }` |
| `pr_list` | `{ kind: 'module', target: 'host.listPullRequests' }` | `['host.pr.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 60, maxResultBytes: 65536 }` |
| `pr_comments` | `{ kind: 'module', target: 'host.readPullRequestComments' }` | `['host.pr.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: true }` | `{ timeoutSeconds: 60, maxResultBytes: 131072 }` |
| `pr_enable_auto_merge` | `{ kind: 'module', target: 'host.enableAutoMerge' }` | `['host.pr.write']` | `['write']` | `mutating` | `{ schedulable: true, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 120, maxResultBytes: 65536 }` |
| `checks_status` | `{ kind: 'module', target: 'host.readChecks' }` | `['host.checks.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 60, maxResultBytes: 65536 }` |
| `checks_await` | `{ kind: 'module', target: 'host.awaitChecks' }` | `['host.checks.read']` | `['read']` | `monitoring-wait` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 1800, maxResultBytes: 65536 }` |

Every entry carries `capabilityScope: 'declaration'`. `pr_comments` is annotated `untrustedOutput`
for the reason `git_log` and `git_diff` already are: `HostComment.body` is author-controlled text,
carried as data rather than interpreted. It is the only host tool that carries the annotation — the
other six return host-controlled structure (numbers, states, shas, check names) rather than prose,
and annotating those would dilute what the annotation means. Its `maxResultBytes` is doubled because
comment threads are the one host response that grows without bound, and the size limit rather than
truncation is what bounds it.

`pr_enable_auto_merge` is the initial registry's only schedulable production operation. It carries
the prior art's unattended auto-merge capability through the generic one-operation scheduler while
leaving bare git mutations and scheduler-management operations unavailable to recursive scheduling.

`checks_await` is the registry's first `monitoring-wait`. Its `timeoutSeconds` equals
`monitoringWaitCapSeconds`, which is the compiler-enforced ceiling (`limit-exceeds-cap`) rather than
a coincidence; `ChecksAwaitInput.timeoutSeconds` is clamped to it at dispatch, so a request for
3600 s waits 1800 s rather than being refused. It declares `host.checks.read` and no mutating
capability — invariant C7's requirement — and takes neither lock.

**The `required-check-failed` judgement fails closed, and runs on every poll.** Three consequences a
caller may rely on, none of them derivable from the variant's own row in § *Error semantics*:

- **It is judged before the pending count, not after the last check concludes.** A required check
  that has already failed is terminal the moment it concludes; waiting for the rest would turn the
  terminal state into a `timed-out` whenever a slower informational check outlives the deadline.
- **A declaration whose `requiredChecks` cannot be read is refused, not passed.** "Nothing is
  required" is a statement about the declaration, and an unreadable or unparseable repository config
  is not entitled to make it — the wait answers `precondition` naming the failed checks rather than
  inverting a safety judgement on a stray comma. This is why the reader the wait consults answers a
  third value for "could not be read" distinct from an empty list.
- **A required failure the wait cannot attribute to an open pull request is refused too**, naming the
  check and the ref, and a failed pull-request lookup propagates as the host error it was rather than
  being read as "no pull request". The one answer that is certainly wrong is a clean wait over a red
  required check, so every branch that cannot reach a verdict refuses.

A check that concluded failure and is **not** named in `requiredChecks` leaves the wait's outcome
exactly as it was before this judgement existed. See `design/90-decisions.md`, 2026-08-31.

`readDeployStatus` has **no registry entry**. Deploy monitoring and published-URL verification are
S12's, and S10's `Out of scope` line says so; the adapter method exists because the interface fixes
it, and is unreachable from every surface until S12 declares a tool over it.

There is no registry entry over a merge or rebase either, because there is no such adapter method to
declare one over. That absence is `10-design.md`'s auto-merge-only rule expressed in the compiled
registry, where it is checkable, rather than as a runtime refusal.

### L2 — scheduler

Declared in `src/scheduler/scheduler.ts`, with its types in `src/scheduler/types.ts`.

Constructed with `Dispatch` injected; it never imports the pipeline. `resolveRunningAtBoot`
classifies from the journal alone and runs no resume step and no git or host I/O.

**S16 resolves U1 for the three scheduler tools.** Their registry entries are:

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `scheduled_job_create` | `{ kind: 'module', target: 'scheduler.create' }` | `['scheduler.manage']` | `['schedule']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: true }` | `{ timeoutSeconds: 30, maxResultBytes: 4194304 }` |
| `scheduled_job_list` | `{ kind: 'module', target: 'scheduler.list' }` | `['scheduler.read']` | `['schedule']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: true }` | `{ timeoutSeconds: 30, maxResultBytes: 4194304 }` |
| `scheduled_job_cancel` | `{ kind: 'module', target: 'scheduler.cancel' }` | `['scheduler.manage']` | `['schedule']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: true }` | `{ timeoutSeconds: 30, maxResultBytes: 4194304 }` |

Every entry carries `capabilityScope: 'declaration'`. `SchedulerOperations` supplies the current
declaration id from `CallContext` to `Scheduler.create` and `Scheduler.list`; a caller cannot create,
list or cancel a job for another declaration. A cancellation naming another declaration's job is
reported as `job-not-found`, so the operation does not disclose that job's existence.

**`scheduled_job_list` carries `scheduler.read`, not `scheduler.manage`.** The compiler's own
invariant (§ Compiler, `annotation-contradiction`) refuses a `read` execution class declaring a
capability that is not itself `.read`-suffixed — the same rule every other read/write pair in this
contract already satisfies (`repo.read`; `host.pr.read` next to `host.pr.write`). One shared
`scheduler.manage` for all three tools would fail that check the moment the registry compiles, so
listing gets its own read-scoped capability while creation and cancellation keep the mutating one.
The `schedule` MCP/operator scope expands to both, so a session or token holding it can still reach
all three.

All three results are `untrustedOutput` because each returns caller-authored `ScheduledJob.input`
as inert data. The 4 MiB result cap matches the largest existing caller-selected-data precedent and
comfortably round-trips the initial schedulable operation's input; the list operation fails with the
ordinary result-size envelope rather than truncating jobs. A later contract amendment making a
larger-input operation schedulable must check this management cap at the same time.
Scheduler-management tools are not themselves schedulable, so holding one operation cannot be
turned into caller-authored sequencing.

### L2 — watcher

Declared in `src/watcher/watcher.ts`.

Constructed with `Dispatch` injected, exactly as the scheduler is. Every git and host step goes
through that dispatch, so the watcher depends on neither `GitOperations` nor `HostAdapter`.
`start` fails unless both deployment switches are on: remote operations permitted and watcher
enabled. No active declaration with a file watcher is a healthy idle state, not a startup error. Every
`tick` resolves the current active declarations before selecting work, so a declaration added or
amended at runtime becomes eligible on the next tick without restarting the watcher. A declaration's
`fileWatcher` remains the third, per-file authority condition: no file is claimed or processed for a
declaration that does not currently name one.

For a claimed file, the declaration-selected protocol is `planTool`, `prepare_branch`, `applyTool`,
the two post-apply observations and `git_stage` described under `### File watcher`, `git_commit`,
`git_push`, `pr_open`, then `pr_enable_auto_merge` when configured. The initial clean-tree
`repo_status` gate remains before claim, and the plan phase must succeed before the first mutating
repository step. Each name in that sequence is dispatched independently with no outer lock. Branch,
commit and pull-request fields come only from the validated plan result; the watcher does not derive
consumer naming conventions of its own.

### L3 — module adapter

Declared in `src/module-adapter/module-adapter.ts`.

The catalogue is populated by registration at composition time. It never imports a handler.

### L3 — http adapter

Declared in `src/http/http-adapter.ts`.

Its one consumer is published-URL verification of a managed repository, which is unauthenticated,
so the adapter takes no credential dependency and its L1-only dependency list stands.

**S12 resolves U1 for the http adapter's one operation and ships it.** Unlike `ModuleAdapter`, this
interface fixes no `register` method — one real consumer, fixed internally by the factory rather than
a pluggable catalogue, is what "its one consumer" above already says.

Declared in `src/http/http-adapter.ts`.

**The convention this operation reads is a lower-bound decision, not a design fact the brief or
`10-design.md` fixes anywhere:** the published URL is expected to answer a 200 whose JSON body carries
`commitSha` — the one shape this design already establishes for "a running thing's commit", since this
service's own `/healthz` answers `{ ready, commitSha }` (`surfaces/http-server.ts`, S2). A managed
repository's deploy is expected to expose the same shape at the URL declared for verification. Recorded
in `90-decisions.md` alongside the other slices' own U1 lower-bound choices.

`verify_published_url`'s registry entry:

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `verify_published_url` | `{ kind: 'http', operation: 'verify-published-url' }` | `['host.checks.read']` | `['read']` | `read` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 4096 }` |

`host.checks.read` is the capability `10-design.md`'s own capability table already maps to "check
status, bounded waits, deploy status, **published-URL verification**" — no new capability was needed.

**S12 also wires the dispatch pipeline and boot's B5 check for `http`-targeted entries**, both
previously refusing every such entry unconditionally (`dispatch/dispatch-pipeline.ts`'s own prior
comment: "http-targeted tools are not dispatched until an http adapter exists"; `lifecycle/boot.ts`'s
own prior comment: "an http-targeted entry has no adapter to check against yet and is not examined
here"). Neither file is named in S12's `Touches` line in `30-slices.md`, but both already carried a
forward reference naming exactly this slice as the one that fills them in, and `verify_published_url`
is unreachable dead weight in the compiled registry without both changes — the same reasoning that
justified amending `git_commit` above.

### L4 — dispatch pipeline

Declared in `src/dispatch/dispatch-pipeline.ts`.

This is where a call acquires its authority and its locks, and three invariants name it as
responsible. The epoch check runs before every handler invocation, and a moved epoch forces a
recomputation that can only narrow — **A3** with **A2**. `visibleTools` and `dispatch` apply the *same*
predicate: a tool absent from the first returns `authorization` from the second and never reaches a
handler — **A9**. That is one predicate written once, not two that must be kept in agreement.

The pipeline mints the `operationId`; no caller supplies one. That is what makes **R1** enforceable —
`Journal.begin` commits before the first side effect, against an identifier the caller could not have
pre-registered.

`visibleTools` is what `tools/list` returns and what the console filters views against. A tool the
session may not call is absent from it, not merely refused by `dispatch`.

`declarationId` is the declaration the call is against: the session binding for `mcp` and
`watcher`, the route for `operator`, the job for `scheduler`. It is null for an instance-scoped
call, whose target — where it has one — arrives inside `input`. `scheduledJobId` travels by value,
as `actorRef` does, and the pipeline stamps it onto the journal entry it creates; no caller
supplies an `operationId`.

### L4 — authorization

Declared in `src/authorization/authorization.ts`, with its records in `src/authorization/types.ts`.

Every method here is shaped by **S6** and **S7**: a token value exists only in the `IssuedToken`
returned at issue, and revocation writes a timestamp rather than deleting a row. Nothing in this
interface can return a stored token value, because none is stored.

`revokeBearerToken` is `/oauth/revoke`'s (RFC 7009) one call: the client presents the opaque value it holds, not the `TokenId` it was never given, so revocation has to resolve by hash the same way `establishMcpSession` and `refresh` already do rather than by id.

`recomputeSessionGrant` is synchronous and total, and its result is always a subset of the session
it was handed. `grantIsLive` walks the cascade upward at check time; nothing writes a cascade as a
batch, so there is no partially applied revocation to recover from.

`issueMcpGrant` is the one durable write the authorization-code flow performs. Everything ahead of
it — the pending-authorization record, the PKCE challenge, the issued authorization code — is
surface-owned and ephemeral (see `### L5 — surfaces` below), the same way a login form's CSRF token
is never a store row. `getClient` is what lets `/oauth/authorize` (`GET`) check a presented
`redirect_uri` against the client's own registered list before a `PendingAuthorization` is ever
created — the redirect-URI check named below has to read the same row `registerClient` wrote, not
merely compare the value against itself at token-exchange time. By the time a surface calls
`issueMcpGrant`, PKCE verification, redirect-URI matching and client validation have already happened; the method's only job is minting the durable
`Grant` (`kind: 'mcp'`) and its access/refresh `Token` pair, which is what lets a client reconnect
after a container restart without re-authorising (S14.7). A grant is never re-issued for the same
authorization code — the surface layer deletes the ephemeral code before calling this method, so a
replay finds no code to exchange rather than reaching the store twice.

`expandScopes` is exported and crosses a module boundary — `src/contract/tool-parity.ts` calls it to
compute the widest grant an `mcp` session can hold. It must stay exported for that reason: the parity
harness measuring what a profile can see has to use the same expansion a real session is built with,
because a second description of the mapping is a second thing to keep correct and the first thing to
go stale. It is synchronous, total, and adds nothing — its result is a subset of the contract set for
every input, including an empty scope array and a scope carrying a capability this deployment never
registered.

The mapping it applies is fixed under `### Scopes` above, and **that is where a change to it belongs**;
this signature carries no policy of its own. Two things a caller may not assume. It is not a
membership test against `ToolDeclaration.scopes`, which nothing at dispatch reads — a tool declaring
no capabilities is gated by no scope at all, whatever its `scopes` field says. And its totality is
load-bearing rather than incidental: a capability the rule cannot place must fail the build (**A10**),
never fall through to an empty grant, because an unplaceable capability that merely expands to nothing
is indistinguishable at runtime from one the resource owner declined to grant.

### L4 — operator identity

Declared in `src/operator-identity/operator-identity.ts`.

`EnrolmentResult` is the only place the TOTP secret and the recovery codes exist in the clear, and
it is returned exactly once. The store holds hashes.

### L0 — contract types and compiler

Declared in `src/contract/compiler.ts`, over the types in `src/contract/tool-declaration.ts`.

The compiler is build-time only and is not present at runtime.

### L5 — surfaces

Surfaces expose nothing inward. Three things about them are contract-level rather than
implementation.

`LivenessReport`, `VersionReport` and `HealthReport` are declared in `src/surfaces/http-server.ts`.

`MCP_RESOURCE_URI_TEMPLATE` has no named declaration in the tree. The template it fixes —
`/mcp/{declarationId}` — is enforced by `MCP_RESOURCE_URI_PATTERN` in `src/shared/brands.ts`, which is
`mcpResourceUri()`'s own rule, and constructed at the two call sites in `src/surfaces/mcp-routes.ts`.
The pattern is the authority; the template is how to read it.

`LivenessReport` is the **only** payload served without authentication, on `/healthz`. It carries
readiness and the running commit and nothing else. `VersionReport` and `HealthReport` are
authenticated console routes: the fingerprints, the chain state, the failing credential references
and the volume breakdown are all operator data, and item 15's companion check reaches the catalogue
through an authenticated `tools/list` rather than through the probe.

A bearer route accepts no cookie and a cookie route accepts no bearer — **E6** — except for the four
rows S34 marks `bearer or cookie`, explained beneath the table below.

**Three paths were fixed ahead of the route table because they already shipped**: `LivenessReport` on
`GET /healthz` unauthenticated, `VersionReport` on `GET /version`, and `HealthReport` on `GET /health`.
They are externally observable — an operator's monitoring binds to them — so U4, resolving later, had
to accept them rather than rename a live endpoint. It did; they appear unchanged in the first block of
the table that follows.

#### The HTTP API route table (resolves U4, S18.1/S18.14)

Every row states its method, which of the two credentials it accepts — `none` for a route
authenticated by a one-time secret or a body-carried token rather than by session, `cookie` for
the operator console session plus CSRF, `bearer` for `Authorization: Bearer` — and whether it
carries a repository dimension: a `:declarationId` (or the equivalent path segment) naming the one
repository the call acts on. `console.manage`-style capability names are not repeated here; they
are `20-contract.md` § Capabilities and the lattice's, and this table only fixes paths, methods and
credentials, per U4's own scope.

**`bearer or cookie` is a third credential value, added by S34.** Every route fixed before S34
accepts exactly one of the two — a bearer route rejects a cookie and a cookie route rejects a
bearer, both demonstrated end to end by S18.10 — and that split holds everywhere this value does
not appear. The four rows it does mark (`/health`, `/parked-operations`, its `/resolve` and
`/failing-credentials/.../clear`) predate the console's health and parked-operations views: they
were bearer-only because nothing but a script had ever called them. S34 gives the operator console
its own reason to call the same routes, and duplicating each as a second cookie-only path would
mean two implementations of one read or one mutation to keep in sync, which is the drift this
amendment avoids instead. A bearer credential on one of these four is checked exactly as before,
capability included; a cookie is accepted as an authenticated operator session with no capability
gate, the same as every other cookie route, and a mutating request over cookie still requires the
double-submit CSRF token — a bearer request never does, since it carries no ambient cookie for
CSRF to defend. Presenting neither, or a cookie failing its CSRF check, is refused exactly as a
plain cookie route refuses it today.

**Liveness, version and health** — no repository dimension. Fixed above this table because they
already shipped ahead of it.

| Path | Method | Credential |
|---|---|---|
| `/healthz` | `GET` | none |
| `/version` | `GET` | bearer |
| `/health` | `GET` | bearer or cookie |

**Authentication (`console-auth-routes.ts`)** — no repository dimension. An operator session has no
repository binding (`design/10-design.md` § Operator drives the console, step 2); it narrows per
call against whichever declaration a later request names, not at sign-in.

| Path | Method | Credential |
|---|---|---|
| `/auth/enrol` | `POST` | none (provisioning secret) |
| `/auth/login` | `POST` | none (password + TOTP) |
| `/auth/login/recovery-code` | `POST` | none (password + recovery code) |
| `/auth/login/break-glass` | `POST` | none (break-glass token) |
| `/auth/login/oidc` | `GET` | none (redirects to the configured issuer) |
| `/auth/login/oidc/callback` | `GET` | none (the issuer's redirect back, carrying `code` and `state`) |
| `/auth/totp-reenrol/begin` | `POST` | cookie |
| `/auth/totp-reenrol/complete` | `POST` | cookie |
| `/auth/session` | `GET` | cookie |
| `/auth/logout` | `POST` | cookie |

**Declarations (`declaration-routes.ts`, and `tool-routes.ts` for the two `/tools` rows)** — the landing view's feed and declaration management.
Listing and creating a declaration carry no repository dimension (there is nothing yet to bind to,
or the call spans every declaration); every route naming an existing declaration's id does.

| Path | Method | Credential | Repository dimension |
|---|---|---|---|
| `/declarations` | `GET` | cookie | no |
| `/declarations` | `POST` | cookie | no |
| `/declarations/{declarationId}` | `GET` | cookie | yes |
| `/declarations/{declarationId}` | `PATCH` | cookie | yes |
| `/declarations/{declarationId}` | `DELETE` | cookie | yes |
| `/declarations/{declarationId}/orphan` | `POST` | cookie | yes |
| `/declarations/{declarationId}/clone` | `DELETE` | cookie | yes |
| `/declarations/{declarationId}/tools` | `GET` | cookie | yes |
| `/declarations/{declarationId}/tools/{toolName}` | `POST` | cookie | yes |

**Grants and authorization (`authorization-routes.ts`)** — the grants view (S32). No repository
dimension: a client, grant, operator API token or operator session is not scoped to one
declaration in its path, even where the underlying grant itself narrows to one.

| Path | Method | Credential |
|---|---|---|
| `/grants` | `GET` | cookie |
| `/grants/tokens` | `POST` | cookie |
| `/grants/{grantId}/revoke` | `POST` | cookie |
| `/tokens/{tokenId}/revoke` | `POST` | cookie |
| `/clients/{clientId}/revoke` | `POST` | cookie |
| `/operator-sessions/{sessionRef}/revoke` | `POST` | cookie |

**Attention and health administration (`http-server.ts`)** — the parked-operations and
failing-credential views (S8, S9, S34). `/parked-operations*` spans every declaration in its
listing and resolves by `operationId`, which is not itself a repository dimension; clearing a
failing credential names the declaration it was recorded against directly in its path. The two
`/notifier/failed*` rows are new with S34: the health view's failed-outbox list and its own way
out, which had a `Notifier` member (`clearFailed`) but no route before this slice.

| Path | Method | Credential | Repository dimension |
|---|---|---|---|
| `/parked-operations` | `GET` | bearer or cookie | no |
| `/parked-operations/{operationId}/resolve` | `POST` | bearer or cookie | no |
| `/failing-credentials/{credentialRef}/{declarationId}/clear` | `POST` | bearer or cookie | yes |
| `/notifier/failed` | `GET` | cookie | no |
| `/notifier/failed/{id}/clear` | `POST` | cookie | no |

**Audit trail (`audit-routes.ts`)** — the audit view (S33), under `audit.read`. No repository
dimension: `declarationId` narrows the query as a filter, the same as `tool` and `actorSubject`,
rather than naming the one repository the call acts on — a query with none set spans every
declaration's trail, which a path segment could not express.

| Path | Method | Credential |
|---|---|---|
| `/audit` | `GET` | cookie |

**OAuth and the MCP transport** — see the table immediately below (resolves U5). No repository
dimension except the protected-resource metadata document and the MCP transport itself, both of
which name a `declarationId` directly in their path; `/oauth/authorize`'s `GET` step also carries a
`resource` query parameter naming one, but the table below classifies routes by path rather than by
query, consistent with every other row here.

**The closed set, and the count S18.14 asks for.** Twenty-eight routes above carry no repository
dimension — the three liveness/version/health routes, the six authentication routes, the two
declaration listing/creation routes, the six grants/authorization routes, the two
parked-operations routes, the two `/notifier/failed*` routes, `/audit`, and the six no-dimension
OAuth/MCP routes below (`/.well-known/oauth-authorization-server`, `/oauth/register`,
`/oauth/authorize` ×2 methods, `/oauth/token`, `/oauth/revoke`). This is the closed set; nothing
may be added to it without a contract amendment naming why the new route has no repository to
scope to. The remaining ten routes each carry a `declarationId` (or the equivalent —
`/failing-credentials/{credentialRef}/{declarationId}/clear`'s second segment) directly in their
path: the seven declaration-management and tool routes above, `/failing-credentials/.../clear`, the
protected-resource metadata document, and the MCP transport itself. Thirty-eight routes in total.

#### OAuth endpoints and the MCP transport (resolves U5)

These two stay written out rather than becoming pointers, because there is no declaration in the tree
to point at. Both are **wire shapes fixed by RFC**, not internal types: they are served as object
literals from `src/surfaces/mcp-routes.ts` at `/.well-known/oauth-protected-resource/mcp/{id}` and
`/.well-known/oauth-authorization-server`, and asserted from the outside by
`src/surfaces/mcp-routes.test.ts`. The snake_case member names are the RFCs', which is the clearest
signal that what is fixed here is a document a third-party client parses rather than a type this
service passes around. `SUPPORTED_SCOPES` in that file is what fills `scopes_supported`.

```ts
interface ProtectedResourceMetadata {
  readonly resource: McpResourceUri;
  readonly authorization_servers: readonly [string];
  readonly scopes_supported: readonly McpScope[];
  readonly bearer_methods_supported: readonly ['header'];
}

interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint: string;
  readonly revocation_endpoint: string;
  readonly response_types_supported: readonly ['code'];
  readonly grant_types_supported: readonly ['authorization_code', 'refresh_token'];
  readonly token_endpoint_auth_methods_supported: readonly ['none'];
  readonly code_challenge_methods_supported: readonly ['S256'];
  readonly scopes_supported: readonly McpScope[];
}
```

| Path | Method | Auth | Carries |
|---|---|---|---|
| `/.well-known/oauth-protected-resource/mcp/{declarationId}` | `GET` | none | `ProtectedResourceMetadata` for that declaration's resource URI |
| `/.well-known/oauth-authorization-server` | `GET` | none | `AuthorizationServerMetadata`, one server for the whole instance |
| `/oauth/register` | `POST` | none | Dynamic Client Registration (RFC 7591) — wraps `registerClient` |
| `/oauth/authorize` | `GET`, `POST` | operator console cookie | The approval step; issues a short-lived, process-local authorization code bound to a PKCE `code_challenge` (S256) and the `resource` being granted. Ephemeral — a restart mid-flow means starting over, not a re-authorization of an already-connected client |
| `/oauth/token` | `POST` | none (PKCE substitutes for a client secret) | `authorization_code` grant (with `code_verifier`) calls `issueMcpGrant`; `refresh_token` grant calls `refresh` |
| `/oauth/revoke` | `POST` | bearer | Revokes the presented token via `revokeBearerToken` (RFC 7009) |
| `/mcp/{declarationId}` | `POST` | bearer, audience-checked against the path | The MCP JSON-RPC transport: `initialize`, `tools/list`, `tools/call`, and JSON-RPC notifications |

**A body carrying no `id` member is a JSON-RPC notification, and is answered `202 Accepted` with no
body.** Two things about that are load-bearing and neither is recoverable from the tree.

The status is `202`, not `204`. MCP's Streamable HTTP transport fixes it, and clients branch on that
exact number rather than on the 2xx class — the official SDK client starts its server-initiated
stream for `notifications/initialized` only inside its `202` arm, so a `204` is a silent protocol
downgrade rather than an equivalent answer. A notification is the one message a JSON-RPC peer must
never receive a response to, and `notifications/initialized` is the one the MCP spec has every client
send immediately after `initialize`, so answering it as an unknown method aborts the connection
before `tools/list` is ever reached.

The accept sits **below** live-session resolution and the repository-binding check, never above them.
A notification is not an exemption from either, and accepting one before them would make an omitted
`id` an unauthenticated 2xx entrypoint on a route that exposes repository state — **E8**. `initialize`
is a request and never a notification: one arriving without an `id` is accepted and dropped rather
than minting a session whose result has no `id` to answer. See `design/90-decisions.md`, 2026-08-31.

A `401` from `/mcp/{declarationId}` — audience mismatch, unknown/expired/revoked token or grant —
answers `WWW-Authenticate: Bearer realm="subzerodev-git", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp/{declarationId}"`
and no `ToolResult` envelope, per `AuthorizationError`'s first nine variants (`## Error semantics`
above). Only the operator console's own cookie session may approve `/oauth/authorize` — the same
authenticated-operator gate `console-auth-routes.ts` already uses elsewhere, not a new one.
`/oauth/authorize` and `/oauth/register` are unauthenticated by transport (registration and the
initial approval redirect have no token yet) but bounded: a deployment-fixed cap on pending
authorizations and registered clients keeps an unauthenticated caller from growing either without
bound, mirroring the prior art's `MAX_PENDING_AUTHORIZATIONS` / `MAX_REGISTERED_CLIENTS`
(`SubZeroDev.Blog/tools/blog-mcp/src/serve/oauth.ts`).

**No route handler may take the process down.** An unhandled rejection in a handler is fatal to the
service, which would hand anyone able to make one throw the same power that refusing to start on a
corrupt trail would. Every surface catches at the handler boundary and answers `500`.

---

## Error semantics

Every module's failures are an enumerated union. No module throws as control flow, and no module
returns a bare `Error` or a string in an error position. Each variant declares the `ResultKind` the
pipeline maps it to, so the envelope's generating rule is applied once rather than per call site.

```ts
interface ModuleErrorBase {
  readonly resultKind: ResultKind;
  readonly retryable: boolean;
  readonly summary: string;
}
```

**Terminal modules are the exception, and there are exactly two.** The dispatch pipeline and the
http adapter return a `ToolResult` rather than an error, because nothing sits above them to do the
mapping — the pipeline is where the generating rule is *applied*, and the http adapter's one
consumer reaches it only through the pipeline. A union for either would be a value constructed
solely to be translated on the next line, and the translation would still be written per call site,
so it buys the indirection without the property. Their failure sets are closed all the same, and
each member's envelope is fixed in their sections below; a refusal added to either without a row
there is the drift this exception makes checkable. Everything else on this page declares a union.

### Exec

```ts
type ExecError = ModuleErrorBase & (
  | { readonly code: 'spawn-failed' }
  | { readonly code: 'nonzero-exit'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly code: 'timed-out'; readonly limitSeconds: number }
  | { readonly code: 'argv-rejected'; readonly rule: string }
  | { readonly code: 'cancelled' }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `spawn-failed` | The fixed executable could not be started | no | `infrastructure` — the environment is wrong, not the request |
| `nonzero-exit` | The child exited non-zero; `stdout` and `stderr` are already scrubbed | no | Classify by domain: auth rejection to `upstream`, a refused push to `precondition`; informational commands retain both streams for diagnosis |
| `timed-out` | The declared cap elapsed and the child was killed | no | `timeout`, and park the journal entry — what the command achieved is not knowable |
| `argv-rejected` | The vector selects an executable, injects or writes configuration, carries credentials or a foreign or opaque remote operand, names a remote-helper transport (`<transport>::<address>`), or persists a remote | no | `validation`; no authority could ever permit it |
| `cancelled` | The caller's signal aborted | no | `conflict`, releasing locks in reverse acquisition order |

### Locks

```ts
type LockError = ModuleErrorBase & (
  | { readonly code: 'acquire-timeout'; readonly holder: LockHolder | null }
  | { readonly code: 'queue-full'; readonly depth: number }
  | { readonly code: 'admission-refused'; readonly limit: 'per-session-waits' | 'process-lock-free' }
  | { readonly code: 'cancelled' }
);
```

All four map to `conflict` and none is retried inside the service — from the caller's side they are
the same thing, come back later. `acquire-timeout` names the holding operation and its repository,
which is what makes the refusal actionable rather than mysterious.

### Declarations

```ts
type DeclarationError = ModuleErrorBase & (
  | { readonly code: 'not-found' }
  | { readonly code: 'already-exists' }
  | { readonly code: 'immutable-field'; readonly field: string }
  | { readonly code: 'remote-host-not-allowed'; readonly host: RemoteHost }
  | { readonly code: 'capability-outside-ceiling'; readonly capabilities: readonly CapabilityName[] }
  | { readonly code: 'capability-unsupported-by-host'; readonly capabilities: readonly CapabilityName[] }
  | { readonly code: 'watcher-tool-not-annotated'; readonly tool: RegistryToolName; readonly expected: Exclude<FileWatcherPhase, false> }
  | { readonly code: 'watcher-plan-schema-mismatch'; readonly planTool: RegistryToolName; readonly applyTool: RegistryToolName }
  | { readonly code: 'adoption-refused'; readonly blockers: readonly EvictionBlocker[] }
  | { readonly code: 'remote-mismatch'; readonly declared: CloneUrl; readonly observed: CloneUrl }
  | { readonly code: 'clone-still-present' }
  | { readonly code: 'watcher-directory-not-empty'; readonly files: number }
  | { readonly code: 'not-orphaned' }
  | { readonly code: 'store-failed'; readonly cause: StoreError }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `not-found` | No declaration for the id, or none in the named generation | no | `precondition` |
| `already-exists` | Declaring an id that is already `active` | no | `precondition` |
| `immutable-field` | An amend touches `id`, `generation`, `host` or `state` | no | `validation` |
| `remote-host-not-allowed` | `cloneUrl`'s host is off the deployment allowlist | no | `validation`. This is the second, independent guard against credential redirection |
| `capability-outside-ceiling` | A grant names a capability the ceiling lacks | no | `validation` |
| `capability-unsupported-by-host` | A `generic` declaration is granted a `host.*` capability | no | `validation` |
| `watcher-tool-not-annotated` | A configured plan or apply tool is absent or does not carry the expected phase annotation | no | `validation` |
| `watcher-plan-schema-mismatch` | The configured plan output and apply input use different canonical schemas for `plan` | no | `validation` |
| `adoption-refused` | Re-declaring an id whose orphaned clone is not clean, across every generation | no | `precondition` naming the blockers. The exit is to push the work, then `clone.remove` |
| `remote-mismatch` | The orphaned clone points at a different remote | no | `precondition`. Never repoint an existing checkout |
| `clone-still-present` | `declaration.remove` while a clone remains | no | `precondition` naming `clone.remove` |
| `watcher-directory-not-empty` | `declaration.remove` while the inbox holds files | no | `precondition` |
| `not-orphaned` | `declaration.remove` on an `active` declaration | no | `precondition` |
| `store-failed` | The underlying write failed | only if the cause is | `infrastructure`, after the store's own bounded retry |

### Credentials

```ts
type CredentialError = ModuleErrorBase & (
  | { readonly code: 'reference-not-found'; readonly ref: CredentialRef }
  | { readonly code: 'reference-unreadable'; readonly ref: CredentialRef }
  | { readonly code: 'host-not-permitted'; readonly ref: CredentialRef; readonly host: RemoteHost }
  | { readonly code: 'marked-failing'; readonly mark: CredentialFailureMark }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `reference-not-found` | No file in the mount matches the reference name | no | `precondition` naming the reference and the declaration, never a value |
| `reference-unreadable` | A secret or username file exists and cannot be read, or the username is empty or contains CR, LF or NUL | no | `infrastructure` |
| `host-not-permitted` | The reference's own allowed-host constraint excludes the remote | no | `authorization` |
| `marked-failing` | The reference is marked failing for this declaration | no | `upstream`. The mark clears when the resolver observes a changed secret, or by hand from the health view |

Nothing here ever retries with a different credential.

### Structured store

```ts
type StoreError = ModuleErrorBase & (
  | { readonly code: 'busy'; readonly attempts: number }
  | { readonly code: 'corrupt'; readonly newestSnapshot: BackupStamp | null; readonly newestPreMigrationBackup: BackupStamp | null }
  | { readonly code: 'migration-failed'; readonly version: number; readonly backupAt: IsoUtcTimestamp }
  | { readonly code: 'io-failed' }
  | { readonly code: 'constraint-violated'; readonly constraint: string }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `busy` | SQLite reported busy past the bounded retry | already retried | `infrastructure`; the transaction rolled back |
| `corrupt` | The boot integrity check failed | no | Refuse to start, naming the newest snapshot **and its age** alongside the pre-migration copy. The two are for different failures and must not be conflated |
| `migration-failed` | A migration step failed | no | Refuse to start. The backup taken first is item 18's rollback target |
| `io-failed` | A syscall failed | no | Fatal at boot, `infrastructure` at runtime |
| `constraint-violated` | A `CHECK` or unique index rejected a write | no | `infrastructure`. This is a defect, not a caller error |

### Clone store

```ts
type CloneStoreError = ModuleErrorBase & (
  | { readonly code: 'clone-failed'; readonly cause: ExecError }
  | { readonly code: 'clone-timeout'; readonly limitSeconds: number }
  | { readonly code: 'remote-mismatch'; readonly declared: CloneUrl; readonly observed: CloneUrl }
  | { readonly code: 'corrupt-tree' }
  | { readonly code: 'not-safe-to-evict'; readonly blockers: readonly EvictionBlocker[] }
  | { readonly code: 'not-safe-to-remove'; readonly blockers: readonly EvictionBlocker[] }
  | { readonly code: 'disk-full'; readonly usage: VolumeUsage; readonly evictionBlockers: readonly EvictionBlocker[] }
  | { readonly code: 'recovery-pending' }
  | { readonly code: 'needs-attention'; readonly reason: string }
  | { readonly code: 'store-failed'; readonly cause: StoreError }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `clone-failed` | The initial clone exited non-zero | no | `upstream`. The partial directory is removed and the clone is `absent` |
| `clone-timeout` | The clone cap elapsed | no | `timeout`. Partial directory removed under the materialisation lock |
| `remote-mismatch` | `observedRemote` differs from `cloneUrl` at materialisation | no | `precondition`. Never repoint |
| `corrupt-tree` | A safety-relevant git probe over the clone could not be run, so the tree's state cannot be established. The state is never inferred from a failed probe — a command that cannot run is not evidence of safety | no | `precondition` naming `clone.remove` with its override as the exit |
| `not-safe-to-evict` | The interlock refused | no | Report the blockers. The space request is refused; the work is never discarded |
| `not-safe-to-remove` | `clone.remove` refused | no | `precondition`. Making the work pushable is the exit; making it discardable is not |
| `disk-full` | The refuse watermark blocked an operation needing space | no | `precondition` naming which of the five consumers holds the volume, with the store broken down by table, and the declarations blocking eviction |
| `recovery-pending` | A mutation was attempted before the lazy pass reached this declaration | no | Run recovery first. Reads are unaffected |
| `needs-attention` | A parked entry blocks ordinary mutations | no | `precondition`. Reads, and the repair session under `attention.resolve`, still work |
| `store-failed` | A metadata write failed | only if the cause is | `infrastructure` |

### Journal

```ts
type JournalError = ModuleErrorBase & (
  | { readonly code: 'intent-write-failed'; readonly cause: StoreError }
  | { readonly code: 'prestate-capture-failed'; readonly cause: CloneStoreError }
  | { readonly code: 'read-failed'; readonly cause: StoreError }
  | { readonly code: 'entry-not-found'; readonly operationId: OperationId }
  | { readonly code: 'invalid-transition'; readonly from: JournalEntryState; readonly to: JournalEntryState }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `intent-write-failed` | The intent record could not be written | no | **Abort the operation before acting.** Return `infrastructure` with no side effects — an unrecoverable mutation is worse than a refused one |
| `prestate-capture-failed` | Git state could not be observed under the lock | no | Abort, as above |
| `read-failed` | An unsettled, parked or scheduled-job lookup could not read the store | only if the cause is | Fail closed: boot reports `store-failed`, and recovery or scheduling must not treat the result as an empty set |
| `entry-not-found` | A step, settle or park names an unknown operation | no | `infrastructure`. A defect |
| `invalid-transition` | `settled` to anything, or `attention` to `applied` | no | `infrastructure`. A defect |

`classify` has no error type. It is total: an entry it cannot classify returns
`{ verdict: 'park' }`, including when `descriptor` is null.

### Recovery catalogue

```ts
type RecoveryCatalogueError = ModuleErrorBase & (
  | { readonly code: 'duplicate-registration'; readonly tool: RegistryToolName }
);
```

Raised only at composition time and fatal there. A missing descriptor is not an error of this
module — `lookup` returns `null` and the recovery ladder parks the entry.

### Audit

```ts
type AuditError = ModuleErrorBase & (
  | { readonly code: 'query-failed' }
  | { readonly code: 'segment-unreadable'; readonly segment: number }
  | { readonly code: 'chain-broken'; readonly at: AuditChainBreak }
);
```

`append` has no error type: it returns `AuditAppendOutcome` and never throws. Exactly two callers
read that outcome differently:

| Caller | On `appended: false` |
|---|---|
| The `git.raw` **intent** line | **Abort before the child process starts.** A hatch use the service cannot record must not run |
| Everything else, including the `git.raw` **outcome** line | Proceed. A logging failure never fails the call it describes |

`chain-broken` is surfaced in the health view and the audit view and is **never fatal**. Refusing to
start on a corrupt trail would hand anyone able to corrupt it a way to stop the service.

All three variants carry `resultKind: 'infrastructure'`. None is a caller's fault: a query that
cannot read a segment, or a chain that does not verify, says something about the volume rather than
about the request, and `isError` is true for all three accordingly.

`verify` and `chainState` return an `AuditChainState` and have **no error type at all** — they must
not throw, for the same reason `chain-broken` is not fatal. A trail so damaged that it cannot be
read reports a `chainBreak` describing that, rather than propagating an exception into whatever was
asking. That includes the case where the structured store holding the mirror is itself unreadable.

### Notifier

```ts
type NotifierError = ModuleErrorBase & (
  | { readonly code: 'no-transport-configured' }
  | { readonly code: 'delivery-failed'; readonly status: number | null; readonly attempts: number }
  | { readonly code: 'retries-exhausted'; readonly rowId: OutboxRowId }
  | { readonly code: 'row-not-found'; readonly rowId: OutboxRowId }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `no-transport-configured` | No webhook is set | no | The row stays `pending` and is surfaced in the health view |
| `delivery-failed` | Non-2xx or transport error | yes, bounded, with backoff | Nothing. Delivery never blocks the operation it describes |
| `retries-exhausted` | The bound was reached | no | Mark the row `failed` and surface it. Never drop it |
| `row-not-found` | The operator cleared a row that is already gone | no | `precondition` |

### Git operations

The twelve domain operations return `ToolResult`, so they have no separate error type. The two
non-operation members do:

```ts
type GitOperationsError = ModuleErrorBase & (
  | { readonly code: 'config-unparseable'; readonly findings: readonly Finding[] }
  | { readonly code: 'config-unreadable' }
  | { readonly code: 'no-clone' }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `config-unparseable` | The repository's config file exists and is not valid against its format | no | `precondition` with findings. **A missing file is not an error** — every field defaults |
| `config-unreadable` | The file exists and the read failed | no | `infrastructure` |
| `no-clone` | `ctx.cloneRoot` is null for a declaration-scoped operation that needs a clone | no | `infrastructure`. A defect: the pipeline materialises before invoking. A `fileWatcher: 'plan'` handler is pure and never reaches this — a null `cloneRoot` is what it is given |

`validateWritePath` returns `PathRejection`, not this type, because its three cases split across two
envelope kinds — see the boundary rules under `### L2 — git operations`.

### Host adapter

```ts
type HostError = ModuleErrorBase & (
  | { readonly code: 'unreachable' }
  | { readonly code: 'rate-limited'; readonly retryAfterSeconds: number }
  | { readonly code: 'server-error'; readonly status: number; readonly attempts: number }
  | { readonly code: 'auth-rejected'; readonly ref: CredentialRef; readonly declarationId: DeclarationId }
  | { readonly code: 'merge-conflict'; readonly pullRequest: PullRequestRef; readonly headSha: GitSha; readonly baseSha: GitSha }
  | { readonly code: 'required-check-failed'; readonly check: string; readonly pullRequest: PullRequestRef }
  | { readonly code: 'not-found'; readonly resource: string }
  | { readonly code: 'timed-out'; readonly limitSeconds: number }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `unreachable` | DNS, TLS or transport failure | not inside the call | `upstream` |
| `rate-limited` | The per-credential budget tripped, or the host said so | monitoring waits back off with jitter | `upstream` with a retry-after. **Never `precondition`** — an unavailable dependency is not a repository state |
| `server-error` | 5xx after up to three retries, **read operations only** | already retried | `upstream` |
| `auth-rejected` | The credential was refused | no | `upstream`, and mark the reference failing for **this declaration only** |
| `merge-conflict` | The pull request cannot merge | no — **terminal** | `precondition` naming the branch and both heads; the notifier fires. There is no rebase tool |
| `required-check-failed` | A declared required check concluded failure. `checks_await`'s judgement also refuses — without this variant — when it cannot establish whether a failure was required, or cannot attribute one to a pull request; see `### L2 — host adapter` | no — terminal | `precondition` naming the check and pull request; the notifier fires |
| `not-found` | The pull request, check or workflow does not exist | no | `precondition` |
| `timed-out` | A bounded wait reached its cap | no | `timeout`; the notifier fires |

**The three "the notifier fires" cells above are specified and not yet held.** No host terminal
state reaches the notifier on the ordinary dispatch path today, so on that path those three are
requirements rather than descriptions; boot recovery and the watcher do fire it. Tracked as issue
#49 — this paragraph goes when that closes. Recorded here because a reader cannot tell a rule the
tree holds from one it owes by reading either the rule or the tree.

### Scheduler

```ts
type SchedulerError = ModuleErrorBase & (
  | { readonly code: 'tool-not-in-registry'; readonly tool: RegistryToolName }
  | { readonly code: 'tool-not-schedulable'; readonly tool: RegistryToolName }
  | { readonly code: 'input-invalid'; readonly findings: readonly Finding[] }
  | { readonly code: 'job-not-found'; readonly id: ScheduledJobId }
  | { readonly code: 'job-not-pending'; readonly id: ScheduledJobId; readonly status: ScheduledJobStatus }
  | { readonly code: 'grant-revoked'; readonly grantId: GrantId }
  | { readonly code: 'grant-insufficient'; readonly missing: readonly CapabilityName[] }
  | { readonly code: 'store-failed'; readonly cause: StoreError }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `tool-not-in-registry` | The name does not exist — at creation, at fire time, or at boot re-validation | no | `validation` at creation; `needs-attention` naming the upgrade at boot |
| `tool-not-schedulable` | The named tool lacks the annotation | no | `validation` |
| `input-invalid` | The stored input fails the tool's schema, at any of the same three points | no | As above |
| `job-not-found`, `job-not-pending` | Cancelling a terminal job | no | `precondition` |
| `grant-revoked` | The creating grant or its client is revoked, checked at fire time | no | Move the job to `cancelled` with a reason naming the revocation. Never fire it, never silently drop it |
| `grant-insufficient` | Re-intersection at fire time lost a needed capability | no | `needs-attention` naming the missing capabilities |
| `store-failed` | The structured store could not be opened or written to | no | `infrastructure`, the same shape `JournalError`/`DeclarationError`/`AuthorizationError` already carry for the identical failure |

### Watcher

```ts
type WatcherError = ModuleErrorBase & (
  | { readonly code: 'not-permitted'; readonly missingSwitch: 'remote-operations' | 'watcher-enabled' }
  | { readonly code: 'watched-file-unreadable'; readonly file: WatchedFileName }
  | { readonly code: 'claim-failed'; readonly file: WatchedFileName }
  | { readonly code: 'step-failed'; readonly step: string; readonly result: ResultKind; readonly reason: string }
  | { readonly code: 'interrupted-claim'; readonly file: WatchedFileName }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `not-permitted` | Either deployment switch is off | no | Do not start. Both default off |
| `watched-file-unreadable` | A candidate cannot be read | no | Move it to `failed/`. A symlink is never a candidate in the first place |
| `claim-failed` | The rename into `processing/` failed | next tick | Leave the file in the inbox |
| `step-failed` | Any dispatched step returned a non-success envelope | no | Move to `failed/` with a sibling error file naming the step and its result. Never delete |
| `interrupted-claim` | A file sits in `processing/` at startup | **never reprocessed** | Move to `failed/` with an explanation — it may already have an open pull request |

There is no caller to return an envelope to. Every outcome above is audited, and every failure
notifies at `attention`.

### Module adapter and http adapter

```ts
type ModuleAdapterError = ModuleErrorBase & (
  | { readonly code: 'target-not-registered'; readonly target: ModuleTargetName }
  | { readonly code: 'duplicate-registration'; readonly target: ModuleTargetName }
);
```

`duplicate-registration` and `target-not-registered` are composition-time and boot-time faults and
are fatal there — boot verifies every registry operation has exactly one executor. Reaching one at
runtime is `infrastructure`.

**The http adapter is terminal and declares no union**, for the reason given under *Terminal
modules* at the head of this section: `invoke` returns a `ToolResult`, and there is no layer above
it to map an error into one. Its failure set is nonetheless closed, because it is the complete set
an unauthenticated GET can distinguish, and each member's kind is fixed here rather than left to a
call site:

| Failure | Envelope | Notes |
|---|---|---|
| The operation is not declared | `infrastructure` | Boot-time fault reached at runtime, exactly as the module adapter's is |
| Unreachable, or a non-2xx, or a 200 whose body carries no readable commit | `upstream` | |
| A 200 serving a commit other than the expected one | `precondition` | Naming both SHAs |
| The declared timeout elapsed | `timeout` | |

The four classifications of definition-of-done item 15 belong to the companion check and are not
reachable here.

### Dispatch pipeline

**Terminal, and declares no union**, for the reason given under *Terminal modules* at the head of
this section. The pipeline *is* the thing that produces the envelope, so an error type here would be
a value it constructs only to map to itself one line later. Its refusals are still a closed set, and
each one's envelope is fixed here rather than left to the call site that writes it:

| Refusal | Raised when | Retryable | Envelope |
|---|---|---|---|
| `tool-not-found` | A by-name call for a tool that does not exist | no | `authorization`, audited. A stale catalogue is worth seeing |
| `capability-insufficient` | The recomputed grant no longer admits the call | no | `authorization`, audited, no handler runs |
| `scope-insufficient` | The granted scopes do not cover the tool | no | `authorization`, audited |
| `declaration-required` | A declaration-scoped tool was called with no declaration in context | no | `validation` |
| `input-invalid` | The input fails the declared schema | no | `validation` with findings, before any handler runs |
| `output-invalid` | A handler returned something the output schema rejects | no | `infrastructure`. **Side effects already happened**; the journal records them, and this is the one place a caller sees an error after they landed |
| `result-too-large` | The result exceeds the declared limit | no | `infrastructure` |
| `grant-revoked` | The epoch check found the grant or its client revoked | no | **Close the session.** The transport answers `401` with the resource-metadata challenge, not an envelope — the caller must re-authorise rather than retry |

### Authorization

```ts
type AuthorizationError = ModuleErrorBase & (
  | { readonly code: 'token-unknown' }
  | { readonly code: 'token-expired' }
  | { readonly code: 'token-revoked' }
  | { readonly code: 'grant-revoked' }
  | { readonly code: 'client-revoked' }
  | { readonly code: 'audience-mismatch'; readonly expected: McpResourceUri }
  | { readonly code: 'resource-unknown'; readonly resource: McpResourceUri }
  | { readonly code: 'declaration-orphaned'; readonly declarationId: DeclarationId }
  | { readonly code: 'generation-stale'; readonly granted: Generation; readonly current: Generation }
  | { readonly code: 'registration-invalid'; readonly findings: readonly Finding[] }
  | { readonly code: 'store-failed'; readonly cause: StoreError }
);
```

The first nine are **transport-level `401` with a `WWW-Authenticate` resource-metadata challenge**
and never a `ToolResult` — the caller has to be told where to authenticate, and an envelope does
not say that. `registration-invalid` is a `400` on the registration endpoint. `store-failed` is a
`503`. None is retryable by the caller without re-authorising, except `store-failed`.

`ModuleErrorBase.resultKind` is still `authorization` for these: it is what the audit line records,
not what the transport returns.

### Operator identity

```ts
type OperatorIdentityError = ModuleErrorBase & (
  | { readonly code: 'not-provisioned' }
  | { readonly code: 'already-provisioned' }
  | { readonly code: 'provisioning-secret-invalid' }
  | { readonly code: 'credentials-invalid' }
  | { readonly code: 'totp-invalid' }
  | { readonly code: 'totp-key-unavailable' }
  | { readonly code: 'recovery-code-invalid' }
  | { readonly code: 'recovery-code-used' }
  | { readonly code: 'break-glass-invalid' }
  | { readonly code: 'oidc-unavailable'; readonly reason: 'discovery' | 'jwks' | 'signature' | 'validity-window' | 'state' | 'token-exchange' }
  | { readonly code: 'subject-not-allowlisted'; readonly subject: Subject }
  | { readonly code: 'session-unknown' }
  | { readonly code: 'session-expired' }
  | { readonly code: 'session-revoked' }
  | { readonly code: 'store-failed'; readonly cause: StoreError }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `not-provisioned` | Any console route except enrolment, before enrolment | no | `401`. Readiness still passes, because failing it would withhold traffic from the route that resolves the condition |
| `already-provisioned`, `provisioning-secret-invalid` | Enrolment after the file was burned, or with the wrong secret | no | `401`. The file's presence authorises nothing |
| `credentials-invalid`, `totp-invalid` | Local login | no | `401` with a reason. TOTP is enforced, not offered |
| `totp-key-unavailable` | The sealing key is absent or unreadable, so no TOTP code can be verified | by the operator, after restoring the key | `401` naming the missing key. **Never fatal at boot** — break-glass is the way back in, and it needs the service running |
| `recovery-code-invalid`, `recovery-code-used` | Recovery-code login | no | `401`. A successful use burns the code, audits, and forces TOTP re-enrolment |
| `break-glass-invalid` | The token is absent, stale or already consumed | no | `401`. Consumption is audited |
| `oidc-unavailable` | Discovery, JWKS, signature or validity-window failure | by the operator, later | `401` with a reason. **Local password plus TOTP still works** |
| `subject-not-allowlisted` | Federated login returned an unlisted subject | no | `401`, audited as `identity-event` `'oidc-subject-rejected'` (S31.2) |
| `session-unknown`, `session-expired`, `session-revoked` | A cookie presented against the persisted row | no | `401`. Invalidation is server-side, not a cleared cookie |

### Compiler

```ts
type CompilerError = ModuleErrorBase & (
  | { readonly code: 'duplicate-tool-name'; readonly name: RegistryToolName }
  | { readonly code: 'no-executor'; readonly name: RegistryToolName }
  | { readonly code: 'multiple-executors'; readonly name: RegistryToolName }
  | { readonly code: 'capability-scope-mismatch'; readonly name: RegistryToolName; readonly capability: CapabilityName }
  | { readonly code: 'schema-invalid'; readonly name: RegistryToolName; readonly findings: readonly Finding[] }
  | { readonly code: 'annotation-contradiction'; readonly name: RegistryToolName; readonly rule: string }
  | { readonly code: 'reserved-name'; readonly name: RegistryToolName }
  | { readonly code: 'limit-exceeds-cap'; readonly name: RegistryToolName; readonly cap: number }
  | { readonly code: 'capability-unscopable'; readonly name: RegistryToolName; readonly capability: CapabilityName }
);
```

Every variant **fails the build**. A warning is never sufficient — that is definition-of-done item
2, and the rejection counts it asks for are the counts of these.

`annotation-contradiction` covers a `read` execution class declaring a write capability, a
`monitoring-wait` declaring a mutating capability, and either file-watcher phase departing from the
target kind, execution class, capabilities, scopes or other annotations fixed under `ToolAnnotations`.
`schema-invalid` also covers a watcher plan or apply entry whose outer input or output schema does not
project the corresponding `FileWatcher*` type; pairing the two consumer-specific `plan` schemas is a
declaration check because the compiler receives registry entries but no `FileWatcherConfig`.
**Projection is exact**: the outer schema declares those properties, all of them required, and no
others. `TPlan` is the one sanctioned point of variation, so a sixth property on a plan output is a
different type rather than a richer one — and on either *input* schema it is worse than untidy,
because the watcher dispatches exactly the contract's fields and an entry requiring more could never
be dispatched successfully. Whether the two schemas additionally set `additionalProperties: false`
is left to the declaring package, as it is for every other entry.
`limit-exceeds-cap` covers a `monitoring-wait` whose `timeoutSeconds` exceeds
`monitoringWaitCapSeconds`, and any entry whose `maxResultBytes` or `timeoutSeconds` is not a
positive integer. There being no global `maxResultBytes` default is only a guarantee if a nonsense
limit fails the build rather than passing as an explicit choice. `cap` carries the bound the value
failed against, which for the ceiling is `monitoringWaitCapSeconds` and for a non-positive or
fractional limit is `1`, the smallest value either field admits. `cap` is therefore not always a
value the declaration exceeded — for `timeoutSeconds: 1.5` it is the nearest admissible one — and a
consumer that renders it must read it as "what this field accepts", never as "what you passed
exceeded this". The `summary` names the rule that was broken.

`capability-unscopable` is a declared capability that `### Scopes`'s rule cannot place in any of the
four scopes — in practice a `content.*` name whose final segment is neither `read` nor `write`, since
the nine fixed literals are placed by a closed table that cannot miss one. It exists because the
alternative failure is silent and was the defect that produced this variant: an unplaceable capability
expands to nothing, so the tool compiles, boots, and is invisible to every scope-bearing surface with
no error anywhere to read. `ContentCapability`'s type already rejects a malformed name written as a
literal; this variant is what catches one that reached the array as a widened `string`, which is the
only way a published consumer package can deliver one. It is **A10**'s enforcement, and the reason
A10 may be relied on without checking.

`no-executor` and `multiple-executors` are decided **within the declaration array alone**, because
`compile` receives nothing else and invariant B1 forbids L0 from importing the layer that
implements a target. `no-executor` is a declaration whose `ExecutionTarget` names an empty
identifier — nothing could ever execute it. `multiple-executors` is two or more declarations
claiming the identical target, by `kind` and identifier. Neither can detect a target that is
well-formed but unimplemented; boot does that, and it is boot that owns `executor-missing`.

Every `CompilerError` carries `resultKind: 'validation'`. A rejected declaration set is caller
input failing the contract — the envelope's own definition of `validation` — not a failure of the
service or its environment, so `isError` is false for all nine.

### Boot

```ts
type BootError = ModuleErrorBase & (
  | { readonly code: 'lease-held'; readonly holder: InstanceLease }
  | { readonly code: 'lease-not-exclusive' }
  | { readonly code: 'fingerprint-mismatch'; readonly expected: Sha256Hex; readonly found: Sha256Hex }
  | { readonly code: 'registry-unreadable'; readonly reason: string }
  | { readonly code: 'console-manifest-mismatch'; readonly expected: Sha256Hex; readonly found: Sha256Hex }
  | { readonly code: 'console-unreadable'; readonly reason: string }
  | { readonly code: 'ceiling-outside-contract'; readonly capabilities: readonly CapabilityName[] }
  | { readonly code: 'executor-missing'; readonly tools: readonly RegistryToolName[] }
  | { readonly code: 'watcher-revalidation-failed'; readonly cause: DeclarationError }
  | { readonly code: 'store-failed'; readonly cause: StoreError }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `lease-held` | A live instance holds the lease | no | Refuse to start, naming the holder from the lease contents |
| `lease-not-exclusive` | The child-process self-test was granted the same lock | no | **Fatal**, naming the volume configuration. This is the bind-mount case, and the alternative is two instances silently sharing one store |
| `fingerprint-mismatch`, `console-manifest-mismatch` | The artifact does not match what was built | no | Fatal. The service must never start with a smaller accidental tool set or a swapped bundle |
| `registry-unreadable`, `console-unreadable` | The registry or console artifact is absent, unparseable, or carries no valid fingerprint | no | Fatal, naming the reason. Distinct from a mismatch, which has two real digests to report; here there is nothing to compare, and reporting it as a mismatch would mean inventing them |
| `ceiling-outside-contract` | The deployment ceiling names a capability the contract set lacks | no | Fatal |
| `executor-missing` | A registry entry has no registered executor | no | Fatal |
| `watcher-revalidation-failed` | An active declaration's stored file-watcher pair is invalid against the registry loaded by this boot | no | Fatal, preserving the `DeclarationError` as `cause`; no transport starts under invalid declaration authority |
| `store-failed` | Open, integrity check or migration failed | no | Fatal, per the store's own table |

A broken audit chain is **not** in this list, deliberately.

---

## Invariants

Each holds at all times, is written so it could become an assertion, and names the module
responsible for maintaining it.

### Authority

| # | Invariant | Responsible |
|---|---|---|
| A1 | For every call, the effective set is a subset of `contract ∩ ceiling ∩ session`, and additionally of the declaration grant for every capability whose `capabilityScopeOf` is `declaration`. No code path adds a member to any of the four sets at runtime. | Declarations |
| A2 | `recomputeSessionGrant(s, d).grant` is a subset of `s.grant`, for all `s` and `d`. A recomputation can only narrow. | Authorization |
| A3 | `session.frozenAtEpoch === declaration.grantEpoch` is checked before every handler invocation; a moved epoch forces A2 before the handler runs. | Dispatch pipeline |
| A4 | `effectiveWritablePrefixes(d, p)` is a subset of `d.writablePathPrefixes` and contains no prefix under `p.strippedPathPrefixes`. No layer adds a prefix. | Declarations |
| A5 | `hostSupportedCapabilities('generic')` contains no `host.*` capability, and no declaration with `host === 'generic'` holds one. | Declarations |
| A6 | `git.raw` is in a declaration's grant only when written there explicitly. A newly declared repository does not have it. | Declarations |
| A7 | `declaration.manage`, `auth.manage`, `audit.read` and `attention.resolve` are absent from every profile whose kind is `mcp`, `scheduler` or `watcher`. | Authorization |
| A8 | No field of `RepositoryConfig` is a capability, scope, path prefix, credential reference, remote, host, timeout or limit. Any field a caller could set that widens what the service will do lives in `Declaration`. | Contract — re-checked at every amendment of `RepositoryConfig` |
| A9 | `visibleTools` and `dispatch` apply the same predicate. A tool absent from `visibleTools` returns `authorization` from `dispatch` and never reaches a handler. | Dispatch pipeline |
| A10 | Every capability in the contract set is placed in at least one scope by `### Scopes`'s rule. Equivalently: `expandScopes(['read','write','raw','schedule'], contract)` equals the declaration-scoped members of `contract`. A capability the rule cannot place fails the build as `capability-unscopable` rather than expanding to nothing. | Compiler, Authorization |

### Recovery and ordering

| # | Invariant | Responsible |
|---|---|---|
| R1 | For every mutating operation, `Journal.begin` commits before the first side effect. If it fails, no side effect occurs. | Dispatch pipeline, Journal |
| R2 | Every call mutating state outside the local clone calls `Journal.appendStep` and commits it before the call it describes. | Git operations, Composites |
| R3 | `Journal.classify` reads no git state and performs no I/O. The same three arguments always yield the same verdict. | Journal |
| R4 | `Journal.unsettled` selects on `(declarationId, generation)`. An entry from a previous era is never a candidate. | Journal |
| R5 | An entry whose `steps` contains an `applied` step never classifies as `nothing-happened`. | Journal |
| R6 | A `settle` carrying a `NotificationRequest` writes the outbox row and the state change in one transaction. | Journal, Structured store |
| R7 | No recovery path discards a commit, a stash, an untracked file or an unpushed branch. Recovery resumes or parks. | Lifecycle, Clone store |
| R8 | A resume step runs as an ordinary dispatch that takes the global mutation lock for itself, and completes before the triggering call acquires anything. It is never nested inside another operation's hold. | Lifecycle |
| R9 | `resolveRunningAtBoot` runs no resume step and performs no git or host I/O. | Scheduler |
| R10 | A `running` job is never simply fired again at boot. | Scheduler |

### Concurrency

| # | Invariant | Responsible |
|---|---|---|
| C1 | At most one mutation lock is held process-wide at any instant. | Locks |
| C2 | Whenever both are held, the materialisation lock was acquired before the mutation lock, and they are released in reverse order. | Dispatch pipeline |
| C3 | A mutating operation holds the materialisation lock for its whole duration; a read or a monitoring wait releases it once the clone is `ready`. A `fileWatcher: 'plan'` entry is the one exception: it needs no clone, so it acquires neither lock — see D11. | Dispatch pipeline |
| C4 | Eviction never runs while the mutation lock is held, and never for a declaration whose `activeOperationCount` is non-zero. | Clone store |
| C5 | `pinActiveOperation` never awaits and never fails. | Locks |
| C6 | Every monitoring wait's effective timeout is at most `monitoringWaitCapSeconds`, regardless of what was requested. | Dispatch pipeline, Compiler |
| C7 | At most one process holds the instance lease, and boot proves cross-process exclusion with a real child process before serving. | Lifecycle |
| C8 | A stdio process opens no volume, takes no lock and holds no clone. | Surfaces |

### Audit and secrets

| # | Invariant | Responsible |
|---|---|---|
| S1 | Every audit append passes through one writer. Sequence numbers are contiguous within a segment, and each record's `previousHash` equals its predecessor's `hash`. | Audit |
| S2 | A segment is never deleted before its terminal hash is written as a `RetainedAnchor`. | Audit |
| S3 | `Audit.append` never throws and never rejects. Only the `git.raw` intent line's caller treats `appended: false` as fatal to the call. | Audit, Git operations |
| S4 | A chain break is reported and never fatal. | Lifecycle |
| S5 | No secret value appears in a return type, a persisted row, a log line, an audit record, a `ToolResult`, or a process argument vector. A credential reaches only a child process's environment, by name. | Credentials, Exec |
| S6 | `Token` rows hold `verifierHash` and never a token value. `IssuedToken` is the only value-bearing type and is returned once. | Authorization |
| S7 | Revocation writes a timestamp. No revocation deletes a row, and no cascade is written as a batch — `grantIsLive` walks upward at check time. | Authorization |
| S8 | Every mutating call, every authorization rejection, every `git.raw` intent and outcome, every watched-file outcome, every identity event and every lease takeover produces an audit record. | Dispatch pipeline, Watcher, Operator identity, Lifecycle |
| S9 | `git.raw` appends its intent line, carrying the argument vector, before the vector is judged — and therefore before any child process starts. Every call that gets past that append writes an intent/outcome pair, a refused vector included; a failed intent append is the one case that writes neither, because it refuses the call (**S3**). | Git operations |

### Envelope and surfaces

| # | Invariant | Responsible |
|---|---|---|
| E1 | `result.ok === (result.kind === 'success')`. | Result |
| E2 | `isError(k)` is true exactly for `upstream`, `timeout` and `infrastructure`. | Result |
| E3 | Token, audience and issuer failures produce `401` with a resource-metadata challenge and never a `ToolResult`. | Surfaces, Authorization |
| E4 | Every read result's data carries a `ReadStamp` whose `mutationInFlight` is scoped to the declaration read, not to the process-wide mutex. | Git operations |
| E5 | No code path returns a published URL in a success position without a confirmed successful deploy for that exact commit. | Host adapter, Http adapter |
| E6 | Each route accepts exactly the credentials its row in § *L5 — surfaces* names. A route accepts both credentials only where its row is marked `bearer or cookie`, and marking a further row so is a contract amendment, never a table edit alone. | Surfaces |
| E7 | Every mutating cookie route requires an `Origin` check and a double-submit token. | Surfaces |
| E8 | No route exposing repository, credential, audit, volume or operator state is unauthenticated at any point in the lifecycle, enrolment included. `LivenessReport` on `/healthz` is the sole unauthenticated payload and carries only `ready` and `commitSha`. | Surfaces, Operator identity |

### Build and layering

| # | Invariant | Responsible |
|---|---|---|
| B1 | Nothing in L0, L3, L4 or L5 imports anything from L2, and the exemption names the composition root's files **by path, never by directory**, so widening it is a visible diff. Separately, no module value-imports a module in a higher layer; a type-only upward import holds only where the check itself lists it with its reason. | CI dependency-direction check |
| B2 | The module dependency graph is acyclic. The scheduler, the watcher and the lifecycle module receive `Dispatch` by injection; the module adapter and the recovery catalogue are populated by registration. | Composition root |
| B3 | Boot verifies the registry fingerprint and the console asset manifest, and refuses to start on a mismatch. | Lifecycle |
| B4 | The deployment ceiling is a subset of the contract capability set. Startup is fatal otherwise. | Lifecycle |
| B5 | Every registry entry has exactly one executor registered for its `ExecutionTarget`, verified at boot. | Lifecycle |
| B6 | `ScheduledJob.tool` names a registry entry annotated `schedulable`; `FileWatcherConfig.planTool` and `applyTool` name entries annotated for their respective phases, whose canonical `plan` schemas match. Checked at creation, at fire time, and at boot re-validation. | Scheduler, Declarations |
| B7 | No base tool name carries a `blog_` prefix, and no tool ships under a name intended for removal. | Compiler |
| B8 | The compiler is absent from the runtime image. | Build |

### Storage

| # | Invariant | Responsible |
|---|---|---|
| D1 | `Clone.state` is re-derived from disk at boot. The stored value is never trusted as a source of truth. | Clone store |
| D2 | Safe-to-evict is computed at eviction time and never persisted. | Clone store |
| D3 | `RepositoryConfig` is read from the working tree on every operation that needs it. Nothing caches it. | Git operations |
| D4 | Store retention ends in an incremental vacuum, and the maintenance pass reports bytes returned to the filesystem rather than rows deleted. | Structured store |
| D5 | Every retention window that prunes automatically has exactly one owning module, and the lifecycle module calls `runRetention` on each with no mutation lock held. | Lifecycle |
| D6 | During delivery and interrupted-claim recovery, a watched file is never deleted; every terminal path moves it to `processed/` or `failed/`. `Watcher.runRetention` may delete only files in `processed/` older than `processedFileDays`; it never deletes `failed/` files automatically. | Watcher |
| D7 | A candidate watched file is stat-ed link-preservingly, so a symlink is never a candidate. | Watcher |
| D8 | A file found in `processing/` at startup is moved to `failed/` and never reprocessed. | Watcher |
| D9 | The pre-migration copy is taken before any migration runs, and the three most recent are retained. | Structured store |
| D10 | At most one `declaration` row per id has `state = 'active'`. | Structured store |
| D11 | A file-watcher plan handler runs with no clone, no repository lock and no mutation journal, and no mutating repository step starts unless its output validates. | Dispatch pipeline, Watcher |
| D12 | A file-watcher apply result advances to staging only when an independent status observation reports exactly its declared changed paths and every path is inside both its plan and the effective watcher allowlist. | Watcher |
| D13 | File-watcher staging names exactly the independently observed changed paths; commit starts only after a second observation reports that exact set fully staged. | Watcher |
| D14 | A file-watcher apply handler validates every path it writes against the declaration's path allowlist before any side effect, whoever dispatched it. `permittedPaths` narrows that bound and never widens it. | Git operations, Watcher |
| D15 | Every watcher tick resolves the current active declarations. Zero active file-watcher declarations is healthy and idle; adding or amending one makes it eligible on the next tick without a watcher restart. | Watcher |

---

## Unresolved

The design doc does not determine the following. None of it may be invented by an implementing
agent; each needs a contract amendment before the work depending on it is sized or started.

**U1 — The registry tool inventory.** The design fixes the shape of a `ToolDeclaration`, which
capability covers which operation family, and the annotations a tool may carry. It does not name
the tools or fix their input and output schemas. The brief fixes only the naming policy —
operation-descriptive names, no `blog_` prefix on a base tool, a clean break at cutover — and gives
`git_commit` and `repo_declare` as examples. The `*Input` and `*Data` types referenced under
`### L2 — git operations`, `### L2 — composites` and `CreatePullRequestInput` carry only the fields
the design and brief determine, and are lower bounds rather than complete declarations.
**This blocks any slice that compiles a contract.**

*Narrowed 2026-08-08:* S6 resolves U1 for the five read operations — `repo_status`, `git_log`,
`git_branches`, `repo_health`, `git_diff` — their input and output types, and their registry
entries. See `### L2 — git operations` above. U1 otherwise stands: the seven mutating operations,
the two composites, and the host adapter's `CreatePullRequestInput` remain open for the slices that
ship them.

*Narrowed further 2026-08-08:* S7 resolves U1 for the three local mutating operations — `git_stage`,
`git_commit`, `git_restore_paths` — their output types and registry entries (their input types were
already fixed). See `### L2 — git operations` above. U1 otherwise stands: `push`, `fetch`,
`syncBase`, `raw`, the two composites, and `CreatePullRequestInput` remain open for the slices that
ship them.

*Narrowed further 2026-08-08:* S9 resolves U1 for the three remote operations — `git_push`,
`git_fetch`, `sync_base` — their input and output types and registry entries. See
`### L2 — git operations` above. U1 otherwise stands: `raw`, the two composites, and
`CreatePullRequestInput` remain open for the slices that ship them.

*Narrowed further 2026-08-08:* S10 resolves U1 for the host tools — `pr_open`, `pr_status`,
`pr_list`, `pr_comments`, `pr_enable_auto_merge`, `checks_status`, `checks_await` — their input and
output types and registry entries, `CreatePullRequestInput` included. See `### L2 — host adapter`
above. U1 otherwise stands: `raw` and the two composites remain open for the slices that ship them.
`readDeployStatus` remains an adapter method with no registry tool; S12 registers published-URL
verification through the HTTP adapter instead.

*Narrowed further 2026-08-09:* S12 resolves U1 for `prepare_branch`, `reconcile_after_merge` and
`verify_published_url` — their input and output types and registry entries. See `### L2 — composites`
and `### L3 — http adapter` above. U1 otherwise stands: only `raw` remains open, for the slice that
ships it.

*Narrowed further 2026-08-10 by the S15 contract amendment:* `git_raw` now has complete input and
output types and a registry entry under `### L2 — git operations`. This closed the inventory known
at S15, but S16 still named three scheduler tools without fixing their public declarations.

**Resolved 2026-08-10 by the S16 contract amendment:** `scheduled_job_create`,
`scheduled_job_list` and `scheduled_job_cancel` now have complete input and output types and registry
entries under `### L2 — scheduler`; `pr_enable_auto_merge` is the initial schedulable production
operation. U1 is closed.

**U2 — The `OperatorScope` vocabulary, resolved 2026-08-09 by S13.** `OperatorScope` is the same
four values as `McpScope`. See `### Scopes` above and `design/90-decisions.md`, 2026-08-09.

**U3 — `JournalStepState` beyond `applied`, resolved 2026-08-09 by S12.** The field is redundant, and
`type JournalStepState = 'applied'` above is right as it stands — no second value was added. A step's
own **name**, not a second state on it, is what lets a recovery descriptor tell how far a composite
got: `entry.steps.map(s => s.name)` compared against `observed` is already enough for `expectedPostState`
and `resume` to decide, exactly the way `git/recovery-descriptors.ts`'s existing three local-mutation
descriptors already read `entry.preState` rather than a step state. S12's own two composite descriptors
(`composites/recovery-descriptors.ts`) confirm this by construction: neither reads `JournalStepState`
at all, and both resolve `resume` from `entry.tool` and `entry.input` alone. `sync_base`'s own recovery
descriptor (S9) is not revisited by this resolution — it sits outside S12's `Touches` line, and its own
doc comment's "a contract question, not a predicate this file can be clever about" is now answered by
this entry, but fixing `sync_base` itself is a separate, later change.

**U4 — The HTTP API route table, resolved 2026-08-19 by S18.** The full table — every path, method,
credential and whether it carries a repository dimension — is fixed under `### L5 — surfaces`
above, closing the twenty-five-route no-repository-dimension set and confirming the remaining ten
routes each carry a declaration id. See `design/90-decisions.md`, 2026-08-19.

**U5 — OAuth endpoint paths and the protected-resource metadata document, resolved 2026-08-10 by
S14.** Standard RFC-shaped paths under `/oauth/*` and `/.well-known/*`, with `issueMcpGrant` added
to `Authorization` as the one durable write the authorization-code exchange performs. See
`### L5 — surfaces` above and `design/90-decisions.md`, 2026-08-10.

**U6 — Operational numbers, resolved 2026-08-11.** The deployment defaults, notifier attempt and
backoff policy, and the requirement for an explicit per-tool `maxResultBytes` are fixed under
`### Deployment configuration` above. The chosen finite values match the already exercised code
defaults; `hatchSeconds`, `sessionIdleSeconds` and `sessionAbsoluteSeconds` retain their previously
fixed values. See `design/90-decisions.md`, 2026-08-11. This unblocks S17.

~~**U7 — The console package's element type and build entry.**~~ — **resolved 2026-08-19 by S19.**
`ConsoleViewRegistration` was generic over the element type because the design fixed what a view
receives and what it declares, but not the UI framework binding, the package's exported build entry,
or how the asset manifest is hashed into the console fingerprint.

*Narrowed 2026-08-19 by S18:* the framework binding (React), the build entry (Vite, `console/`, an
`index.html` root) and the asset-manifest hashing (`console-integrity.ts`'s digest over every built
file, verified at boot per `### Boot`'s `console-manifest-mismatch`/`console-unreadable`) are fixed.

*Resolved 2026-08-19 by S19:* `TElement` is fixed to `ReactElement`, and the package's exported build
entry is `console/src/index.ts` (`main`/`types` in `console/package.json`), re-exporting
`ConsoleViewProps`, `ConsoleViewRegistration` and `createConsole` — the function a consumer's own
`main.tsx` calls with its additional views. See `### Console view registration` above and
`design/90-decisions.md`, 2026-08-19.

**U10 — The file-watcher target protocol, resolved 2026-08-11.** One logical target is an explicit
pair of ordinary compiled registry entries named by `FileWatcherConfig.planTool` and `applyTool`.
Their phase annotations, generic outer schemas, consumer-specific plan-schema equality and dispatch
semantics are fixed under `### Declaration`, `### File watcher`, `### Contract types (L0)` and
`### L2 — watcher` above. See `design/90-decisions.md`, 2026-08-11.

~~**U8 — The pre-state digest algorithms.**~~ — **resolved 2026-08-08.** `SHA256_hex(canonical(...))`
over an ordered array of index entries and porcelain-status lines respectively, neither derived via
a command that writes to the object database. See `### Clone`, immediately after `ObservedGitState`,
for the exact fields and ordering. This unblocks S7.

~~**U9 — The audit record's canonical serialisation.**~~ — **resolved 2026-08-03.** Deep key-sorted
JSON over the full flattened `AuditRecord` excluding only `hash` itself, reusing the compiler's
fingerprint canonicalisation. See `### Audit` above. This unblocks S3.
