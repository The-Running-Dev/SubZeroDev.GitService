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
import type { ClonePath, DeclarationId, OperationId, PathPrefix } from '../shared/brands.ts';
import type { AuditAppendInput, AuditAppendOutcome } from '../audit/types.ts';
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
  git(['config', 'user.name', 'fixture'], clonePath);
  git(['config', 'user.email', 'fixture@example.com'], clonePath);

  return { clonePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function contextFor(clonePath: string, writablePathPrefixes: readonly PathPrefix[] = []): CallContext {
  return {
    operationId: 'op-1' as OperationId,
    declarationId: 'repo-a' as DeclarationId,
    generation: 1 as never,
    cloneRoot: clonePath as ClonePath,
    actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
    capabilities: new Set() as never,
    writablePathPrefixes,
    context: 'normal',
    scheduledJobId: null,
    deadline: systemClock.now(),
    signal: new AbortController().signal,
  };
}

function recordingAudit(): { readonly append: (input: AuditAppendInput) => Promise<AuditAppendOutcome>; readonly records: AuditAppendInput[] } {
  const records: AuditAppendInput[] = [];
  return {
    records,
    async append(input: AuditAppendInput): Promise<AuditAppendOutcome> {
      records.push(input);
      return { appended: true, sequence: records.length };
    },
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

test('git_stage stages a well-formed path under the writable allowlist', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nmore\n', 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const audit = recordingAudit();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });

      const result = await gitOperations.stage(contextFor(clonePath, ['README.md' as PathPrefix]), { paths: ['README.md' as never] });
      assert.equal(result.ok, true);
      if (!result.ok || !result.data) return;
      assert.deepEqual(result.data.staged, ['README.md']);

      const statusResult = await gitOperations.status(contextFor(clonePath), {});
      assert.equal(statusResult.ok, true);
      if (!statusResult.ok || !statusResult.data) return;
      assert.equal(statusResult.data.changedPaths[0]?.staged, true);
      assert.equal(audit.records.length, 0, 'a successful stage writes no authorization-rejection record');
    } finally {
      cleanup();
    }
  });
});

test('git_stage: a malformed path returns validation and writes no audit record — well-formed but outside the allowlist returns authorization and writes one', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nmore\n', 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();

      let malformedRejected = 0;
      let allowlistRejected = 0;

      // `-A`, `--all`, `.`, a `..` segment, a `;` — every malformed case
      // `repoRelativePath`'s own rule table names — each on its own audit
      // and count so a failure doesn't hide the other cases.
      const malformedCases = ['-A', '--all', '.', '../x', 'a;b'];
      for (const malformed of malformedCases) {
        const audit = recordingAudit();
        const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
        const result = await gitOperations.stage(contextFor(clonePath, ['/' as PathPrefix]), { paths: [malformed as never] });
        assert.equal(result.kind, 'validation', `'${malformed}' should be malformed`);
        assert.equal(audit.records.length, 0, `'${malformed}' is malformed input, not an authorization rejection — no audit record`);
        malformedRejected += 1;
      }
      assert.equal(malformedRejected, malformedCases.length);

      const audit = recordingAudit();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
      const outsideResult = await gitOperations.stage(contextFor(clonePath, ['some/other/prefix/' as PathPrefix]), { paths: ['README.md' as never] });
      assert.equal(outsideResult.kind, 'authorization', `'README.md' is well-formed but outside the allowlist`);
      assert.equal(audit.records.length, 1, 'a well-formed path outside the allowlist writes exactly one audit record');
      assert.equal(audit.records[0]!.form, 'authorization-rejection');
      allowlistRejected += 1;
      assert.equal(allowlistRejected, 1);
    } finally {
      cleanup();
    }
  });
});

test('git_commit commits what is staged and reports the sha, branch and changed paths', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      git(['checkout', '-b', 'topic'], clonePath);
      writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nmore\n', 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const staged = await gitOperations.stage(contextFor(clonePath, ['README.md' as PathPrefix]), { paths: ['README.md' as never] });
      assert.equal(staged.ok, true);

      const result = await gitOperations.commit(contextFor(clonePath), { message: 'update README' });
      assert.equal(result.ok, true);
      if (!result.ok || !result.data) return;
      assert.match(result.data.sha, /^[0-9a-f]{40}$/);
      assert.equal(result.data.branch, 'topic');
      assert.deepEqual(result.data.changedPaths, ['README.md']);
    } finally {
      cleanup();
    }
  });
});

