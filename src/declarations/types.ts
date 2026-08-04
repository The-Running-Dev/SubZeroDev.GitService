import type {
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

export interface ContentDropConfig {
  readonly tool: RegistryToolName;
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
  readonly contentDrop: ContentDropConfig | null;
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
  readonly contentDrop: ContentDropConfig | null;
  readonly identity: RepositoryIdentity;
}

export interface AmendInput {
  readonly cloneUrl: CloneUrl | null;
  readonly credentialRef: CredentialRef | null;
  readonly capabilityGrant: readonly DeclarationScopedCapability[] | null;
  readonly writablePathPrefixes: readonly PathPrefix[] | null;
  readonly pinned: boolean | null;
  readonly contentDrop: ContentDropConfig | null | undefined;
  readonly identity: RepositoryIdentity | null;
}

export interface OrphanReport {
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly cancelledJobs: readonly ScheduledJobId[];
  readonly revokedGrants: readonly GrantId[];
  readonly retainedJournalEntries: readonly OperationId[];
  readonly cloneLeftOnDisk: boolean;
  readonly dropWatchStopped: boolean;
}

export interface DeclarationFilter {
  readonly state: DeclarationState | null;
  readonly hasContentDrop: boolean | null;
}

export interface RepositoryConfig {
  readonly baseBranch: string;
  readonly requiredChecks: readonly string[];
  readonly deployWorkflow: string | null;
  readonly branchPrefixes: readonly string[];
}

export const REPOSITORY_CONFIG_DEFAULTS: RepositoryConfig = {
  baseBranch: 'main',
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
