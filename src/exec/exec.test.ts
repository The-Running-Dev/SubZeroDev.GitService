import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { ClonePath } from '../shared/brands.ts';
import { createExec } from './exec.ts';

function scratchRepo(): { readonly cwd: ClonePath; readonly cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'szg-exec-neutral-env-'));
  spawnSync('git', ['init', '--initial-branch=main', '.'], { cwd: dir, encoding: 'utf8' });
  return { cwd: dir as ClonePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Issue #334: `neutralGitEnv()` pointed `GIT_CONFIG_GLOBAL` at the Windows
 * null device (`NUL`), which git's config loader rejects outright —
 * `fatal: unable to access 'NUL': Invalid argument`, exit 128 — failing
 * every real git invocation on Windows rather than neutralising the global
 * config. A path guaranteed never to exist is what git actually treats as
 * an empty global config, on every platform.
 */
test("issue #334: a real git invocation succeeds under the neutralised environment, rather than failing on GIT_CONFIG_GLOBAL", async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const repo = scratchRepo();
    try {
      const exec = createExec({ volumeRoot, credentialEnv: new Map() });

      const result = await exec.runGit({
        argv: ['status', '--porcelain=v1'],
        cwd: repo.cwd,
        timeoutSeconds: 30,
        credential: null,
        signal: new AbortController().signal,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.value.exitCode, 0);
    } finally {
      repo.cleanup();
    }
  });
});

const NODE = process.execPath;

/**
 * A POSIX child that kills itself with a signal exec did not send. On Windows
 * a self-sent signal is `TerminateProcess` and reaches the parent as exit code
 * 1, never as a signal, so the case cannot be produced there; the mapping
 * itself is platform-independent and runs on the Linux CI.
 */
test('S46.2: a started child killed by a signal exec did not send is signalled, carrying the signal name — not spawn-failed', { skip: process.platform === 'win32' }, async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const exec = createExec({ volumeRoot, credentialEnv: new Map(), gitExecutable: NODE });
    const result = await exec.runGit({
      argv: ['-e', "process.kill(process.pid, 'SIGTERM')"],
      cwd: volumeRoot as ClonePath,
      timeoutSeconds: 30,
      credential: null,
      signal: new AbortController().signal,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'signalled');
    assert.equal(result.error.code === 'signalled' && result.error.signal, 'SIGTERM');
    assert.equal(result.error.resultKind, 'infrastructure');
    assert.equal(result.error.retryable, false);
  });
});

test('S46.2: a cap or an abort exec itself sent is still timed-out / cancelled, not signalled', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const exec = createExec({ volumeRoot, credentialEnv: new Map(), gitExecutable: NODE });
    const capped = await exec.runGit({
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: volumeRoot as ClonePath,
      timeoutSeconds: 0.2,
      credential: null,
      signal: new AbortController().signal,
    });
    assert.equal(capped.ok, false);
    if (!capped.ok) assert.equal(capped.error.code, 'timed-out');

    const controller = new AbortController();
    const pending = exec.runGit({ argv: ['-e', 'setInterval(() => {}, 1000)'], cwd: volumeRoot as ClonePath, timeoutSeconds: 30, credential: null, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const aborted = await pending;
    assert.equal(aborted.ok, false);
    if (!aborted.ok) assert.equal(aborted.error.code, 'cancelled');
  });
});

test('S46.2: spawn-failed is returned only for a child that never started', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const exec = createExec({ volumeRoot, credentialEnv: new Map(), gitExecutable: path.join(volumeRoot, 'no-such-executable') });
    const result = await exec.runGit({ argv: ['status'], cwd: volumeRoot as ClonePath, timeoutSeconds: 30, credential: null, signal: new AbortController().signal });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'spawn-failed');
  });
});

test('S46.6: durationMs survives a wall clock stepped backwards while the child runs', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const exec = createExec({ volumeRoot, credentialEnv: new Map(), gitExecutable: NODE });
    const realNow = Date.now;
    let calls = 0;
    // Every reading after the first is an hour earlier than the one before it.
    Date.now = () => realNow() - 3_600_000 * calls++;
    try {
      const result = await exec.runGit({ argv: ['-e', '0'], cwd: volumeRoot as ClonePath, timeoutSeconds: 30, credential: null, signal: new AbortController().signal });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.ok(result.value.durationMs >= 0 && result.value.durationMs < 30_000, `durationMs was ${result.value.durationMs}`);
    } finally {
      Date.now = realNow;
    }
  });
});
