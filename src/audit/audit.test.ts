import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, truncateSync, statSync, rmSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../clock/clock.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { createAudit } from './audit.ts';
import { computeAuditRecordHash } from './hash.ts';
import type { AuditAppendInput } from './types.ts';
import type { ActorRef } from '../shared/actor.ts';

const ACTOR: ActorRef = { kind: 'recovery', subject: 'system' as never, clientId: null, grantId: null };

function leaseTakeoverInput(overrides: Partial<AuditAppendInput> = {}): AuditAppendInput {
  return {
    at: systemClock.now(),
    operationId: null,
    declarationId: null,
    generation: null,
    tool: null,
    actorRef: ACTOR,
    context: 'recovery',
    form: 'lease-takeover',
    previousHolder: {
      instanceId: 'prev-instance',
      bootId: 'prev-boot',
      hostName: 'prev-host',
      startedAt: '2026-01-01T00:00:00.000Z' as never,
    },
    ...overrides,
  } as AuditAppendInput;
}

function listSegmentFiles(volume: string): readonly string[] {
  const dir = path.join(volume, 'audit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name));
}

async function migratedVolume(volume: string): Promise<void> {
  const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();
}

test('S3.2 — appending N records produces N JSONL lines with contiguous sequence, chained hashes, and a matching audit_chain_head', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });

    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(await audit.append(leaseTakeoverInput()));
    }

    for (const [i, outcome] of outcomes.entries()) {
      assert.equal(outcome.appended, true);
      if (!outcome.appended) return;
      assert.equal(outcome.sequence, i + 1, 'sequence is contiguous starting at 1');
    }

    const state = await audit.verify();
    assert.equal(state.chainBreak, null);
    assert.equal(state.verifiedThrough, 5);
    assert.equal(state.headHash, state.mirroredHeadHash, 'audit_chain_head matches the last line\'s hash');
    assert.match(state.headHash ?? '', /^[0-9a-f]{64}$/);

    const lines = readFileSync(path.join(volume, 'audit', '000001.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5, 'five JSONL lines');
    const records = lines.map((l) => JSON.parse(l));
    for (let i = 1; i < records.length; i += 1) {
      assert.equal(records[i].previousHash, records[i - 1].hash, `record ${i} chains to record ${i - 1}`);
    }
    assert.equal(records[0].previousHash, null, 'genesis record has no predecessor');
  });
});

test('S3.3 — 500 concurrent appends produce 500 lines, no duplicate sequence, and a chain that verifies', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });

    const outcomes = await Promise.all(Array.from({ length: 500 }, () => audit.append(leaseTakeoverInput())));

    const sequences = outcomes.map((o) => (o.appended ? o.sequence : -1));
    assert.equal(sequences.every((s) => s > 0), true, 'every append succeeded');
    const unique = new Set(sequences);
    assert.equal(unique.size, 500, 'no duplicate sequence numbers under overlap');
    assert.deepEqual([...unique].sort((a, b) => a - b), Array.from({ length: 500 }, (_, i) => i + 1));

    const state = await audit.verify();
    assert.equal(state.chainBreak, null, 'the chain verifies under concurrent overlap');
    assert.equal(state.verifiedThrough, 500);
  });
});

test('S26.1 — retention anchors an aged closed segment before deleting it, and verification still detects a later break', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock, segmentBytes: 350 });
    for (let index = 0; index < 8; index += 1) await audit.append(leaseTakeoverInput());

    const first = path.join(volume, 'audit', '000001.jsonl');
    utimesSync(first, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    const report = await audit.runRetention();
    assert.equal(existsSync(first), false, 'the aged closed segment is removed');
    assert.equal(report.deletedRows, 1);

    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const anchors = db.prepare('SELECT segment FROM audit_retained_anchor').all() as { segment: number }[];
    db.close();
    assert.deepEqual(anchors.map((anchor) => anchor.segment), [1], 'the terminal hash is committed as an anchor first');

    const second = path.join(volume, 'audit', '000002.jsonl');
    const lines = readFileSync(second, 'utf8').trim().split('\n');
    lines[0] = lines[0]!.replace('lease-takeover', 'tampered');
    writeFileSync(second, `${lines.join('\n')}\n`, 'utf8');
    assert.notEqual((await audit.verify()).chainBreak, null, 'verification resumes from the anchor and still detects a later break');
  });
});

