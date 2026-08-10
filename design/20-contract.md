# Contract — SubZeroDev.Git

Derived from `10-design.md`. Where this document fixes something the design left to the contract,
the choice is logged in `90-decisions.md` on the same date.

The language is **TypeScript**, targeting Node with ESM. That follows from the brief: MCP
TypeScript SDK v2 pinned, and a prior art that is TypeScript throughout. Declarations here are
types and signatures only.

Two conventions carry the whole document and are stated once.

**Nominal strings.** Every constrained string is a branded type, so a raw `string` never reaches a
field that has an invariant. Each brand has a constructor that is the only way to make one, and
the constructor is where the invariant is checked.

```ts
declare const BRAND: unique symbol;
type Brand<T, B extends string> = T & { readonly [BRAND]: B };
```

**Typed failure, not thrown failure.** L2 domain functions return `ToolResult`, per the design.
Every other module returns `Outcome<T, E>` with an enumerated `E`. Nothing in this contract
throws as a control-flow mechanism, and no function returns a bare `Error` or a string.

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

```ts
type DeclarationId      = Brand<string, 'DeclarationId'>;
type Generation         = Brand<number, 'Generation'>;
type GrantEpoch         = Brand<number, 'GrantEpoch'>;
type CredentialRef      = Brand<string, 'CredentialRef'>;
type RegistryToolName   = Brand<string, 'RegistryToolName'>;
type ModuleTargetName   = Brand<string, 'ModuleTargetName'>;
type HttpOperationName  = Brand<string, 'HttpOperationName'>;
type OperationId        = Brand<string, 'OperationId'>;
type ScheduledJobId     = Brand<string, 'ScheduledJobId'>;
type SessionId          = Brand<string, 'SessionId'>;
type ClientId           = Brand<string, 'ClientId'>;
type GrantId            = Brand<string, 'GrantId'>;
type TokenId            = Brand<string, 'TokenId'>;
type OutboxRowId        = Brand<string, 'OutboxRowId'>;
type ConsoleViewId      = Brand<string, 'ConsoleViewId'>;
type Subject            = Brand<string, 'Subject'>;
type IsoUtcTimestamp    = Brand<string, 'IsoUtcTimestamp'>;
type Sha256Hex          = Brand<string, 'Sha256Hex'>;
type GitSha             = Brand<string, 'GitSha'>;
type BranchName         = Brand<string, 'BranchName'>;
type RepoRelativePath   = Brand<string, 'RepoRelativePath'>;
type PathPrefix         = Brand<string, 'PathPrefix'>;
type ClonePath          = Brand<string, 'ClonePath'>;
type DropFileName       = Brand<string, 'DropFileName'>;
type RemoteHost         = Brand<string, 'RemoteHost'>;
type CloneUrl           = Brand<string, 'CloneUrl'>;
type HttpsUrl           = Brand<string, 'HttpsUrl'>;
type McpResourceUri     = Brand<string, 'McpResourceUri'>;
type BearerToken        = Brand<string, 'BearerToken'>;
type SaltedHash         = Brand<string, 'SaltedHash'>;
type EnvVarName         = Brand<string, 'EnvVarName'>;
```

The invariant each brand carries, and where it is checked:

| Brand | Invariant | Checked by |
|---|---|---|
| `DeclarationId` | `^[a-z0-9][a-z0-9-]{0,62}$` | `declarationId()` |
| `Generation` | integer, `>= 1` | `generation()` |
| `GrantEpoch` | integer, `>= 0` | `grantEpoch()` |
| `CredentialRef` | `^[a-z0-9][a-z0-9._-]{0,63}$` | `credentialRef()` |
| `RegistryToolName` | `^[a-z][a-z0-9_]{0,63}$`, no `blog_` prefix on a base tool | compiler |
| `IsoUtcTimestamp` | RFC 3339, `Z` suffix, millisecond precision | `isoUtcTimestamp()` |
| `Sha256Hex` | `^[0-9a-f]{64}$` | `sha256Hex()` |
| `GitSha` | `^[0-9a-f]{40}$` | `gitSha()` |
| `RepoRelativePath` | non-empty, no leading `/`, no segment `..`, no `;`, not `.`, not `-A`, not `--all` | `repoRelativePath()` |
| `PathPrefix` | a `RepoRelativePath` ending in `/`, or a `RepoRelativePath` naming one file | `pathPrefix()` |
| `CloneUrl` | parses as an https URL or an scp-style remote, and its host is on the deployment allowlist | `cloneUrl()` |
| `HttpsUrl` | absolute, scheme `https` | `httpsUrl()` |
| `McpResourceUri` | `/mcp/{DeclarationId}` | `mcpResourceUri()` |
| `SaltedHash` | opaque, and never equal to the value it hashes | authorization, operator identity |

```ts
declare function declarationId(value: string): Outcome<DeclarationId, ValidationFailure>;
declare function generation(value: number): Outcome<Generation, ValidationFailure>;
declare function grantEpoch(value: number): Outcome<GrantEpoch, ValidationFailure>;
declare function credentialRef(value: string): Outcome<CredentialRef, ValidationFailure>;
declare function isoUtcTimestamp(value: string): Outcome<IsoUtcTimestamp, ValidationFailure>;
declare function sha256Hex(value: string): Outcome<Sha256Hex, ValidationFailure>;
declare function gitSha(value: string): Outcome<GitSha, ValidationFailure>;
declare function branchName(value: string): Outcome<BranchName, ValidationFailure>;
declare function repoRelativePath(value: string): Outcome<RepoRelativePath, ValidationFailure>;
declare function pathPrefix(value: string): Outcome<PathPrefix, ValidationFailure>;
declare function cloneUrl(value: string, allowed: readonly RemoteHost[]): Outcome<CloneUrl, ValidationFailure>;
declare function httpsUrl(value: string): Outcome<HttpsUrl, ValidationFailure>;
declare function mcpResourceUri(value: string): Outcome<McpResourceUri, ValidationFailure>;

interface ValidationFailure {
  readonly field: string;
  readonly rule: string;
  readonly received: string;
}
```

### JSON

```ts
type JsonPrimitive = string | number | boolean | null;
interface JsonArray extends ReadonlyArray<JsonValue> {}
interface JsonObject { readonly [key: string]: JsonValue }
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
type JsonSchema = Brand<JsonObject, 'JsonSchema'>;
```

### Capabilities and the lattice

```ts
type ContentCapability = `content.${string}`;

type DeclarationScopedCapability =
  | 'repo.read'
  | 'git.local.write'
  | 'git.remote.write'
  | 'git.raw'
  | 'host.pr.read'
  | 'host.pr.write'
  | 'host.checks.read'
  | 'scheduler.manage'
  | ContentCapability;

type InstanceScopedCapability =
  | 'declaration.manage'
  | 'auth.manage'
  | 'audit.read'
  | 'attention.resolve';

type CapabilityName = DeclarationScopedCapability | InstanceScopedCapability;
type CapabilityScope = 'declaration' | 'instance';
type CapabilitySet = ReadonlySet<CapabilityName>;

type ContractCapabilitySet = Brand<CapabilitySet, 'Layer1'>;
type DeploymentCeiling     = Brand<CapabilitySet, 'Layer2'>;
type DeclarationGrant      = Brand<CapabilitySet, 'Layer3'>;
type SessionGrant          = Brand<CapabilitySet, 'Layer4'>;
type EffectiveGrant        = Brand<CapabilitySet, 'Effective'>;

declare function capabilityScopeOf(capability: CapabilityName): CapabilityScope;
declare function hostSupportedCapabilities(host: HostKind): CapabilitySet;
```

The `host.*` capabilities are present in `hostSupportedCapabilities('github')` and absent from
`hostSupportedCapabilities('generic')`.

### Scopes

```ts
type McpScope = 'read' | 'write' | 'raw' | 'schedule';
type OperatorScope = McpScope;
type Scope = McpScope | OperatorScope;
```

**U2, resolved 2026-08-09 by S13.** `OperatorScope` carries the same four values as `McpScope` —
`read`, `write`, `raw`, `schedule` — gating the same declaration-scoped capability classes an
`operator-api` grant reaches through the HTTP API's route (which carries the repository) rather
than through a resource indicator. The four instance-level capabilities (`declaration.manage`,
`auth.manage`, `audit.read`, `attention.resolve`) stay reachable only from the console, per their
existing "console-only" language above — no `OperatorScope` value names them, and no operator-api
token can exercise them. See `design/90-decisions.md`, 2026-08-09.

### Declaration

```ts
type HostKind = 'github' | 'generic';
type DeclarationState = 'active' | 'orphaned';

interface RepositoryIdentity {
  readonly gitUserName: string;
  readonly gitUserEmail: string;
}

interface ContentDropConfig {
  readonly tool: RegistryToolName;
  readonly autoMerge: boolean;
}

interface Declaration {
  readonly id: DeclarationId;
  readonly generation: Generation;
  readonly cloneUrl: CloneUrl;
  readonly host: HostKind;
  readonly credentialRef: CredentialRef;
  readonly capabilityGrant: DeclarationGrant;
  readonly writablePathPrefixes: readonly PathPrefix[];
  readonly pinned: boolean;
  readonly contentDrop: ContentDropConfig | null;
  readonly identity: RepositoryIdentity;
  readonly state: DeclarationState;
  readonly grantEpoch: GrantEpoch;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

interface DeclareInput {
  readonly id: DeclarationId;
  readonly cloneUrl: CloneUrl;
  readonly host: HostKind;
  readonly credentialRef: CredentialRef;
  readonly capabilityGrant: readonly DeclarationScopedCapability[];
  readonly writablePathPrefixes: readonly PathPrefix[];
  readonly pinned: boolean;
  readonly contentDrop: ContentDropConfig | null;
  readonly identity: RepositoryIdentity;
}

interface AmendInput {
  readonly cloneUrl: CloneUrl | null;
  readonly credentialRef: CredentialRef | null;
  readonly capabilityGrant: readonly DeclarationScopedCapability[] | null;
  readonly writablePathPrefixes: readonly PathPrefix[] | null;
  readonly pinned: boolean | null;
  readonly contentDrop: ContentDropConfig | null | undefined;
  readonly identity: RepositoryIdentity | null;
}
```

`AmendInput.contentDrop` is three-valued on purpose: `undefined` leaves it alone, `null` removes
it, a value sets it. `id`, `generation`, `host` and `state` are absent from `AmendInput` because
the design makes each immutable for the life of a generation.

```ts
interface OrphanReport {
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly cancelledJobs: readonly ScheduledJobId[];
  readonly revokedGrants: readonly GrantId[];
  readonly retainedJournalEntries: readonly OperationId[];
  readonly cloneLeftOnDisk: boolean;
  readonly dropWatchStopped: boolean;
}
```

### RepositoryConfig

```ts
interface RepositoryConfig {
  readonly baseBranch: BranchName;
  readonly requiredChecks: readonly string[];
  readonly deployWorkflow: string | null;
  readonly branchPrefixes: readonly string[];
}

declare const REPOSITORY_CONFIG_DEFAULTS: RepositoryConfig;
```

Every field defaults, so a declaration with no config file at all is fully operable. This type
carries no capability, scope, path prefix, credential reference or remote — see invariant A8.

### Clone

```ts
type CloneState =
  | 'absent'
  | 'materialising'
  | 'ready'
  | 'dirty'
  | 'recovery-pending'
  | 'needs-attention'
  | 'evicted';

interface Clone {
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly state: CloneState;
  readonly path: ClonePath;
  readonly sizeBytes: number;
  readonly lastOperationAt: IsoUtcTimestamp | null;
  readonly observedRemote: CloneUrl | null;
  readonly attentionReason: string | null;
}
```

`safeToEvict` is deliberately absent from this type. It is derived by `CloneStore.isSafeToEvict` at
eviction time and never stored — see invariant D2.

```ts
interface PreState {
  readonly branch: BranchName | null;
  readonly headSha: GitSha | null;
  readonly upstreamSha: GitSha | null;
  readonly indexDigest: Sha256Hex;
  readonly worktreeDigest: Sha256Hex;
}

interface ObservedGitState extends PreState {
  readonly observedAt: IsoUtcTimestamp;
}
```

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

