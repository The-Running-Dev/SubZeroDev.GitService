import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { CloneUrl } from '../shared/brands.ts';
import type { StoreError } from '../store/errors.ts';
import type { ExecError } from '../exec/errors.ts';
import type { EvictionBlocker } from './types.ts';
import type { VolumeUsage } from '../store/volume-usage.ts';

export type CloneStoreError = ModuleErrorBase &
  (
    | { readonly code: 'clone-failed'; readonly cause: ExecError }
    | { readonly code: 'clone-timeout'; readonly limitSeconds: number }
    | { readonly code: 'remote-mismatch'; readonly declared: CloneUrl; readonly observed: CloneUrl }
    | { readonly code: 'corrupt-tree' }
    | { readonly code: 'not-safe-to-evict'; readonly blockers: readonly EvictionBlocker[] }
    | { readonly code: 'not-safe-to-remove'; readonly blockers: readonly EvictionBlocker[] }
    | { readonly code: 'disk-full'; readonly usage: VolumeUsage; readonly evictionBlockers: readonly EvictionBlocker[] }
    | { readonly code: 'recovery-pending' }
    | { readonly code: 'needs-attention'; readonly reason: string }
    | { readonly code: 'store-failed'; readonly cause: StoreError }
  );

/** `20-contract.md` § Error semantics › Clone store. */
export function cloneStoreError<T extends { readonly code: CloneStoreError['code'] }>(variant: T, summary: string): CloneStoreError {
  const resultKind =
    variant.code === 'clone-failed'
      ? 'upstream'
      : variant.code === 'clone-timeout'
        ? 'timeout'
        : variant.code === 'store-failed'
          ? 'infrastructure'
          : 'precondition';
  return { resultKind, retryable: false, summary, ...variant } as unknown as CloneStoreError;
}