test('S3.4 — deleting one line from the middle of a segment makes verify report an AuditChainBreak naming sequence, expected and found hash', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    for (let i = 0; i < 5; i += 1) await audit.append(leaseTakeoverInput());

    const segPath = path.join(volume, 'audit', '000001.jsonl');
    const lines = readFileSync(segPath, 'utf8').trim().split('\n');
    lines.splice(2, 1); // delete the middle (originally sequence 3)
    writeFileSync(segPath, `${lines.join('\n')}\n`, 'utf8');

    const state = await audit.verify();
    assert.notEqual(state.chainBreak, null);
    assert.equal(state.chainBreak?.atSequence, 4, 'the record after the gap is where the break surfaces');
    assert.match(state.chainBreak?.expectedHash ?? '', /^[0-9a-f]{64}$/);
    assert.match(state.chainBreak?.foundHash ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(state.chainBreak?.expectedHash, state.chainBreak?.foundHash);
  });
});

test('S3.5 — truncating the file produces an AuditChainBreak', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    for (let i = 0; i < 5; i += 1) await audit.append(leaseTakeoverInput());

    const segPath = path.join(volume, 'audit', '000001.jsonl');
    const size = statSync(segPath).size;
    truncateSync(segPath, Math.floor(size * 0.6)); // cut mid-file, likely mid-line

    const state = await audit.verify();
    assert.notEqual(state.chainBreak, null, 'truncation is reported as a break');
  });
});

test('S3.5 — editing one field of one line produces an AuditChainBreak', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    for (let i = 0; i < 3; i += 1) await audit.append(leaseTakeoverInput());

    const segPath = path.join(volume, 'audit', '000001.jsonl');
    const lines = readFileSync(segPath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[1]!);
    tampered.context = 'hatch'; // edit a field, leave the stored hash untouched
    lines[1] = JSON.stringify(tampered);
    writeFileSync(segPath, `${lines.join('\n')}\n`, 'utf8');

    const state = await audit.verify();
    assert.notEqual(state.chainBreak, null);
    assert.equal(state.chainBreak?.atSequence, 2, 'the edited record itself is where the break is reported');
  });
});

test('S3.6 — rotation at auditSegmentBytes opens a new segment beginning with the previous segment\'s terminal hash, and verify spans the boundary', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    // A tiny cap forces rotation after roughly one record per segment.
    const audit = createAudit({ volumeRoot: volume, clock: systemClock, segmentBytes: 200 });
    for (let i = 0; i < 6; i += 1) {
      const outcome = await audit.append(leaseTakeoverInput());
      assert.equal(outcome.appended, true);
    }

    const seg1 = JSON.parse(readFileSync(path.join(volume, 'audit', '000001.jsonl'), 'utf8').trim().split('\n')[0]!);
    const seg2Lines = readFileSync(path.join(volume, 'audit', '000002.jsonl'), 'utf8').trim().split('\n');
    assert.ok(seg2Lines.length >= 1, 'rotation actually produced a second segment');
    const firstOfSeg2 = JSON.parse(seg2Lines[0]!);
    assert.equal(firstOfSeg2.previousHash, seg1.hash, 'the new segment opens chained to the previous terminal hash');

    const state = await audit.verify();
    assert.equal(state.chainBreak, null, 'verify spans the segment boundary cleanly');
    assert.equal(state.verifiedThrough, 6);
  });
});

test('S3.7 — append returns {appended:false} rather than throwing when the write fails, and the calling path completes', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    // Pre-create a FILE where the audit module expects a directory, so any
    // attempt to write a segment inside it fails deterministically and
    // portably (a chmod-based simulation would not reliably block writes on
    // Windows, which this was verified against).
    writeFileSync(path.join(volume, 'audit'), 'not a directory', 'utf8');

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const outcome = await audit.append(leaseTakeoverInput());

    assert.equal(outcome.appended, false, 'the failure is reported, not thrown');
    if (outcome.appended) return;
    assert.ok(['write-failed', 'volume-full', 'segment-rotation-failed'].includes(outcome.reason));
  });
});

