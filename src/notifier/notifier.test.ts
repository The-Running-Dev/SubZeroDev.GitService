import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createJournal } from '../journal/journal.ts';
import type { JournalBeginInput, NotificationRequest } from '../journal/types.ts';
import type { DeliveryReport } from './types.ts';
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

/** The three counts alone. `errors` is asserted separately by the tests that care what went wrong. */
function counts(report: DeliveryReport): { delivered: number; failed: number; stillPending: number } {
  return { delivered: report.delivered, failed: report.failed, stillPending: report.stillPending };
}

interface OutboxRowSnapshot {
  status: string;
  attempts: number;
  delivered_at: string | null;
  /** Included so a test can prove a pass that attempted nothing also *wrote* nothing — these are the columns a no-op pass used to stamp. */
  last_attempt_at: string | null;
  last_error: string | null;
}

function readOutboxRows(volume: string): OutboxRowSnapshot[] {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  const rows = db.prepare('SELECT status, attempts, delivered_at, last_attempt_at, last_error FROM notification_outbox ORDER BY created_at').all() as unknown as OutboxRowSnapshot[];
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
    assert.deepEqual(counts(report), { delivered: 1, failed: 0, stillPending: 0 });
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
    assert.deepEqual(counts(report), { delivered: 0, failed: 1, stillPending: 0 });
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
    assert.deepEqual(counts(report), { delivered: 0, failed: 0, stillPending: 1 });

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

test('redriveUndelivered re-attempts pending rows, and leaves failed ones for the operator rather than re-sending history', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);

    // op-1 exhausts its retries and goes `failed` — a notification that has
    // already reached a decision.
    const failing = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 1,
      deliverFn: async () => ({ ok: false, status: 503 }),
    });
    assert.deepEqual(counts(await failing.deliverPending()), { delivered: 0, failed: 1, stillPending: 0 });

    // A second, still-pending row arrives afterwards.
    await journal.begin(beginInputFor('op-2'));
    await journal.settle('op-2' as never, TERMINAL_NOTIFICATIONS[1]!);

    // Restart: a fresh instance with a healthy transport.
    let delivered = 0;
    const recovered = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      deliverFn: async () => {
        delivered += 1;
        return { ok: true, status: 200 };
      },
    });
    const redriven = await recovered.redriveUndelivered();

    // Only the pending row is sent. Re-driving the failed one would page the
    // operator with a terminal state they have already been shown and, at
    // scale, with the entire backlog at once the moment a webhook is fixed.
    assert.deepEqual(counts(redriven), { delivered: 1, failed: 0, stillPending: 0 });
    assert.equal(delivered, 1, 'exactly one POST — the failed row was not re-sent');

    const stillFailed = await recovered.listFailed();
    assert.equal(stillFailed.length, 1, 'and the failed row is still surfaced, never dropped');
  });
});

test('a delivery attempt that never responds is abandoned at the timeout rather than hanging the pass', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);

    // The endpoint accepts and then never answers — a firewall that DROPs
    // rather than refuses. Without a bound this pass never settles, and every
    // caller waiting on it waits forever.
    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 1,
      deliveryTimeoutSeconds: 1,
      deliverFn: () => new Promise(() => {}),
    });

    const startedAt = Date.now();
    const report = await notifier.deliverPending();
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 5000, `the pass returned in ${elapsedMs}ms rather than hanging`);
    assert.equal(report.failed, 1);
    assert.match(report.errors.map((e) => e.summary).join(' '), /did not respond within 1s/);
  });
});

test('concurrent passes are serialised, so a row is never selected and sent twice', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);

    let posts = 0;
    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      deliverFn: async () => {
        posts += 1;
        // Slow enough that an unserialised second pass would comfortably
        // select the same still-`pending` row.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true, status: 200 };
      },
    });

    // Exactly the shape recovery, boot and the timer produce between them.
    await Promise.all([notifier.deliverPending(), notifier.deliverPending(), notifier.redriveUndelivered()]);

    assert.equal(posts, 1, 'the row was POSTed once despite three overlapping passes');
    const rows = readOutboxRows(volume);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'delivered');
  });
});