```ts
type SafeToEvictVerdict =
  | { readonly safe: true }
  | { readonly safe: false; readonly blockers: readonly EvictionBlocker[] };

type EvictionBlocker =
  | { readonly kind: 'pinned' }
  | { readonly kind: 'worktree-dirty' }
  | { readonly kind: 'branch-ahead-of-upstream'; readonly branch: BranchName; readonly ahead: number }
  | { readonly kind: 'unreachable-commits'; readonly base: BranchName; readonly count: number }
  | { readonly kind: 'stash-present'; readonly count: number }
  | { readonly kind: 'open-journal-entry'; readonly operationId: OperationId }
  | { readonly kind: 'active-operations'; readonly count: number }
  | { readonly kind: 'corrupt-tree' };

interface CloneHandle {
  readonly clone: Clone;
  readonly materialisationLock: LockHandle;
  readonly activePin: ActivePin;
}

interface CorruptTreeOverride {
  readonly permitCorruptTree: boolean;
}

interface EvictionOutcome {
  readonly declarationId: DeclarationId;
  readonly evicted: boolean;
  readonly freedBytes: number;
  readonly blockers: readonly EvictionBlocker[];
}
```

### Actors, profiles and sessions

```ts
type ActorKind = 'operator' | 'mcp' | 'scheduler' | 'watcher' | 'recovery';

interface ActorRef {
  readonly kind: ActorKind;
  readonly subject: Subject;
  readonly clientId: ClientId | null;
  readonly grantId: GrantId | null;
}

type SessionKind = 'operator' | 'mcp' | 'scheduler' | 'watcher';

interface ActorProfile {
  readonly kind: SessionKind;
  readonly capabilities: CapabilitySet;
  readonly strippedPathPrefixes: readonly PathPrefix[];
}

declare const STRIPPED_FOR_UNATTENDED: readonly PathPrefix[];

interface Session {
  readonly id: SessionId;
  readonly kind: SessionKind;
  readonly actorRef: ActorRef;
  readonly repositoryBinding: DeclarationId | null;
  readonly grant: SessionGrant;
  readonly writablePathPrefixes: readonly PathPrefix[];
  readonly frozenAtEpoch: GrantEpoch;
}
```

`STRIPPED_FOR_UNATTENDED` is `.github/workflows/`, `.config/`, `tools/`, `build/`. It is the
`strippedPathPrefixes` of the `mcp`, `scheduler` and `watcher` profiles; the `operator` profile's
is empty. `repositoryBinding` is non-null for `mcp` and `watcher`, null for `operator`, and null
for `scheduler` because a scheduler session binds per job rather than per session.

```ts
interface OperatorSession {
  readonly id: SessionId;
  readonly subject: Subject;
  readonly createdAt: IsoUtcTimestamp;
  readonly lastSeenAt: IsoUtcTimestamp;
  readonly idleExpiresAt: IsoUtcTimestamp;
  readonly absoluteExpiresAt: IsoUtcTimestamp;
  readonly revokedAt: IsoUtcTimestamp | null;
}
```

### Authorization records

```ts
type GrantKind = 'mcp' | 'operator-api';
type TokenKind = 'access' | 'refresh';

interface OAuthClient {
  readonly clientId: ClientId;
  readonly redirectUris: readonly HttpsUrl[];
  readonly registeredAt: IsoUtcTimestamp;
  readonly revokedAt: IsoUtcTimestamp | null;
}

interface Grant {
  readonly grantId: GrantId;
  readonly kind: GrantKind;
  readonly clientId: ClientId | null;
  readonly subject: Subject;
  readonly resource: McpResourceUri | null;
  readonly declarationId: DeclarationId | null;
  readonly generation: Generation | null;
  readonly scopes: readonly Scope[];
  readonly createdAt: IsoUtcTimestamp;
  readonly lastUsedAt: IsoUtcTimestamp | null;
  readonly revokedAt: IsoUtcTimestamp | null;
}

interface Token {
  readonly jti: TokenId;
  readonly grantId: GrantId;
  readonly kind: TokenKind;
  readonly verifierHash: SaltedHash;
  readonly issuedAt: IsoUtcTimestamp;
  readonly expiresAt: IsoUtcTimestamp;
  readonly revokedAt: IsoUtcTimestamp | null;
}

interface IssuedToken {
  readonly jti: TokenId;
  readonly value: BearerToken;
  readonly expiresAt: IsoUtcTimestamp;
}

interface GrantView {
  readonly grant: Grant;
  readonly client: OAuthClient | null;
  readonly activeTokens: number;
  readonly liveSessions: number;
}
```

`resource`, `declarationId` and `generation` are non-null exactly when `kind` is `mcp`, and null
exactly when it is `operator-api`. `clientId` is null for an `operator-api` grant. `IssuedToken` is
the only type in this contract carrying a token value, and nothing persists it.

### Operation journal

```ts
type JournalEntryState = 'intended' | 'applied' | 'settled' | 'attention';
type OperationContextKind = 'normal' | 'repair' | 'recovery' | 'hatch';
type JournalStepState = 'applied';

interface JournalStep {
  readonly name: string;
  readonly state: JournalStepState;
  readonly at: IsoUtcTimestamp;
}

interface OperationJournalEntry {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly actorRef: ActorRef;
  readonly scheduledJobId: ScheduledJobId | null;
  readonly context: OperationContextKind;
  readonly preState: PreState;
  readonly steps: readonly JournalStep[];
  readonly state: JournalEntryState;
  readonly attentionReason: string | null;
  readonly startedAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

interface JournalBeginInput {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly actorRef: ActorRef;
  readonly scheduledJobId: ScheduledJobId | null;
  readonly context: OperationContextKind;
  readonly preState: PreState;
}
```

`JournalStepState` admits only `applied`, because that is the only step state the design names and
the only one recovery reads. Whether a second state exists is open — see `## Unresolved`.

`input` is scrubbed by `Exec.scrubJson` before it reaches this type.

### Recovery

```ts
interface RecoveryResumeStep {
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
}

interface RecoveryDescriptor {
  readonly tool: RegistryToolName;
  readonly expectedPostState: (entry: OperationJournalEntry, observed: ObservedGitState) => boolean;
  readonly resume: ((entry: OperationJournalEntry) => RecoveryResumeStep) | null;
}

type RecoveryClassification =
  | { readonly verdict: 'nothing-happened' }
  | { readonly verdict: 'completed'; readonly terminal: TerminalState | null }
  | { readonly verdict: 'resume'; readonly step: RecoveryResumeStep }
  | { readonly verdict: 'park'; readonly reason: string };
```

### Scheduled jobs

```ts
type ScheduledJobStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'skipped'
  | 'cancelled'
  | 'needs-attention';

type OnMissedPolicy =
  | { readonly mode: 'catch_up' }
  | { readonly mode: 'skip_if_older_than'; readonly seconds: number };

interface ScheduledJob {
  readonly id: ScheduledJobId;
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly notBefore: IsoUtcTimestamp;
  readonly onMissed: OnMissedPolicy;
  readonly frozenGrant: CapabilitySet;
  readonly status: ScheduledJobStatus;
  readonly reason: string | null;
  readonly createdBy: ActorRef;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

interface CreateJobInput {
  readonly declarationId: DeclarationId;
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly notBefore: IsoUtcTimestamp;
  readonly onMissed: OnMissedPolicy;
}
```

`onMissed` has no default and is required at creation. `ScheduledJob` carries no `operationId`; the
correlation runs the other way, through `OperationJournalEntry.scheduledJobId`.

### Audit

```ts
type AuditRecordForm =
  | 'call'
  | 'authorization-rejection'
  | 'hatch-intent'
  | 'hatch-outcome'
  | 'content-drop'
  | 'identity-event'
  | 'lease-takeover';

interface AuditRecordBase {
  readonly sequence: number;
  readonly at: IsoUtcTimestamp;
  readonly operationId: OperationId | null;
  readonly declarationId: DeclarationId | null;
  readonly generation: Generation | null;
  readonly tool: RegistryToolName | null;
  readonly actorRef: ActorRef;
  readonly context: OperationContextKind;
  readonly previousHash: Sha256Hex | null;
  readonly hash: Sha256Hex;
}

type IdentityEvent =
  | 'enrolment'
  | 'recovery-code-used'
  | 'break-glass-used'
  | 'totp-reenrolled'
  | 'session-revoked'
  | 'token-issued'
  | 'client-revoked'
  | 'grant-revoked'
  | 'token-revoked';

type AuditRecordBody =
  | { readonly form: 'call'; readonly resultKind: ResultKind; readonly changedPaths: readonly RepoRelativePath[] }
  | { readonly form: 'authorization-rejection'; readonly missing: readonly CapabilityName[]; readonly rejectedPath: RepoRelativePath | null }
  | { readonly form: 'hatch-intent'; readonly argv: readonly string[] }
  | { readonly form: 'hatch-outcome'; readonly resultKind: ResultKind; readonly changedPaths: readonly RepoRelativePath[] }
  | { readonly form: 'content-drop'; readonly file: DropFileName; readonly outcome: DropOutcome }
  | { readonly form: 'identity-event'; readonly event: IdentityEvent }
  | { readonly form: 'lease-takeover'; readonly previousHolder: InstanceLease };

type AuditRecord = AuditRecordBase & AuditRecordBody;
type AuditAppendInput = Omit<AuditRecordBase, 'sequence' | 'previousHash' | 'hash'> & AuditRecordBody;

type AuditAppendFailure = 'write-failed' | 'segment-rotation-failed' | 'volume-full';

type AuditAppendOutcome =
  | { readonly appended: true; readonly sequence: number }
  | { readonly appended: false; readonly reason: AuditAppendFailure };

interface RetainedAnchor {
  readonly segment: number;
  readonly terminalSequence: number;
  readonly terminalHash: Sha256Hex;
  readonly retainedAt: IsoUtcTimestamp;
}

interface AuditChainBreak {
  readonly atSequence: number;
  readonly expectedHash: Sha256Hex;
  readonly foundHash: Sha256Hex | null;
}

interface AuditChainState {
  readonly verifiedThrough: number | null;
  readonly headHash: Sha256Hex | null;
  readonly mirroredHeadHash: Sha256Hex | null;
  readonly retainedAnchors: readonly RetainedAnchor[];
  readonly chainBreak: AuditChainBreak | null;
}

interface AuditQuery {
  readonly declarationId: DeclarationId | null;
  readonly tool: RegistryToolName | null;
  readonly actorSubject: Subject | null;
  readonly form: AuditRecordForm | null;
  readonly from: IsoUtcTimestamp | null;
  readonly to: IsoUtcTimestamp | null;
  readonly limit: number;
  readonly cursor: string | null;
}

interface AuditPage {
  readonly records: readonly AuditRecord[];
  readonly nextCursor: string | null;
  readonly chain: AuditChainState;
}
```

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

### Content drops

```ts
type DropStage = 'inbox' | 'processing' | 'processed' | 'failed';

type DropOutcome =
  | { readonly kind: 'succeeded'; readonly pullRequest: PullRequestRef }
  | { readonly kind: 'rejected'; readonly step: string; readonly result: ResultKind; readonly reason: string }
  | { readonly kind: 'interrupted-claim'; readonly reason: string };

interface DropCandidate {
  readonly declarationId: DeclarationId;
  readonly file: DropFileName;
  readonly stage: DropStage;
  readonly sizeBytes: number;
  readonly isSymlink: boolean;
}

interface PendingPullRequest {
  readonly declarationId: DeclarationId;
  readonly number: number;
  readonly branch: BranchName;
  readonly openedAt: IsoUtcTimestamp;
  readonly sourceFile: DropFileName;
}

interface PendingPullRequestList {
  readonly entries: readonly PendingPullRequest[];
}

interface WatchTickReport {
  readonly declarationId: DeclarationId;
  readonly skipped: 'clone-not-clean' | 'clone-needs-attention' | null;
  readonly claimed: DropFileName | null;
  readonly outcome: DropOutcome | null;
  readonly reconciled: readonly PendingPullRequest[];
  readonly stillPending: readonly PendingPullRequest[];
}
```

