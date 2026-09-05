import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { compiler } from '../contract/compiler.ts';
import { createAudit } from '../audit/audit.ts';
import { createStructuredStore, MIGRATIONS } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { CONSOLE_HASH_FILENAME, computeConsoleDigest } from './console-integrity.ts';
import { createOperatorIdentity } from '../operator-identity/operator-identity.ts';
import { DatabaseSync } from 'node:sqlite';
import { createJournal } from '../journal/journal.ts';
import { createNotifier, type Notifier } from '../notifier/notifier.ts';
import { createAuthorization } from '../authorization/authorization.ts';
import { createDeclarations } from '../declarations/declarations.ts';
import type { ContractCapabilitySet } from '../contract/capabilities.ts';
import type { RemoteHost } from '../shared/brands.ts';
import { createRecoveryCatalogue } from '../recovery/catalogue.ts';
import { RECONCILE_AFTER_MERGE_RECOVERY } from '../composites/recovery-descriptors.ts';
import { err, ok } from '../shared/outcome.ts';
import { declarationError } from '../declarations/errors.ts';
import { storeError } from '../store/errors.ts';
import type { RecoveryDependencies } from './recovery.ts';

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
import { createLifecycle, type LifecycleDependencies } from './boot.ts';
import type { BootJobReport } from '../scheduler/types.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
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

/**
 * Writes the artifact boot's step 2b (S18.11) verifies. Mirrors
 * `writeBuildDir` above, for the console side: a built asset plus the
 * companion hash `scripts/build-console-manifest.ts` writes atomically.
 * Kept synchronous, like `writeBuildDir`, so every `lifecycleFor` call site
 * stays synchronous too — `computeConsoleDigest` itself is async (it mirrors
 * the real boot-time verification path, exercised directly in
 * `console-integrity.test.ts`), so this recomputes the same one-file digest
 * inline rather than awaiting it here.
 */
function writeConsoleDir(root: string): string {
  const consoleDir = path.join(root, 'console-dist');
  mkdirSync(consoleDir, { recursive: true });
  const indexHtml = '<!doctype html><div id="root"></div>';
  writeFileSync(path.join(consoleDir, 'index.html'), indexHtml, 'utf8');
  const hash = createHash('sha256').update('index.html', 'utf8').update('\0').update(indexHtml, 'utf8').update('\0').digest('hex');
  writeFileSync(path.join(consoleDir, CONSOLE_HASH_FILENAME), `${hash}\n`, 'utf8');
  return consoleDir;
}

const EMPTY_CEILING = new Set() as unknown as DeploymentCeiling;

