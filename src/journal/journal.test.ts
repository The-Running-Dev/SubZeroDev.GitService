import { test } from 'node:test';
import { read } from './testing/read.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { JournalBeginInput } from './types.ts';
import { createJournal } from './journal.ts';

const ACTOR = { kind: 'mcp' as const, subject: 'sub' as never, clientId: null, grantId: null };

function beginInputFor(operationId: string, declarationId = 'repo-a'): JournalBeginInput {
  return {
    operationId: operationId as never,
    declarationId: declarationId as never,
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

test('begin writes an intended entry with the given pre-state and no steps', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const result = await journal.begin(beginInputFor('op-1'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.state, 'intended');
    assert.equal(result.value.steps.length, 0);
    assert.equal(result.value.preState.branch, 'main');
    assert.equal(result.value.tool, 'git_stage');
  });
});

test('appendStep records one applied step, in order, before markApplied moves the entry to applied', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-2'));

    const stepped = await journal.appendStep('op-2' as never, 'git_stage');
    assert.equal(stepped.ok, true);

    const applied = await journal.markApplied('op-2' as never);
    assert.equal(applied.ok, true);

    const unsettled = read(await journal.unsettled('repo-a' as never, 1 as never));
    const entry = unsettled.find((e) => e.operationId === ('op-2' as never));
    assert.ok(entry);
    assert.equal(entry!.state, 'applied');
    assert.equal(entry!.steps.length, 1);
    assert.equal(entry!.steps[0]!.name, 'git_stage');
    assert.equal(entry!.steps[0]!.state, 'applied');
  });
});

test('settle moves the entry to settled and drops it out of unsettled()', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-3'));
    await journal.appendStep('op-3' as never, 'git_stage');
    await journal.markApplied('op-3' as never);

    const settled = await journal.settle('op-3' as never, null);
    assert.equal(settled.ok, true);

    const unsettled = read(await journal.unsettled('repo-a' as never, 1 as never));
    assert.equal(
      unsettled.some((e) => e.operationId === ('op-3' as never)),
      false,
      'a settled entry is no longer unsettled',
    );

    // `journal_unsettled`'s own index guarantees this at the SQL level; a
    // direct row read is what proves `state` actually reads `settled` rather
    // than merely being absent from a query that happens to filter it out.
    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const row = db.prepare('SELECT state FROM journal_entry WHERE operation_id = ?').get('op-3') as { state: string } | undefined;
    db.close();
    assert.equal(row?.state, 'settled');
  });
});

test('settle with a notification writes the outbox row in the same call, still pending (S11 delivers nothing yet)', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-4'));
    await journal.appendStep('op-4' as never, 'git_stage');
    await journal.markApplied('op-4' as never);

    const settled = await journal.settle('op-4' as never, {
      severity: 'attention',
      declarationId: 'repo-a' as never,
      subject: { kind: 'operation-parked', operationId: 'op-4' as never, reason: 'test' },
      summary: 'test notification',
    });
    assert.equal(settled.ok, true);

    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const rows = db.prepare('SELECT status, severity FROM notification_outbox').all() as { status: string; severity: string }[];
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'pending');
    assert.equal(rows[0]!.severity, 'attention');
  });
});

