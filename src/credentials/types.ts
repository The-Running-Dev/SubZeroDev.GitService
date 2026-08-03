import type { CredentialRef, DeclarationId, IsoUtcTimestamp } from '../shared/brands.ts';

/**
 * Type only. The credentials module (L1) that marks these is S9. `HealthReport`
 * lists failing credential references, so the type is needed before the
 * module that owns it exists.
 */
export interface CredentialFailureMark {
  readonly ref: CredentialRef;
  readonly declarationId: DeclarationId;
  readonly reason: string;
  readonly markedAt: IsoUtcTimestamp;
}
