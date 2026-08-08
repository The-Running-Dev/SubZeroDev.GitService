import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { ModuleTargetName } from '../shared/brands.ts';

/** `20-contract.md` § Error semantics › Module adapter and http adapter. */
export type ModuleAdapterError = ModuleErrorBase &
  (
    | { readonly code: 'target-not-registered'; readonly target: ModuleTargetName }
    | { readonly code: 'duplicate-registration'; readonly target: ModuleTargetName }
  );

/** Both variants are composition/boot-time faults; reaching either at runtime is `infrastructure`. */
export function moduleAdapterError<T extends { readonly code: ModuleAdapterError['code'] }>(variant: T, summary: string): ModuleAdapterError {
  return { resultKind: 'infrastructure', retryable: false, summary, ...variant } as unknown as ModuleAdapterError;
}
