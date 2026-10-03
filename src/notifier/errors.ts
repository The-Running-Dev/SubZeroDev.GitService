import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { OutboxRowId } from '../shared/brands.ts';
import type { StoreError } from '../store/errors.ts';

/** `20-contract.md` § Error semantics › Notifier. */
export type NotifierError = ModuleErrorBase &
  (
    | { readonly code: 'no-transport-configured' }
    | { readonly code: 'delivery-failed'; readonly status: number | null; readonly attempts: number }
    | { readonly code: 'retries-exhausted'; readonly rowId: OutboxRowId }
    | { readonly code: 'row-not-found'; readonly rowId: OutboxRowId }
    | { readonly code: 'store-failed'; readonly cause: StoreError }
  );

const RETRYABLE: Readonly<Record<NotifierError['code'], boolean>> = {
  'no-transport-configured': false,
  'delivery-failed': true,
  'retries-exhausted': false,
  'row-not-found': false,
  'store-failed': false,
};

/** Every variant is `infrastructure` (bar `row-not-found`) — a delivery fault says something about the transport, not the caller's request. */
export function notifierError<T extends { readonly code: NotifierError['code'] }>(variant: T, summary: string): NotifierError {
  const resultKind = variant.code === 'row-not-found' ? 'precondition' : 'infrastructure';
  // `store-failed` is retryable only if its cause is, the same as every other module that carries one.
  const retryable = variant.code === 'store-failed' ? (variant as unknown as { cause: StoreError }).cause.retryable : RETRYABLE[variant.code];
  return { resultKind, retryable, summary, ...variant } as unknown as NotifierError;
}
