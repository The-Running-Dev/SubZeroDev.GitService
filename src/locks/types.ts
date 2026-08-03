import type { DeclarationId, IsoUtcTimestamp, OperationId, RegistryToolName } from '../shared/brands.ts';

/**
 * Type only — declared here so `conflict()`'s signature type-checks. The
 * Locks module itself (acquisition, the mutex, `currentMutationHolder`) is
 * out of scope for this slice; see `30-slices.md` S2.
 */
export interface LockHolder {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId;
  readonly tool: RegistryToolName;
  readonly heldSince: IsoUtcTimestamp;
}
