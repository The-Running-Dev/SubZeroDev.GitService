import type { ModuleErrorBase, Finding } from '../shared/result-kind.ts';
import { infrastructure, precondition, type ToolResult } from '../result/envelope.ts';

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

/**
 * The one mapping from a configuration failure to the envelope: an unparseable
 * file is a problem with that repository (`precondition`, with findings), an
 * unreadable one or a missing clone is the service's (`infrastructure`). The
 * direct git tools and both composites go through it, so the same file reads
 * the same way whichever surface asked.
 */
export function gitOperationsErrorToToolResult(error: GitOperationsError): ToolResult<never> {
  if (error.resultKind === 'precondition') return precondition(error.summary, 'findings' in error ? error.findings : []);
  return infrastructure(error.summary);
}
