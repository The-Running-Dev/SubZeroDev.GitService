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

test('S11.6 — a notifier endpoint that hangs does not delay the operation that enqueued the notification', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });

    // The endpoint hangs for this long. `durationMs` proper is a field on a
    // `ToolResult`'s `Diagnostics`, which the journal does not produce — so
    // the operation's own measured elapsed time stands in for it, which is
    // the quantity the criterion is actually comparing against the delay.
    const ENDPOINT_DELAY_MS = 750;

    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 1,
      deliverFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, ENDPOINT_DELAY_MS));
        return { ok: true, status: 200 };
      },
    });

    // Delivery is in flight and hanging while the operation runs — the whole
    // point is that an operation enqueuing a notification is not behind it.
    const deliveryInFlight = notifier.deliverPending();

    const startedAt = Date.now();
    await journal.begin(beginInputFor('op-1'));
    const settled = await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);
    const operationDurationMs = Date.now() - startedAt;

    assert.equal(settled.ok, true);
    // The comparison the criterion names, made directly.
    assert.ok(
      operationDurationMs < ENDPOINT_DELAY_MS,
      `the operation took ${operationDurationMs}ms, which must be well under the endpoint's ${ENDPOINT_DELAY_MS}ms hang`,
    );

    await deliveryInFlight;
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

const MAINTENANCE_NOTIFICATION: NotificationRequest = {
  severity: 'info',
  declarationId: null,
  subject: { kind: 'maintenance-pass', releasedBytes: 0, evictedDeclarations: [], prunedByModule: [] },
  summary: 'nothing to report',
};

/** An open, migrated store — `migratedVolume` closes its own, and these tests need one live to hold a transaction. */
async function withOpenStore<T>(fn: (volume: string, store: ReturnType<typeof createStructuredStore>) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    try {
      return await fn(volume, store);
    } finally {
      await store.close();
    }
  });
}

test('enqueue writes inside the caller transaction: a committed one leaves the row', async () => {
  await withOpenStore(async (volume, store) => {
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });

    const result = await store.transaction(async (tx) => {
      notifier.enqueue(MAINTENANCE_NOTIFICATION, tx);
      return 'done';
    });
    assert.equal(result.ok, true);

    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'pending');
  });
});

test('enqueue writes inside the caller transaction: a rolled-back one leaves NO row', async () => {
  await withOpenStore(async (volume, store) => {
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });

    // The regression test for the defect this member shipped with. Opening a
    // private connection here instead of writing through `tx` made the row
    // survive this rollback — a notification for something that never
    // happened, which no later pass can tell from a real one.
    const result = await store.transaction(async (tx) => {
      notifier.enqueue(MAINTENANCE_NOTIFICATION, tx);
      throw new Error('the caller failed after enqueuing');
    });
    assert.equal(result.ok, false, 'the transaction faulted, as the test intends');

    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 0, 'the row rolled back with the caller — it must not outlive the work it describes');
  });
});

test('enqueue survives the caller having already written in the same transaction', async () => {
  await withOpenStore(async (volume, store) => {
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });

    // The realistic settle ordering, and the direction that used to lose the
    // row outright: a private connection hit SQLITE_BUSY against the write
    // lock the caller already held, and `enqueue` returns `void`, so the
    // failure was swallowed with no channel to report it.
    const result = await store.transaction(async (tx) => {
      tx.run(
        `INSERT INTO notification_outbox (id, severity, declaration_id, payload, status, attempts, last_attempt_at, last_error, created_at, delivered_at)
         VALUES ('caller-row', 'attention', NULL, '{}', 'pending', 0, NULL, NULL, ?, NULL)`,
        systemClock.now(),
      );
      notifier.enqueue(MAINTENANCE_NOTIFICATION, tx);
      return 'done';
    });
    assert.equal(result.ok, true);

    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 2, 'both the caller write and the enqueued row committed together');
  });
});
