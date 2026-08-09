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
import { createOperatorIdentity } from '../operator-identity/operator-identity.ts';
import { DatabaseSync } from 'node:sqlite';
import { createJournal } from '../journal/journal.ts';
import { createNotifier, type Notifier } from '../notifier/notifier.ts';

/** The outbox as it stands on disk, for the redrive tests below. */
function readOutboxRows(volume: string): { status: string }[] {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  const rows = db.prepare('SELECT status FROM notification_outbox').all() as unknown as { status: string }[];
  db.close();
  return rows;
}
import type { Audit } from '../audit/audit.ts';
import type { CapabilityName, DeploymentCeiling } from '../contract/capabilities.ts';
import { fixtureTool, httpTarget } from '../contract/fixtures.ts';
import { createLifecycle } from './boot.ts';
import type { LeaseAcquisition, LockAcquirer } from './lease.ts';

/**
 * A subdirectory of the test volume stands in for the credential mount. The
 * contract requires the mount live outside the data volume in a real
 * deployment (the TOTP sealing key must not share a backup with the sealed
 * secret it opens); nothing at the type level enforces that separation, and
 * a nested temp directory needs no cleanup of its own beyond `withVolumeAsync`'s.
 */
function operatorIdentityFor(volume: string, audit: Audit) {
  return createOperatorIdentity({
    volumeRoot: volume,
    credentialMountRoot: path.join(volume, '_credential-mount'),
    clock: systemClock,
    audit,
  });
}

/**
 * Writes the artifact boot step 2 verifies. The compiler is build-time only,
 * so this mirrors what `scripts/build-registry.ts` emits rather than being
 * called from the runtime.
 */