### Instance lease

```ts
interface InstanceLease {
  readonly instanceId: string;
  readonly bootId: string;
  readonly hostName: string;
  readonly startedAt: IsoUtcTimestamp;
}
```

Written once at acquisition and never refreshed. Exclusion is the OS lock; the contents only name
the holder.

**The lock and the contents are two files**, not one. The runtime has no `flock` binding, so the
advisory lock is carried by a dedicated file that exists only to be locked, and `InstanceLease` is
written beside it while that lock is held. A reader that finds the JSON has learned who *claims*
the volume; only the lock decides who holds it. That split is why a lease file left by a dead
instance is a takeover to be reported rather than a refusal — see the boot path in `10-design.md`.

### The result envelope

```ts
type ResultKind =
  | 'success'
  | 'validation'
  | 'precondition'
  | 'conflict'
  | 'authorization'
  | 'upstream'
  | 'timeout'
  | 'infrastructure';

interface Finding {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

interface Diagnostics {
  readonly operationId: OperationId | null;
  readonly declarationId: DeclarationId | null;
  readonly generation: Generation | null;
  readonly durationMs: number;
}

interface ToolResult<TData = never> {
  readonly ok: boolean;
  readonly kind: ResultKind;
  readonly summary: string;
  readonly data?: TData;
  readonly findings?: readonly Finding[];
  readonly diagnostics?: Diagnostics;
}

declare function isError(kind: ResultKind): boolean;

declare function success<TData>(summary: string, data: TData, diagnostics: Diagnostics): ToolResult<TData>;
declare function validation(summary: string, findings: readonly Finding[]): ToolResult<never>;
declare function precondition(summary: string, findings: readonly Finding[]): ToolResult<never>;
declare function conflict(summary: string, holder: LockHolder | null): ToolResult<never>;
declare function authorization(summary: string, missing: readonly CapabilityName[]): ToolResult<never>;
declare function upstream(summary: string, retryAfterSeconds: number | null): ToolResult<never>;
declare function timeout(summary: string, limitSeconds: number): ToolResult<never>;
declare function infrastructure(summary: string): ToolResult<never>;

interface ReadStamp {
  readonly lastSettledOperationId: OperationId | null;
  readonly mutationInFlight: boolean;
}
```

`isError` returns true for `upstream`, `timeout` and `infrastructure`, and false for the other
five. Every read operation's `TData` includes a `ReadStamp`, whose `mutationInFlight` is scoped to
the declaration being read rather than to the process-wide mutex.

### Notification

```ts
type NotificationSeverity = 'attention' | 'info';

type TerminalState =
  | { readonly kind: 'merge-conflict'; readonly branch: BranchName; readonly headSha: GitSha; readonly baseSha: GitSha }
  | { readonly kind: 'required-check-failed'; readonly check: string; readonly pullRequest: PullRequestRef }
  | { readonly kind: 'wait-timeout'; readonly waitedSeconds: number; readonly tool: RegistryToolName }
  | { readonly kind: 'operation-parked'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'content-drop-failed'; readonly file: DropFileName; readonly reason: string };

interface MaintenanceSummary {
  readonly kind: 'maintenance-pass';
  readonly releasedBytes: number;
  readonly evictedDeclarations: readonly DeclarationId[];
  readonly prunedByModule: readonly RetentionReport[];
}

interface NotificationRequest {
  readonly severity: NotificationSeverity;
  readonly declarationId: DeclarationId | null;
  readonly subject: TerminalState | MaintenanceSummary;
  readonly summary: string;
}

type OutboxRowStatus = 'pending' | 'in-flight' | 'delivered' | 'failed';

interface OutboxRow {
  readonly id: OutboxRowId;
  readonly severity: NotificationSeverity;
  readonly declarationId: DeclarationId | null;
  readonly payload: JsonValue;
  readonly status: OutboxRowStatus;
  readonly attempts: number;
  readonly lastAttemptAt: IsoUtcTimestamp | null;
  readonly lastError: string | null;
  readonly createdAt: IsoUtcTimestamp;
  readonly deliveredAt: IsoUtcTimestamp | null;
}

interface DeliveryReport {
  readonly delivered: number;
  readonly failed: number;
  readonly stillPending: number;
  readonly errors: readonly NotifierError[];
}
```

Every `TerminalState` is `attention` severity; `MaintenanceSummary` is `info`, one per pass rather
than one per clone.

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

```ts
type VolumeConsumer =
  | 'clones'
  | 'audit-log'
  | 'structured-store'
  | 'backups-and-snapshots'
  | 'drop-directories';

type StoreTableName =
  | 'schema_migration'
  | 'declaration'
  | 'clone'
  | 'oauth_client'
  | 'grant'
  | 'token'
  | 'operator_credential'
  | 'operator_recovery_code'
  | 'operator_session'
  | 'scheduled_job'
  | 'journal_entry'
  | 'journal_step'
  | 'notification_outbox'
  | 'audit_chain_head'
  | 'audit_retained_anchor'
  | 'credential_failure_mark';

interface VolumeUsage {
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly usedPercent: number;
  readonly byConsumer: Readonly<Record<VolumeConsumer, number>>;
  readonly storeByTable: Readonly<Record<StoreTableName, number>>;
}

type MaintenanceReason = 'scheduled' | 'watermark' | 'operator-requested';

interface RetentionReport {
  readonly module: string;
  readonly deletedRows: number;
  readonly freedBytes: number;
  readonly skipped: readonly string[];
}

interface MaintenanceReport {
  readonly reason: MaintenanceReason;
  readonly startedAt: IsoUtcTimestamp;
  readonly finishedAt: IsoUtcTimestamp;
  readonly perModule: readonly RetentionReport[];
  readonly evictions: readonly EvictionOutcome[];
  readonly usageBefore: VolumeUsage;
  readonly usageAfter: VolumeUsage;
}
```

### Deployment configuration

```ts
interface RetentionWindows {
  readonly auditSegmentBytes: number;
  readonly auditDays: number;
  readonly journalSettledDays: number;
  readonly outboxDeliveredDays: number;
  readonly preMigrationBackupsRetained: number;
  readonly storeSnapshotsRetained: number;
  readonly operatorSessionDays: number;
  readonly processedDropDays: number;
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

interface DeploymentConfig {
  readonly ceiling: DeploymentCeiling;
  readonly remoteHostAllowlist: readonly RemoteHost[];
  readonly remoteOperationsPermitted: boolean;
  readonly watcher: WatcherConfig;
  readonly retention: RetentionWindows;
  readonly watermarks: DiskWatermarks;
  readonly timeouts: TimeoutBudget;
  readonly admission: AdmissionLimits;
  readonly notifierWebhook: HttpsUrl | null;
  readonly oidcIssuer: HttpsUrl | null;
  readonly oidcSubjectAllowlist: readonly Subject[];
  readonly sessionIdleSeconds: number;
  readonly sessionAbsoluteSeconds: number;
}
```

Defaults the design fixes: `auditSegmentBytes` 67108864, `auditDays` 90, `journalSettledDays` 30,
`outboxDeliveredDays` 14, `preMigrationBackupsRetained` 3, `storeSnapshotsRetained` 7,
`operatorSessionDays` 7, `processedDropDays` 14, `tokenDays` 7, `revokedGrantDays` 180,
`terminalJobDays` 30, `maintenanceAtPercent` 85, `refuseAtPercent` 95, `cloneSeconds` 300,
`fetchSeconds` 300, `pushSeconds` 300, `monitoringWaitCapSeconds` 1800, `pollIntervalSeconds` 15,
`watcher.enabled` false, `remoteOperationsPermitted` false. The remaining values are deployment-set
and the design declines to fix them — see `## Unresolved`.

Two of those U6 values acquire **defaults, not resolutions**, because the console session cannot be
built without them: `sessionIdleSeconds` 3600 and `sessionAbsoluteSeconds` 43200. Both stay
deployment-overridable and U6 still owns the question of what a deployment should choose; these are
what the service uses when it is not told otherwise. They are bounded by `operatorSessionDays`,
which retention already fixes at 7.

### Contract types (L0)

```ts
type ToolExecutionClass = 'read' | 'mutating' | 'monitoring-wait';

interface ToolAnnotations {
  readonly schedulable: boolean;
  readonly dropTarget: boolean;
  readonly untrustedOutput: boolean;
}

interface ToolLimits {
  readonly timeoutSeconds: number;
  readonly maxResultBytes: number;
}

type ExecutionTarget =
  | { readonly kind: 'module'; readonly target: ModuleTargetName }
  | { readonly kind: 'http'; readonly operation: HttpOperationName };

interface ToolDeclaration {
  readonly name: RegistryToolName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly scopes: readonly Scope[];
  readonly capabilities: readonly CapabilityName[];
  readonly capabilityScope: CapabilityScope;
  readonly executionClass: ToolExecutionClass;
  readonly annotations: ToolAnnotations;
  readonly limits: ToolLimits;
  readonly target: ExecutionTarget;
}

interface CompiledRegistry {
  readonly fingerprint: Sha256Hex;
  readonly compiledAt: IsoUtcTimestamp;
  readonly entries: readonly ToolDeclaration[];
  readonly contractCapabilitySet: ContractCapabilitySet;
}

interface ManifestEntry {
  readonly name: RegistryToolName;
  readonly capabilities: readonly CapabilityName[];
  readonly scopes: readonly Scope[];
  readonly executionClass: ToolExecutionClass;
}

interface SanitisedManifest {
  readonly fingerprint: Sha256Hex;
  readonly tools: readonly ManifestEntry[];
}

interface GeneratedDocumentation {
  readonly markdown: string;
}

interface CompilerArtifact {
  readonly registry: CompiledRegistry;
  readonly manifest: SanitisedManifest;
  readonly fingerprint: Sha256Hex;
  readonly documentation: GeneratedDocumentation;
}
```

`untrustedOutput` is the annotation the prior art puts on a tool returning author-controlled text.

### Console view registration (L5, published package)

```ts
interface ConsoleViewProps {
  readonly declarationId: DeclarationId;
}

interface ConsoleViewRegistration<TElement> {
  readonly id: ConsoleViewId;
  readonly title: string;
  readonly capabilities: readonly CapabilityName[];
  readonly render: (props: ConsoleViewProps) => TElement;
}
```

A view declares the capabilities it needs and receives the selected declaration. It never names a
declaration it belongs to.

---

## Persisted schemas

Three storage kinds, per the design. Only the structured store has a schema; the audit log is JSONL
holding one `AuditRecord` per line, and the working clones are directories.

**The migration story, stated once because it is the same for every table.** Migrations are
explicit, numbered and forward-only. The store is copied to a timestamped backup **before** any
migration runs, and the three most recent copies are retained. Every table below is created by
migration `0001` against an empty store, so for the first release "what happens to existing data"
is: there is none. Thereafter a migration may add a table, add a nullable column, or add an index;
it may not drop or narrow a column that a retained pre-migration copy's schema depends on, because
definition-of-done item 18's rollback restores that copy alongside the previous image.

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
  content_drop_tool       TEXT,
  content_drop_auto_merge INTEGER CHECK (content_drop_auto_merge IN (0,1)),
  git_user_name           TEXT    NOT NULL,
  git_user_email          TEXT    NOT NULL,
  state                   TEXT    NOT NULL CHECK (state IN ('active','orphaned')),
  grant_epoch             INTEGER NOT NULL,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  PRIMARY KEY (id, generation),
  CHECK (generation >= 1),
  CHECK ((content_drop_tool IS NULL) = (content_drop_auto_merge IS NULL))
) STRICT;

CREATE UNIQUE INDEX declaration_active_id ON declaration (id) WHERE state = 'active';
CREATE INDEX declaration_by_state ON declaration (state);
CREATE INDEX declaration_with_drop ON declaration (id) WHERE content_drop_tool IS NOT NULL;
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

```ts
interface Clock {
  now(): IsoUtcTimestamp;
  monotonicMs(): number;
}
```

The envelope constructors and `isError` are declared under `### The result envelope`.

### L1 — exec

