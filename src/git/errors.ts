import type { ModuleErrorBase, Finding } from '../shared/result-kind.ts';

/** `20-contract.md` § Error semantics › Git operations. */
export type GitOperationsError = ModuleErrorBase &
  (
    | { readonly code: 'config-unparseable'; readonly findings: readonly Finding[] }
    | { readonly code: 'config-unreadable' }
    | { readonly code: 'no-clone' }
  );

export function gitOperationsError<T extends { readonly code: GitOperationsError['code'] }>(variant: T, summary: string): GitOperationsError {
  const resultKind = variant.code === 'config-unparseable' ? 'precondition' : 'infrastructure';
  return { resultKind, retryable: false, summary, ...variant } as unknown as GitOperationsError;
}