test('with no webhook, a pass writes nothing and reports the condition once rather than once per row', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    for (const [i, notify] of TERMINAL_NOTIFICATIONS.entries()) {
      await journal.begin(beginInputFor(`op-${i}`));
      await journal.settle(`op-${i}` as never, notify);
    }

    const before = readOutboxRows(volume);
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });
    const report = await notifier.deliverPending();

    assert.equal(report.errors.length, 1, 'one error for the pass, not one per row');
    assert.equal(report.errors[0]!.code, 'no-transport-configured');
    assert.equal(report.stillPending, 3, 'and the rows are still counted');

    // Nothing was attempted, so nothing may be written — otherwise every pass
    // rewrites the whole outbox forever on a deployment with no webhook.
    const after = readOutboxRows(volume);
    assert.deepEqual(after, before, 'no row was touched');
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

test('S11.4 — all four NotifierError variants are constructible, and each is produced by a real path; counts stated', async () => {
  const produced = new Set<string>();

  // 1. no-transport-configured — a pass with no webhook set.
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);
    const report = await createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null }).deliverPending();
    for (const error of report.errors) produced.add(error.code);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]!.code, 'no-transport-configured');
  });

  // 2. delivery-failed — a non-2xx that has retries left, so the row stays pending.
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);
    const report = await createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 5,
      deliverFn: async () => ({ ok: false, status: 500 }),
      sleepFn: async () => {},
    }).deliverPending();
    for (const error of report.errors) produced.add(error.code);
    // The bound is reached inside this single call, so the terminal error is
    // `retries-exhausted`; `delivery-failed` is what it reports as the cause.
    assert.ok(report.errors.some((e) => e.code === 'retries-exhausted'));
  });

  // 3. delivery-failed WITHOUT retries-exhausted — a transport error on the
  //    first of three attempts, succeeding on the second. The row is
  //    delivered, so nothing is exhausted, and the only thing reported is the
  //    failure that happened on the way. This is the case that proves the
  //    variant is reachable on its own rather than only as a companion to
  //    exhaustion.
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);
    let attempt = 0;
    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      maxAttempts: 3,
      deliverFn: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('ECONNREFUSED');
        return { ok: true, status: 200 };
      },
      sleepFn: async () => {},
    });
    const report = await notifier.deliverPending();
    for (const error of report.errors) produced.add(error.code);

    assert.equal(report.delivered, 1, 'the row was delivered on the retry');
    assert.equal(report.errors.length, 1, 'and the one failure on the way is still reported');
    assert.equal(report.errors[0]!.code, 'delivery-failed');
    assert.ok(
      !report.errors.some((e) => e.code === 'retries-exhausted'),
      'nothing was exhausted, so delivery-failed is reachable independently',
    );
    assert.match(report.errors[0]!.summary, /ECONNREFUSED/);
  });

  // 4. row-not-found — clearing a row that is not failed.
  await migratedVolume(async (volume) => {
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });
    const cleared = await notifier.clearFailed('no-such-row' as never, ACTOR);
    assert.equal(cleared.ok, false);
    if (cleared.ok) return;
    produced.add(cleared.error.code);
  });

  const expected = ['no-transport-configured', 'delivery-failed', 'retries-exhausted', 'row-not-found'];
  assert.deepEqual([...produced].sort(), [...expected].sort(), `all ${expected.length} NotifierError variants must be reachable — produced ${produced.size}`);
});

test('S11.4 — a delivery whose status write-back fails is counted as still pending, not as delivered', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-1'));
    await journal.settle('op-1' as never, TERMINAL_NOTIFICATIONS[0]!);

    const notifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      deliverFn: async () => ({ ok: true, status: 200 }),
    });

    // The webhook accepts, then the volume goes away before the status can be
    // written back. The row is still `pending` on disk, so the next pass will
    // send it again — and a report claiming `delivered: 1` would hide the
    // duplicate the operator is about to receive.
    rmSync(path.join(volume, 'store.sqlite'), { force: true });
    mkdirSync(path.join(volume, 'store.sqlite'), { recursive: true });

    const report = await notifier.deliverPending();
    assert.equal(report.delivered, 0, 'a delivery that could not be recorded is not reported as delivered');
    assert.ok(report.errors.length > 0, 'and the reason is surfaced rather than swallowed');
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