test('S3.8 — a lease-takeover record names the previous holder', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const outcome = await audit.append(leaseTakeoverInput());
    assert.equal(outcome.appended, true);
    if (!outcome.appended) return;

    const lines = readFileSync(path.join(volume, 'audit', '000001.jsonl'), 'utf8').trim().split('\n');
    const record = JSON.parse(lines[0]!);
    assert.equal(record.form, 'lease-takeover');
    assert.equal(record.previousHolder.instanceId, 'prev-instance');
  });
});

test('verify() on a never-appended log is verified-empty, not "never verified"', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const state = await audit.verify();
    assert.equal(state.chainBreak, null);
    assert.equal(state.verifiedThrough, 0);
    assert.equal(state.headHash, null);
  });
});

test('the trail survives corruption of the structured store: verify() and append() both keep working', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const first = createAudit({ volumeRoot: volume, clock: systemClock });
    await first.append(leaseTakeoverInput());
    await first.append(leaseTakeoverInput());

    // The audit log lives outside the structured store precisely so it can
    // outlive it. Corrupt the store, leave the segments untouched.
    writeFileSync(path.join(volume, 'store.sqlite'), 'not a database at all', 'utf8');

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });

    const state = await audit.verify();
    assert.equal(state.chainBreak, null, 'a corrupt store is not a chain break');
    assert.equal(state.verifiedThrough, 2, 'the head is re-derived from the segment files');
    assert.equal(state.mirroredHeadHash, null, 'the mirror is unreadable, and says so rather than throwing');

    const appended = await audit.append(leaseTakeoverInput());
    assert.equal(appended.appended, true, 'the trail can still be written to');
    if (!appended.appended) return;
    assert.equal(appended.sequence, 3, 'and continues the sequence from the files');

    const after = await audit.verify();
    assert.equal(after.chainBreak, null, 'the chain written without the mirror still verifies');
    assert.equal(after.verifiedThrough, 3);
  });
});

test('verify() reports rather than throws when the audit directory itself is unreadable', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    // A file where the segment directory belongs: nothing is readable at all.
    writeFileSync(path.join(volume, 'audit'), 'not a directory', 'utf8');

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const state = await audit.verify();
    assert.notEqual(state.chainBreak, null, 'an unverifiable trail is reported as a break');
    assert.equal(state.verifiedThrough, null);
  });
});

test('verify() resumes from a RetainedAnchor when early segments have been pruned', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock, segmentBytes: 200 });
    for (let i = 0; i < 6; i += 1) await audit.append(leaseTakeoverInput());

    // Simulate what S17's retention will do: record the terminal hash of
    // segment 1 as an anchor (invariant S2 requires this *before* deletion),
    // then delete the segment.
    const seg1Path = path.join(volume, 'audit', '000001.jsonl');
    const seg1Lines = readFileSync(seg1Path, 'utf8').trim().split('\n');
    const terminal = JSON.parse(seg1Lines[seg1Lines.length - 1]!) as { sequence: number; hash: string };

    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    db.prepare(
      'INSERT INTO audit_retained_anchor (segment, terminal_sequence, terminal_hash, retained_at) VALUES (?, ?, ?, ?)',
    ).run(1, terminal.sequence, terminal.hash, systemClock.now());
    db.close();
    rmSync(seg1Path);

    const state = await audit.verify();
    assert.equal(state.chainBreak, null, 'a pruned prefix is not a chain break when its anchor is present');
    assert.equal(state.verifiedThrough, 6, 'verification resumes from the anchor and reaches the head');
    assert.equal(state.retainedAnchors.length, 1, 'the anchors are reported');
    assert.equal(state.retainedAnchors[0]?.segment, 1);
  });
});

test('verify() still reports a break when a prefix is pruned WITHOUT an anchor', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock, segmentBytes: 200 });
    for (let i = 0; i < 6; i += 1) await audit.append(leaseTakeoverInput());

    // Deleting a segment without first writing its anchor violates invariant
    // S2, and must not be mistaken for a legitimately retained trail.
    rmSync(path.join(volume, 'audit', '000001.jsonl'));

    const state = await audit.verify();
    assert.notEqual(state.chainBreak, null, 'an unanchored gap is still a break');
  });
});