test('S11.1 — a crash forced inside the settle transaction leaves NEITHER the state change nor the outbox row', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-atomic'));
    await journal.markApplied('op-atomic' as never);

    // The crash is forced *between* the two writes, which is the only window
    // the criterion cares about: the UPDATE has already run when the INSERT
    // violates `notification_outbox`'s own CHECK (severity IN
    // ('attention','info')) and throws. A severity outside the union is the
    // cheapest way to fault the second statement without faulting the first,
    // and it exercises the real ROLLBACK path rather than a mocked one.
    const settled = await journal.settle('op-atomic' as never, {
      severity: 'not-a-severity' as never,
      declarationId: 'repo-a' as never,
      subject: { kind: 'operation-parked', operationId: 'op-atomic' as never, reason: 'forced' },
      summary: 'this insert must fault after the state change has been written',
    });
    assert.equal(settled.ok, false, 'the faulted transaction is reported, not swallowed');

    // Both tables inspected, per the criterion. The forbidden state is
    // "entry settled AND row missing" — so the entry must have rolled back
    // to `applied` rather than being left `settled` with nothing to deliver.
    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const entry = db.prepare('SELECT state FROM journal_entry WHERE operation_id = ?').get('op-atomic') as { state: string } | undefined;
    const rows = db.prepare('SELECT id FROM notification_outbox').all() as { id: string }[];
    db.close();

    assert.equal(entry?.state, 'applied', 'the state change rolled back with the failed insert');
    assert.notEqual(entry?.state, 'settled', 'the forbidden state — settled with no outbox row — must not exist');
    assert.equal(rows.length, 0, 'and no partial row was left behind');
  });
});

test('park moves the entry to attention with a reason, and settling a settled entry is refused as invalid-transition', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-5'));

    const parked = await journal.park('op-5' as never, 'no descriptor registered');
    assert.equal(parked.ok, true);

    const all = read(await journal.parked());
    assert.equal(all.length, 1);
    assert.equal(all[0]!.attentionReason, 'no descriptor registered');

    await journal.settle('op-5' as never, null);
    const doubleSettle = await journal.settle('op-5' as never, null);
    assert.equal(doubleSettle.ok, false);
    if (doubleSettle.ok) return;
    assert.equal(doubleSettle.error.code, 'invalid-transition');
  });
});

test('classify: an entry with no steps is nothing-happened, even with a descriptor registered', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const begun = await journal.begin(beginInputFor('op-6'));
    assert.equal(begun.ok, true);
    if (!begun.ok) return;

    const observed = { ...begun.value.preState, observedAt: systemClock.now() };
    const descriptor = { tool: 'git_stage' as never, expectedPostState: () => true, resume: null };
    const verdict = journal.classify(begun.value, observed, descriptor);
    assert.deepEqual(verdict, { verdict: 'nothing-happened' });
  });
});

test('classify: an entry carrying an applied step never classifies nothing-happened, even when every pre-state field still matches', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-7'));
    await journal.appendStep('op-7' as never, 'git_stage');
    const unsettled = read(await journal.unsettled('repo-a' as never, 1 as never));
    const entry = unsettled.find((e) => e.operationId === ('op-7' as never))!;

    const identicalObserved = { ...entry.preState, observedAt: systemClock.now() };
    const noDescriptorVerdict = journal.classify(entry, identicalObserved, null);
    assert.equal(noDescriptorVerdict.verdict, 'park', 'no descriptor registered — parks rather than nothing-happened');

    const matchingDescriptor = { tool: entry.tool, expectedPostState: () => true, resume: null };
    const completedVerdict = journal.classify(entry, identicalObserved, matchingDescriptor);
    assert.equal(completedVerdict.verdict, 'completed');
  });
});

test('classify never throws and is total — an entry with steps, no descriptor, and a mismatched post-state parks with a reason', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-8'));
    await journal.appendStep('op-8' as never, 'git_stage');
    const unsettled = read(await journal.unsettled('repo-a' as never, 1 as never));
    const entry = unsettled.find((e) => e.operationId === ('op-8' as never))!;

    const mismatchedObserved = { ...entry.preState, headSha: 'f'.repeat(40) as never, observedAt: systemClock.now() };
    const descriptorWithNoResume = { tool: entry.tool, expectedPostState: () => false, resume: null };
    const verdict = journal.classify(entry, mismatchedObserved, descriptorWithNoResume);
    assert.equal(verdict.verdict, 'park');
    if (verdict.verdict !== 'park') return;
    assert.match(verdict.reason, /no resume step/);
  });
});

test('appendStep, markApplied, settle and park on an unknown operation return entry-not-found', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const unknown = 'no-such-op' as never;

    const results = await Promise.all([journal.appendStep(unknown, 'x'), journal.markApplied(unknown), journal.settle(unknown, null), journal.park(unknown, 'x')]);
    for (const result of results) {
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.error.code, 'entry-not-found');
    }
  });
});

