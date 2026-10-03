import type { ClonePath, GitSha } from '../shared/brands.ts';
import type { Exec } from '../exec/exec.ts';

/**
 * The shared local-git plumbing `git-operations.ts` and `composites.ts` both
 * need, so neither carries a private copy with its own idea of what a failure
 * looks like. Each normalises the same way: a failed call is `null` or
 * `false`, never a third shape a caller has to tell apart.
 *
 * `currentBranch` is re-exported rather than defined here. `clone-store.ts`
 * (L1) needs it too, and `scripts/check-layer-direction.ts` refuses an L1
 * import of anything under `git/` (L2), so the one implementation stays in
 * `exec/primitives.ts` and this module is where the L2 callers find it.
 */
export { currentBranch } from '../exec/primitives.ts';

/** `git rev-parse --verify <ref>`: the commit it names, or `null` when it does not resolve or the call failed. */
export async function revParse(exec: Pick<Exec, 'runGit'>, cwd: ClonePath, ref: string, timeoutSeconds: number, signal: AbortSignal): Promise<GitSha | null> {
  const result = await exec.runGit({ argv: ['rev-parse', '--verify', ref], cwd, timeoutSeconds, credential: null, signal });
  return result.ok ? (result.value.stdout.trim() as GitSha) : null;
}

/** `git merge-base --is-ancestor`: true only on a zero exit, so "not an ancestor" and "could not ask" both read `false`. */
export async function isAncestor(
  exec: Pick<Exec, 'runGit'>,
  cwd: ClonePath,
  ancestor: string,
  descendant: string,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await exec.runGit({ argv: ['merge-base', '--is-ancestor', ancestor, descendant], cwd, timeoutSeconds, credential: null, signal });
  return result.ok;
}
