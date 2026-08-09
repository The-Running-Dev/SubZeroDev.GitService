import type { BranchName, ClonePath } from '../shared/brands.ts';
import type { Exec } from '../exec/exec.ts';

/**
 * `git rev-parse --abbrev-ref HEAD`, normalised: a detached HEAD (the literal
 * string `HEAD`) and a failed call both read as "no branch", not two
 * different shapes a caller has to tell apart. The one implementation both
 * `git-operations.ts` and `composites.ts` call, rather than a private copy
 * each maintaining its own detached-HEAD handling.
 */
export async function currentBranch(exec: Pick<Exec, 'runGit'>, cwd: ClonePath, timeoutSeconds: number, signal: AbortSignal): Promise<BranchName | null> {
  const result = await exec.runGit({ argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, timeoutSeconds, credential: null, signal });
  if (!result.ok) return null;
  const name = result.value.stdout.trim();
  return name.length > 0 && name !== 'HEAD' ? (name as BranchName) : null;
}
