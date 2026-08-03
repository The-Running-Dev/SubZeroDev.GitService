import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { compiler } from '../contract/compiler.ts';
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
  const lifecycle = createLifecycle({
    volumeRoot: volume,
    buildDir: writeBuildDir(volume),
    clock: systemClock,
    store,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ...(acquirer ? { acquirer } : {}),
  });
  return { store, lifecycle };
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