function lifecycleFor(
  volume: string,
  acquirer?: LockAcquirer,
  options: {
    readonly ceiling?: DeploymentCeiling;
    readonly registryDeclarations?: Parameters<typeof compiler.compile>[0];
    readonly notifier?: Pick<Notifier, 'redriveUndelivered' | 'runRetention' | 'enqueue'>;
    readonly recovery?: RecoveryDependencies;
    readonly revalidateFileWatchers?: LifecycleDependencies['revalidateFileWatchers'];
    readonly scheduler?: LifecycleDependencies['scheduler'];
    readonly registryEntries?: LifecycleDependencies['registryEntries'];
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
    consoleDir: writeConsoleDir(volume),
    ceiling: options.ceiling ?? EMPTY_CEILING,
    revalidateFileWatchers: options.revalidateFileWatchers ?? (async () => ok(undefined)),
    ...(acquirer ? { acquirer } : {}),
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options.registryEntries ? { registryEntries: options.registryEntries } : {}),
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
      assert.equal(booted.value.migrationsApplied, MIGRATIONS.length, 'every migration applied');
      assert.match(booted.value.registryFingerprint, /^[0-9a-f]{64}$/);
      assert.match(booted.value.consoleFingerprint, /^[0-9a-f]{64}$/, 'S18.11 — a real digest of the built console, not the placeholder');
      assert.deepEqual(booted.value.clones, [], 'step 8 derives an empty clone set with none declared');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S23 — boot refuses a stored file-watcher pair that no longer matches the registry and releases its resources', async () => {
  await withVolumeAsync(async (volume) => {
    const cause = declarationError(
      { code: 'watcher-tool-not-annotated', tool: 'removed_plan_tool' as never, expected: 'plan' },
      "tool 'removed_plan_tool' is absent or is not a file-watcher plan",
    );
    const { lifecycle } = lifecycleFor(volume, undefined, {
      revalidateFileWatchers: async () => err(cause),
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false, 'registry drift in a stored file-watcher pair is fatal at boot');
    if (booted.ok) return;
    assert.equal(booted.error.code, 'watcher-revalidation-failed');
    if (booted.error.code !== 'watcher-revalidation-failed') return;
    assert.equal(booted.error.cause, cause, 'the boot error preserves the declaration failure');

    const { lifecycle: retry } = lifecycleFor(volume);
    const retried = await retry.boot();
    assert.equal(retried.ok, true, 'the failed boot closed the store and released the lease');
    await retry.shutdown('operator');
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
    } as unknown as Pick<Notifier, 'redriveUndelivered' | 'runRetention' | 'enqueue'>;

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

test('S12.5 — a resume touching the host runs through the pipeline under its own lock, never during boot', async () => {
  await withVolumeAsync(async (volume) => {
    const seedStore = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await seedStore.open();
    await seedStore.migrate();
    await seedStore.close();

    // Left behind by a killed `reconcile_after_merge` — the composite that
    // touches the host (`host.pr.read`). Its descriptor's `expectedPostState`
    // always returns `false` (`composites/recovery-descriptors.ts`), so this
    // entry classifies `resume` on the very first observation, with nothing
    // needed from `cloneStore` to force it.
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin({
      operationId: 'op-1' as never,
      declarationId: 'repo-a' as never,
      generation: 1 as never,
      tool: 'reconcile_after_merge' as never,
      input: { pullRequestNumber: 7 },
      actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
      scheduledJobId: null,
      context: 'normal',
      preState: { branch: 'main' as never, headSha: 'a'.repeat(40) as never, upstreamSha: 'a'.repeat(40) as never, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never },
    });

    const catalogue = createRecoveryCatalogue();
    catalogue.register(RECONCILE_AFTER_MERGE_RECOVERY);

    // Stands in for the dispatch pipeline — the one thing a host-touching
    // resume must go through, under its own mutation lock (S12's own
    // composites.test.ts uses the same stand-in for the same reason).
    const dispatchCalls: string[] = [];
    const dispatchSpy: RecoveryDependencies['dispatch'] = async (request) => {
      dispatchCalls.push(request.toolName);
      return { ok: true, kind: 'success', summary: 'resumed', data: null, findings: [], diagnostics: null } as never;
    };

    const recovery: RecoveryDependencies = {
      journal,
      catalogue,
      clock: systemClock,
      declarations: { get: async () => ({ id: 'repo-a', generation: 1 }) as never },
      cloneStore: {
        // Diverged from `preState`, so `journal.classify` cannot take its
        // `nothing-happened` shortcut and actually consults the descriptor —
        // whose `expectedPostState` always returns `false` regardless
        // (`composites/recovery-descriptors.ts`), landing on `resume`.
        observeGitState: async () => ok({ branch: 'main' as never, headSha: 'd'.repeat(40) as never, upstreamSha: 'a'.repeat(40) as never, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never, observedAt: '2026-08-09T00:00:00.000Z' as never }),
        markAttention: async () => ok(undefined),
      },
      dispatch: dispatchSpy,
      recoverySession: { grant: new Set() } as never,
    };

    const { lifecycle } = lifecycleFor(volume, undefined, { recovery });
    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;

      assert.deepEqual(dispatchCalls, [], 'boot never dispatches a resume — zero host calls during boot');
      assert.deepEqual(booted.value.recoveryPending, ['repo-a'], 'the entry is reported pending, not silently dropped');

      // Confirms the spy is wired correctly: the same entry resumes, and
      // touches the host, only once asked for on demand.
      const recovered = await lifecycle.recoverDeclaration('repo-a' as never);
      assert.equal(recovered.ok, true);
      if (!recovered.ok) return;
      assert.equal(recovered.value[0]?.verdict, 'resume');
      assert.deepEqual(dispatchCalls, ['reconcile_after_merge'], 'the resume dispatches under its own lock, on demand');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('boot step 7 parks an unsettled entry whose tool has no descriptor in the catalogue this image loaded, and reports its id', async () => {
  await withVolumeAsync(async (volume) => {
    const seedStore = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await seedStore.open();
    await seedStore.migrate();
    await seedStore.close();

    // The upgrade case `10-design.md` § Boot and recovery step 7 names: an
    // image renamed or removed `retired_tool`, so the catalogue this boot
    // loads has no descriptor for the entry the previous image left behind.
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await journal.begin({
      operationId: 'op-no-descriptor' as never,
      declarationId: 'repo-a' as never,
      generation: 1 as never,
      tool: 'retired_tool' as never,
      input: {},
      actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
      scheduledJobId: null,
      context: 'normal',
      preState: { branch: 'main' as never, headSha: 'a'.repeat(40) as never, upstreamSha: 'a'.repeat(40) as never, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never },
    });

    // Registered, but for a different tool — so the catalogue is genuinely
    // populated and the park below is a real lookup miss rather than the
    // "an empty catalogue parks everything" failure the 2026-08-13 decision
    // caught in `revalidatePending`'s registry half.
    const catalogue = createRecoveryCatalogue();
    catalogue.register(RECONCILE_AFTER_MERGE_RECOVERY);

    const attentionCalls: string[] = [];
    const recovery: RecoveryDependencies = {
      journal,
      catalogue,
      clock: systemClock,
      declarations: { get: async () => ({ id: 'repo-a', generation: 1 }) as never },
      cloneStore: {
        observeGitState: async () => ok({ branch: 'main' as never, headSha: 'a'.repeat(40) as never, upstreamSha: 'a'.repeat(40) as never, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never, observedAt: '2026-09-05T00:00:00.000Z' as never }),
        markAttention: async (declarationId) => {
          attentionCalls.push(declarationId);
          return ok(undefined);
        },
      },
      dispatch: async () => ({ ok: true, kind: 'success', summary: '', data: null, findings: [], diagnostics: null }) as never,
      recoverySession: { grant: new Set() } as never,
    };

    const { lifecycle } = lifecycleFor(volume, undefined, { recovery });
    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;

      assert.deepEqual(booted.value.revalidation.entriesParked, ['op-no-descriptor'], 'the operator is told which entry the upgrade stranded, not merely that something was parked');
      assert.deepEqual(attentionCalls, ['repo-a'], 'the clone is put in needs-attention so ordinary mutations are refused until the entry is resolved');

      const parked = await journal.parked();
      assert.equal(parked.ok, true);
      if (!parked.ok) return;
      assert.equal(parked.value.length, 1, 'the entry is parked in the store, not only reported');
      assert.match(parked.value[0]?.attentionReason ?? '', /retired_tool/, 'the reason names the tool whose descriptor is gone');
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
      assert.equal(booted.value.migrationsApplied, MIGRATIONS.length);
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
      consoleDir: writeConsoleDir(volume),
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
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
      consoleDir: writeConsoleDir(volume),
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false);
    if (booted.ok) return;
    assert.equal(booted.error.code, 'registry-unreadable', 'distinct from fingerprint-mismatch');
    if (booted.error.code !== 'registry-unreadable') return;
    assert.ok(booted.error.reason.length > 0, 'names why it could not be read');
  });
});

test('a console build that is absent reports console-unreadable, not a mismatch with invented digests', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleDir: path.join(volume, 'no-such-console-dir'),
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false);
    if (booted.ok) return;
    assert.equal(booted.error.code, 'console-unreadable', 'distinct from console-manifest-mismatch');
    if (booted.error.code !== 'console-unreadable') return;
    assert.ok(booted.error.reason.length > 0, 'names why it could not be read');
  });
});

test('S18.11 — changing one byte of a built console asset makes boot exit with console-manifest-mismatch', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const consoleDir = writeConsoleDir(volume);
    const indexPath = path.join(consoleDir, 'index.html');
    writeFileSync(indexPath, 'tampered after the manifest hash was written', 'utf8');

    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleDir,
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false);
    if (booted.ok) return;
    assert.equal(booted.error.code, 'console-manifest-mismatch');
    if (booted.error.code !== 'console-manifest-mismatch') return;
    assert.notEqual(booted.error.expected, booted.error.found);
  });
});

