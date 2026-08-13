import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLocks } from './locks.ts';
import type { LockHolder } from './types.ts';

function holder(): LockHolder {
  return {
    operationId: randomUUID() as never,
    declarationId: 'repo-a' as never,
    tool: 'noop' as never,
    heldSince: new Date().toISOString() as never,
  };
}

test('2026-08-13 post-S27 reconciliation — mutationQueueDepth refuses a waiter beyond the bound, rather than queueing it unbounded', async () => {
  const locks = createLocks({ mutationQueueDepth: 2, concurrentWaitsPerSession: 4, concurrentLockFreeOperations: 16 });
  const signal = new AbortController().signal;

  // The first acquisition takes the lock outright — nothing queues yet.
  const held = await locks.acquireMutation(holder(), 5000, signal);
  assert.equal(held.ok, true);

  // Two waiters fill the queue to its 2-deep limit.
  const waiterA = locks.acquireMutation(holder(), 5000, signal);
  const waiterB = locks.acquireMutation(holder(), 5000, signal);

  // A third waiter arrives while the queue is already at its limit and is
  // refused immediately — it is never enqueued.
  const refused = await locks.acquireMutation(holder(), 5000, signal);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, 'queue-full');
    assert.equal(refused.error.resultKind, 'conflict');
  }

  if (held.ok) held.value.release();
  const settledA = await waiterA;
  assert.equal(settledA.ok, true);
  if (settledA.ok) settledA.value.release();
  const settledB = await waiterB;
  assert.equal(settledB.ok, true);
  if (settledB.ok) settledB.value.release();
});

test('2026-08-13 post-S27 reconciliation — mutationQueueDepth bounds a per-declaration materialisation queue the same way', async () => {
  const locks = createLocks({ mutationQueueDepth: 1, concurrentWaitsPerSession: 4, concurrentLockFreeOperations: 16 });
  const signal = new AbortController().signal;

  const held = await locks.acquireMaterialisation('repo-a' as never, holder(), 5000, signal);
  assert.equal(held.ok, true);

  const waiter = locks.acquireMaterialisation('repo-a' as never, holder(), 5000, signal);
  const refused = await locks.acquireMaterialisation('repo-a' as never, holder(), 5000, signal);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.code, 'queue-full');

  // A different declaration's queue is unaffected — the bound is per mutex,
  // not process-wide.
  const otherHeld = await locks.acquireMaterialisation('repo-b' as never, holder(), 5000, signal);
  assert.equal(otherHeld.ok, true);

  if (held.ok) held.value.release();
  const settled = await waiter;
  assert.equal(settled.ok, true);
  if (settled.ok) settled.value.release();
  if (otherHeld.ok) otherHeld.value.release();
});

test('an acquisition against a free lock is never refused for queue depth, even at mutationQueueDepth 0', async () => {
  const locks = createLocks({ mutationQueueDepth: 0, concurrentWaitsPerSession: 4, concurrentLockFreeOperations: 16 });
  const signal = new AbortController().signal;

  const first = await locks.acquireMutation(holder(), 5000, signal);
  assert.equal(first.ok, true);
  if (first.ok) first.value.release();

  const second = await locks.acquireMutation(holder(), 5000, signal);
  assert.equal(second.ok, true, 'the lock was free, so this acquisition never touches the queue at all');
  if (second.ok) second.value.release();
});
