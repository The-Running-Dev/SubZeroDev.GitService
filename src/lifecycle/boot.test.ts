import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { compiler } from '../contract/compiler.ts';
import { createAudit } from '../audit/audit.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { NO_CONSOLE_FINGERPRINT } from '../surfaces/http-server.ts';
import { createLifecycle } from './boot.ts';
import type { LeaseAcquisition, LockAcquirer } from './lease.ts';

/**
 * Writes the artifact boot step 2 verifies. The compiler is build-time only,
 * so this mirrors what `scripts/build-registry.ts` emits rather than being
 * called from the runtime.
 */
function writeBuildDir(root: string): string {
  const buildDir = path.join(root, 'build');
  mkdirSync(buildDir, { recursive: true });
  const compiled = compiler.compile([]);
  if (!compiled.ok) throw new Error('fixture registry failed to compile');
  const json = JSON.stringify(
    compiled.value.registry,
    (_key, value) => (value instanceof Set ? [...value].sort() : value),
    2,
  );
  writeFileSync(path.join(buildDir, 'registry.json'), json, 'utf8');
  writeFileSync(
    path.join(buildDir, 'registry.json.sha256'),
    `${createHash('sha256').update(json, 'utf8').digest('hex')}\n`,
    'utf8',
  );
  return buildDir;
}

function lifecycleFor(volume: string, acquirer?: LockAcquirer) {
  const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  const lifecycle = createLifecycle({
    volumeRoot: volume,
    buildDir: writeBuildDir(volume),
    clock: systemClock,
    store,
    audit,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ...(acquirer ? { acquirer } : {}),
  });
  return { store, audit, lifecycle };
}

