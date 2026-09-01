import type { Brand } from '../shared/brands.ts';

/**
 * Open at the family, fixed at the tail — `20-contract.md` § *Capabilities
 * and the lattice*: "Openness is bounded at the tail, not at the head." A
 * consumer names the family (`content.post`, `content.gitUtility`); the
 * final segment must be `read` or `write`, which is what lets `### Scopes`'s
 * rule place a name this document has never seen.
 */
export type ContentCapability = `content.${string}.read` | `content.${string}.write`;

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
 * are a closed, listed set; every other `CapabilityName` — the nine fixed
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

export function isContentCapability(capability: CapabilityName): capability is ContentCapability {
  return capability.startsWith('content.');
}

/**
 * The nine fixed declaration-scoped literals' scope follows their operation
 * family, which coincides with their own tail only seven times out of nine
 * (`scheduler.read`/`scheduler.manage` end in `read`/nothing-read but belong
 * to `schedule`) — `20-contract.md` § *Scopes*. This is the one place that
 * table is written; `expandScopes` and the compiler's `capability-unscopable`
 * check both read it rather than keeping their own copy.
 */
const FIXED_CAPABILITY_SCOPE: ReadonlyMap<CapabilityName, McpScope> = new Map([
  ['repo.read', 'read'],
  ['host.pr.read', 'read'],
  ['host.checks.read', 'read'],
  ['git.local.write', 'write'],
  ['git.remote.write', 'write'],
  ['host.pr.write', 'write'],
  ['git.raw', 'raw'],
  ['scheduler.manage', 'schedule'],
  ['scheduler.read', 'schedule'],
]);

/**
 * The scope `### Scopes`'s rule places `capability` in, or `null` when no
 * scope can reach it. The nine fixed literals are placed by the closed table
 * above, which cannot miss one. A `content.*` capability is placed by its own
 * tail — `read` to `read`, `write` to `write` — the rule `ContentCapability`'s
 * type already enforces for a literal; `null` is reachable only for a
 * malformed name that arrived as a widened `string`, which is exactly what
 * the compiler's `capability-unscopable` error exists to catch (**A10**).
 * Every other `CapabilityName` — the four instance-scoped ones — is also
 * `null` here, deliberately: they are unscoped by design (**A7**), not
 * unscopable, and the compiler check below is gated on `capabilityScopeOf`
 * to keep that distinction.
 */
export function scopeForCapability(capability: CapabilityName): McpScope | null {
  const fixed = FIXED_CAPABILITY_SCOPE.get(capability);
  if (fixed) return fixed;
  if (isContentCapability(capability)) {
    if (capability.endsWith('.read')) return 'read';
    if (capability.endsWith('.write')) return 'write';
  }
  return null;
}

/**
 * A scope expands to capabilities by a total rule, not a lookup table —
 * `20-contract.md` § *Scopes*: `scopeForCapability` above is the single place
 * that rule is written (the closed nine-literal table plus the `content.*`
 * tail rule), so this only ever grants a capability this deployment's
 * contract set actually holds (invariant A1) and is, by construction, total
 * over it (**A10**) — a capability the rule cannot place is caught at compile
 * time by `capability-unscopable` instead of silently expanding to nothing
 * here.
 *
 * **Declared here rather than in the authorization module**, for the same
 * reason `HostKind` below is: it is pure over `scopeForCapability` and holds
 * no authorization state, and `src/contract/tool-parity.ts` needs it. Keeping
 * it at L4 made L0 import L4 at runtime — the one edge that made the module
 * graph cyclic and "dependencies point downward only" (`10-design.md`
 * § *Module boundaries*) false. `authorization.ts` re-exports it, so **A10**'s
 * "Compiler, Authorization" responsibility is unchanged.
 */
export function expandScopes(scopes: readonly OperatorScope[], contractCapabilitySet: ContractCapabilitySet): SessionGrant {
  const granted = new Set<CapabilityName>();
  const requested = new Set<OperatorScope>(scopes);
  for (const capability of contractCapabilitySet as unknown as ReadonlySet<CapabilityName>) {
    const scope = scopeForCapability(capability);
    if (scope !== null && requested.has(scope)) granted.add(capability);
  }
  return granted as unknown as SessionGrant;
}

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