test('a journal write forced to fail — an unwritable volume — returns infrastructure without throwing', async () => {
  // No migration run against this path at all: `store.sqlite` cannot be
  // opened as the schema this module expects, so every write here fails the
  // same way a real disk fault would — the same seam `clone-store.ts` and
  // `audit.ts` already rely on for the identical test.
  await withVolumeAsync(async (volume) => {
    const journal = createJournal({ volumeRoot: path.join(volume, 'does', 'not', 'exist', 'as', 'a', 'file', 'store.sqlite'), clock: systemClock });
    const result = await journal.begin(beginInputFor('op-forced-fail'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'intent-write-failed');
    assert.equal(result.error.resultKind, 'infrastructure');
  });
});

test('unsettled() is scoped to the declaration and generation pair, never crossing eras', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-9', 'repo-a'));
    await journal.begin(beginInputFor('op-10', 'repo-b'));

    const repoAUnsettled = read(await journal.unsettled('repo-a' as never, 1 as never));
    assert.equal(repoAUnsettled.length, 1);
    assert.equal(repoAUnsettled[0]!.operationId, 'op-9');

    const allUnsettled = read(await journal.allUnsettled());
    assert.equal(allUnsettled.length, 2);
  });
});

test('an unreadable store fails the four queries closed rather than reporting an empty result', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-11', 'repo-a'));
    await journal.park('op-11' as never, 'parked so a working read has something to find');

    // The store reads fine first — otherwise an empty result below would prove
    // nothing, since a journal with no rows also returns nothing.
    assert.equal(read(await journal.parked()).length, 1);
    assert.equal(read(await journal.allUnsettled()).length, 1);

    // Replacing the database with a directory makes every open fail: the same
    // observable an unreadable volume produces, without depending on file
    // permissions, which do not behave the same way across platforms.
    const store = path.join(volume, 'store.sqlite');
    rmSync(store, { force: true });
    mkdirSync(store, { recursive: true });

    for (const query of [
      journal.parked(),
      journal.allUnsettled(),
      journal.unsettled('repo-a' as never, 1 as never),
      journal.findByScheduledJob('job-1' as never),
    ]) {
      const result = await query;
      assert.equal(result.ok, false, 'an unreadable store is not an empty journal');
      if (!result.ok) assert.equal(result.error.code, 'read-failed');
    }
  });
});

test('S8.1 — classify is pure: repeat calls return identical verdicts, and it reaches the store not at all', async () => {
  await migratedVolume(async (volume) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin(beginInputFor('op-9'));
    await journal.appendStep('op-9' as never, 'git_stage');
    const entry = (read(await journal.unsettled('repo-a' as never, 1 as never))).find((e) => e.operationId === ('op-9' as never))!;
    const observed = { ...entry.preState, headSha: 'e'.repeat(40) as never, observedAt: systemClock.now() };

    // A descriptor whose answer depends only on its arguments, so any
    // difference between the two calls would be `classify`'s own.
    const descriptor = { tool: entry.tool, expectedPostState: () => false, resume: () => ({ tool: entry.tool, input: { paths: [] } }) };

    const first = journal.classify(entry, observed, descriptor);
    const second = journal.classify(entry, observed, descriptor);
    assert.deepEqual(first, second, 'the same three arguments must always yield the same verdict (invariant R3)');

    // No I/O, demonstrated rather than asserted from the source: this journal
    // is pointed at a volume that cannot be opened, so every method that does
    // reach the store fails there. `classify` returning the same verdict
    // anyway is what proves it never went.
    const unusable = createJournal({ volumeRoot: path.join(volume, 'store.sqlite', 'not-a-directory'), clock: systemClock });
    const begunOnUnusable = await unusable.begin(beginInputFor('op-10'));
    assert.equal(begunOnUnusable.ok, false, 'the fixture is only meaningful if this volume genuinely cannot be written');

    assert.deepEqual(unusable.classify(entry, observed, descriptor), first);
  });
});