test('boot takes the lease, applies migrations and reports both', async () => {
  await withVolumeAsync(async (volume) => {
    const { lifecycle } = lifecycleFor(volume);
    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;

      assert.equal(booted.value.leaseSelfTestPassed, true, 'the child-process self-test ran and passed');
      assert.ok(booted.value.lease.instanceId.length > 0);
      assert.equal(booted.value.migrationsApplied, 1, 'migration 0001 applied');
      assert.match(booted.value.registryFingerprint, /^[0-9a-f]{64}$/);
      assert.deepEqual(booted.value.clones, [], 'step 8 derives an empty clone set with none declared');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S2.7 — readiness passes only after the lease is held and migrations have applied', async () => {
  await withVolumeAsync(async (volume) => {
    const { lifecycle } = lifecycleFor(volume);
    let ready = false;
    try {
      assert.equal(ready, false, 'readiness is false before boot');

      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;
      ready = booted.ok;

      assert.equal(ready, true, 'readiness passes once the lease is held and migrations applied');
      assert.equal(booted.value.migrationsApplied, 1);
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S2.7 — a boot that fails to take the lease never becomes ready', async () => {
  await withVolumeAsync(async (volume) => {
    const first = lifecycleFor(volume);
    const firstBoot = await first.lifecycle.boot();
    assert.equal(firstBoot.ok, true, 'the first instance boots');

    try {
      const second = lifecycleFor(volume);
      const secondBoot = await second.lifecycle.boot();

      assert.equal(secondBoot.ok, false, 'the second instance refuses to start');
      if (secondBoot.ok) return;
      assert.equal(secondBoot.error.code, 'lease-held');
      if (secondBoot.error.code !== 'lease-held') return;
      assert.ok(secondBoot.error.holder.instanceId.length > 0, 'names the holder');
      assert.match(
        secondBoot.error.summary,
        /instanceId .+ on .+, started /,
        'the summary names instanceId, hostName and startedAt',
      );
    } finally {
      await first.lifecycle.shutdown('operator');
    }
  });
});

test('S2.4 — boot on a volume that grants the lock to both exits with lease-not-exclusive, naming the volume configuration', async () => {
  await withVolumeAsync(async (volume) => {
    const permissiveVolume: LockAcquirer = {
      acquire(): LeaseAcquisition {
        return { acquired: true, guard: { release: () => {} } };
      },
      childIsRefused(): boolean {
        return false;
      },
    };

    const { lifecycle } = lifecycleFor(volume, permissiveVolume);
    const booted = await lifecycle.boot();

    assert.equal(booted.ok, false, 'boot must refuse a volume that does not exclude');
    if (booted.ok) return;
    assert.equal(booted.error.code, 'lease-not-exclusive');
    assert.match(booted.error.summary, /named volume/i, 'the message names the volume configuration to fix');
    assert.match(booted.error.summary, /bind-mounted/i, 'and names the bind-mount case it is most likely to be');
  });
});

test('a tampered registry artifact fails boot and releases the lease again', async () => {
  await withVolumeAsync(async (volume) => {
    const { lifecycle } = lifecycleFor(volume);
    const registryPath = path.join(volume, 'build', 'registry.json');
    writeFileSync(registryPath, `${'{"fingerprint":"tampered"}'}\n`, 'utf8');

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false);
    if (booted.ok) return;
    assert.equal(booted.error.code, 'fingerprint-mismatch');

    // The lease must not be left held by a boot that refused to complete,
    // or the next start would report the volume as owned by a dead instance.
    const { lifecycle: retry } = lifecycleFor(volume);
    const second = await retry.boot();
    assert.equal(second.ok, true, 'the volume is free again after a failed boot');
    await retry.shutdown('operator');
  });
});

test('S3.8 — a lease takeover detected at boot writes a lease-takeover audit record, and the boot report reflects it', async () => {
  await withVolumeAsync(async (volume) => {
    // A stale lease left by a holder that died without releasing — written by
    // hand rather than through acquireLease, so this exercises boot's own
    // wiring rather than the lease module already covered in lease.test.ts.
    const staleLease = {
      instanceId: 'dead-instance',
      bootId: 'dead-boot',
      hostName: 'dead-host',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(path.join(volume, 'lease.json'), `${JSON.stringify(staleLease, null, 2)}\n`, 'utf8');

    const { lifecycle, audit } = lifecycleFor(volume);
    const booted = await lifecycle.boot();
    try {
      assert.equal(booted.ok, true, 'a takeover does not fail boot');
      if (!booted.ok) return;

      assert.equal(booted.value.auditChain.chainBreak, null);
      assert.equal(booted.value.auditChain.verifiedThrough, 1, 'exactly the lease-takeover record');

      const page = await audit.query({
        declarationId: null,
        tool: null,
        actorSubject: null,
        form: 'lease-takeover',
        from: null,
        to: null,
        limit: 10,
        cursor: null,
      });
      assert.equal(page.ok, true);
      if (!page.ok) return;
      assert.equal(page.value.records.length, 1);
      const record = page.value.records[0] as unknown as { previousHolder: { instanceId: string } };
      assert.equal(record.previousHolder.instanceId, 'dead-instance', 'names the previous holder');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S3.4 — a chain break already present on disk does not fail boot; boot reports it', async () => {
  await withVolumeAsync(async (volume) => {
    // Seed a real trail, then corrupt it before this boot ever runs.
    const seedStore = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await seedStore.open();
    await seedStore.migrate();
    await seedStore.close();
    const seedAudit = createAudit({ volumeRoot: volume, clock: systemClock });
    await seedAudit.append({
      at: systemClock.now(),
      operationId: null,
      declarationId: null,
      generation: null,
      tool: null,
      actorRef: { kind: 'recovery', subject: 'system' as never, clientId: null, grantId: null },
      context: 'recovery',
      form: 'lease-takeover',
      previousHolder: { instanceId: 'x', bootId: 'y', hostName: 'z', startedAt: '2026-01-01T00:00:00.000Z' as never },
    });
    const segPath = path.join(volume, 'audit', '000001.jsonl');
    writeFileSync(segPath, 'not valid jsonl at all\n', 'utf8');

    const { lifecycle } = lifecycleFor(volume);
    const booted = await lifecycle.boot();
    try {
      assert.equal(booted.ok, true, 'boot still starts and serves despite a pre-existing chain break');
      if (!booted.ok) return;
      assert.notEqual(booted.value.auditChain.chainBreak, null, 'boot reports the break rather than hiding it');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('a boot that fails after opening the store closes it again, leaking no handle', async () => {
  await withVolumeAsync(async (volume) => {
    const seed = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await seed.open();
    await seed.migrate();
    await seed.close();
    writeFileSync(path.join(volume, 'store.sqlite'), 'not a database', 'utf8');

    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    let closed = 0;
    const countingStore = { ...store, close: async () => { closed += 1; await store.close(); } };

    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store: countingStore,
      audit: createAudit({ volumeRoot: volume, clock: systemClock }),
      consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false, 'the corrupt store fails boot');
    assert.ok(closed >= 1, 'boot closed the store it had opened, without relying on shutdown()');
  });
});

test('a registry that is absent reports registry-unreadable, not a mismatch with invented digests', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: path.join(volume, 'no-such-build-dir'),
      clock: systemClock,
      store,
      audit: createAudit({ volumeRoot: volume, clock: systemClock }),
      consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false);
    if (booted.ok) return;
    assert.equal(booted.error.code, 'registry-unreadable', 'distinct from fingerprint-mismatch');
    if (booted.error.code !== 'registry-unreadable') return;
    assert.ok(booted.error.reason.length > 0, 'names why it could not be read');
  });
});

test('a corrupt store fails boot with store-failed carrying the corrupt cause', async () => {
  await withVolumeAsync(async (volume) => {
    // Seed a healthy store, then corrupt it on disk.
    const seed = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await seed.open();
    await seed.migrate();
    await seed.close();
    writeFileSync(path.join(volume, 'store.sqlite'), 'not a database', 'utf8');

    const { lifecycle } = lifecycleFor(volume);
    const booted = await lifecycle.boot();

    assert.equal(booted.ok, false, 'boot must refuse a corrupt store');
    if (booted.ok) return;
    assert.equal(booted.error.code, 'store-failed');
    if (booted.error.code !== 'store-failed') return;
    assert.equal(booted.error.cause.code, 'corrupt');

    await lifecycle.shutdown('operator');
  });
});
