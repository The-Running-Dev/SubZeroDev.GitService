import type { ModuleErrorBase, Finding } from '../shared/result-kind.ts';
import type { DeclarationId, Generation, McpResourceUri } from '../shared/brands.ts';
import type { StoreError } from '../store/errors.ts';

/**
 * `20-contract.md` § Error semantics › Authorization. The first nine variants
 * are transport-level `401` with a resource-metadata challenge and never a
 * `ToolResult`; `registration-invalid` is a `400`; `store-failed` is a `503`.
 * `resultKind` is `'authorization'` for every variant regardless — it is what
 * the audit line records, not what the transport returns.
 */
export type AuthorizationError = ModuleErrorBase &
  (
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

export function authorizationError<T extends { readonly code: AuthorizationError['code'] }>(variant: T, summary: string): AuthorizationError {
  return { resultKind: 'authorization', retryable: variant.code === 'store-failed', summary, ...variant } as unknown as AuthorizationError;
}
