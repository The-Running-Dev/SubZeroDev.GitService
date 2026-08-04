import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { LockHolder } from './types.ts';

export type LockError = ModuleErrorBase &
  (
    | { readonly code: 'acquire-timeout'; readonly holder: LockHolder | null }
    | { readonly code: 'queue-full'; readonly depth: number }
    | { readonly code: 'admission-refused'; readonly limit: 'per-session-waits' | 'process-lock-free' }
    | { readonly code: 'cancelled' }
  );

/** All four map to `conflict` (`20-contract.md` § Error semantics › Locks): "come back later" from the caller's side, whichever one fired. */
export function lockError<T extends { readonly code: LockError['code'] }>(variant: T, summary: string): LockError {
  return { resultKind: 'conflict', retryable: false, summary, ...variant } as unknown as LockError;
}
