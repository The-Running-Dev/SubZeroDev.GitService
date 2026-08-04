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