```ts
interface CredentialBinding {
  readonly ref: CredentialRef;
  readonly declarationId: DeclarationId;
  readonly variableName: EnvVarName;
}

interface ExecRequest {
  readonly argv: readonly string[];
  readonly cwd: ClonePath;
  readonly timeoutSeconds: number;
  readonly credential: CredentialBinding | null;
  readonly signal: AbortSignal;
}

interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

interface Exec {
  runGit(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>>;
  runGh(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>>;
  scrub(text: string): string;
  scrubJson(value: JsonValue): JsonValue;
}
```

`argv` is a vector, never a string, and there is no shell. The executable is fixed by which runner
is called, never by an element of `argv`. `credential` names an environment variable; the value is
placed in the child's environment by the resolver and never returned to a caller. Exec supplies the
credential-helper configuration itself, ahead of every element of `argv`, and disables system and
global configuration with a neutral home directory.

### L1 — locks

```ts
interface LockHolder {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId;
  readonly tool: RegistryToolName;
  readonly heldSince: IsoUtcTimestamp;
}

interface LockHandle {
  readonly holder: LockHolder;
  release(): void;
}

interface ActivePin {
  release(): void;
}

interface WaitAdmission {
  release(): void;
}

interface Locks {
  acquireMutation(holder: LockHolder, waitMs: number, signal: AbortSignal): Promise<Outcome<LockHandle, LockError>>;
  acquireMaterialisation(declarationId: DeclarationId, holder: LockHolder, waitMs: number, signal: AbortSignal): Promise<Outcome<LockHandle, LockError>>;
  pinActiveOperation(declarationId: DeclarationId): ActivePin;
  activeOperationCount(declarationId: DeclarationId): number;
  currentMutationHolder(): LockHolder | null;
  admitLockFreeWait(sessionId: SessionId): Outcome<WaitAdmission, LockError>;
}
```

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

```ts
interface DeclarationFilter {
  readonly state: DeclarationState | null;
  readonly hasContentDrop: boolean | null;
}

interface Declarations {
  get(id: DeclarationId): Promise<Declaration | null>;
  getGeneration(id: DeclarationId, generation: Generation): Promise<Declaration | null>;
  list(filter: DeclarationFilter): Promise<readonly Declaration[]>;

  declare(input: DeclareInput, actor: ActorRef): Promise<Outcome<Declaration, DeclarationError>>;
  amend(id: DeclarationId, patch: AmendInput, actor: ActorRef): Promise<Outcome<Declaration, DeclarationError>>;
  orphan(id: DeclarationId, actor: ActorRef): Promise<Outcome<OrphanReport, DeclarationError>>;
  remove(id: DeclarationId, actor: ActorRef): Promise<Outcome<void, DeclarationError>>;

  effectiveGrant(
    contract: ContractCapabilitySet,
    ceiling: DeploymentCeiling,
    declaration: Declaration | null,
    session: SessionGrant,
  ): EffectiveGrant;

  effectiveWritablePrefixes(declaration: Declaration, profile: ActorProfile): readonly PathPrefix[];

  bumpGrantEpoch(id: DeclarationId, tx: StoreTransaction): GrantEpoch;
  remoteHostAllowlist(): readonly RemoteHost[];
}
```

`effectiveGrant` takes all four layers and returns a set rather than a boolean, because the epoch
check needs the recomputed set and not just a verdict. Each capability's own scope decides whether
layer 3 participates in its intersection; an instance-scoped capability intersects layers 1, 2 and
4 only, which is why `declaration` may be null.

### L1 — credentials

```ts
type MutableEnv = Map<EnvVarName, string>;

interface CredentialFailureMark {
  readonly ref: CredentialRef;
  readonly declarationId: DeclarationId;
  readonly reason: string;
  readonly markedAt: IsoUtcTimestamp;
}

interface CredentialResolver {
  resolveInto(ref: CredentialRef, declarationId: DeclarationId, env: MutableEnv): Promise<Outcome<CredentialBinding, CredentialError>>;
  allowedHosts(ref: CredentialRef): Promise<Outcome<readonly RemoteHost[], CredentialError>>;
  markFailing(ref: CredentialRef, declarationId: DeclarationId, reason: string): Promise<void>;
  clearFailing(ref: CredentialRef, declarationId: DeclarationId): Promise<void>;
  listFailing(): Promise<readonly CredentialFailureMark[]>;
}
```

No signature here returns a secret value. `resolveInto` writes into a `MutableEnv` that only `Exec`
consumes, and hands back a `CredentialBinding` naming the variable. Resolution happens at the
moment of use, so a replaced file takes effect on the next operation with no restart.

**The mount's layout, fixed by S9.** A reference name is a file name directly under the credential
mount, and that file's contents — trimmed of a trailing newline — are the secret. The per-reference
allowed-host constraint the design gives each reference lives in one manifest at the mount root:

```
<mount>/_allowed-hosts.json     { "<ref>": ["github.com", ...], ... }
<mount>/<ref>                   the secret
```

The manifest's name begins with `_`, which `CredentialRef`'s own pattern forbids as a first
character, so it can never collide with a reference — the same device the TOTP sealing key already
uses. **A reference absent from the manifest permits no host**, and `allowedHosts` returns the
empty list rather than every host: the design calls this a second guard independent of the
deployment's `remoteHostAllowlist`, and a guard that defaults open is not one.

`EnvVarName` for a resolved binding is derived from the reference, uppercased with every character
outside `[A-Z0-9]` replaced by `_`, under a fixed `SZG_CREDENTIAL_` prefix. It is an internal
channel name between the resolver and `Exec`, never operator-configured, so nothing depends on the
particular spelling beyond its being stable within one call.

### L1 — structured store

```ts
type SqlParameter = string | number | bigint | null | Uint8Array;

interface StoreTransaction {
  readonly id: string;
  run(sql: string, ...parameters: readonly SqlParameter[]): void;
  all(sql: string, ...parameters: readonly SqlParameter[]): readonly unknown[];
}

interface BackupStamp {
  readonly at: IsoUtcTimestamp;
  readonly ageSeconds: number;
}

interface StructuredStore {
  open(): Promise<Outcome<void, StoreError>>;
  integrityCheck(): Promise<Outcome<void, StoreError>>;
  backupBeforeMigration(): Promise<Outcome<IsoUtcTimestamp, StoreError>>;
  migrate(): Promise<Outcome<number, StoreError>>;
  transaction<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<Outcome<T, StoreError>>;
  snapshot(): Promise<Outcome<IsoUtcTimestamp, StoreError>>;
  incrementalVacuum(): Promise<Outcome<number, StoreError>>;
  usageByTable(): Promise<Outcome<Readonly<Record<StoreTableName, number>>, StoreError>>;
  newestSnapshot(): Promise<BackupStamp | null>;
  newestPreMigrationBackup(): Promise<BackupStamp | null>;
  runRetention(): Promise<RetentionReport>;
  close(): Promise<void>;
}
```

`incrementalVacuum` returns the bytes actually returned to the filesystem, which is what the
maintenance pass reports rather than the rows it deleted.

**`StoreTransaction` carries `run`, and that is what makes every `tx`-taking member honest.** Four
members take one — `Notifier.enqueue`, `Declarations.bumpGrantEpoch`, `Scheduler.cancelForDeclaration`
and `Authorization.revokeGrantsForResource` — and each promises its write commits with the caller's.
An opaque `{ id }` token cannot deliver that: a participant holding only an identifier has no way to
reach the open transaction, so it opens its own connection instead and the write lands outside. It
then either survives the caller's rollback, or is refused as busy and lost silently, since three of
the four return no error channel. Participants therefore write through `run`.

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

```ts
interface CloneStore {
  ensure(declaration: Declaration, holder: LockHolder, signal: AbortSignal): Promise<Outcome<CloneHandle, CloneStoreError>>;
  describe(declarationId: DeclarationId): Promise<Outcome<Clone, CloneStoreError>>;
  deriveAllStatesFromDisk(): Promise<readonly Clone[]>;
  observeGitState(declarationId: DeclarationId): Promise<Outcome<ObservedGitState, CloneStoreError>>;
  isSafeToEvict(declarationId: DeclarationId, acrossAllGenerations: boolean): Promise<Outcome<SafeToEvictVerdict, CloneStoreError>>;
  evictIfSafe(declarationId: DeclarationId): Promise<Outcome<EvictionOutcome, CloneStoreError>>;
  remove(declarationId: DeclarationId, override: CorruptTreeOverride, actor: ActorRef): Promise<Outcome<void, CloneStoreError>>;
  markAttention(declarationId: DeclarationId, reason: string): Promise<Outcome<void, CloneStoreError>>;
  clearAttention(declarationId: DeclarationId, actor: ActorRef): Promise<Outcome<void, CloneStoreError>>;
  readVolumeUsage(): Promise<Outcome<VolumeUsage, CloneStoreError>>;
  requestMaintenance(reason: MaintenanceReason): void;
  runRetention(): Promise<RetentionReport>;
}
```

`acrossAllGenerations` is `true` for the adoption check and `false` for eviction: adoption asks
whether any era left work in the tree, eviction asks about the current one.

`requestMaintenance` returns `void` and never awaits, because it is called on the post-mutation
path, where eviction must not run.

`remove` with `permitCorruptTree` still refuses when the tree holds commits unreachable from
`origin/<base>`. It is never a way to discard unpushed work.

### L1 — journal

```ts
interface Journal {
  begin(input: JournalBeginInput): Promise<Outcome<OperationJournalEntry, JournalError>>;
  appendStep(operationId: OperationId, name: string): Promise<Outcome<void, JournalError>>;
  markApplied(operationId: OperationId): Promise<Outcome<void, JournalError>>;
  settle(operationId: OperationId, notify: NotificationRequest | null): Promise<Outcome<void, JournalError>>;
  park(operationId: OperationId, reason: string): Promise<Outcome<void, JournalError>>;

  classify(
    entry: OperationJournalEntry,
    observed: ObservedGitState,
    descriptor: RecoveryDescriptor | null,
  ): RecoveryClassification;

  unsettled(declarationId: DeclarationId, generation: Generation): Promise<readonly OperationJournalEntry[]>;
  allUnsettled(): Promise<readonly OperationJournalEntry[]>;
  findByScheduledJob(jobId: ScheduledJobId): Promise<OperationJournalEntry | null>;
  parked(): Promise<readonly OperationJournalEntry[]>;
  runRetention(): Promise<RetentionReport>;
}
```

`classify` is pure, reads no git state and performs no I/O — the clone store owns the observation,
the journal owns the rule. `settle` takes the notification because the outbox row and the state
change commit in one transaction; `null` is the ordinary case. `appendStep` writes the step in the
`applied` state, before the call it describes.

### L1 — recovery catalogue

```ts
interface RecoveryCatalogue {
  register(descriptor: RecoveryDescriptor): Outcome<void, RecoveryCatalogueError>;
  lookup(tool: RegistryToolName): RecoveryDescriptor | null;
  registeredTools(): ReadonlySet<RegistryToolName>;
}
```

Populated by the composition root. It never imports a domain module.

### L1 — audit

```ts
interface Audit {
  append(input: AuditAppendInput): Promise<AuditAppendOutcome>;
  query(filter: AuditQuery): Promise<Outcome<AuditPage, AuditError>>;
  verify(): Promise<AuditChainState>;
  chainState(): Promise<AuditChainState>;
  runRetention(): Promise<RetentionReport>;
  close(): Promise<void>;
}
```

`close` releases the module's own handle on the structured store, mirroring `StructuredStore.close`.
The lifecycle module calls it during shutdown: a module that opens a resource is the module that
releases it, and leaving the handle to process exit makes an in-process restart hold a file open on
a host that refuses to unlink open files.

`append` never throws and never rejects. Every append passes through one writer inside the module,
which is what assigns `sequence`, `previousHash` and `hash`.

### L1 — notifier

```ts
interface Notifier {
  enqueue(request: NotificationRequest, tx: StoreTransaction): void;
  deliverPending(): Promise<DeliveryReport>;
  redriveUndelivered(): Promise<DeliveryReport>;
  listFailed(): Promise<readonly OutboxRow[]>;
  clearFailed(id: OutboxRowId, actor: ActorRef): Promise<Outcome<void, NotifierError>>;
  runRetention(): Promise<RetentionReport>;
}
```