test('git_commit refuses on the configured base branch — protected-base invariant 1', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nmore\n', 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const staged = await gitOperations.stage(contextFor(clonePath, ['README.md' as PathPrefix]), { paths: ['README.md' as never] });
      assert.equal(staged.ok, true);

      const result = await gitOperations.commit(contextFor(clonePath), { message: 'update README' });
      assert.equal(result.ok, false);
      assert.equal(result.kind, 'precondition');
    } finally {
      cleanup();
    }
  });
});

test('git_commit refuses to proceed when the repository config is unparseable, rather than silently allowing a base-branch commit', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      mkdirSync(path.join(clonePath, '.config'));
      writeFileSync(path.join(clonePath, '.config', 'subzerodev-git.json'), '{not valid json', 'utf8');
      writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nmore\n', 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const staged = await gitOperations.stage(contextFor(clonePath, ['README.md' as PathPrefix]), { paths: ['README.md' as never] });
      assert.equal(staged.ok, true);

      const result = await gitOperations.commit(contextFor(clonePath), { message: 'update README' });
      assert.equal(result.ok, false, 'an unparseable config must not be treated as "no base branch configured"');
      assert.equal(result.kind, 'precondition');
    } finally {
      cleanup();
    }
  });
});

test('loadRepositoryConfig refuses a baseBranch git would read as an option, rather than reaching git fetch with it (issue #149)', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      mkdirSync(path.join(clonePath, '.config'));
      writeFileSync(path.join(clonePath, '.config', 'subzerodev-git.json'), JSON.stringify({ baseBranch: '--upload-pack=/bin/sh' }), 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const result = await gitOperations.loadRepositoryConfig(contextFor(clonePath));
      assert.equal(result.ok, false, 'a baseBranch beginning with - must never reach syncBase, which passes it to git fetch as a bare positional');
      if (result.ok) return;
      assert.equal(result.error.resultKind, 'precondition');
      assert.equal(result.error.code, 'config-unparseable');

      // The same refusal reaches every domain operation that reads the
      // config, not just loadRepositoryConfig directly — repo_status is a
      // representative caller.
      const status = await gitOperations.status(contextFor(clonePath), {});
      assert.equal(status.ok, false);
      assert.equal(status.kind, 'precondition');
    } finally {
      cleanup();
    }
  });
});

test('loadRepositoryConfig accepts a well-formed custom baseBranch from config', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      mkdirSync(path.join(clonePath, '.config'));
      writeFileSync(path.join(clonePath, '.config', 'subzerodev-git.json'), JSON.stringify({ baseBranch: 'release/1.2' }), 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const result = await gitOperations.loadRepositoryConfig(contextFor(clonePath));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.value.baseBranch, 'release/1.2');
    } finally {
      cleanup();
    }
  });
});

test('git_restore_paths restores a well-formed, allowlisted path to HEAD, discarding the change', async () => {
  await withVolumeAsync(async (volume) => {
    const { clonePath, cleanup } = realClone();
    try {
      writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const gitOperations = createGitOperations({ clock: systemClock, exec, locks });

      const result = await gitOperations.restorePaths(contextFor(clonePath, ['README.md' as PathPrefix]), { paths: ['README.md' as never] });
      assert.equal(result.ok, true);
      if (!result.ok || !result.data) return;
      assert.deepEqual(result.data.restored, ['README.md']);

      const statusResult = await gitOperations.status(contextFor(clonePath), {});
      assert.equal(statusResult.ok, true);
      if (!statusResult.ok || !statusResult.data) return;
      assert.equal(statusResult.data.dirty, false, 'the working tree change was discarded');
    } finally {
      cleanup();
    }
  });
});

test('GitOperations has no reset, clean, force-push, rebase or branch-delete operation — all six attempts through the typed surface fail', async () => {
  await withVolumeAsync(async (volume) => {
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks }) as unknown as Record<string, unknown>;

    const forbiddenOperationNames = ['reset', 'clean', 'forcePush', 'rebase', 'branchDelete', 'deleteBranch'];
    let absent = 0;
    for (const name of forbiddenOperationNames) {
      assert.equal(typeof gitOperations[name], 'undefined', `GitOperations must carry no '${name}' operation`);
      absent += 1;
    }
    assert.equal(absent, forbiddenOperationNames.length, `all ${forbiddenOperationNames.length} forbidden operations are confirmed absent`);
  });
});
