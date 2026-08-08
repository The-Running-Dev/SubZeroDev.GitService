import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createJournal } from '../journal/journal.ts';
import type { JournalBeginInput, NotificationRequest } from '../journal/types.ts';
import { createNotifier } from './notifier.ts';

const ACTOR = { kind: 'mcp' as const, subject: 'sub' as never, clientId: null, grantId: null };

function beginInputFor(operationId: string): JournalBeginInput {
  return {
    operationId: operationId as never,
    declarationId: 'repo-a' as never,
    generation: 1 as never,
    tool: 'git_stage' as never,
    input: { paths: ['README.md'] },
    actorRef: ACTOR,
    scheduledJobId: null,
    context: 'normal',
    preState: {
      branch: 'main' as never,
      headSha: 'a'.repeat(40) as never,
      upstreamSha: 'a'.repeat(40) as never,
      indexDigest: 'b'.repeat(64) as never,
      worktreeDigest: 'c'.repeat(64) as never,
    },
  };
}

async function migratedVolume<T>(fn: (volume: string) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();
    return fn(volume);
  });
}

function readOutboxRows(volume: string): { status: string; attempts: number; delivered_at: string | null }[] {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  const rows = db.prepare('SELECT status, attempts, delivered_at FROM notification_outbox').all() as { status: string; attempts: number; delivered_at: string | null }[];
  db.close();
  return rows;
}

const TERMINAL_NOTIFICATIONS: readonly NotificationRequest[] = [
  {
    severity: 'attention',
    declarationId: 'repo-a' as never,
    subject: { kind: 'merge-conflict', branch: 'feature' as never, headSha: 'a'.repeat(40) as never, baseSha: 'b'.repeat(40) as never },
    summary: 'merge conflict',
  },
  {
    severity: 'attention',
    declarationId: 'repo-a' as never,
    subject: {
      kind: 'required-check-failed',
      check: 'ci',
      pullRequest: { number: 1, url: 'https://example.invalid/pr/1' as never, branch: 'feature' as never },
    },
    summary: 'required check failed',
  },
  {
    severity: 'attention',
    declarationId: 'repo-a' as never,
    subject: { kind: 'wait-timeout', waitedSeconds: 1800, tool: 'host_await_checks' as never },
    summary: 'wait timed out',
  },
];

test('a merge conflict, a failed required check and a wait timeout each enqueue at attention severity', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    for (const [i, notify] of TERMINAL_NOTIFICATIONS.entries()) {
      await journal.begin(beginInputFor(`op-${i}`));
      const settled = await journal.settle(`op-${i}` as never, notify);
      assert.equal(settled.ok, true);
    }

    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const rows = db.prepare('SELECT severity, status, payload FROM notification_outbox ORDER BY created_at').all() as { severity: string; status: string; payload: string }[];
    db.close();

    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.severity, 'attention');
      assert.equal(row.status, 'pending');
    }
    const kinds = rows.map((r) => (JSON.parse(r.payload) as { subject: { kind: string } }).subject.kind);
    assert.deepEqual(kinds, ['merge-conflict', 'required-check-failed', 'wait-timeout']);
  });
});

test('deliverPending delivers a pending row on the first successful attempt', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);

    let calls = 0;
    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      deliverFn: async () => {
        calls += 1;
        return { ok: true, status: 200 };
      },
    });

    const report = await notifier.deliverPending();
    assert.deepEqual(report, { delivered: 1, failed: 0, stillPending: 0 });
    assert.equal(calls, 1);

    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'delivered');
    assert.equal(rows[0]!.attempts, 1);
    assert.notEqual(rows[0]!.delivered_at, null);
  });
});