`enqueue` is synchronous and takes a transaction, so the row and the settle commit together.
Delivery happens afterwards and never blocks the operation it describes.

### L1 — lifecycle

```ts
interface BootJobReport {
  readonly markedDone: readonly ScheduledJobId[];
  readonly markedNeedsAttention: readonly ScheduledJobId[];
  readonly returnedToPending: readonly ScheduledJobId[];
  readonly leftRunning: readonly ScheduledJobId[];
}

interface RevalidationReport {
  readonly jobsParked: readonly ScheduledJobId[];
  readonly entriesParked: readonly OperationId[];
}

interface BootReport {
  readonly lease: InstanceLease;
  readonly leaseSelfTestPassed: boolean;
  readonly registryFingerprint: Sha256Hex;
  readonly consoleFingerprint: Sha256Hex;
  readonly migrationsApplied: number;
  readonly provisioningPending: boolean;
  readonly auditChain: AuditChainState;
  readonly jobsResolved: BootJobReport;
  readonly revalidation: RevalidationReport;
  readonly clones: readonly Clone[];
  readonly recoveryPending: readonly DeclarationId[];
}

type ShutdownReason = 'signal' | 'fatal' | 'operator';

interface Lifecycle {
  boot(): Promise<Outcome<BootReport, BootError>>;
  runMaintenance(reason: MaintenanceReason): Promise<MaintenanceReport>;
  recoverDeclaration(declarationId: DeclarationId): Promise<Outcome<readonly RecoveryClassification[], BootError>>;
  shutdown(reason: ShutdownReason): Promise<void>;
}
```

`recoverDeclaration` is the lazy pass, called on first use and by the background sweep. Any resume
step it runs goes through the injected dispatch and takes the global mutation lock for itself,
completing before the triggering call acquires anything.

Boot step 1's lock is taken through an injected seam, because the failure it must detect is a
property of the volume rather than of this code, and a volume that does not exclude cannot be
produced on demand in a test:

```ts
interface LeaseGuard {
  release(): void;
}

type LeaseAcquisition =
  | { readonly acquired: true; readonly guard: LeaseGuard }
  | { readonly acquired: false };

interface LockAcquirer {
  acquire(lockPath: string): LeaseAcquisition;
  childIsRefused(lockPath: string): boolean;
}
```

`childIsRefused` spawns a **real second process** that attempts the same lock and reports whether
it was refused. A child rather than a second acquire from this process, because the property
relied on is cross-process exclusion: a same-process re-acquire tests the locking API, and can
pass on a broken volume and fail on a sound one. An acquirer whose `childIsRefused` returns false
makes boot fatal with `lease-not-exclusive`.

The deployment supplies one implementation. Everything else the lifecycle and store modules export
— factories, options records and the migration list — is an internal helper and out of scope here,
per this section's opening rule.

### L2 — git operations

```ts
interface CallContext {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId | null;
  readonly generation: Generation | null;
  readonly cloneRoot: ClonePath | null;
  readonly actorRef: ActorRef;
  readonly capabilities: EffectiveGrant;
  readonly writablePathPrefixes: readonly PathPrefix[];
  readonly context: OperationContextKind;
  readonly scheduledJobId: ScheduledJobId | null;
  readonly deadline: IsoUtcTimestamp;
  readonly signal: AbortSignal;
}

type DomainOperation<TInput, TData> = (ctx: CallContext, input: TInput) => Promise<ToolResult<TData>>;

type PathRejection =
  | { readonly kind: 'malformed'; readonly rule: string }
  | { readonly kind: 'outside-allowlist'; readonly prefixes: readonly PathPrefix[] }
  | { readonly kind: 'stripped-by-profile'; readonly prefix: PathPrefix };

interface GitOperations {
  readonly status: DomainOperation<RepoStatusInput, RepoStatusData>;
  readonly log: DomainOperation<GitLogInput, GitLogData>;
  readonly branches: DomainOperation<BranchesInput, BranchesData>;
  readonly health: DomainOperation<RepoHealthInput, RepoHealthData>;
  readonly diff: DomainOperation<GitDiffInput, GitDiffData>;
  readonly stage: DomainOperation<GitStageInput, GitStageData>;
  readonly commit: DomainOperation<GitCommitInput, GitCommitData>;
  readonly restorePaths: DomainOperation<RestorePathsInput, RestorePathsData>;
  readonly push: DomainOperation<GitPushInput, GitPushData>;
  readonly fetch: DomainOperation<GitFetchInput, GitFetchData>;
  readonly syncBase: DomainOperation<SyncBaseInput, SyncBaseData>;
  readonly raw: DomainOperation<GitRawInput, GitRawData>;

  loadRepositoryConfig(ctx: CallContext): Promise<Outcome<RepositoryConfig, GitOperationsError>>;
  validateWritePath(ctx: CallContext, path: string): Outcome<RepoRelativePath, PathRejection>;
}
```

`validateWritePath` returns `malformed` for `-A`, `--all`, `.`, and any path containing `..` or
`;`, which the pipeline maps to `validation`. The other two map to `authorization` and are audited,
because that refusal is the signal of an unattended actor probing its unlock paths.

`loadRepositoryConfig` reads from the working tree on every call and caches nothing.

The twelve operations' input and output types are **named above but not defined here**, because the
design does not determine them. `RepoStatusInput`, `BranchesInput`, `RepoHealthInput`,
`GitDiffInput`, `GitPushInput`, `GitFetchInput`, `SyncBaseInput` and every `*Data` are placeholders
that U1 must define; declaring them here with guessed fields would be inventing the product
surface. What the design and the brief do fix:

```ts
interface GitStageInput { readonly paths: readonly RepoRelativePath[] }
interface RestorePathsInput { readonly paths: readonly RepoRelativePath[] }
interface GitCommitInput { readonly message: string }
interface GitLogInput { readonly ref: BranchName | null }
interface GitRawInput { readonly argv: readonly string[] }
```

`GitLogInput.ref` defaults to `origin/<baseBranch>` when null, never to `HEAD`. `GitRawInput.argv`
is rejected before the process starts when it selects an executable, injects configuration, carries
a remote operand that does not normalise to this declaration's own `cloneUrl`, or invokes a
subcommand that persists a remote — `remote add`, `remote set-url`, `submodule add`, or a `config`
write matching `remote.*`. There is no force flag anywhere in `GitPushInput`, and there is no
reset, clean, rebase or branch-delete operation on this interface. The remaining fields of all
twelve are **not determined** — see `## Unresolved`.

**S6 resolves U1 for the five read operations.** Their input and output types, fixed here:

```ts
interface RepoStatusInput {}

interface RepoStatusEntry {
  readonly path: RepoRelativePath;
  readonly staged: boolean;
}

interface RepoStatusData {
  readonly branch: BranchName;
  readonly baseBranch: BranchName;
  readonly dirty: boolean;
  readonly parkedOffBase: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly changedPaths: readonly RepoStatusEntry[];
  readonly observedRemote: CloneUrl | null;
  readonly readStamp: ReadStamp;
}

interface GitLogEntry {
  readonly sha: GitSha;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: IsoUtcTimestamp;
  readonly subject: string;
}

interface GitLogData {
  readonly ref: BranchName;
  readonly commits: readonly GitLogEntry[];
  readonly readStamp: ReadStamp;
}

interface BranchesInput {}

interface BranchSummary {
  readonly name: BranchName;
  readonly current: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly lastCommitAt: IsoUtcTimestamp | null;
}

interface BranchesData {
  readonly baseBranch: BranchName;
  readonly branches: readonly BranchSummary[];
  readonly readStamp: ReadStamp;
}

interface RepoHealthInput {}

interface StaleBranchSummary {
  readonly count: number;
  readonly names: readonly BranchName[];
}

interface RepoHealthData {
  readonly branch: BranchName;
  readonly baseBranch: BranchName;
  readonly dirty: boolean;
  readonly parkedOffBase: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly commitsLast7Days: number;
  readonly daysSinceLastCommit: number | null;
  readonly staleBranches: StaleBranchSummary;
  readonly readStamp: ReadStamp;
}

interface GitDiffInput {
  readonly staged: boolean;
  readonly paths: readonly RepoRelativePath[] | null;
}

interface GitDiffData {
  readonly diff: string;
  readonly checkClean: boolean;
  readonly checkOutput: string;
  readonly readStamp: ReadStamp;
}
```

`RepoHealthData` carries no GitHub-derived field — no PR count, deploy status or check pass rate.
`GitOperations` (L2) depends on L1 only; folding host data into this tool would give it a dependency
the module table does not grant it. A combined local-plus-host view, if wanted, is a composite, not
this tool.

