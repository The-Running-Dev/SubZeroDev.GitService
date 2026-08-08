import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { OutboxRowId } from '../shared/brands.ts';

/** `20-contract.md` § Error semantics › Notifier. */
export type NotifierError = ModuleErrorBase &
  (
    | { readonly code: 'no-transport-configured' }
    | { readonly code: 'delivery-failed'; readonly status: number | null; readonly attempts: number }
    | { readonly code: 'retries-exhausted'; readonly rowId: OutboxRowId }
    | { readonly code: 'row-not-found'; readonly rowId: OutboxRowId }
  );

const RETRYABLE: Readonly<Record<NotifierError['code'], boolean>> = {
  'no-transport-configured': false,
  'delivery-failed': true,
  'retries-exhausted': false,
  'row-not-found': false,
};

/** Every variant is `infrastructure` — a delivery fault says something about the transport, not the caller's request. */
export function notifierError<T extends { readonly code: NotifierError['code'] }>(variant: T, summary: string): NotifierError {
  const resultKind = variant.code === 'row-not-found' ? 'precondition' : 'infrastructure';
  return { resultKind, retryable: RETRYABLE[variant.code], summary, ...variant } as unknown as NotifierError;
}
