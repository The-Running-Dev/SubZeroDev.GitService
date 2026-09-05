import type { BranchName, ClonePath } from '../shared/brands.ts';
import type { Exec } from './exec.ts';

/**
 * `git rev-parse --abbrev-ref HEAD`, normalised: a detached HEAD (the literal
 * string `HEAD`) and a failed call both read as "no branch", not two
 * different shapes a caller has to tell apart. The one implementation
 * `git-operations.ts`, `composites.ts` and `clone-store.ts` all call, rather
 * than a private copy each maintaining its own detached-HEAD handling.
 *
 * Lives beside `Exec` itself (L1), not in `git/` (L2, issue #60's original
 * home for this function): `clone-store.ts` is L1, and the direction rule
 * `scripts/check-layer-direction.ts` enforces ("dependencies point downward
 * only") refuses an L1-to-L2 value import even though B1 itself only
 * forbids L2 imports from L0/L3/L4/L5. Everything this needs — `Exec`,
 * `ClonePath`, `BranchName` — is already L0/L1, so this is where a module
 * every layer from L1 up can share it without creating an upward edge.
 */
export async function currentBranch(exec: Pick<Exec, 'runGit'>, cwd: ClonePath, timeoutSeconds: number, signal: AbortSignal): Promise<BranchName | null> {
  const result = await exec.runGit({ argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, timeoutSeconds, credential: null, signal });
  if (!result.ok) return null;
  const name = result.value.stdout.trim();
  return name.length > 0 && name !== 'HEAD' ? (name as BranchName) : null;
}
