import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { StoreError } from '../store/errors.ts';
import type { Subject } from '../shared/brands.ts';

export type OperatorIdentityError = ModuleErrorBase &
  (
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

/**
 * Every variant maps to `401` at the surface (`20-contract.md` § Operator
 * identity), except `store-failed`, which follows the Authorization module's
 * own precedent for the same code (line 2545: "`store-failed` is a `503`")
 * rather than inventing a second convention for the same failure.
 */
export function operatorIdentityError<T extends { readonly code: OperatorIdentityError['code'] }>(
  variant: T,
  summary: string,
): OperatorIdentityError {
  const resultKind = variant.code === 'store-failed' ? 'infrastructure' : 'authorization';
  return { resultKind, retryable: false, summary, ...variant } as unknown as OperatorIdentityError;
}
