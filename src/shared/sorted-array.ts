/**
 * A `Set` (or an array treated as an unordered collection) has no order of
 * its own; sorting it into an array is how a caller gets a deterministic,
 * reordering-invariant sequence — for hashing (`src/contract/fingerprint.ts`)
 * or for a stable wire shape (`src/surfaces/declaration-routes.ts`). One
 * shared helper instead of each caller re-deriving `[...x].sort()`.
 */
export function sortedArray<T>(values: Iterable<T>): readonly T[] {
  return [...values].sort();
}
