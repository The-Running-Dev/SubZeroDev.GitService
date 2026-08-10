import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { CredentialRef, DeclarationId, GitSha } from '../shared/brands.ts';
import type { PullRequestRef } from './types.ts';

/** `20-contract.md` § Error semantics › Host adapter. */
export type HostError = ModuleErrorBase &
  (
    | { readonly code: 'unreachable' }
    | { readonly code: 'rate-limited'; readonly retryAfterSeconds: number }
    | { readonly code: 'server-error'; readonly status: number; readonly attempts: number }
    | { readonly code: 'auth-rejected'; readonly ref: CredentialRef; readonly declarationId: DeclarationId }
    | { readonly code: 'merge-conflict'; readonly pullRequest: PullRequestRef; readonly headSha: GitSha; readonly baseSha: GitSha }
    | { readonly code: 'required-check-failed'; readonly check: string; readonly pullRequest: PullRequestRef }
    | { readonly code: 'not-found'; readonly resource: string }
    | { readonly code: 'timed-out'; readonly limitSeconds: number }
  );

/**
 * The `resultKind` each variant carries is fixed by the contract's own table,
 * and one row of it is load-bearing enough to state here: **`rate-limited` is
 * `upstream`, never `precondition`**. The design records that exact
 * misclassification as a defect the prior art had — an unavailable dependency
 * is not a repository state, and calling it one tells an operator to go and
 * fix a repository that is fine.
 *
 * `retryable` describes whether the *caller* may retry, not whether this
 * module already did. `server-error` is false because the retries have already
 * happened by the time the variant is constructed (reads) or are forbidden
 * (mutations).
 */
const RESULT_KIND: Readonly<Record<HostError['code'], ModuleErrorBase['resultKind']>> = {
  unreachable: 'upstream',
  'rate-limited': 'upstream',
  'server-error': 'upstream',
  'auth-rejected': 'upstream',
  'merge-conflict': 'precondition',
  'required-check-failed': 'precondition',
  'not-found': 'precondition',
  'timed-out': 'timeout',
};

const RETRYABLE: Readonly<Record<HostError['code'], boolean>> = {
  unreachable: false,
  'rate-limited': true,
  'server-error': false,
  'auth-rejected': false,
  'merge-conflict': false,
  'required-check-failed': false,
  'not-found': false,
  'timed-out': false,
};

export function hostError<T extends { readonly code: HostError['code'] }>(variant: T, summary: string): HostError {
  return {
    resultKind: RESULT_KIND[variant.code],
    retryable: RETRYABLE[variant.code],
    summary,
    ...variant,
  } as unknown as HostError;
}
