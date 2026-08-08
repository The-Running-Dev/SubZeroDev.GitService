import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { ClonePath, CredentialRef, DeclarationId, EnvVarName } from '../shared/brands.ts';
import { createExec } from './exec.ts';

const VARIABLE = 'SZG_CREDENTIAL_FIXTURE' as EnvVarName;
const SECRET = 'ghp-exec-fixture-secret-0123456789';

function scratchRepo(): { readonly cwd: ClonePath; readonly cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'szg-exec-'));
  spawnSync('git', ['init', '--initial-branch=main', '.'], { cwd: dir, encoding: 'utf8' });
  return { cwd: dir as ClonePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * S9.2, the process-argument-vector half — observed from *inside* the child
 * rather than from the call site. `git config --list` prints every `-c`
 * setting the invocation carried, which is the only channel `Exec` adds to a
 * caller's `argv` at all. A secret smuggled in as configuration (an
 * `http.extraHeader`, a credential embedded in a URL) would show up here; the
 * helper this service actually configures does not, because it names a
 * variable rather than a value.
 */
test('S9.2: the credential reaches the child as configuration naming a variable, and the secret itself appears in no argument', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const repo = scratchRepo();
    try {
      const credentialEnv = new Map<EnvVarName, string>([[VARIABLE, SECRET]]);
      const spawned: { executable: string; argv: readonly string[] }[] = [];
      const exec = createExec({ volumeRoot, credentialEnv, onSpawn: (executable, argv) => spawned.push({ executable, argv }) });

      const result = await exec.runGit({
        argv: ['config', '--list'],
        cwd: repo.cwd,
        timeoutSeconds: 30,
        credential: { ref: 'fixture' as CredentialRef, declarationId: 'repo-a' as DeclarationId, variableName: VARIABLE },
        signal: new AbortController().signal,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;

      // The channel is configured — read from the child's own account of the
      // command line it was handed.
      assert.match(result.value.stdout, /credential\.helper=/);

      // And the vector that actually became a process carries no secret. This
      // is the assertion that matters: `result.value.stdout` has already been
      // through `scrub`, so a leak into `argv` would be invisible there.
      assert.equal(spawned.length, 1);
      assert.equal(
        spawned[0]!.argv.some((element) => element.includes(SECRET)),
        false,
      );
      // The only thing prepended is the helper configuration — cleared, then
      // set to this service's own — and the caller's own vector follows it
      // unchanged.
      assert.deepEqual(spawned[0]!.argv.slice(0, 3), ['-c', 'credential.helper=', '-c']);
      assert.match(spawned[0]!.argv[3]!, /^credential\.helper=!'.*credential-helper\.sh'$/);
      assert.deepEqual(spawned[0]!.argv.slice(4), ['config', '--list']);
    } finally {
      repo.cleanup();
    }
  });
});

test('S9.2: a resolved secret appearing in captured output is redacted by scrub, and scrubJson reaches nested strings', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const credentialEnv = new Map<EnvVarName, string>([[VARIABLE, SECRET]]);
    const exec = createExec({ volumeRoot, credentialEnv });

    assert.equal(exec.scrub(`fatal: could not read ${SECRET} from remote`).includes(SECRET), false);
    assert.match(exec.scrub(`fatal: ${SECRET}`), /\*\*\*/);
    // The URL-embedded form is still redacted for a credential this process
    // never resolved — the two rules are additive, not alternatives.
    assert.equal(exec.scrub('https://user:hunter2@example.com/x.git').includes('hunter2'), false);

    const scrubbed = JSON.stringify(exec.scrubJson({ message: `token ${SECRET}`, nested: { list: [SECRET] } }));
    assert.equal(scrubbed.includes(SECRET), false);
  });
});

test('a credential naming a variable the shared env does not hold runs without one rather than authenticating as empty', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const repo = scratchRepo();
    try {
      const exec = createExec({ volumeRoot, credentialEnv: new Map<EnvVarName, string>() });
      const result = await exec.runGit({
        argv: ['config', '--list'],
        cwd: repo.cwd,
        timeoutSeconds: 30,
        credential: { ref: 'fixture' as CredentialRef, declarationId: 'repo-a' as DeclarationId, variableName: VARIABLE },
        signal: new AbortController().signal,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      // No helper is configured at all: an unresolved reference must surface as
      // a resolution failure, not as an authentication rejection that marks a
      // reference which never resolved.
      assert.equal(/credential\.helper=/.test(result.value.stdout), false);
    } finally {
      repo.cleanup();
    }
  });
});
