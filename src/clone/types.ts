import type { BranchName, ClonePath, DeclarationId, Generation, IsoUtcTimestamp, CloneUrl, GitSha, OperationId, Sha256Hex } from '../shared/brands.ts';
import type { ActivePin, LockHandle } from '../locks/types.ts';

export type CloneState =
  | 'absent'
  | 'materialising'
  | 'ready'
  | 'dirty'
  | 'recovery-pending'
  | 'needs-attention'
  | 'evicted';

export interface Clone {
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly state: CloneState;
  readonly path: ClonePath;
  readonly sizeBytes: number;
  readonly lastOperationAt: IsoUtcTimestamp | null;
  readonly observedRemote: CloneUrl | null;
  readonly attentionReason: string | null;
}

export interface PreState {
  readonly branch: BranchName | null;
  readonly headSha: GitSha | null;
  readonly upstreamSha: GitSha | null;
  readonly indexDigest: Sha256Hex;
  readonly worktreeDigest: Sha256Hex;
}

export interface ObservedGitState extends PreState {
  readonly observedAt: IsoUtcTimestamp;
}

export type EvictionBlocker =
  | { readonly kind: 'pinned' }
  | { readonly kind: 'worktree-dirty' }
  | { readonly kind: 'branch-ahead-of-upstream'; readonly branch: BranchName; readonly ahead: number }
  | { readonly kind: 'unreachable-commits'; readonly base: BranchName; readonly count: number }
  | { readonly kind: 'stash-present'; readonly count: number }
  | { readonly kind: 'open-journal-entry'; readonly operationId: OperationId }
  | { readonly kind: 'active-operations'; readonly count: number }
  | { readonly kind: 'corrupt-tree' };

export type SafeToEvictVerdict = { readonly safe: true } | { readonly safe: false; readonly blockers: readonly EvictionBlocker[] };

export interface CloneHandle {
  readonly clone: Clone;
  readonly materialisationLock: LockHandle;
  readonly activePin: ActivePin;
}

export interface CorruptTreeOverride {
  readonly permitCorruptTree: boolean;
}

export interface EvictionOutcome {
  readonly declarationId: DeclarationId;
  readonly evicted: boolean;
  readonly freedBytes: number;
  readonly blockers: readonly EvictionBlocker[];
}
