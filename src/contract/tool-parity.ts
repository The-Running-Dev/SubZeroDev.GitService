import { expandScopes } from '../authorization/authorization.ts';
import type { SessionKind } from '../declarations/types.ts';
import { capabilityScopeOf, type CapabilityName, type ContractCapabilitySet, type OperatorScope } from './capabilities.ts';
import type { JsonSchema } from './json.ts';
import type { CompiledRegistry } from './tool-declaration.ts';

/** The four `SessionKind`s the service defines — S36.1's "every profile the service defines". */
export const TOOL_PARITY_PROFILES: readonly SessionKind[] = ['operator', 'mcp', 'scheduler', 'watcher'];

const ALL_OPERATOR_SCOPES: readonly OperatorScope[] = ['read', 'write', 'raw', 'schedule'];

/**
 * Every declaration-scoped capability the contract declares — the widest
 * grant a `scheduler` or `watcher` session can carry, mirroring
 * `watcher.ts`'s own `declarationScopedCapabilities` (its comment: scoped to
 * declaration-scoped capabilities only, so an instance-scoped one a future
 * tool might add is never inherited — invariant A7). `scheduler` has no
 * equivalent real construction site to mirror (a job's `frozenGrant` is
 * whatever its creating session already held), so it is modelled the same
 * way as `watcher`: the two share one `ActorProfile` shape and one row of
 * A7, and this is the grant A7 promises them, not the raw pass-through
 * `scheduler.ts` today happens to store.
 */
function declarationScopedCapabilities(contract: ContractCapabilitySet): ReadonlySet<CapabilityName> {
  return new Set([...(contract as unknown as ReadonlySet<CapabilityName>)].filter((capability) => capabilityScopeOf(capability) === 'declaration'));
}

/**
 * The widest grant a session of `profile`'s kind can ever hold, against a
 * declaration and deployment ceiling that grant everything — i.e. what a
 * caller of that profile would see if nothing narrower than the profile
 * itself were in the way. Reuses the real construction each kind's session
 * is actually built with (`tool-routes.ts`'s `sessionFor`, `authorization.ts`'s
 * `establishMcpSession`, `watcher.ts`'s `watcherSessionFor`) rather than a
 * second, independently-maintained description of them.
 */
function maximalGrant(profile: SessionKind, contract: ContractCapabilitySet): ReadonlySet<CapabilityName> {
  switch (profile) {
    case 'operator':
      return new Set(contract as unknown as ReadonlySet<CapabilityName>);
    case 'mcp':
      return new Set(expandScopes(ALL_OPERATOR_SCOPES, contract) as unknown as ReadonlySet<CapabilityName>);
    case 'scheduler':
    case 'watcher':
      return declarationScopedCapabilities(contract);
  }
}

export interface ToolParityEntry {
  readonly name: string;
  readonly capabilities: readonly CapabilityName[];
  readonly inputSchema: JsonSchema;
}

export interface ToolParitySnapshot {
  readonly profile: SessionKind;
  readonly tools: readonly ToolParityEntry[];
}

/**
 * S36.1/S36.5: captures what `tools/list` would actually show a caller of
 * each profile — a tool whose capabilities the profile's widest grant
 * cannot satisfy is absent from that profile's snapshot, the same
 * `entry.capabilities.every(c => grant.has(c))` test `dispatch-pipeline.ts`'s
 * `isVisible` runs at call time, not the whole registry re-listed once.
 */
export function captureToolParity(registry: CompiledRegistry): readonly ToolParitySnapshot[] {
  return TOOL_PARITY_PROFILES.map((profile) => {
    const grant = maximalGrant(profile, registry.contractCapabilitySet);
    const tools = registry.entries
      .filter((entry) => entry.capabilities.every((capability) => grant.has(capability)))
      .map((entry) => ({
        name: entry.name as string,
        capabilities: [...entry.capabilities].sort(),
        inputSchema: entry.inputSchema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { profile, tools };
  });
}

export type ToolParityDifferenceKind = 'removed' | 'added' | 'capabilities-changed' | 'input-changed';

export interface ToolParityDifference {
  readonly profile: SessionKind;
  readonly tool: string;
  readonly kind: ToolParityDifferenceKind;
  readonly detail: string;
}

export interface ToolParityComparison {
  readonly differences: readonly ToolParityDifference[];
  /** True whenever any difference is not an addition — S36.4: an addition alone never fails a run. */
  readonly failed: boolean;
}

function schemaEquals(a: JsonSchema, b: JsonSchema): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * S36.2–S36.5: compares two captures profile by profile. A tool present in
 * the baseline and absent from current is `removed` (fails); present in
 * current and absent from baseline is `added` (does not fail — a derived
 * image may legitimately offer a superset); present in both with a
 * different `capabilities` set is `capabilities-changed`; with a different
 * `inputSchema` is `input-changed`. Because capture already filters per
 * profile, a capability change that hides a tool from one profile alone
 * surfaces as a `removed` difference in that profile's comparison only.
 */
export function compareToolParity(baseline: readonly ToolParitySnapshot[], current: readonly ToolParitySnapshot[]): ToolParityComparison {
  const differences: ToolParityDifference[] = [];
  const currentByProfile = new Map(current.map((snapshot) => [snapshot.profile, snapshot]));

  for (const baseSnapshot of baseline) {
    const curSnapshot = currentByProfile.get(baseSnapshot.profile);
    const baseByName = new Map(baseSnapshot.tools.map((tool) => [tool.name, tool]));
    const curByName = new Map((curSnapshot?.tools ?? []).map((tool) => [tool.name, tool]));

    for (const [name, baseTool] of baseByName) {
      const curTool = curByName.get(name);
      if (!curTool) {
        differences.push({ profile: baseSnapshot.profile, tool: name, kind: 'removed', detail: `'${name}' is no longer visible to profile '${baseSnapshot.profile}'` });
        continue;
      }
      if (JSON.stringify(baseTool.capabilities) !== JSON.stringify(curTool.capabilities)) {
        differences.push({
          profile: baseSnapshot.profile,
          tool: name,
          kind: 'capabilities-changed',
          detail: `'${name}' required capabilities changed from [${baseTool.capabilities.join(', ')}] to [${curTool.capabilities.join(', ')}] for profile '${baseSnapshot.profile}'`,
        });
      }
      if (!schemaEquals(baseTool.inputSchema, curTool.inputSchema)) {
        differences.push({ profile: baseSnapshot.profile, tool: name, kind: 'input-changed', detail: `'${name}' input schema changed for profile '${baseSnapshot.profile}'` });
      }
    }

    for (const [name] of curByName) {
      if (!baseByName.has(name)) {
        differences.push({ profile: baseSnapshot.profile, tool: name, kind: 'added', detail: `'${name}' is newly visible to profile '${baseSnapshot.profile}'` });
      }
    }
  }

  return { differences, failed: differences.some((d) => d.kind !== 'added') };
}
