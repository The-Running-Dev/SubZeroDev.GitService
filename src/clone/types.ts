import type { ClonePath, DeclarationId, Generation, IsoUtcTimestamp, CloneUrl } from '../shared/brands.ts';

/**
 * Type only. The clone store (L1) that maintains these is S5; boot step 8
 * re-derives the set from disk and reports it, which is why the type is
 * needed before the module that owns it exists.
 */
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
