import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Exec } from '../exec/exec.ts';
import type { ClonePath } from '../shared/brands.ts';
import { currentBranch, isAncestor, revParse } from './primitives.ts';

const CWD = '/clone' as ClonePath;
const SIGNAL = new AbortController().signal;

/** A `runGit` double answering every call with one scripted outcome. */
function execAnswering(outcome: { readonly ok: true; readonly stdout: string } | { readonly ok: false }): Pick<Exec, 'runGit'> {
  return {
    async runGit() {
      return (outcome.ok ? { ok: true, value: { stdout: outcome.stdout, stderr: '', exitCode: 0 } } : { ok: false, error: { summary: 'exit 1' } }) as never;
    },
  };
}

test('S45.5 — revParse is the trimmed sha on success and null on any failure', async () => {
  assert.equal(await revParse(execAnswering({ ok: true, stdout: `${'a'.repeat(40)}\n` }), CWD, 'HEAD', 5, SIGNAL), 'a'.repeat(40));
  assert.equal(await revParse(execAnswering({ ok: false }), CWD, 'HEAD', 5, SIGNAL), null);
});

test('S45.5 — isAncestor is a boolean from the exit status: a failed call reads false, never a third shape', async () => {
  assert.equal(await isAncestor(execAnswering({ ok: true, stdout: '' }), CWD, 'a', 'b', 5, SIGNAL), true);
  assert.equal(await isAncestor(execAnswering({ ok: false }), CWD, 'a', 'b', 5, SIGNAL), false);
});

test('S45.5 — currentBranch is null on failure and on a detached HEAD', async () => {
  assert.equal(await currentBranch(execAnswering({ ok: true, stdout: 'topic\n' }), CWD, 5, SIGNAL), 'topic');
  assert.equal(await currentBranch(execAnswering({ ok: true, stdout: 'HEAD\n' }), CWD, 5, SIGNAL), null);
  assert.equal(await currentBranch(execAnswering({ ok: false }), CWD, 5, SIGNAL), null);
});

test('S45.5 — composites.ts and git-operations.ts hold no private copy of the shared primitives', () => {
  for (const file of ['../composites/composites.ts', './git-operations.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /'rev-parse', '--verify'/, `${file} runs rev-parse --verify itself`);
    assert.doesNotMatch(source, /'merge-base', '--is-ancestor'/, `${file} runs merge-base --is-ancestor itself`);
    assert.doesNotMatch(source, /'rev-parse', '--abbrev-ref', 'HEAD'/, `${file} resolves the current branch itself`);
    assert.match(source, /primitives\.ts'/, `${file} does not import the shared primitives`);
  }
});
