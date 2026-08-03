/**
 * Deep, key-sorted JSON serialisation. Array order is preserved — an ordered
 * array (`entries`, `changedPaths`, `argv`) is content, not a set.
 *
 * Shared rather than owned by the compiler, because two independent
 * consumers need byte-identical output: the compiler's registry fingerprint
 * (`src/contract/fingerprint.ts`, build-time only, absent from the runtime
 * per invariant B8) and the audit trail's record hash (`src/audit/hash.ts`,
 * runtime, per `20-contract.md` § Audit's U9 resolution, which states this is
 * "the same algorithm" as the fingerprint's). A shared, dependency-free
 * function in `shared/` is how that stays true without the runtime importing
 * anything under `src/contract/`.
 */
export function sortKeysDeep(value: unknown): unknown {
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

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