/**
 * A derived image's build adds a consumer's registered view as an extra
 * built asset and re-stamps the manifest hash over the whole directory,
 * exactly what `scripts/build-console-manifest.ts` does for the base's own
 * build — boot's verification has no notion of "base" vs "derived", so this
 * models the extension by writing one extra file into the same fixture
 * `writeConsoleDir` produces.
 */
function addConsumerView(consoleDir: string): void {
  const extraPath = path.join(consoleDir, 'assets', 'consumer-view-abc123.js');
  mkdirSync(path.dirname(extraPath), { recursive: true });
  writeFileSync(extraPath, 'export const ConsumerView = () => null;', 'utf8');
}

async function restampConsoleManifest(consoleDir: string): Promise<void> {
  const digest = await computeConsoleDigest(consoleDir);
  writeFileSync(path.join(consoleDir, CONSOLE_HASH_FILENAME), `${digest}\n`, 'utf8');
}

test('S19.2 — a derived build with an extra registered view still verifies, and its console fingerprint is a real digest distinct from the contract fingerprint', async () => {
  await withVolumeAsync(async (volume) => {
    const consoleDir = writeConsoleDir(volume);
    addConsumerView(consoleDir);
    await restampConsoleManifest(consoleDir);

    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleDir,
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
    });

    const booted = await lifecycle.boot();
    try {
      assert.equal(booted.ok, true);
      if (!booted.ok) return;
      assert.match(booted.value.consoleFingerprint, /^[0-9a-f]{64}$/);
      assert.notEqual(booted.value.consoleFingerprint, booted.value.registryFingerprint, 'distinct hashing domains — an asset digest is never the compiler fingerprint');
    } finally {
      if (booted.ok) await lifecycle.shutdown('operator');
    }
  });
});

