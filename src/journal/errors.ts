import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { OperationId } from '../shared/brands.ts';
import type { StoreError } from '../store/errors.ts';
import type { CloneStoreError } from '../clone/errors.ts';
import type { JournalEntryState } from './types.ts';

/** `20-contract.md` § Error semantics › Journal. */
export type JournalError = ModuleErrorBase &
  (
    | { readonly code: 'intent-write-failed'; readonly cause: StoreError }
    | { readonly code: 'prestate-capture-failed'; readonly cause: CloneStoreError }
    | { readonly code: 'entry-not-found'; readonly operationId: OperationId }
    | { readonly code: 'invalid-transition'; readonly from: JournalEntryState; readonly to: JournalEntryState }
  );

export function journalError<T extends { readonly code: JournalError['code'] }>(variant: T, summary: string): JournalError {
  return { resultKind: 'infrastructure', retryable: false, summary, ...variant } as unknown as JournalError;
}
