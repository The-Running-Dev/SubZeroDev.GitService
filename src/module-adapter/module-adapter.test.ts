import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModuleTargetName } from '../shared/brands.ts';
import { success } from '../result/envelope.ts';
import { createModuleAdapter } from './module-adapter.ts';

const CTX = {
  operationId: 'op-1' as never,
  declarationId: null,
  generation: null,
  cloneRoot: null,
  actorRef: { kind: 'mcp' as const, subject: 'sub' as never, clientId: null, grantId: null },
  capabilities: new Set() as never,
  writablePathPrefixes: [],
  context: 'normal' as const,
  scheduledJobId: null,
  deadline: '2026-01-01T00:00:00.000Z' as never,
  signal: new AbortController().signal,
};

test('register then invoke reaches the registered handler', async () => {
  const adapter = createModuleAdapter();
  let entered = false;
  const registered = adapter.register('git.status' as ModuleTargetName, async () => {
    entered = true;
    return success('ok', { x: 1 }, { operationId: null, declarationId: null, generation: null, durationMs: 0 });
  });
  assert.equal(registered.ok, true);

  const result = await adapter.invoke('git.status' as ModuleTargetName, CTX, {});
  assert.equal(entered, true);
  assert.equal(result.ok, true);
});

test('invoking an unregistered target returns infrastructure and reaches no handler', async () => {
  const adapter = createModuleAdapter();
  const result = await adapter.invoke('git.nonexistent' as ModuleTargetName, CTX, {});
  assert.equal(result.kind, 'infrastructure');
});

test('registering the same target twice is a duplicate-registration fault', () => {
  const adapter = createModuleAdapter();
  const first = adapter.register('git.status' as ModuleTargetName, async () => success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 }));
  const second = adapter.register('git.status' as ModuleTargetName, async () => success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error.code, 'duplicate-registration');
});

test('registeredTargets reports every registered target name', () => {
  const adapter = createModuleAdapter();
  adapter.register('git.status' as ModuleTargetName, async () => success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 }));
  adapter.register('git.log' as ModuleTargetName, async () => success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 }));
  const targets = adapter.registeredTargets();
  assert.equal(targets.size, 2);
  assert.ok(targets.has('git.status' as ModuleTargetName));
  assert.ok(targets.has('git.log' as ModuleTargetName));
});
