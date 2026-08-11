import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeclareInput, toAmendInput } from './declaration-routes.ts';

/**
 * `parseDeclareInput` and `toAmendInput`'s `fileWatcher` branches were added
 * without coverage (code review finding, 2026-08-11) — every case here
 * exercises a specific well-formed/malformed shape rather than the route's
 * other, already-tested fields.
 */

const VALID_BASE: Record<string, unknown> = {
  id: 'watch-1',
  cloneUrl: 'https://github.com/example/watch-1.git',
  host: 'github',
  credentialRef: 'unused',
  capabilityGrant: ['repo.read'],
  writablePathPrefixes: [],
  identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
};

test('parseDeclareInput accepts a well-formed fileWatcher', () => {
  const result = parseDeclareInput({ ...VALID_BASE, fileWatcher: { planTool: 'watch_plan', applyTool: 'watch_apply', autoMerge: true } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value.fileWatcher : null, { planTool: 'watch_plan', applyTool: 'watch_apply', autoMerge: true });
});

test('parseDeclareInput accepts an absent fileWatcher as null', () => {
  const result = parseDeclareInput({ ...VALID_BASE });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.fileWatcher : undefined, null);
});

test('parseDeclareInput rejects a fileWatcher missing planTool/applyTool/autoMerge', () => {
  const result = parseDeclareInput({ ...VALID_BASE, fileWatcher: { planTool: 'watch_plan' } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.findings.some((f) => f.startsWith('fileWatcher:')));
});

test('parseDeclareInput rejects a fileWatcher with a non-boolean autoMerge', () => {
  const result = parseDeclareInput({ ...VALID_BASE, fileWatcher: { planTool: 'watch_plan', applyTool: 'watch_apply', autoMerge: 'yes' } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.findings.some((f) => f.startsWith('fileWatcher:')));
});

test('toAmendInput leaves fileWatcher undefined when the key is absent (no-op patch)', () => {
  const result = toAmendInput({});
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.fileWatcher : 'missing', undefined);
});

test('toAmendInput clears fileWatcher when the key is explicitly null', () => {
  const result = toAmendInput({ fileWatcher: null });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.fileWatcher : 'missing', null);
});

test('toAmendInput accepts a well-formed fileWatcher patch', () => {
  const result = toAmendInput({ fileWatcher: { planTool: 'watch_plan', applyTool: 'watch_apply', autoMerge: false } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.value.fileWatcher : null, { planTool: 'watch_plan', applyTool: 'watch_apply', autoMerge: false });
});

test('toAmendInput rejects a malformed fileWatcher patch instead of silently dropping it', () => {
  const result = toAmendInput({ fileWatcher: { planTool: 'watch_plan', applyTool: 123, autoMerge: false } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.findings.some((f) => f.startsWith('fileWatcher:')));
});

test('toAmendInput rejects a fileWatcher patch that is not an object', () => {
  const result = toAmendInput({ fileWatcher: 'not-an-object' });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.findings.some((f) => f.startsWith('fileWatcher:')));
});
