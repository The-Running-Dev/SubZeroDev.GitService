import type { RegistryToolName } from '../shared/brands.ts';
import type { Finding, ModuleErrorBase } from '../shared/result-kind.ts';
import type { CapabilityName } from './capabilities.ts';

export type CompilerError = ModuleErrorBase &
  (
    | { readonly code: 'duplicate-tool-name'; readonly name: RegistryToolName }
    | { readonly code: 'no-executor'; readonly name: RegistryToolName }
    | { readonly code: 'multiple-executors'; readonly name: RegistryToolName }
    | { readonly code: 'capability-scope-mismatch'; readonly name: RegistryToolName; readonly capability: CapabilityName }
    | { readonly code: 'schema-invalid'; readonly name: RegistryToolName; readonly findings: readonly Finding[] }
    | { readonly code: 'annotation-contradiction'; readonly name: RegistryToolName; readonly rule: string }
    | { readonly code: 'reserved-name'; readonly name: RegistryToolName }
    | { readonly code: 'limit-exceeds-cap'; readonly name: RegistryToolName; readonly cap: number }
  );
