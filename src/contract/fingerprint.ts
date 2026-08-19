import { createHash } from 'node:crypto';
import type { Sha256Hex } from '../shared/brands.ts';
import { canonicalize } from '../shared/canonical-json.ts';
import { sortedArray } from '../shared/sorted-array.ts';
import type { CapabilityName, ContractCapabilitySet } from './capabilities.ts';
import type { ToolDeclaration } from './tool-declaration.ts';

/**
 * Normalises `entries` into the fixed, content-derived order (by tool name)
 * that makes the fingerprint reordering-invariant: two declaration arrays
 * that differ only in element order produce the same normalised sequence and
 * therefore the same hash.
 */
export function normaliseEntryOrder(entries: readonly ToolDeclaration[]): readonly ToolDeclaration[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * `capabilities` and `scopes` are unordered sets in every sense but their TS
 * type (`readonly CapabilityName[]` / `readonly Scope[]`, not a `Set`) — a
 * declaration authored with the same two capabilities in a different order
 * is the same declaration. Sorting them here, for hashing only, is what makes
 * the fingerprint invariant to that; the actual emitted `entries` keep the
 * author's original order, since that's a readability choice, not a content
 * one.
 */
function fingerprintProjection(entry: ToolDeclaration): unknown {
  return { ...entry, capabilities: sortedArray(entry.capabilities), scopes: sortedArray(entry.scopes) };
}

export function computeFingerprint(
  normalisedEntries: readonly ToolDeclaration[],
  contractCapabilitySet: ContractCapabilitySet,
): Sha256Hex {
  const capabilities = sortedArray(contractCapabilitySet as ReadonlySet<CapabilityName>);
  const projectedEntries = normalisedEntries.map(fingerprintProjection);
  const canonical = canonicalize({ entries: projectedEntries, contractCapabilitySet: capabilities });
  return createHash('sha256').update(canonical, 'utf8').digest('hex') as Sha256Hex;
}