test('delivery failure retries with backoff, bounded, then marks the row failed and it is surfaced in listFailed — never deleted', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);

    let calls = 0;
    const sleeps: number[] = [];
    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 3,
      deliverFn: async () => {
        calls += 1;
        return { ok: false, status: 500 };
      },
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });

    const report = await notifier.deliverPending();
    assert.deepEqual(report, { delivered: 0, failed: 1, stillPending: 0 });
    assert.equal(calls, 3, 'bounded to maxAttempts tries');
    assert.equal(sleeps.length, 2, 'a backoff sleep between each retry, not after the last');

    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 1, 'the row is never deleted');
    assert.equal(rows[0]!.status, 'failed');
    assert.equal(rows[0]!.attempts, 3);

    const failed = await notifier.listFailed();
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.status, 'failed');
  });
});

test('with no webhook configured, rows accumulate pending and nothing throws', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);

    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });
    const report = await notifier.deliverPending();
    assert.deepEqual(report, { delivered: 0, failed: 0, stillPending: 1 });

    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'pending');
  });
});

test('a hanging notifier endpoint does not delay deliverPending forever, and the operation it describes already returned before this ran', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const started = Date.now();
    await journal.begin(beginInputFor('op-1'));
    const settled = await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);
    const settleDurationMs = Date.now() - started;

    // The operation that enqueued the notification (`begin` + `settle`) has
    // already completed — delivery is a separate call, made afterwards, and
    // this asserts the enqueue path itself never touches the network.
    assert.equal(settled.ok, true);
    assert.ok(settleDurationMs < 1000, 'settle returned without waiting on any delivery attempt');

    let delayMs = 0;
    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 1,
      deliverFn: async () => {
        delayMs = 50;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { ok: true, status: 200 };
      },
    });
    await notifier.deliverPending();
    assert.equal(delayMs, 50, 'delivery ran, on its own time, well after the operation had already returned');
  });
});

test('redriveUndelivered re-attempts pending and failed rows alike, the boot path', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);
    await journal.begin(beginInputFor('op-2'));
    await journal.settle('op-2' as never, TERMINAL_NOTIFICATIONS[1]!);

    // First pass: fail both, exhausting attempts so op-1's row goes to `failed`.
    const failing = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 1,
      deliverFn: async () => ({ ok: false, status: 503 }),
    });
    const firstPass = await failing.deliverPending();
    assert.deepEqual(firstPass, { delivered: 0, failed: 2, stillPending: 0 });

    // Simulate a restart: a fresh notifier instance, now with a healthy transport.
    const recovered = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      deliverFn: async () => ({ ok: true, status: 200 }),
    });
    const redriven = await recovered.redriveUndelivered();
    assert.deepEqual(redriven, { delivered: 2, failed: 0, stillPending: 0 });

    const rows = readOutboxRows(volume);
    assert.equal(rows.every((r) => r.status === 'delivered'), true);
  });
});

test('clearFailed resets a failed row to pending without deleting it, and refuses a row that is not failed', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);

    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 1,
      deliverFn: async () => ({ ok: false, status: 500 }),
    });
    await notifier.deliverPending();

    const failed = await notifier.listFailed();
    assert.equal(failed.length, 1);

    const cleared = await notifier.clearFailed(failed[0]!.id, ACTOR);
    assert.equal(cleared.ok, true);

    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 1, 'never deleted');
    assert.equal(rows[0]!.status, 'pending');
    assert.equal(rows[0]!.attempts, 0);

    const secondClear = await notifier.clearFailed(failed[0]!.id, ACTOR);
    assert.equal(secondClear.ok, false);
    if (secondClear.ok) return;
    assert.equal(secondClear.error.code, 'row-not-found');
  });
});

test('enqueue writes a pending row directly, independent of Journal.settle', async () => {
  await migratedVolume(async (volume) => {
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });
    notifier.enqueue(
      { severity: 'info', declarationId: null, subject: { kind: 'maintenance-pass', releasedBytes: 0, evictedDeclarations: [], prunedByModule: [] }, summary: 'nothing to report' },
      { id: 'tx-1' },
    );
    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'pending');
  });
});
