import type { DeclarationId, IsoUtcTimestamp, OperationId, RegistryToolName } from '../shared/brands.ts';

export interface LockHolder {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId;
  readonly tool: RegistryToolName;
  readonly heldSince: IsoUtcTimestamp;
}

export interface LockHandle {
  readonly holder: LockHolder;
  release(): void;
}

export interface ActivePin {
  release(): void;
}

/** Held for a monitoring wait's duration. `release` is idempotent, on the same grounds as `ActivePin.release`. */
export interface WaitAdmission {
  release(): void;
}

/** `DeploymentConfig.admission`. `mutationQueueDepth` is not S10's; the two wait counters are. */
export interface AdmissionLimits {
  readonly mutationQueueDepth: number;
  readonly concurrentWaitsPerSession: number;
  readonly concurrentLockFreeOperations: number;
}
