import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CloneUrl } from '../../shared/brands.ts';

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  }
}

/**
 * A real local git remote for tests that exercise `CloneStore` against
 * actual `git clone`/`git rev-parse`/etc. subprocesses, rather than mocking
 * them — per `agent.md` § Verification ("running the code beats recalling
 * it"), the properties S5 claims (a genuine clone, a genuine corrupt-tree
 * detection, a genuine unreachable-commit count) are only real if a real
 * `git` process produced them. `cloneUrl` accepts a bare local path with no
 * scheme, so the branded `CloneUrl` cast here is the same "just a string at
 * runtime" the deployment-facing `cloneUrl()` validator itself relies on —
 * this fixture bypasses that validator deliberately, the way a unit test for
 * `CloneStore` in isolation is expected to.
 */
export function createBareGitRemote(): CloneUrl {
  const dir = mkdtempSync(path.join(tmpdir(), 'szg-remote-'));
  const bareDir = path.join(dir, 'remote.git');
  const workDir = path.join(dir, 'work');
  git(['init', '--bare', '--initial-branch=main', bareDir], dir);

  git(['init', '--initial-branch=main', workDir], dir);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'remote', 'add', 'origin', bareDir], workDir);
  writeFileSync(path.join(workDir, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md'], workDir);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial'], workDir);
  git(['push', 'origin', 'main'], workDir);

  return bareDir as CloneUrl;
}
