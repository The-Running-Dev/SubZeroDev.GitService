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