The five registry entries S6 ships, naming the tools by the brief's own convention (`git_commit`,
`repo_declare`):

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `repo_status` | `{ kind: 'module', target: 'git.status' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |
| `git_log` | `{ kind: 'module', target: 'git.log' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: true }` | `{ timeoutSeconds: 30, maxResultBytes: 1048576 }` |
| `git_branches` | `{ kind: 'module', target: 'git.branches' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 262144 }` |
| `repo_health` | `{ kind: 'module', target: 'git.health' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |
| `git_diff` | `{ kind: 'module', target: 'git.diff' }` | `['repo.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: true }` | `{ timeoutSeconds: 30, maxResultBytes: 4194304 }` |

Every entry has `capabilityScope: 'declaration'`. `git_log` and `git_diff` carry
`untrustedOutput: true`: commit subjects and diff bodies are written by repository contributors,
not the operator, which is exactly the "author-controlled text as data" case the annotation exists
for elsewhere on `HostComment.body`. `repo_status`, `git_branches` and `repo_health` carry only
branch names and counts, and stay `false`. None is `schedulable` — a periodic read has no
declared consumer yet, and the annotation is easy to flip on a future tool that wants one.
`timeoutSeconds` is short because all five run against the local clone only, with no network call.

**S7 resolves U1 for the three local mutating operations** — `git_stage`, `git_commit`,
`git_restore_paths`. `GitStageInput`, `RestorePathsInput` and `GitCommitInput` are already fixed
above; their output types, fixed here:

```ts
interface GitStageData {
  readonly staged: readonly RepoRelativePath[];
}

interface GitCommitData {
  readonly sha: GitSha;
  readonly branch: BranchName;
  readonly changedPaths: readonly RepoRelativePath[];
}

interface RestorePathsData {
  readonly restored: readonly RepoRelativePath[];
}
```

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
| `git_stage` | `{ kind: 'module', target: 'git.stage' }` | `['git.local.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |
| `git_commit` | `{ kind: 'module', target: 'git.commit' }` | `['git.local.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |
| `git_restore_paths` | `{ kind: 'module', target: 'git.restorePaths' }` | `['git.local.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |

Every entry carries `capabilityScope: 'declaration'`, the same as every S6 entry. None is
`schedulable` — a scheduled job naming a bare local mutation with no commit message or path input
of its own has no declared consumer yet — and none is `dropTarget`, which S17's watcher tools claim
for themselves. `timeoutSeconds` matches the five read tools': all three run against the local
clone only, with no network call, and the design's per-declaration path-allowlist and two-lock
machinery is what bounds their cost, not a longer cap.

**S9 resolves U1 for the three remote operations** — `git_push`, `git_fetch`, `sync_base`. Their
input and output types, fixed here:

```ts
interface GitPushInput {
  readonly branch: BranchName | null;
}

interface GitPushData {
  readonly branch: BranchName;
  readonly headSha: GitSha;
  readonly alreadyUpToDate: boolean;
}

interface GitFetchInput {}

interface GitFetchData {
  readonly baseBranch: BranchName;
  readonly upstreamSha: GitSha | null;
  readonly updatedRefs: readonly BranchName[];
}

interface SyncBaseInput {}

interface SyncBaseData {
  readonly baseBranch: BranchName;
  readonly headSha: GitSha;
  readonly upstreamSha: GitSha;
  readonly fastForwarded: boolean;
}
```

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
| `git_push` | `{ kind: 'module', target: 'git.push' }` | `['git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |
| `git_fetch` | `{ kind: 'module', target: 'git.fetch' }` | `['git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |
| `sync_base` | `{ kind: 'module', target: 'git.syncBase' }` | `['git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |

Every entry carries `capabilityScope: 'declaration'`. All three are `mutating` rather than `read`,
`git_fetch` included: it moves remote-tracking refs, and the global mutation lock is what keeps a
transfer from interleaving with another declaration's commit. `timeoutSeconds` is ten times the
local tools' because these are the first operations that cross a network — the cap has to bound a
transfer, not a local `git add`. None is `schedulable`: a scheduled bare push with no branch of its
own has no declared consumer, and S16's held operations are where that question is actually
answered.

### L2 — composites

```ts
interface Composite<TInput, TData> {
  readonly tool: RegistryToolName;
  readonly run: DomainOperation<TInput, TData>;
  readonly recovery: RecoveryDescriptor;
}

interface Composites {
  readonly prepareBranch: Composite<PrepareBranchInput, PrepareBranchData>;
  readonly reconcileAfterMerge: Composite<ReconcileAfterMergeInput, ReconcileAfterMergeData>;
}
```

Each composite ships its own `RecoveryDescriptor`, which the composition root registers into the
catalogue. Every sub-step that mutates outside the local clone calls `Journal.appendStep` before
making the call. Input and output types are subject to the same `## Unresolved` item as the git
operations.

**Implementation note (S12):** the shipped `GitOperations`, `HostOperations` and now `Composites`
modules all expose plain `DomainOperation`s, with each operation's `RecoveryDescriptor` held in a
sibling `recovery-descriptors.ts` file and registered into the catalogue by the composition root at
startup (`git/recovery-descriptors.ts`, `host/recovery-descriptors.ts`,
`composites/recovery-descriptors.ts`) — never bundled with the operation itself. This is a documented
drift from the `Composite<TInput, TData>` wrapper above, which this slice does not build: the
`{ tool, run, recovery }` bundle was written before S6–S11 established the actual pattern every other
L2 module now follows, and building a second, different shape for composites alone would be the
inconsistency, not the fix. Flagged for `/reconcile` rather than resolved here.

**S12 resolves U1 for the two composites.** Their input and output types, fixed here:

```ts
interface PrepareBranchInput {
  readonly branch: BranchName;
}

type PrepareBranchAction = 'reused-existing' | 'created-from-remote-base' | 'fast-forwarded-then-created' | 'rebased-preserved-commits';

interface PrepareBranchData {
  readonly branch: BranchName;
  readonly baseBranch: BranchName;
  readonly branchHeadSha: GitSha;
  readonly baseSha: GitSha;
  readonly preservedCommits: readonly GitSha[];
  readonly action: PrepareBranchAction;
}

interface ReconcileAfterMergeInput {
  readonly pullRequestNumber: number;
  readonly expectedHeadSha: GitSha | null;
}

interface ReconcileAfterMergeData {
  readonly baseBranch: BranchName;
  readonly baseSha: GitSha;
  readonly mergeCommitSha: GitSha;
  readonly deletedBranch: BranchName | null;
}
```

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
| `prepare_branch` | `{ kind: 'module', target: 'composites.prepareBranch' }` | `['git.local.write', 'git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |
| `reconcile_after_merge` | `{ kind: 'module', target: 'composites.reconcileAfterMerge' }` | `['git.local.write', 'git.remote.write', 'host.pr.read']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 300, maxResultBytes: 65536 }` |

Both carry `capabilityScope: 'declaration'`, matching every other L2 tool.

**Resume, not a narrower step (S12.4, S12.5).** Both descriptors' `resume` re-dispatches the *same*
composite tool with the journal entry's original input, rather than a finer-grained step — safe only
because both composites are written to be idempotent from any partial state (see
`composites/recovery-descriptors.ts`'s doc comment). `expectedPostState` always returns `false` for
both, the same honest-absence reasoning `sync_base`'s own descriptor already gives: neither
composite's effect is fully visible in `ObservedGitState`.

### L2 — host adapter

```ts
interface PullRequestRef {
  readonly number: number;
  readonly url: HttpsUrl;
  readonly branch: BranchName;
}

type PullRequestState = 'open' | 'merged' | 'closed';

interface PullRequestStatus {
  readonly ref: PullRequestRef;
  readonly state: PullRequestState;
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
  readonly mergeCommitSha: GitSha | null;
  readonly mergeable: boolean | null;
  readonly autoMergeEnabled: boolean;
}

interface CheckStatus {
  readonly name: string;
  readonly conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'pending';
  readonly detailsUrl: HttpsUrl | null;
}

interface DeployStatus {
  readonly workflow: string;
  readonly commitSha: GitSha;
  readonly conclusion: 'success' | 'failure' | 'cancelled' | 'pending';
  readonly detailsUrl: HttpsUrl | null;
}

interface HostComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: IsoUtcTimestamp;
}

interface RequestBudget {
  readonly remaining: number;
  readonly resetsAt: IsoUtcTimestamp | null;
}

interface HostAdapter {
  readonly kind: HostKind;
  createPullRequest(ctx: CallContext, input: CreatePullRequestInput): Promise<Outcome<PullRequestRef, HostError>>;
  readPullRequest(ctx: CallContext, number: number): Promise<Outcome<PullRequestStatus, HostError>>;
  listPullRequests(ctx: CallContext, state: PullRequestState | null): Promise<Outcome<readonly PullRequestStatus[], HostError>>;
  readPullRequestComments(ctx: CallContext, number: number): Promise<Outcome<readonly HostComment[], HostError>>;
  enableAutoMerge(ctx: CallContext, number: number): Promise<Outcome<void, HostError>>;
  readChecks(ctx: CallContext, ref: GitSha): Promise<Outcome<readonly CheckStatus[], HostError>>;
  readDeployStatus(ctx: CallContext, workflow: string, ref: GitSha): Promise<Outcome<DeployStatus, HostError>>;
  remainingBudget(ref: CredentialRef): RequestBudget;
}
```

`HostComment.body` is author-controlled text carried as data; the tool returning it is annotated
`untrustedOutput`. There is no merge method and no rebase method on this interface, and by design
there never will be — the host's own auto-merge is the only merge path.

**S10 resolves U1 for the host tools**, `CreatePullRequestInput` included. Their input and output
types, fixed here:

```ts
interface CreatePullRequestInput {
  readonly title: string;
  readonly body: string;
  readonly headBranch: BranchName | null;
  readonly draft: boolean;
}

interface PrOpenData {
  readonly ref: PullRequestRef;
}

interface PrStatusInput {
  readonly number: number;
}

interface PrStatusData {
  readonly status: PullRequestStatus;
}

interface PrListInput {
  readonly state: PullRequestState | null;
}

interface PrListData {
  readonly pullRequests: readonly PullRequestStatus[];
}

interface PrCommentsInput {
  readonly number: number;
}

interface PrCommentsData {
  readonly comments: readonly HostComment[];
}

interface PrEnableAutoMergeInput {
  readonly number: number;
}

interface PrEnableAutoMergeData {
  readonly number: number;
  readonly autoMergeEnabled: boolean;
}

interface ChecksStatusInput {
  readonly ref: GitSha | null;
}

interface ChecksStatusData {
  readonly ref: GitSha;
  readonly checks: readonly CheckStatus[];
}

interface ChecksAwaitInput {
  readonly ref: GitSha | null;
  readonly timeoutSeconds: number;
}

interface ChecksAwaitData {
  readonly ref: GitSha;
  readonly checks: readonly CheckStatus[];
  readonly concluded: boolean;
  readonly waitedSeconds: number;
}
```

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
| `pr_open` | `{ kind: 'module', target: 'host.createPullRequest' }` | `['host.pr.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 120, maxResultBytes: 65536 }` |
| `pr_status` | `{ kind: 'module', target: 'host.readPullRequest' }` | `['host.pr.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 60, maxResultBytes: 65536 }` |
| `pr_list` | `{ kind: 'module', target: 'host.listPullRequests' }` | `['host.pr.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 60, maxResultBytes: 65536 }` |
| `pr_comments` | `{ kind: 'module', target: 'host.readPullRequestComments' }` | `['host.pr.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: true }` | `{ timeoutSeconds: 60, maxResultBytes: 131072 }` |
| `pr_enable_auto_merge` | `{ kind: 'module', target: 'host.enableAutoMerge' }` | `['host.pr.write']` | `['write']` | `mutating` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 120, maxResultBytes: 65536 }` |
| `checks_status` | `{ kind: 'module', target: 'host.readChecks' }` | `['host.checks.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 60, maxResultBytes: 65536 }` |
| `checks_await` | `{ kind: 'module', target: 'host.awaitChecks' }` | `['host.checks.read']` | `['read']` | `monitoring-wait` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 1800, maxResultBytes: 65536 }` |

Every entry carries `capabilityScope: 'declaration'`. `pr_comments` is annotated `untrustedOutput`
for the reason `git_log` and `git_diff` already are: `HostComment.body` is author-controlled text,
carried as data rather than interpreted. It is the only host tool that carries the annotation — the
other six return host-controlled structure (numbers, states, shas, check names) rather than prose,
and annotating those would dilute what the annotation means. Its `maxResultBytes` is doubled because
comment threads are the one host response that grows without bound, and the size limit rather than
truncation is what bounds it.

`checks_await` is the registry's first `monitoring-wait`. Its `timeoutSeconds` equals
`monitoringWaitCapSeconds`, which is the compiler-enforced ceiling (`limit-exceeds-cap`) rather than
a coincidence; `ChecksAwaitInput.timeoutSeconds` is clamped to it at dispatch, so a request for
3600 s waits 1800 s rather than being refused. It declares `host.checks.read` and no mutating
capability — invariant C7's requirement — and takes neither lock.

`readDeployStatus` has **no registry entry**. Deploy monitoring and published-URL verification are
S12's, and S10's `Out of scope` line says so; the adapter method exists because the interface fixes
it, and is unreachable from every surface until S12 declares a tool over it.

There is no registry entry over a merge or rebase either, because there is no such adapter method to
declare one over. That absence is `10-design.md`'s auto-merge-only rule expressed in the compiled
registry, where it is checkable, rather than as a runtime refusal.

### L2 — scheduler

```ts
interface SkippedJob {
  readonly id: ScheduledJobId;
  readonly reason: string;
}

interface TickReport {
  readonly fired: readonly ScheduledJobId[];
  readonly skipped: readonly SkippedJob[];
  readonly cancelled: readonly SkippedJob[];
}

interface Scheduler {
  create(input: CreateJobInput, ctx: CallContext): Promise<Outcome<ScheduledJob, SchedulerError>>;
  list(declarationId: DeclarationId | null, status: ScheduledJobStatus | null): Promise<readonly ScheduledJob[]>;
  cancel(id: ScheduledJobId, ctx: CallContext, reason: string): Promise<Outcome<ScheduledJob, SchedulerError>>;
  cancelForDeclaration(declarationId: DeclarationId, reason: string, tx: StoreTransaction): readonly ScheduledJobId[];
  tick(now: IsoUtcTimestamp): Promise<TickReport>;
  resolveRunningAtBoot(): Promise<BootJobReport>;
  revalidatePending(registry: CompiledRegistry): Promise<readonly ScheduledJobId[]>;
  runRetention(): Promise<RetentionReport>;
}
```

Constructed with `Dispatch` injected; it never imports the pipeline. `resolveRunningAtBoot`
classifies from the journal alone and runs no resume step and no git or host I/O.

### L2 — watcher

```ts
interface Watcher {
  start(): Promise<Outcome<void, WatcherError>>;
  stop(): Promise<void>;
  recoverInterruptedClaims(): Promise<readonly WatchTickReport[]>;
  tick(): Promise<readonly WatchTickReport[]>;
  runRetention(): Promise<RetentionReport>;
}
```

Constructed with `Dispatch` injected, exactly as the scheduler is. Every git and host step goes
through that dispatch, so the watcher depends on neither `GitOperations` nor `HostAdapter`.
`start` fails unless all three switches are on: remote operations permitted, watcher enabled, and
at least one declaration naming a drop.

### L3 — module adapter

```ts
type ModuleHandler = (ctx: CallContext, input: JsonValue) => Promise<ToolResult<JsonValue>>;

interface ModuleAdapter {
  register(target: ModuleTargetName, handler: ModuleHandler): Outcome<void, ModuleAdapterError>;
  invoke(target: ModuleTargetName, ctx: CallContext, input: JsonValue): Promise<ToolResult<JsonValue>>;
  registeredTargets(): ReadonlySet<ModuleTargetName>;
}
```

The catalogue is populated by registration at composition time. It never imports a handler.

### L3 — http adapter

```ts
interface HttpAdapter {
  invoke(operation: HttpOperationName, ctx: CallContext, input: JsonValue, limits: ToolLimits): Promise<ToolResult<JsonValue>>;
  declaredOperations(): ReadonlySet<HttpOperationName>;
}
```

Its one consumer is published-URL verification of a managed repository, which is unauthenticated,
so the adapter takes no credential dependency and its L1-only dependency list stands.

**S12 resolves U1 for the http adapter's one operation and ships it.** Unlike `ModuleAdapter`, this
interface fixes no `register` method — one real consumer, fixed internally by the factory rather than
a pluggable catalogue, is what "its one consumer" above already says.

```ts
interface VerifyPublishedUrlInput {
  readonly url: HttpsUrl;
  readonly expectedCommitSha: GitSha;
}

interface VerifyPublishedUrlData {
  readonly url: HttpsUrl;
  readonly commitSha: GitSha;
}
```

**The convention this operation reads is a lower-bound decision, not a design fact the brief or
`10-design.md` fixes anywhere:** the published URL is expected to answer a 200 whose JSON body carries
`commitSha` — the one shape this design already establishes for "a running thing's commit", since this
service's own `/healthz` answers `{ ready, commitSha }` (`surfaces/http-server.ts`, S2). A managed
repository's deploy is expected to expose the same shape at the URL declared for verification. Recorded
in `90-decisions.md` alongside the other slices' own U1 lower-bound choices.

`verify_published_url`'s registry entry:

| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |
|---|---|---|---|---|---|---|
| `verify_published_url` | `{ kind: 'http', operation: 'verify-published-url' }` | `['host.checks.read']` | `['read']` | `read` | `{ schedulable: false, dropTarget: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 4096 }` |

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

```ts
interface DispatchRequest {
  readonly toolName: RegistryToolName;
  readonly input: JsonValue;
  readonly session: Session;
  readonly declarationId: DeclarationId | null;
  readonly scheduledJobId: ScheduledJobId | null;
  readonly context: OperationContextKind;
  readonly signal: AbortSignal;
}

type Dispatch = (request: DispatchRequest) => Promise<ToolResult<JsonValue>>;

interface DispatchPipeline {
  readonly dispatch: Dispatch;
  visibleTools(session: Session, declaration: Declaration | null): readonly ToolDeclaration[];
}
```

`visibleTools` is what `tools/list` returns and what the console filters views against. A tool the
session may not call is absent from it, not merely refused by `dispatch`.

`declarationId` is the declaration the call is against: the session binding for `mcp` and
`watcher`, the route for `operator`, the job for `scheduler`. It is null for an instance-scoped
call, whose target — where it has one — arrives inside `input`. `scheduledJobId` travels by value,
as `actorRef` does, and the pipeline stamps it onto the journal entry it creates; no caller
supplies an `operationId`.

### L4 — authorization

```ts
interface ClientRegistrationRequest {
  readonly redirectUris: readonly HttpsUrl[];
  readonly clientName: string;
}

interface RefreshedTokens {
  readonly access: IssuedToken;
  readonly refresh: IssuedToken;
}

interface McpGrantInput {
  readonly clientId: ClientId;
  readonly subject: Subject;
  readonly resource: McpResourceUri;
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly scopes: readonly McpScope[];
}

interface IssuedMcpGrant {
  readonly grant: Grant;
  readonly access: IssuedToken;
  readonly refresh: IssuedToken;
}

interface Authorization {
  registerClient(request: ClientRegistrationRequest): Promise<Outcome<OAuthClient, AuthorizationError>>;
  getClient(clientId: ClientId): Promise<OAuthClient | null>;
  issueMcpGrant(input: McpGrantInput, actor: ActorRef): Promise<Outcome<IssuedMcpGrant, AuthorizationError>>;
  establishMcpSession(bearer: BearerToken, resource: McpResourceUri): Promise<Outcome<Session, AuthorizationError>>;
  verifyOperatorApiToken(bearer: BearerToken): Promise<Outcome<Session, AuthorizationError>>;
  issueOperatorApiToken(subject: Subject, scopes: readonly OperatorScope[], actor: ActorRef): Promise<Outcome<IssuedToken, AuthorizationError>>;
  refresh(bearer: BearerToken): Promise<Outcome<RefreshedTokens, AuthorizationError>>;

  recomputeSessionGrant(session: Session, declaration: Declaration | null): Outcome<Session, AuthorizationError>;
  grantIsLive(grantId: GrantId): Promise<boolean>;

  listGrants(kind: GrantKind | null): Promise<readonly GrantView[]>;
  revokeClient(clientId: ClientId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>>;
  revokeGrant(grantId: GrantId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>>;
  revokeToken(jti: TokenId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>>;
  revokeGrantsForResource(declarationId: DeclarationId, generation: Generation, tx: StoreTransaction): readonly GrantId[];
  revokeBearerToken(bearer: BearerToken, actor: ActorRef): Promise<Outcome<void, AuthorizationError>>;
  runRetention(): Promise<RetentionReport>;
}
```

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

### L4 — operator identity

```ts
type ProvisioningState = 'pending' | 'complete';

interface EnrolmentRequest {
  readonly provisioningSecret: string;
  readonly subject: Subject;
  readonly password: string;
}

interface EnrolmentResult {
  readonly totpSecret: string;
  readonly recoveryCodes: readonly string[];
}

interface LocalLoginRequest {
  readonly subject: Subject;
  readonly password: string;
  readonly totpCode: string;
}

interface OidcRedirect {
  readonly authorizeUrl: HttpsUrl;
  readonly state: string;
}

interface OperatorIdentity {
  provisioningState(): Promise<ProvisioningState>;
  enrol(request: EnrolmentRequest): Promise<Outcome<EnrolmentResult, OperatorIdentityError>>;

  loginLocal(request: LocalLoginRequest): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  loginWithRecoveryCode(subject: Subject, password: string, code: string): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  loginWithBreakGlass(token: string): Promise<Outcome<OperatorSession, OperatorIdentityError>>;

  beginOidc(): Promise<Outcome<OidcRedirect, OperatorIdentityError>>;
  completeOidc(code: string, state: string): Promise<Outcome<OperatorSession, OperatorIdentityError>>;

  touch(sessionId: SessionId): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  logout(sessionId: SessionId): Promise<Outcome<void, OperatorIdentityError>>;
  revokeSession(sessionId: SessionId, actor: ActorRef): Promise<Outcome<void, OperatorIdentityError>>;
  listSessions(): Promise<readonly OperatorSession[]>;
  runRetention(): Promise<RetentionReport>;
}
```

`EnrolmentResult` is the only place the TOTP secret and the recovery codes exist in the clear, and
it is returned exactly once. The store holds hashes.

### L0 — contract types and compiler

```ts
interface ContractAuthoring {
  tool(declaration: ToolDeclaration): ToolDeclaration;
}

interface Compiler {
  compile(declarations: readonly ToolDeclaration[]): Outcome<CompilerArtifact, readonly CompilerError[]>;
  fingerprint(registry: CompiledRegistry): Sha256Hex;
}
```

The compiler is build-time only and is not present at runtime.

### L5 — surfaces

Surfaces expose nothing inward. Three things about them are contract-level rather than
implementation:

```ts
declare const MCP_RESOURCE_URI_TEMPLATE: '/mcp/{declarationId}';

interface LivenessReport {
  readonly ready: boolean;
  readonly commitSha: GitSha;
}

interface VersionReport {
  readonly commitSha: GitSha;
  readonly contractFingerprint: Sha256Hex;
  readonly consoleFingerprint: Sha256Hex;
}

interface HealthReport {
  readonly ready: boolean;
  readonly provisioningPending: boolean;
  readonly version: VersionReport;
  readonly auditChain: AuditChainState;
  readonly failedOutboxRows: number;
  readonly failingCredentialRefs: readonly CredentialFailureMark[];
  readonly parkedOperations: number;
  readonly volume: VolumeUsage;
}
```

`LivenessReport` is the **only** payload served without authentication, on `/healthz`. It carries
readiness and the running commit and nothing else. `VersionReport` and `HealthReport` are
authenticated console routes: the fingerprints, the chain state, the failing credential references
and the volume breakdown are all operator data, and item 15's companion check reaches the catalogue
through an authenticated `tools/list` rather than through the probe.

A bearer route accepts no cookie and a cookie route accepts no bearer. The route table itself is
not fixed here — see `## Unresolved`.

**Three paths are fixed, ahead of that table, because they already ship**: `LivenessReport` on
`GET /healthz` unauthenticated, `VersionReport` on `GET /version`, and `HealthReport` on
`GET /health`, the latter two authenticated. U4 still owns the rest of the route table, but these
three are externally observable — an operator's monitoring binds to them — so U4 resolving later
must accept them rather than rename a live endpoint.

#### OAuth endpoints and the MCP transport (resolves U5)

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
| `/oauth/revoke` | `POST` | bearer | Revokes the presented token via `revokeToken` (RFC 7009) |
| `/mcp/{declarationId}` | `POST` | bearer, audience-checked against the path | The MCP JSON-RPC transport: `initialize`, `tools/list`, `tools/call` |

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

### Exec

```ts
type ExecError = ModuleErrorBase & (
  | { readonly code: 'spawn-failed' }
  | { readonly code: 'nonzero-exit'; readonly exitCode: number; readonly stderr: string }
  | { readonly code: 'timed-out'; readonly limitSeconds: number }
  | { readonly code: 'argv-rejected'; readonly rule: string }
  | { readonly code: 'cancelled' }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `spawn-failed` | The fixed executable could not be started | no | `infrastructure` — the environment is wrong, not the request |
| `nonzero-exit` | The child exited non-zero; `stderr` is already scrubbed | no | Classify by domain: auth rejection to `upstream`, a refused push to `precondition` |
| `timed-out` | The declared cap elapsed and the child was killed | no | `timeout`, and park the journal entry — what the command achieved is not knowable |
| `argv-rejected` | The vector selects an executable, injects configuration, carries a foreign remote operand, or persists a remote | no | `validation`; no authority could ever permit it |
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
  | { readonly code: 'drop-tool-not-annotated'; readonly tool: RegistryToolName }
  | { readonly code: 'adoption-refused'; readonly blockers: readonly EvictionBlocker[] }
  | { readonly code: 'remote-mismatch'; readonly declared: CloneUrl; readonly observed: CloneUrl }
  | { readonly code: 'clone-still-present' }
  | { readonly code: 'drop-directory-not-empty'; readonly files: number }
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
| `drop-tool-not-annotated` | `contentDrop.tool` is not annotated a drop target | no | `validation` |
| `adoption-refused` | Re-declaring an id whose orphaned clone is not clean, across every generation | no | `precondition` naming the blockers. The exit is to push the work, then `clone.remove` |
| `remote-mismatch` | The orphaned clone points at a different remote | no | `precondition`. Never repoint an existing checkout |
| `clone-still-present` | `declaration.remove` while a clone remains | no | `precondition` naming `clone.remove` |
| `drop-directory-not-empty` | `declaration.remove` while the inbox holds files | no | `precondition` |
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
| `reference-unreadable` | The file exists and cannot be read | no | `infrastructure` |
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
| `corrupt-tree` | `rev-parse --git-dir` fails | no | `precondition` naming `clone.remove` with its override as the exit |
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
  | { readonly code: 'entry-not-found'; readonly operationId: OperationId }
  | { readonly code: 'invalid-transition'; readonly from: JournalEntryState; readonly to: JournalEntryState }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `intent-write-failed` | The intent record could not be written | no | **Abort the operation before acting.** Return `infrastructure` with no side effects — an unrecoverable mutation is worse than a refused one |
| `prestate-capture-failed` | Git state could not be observed under the lock | no | Abort, as above |
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
| `no-clone` | `ctx.cloneRoot` is null for a declaration-scoped operation | no | `infrastructure`. A defect: the pipeline materialises before invoking |

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
  | { readonly code: 'required-check-failed'; readonly check: string }
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
| `required-check-failed` | A declared required check concluded failure | no — terminal | `precondition`; the notifier fires |
| `not-found` | The pull request, check or workflow does not exist | no | `precondition` |
| `timed-out` | A bounded wait reached its cap | no | `timeout`; the notifier fires |

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

### Watcher

```ts
type WatcherError = ModuleErrorBase & (
  | { readonly code: 'not-permitted'; readonly missingSwitch: 'remote-operations' | 'watcher-enabled' | 'no-declaration-declares-a-drop' }
  | { readonly code: 'drop-unreadable'; readonly file: DropFileName }
  | { readonly code: 'claim-failed'; readonly file: DropFileName }
  | { readonly code: 'step-failed'; readonly step: string; readonly result: ResultKind; readonly reason: string }
  | { readonly code: 'interrupted-claim'; readonly file: DropFileName }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `not-permitted` | Any of the three switches is off | no | Do not start. All three default off |
| `drop-unreadable` | A candidate cannot be read | no | Move it to `failed/`. A symlink is never a candidate in the first place |
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

type HttpAdapterError = ModuleErrorBase & (
  | { readonly code: 'operation-not-declared'; readonly operation: HttpOperationName }
  | { readonly code: 'unreachable-or-non-2xx'; readonly status: number | null }
  | { readonly code: 'unexpected-commit'; readonly expected: GitSha; readonly served: GitSha }
  | { readonly code: 'timed-out'; readonly limitSeconds: number }
);
```

`duplicate-registration`, `target-not-registered` and `operation-not-declared` are composition-time
and boot-time faults and are fatal there — boot verifies every registry operation has exactly one
executor. Reaching one at runtime is `infrastructure`.

The http adapter's other three variants are the complete failure set an unauthenticated GET can
distinguish: `unreachable-or-non-2xx` maps to `upstream`, `unexpected-commit` to `precondition`
naming both SHAs, `timed-out` to `timeout`. The four classifications of definition-of-done item 15
belong to the companion check and are not reachable here.

### Dispatch pipeline

```ts
type DispatchError = ModuleErrorBase & (
  | { readonly code: 'tool-not-found'; readonly tool: RegistryToolName }
  | { readonly code: 'capability-insufficient'; readonly missing: readonly CapabilityName[] }
  | { readonly code: 'scope-insufficient'; readonly missing: readonly Scope[] }
  | { readonly code: 'declaration-required' }
  | { readonly code: 'input-invalid'; readonly findings: readonly Finding[] }
  | { readonly code: 'output-invalid'; readonly findings: readonly Finding[] }
  | { readonly code: 'result-too-large'; readonly bytes: number; readonly limit: number }
  | { readonly code: 'grant-revoked' }
);
```

| Variant | Raised when | Retryable | Caller does |
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
  | { readonly code: 'oidc-unavailable'; readonly reason: 'discovery' | 'jwks' | 'signature' | 'validity-window' }
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
| `subject-not-allowlisted` | Federated login returned an unlisted subject | no | `401` |
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
);
```

Every variant **fails the build**. A warning is never sufficient — that is definition-of-done item
2, and the rejection counts it asks for are the counts of these.

`annotation-contradiction` covers a `read` execution class declaring a write capability, a
`monitoring-wait` declaring a mutating capability, and a `dropTarget` tool that is not `mutating`.
`limit-exceeds-cap` covers a `monitoring-wait` whose `timeoutSeconds` exceeds
`monitoringWaitCapSeconds`.

`no-executor` and `multiple-executors` are decided **within the declaration array alone**, because
`compile` receives nothing else and invariant B1 forbids L0 from importing the layer that
implements a target. `no-executor` is a declaration whose `ExecutionTarget` names an empty
identifier — nothing could ever execute it. `multiple-executors` is two or more declarations
claiming the identical target, by `kind` and identifier. Neither can detect a target that is
well-formed but unimplemented; boot does that, and it is boot that owns `executor-missing`.

Every `CompilerError` carries `resultKind: 'validation'`. A rejected declaration set is caller
input failing the contract — the envelope's own definition of `validation` — not a failure of the
service or its environment, so `isError` is false for all eight.

### Boot

```ts
type BootError = ModuleErrorBase & (
  | { readonly code: 'lease-held'; readonly holder: InstanceLease }
  | { readonly code: 'lease-not-exclusive' }
  | { readonly code: 'fingerprint-mismatch'; readonly expected: Sha256Hex; readonly found: Sha256Hex }
  | { readonly code: 'registry-unreadable'; readonly reason: string }
  | { readonly code: 'console-manifest-mismatch'; readonly expected: Sha256Hex; readonly found: Sha256Hex }
  | { readonly code: 'ceiling-outside-contract'; readonly capabilities: readonly CapabilityName[] }
  | { readonly code: 'executor-missing'; readonly tools: readonly RegistryToolName[] }
  | { readonly code: 'store-failed'; readonly cause: StoreError }
);
```

| Variant | Raised when | Retryable | Caller does |
|---|---|---|---|
| `lease-held` | A live instance holds the lease | no | Refuse to start, naming the holder from the lease contents |
| `lease-not-exclusive` | The child-process self-test was granted the same lock | no | **Fatal**, naming the volume configuration. This is the bind-mount case, and the alternative is two instances silently sharing one store |
| `fingerprint-mismatch`, `console-manifest-mismatch` | The artifact does not match what was built | no | Fatal. The service must never start with a smaller accidental tool set or a swapped bundle |
| `registry-unreadable` | The registry artifact is absent, unparseable, or carries no valid fingerprint | no | Fatal, naming the reason. Distinct from `fingerprint-mismatch`, which has two real digests to report; here there is nothing to compare, and reporting it as a mismatch would mean inventing them |
| `ceiling-outside-contract` | The deployment ceiling names a capability the contract set lacks | no | Fatal |
| `executor-missing` | A registry entry has no registered executor | no | Fatal |
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
| C3 | A mutating operation holds the materialisation lock for its whole duration; a read or a monitoring wait releases it once the clone is `ready`. | Dispatch pipeline |
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
| S8 | Every mutating call, every authorization rejection, every `git.raw` intent and outcome, every drop-file outcome, every identity event and every lease takeover produces an audit record. | Dispatch pipeline, Watcher, Operator identity, Lifecycle |
| S9 | `git.raw` appends its intent line, carrying the argument vector, before the child process starts. | Git operations |

### Envelope and surfaces

| # | Invariant | Responsible |
|---|---|---|
| E1 | `result.ok === (result.kind === 'success')`. | Result |
| E2 | `isError(k)` is true exactly for `upstream`, `timeout` and `infrastructure`. | Result |
| E3 | Token, audience and issuer failures produce `401` with a resource-metadata challenge and never a `ToolResult`. | Surfaces, Authorization |
| E4 | Every read result's data carries a `ReadStamp` whose `mutationInFlight` is scoped to the declaration read, not to the process-wide mutex. | Git operations |
| E5 | No code path returns a published URL in a success position without a confirmed successful deploy for that exact commit. | Host adapter, Http adapter |
| E6 | A bearer-authenticated route accepts no cookie, and a cookie-authenticated route accepts no bearer. | Surfaces |
| E7 | Every mutating cookie route requires an `Origin` check and a double-submit token. | Surfaces |
| E8 | No route exposing repository, credential, audit, volume or operator state is unauthenticated at any point in the lifecycle, enrolment included. `LivenessReport` on `/healthz` is the sole unauthenticated payload and carries only `ready` and `commitSha`. | Surfaces, Operator identity |

### Build and layering

| # | Invariant | Responsible |
|---|---|---|
| B1 | Nothing in L0, L3, L4 or L5 imports anything from L2, and the exemption is exactly one path — the composition root. | CI dependency-direction check |
| B2 | The module dependency graph is acyclic. The scheduler, the watcher and the lifecycle module receive `Dispatch` by injection; the module adapter and the recovery catalogue are populated by registration. | Composition root |
| B3 | Boot verifies the registry fingerprint and the console asset manifest, and refuses to start on a mismatch. | Lifecycle |
| B4 | The deployment ceiling is a subset of the contract capability set. Startup is fatal otherwise. | Lifecycle |
| B5 | Every registry entry has exactly one executor registered for its `ExecutionTarget`, verified at boot. | Lifecycle |
| B6 | `ScheduledJob.tool` names a registry entry annotated `schedulable`; `ContentDropConfig.tool` names one annotated `dropTarget`. Checked at creation, at fire time, and at boot re-validation. | Scheduler, Declarations |
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
| D6 | Nothing dropped into a content-drop directory is ever deleted by the service. Files move between the four stages only. | Watcher |
| D7 | A candidate drop file is stat-ed link-preservingly, so a symlink is never a candidate. | Watcher |
| D8 | A file found in `processing/` at startup is moved to `failed/` and never reprocessed. | Watcher |
| D9 | The pre-migration copy is taken before any migration runs, and the three most recent are retained. | Structured store |
| D10 | At most one `declaration` row per id has `state = 'active'`. | Structured store |

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
above. U1 otherwise stands: `raw` and the two composites remain open for the slices that ship them,
and `readDeployStatus` carries no tool until S12 declares one.

*Narrowed further 2026-08-09:* S12 resolves U1 for `prepare_branch`, `reconcile_after_merge` and
`verify_published_url` — their input and output types and registry entries. See `### L2 — composites`
and `### L3 — http adapter` above. U1 otherwise stands: only `raw` remains open, for the slice that
ships it.

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

**U4 — The HTTP API route table.** The design fixes that it is an explicit route table and never a
call-any-tool-by-name proxy; that every route takes a repository dimension; that bearer and cookie
routes are disjoint; and that four views are operator-only. It does not enumerate the routes, their
paths, or their request and response bodies.

**U5 — OAuth endpoint paths and the protected-resource metadata document, resolved 2026-08-10 by
S14.** Standard RFC-shaped paths under `/oauth/*` and `/.well-known/*`, with `issueMcpGrant` added
to `Authorization` as the one durable write the authorization-code exchange performs. See
`### L5 — surfaces` above and `design/90-decisions.md`, 2026-08-10.

**U6 — Operational numbers the design explicitly defers.** `mutationQueueDepth`,
`concurrentWaitsPerSession`, `concurrentLockFreeOperations`, `mutationLockAcquireMs`,
`materialisationLockAcquireMs`, `hatchSeconds`, `sessionIdleSeconds`, `sessionAbsoluteSeconds`, the
notifier's retry bound and backoff schedule, and the default `maxResultBytes`. The design says
these "belong with the other operational numbers rather than in this document". The types are fixed
above; the values are not.

*Partly narrowed 2026-08-04:* `sessionIdleSeconds` and `sessionAbsoluteSeconds` now carry defaults
(3600 and 43200, above), because S4's console session cannot exist without a number. U6 still owns
what a deployment ought to choose — a default is what the service falls back to, not an answer to
the question.

**U7 — The console package's element type and build entry.** `ConsoleViewRegistration` is generic
over the element type because the design fixes what a view receives and what it declares, but not
the UI framework binding, the package's exported build entry, or how the asset manifest is hashed
into the console fingerprint.

~~**U8 — The pre-state digest algorithms.**~~ — **resolved 2026-08-08.** `SHA256_hex(canonical(...))`
over an ordered array of index entries and porcelain-status lines respectively, neither derived via
a command that writes to the object database. See `### Clone`, immediately after `ObservedGitState`,
for the exact fields and ordering. This unblocks S7.

~~**U9 — The audit record's canonical serialisation.**~~ — **resolved 2026-08-03.** Deep key-sorted
JSON over the full flattened `AuditRecord` excluding only `hash` itself, reusing the compiler's
fingerprint canonicalisation. See `### Audit` above. This unblocks S3.
