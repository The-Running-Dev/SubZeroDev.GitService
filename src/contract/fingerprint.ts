import { createHash } from 'node:crypto';
import type { Sha256Hex } from '../shared/brands.ts';
import type { CapabilityName, ContractCapabilitySet } from './capabilities.ts';
import type { ToolDeclaration } from './tool-declaration.ts';

/**
 * Deep, key-sorted JSON serialisation. Array order is preserved because the
 * only array this is applied to (`entries`) is already normalised to a fixed
 * order by the caller before hashing — sorting keys, not sorting sequences,
 * is what makes two semantically identical declarations hash identically
 * regardless of the property order they were written in.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Normalises `entries` into the fixed, content-derived order (by tool name)
 * that makes the fingerprint reordering-invariant: two declaration arrays
 * that differ only in element order produce the same normalised sequence and
 * therefore the same hash.
 */
export function normaliseEntryOrder(entries: readonly ToolDeclaration[]): readonly ToolDeclaration[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function computeFingerprint(
  normalisedEntries: readonly ToolDeclaration[],
  contractCapabilitySet: ContractCapabilitySet,
): Sha256Hex {
  const capabilities = [...(contractCapabilitySet as ReadonlySet<CapabilityName>)].sort();
  const canonical = canonicalize({ entries: normalisedEntries, contractCapabilitySet: capabilities });
  return createHash('sha256').update(canonical, 'utf8').digest('hex') as Sha256Hex;
}
