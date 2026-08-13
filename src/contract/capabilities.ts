import type { Brand } from '../shared/brands.ts';

export type ContentCapability = `content.${string}`;

export type DeclarationScopedCapability =
  | 'repo.read'
  | 'git.local.write'
  | 'git.remote.write'
  | 'git.raw'
  | 'host.pr.read'
  | 'host.pr.write'
  | 'host.checks.read'
  | 'scheduler.manage'
  | 'scheduler.read'
  | ContentCapability;

export type InstanceScopedCapability =
  | 'declaration.manage'
  | 'auth.manage'
  | 'audit.read'
  | 'attention.resolve';

export type CapabilityName = DeclarationScopedCapability | InstanceScopedCapability;
export type CapabilityScope = 'declaration' | 'instance';
export type CapabilitySet = ReadonlySet<CapabilityName>;

export type ContractCapabilitySet = Brand<CapabilitySet, 'Layer1'>;
export type DeploymentCeiling = Brand<CapabilitySet, 'Layer2'>;
export type DeclarationGrant = Brand<CapabilitySet, 'Layer3'>;
export type SessionGrant = Brand<CapabilitySet, 'Layer4'>;
export type EffectiveGrant = Brand<CapabilitySet, 'Effective'>;

const INSTANCE_SCOPED: ReadonlySet<InstanceScopedCapability> = new Set([
  'declaration.manage',
  'auth.manage',
  'audit.read',
  'attention.resolve',
]);

/**
 * A capability's scope follows its own name: the four instance-scoped names
 * are a closed, listed set; every other `CapabilityName` — the seven fixed
 * declaration-scoped literals plus the open `content.*` family — is
 * declaration-scoped. `content.*` is open-ended precisely because it is
 * declaration-scoped: a per-declaration capability has nothing instance-wide
 * to belong to.
 */
export function capabilityScopeOf(capability: CapabilityName): CapabilityScope {
  return INSTANCE_SCOPED.has(capability as InstanceScopedCapability) ? 'instance' : 'declaration';
}

export type McpScope = 'read' | 'write' | 'raw' | 'schedule';
/** `20-contract.md` § U2, resolved 2026-08-09 by S13: the same four values as `McpScope`. */
export type OperatorScope = McpScope;
export type Scope = McpScope | OperatorScope;

/**
 * `Declaration.host` (`20-contract.md` § Declaration). Declared here, not in
 * the declarations module, so `hostSupportedCapabilities` below has no
 * import back onto a module that itself depends on this file.
 */
export type HostKind = 'github' | 'generic';

const HOST_ONLY: ReadonlySet<CapabilityName> = new Set<CapabilityName>(['host.pr.read', 'host.pr.write', 'host.checks.read']);

/**
 * `github` supports every declaration-scoped capability; `generic` gets
 * local git only — every capability except the three `host.*` ones. Neither
 * host affects the instance-scoped four, which have nothing to do with a
 * repository's remote.
 */
export function hostSupportedCapabilities(host: HostKind): CapabilitySet {
  const all: CapabilityName[] = [
    'repo.read',
    'git.local.write',
    'git.remote.write',
    'git.raw',
    'host.pr.read',
    'host.pr.write',
    'host.checks.read',
    'scheduler.manage',
    'scheduler.read',
    'declaration.manage',
    'auth.manage',
    'audit.read',
    'attention.resolve',
  ];
  return new Set(host === 'github' ? all : all.filter((c) => !HOST_ONLY.has(c)));
}
