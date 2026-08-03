import type { HttpOperationName, ModuleTargetName, RegistryToolName } from '../shared/brands.ts';
import type { JsonSchema } from './json.ts';
import type { ToolDeclaration } from './tool-declaration.ts';

const EMPTY_SCHEMA = { type: 'object', properties: {} } as unknown as JsonSchema;

/** A minimal, individually-valid `ToolDeclaration`. Every field can be overridden per test. */
export function fixtureTool(overrides: Omit<Partial<ToolDeclaration>, 'name'> & { readonly name: string }): ToolDeclaration {
  return {
    name: overrides.name as RegistryToolName,
    description: overrides.description ?? 'a fixture tool',
    inputSchema: overrides.inputSchema ?? EMPTY_SCHEMA,
    outputSchema: overrides.outputSchema ?? EMPTY_SCHEMA,
    scopes: overrides.scopes ?? ['read'],
    capabilities: overrides.capabilities ?? ['repo.read'],
    capabilityScope: overrides.capabilityScope ?? 'declaration',
    executionClass: overrides.executionClass ?? 'read',
    annotations: overrides.annotations ?? { schedulable: false, dropTarget: false, untrustedOutput: false },
    limits: overrides.limits ?? { timeoutSeconds: 30, maxResultBytes: 1_000_000 },
    target: overrides.target ?? { kind: 'module', target: overrides.name as ModuleTargetName },
  };
}

export function moduleTarget(name: string): { kind: 'module'; target: ModuleTargetName } {
  return { kind: 'module', target: name as ModuleTargetName };
}

export function httpTarget(name: string): { kind: 'http'; operation: HttpOperationName } {
  return { kind: 'http', operation: name as HttpOperationName };
}
