import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { RegistryToolName } from '../shared/brands.ts';

/**
 * `20-contract.md` § Error semantics › Recovery catalogue. One variant, and it
 * is raised only at composition time: registering two descriptors for the same
 * tool is a wiring defect, not a runtime condition.
 *
 * A *missing* descriptor is deliberately not an error of this module —
 * `lookup` returns `null` and the recovery ladder parks the entry, which is
 * how an entry written by a tool that has since lost its descriptor (an
 * upgrade, a withdrawn composite) reaches a human instead of vanishing.
 */
export type RecoveryCatalogueError = ModuleErrorBase & { readonly code: 'duplicate-registration'; readonly tool: RegistryToolName };

export function recoveryCatalogueError<T extends { readonly code: RecoveryCatalogueError['code'] }>(variant: T, summary: string): RecoveryCatalogueError {
  return { resultKind: 'infrastructure', retryable: false, summary, ...variant } as unknown as RecoveryCatalogueError;
}
