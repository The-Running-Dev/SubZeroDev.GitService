import type { HttpOperationName, IsoUtcTimestamp, ModuleTargetName, RegistryToolName, Sha256Hex } from '../shared/brands.ts';
import type { CapabilityName, CapabilityScope, ContractCapabilitySet, Scope } from './capabilities.ts';
import type { JsonSchema } from './json.ts';

export type ToolExecutionClass = 'read' | 'mutating' | 'monitoring-wait';
export type FileWatcherPhase = false | 'plan' | 'apply';

export interface ToolAnnotations {
  readonly schedulable: boolean;
  readonly fileWatcher: FileWatcherPhase;
  readonly untrustedOutput: boolean;
}

export interface ToolLimits {
  readonly timeoutSeconds: number;
  readonly maxResultBytes: number;
}

export type ExecutionTarget =
  | { readonly kind: 'module'; readonly target: ModuleTargetName }
  | { readonly kind: 'http'; readonly operation: HttpOperationName };

export interface ToolDeclaration {
  readonly name: RegistryToolName;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly scopes: readonly Scope[];
  readonly capabilities: readonly CapabilityName[];
  readonly capabilityScope: CapabilityScope;
  readonly executionClass: ToolExecutionClass;
  readonly annotations: ToolAnnotations;
  readonly limits: ToolLimits;
  readonly target: ExecutionTarget;
}

export interface CompiledRegistry {
  readonly fingerprint: Sha256Hex;
  readonly compiledAt: IsoUtcTimestamp;
  readonly entries: readonly ToolDeclaration[];
  readonly contractCapabilitySet: ContractCapabilitySet;
}

export interface ManifestEntry {
  readonly name: RegistryToolName;
  readonly capabilities: readonly CapabilityName[];
  readonly scopes: readonly Scope[];
  readonly executionClass: ToolExecutionClass;
}

export interface SanitisedManifest {
  readonly fingerprint: Sha256Hex;
  readonly tools: readonly ManifestEntry[];
}

export interface GeneratedDocumentation {
  readonly markdown: string;
}

export interface CompilerArtifact {
  readonly registry: CompiledRegistry;
  readonly manifest: SanitisedManifest;
  readonly fingerprint: Sha256Hex;
  readonly documentation: GeneratedDocumentation;
}

export interface ContractAuthoring {
  tool(declaration: ToolDeclaration): ToolDeclaration;
}

/** Identity helper: the ergonomic, single way to author a `ToolDeclaration` literal. */
export const contractAuthoring: ContractAuthoring = {
  tool(declaration: ToolDeclaration): ToolDeclaration {
    return declaration;
  },
};
