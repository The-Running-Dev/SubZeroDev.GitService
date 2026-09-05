import type {
  BranchName,
  CredentialRef,
  DeclarationId,
  GrantEpoch,
  GrantId,
  Generation,
  IsoUtcTimestamp,
  OperationId,
  PathPrefix,
  CloneUrl,
  RegistryToolName,
  ScheduledJobId,
} from '../shared/brands.ts';
import type { DeclarationGrant, DeclarationScopedCapability, HostKind } from '../contract/capabilities.ts';

export type { HostKind } from '../contract/capabilities.ts';

export type DeclarationState = 'active' | 'orphaned';

export interface RepositoryIdentity {
  readonly gitUserName: string;
  readonly gitUserEmail: string;
}

export interface FileWatcherConfig {
  readonly planTool: RegistryToolName;
  readonly applyTool: RegistryToolName;
  readonly autoMerge: boolean;
}

export interface Declaration {
  readonly id: DeclarationId;
  readonly generation: Generation;
  readonly cloneUrl: CloneUrl;
  readonly host: HostKind;
  readonly credentialRef: CredentialRef;
  readonly capabilityGrant: DeclarationGrant;
  readonly writablePathPrefixes: readonly PathPrefix[];
  readonly pinned: boolean;
  readonly fileWatcher: FileWatcherConfig | null;
  readonly identity: RepositoryIdentity;
  readonly state: DeclarationState;
  readonly grantEpoch: GrantEpoch;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface DeclareInput {
  readonly id: DeclarationId;
  readonly cloneUrl: CloneUrl;
  readonly host: HostKind;
  readonly credentialRef: CredentialRef;
  readonly capabilityGrant: readonly DeclarationScopedCapability[];
  readonly writablePathPrefixes: readonly PathPrefix[];
  readonly pinned: boolean;
  readonly fileWatcher: FileWatcherConfig | null;
  readonly identity: RepositoryIdentity;
}

export interface AmendInput {
  readonly cloneUrl: CloneUrl | null;
  readonly credentialRef: CredentialRef | null;
  readonly capabilityGrant: readonly DeclarationScopedCapability[] | null;
  readonly writablePathPrefixes: readonly PathPrefix[] | null;
  readonly pinned: boolean | null;
  readonly fileWatcher: FileWatcherConfig | null | undefined;
  readonly identity: RepositoryIdentity | null;
}

export interface OrphanReport {
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly cancelledJobs: readonly ScheduledJobId[];
  readonly revokedGrants: readonly GrantId[];
  readonly retainedJournalEntries: readonly OperationId[];
  readonly cloneLeftOnDisk: boolean;
  readonly fileWatcherStopped: boolean;
}

export interface DeclarationFilter {
  readonly state: DeclarationState | null;
  readonly hasFileWatcher: boolean | null;
}

export interface RepositoryConfig {
  readonly baseBranch: BranchName;
  readonly requiredChecks: readonly string[];
  readonly deployWorkflow: string | null;
  readonly branchPrefixes: readonly string[];
}

// A known-valid literal, cast rather than run through `branchName()` — the
// same convention `STRIPPED_FOR_UNATTENDED` below uses for a fixed value
// that has nothing to be validated against at load time.
export const REPOSITORY_CONFIG_DEFAULTS: RepositoryConfig = {
  baseBranch: 'main' as BranchName,
  requiredChecks: [],
  deployWorkflow: null,
  branchPrefixes: [],
};

/** `20-contract.md` § Actors, profiles and sessions — needed by `effectiveWritablePrefixes`. */
export type SessionKind = 'operator' | 'mcp' | 'scheduler' | 'watcher';

export interface ActorProfile {
  readonly kind: SessionKind;
  readonly capabilities: ReadonlySet<DeclarationScopedCapability | string>;
  readonly strippedPathPrefixes: readonly PathPrefix[];
}

/** `.github/workflows/`, `.config/`, `tools/`, `build/` — the unattended-actor strip list (`10-design.md` § `Declaration`). */
export const STRIPPED_FOR_UNATTENDED: readonly PathPrefix[] = ['.github/workflows/', '.config/', 'tools/', 'build/'] as unknown as readonly PathPrefix[];

export const OPERATOR_PROFILE: ActorProfile = { kind: 'operator', capabilities: new Set(), strippedPathPrefixes: [] };
export const MCP_PROFILE: ActorProfile = { kind: 'mcp', capabilities: new Set(), strippedPathPrefixes: STRIPPED_FOR_UNATTENDED };
export const SCHEDULER_PROFILE: ActorProfile = { kind: 'scheduler', capabilities: new Set(), strippedPathPrefixes: STRIPPED_FOR_UNATTENDED };
export const WATCHER_PROFILE: ActorProfile = { kind: 'watcher', capabilities: new Set(), strippedPathPrefixes: STRIPPED_FOR_UNATTENDED };
