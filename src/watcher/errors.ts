import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { ResultKind } from '../shared/result-kind.ts';
import type { WatchedFileName } from '../shared/brands.ts';

/** `20-contract.md` § Watcher. */
export type WatcherError = ModuleErrorBase &
  (
    | { readonly code: 'not-permitted'; readonly missingSwitch: 'remote-operations' | 'watcher-enabled' }
    | { readonly code: 'watched-file-unreadable'; readonly file: WatchedFileName }
    | { readonly code: 'claim-failed'; readonly file: WatchedFileName }
    | { readonly code: 'step-failed'; readonly step: string; readonly result: ResultKind; readonly reason: string }
    | { readonly code: 'interrupted-claim'; readonly file: WatchedFileName }
  );

/**
 * `20-contract.md` § Watcher's error table gives no caller to return an
 * envelope to for four of the five variants — they describe outcomes this
 * module audits and notifies internally rather than results returned from
 * `Watcher`'s public methods. `not-permitted` is the exception: `start()`
 * returns it as an `Outcome`, mirroring `host-not-permitted`'s mapping to
 * `authorization` (`credentials/errors.ts`) — both are a configured
 * authority refusing an action outright, not a validation or transient
 * failure.
 */
export function watcherError<T extends { readonly code: WatcherError['code'] }>(variant: T, summary: string): WatcherError {
  const resultKind: ResultKind = variant.code === 'watched-file-unreadable' ? 'validation' : 'authorization';
  return { resultKind, retryable: variant.code === 'claim-failed', summary, ...variant } as unknown as WatcherError;
}