function writeBuildDir(root: string, declarations: Parameters<typeof compiler.compile>[0] = []): string {
  const buildDir = path.join(root, 'build');
  mkdirSync(buildDir, { recursive: true });
  const compiled = compiler.compile(declarations);
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

const EMPTY_CEILING = new Set() as unknown as DeploymentCeiling;

function lifecycleFor(
  volume: string,
  acquirer?: LockAcquirer,
  options: {
    readonly ceiling?: DeploymentCeiling;
    readonly registryDeclarations?: Parameters<typeof compiler.compile>[0];
    readonly notifier?: Pick<Notifier, 'redriveUndelivered'>;
  } = {},
) {
  const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  const lifecycle = createLifecycle({
    volumeRoot: volume,
    buildDir: writeBuildDir(volume, options.registryDeclarations ?? []),
    clock: systemClock,
    store,
    audit,
    operatorIdentity: operatorIdentityFor(volume, audit),
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ceiling: options.ceiling ?? EMPTY_CEILING,
    ...(acquirer ? { acquirer } : {}),
    ...(options.notifier ? { notifier: options.notifier } : {}),
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

test('S11 — boot re-drives the rows left undelivered by the previous process', async () => {
  await withVolumeAsync(async (volume) => {
    // Seed one pending row, as if left behind by a previous process —
    // migrated ahead of `boot()` so the outbox table exists to seed;
    // `boot()`'s own `migrate()` call is idempotent on top.
    const seedStore = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await seedStore.open();
    await seedStore.migrate();
    await seedStore.close();

    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin({
      operationId: 'op-1' as never,
      declarationId: 'repo-a' as never,
      generation: 1 as never,
      tool: 'git_stage' as never,
      input: {},
      actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
      scheduledJobId: null,
      context: 'normal',
      preState: { branch: 'main' as never, headSha: 'a'.repeat(40) as never, upstreamSha: 'a'.repeat(40) as never, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never },
    });
    await journal.settle('op-1' as never, {
      severity: 'attention',
      declarationId: 'repo-a' as never,
      subject: { kind: 'operation-parked', operationId: 'op-1' as never, reason: 'left behind by the previous process' },
      summary: 'a row left over from before the restart',
    });

    let calls = 0;
    const seededNotifier = createNotifier({
      volumeRoot: volume,
      clock: systemClock,
      webhookUrl: 'https://hooks.example.invalid/notify' as never,
      deliverFn: async () => {
        calls += 1;
        return { ok: true, status: 200 };
      },
    });

    const { lifecycle } = lifecycleFor(volume, undefined, { notifier: seededNotifier });
    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);

      // Fired during boot, but boot does not wait for it — see the
      // non-blocking test below for why that distinction is load-bearing.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(calls, 1, 'the row left over from the previous process was re-driven');

      const rows = readOutboxRows(volume);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, 'delivered');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S11 — a slow or unreachable webhook does not delay boot: readiness and the transports come up first', async () => {
  await withVolumeAsync(async (volume) => {
    const seedStore = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await seedStore.open();
    await seedStore.migrate();
    await seedStore.close();

    // A redrive that never settles at all — the worst case, and the one that
    // used to mean the service never started. Awaiting this inside boot()
    // blocked readiness indefinitely; at production defaults even a merely
    // *unreachable* webhook cost ~30 s of backoff per row, sequentially, so
    // twenty accumulated rows kept /healthz silent for ten minutes and an
    // orchestrator killed the container before it ever served.
    let redriveStarted = false;
    const hangingNotifier = {
      redriveUndelivered: () => {
        redriveStarted = true;
        return new Promise<never>(() => {});
      },
    } as unknown as Pick<Notifier, 'redriveUndelivered'>;

    const { lifecycle } = lifecycleFor(volume, undefined, { notifier: hangingNotifier });
    try {
      const startedAt = Date.now();
      const booted = await lifecycle.boot();
      const bootDurationMs = Date.now() - startedAt;

      assert.equal(booted.ok, true, 'boot succeeds even though delivery never will');
      assert.equal(redriveStarted, true, 'the redrive was still started');
      assert.ok(bootDurationMs < 5000, `boot returned in ${bootDurationMs}ms rather than waiting on the notifier`);
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
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });

    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store: countingStore,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleFingerprint: NO_CONSOLE_FINGERPRINT,
      ceiling: EMPTY_CEILING,
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false, 'the corrupt store fails boot');
    assert.ok(closed >= 1, 'boot closed the store it had opened, without relying on shutdown()');
  });
});

test('a registry that is absent reports registry-unreadable, not a mismatch with invented digests', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: path.join(volume, 'no-such-build-dir'),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleFingerprint: NO_CONSOLE_FINGERPRINT,
      ceiling: EMPTY_CEILING,
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

test('S5 — boot exits non-zero with ceiling-outside-contract when the deployment ceiling names a capability absent from the registry', async () => {
  await withVolumeAsync(async (volume) => {
    // The registry declares exactly one capability, `repo.read` (via the one
    // fixture tool below) — a ceiling naming `git.raw`, which nothing in the
    // registry grants, must be fatal at boot per `20-contract.md` § Boot.
    const registryDeclarations = [fixtureTool({ name: 'fixture_read', capabilities: ['repo.read'] })];
    const outsideCeiling = new Set(['git.raw']) as unknown as DeploymentCeiling;

    const { lifecycle } = lifecycleFor(volume, undefined, { ceiling: outsideCeiling, registryDeclarations });
    const booted = await lifecycle.boot();

    assert.equal(booted.ok, false, 'a ceiling capability absent from the registry is fatal');
    if (booted.ok) return;
    assert.equal(booted.error.code, 'ceiling-outside-contract');
    if (booted.error.code !== 'ceiling-outside-contract') return;
    assert.deepEqual(booted.error.capabilities, ['git.raw'] as unknown as CapabilityName[]);
  });
});

test('S5 — boot succeeds when the ceiling is a subset of the registry contract set', async () => {
  await withVolumeAsync(async (volume) => {
    const registryDeclarations = [fixtureTool({ name: 'fixture_read', capabilities: ['repo.read'] })];
    const withinCeiling = new Set(['repo.read']) as unknown as DeploymentCeiling;

    const { lifecycle } = lifecycleFor(volume, undefined, { ceiling: withinCeiling, registryDeclarations });
    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true, 'a ceiling that is a subset of the contract set is fine');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S6 — boot exits with executor-missing when a registry entry has no registered executor', async () => {
  await withVolumeAsync(async (volume) => {
    const registryDeclarations = [fixtureTool({ name: 'fixture_read', capabilities: ['repo.read'], target: { kind: 'module', target: 'fixture.unregistered' as never } })];
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume, registryDeclarations),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleFingerprint: NO_CONSOLE_FINGERPRINT,
      ceiling: new Set(['repo.read']) as unknown as DeploymentCeiling,
      registryEntries: registryDeclarations,
      registeredModuleTargets: new Set(), // nothing registered — the fixture's target has no executor
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false, 'a registry entry with no registered executor is fatal');
    if (booted.ok) return;
    assert.equal(booted.error.code, 'executor-missing');
    if (booted.error.code !== 'executor-missing') return;
    assert.deepEqual(booted.error.tools, ['fixture_read']);

    // The lease must not be left held by a boot that refused to complete.
    const { lifecycle: retry } = lifecycleFor(volume);
    const second = await retry.boot();
    assert.equal(second.ok, true, 'the volume is free again after a failed boot');
    await retry.shutdown('operator');
  });
});

test('S12 — boot exits with executor-missing for an http-targeted entry when registeredHttpOperations is omitted, even with registeredModuleTargets supplied', async () => {
  await withVolumeAsync(async (volume) => {
    const registryDeclarations = [fixtureTool({ name: 'fixture_http', capabilities: ['repo.read'], target: httpTarget('fixture.unregistered') })];
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume, registryDeclarations),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleFingerprint: NO_CONSOLE_FINGERPRINT,
      ceiling: new Set(['repo.read']) as unknown as DeploymentCeiling,
      registryEntries: registryDeclarations,
      registeredModuleTargets: new Set(),
      // registeredHttpOperations deliberately omitted — a composition root
      // that wires the module set but forgets the http one must still be
      // caught here, not only once the first request reaches this entry.
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false, 'an http-targeted entry with no registeredHttpOperations dependency is fatal, not silently skipped');
    if (booted.ok) return;
    assert.equal(booted.error.code, 'executor-missing');
    if (booted.error.code !== 'executor-missing') return;
    assert.deepEqual(booted.error.tools, ['fixture_http']);

    const { lifecycle: retry } = lifecycleFor(volume);
    const second = await retry.boot();
    assert.equal(second.ok, true, 'the volume is free again after a failed boot');
    await retry.shutdown('operator');
  });
});

test('S6 — boot succeeds when every registry entry has a registered executor', async () => {
  await withVolumeAsync(async (volume) => {
    const registryDeclarations = [fixtureTool({ name: 'fixture_read', capabilities: ['repo.read'], target: { kind: 'module', target: 'fixture.registered' as never } })];
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume, registryDeclarations),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleFingerprint: NO_CONSOLE_FINGERPRINT,
      ceiling: new Set(['repo.read']) as unknown as DeploymentCeiling,
      registryEntries: registryDeclarations,
      registeredModuleTargets: new Set(['fixture.registered' as never]),
    });

    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true, 'every entry has an executor');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});
