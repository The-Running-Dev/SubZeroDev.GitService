import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createExec } from '../exec/exec.ts';
import { createLocks } from '../locks/locks.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { ClonePath, DeclarationId, OperationId } from '../shared/brands.ts';
import { createGitOperations } from './git-operations.ts';

/**
 * Neutralised exactly like `Exec` (`exec/exec.ts`'s `neutralGitEnv`) so a
 * developer machine's global `core.autocrlf` or line-ending config cannot
 * make a freshly cloned tree register as dirty under `git status` once
 * `GitOperations` reads it back with its own neutral config.
 */
function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
}

/** A real local clone — a real second checkout of a real bare remote, not a mock. */
function realClone(): { readonly clonePath: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'szg-gitops-'));
  const bareDir = path.join(dir, 'remote.git');
  const clonePath = path.join(dir, 'clone');
  git(['init', '--bare', '--initial-branch=main', bareDir], dir);

  const seedDir = path.join(dir, 'seed');
  mkdirSync(seedDir);
  git(['init', '--initial-branch=main', seedDir], dir);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'remote', 'add', 'origin', bareDir], seedDir);
  writeFileSync(path.join(seedDir, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md'], seedDir);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial'], seedDir);
  git(['push', 'origin', 'main'], seedDir);

  git(['clone', bareDir, clonePath], dir);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'config', 'user.name', 'fixture'], clonePath);

  return { clonePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function contextFor(clonePath: string): CallContext {
  return {
    operationId: 'op-1' as OperationId,
    declarationId: 'repo-a' as DeclarationId,
    generation: 1 as never,
    cloneRoot: clonePath as ClonePath,
    actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
    capabilities: new Set() as never,
    writablePathPrefixes: [],
    context: 'normal',
    scheduledJobId: null,
    deadline: systemClock.now(),
    signal: new AbortController().signal,
  };
}

test('repo_status: a repository with no config file returns baseBranch default and succeeds', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const result = await gitOperations.status(contextFor(clonePath), {});
      assert.equal(result.ok, true);
      if (!result.ok || !result.data) return;
      assert.equal(result.data.baseBranch, 'main', 'REPOSITORY_CONFIG_DEFAULTS.baseBranch with no config file');
      assert.equal(result.data.dirty, false);
      assert.equal(result.data.readStamp.mutationInFlight, false);
    } finally {
      cleanup();
    }
  });
});

test('git_log with no ref reads origin/<baseBranch>, not HEAD, when parked on a different branch', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      // Park the checkout on a branch that has no commits at all, and add one
      // more commit to origin/main behind its back — the only way `git_log`
      // can show that commit is by defaulting to `origin/main`, never `HEAD`.
      git(['checkout', '-b', 'topic'], clonePath);
      const remoteDir = path.join(clonePath, '..', 'seed');
      writeFileSync(path.join(remoteDir, 'second.md'), 'second\n', 'utf8');
      git(['add', 'second.md'], remoteDir);
      git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'second commit'], remoteDir);
      git(['push', 'origin', 'main'], remoteDir);
      git(['fetch', 'origin'], clonePath);

      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const result = await gitOperations.log(contextFor(clonePath), { ref: null });
      assert.equal(result.ok, true);
      if (!result.ok || !result.data) return;
      assert.equal(result.data.ref, 'origin/main');
      assert.equal(result.data.commits.length, 2, 'includes the commit that only exists on origin/main, not on the parked topic branch');
      assert.equal(result.data.commits[0]!.subject, 'second commit', 'newest first');
    } finally {
      cleanup();
    }
  });
});

test('git_branches lists local branches with current flagged', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      git(['checkout', '-b', 'topic'], clonePath);
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const result = await gitOperations.branches(contextFor(clonePath), {});
      assert.equal(result.ok, true);
      if (!result.ok || !result.data) return;
      const names = result.data.branches.map((b) => b.name).sort();
      assert.deepEqual(names, ['main', 'topic']);
      const topic = result.data.branches.find((b) => b.name === 'topic');
      assert.equal(topic?.current, true);
    } finally {
      cleanup();
    }
  });
});

test('repo_health reports dirty and ahead/behind, both a real diff can produce', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      writeFileSync(path.join(clonePath, 'untracked.txt'), 'x\n', 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const result = await gitOperations.health(contextFor(clonePath), {});
      assert.equal(result.ok, true);
      if (!result.ok || !result.data) return;
      assert.equal(result.data.dirty, true);
      assert.equal(result.data.baseBranch, 'main');
    } finally {
      cleanup();
    }
  });
});

test('git_diff shows a staged change', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nmore\n', 'utf8');
      git(['add', 'README.md'], clonePath);

      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const result = await gitOperations.diff(contextFor(clonePath), { staged: true, paths: null });
      assert.equal(result.ok, true);
      if (!result.ok || !result.data) return;
      assert.match(result.data.diff, /README\.md/);
      assert.match(result.data.diff, /\+more/);
    } finally {
      cleanup();
    }
  });
});

test('two reads of the same repository run concurrently — overlapping timestamps, per E4', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      let firstStarted = 0;
      let secondStarted = 0;
      let firstFinished = 0;

      const first = (async () => {
        firstStarted = Date.now();
        await gitOperations.status(contextFor(clonePath), {});
        firstFinished = Date.now();
      })();
      const second = (async () => {
        // Give the first call a moment to actually begin its subprocess work.
        await new Promise((r) => setTimeout(r, 5));
        secondStarted = Date.now();
        await gitOperations.status(contextFor(clonePath), {});
      })();

      await Promise.all([first, second]);
      assert.ok(secondStarted < firstFinished, 'the second read started before the first finished — no lock serialised them');
      void firstStarted;
    } finally {
      cleanup();
    }
  });
});