test('a stale chain-head mirror never causes a duplicate sequence: the files decide', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const first = createAudit({ volumeRoot: volume, clock: systemClock });
    for (let i = 0; i < 3; i += 1) await first.append(leaseTakeoverInput());
    await first.close();

    // Simulate swallowed mirror writes: the row falls behind the durable
    // JSONL. A mirror write can fail after the file append has already
    // succeeded, and that failure is deliberately not fatal to the append.
    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    db.prepare('UPDATE audit_chain_head SET sequence = 1').run();
    db.close();

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const appended = await audit.append(leaseTakeoverInput());
    assert.equal(appended.appended, true);
    if (!appended.appended) return;
    assert.equal(appended.sequence, 4, 'the next sequence continues from the files, not the stale mirror');

    const sequences = readFileSync(path.join(volume, 'audit', '000001.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { sequence: number }).sequence);
    assert.deepEqual(sequences, [1, 2, 3, 4], 'no duplicate sequence number on disk');
    assert.equal((await audit.verify()).chainBreak, null);
    await audit.close();
  });
});

test('verify() reports a duplicate sequence number even when hash linkage is intact (invariant S1)', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    for (let i = 0; i < 3; i += 1) await audit.append(leaseTakeoverInput());

    // Forge a fourth record that chains correctly by hash but reuses
    // sequence 2 — what a stale-mirror append used to produce. Hash linkage
    // alone reads as healthy, so contiguity has to be checked in its own right.
    const segPath = path.join(volume, 'audit', '000001.jsonl');
    const lines = readFileSync(segPath, 'utf8').trim().split('\n');
    const third = JSON.parse(lines[2]!) as { hash: string };
    const forged = JSON.parse(lines[1]!) as Record<string, unknown>;
    forged.previousHash = third.hash;
    delete forged.hash;
    forged.hash = computeAuditRecordHash(forged as never);
    writeFileSync(segPath, `${[...lines, JSON.stringify(forged)].join('\n')}\n`, 'utf8');

    const state = await audit.verify();
    assert.notEqual(state.chainBreak, null, 'a reused sequence number is a chain break');
    assert.equal(state.chainBreak?.atSequence, 2);
    await audit.close();
  });
});

test('close() releases the mirror handle and the module still works afterwards', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    await audit.append(leaseTakeoverInput());
    await audit.close();

    // A deliberate close is not evidence the store is broken, so the lazy
    // handle re-opens rather than latching into an unavailable state.
    const appended = await audit.append(leaseTakeoverInput());
    assert.equal(appended.appended, true);
    if (!appended.appended) return;
    assert.equal(appended.sequence, 2);
    assert.equal((await audit.verify()).chainBreak, null);
    await audit.close();
  });
});

test('query() filters by form and paginates by cursor', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    for (let i = 0; i < 3; i += 1) await audit.append(leaseTakeoverInput());

    const page1 = await audit.query({
      declarationId: null,
      tool: null,
      actorSubject: null,
      form: 'lease-takeover',
      from: null,
      to: null,
      limit: 2,
      cursor: null,
    });
    assert.equal(page1.ok, true);
    if (!page1.ok) return;
    assert.equal(page1.value.records.length, 2);
    assert.equal(page1.value.nextCursor, '2');

    const page2 = await audit.query({
      declarationId: null,
      tool: null,
      actorSubject: null,
      form: 'lease-takeover',
      from: null,
      to: null,
      limit: 2,
      cursor: page1.value.nextCursor,
    });
    assert.equal(page2.ok, true);
    if (!page2.ok) return;
    assert.equal(page2.value.records.length, 1);
    assert.equal(page2.value.nextCursor, null, 'no more pages');
  });
});

test('2026-08-13 post-S27 reconciliation — usageBytes reports the real segment-directory total, growing with each append and rotation', async () => {
  await withVolumeAsync(async (volume) => {
    await migratedVolume(volume);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock, segmentBytes: 350 });

    assert.equal(await audit.usageBytes(), 0, 'nothing appended yet');

    for (let i = 0; i < 10; i += 1) {
      const outcome = await audit.append(leaseTakeoverInput());
      assert.equal(outcome.appended, true);
    }

    const segments = listSegmentFiles(volume);
    assert.ok(segments.length >= 2, 'small segmentBytes rotated across at least two files');
    const expected = segments.reduce((sum, file) => sum + statSync(file).size, 0);
    assert.equal(await audit.usageBytes(), expected, 'usageBytes matches the real total across every segment file');
    assert.ok(expected > 0);
  });
});