test('S19.3 — tampering a derived build after its manifest hash was written makes boot exit with console-manifest-mismatch, the same shape as a registry mismatch', async () => {
  await withVolumeAsync(async (volume) => {
    const consoleDir = writeConsoleDir(volume);
    addConsumerView(consoleDir);
    await restampConsoleManifest(consoleDir);
    writeFileSync(path.join(consoleDir, 'assets', 'consumer-view-abc123.js'), 'tampered after the manifest hash was written', 'utf8');

    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleDir,
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
    });

    const booted = await lifecycle.boot();
    assert.equal(booted.ok, false);
    if (booted.ok) return;
    assert.equal(booted.error.code, 'console-manifest-mismatch');
    if (booted.error.code !== 'console-manifest-mismatch') return;
    assert.notEqual(booted.error.expected, booted.error.found);
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
      consoleDir: writeConsoleDir(volume),
      ceiling: new Set(['repo.read']) as unknown as DeploymentCeiling,
      revalidateFileWatchers: async () => ok(undefined),
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
      consoleDir: writeConsoleDir(volume),
      ceiling: new Set(['repo.read']) as unknown as DeploymentCeiling,
      revalidateFileWatchers: async () => ok(undefined),
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
      consoleDir: writeConsoleDir(volume),
      ceiling: new Set(['repo.read']) as unknown as DeploymentCeiling,
      revalidateFileWatchers: async () => ok(undefined),
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

test('S25.1/S25.7/S26.5 — runMaintenance drives every owner, reports filesystem bytes, and enqueues exactly one info summary', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock, journalSettledDays: 1 });
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });
    const declarations = createDeclarations({
      volumeRoot: volume,
      clock: systemClock,
      remoteHostAllowlist: [] as unknown as readonly RemoteHost[],
      ceiling: EMPTY_CEILING,
      cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
    });
    const authorization = createAuthorization({
      volumeRoot: volume,
      clock: systemClock,
      contractCapabilitySet: new Set() as unknown as ContractCapabilitySet,
      ceiling: EMPTY_CEILING,
      declarations,
      audit,
      tokenDays: 1,
      revokedGrantDays: 1,
    });
    // Only `runRetention` is exercised by this test; `resolveRunningAtBoot`/`revalidatePending` are boot's S16 half, unrelated here.
    const scheduler: Pick<Scheduler, 'resolveRunningAtBoot' | 'revalidatePending' | 'runRetention'> = {
      resolveRunningAtBoot: async () => ({ markedDone: [], markedNeedsAttention: [], returnedToPending: [], leftRunning: [] }),
      revalidatePending: async () => [],
      runRetention: async () => ({ module: 'scheduler', deletedRows: 2, freedBytes: 0, skipped: [] }),
    };

    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleDir: writeConsoleDir(volume),
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
      journal,
      notifier,
      authorization,
      scheduler,
      watcher: { runRetention: async () => ({ module: 'watcher', deletedRows: 1, freedBytes: 42, skipped: [] }) },
    });

    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;

      // A settled journal entry old enough for this pass to actually prune,
      // so `perModule`'s totals are not every owner reporting a trivial zero.
      const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
      const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
      db.prepare(
        `INSERT INTO journal_entry (
          operation_id, declaration_id, generation, tool, input,
          actor_kind, actor_subject, actor_client, actor_grant,
          scheduled_job_id, context, pre_branch, pre_head_sha, pre_upstream_sha,
          pre_index_digest, pre_worktree_digest, state, attention_reason, started_at, updated_at
        ) VALUES ('op-old', 'repo-a', 1, 'git_stage', '{}', 'mcp', 'sub', NULL, NULL, NULL, 'normal', NULL, NULL, NULL, 'd', 'w', 'settled', NULL, ?, ?)`,
      ).run(old, old);
      db.close();

      const report = await lifecycle.runMaintenance('scheduled');
      assert.equal(report.reason, 'scheduled');
      assert.equal(report.evictions.length, 0, 'clone eviction is S27, not wired here');

      const moduleNames = report.perModule.map((r) => r.module).sort();
      assert.deepEqual(moduleNames, ['audit', 'authorization', 'journal', 'notifier', 'operator-identity', 'scheduler', 'structured-store', 'watcher']);

      const journalReport = report.perModule.find((r) => r.module === 'journal')!;
      assert.equal(journalReport.deletedRows, 1, 'the old settled entry qualifies');

      const schedulerReport = report.perModule.find((r) => r.module === 'scheduler')!;
      assert.equal(schedulerReport.deletedRows, 2, 'runMaintenance must actually call the wired scheduler.runRetention, not skip it');
      const watcherReport = report.perModule.find((r) => r.module === 'watcher')!;
      assert.equal(watcherReport.freedBytes, 42, 'the one summary carries filesystem-owner bytes, not just SQLite vacuum bytes');

      // Exactly one `info` maintenance-pass row, never one per module or per row.
      const after = new DatabaseSync(path.join(volume, 'store.sqlite'));
      const outboxRows = after.prepare(`SELECT severity, payload FROM notification_outbox`).all() as { severity: string; payload: string }[];
      after.close();
      const summaries = outboxRows.filter((row) => (JSON.parse(row.payload) as { subject?: { kind?: string } }).subject?.kind === 'maintenance-pass');
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0]!.severity, 'info');
      const subject = (JSON.parse(summaries[0]!.payload) as { subject: { prunedByModule: unknown[] } }).subject;
      assert.equal(subject.prunedByModule.length, report.perModule.length);
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S25.7 — a maintenance-pass notification that fails to enqueue is recorded on the notifier\'s own retention report, not silently dropped', async () => {
  await withVolumeAsync(async (volume) => {
    const realStore = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    // Every other member delegates to the real store; only `transaction` is
    // overridden, so `runMaintenance`'s enqueue step sees a genuine store
    // failure the way a lock-contention or I/O error would produce one.
    const store = { ...realStore, transaction: async () => err(storeError({ code: 'io-failed' }, 'induced: enqueue transaction failed')) };
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });

    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleDir: writeConsoleDir(volume),
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
      notifier,
    });

    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;

      const report = await lifecycle.runMaintenance('scheduled');

      const notifierReport = report.perModule.find((r) => r.module === 'notifier');
      assert.ok(notifierReport, 'the notifier still ran its own retention pass');
      assert.match(
        notifierReport!.skipped.join(' | '),
        /maintenance-pass summary not enqueued.*induced: enqueue transaction failed/,
        'the enqueue failure must be visible in the report, not vanish once the transaction fails',
      );

      const after = new DatabaseSync(path.join(volume, 'store.sqlite'));
      const outboxRows = after.prepare(`SELECT payload FROM notification_outbox`).all() as { payload: string }[];
      after.close();
      const summaries = outboxRows.filter((row) => (JSON.parse(row.payload) as { subject?: { kind?: string } }).subject?.kind === 'maintenance-pass');
      assert.equal(summaries.length, 0, 'the failed transaction really did leave no row behind');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S16 — boot steps 6 and 7 report the scheduler\'s job resolution and revalidation when one is wired', async () => {
  await withVolumeAsync(async (volume) => {
    const jobsResolved: BootJobReport = { markedDone: ['job-1' as never], markedNeedsAttention: [], returnedToPending: [], leftRunning: [] };
    let seenEntryCount: number | null = null;
    const { lifecycle } = lifecycleFor(volume, undefined, {
      registryEntries: [],
      scheduler: {
        resolveRunningAtBoot: async () => jobsResolved,
        revalidatePending: async (registry) => {
          seenEntryCount = registry.entries.length;
          return ['job-2' as never];
        },
        runRetention: async () => ({ module: 'scheduler', deletedRows: 0, freedBytes: 0, skipped: [] }),
      },
    });
    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;
      assert.deepEqual(booted.value.jobsResolved, jobsResolved, 'step 6 reports exactly what the scheduler returned');
      assert.deepEqual(booted.value.revalidation.jobsParked, ['job-2'], 'step 7 reports exactly what revalidatePending parked');
      assert.equal(seenEntryCount, 0, 'this boot genuinely declares an empty registry');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S16 — a scheduler wired without registryEntries never revalidates against a fabricated empty registry', async () => {
  await withVolumeAsync(async (volume) => {
    let revalidateCalls = 0;
    const { lifecycle } = lifecycleFor(volume, undefined, {
      scheduler: {
        resolveRunningAtBoot: async () => ({ markedDone: [], markedNeedsAttention: [], returnedToPending: [], leftRunning: [] }) as BootJobReport,
        revalidatePending: async () => {
          revalidateCalls += 1;
          return ['job-parked-by-mistake' as never];
        },
        runRetention: async () => ({ module: 'scheduler', deletedRows: 0, freedBytes: 0, skipped: [] }),
      },
    });
    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;
      assert.equal(revalidateCalls, 0, 'no registryEntries were supplied, so revalidatePending must not run against a fabricated empty one');
      assert.deepEqual(booted.value.revalidation.jobsParked, [], 'nothing is falsely parked when the registry is simply absent from this boot');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('boot without a scheduler wired reports the honest empty jobsResolved/revalidation, not a fabricated clean sweep', async () => {
  await withVolumeAsync(async (volume) => {
    const { lifecycle } = lifecycleFor(volume);
    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;
      assert.deepEqual(booted.value.jobsResolved, { markedDone: [], markedNeedsAttention: [], returnedToPending: [], leftRunning: [] });
      assert.deepEqual(booted.value.revalidation, { jobsParked: [], entriesParked: [] });
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S27.1/S27.5 — runMaintenance evicts least-recently-used clones only once retention has run, only until usage drops below the maintenance watermark, and reports it in the one info summary', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const notifier = createNotifier({ volumeRoot: volume, clock: systemClock, webhookUrl: null });

    const oldClone = { declarationId: 'repo-oldest' as never, generation: 1 as never, state: 'ready' as const, path: '/vol/clones/repo-oldest' as never, sizeBytes: 200, lastOperationAt: '2020-01-01T00:00:00.000Z' as never, observedRemote: null, attentionReason: null };
    const newerClone = { declarationId: 'repo-newer' as never, generation: 1 as never, state: 'ready' as const, path: '/vol/clones/repo-newer' as never, sizeBytes: 300, lastOperationAt: '2024-01-01T00:00:00.000Z' as never, observedRemote: null, attentionReason: null };

    const evictCalls: string[] = [];
    const evictIfSafe: NonNullable<LifecycleDependencies['evictIfSafe']> = async (declarationId) => {
      evictCalls.push(declarationId as string);
      // Evicting just the oldest clone (200 bytes) is enough to drop usage
      // from 90% to below the 85% default watermark on this fixture's
      // 1000-byte total — the newer clone must never be reached.
      return ok({ declarationId, evicted: true, freedBytes: 200, blockers: [] });
    };

    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleDir: writeConsoleDir(volume),
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
      notifier,
      deriveCloneStatesFromDisk: async () => [newerClone, oldClone],
      evictIfSafe,
      readVolumeUsage: async () => ({ totalBytes: 1000, usedBytes: 900, usedPercent: 90, byConsumer: { clones: 500, 'audit-log': 0, 'structured-store': 0, 'backups-and-snapshots': 0, 'watcher-files': 0 }, storeByTable: {} as never }),
    });

    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;

      const report = await lifecycle.runMaintenance('watermark');
      assert.deepEqual(evictCalls, ['repo-oldest'], 'least-recently-used first, and stops once usage drops back below the watermark');
      assert.equal(report.evictions.length, 1);
      assert.equal(report.evictions[0]!.evicted, true);
      assert.equal(report.evictions[0]!.freedBytes, 200);

      const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
      const outboxRows = db.prepare(`SELECT payload FROM notification_outbox`).all() as { payload: string }[];
      db.close();
      const summaries = outboxRows.filter((row) => (JSON.parse(row.payload) as { subject?: { kind?: string } }).subject?.kind === 'maintenance-pass');
      assert.equal(summaries.length, 1);
      const subject = (JSON.parse(summaries[0]!.payload) as { subject: { evictedDeclarations: string[]; releasedBytes: number } }).subject;
      assert.deepEqual(subject.evictedDeclarations, ['repo-oldest']);
      assert.ok(subject.releasedBytes >= 200, 'the evicted bytes are folded into the one summary');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});

test('S27.1 — runMaintenance never attempts eviction when usage stays below the maintenance watermark after retention', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });

    // Boot's own step 8 also calls `deriveCloneStatesFromDisk` once, so the
    // count is compared before/after `runMaintenance` rather than asserted
    // as zero outright.
    let deriveCalls = 0;
    const lifecycle = createLifecycle({
      volumeRoot: volume,
      buildDir: writeBuildDir(volume),
      clock: systemClock,
      store,
      audit,
      operatorIdentity: operatorIdentityFor(volume, audit),
      consoleDir: writeConsoleDir(volume),
      ceiling: EMPTY_CEILING,
      revalidateFileWatchers: async () => ok(undefined),
      deriveCloneStatesFromDisk: async () => {
        deriveCalls += 1;
        return [];
      },
      evictIfSafe: async (declarationId) => ok({ declarationId, evicted: true, freedBytes: 1, blockers: [] }),
      readVolumeUsage: async () => ({ totalBytes: 1000, usedBytes: 100, usedPercent: 10, byConsumer: { clones: 0, 'audit-log': 0, 'structured-store': 0, 'backups-and-snapshots': 0, 'watcher-files': 0 }, storeByTable: {} as never }),
    });

    try {
      const booted = await lifecycle.boot();
      assert.equal(booted.ok, true);
      if (!booted.ok) return;
      const callsAfterBoot = deriveCalls;

      const report = await lifecycle.runMaintenance('scheduled');
      assert.equal(report.evictions.length, 0);
      assert.equal(deriveCalls, callsAfterBoot, 'usage is well under the watermark — eviction candidates are never even read');
    } finally {
      await lifecycle.shutdown('operator');
    }
  });
});
