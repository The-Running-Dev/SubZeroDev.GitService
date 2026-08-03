import type { IsoUtcTimestamp } from '../shared/brands.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';

export interface BackupStamp {
  readonly at: IsoUtcTimestamp;
  readonly ageSeconds: number;
}

export type StoreError = ModuleErrorBase &
  (
    | { readonly code: 'busy'; readonly attempts: number }
    | {
        readonly code: 'corrupt';
        readonly newestSnapshot: BackupStamp | null;
        readonly newestPreMigrationBackup: BackupStamp | null;
      }
    | { readonly code: 'migration-failed'; readonly version: number; readonly backupAt: IsoUtcTimestamp }
    | { readonly code: 'io-failed' }
    | { readonly code: 'constraint-violated'; readonly constraint: string }
  );

/**
 * Every variant carries `resultKind: 'infrastructure'`, per the contract's own
 * Structured store table: `busy`, `io-failed` and `constraint-violated` map to
 * `infrastructure` for a caller, and `corrupt` and `migration-failed` are
 * fatal at boot, so they never reach a caller as an envelope at all.
 *
 * `retryable` is true only for `busy`, which the store has already retried —
 * the flag records that retrying is the right shape of response, not that the
 * caller should do it again immediately.
 */
export function storeError<T extends { readonly code: StoreError['code'] }>(
  variant: T,
  summary: string,
  retryable = false,
): StoreError {
  return { resultKind: 'infrastructure', retryable, summary, ...variant } as unknown as StoreError;
}
