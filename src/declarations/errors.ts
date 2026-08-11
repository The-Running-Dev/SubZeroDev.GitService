import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { CapabilityName } from '../contract/capabilities.ts';
import type { CloneUrl, RegistryToolName, RemoteHost } from '../shared/brands.ts';
import type { StoreError } from '../store/errors.ts';
import type { EvictionBlocker } from '../clone/types.ts';

export type DeclarationError = ModuleErrorBase &
  (
    | { readonly code: 'not-found' }
    | { readonly code: 'already-exists' }
    | { readonly code: 'immutable-field'; readonly field: string }
    | { readonly code: 'remote-host-not-allowed'; readonly host: RemoteHost }
    | { readonly code: 'capability-outside-ceiling'; readonly capabilities: readonly CapabilityName[] }
    | { readonly code: 'capability-unsupported-by-host'; readonly capabilities: readonly CapabilityName[] }
    | { readonly code: 'watcher-tool-not-annotated'; readonly tool: RegistryToolName; readonly expected: 'plan' | 'apply' }
    | { readonly code: 'watcher-plan-schema-mismatch'; readonly planTool: RegistryToolName; readonly applyTool: RegistryToolName }
    | { readonly code: 'adoption-refused'; readonly blockers: readonly EvictionBlocker[] }
    | { readonly code: 'remote-mismatch'; readonly declared: CloneUrl; readonly observed: CloneUrl }
    | { readonly code: 'clone-still-present' }
    | { readonly code: 'watcher-directory-not-empty'; readonly files: number }
    | { readonly code: 'not-orphaned' }
    | { readonly code: 'store-failed'; readonly cause: StoreError }
  );

/** `20-contract.md` § Error semantics › Declarations. Every variant is `validation` or `precondition` except `store-failed`, per that table. */
export function declarationError<T extends { readonly code: DeclarationError['code'] }>(variant: T, summary: string): DeclarationError {
  const resultKind =
    variant.code === 'store-failed'
      ? 'infrastructure'
      : variant.code === 'immutable-field' ||
          variant.code === 'remote-host-not-allowed' ||
          variant.code === 'capability-outside-ceiling' ||
          variant.code === 'capability-unsupported-by-host' ||
          variant.code === 'watcher-tool-not-annotated' ||
          variant.code === 'watcher-plan-schema-mismatch'
        ? 'validation'
        : 'precondition';
  return { resultKind, retryable: false, summary, ...variant } as unknown as DeclarationError;
}
