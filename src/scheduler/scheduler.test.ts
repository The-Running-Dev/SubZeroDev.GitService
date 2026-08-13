import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createDeclarations, type Declarations } from '../declarations/declarations.ts';
import { createJournal, type Journal } from '../journal/journal.ts';
import type { JournalBeginInput } from '../journal/types.ts';
import { fixtureTool } from '../contract/fixtures.ts';
import type { ToolDeclaration, CompiledRegistry } from '../contract/tool-declaration.ts';
import type { DeploymentCeiling, ContractCapabilitySet } from '../contract/capabilities.ts';
import type { DeclareInput } from '../declarations/types.ts';
import type { Dispatch, DispatchRequest } from '../dispatch/dispatch-pipeline.ts';
import type { ToolResult } from '../result/envelope.ts';
import type { JsonValue } from '../contract/json.ts';
import type { Authorization } from '../authorization/authorization.ts';
import { validateAgainstSchema } from '../contract/json-schema.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../composition-root/production-declarations.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { CallContext } from '../shared/call-context.ts';
import { ok } from '../shared/outcome.ts';
import type { RegistryToolName } from '../shared/brands.ts';
import { createScheduler } from './scheduler.ts';
import type { ScheduledJob } from './types.ts';

async function withMigratedVolume<T>(fn: (volume: string) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();
    return fn(volume);
  });
}

function ceilingOf(...capabilities: readonly string[]): DeploymentCeiling {
  return new Set(capabilities) as unknown as DeploymentCeiling;
}

function contractOf(...capabilities: readonly string[]): ContractCapabilitySet {
  return new Set(capabilities) as unknown as ContractCapabilitySet;
}

function declarationsFor(volume: string, ceiling: DeploymentCeiling): Declarations {
  return createDeclarations({
    volumeRoot: volume,
    clock: systemClock,
    remoteHostAllowlist: ['github.com'] as never,
    ceiling,
    cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
  });
}

const OPERATOR: ActorRef = { kind: 'operator', subject: 'op' as never, clientId: null, grantId: null };

function declareInputFor(id: string, capabilityGrant: readonly string[]): DeclareInput {
  return {
    id: id as DeclareInput['id'],
    cloneUrl: `https://github.com/example/${id}.git` as DeclareInput['cloneUrl'],
    host: 'github',
    credentialRef: 'unused' as DeclareInput['credentialRef'],
    capabilityGrant: capabilityGrant as never,
    writablePathPrefixes: [],
    pinned: false,
    fileWatcher: null,
    identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
  };
}

function ctxFor(declarationId: string, generation: number, capabilities: readonly string[], actorRef: ActorRef): CallContext {
  return {
    operationId: randomUUID() as never,
    declarationId: declarationId as never,
    generation: generation as never,
    cloneRoot: null,
    actorRef,
    capabilities: new Set(capabilities) as never,
    writablePathPrefixes: [],
    context: 'normal',
    scheduledJobId: null,
    deadline: systemClock.now(),
    signal: new AbortController().signal,
  };
}

function registryEntryFor(tools: readonly ToolDeclaration[]): (tool: RegistryToolName) => ToolDeclaration | null {
  return (tool: RegistryToolName) => tools.find((candidate) => candidate.name === tool) ?? null;
}

function defaultDispatchResult(): ToolResult<JsonValue> {
  return { ok: true, kind: 'success', summary: 'ok', data: null, diagnostics: { operationId: null, declarationId: null, generation: null, durationMs: 0 } };
}

function recordingDispatch(result: ToolResult<JsonValue> = defaultDispatchResult()): { readonly dispatch: Dispatch; readonly calls: DispatchRequest[] } {
  const calls: DispatchRequest[] = [];
  const dispatch: Dispatch = async (request) => {
    calls.push(request);
    return result;
  };
  return { dispatch, calls };
}

function refusingDispatch(): Dispatch {
  return async () => {
    throw new Error('should not dispatch');
  };
}

function fakeAuthorization(liveGrants: Set<string>): Pick<Authorization, 'grantIsLive'> {
  return {
    async grantIsLive(grantId) {
      return liveGrants.has(grantId as unknown as string);
    },
  };
}

/** Direct SQL, bypassing `Scheduler.create`'s own transitions — simulates "left `running` by a killed process", which nothing in the public interface can reach on its own. */
function markRunning(volume: string, ids: readonly string[]): void {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  try {
    for (const id of ids) {
      db.prepare("UPDATE scheduled_job SET status = 'running' WHERE id = ?").run(id);
    }
  } finally {
    db.close();
  }
}

function journalBeginFor(operationId: string, declarationId: string, scheduledJobId: string): JournalBeginInput {
  return {
    operationId: operationId as never,
    declarationId: declarationId as never,
    generation: 1 as never,
    tool: 'scheduled_widget' as never,
    input: {},
    actorRef: { kind: 'scheduler', subject: 'sched' as never, clientId: null, grantId: null },
    scheduledJobId: scheduledJobId as never,
    context: 'normal',
    preState: { branch: 'main' as never, headSha: 'a'.repeat(40) as never, upstreamSha: 'a'.repeat(40) as never, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never },
  };
}

const SCHEDULABLE_TOOL: ToolDeclaration = fixtureTool({
  name: 'scheduled_widget',
  capabilities: ['host.pr.write'],
  executionClass: 'mutating',
  annotations: { schedulable: true, fileWatcher: false, untrustedOutput: false },
});

const NON_SCHEDULABLE_TOOL: ToolDeclaration = fixtureTool({
  name: 'not_schedulable',
  capabilities: ['host.pr.write'],
  executionClass: 'mutating',
  annotations: { schedulable: false, fileWatcher: false, untrustedOutput: false },
});

async function createDeclaredRepo(volume: string, ceiling: DeploymentCeiling, capabilityGrant: readonly string[]): Promise<Declarations> {
  const declarations = declarationsFor(volume, ceiling);
  const declared = await declarations.declare(declareInputFor('repo-a', capabilityGrant), OPERATOR);
  assert.equal(declared.ok, true);
  return declarations;
}

test('S16.1 — creating a job naming a tool without the schedulable annotation returns tool-not-schedulable', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch: refusingDispatch(),
      declarations,
      journal,
      registryEntry: registryEntryFor([NON_SCHEDULABLE_TOOL]),
      contractCapabilitySet: contractOf('host.pr.write'),
      ceiling,
    });
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });
    const result = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: NON_SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'tool-not-schedulable');
  });
});

test('S16.1 — creating a job naming a tool absent from the registry returns tool-not-in-registry', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch: refusingDispatch(),
      declarations,
      journal,
      registryEntry: registryEntryFor([]),
      contractCapabilitySet: contractOf('host.pr.write'),
      ceiling,
    });
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });
    const result = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: 'nonexistent_tool' as never, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'tool-not-in-registry');
  });
});

test('S16.2 — scheduled_job_create requires onMissed; a creation omitting it fails its own input schema', () => {
  const entry = PRODUCTION_TOOL_DECLARATIONS.find((candidate) => candidate.name === ('scheduled_job_create' as never));
  assert.ok(entry, 'scheduled_job_create must be a registered tool');
  const findings = validateAgainstSchema(entry!.inputSchema, {
    tool: 'pr_enable_auto_merge',
    input: {},
    notBefore: systemClock.now(),
  } as unknown as JsonValue);
  assert.ok(findings.some((finding) => finding.path.endsWith('onMissed')), `expected a finding naming onMissed, got ${JSON.stringify(findings)}`);
});

test('S16.3 — at fire time the grant is re-intersected with the declaration grant and the ceiling; both directions', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const contract = contractOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const { dispatch, calls } = recordingDispatch();
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch,
      declarations,
      journal,
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contract,
      ceiling,
    });
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });

    // Direction 1: the grant still covers the tool's capability — it fires.
    const created = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal('operationId' in created.value, false, 'ScheduledJob carries no operationId — the correlation runs the other way');

    const firstTick = await scheduler.tick(systemClock.now());
    assert.deepEqual(firstTick.fired, [created.value.id]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.scheduledJobId, created.value.id);
    assert.equal(calls[0]!.declarationId, 'repo-a');

    // Direction 2: a second job, whose declaration is narrowed before it fires.
    const created2 = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(created2.ok, true);
    if (!created2.ok) return;

    const amended = await declarations.amend(
      'repo-a' as never,
      { cloneUrl: null, credentialRef: null, capabilityGrant: [], writablePathPrefixes: null, pinned: null, fileWatcher: undefined, identity: null },
      OPERATOR,
    );
    assert.equal(amended.ok, true);

    const secondTick = await scheduler.tick(systemClock.now());
    assert.deepEqual(secondTick.fired, []);
    assert.equal(calls.length, 1, 'the narrowed job must never reach dispatch');

    const jobs = await scheduler.list('repo-a' as never, null);
    const job2 = jobs.find((candidate) => candidate.id === created2.value.id);
    assert.ok(job2);
    assert.equal(job2!.status, 'needs-attention');
    assert.match(job2!.reason ?? '', /host\.pr\.write/);
  });
});

test('S16.4 — a job whose creating grant was revoked after creation moves to cancelled naming the revocation and never fires', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const contract = contractOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const { dispatch, calls } = recordingDispatch();
    const grantId = 'grant-1';
    const liveGrants = new Set([grantId]);
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch,
      declarations,
      journal,
      authorization: fakeAuthorization(liveGrants),
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contract,
      ceiling,
    });
    const actorRef: ActorRef = { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: grantId as never };
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], actorRef);

    // 02:00 — created under a live grant.
    const created = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: '2026-08-13T06:00:00.000Z' as never, onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    // 03:00 — the creating grant is revoked.
    liveGrants.delete(grantId);

    // 06:00 — due.
    const tick = await scheduler.tick('2026-08-13T06:00:00.000Z' as never);
    assert.deepEqual(tick.fired, []);
    assert.equal(tick.cancelled.length, 1);
    assert.equal(tick.cancelled[0]!.id, created.value.id);
    assert.match(tick.cancelled[0]!.reason, /revok/);
    assert.equal(calls.length, 0, 'a job whose creating grant was revoked must never fire');

    const jobs = await scheduler.list('repo-a' as never, null);
    const job = jobs.find((candidate) => candidate.id === created.value.id);
    assert.ok(job);
    assert.equal(job!.status, 'cancelled');
    assert.match(job!.reason ?? '', /revok/);
  });
});

test('S16.5 — cancelForDeclaration moves pending jobs to cancelled naming the orphaning, inside the caller\'s own transaction', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const contract = contractOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch: refusingDispatch(),
      declarations,
      journal,
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contract,
      ceiling,
    });
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });
    const created = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    const committed = await store.transaction(async (tx) => scheduler.cancelForDeclaration('repo-a' as never, "declaration 'repo-a' was orphaned", tx));
    await store.close();
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    assert.deepEqual(committed.value, [created.value.id]);

    const jobs = await scheduler.list('repo-a' as never, null);
    const job = jobs.find((candidate) => candidate.id === created.value.id);
    assert.ok(job);
    assert.equal(job!.status, 'cancelled');
    assert.match(job!.reason ?? '', /orphan/);
  });
});

test('S16.7 — resolveRunningAtBoot classifies a running job from the journal alone: settled to done, attention to needs-attention, no entry to pending', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const contract = contractOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch: refusingDispatch(),
      declarations,
      journal,
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contract,
      ceiling,
    });
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });

    async function newJob(): Promise<ScheduledJob> {
      const created = await scheduler.create(
        { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
        ctx,
      );
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error('unreachable');
      return created.value;
    }

    const jobSettled = await newJob();
    const jobAttention = await newJob();
    const jobNone = await newJob();

    markRunning(volume, [jobSettled.id, jobAttention.id, jobNone.id] as unknown as string[]);

    const beginSettled = await journal.begin(journalBeginFor('op-settled', 'repo-a', jobSettled.id as unknown as string));
    assert.equal(beginSettled.ok, true);
    const settled = await journal.settle('op-settled' as never, null);
    assert.equal(settled.ok, true);

    const beginAttention = await journal.begin(journalBeginFor('op-attention', 'repo-a', jobAttention.id as unknown as string));
    assert.equal(beginAttention.ok, true);
    const parked = await journal.park('op-attention' as never, 'a repo-a mutation failed');
    assert.equal(parked.ok, true);

    const report = await scheduler.resolveRunningAtBoot();
    assert.deepEqual(report.markedDone, [jobSettled.id]);
    assert.deepEqual(report.markedNeedsAttention, [jobAttention.id]);
    assert.deepEqual(report.returnedToPending, [jobNone.id]);
    assert.deepEqual(report.leftRunning, []);

    const jobs = await scheduler.list('repo-a' as never, null);
    assert.equal(jobs.find((candidate) => candidate.id === jobSettled.id)!.status, 'done');
    const attentionJob = jobs.find((candidate) => candidate.id === jobAttention.id)!;
    assert.equal(attentionJob.status, 'needs-attention');
    assert.equal(attentionJob.reason, 'a repo-a mutation failed');
    assert.equal(jobs.find((candidate) => candidate.id === jobNone.id)!.status, 'pending');
  });
});

test('S16.8 — resolveRunningAtBoot performs no git or host I/O: it reaches the journal alone and runs no resume step', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    let findByScheduledJobCalls = 0;
    // `SchedulerDependencies` names no `Exec`, `CloneStore` or `HostAdapter`
    // at all — there is no git or host client for this module to reach even
    // if it wanted to. This spy on the one dependency it does hold is the
    // runtime half of that structural guarantee.
    const spyJournal: Pick<Journal, 'findByScheduledJob'> = {
      async findByScheduledJob() {
        findByScheduledJobCalls += 1;
        return ok(null);
      },
    };
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch: refusingDispatch(),
      declarations,
      journal: spyJournal,
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contractOf('host.pr.write'),
      ceiling,
    });
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });
    const created = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    markRunning(volume, [created.value.id as unknown as string]);

    const report = await scheduler.resolveRunningAtBoot();
    assert.equal(findByScheduledJobCalls, 1);
    assert.deepEqual(report.returnedToPending, [created.value.id]);
  });
});

test('S16.9 — an image upgrade removing a tool makes a pending job needs-attention at boot revalidation, naming the upgrade', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const contract = contractOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch: refusingDispatch(),
      declarations,
      journal,
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contract,
      ceiling,
    });
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });
    const created = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const upgradedRegistry: CompiledRegistry = {
      fingerprint: 'a'.repeat(64) as never,
      compiledAt: systemClock.now(),
      entries: [],
      contractCapabilitySet: contract,
    };
    const parked = await scheduler.revalidatePending(upgradedRegistry);
    assert.deepEqual(parked, [created.value.id]);

    const jobs = await scheduler.list('repo-a' as never, null);
    const job = jobs.find((candidate) => candidate.id === created.value.id);
    assert.ok(job);
    assert.equal(job!.status, 'needs-attention');
    assert.match(job!.reason ?? '', /upgrade/);
  });
});

test('cancel reports job-not-found for another declaration\'s job, and job-not-pending for a terminal one', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const contract = contractOf('host.pr.write');
    const declarations = declarationsFor(volume, ceiling);
    assert.equal((await declarations.declare(declareInputFor('repo-a', ['host.pr.write']), OPERATOR)).ok, true);
    assert.equal((await declarations.declare(declareInputFor('repo-b', ['host.pr.write']), OPERATOR)).ok, true);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch: refusingDispatch(),
      declarations,
      journal,
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contract,
      ceiling,
    });
    const ctxA = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });
    const ctxB = ctxFor('repo-b', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });
    const created = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctxA,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const fromOtherDeclaration = await scheduler.cancel(created.value.id, ctxB, 'not mine');
    assert.equal(fromOtherDeclaration.ok, false);
    if (!fromOtherDeclaration.ok) assert.equal(fromOtherDeclaration.error.code, 'job-not-found');

    const cancelled = await scheduler.cancel(created.value.id, ctxA, 'no longer needed');
    assert.equal(cancelled.ok, true);

    const cancelledAgain = await scheduler.cancel(created.value.id, ctxA, 'again');
    assert.equal(cancelledAgain.ok, false);
    if (!cancelledAgain.ok) assert.equal(cancelledAgain.error.code, 'job-not-pending');
  });
});

test('a job cancelled between tick\'s due-job read and its firing write is never fired — the cancellation stands', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const contract = contractOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const { dispatch, calls } = recordingDispatch();
    const grantId = 'grant-1';
    // `grantIsLive` runs early in `tick`'s per-job loop and is `await`ed —
    // exactly the async gap a concurrent `cancel()` would land in between
    // `tick`'s due-job SELECT and its firing write. Mutating the row
    // directly here, from inside that gap, reproduces the race without
    // needing real concurrency: by the time `tick` reaches its claim, the
    // row is already `cancelled`, same as if another caller's `cancel()`
    // had won it first.
    const authorization: Pick<Authorization, 'grantIsLive'> = {
      async grantIsLive() {
        const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
        try {
          db.prepare("UPDATE scheduled_job SET status = 'cancelled', reason = 'cancelled mid-tick' WHERE declaration_id = 'repo-a'").run();
        } finally {
          db.close();
        }
        return true;
      },
    };
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch,
      declarations,
      journal,
      authorization,
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contract,
      ceiling,
    });
    const actorRef: ActorRef = { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: grantId as never };
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], actorRef);
    const created = await scheduler.create(
      { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
      ctx,
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const tick = await scheduler.tick(systemClock.now());
    assert.deepEqual(tick.fired, [], 'the job was cancelled mid-tick; it must not be reported as fired');
    assert.equal(calls.length, 0, 'a cancelled job must never reach dispatch');

    const jobs = await scheduler.list('repo-a' as never, null);
    const job = jobs.find((candidate) => candidate.id === created.value.id);
    assert.ok(job);
    assert.equal(job!.status, 'cancelled', 'the concurrent cancellation must survive tick\'s own write, not be overwritten back to running');
    assert.equal(job!.reason, 'cancelled mid-tick');
  });
});

test('S25.5 — runRetention deletes an old terminal job (done/skipped/cancelled) and never touches a needs-attention job regardless of age', async () => {
  await withMigratedVolume(async (volume) => {
    const ceiling = ceilingOf('host.pr.write');
    const contract = contractOf('host.pr.write');
    const declarations = await createDeclaredRepo(volume, ceiling, ['host.pr.write']);
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const scheduler = createScheduler({
      volumeRoot: volume,
      clock: systemClock,
      dispatch: refusingDispatch(),
      declarations,
      journal,
      registryEntry: registryEntryFor([SCHEDULABLE_TOOL]),
      contractCapabilitySet: contract,
      ceiling,
      terminalJobDays: 1,
    });
    const ctx = ctxFor('repo-a', 1, ['host.pr.write'], { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null });

    async function createJob(): Promise<string> {
      const created = await scheduler.create(
        { declarationId: 'repo-a' as never, tool: SCHEDULABLE_TOOL.name, input: {}, notBefore: systemClock.now(), onMissed: { mode: 'catch_up' } },
        ctx,
      );
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error('unreachable');
      return created.value.id;
    }

    const oldDoneId = await createJob();
    const recentCancelledId = await createJob();
    const oldAttentionId = await createJob();

    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const recent: string = systemClock.now();
    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    db.prepare("UPDATE scheduled_job SET status = 'done', updated_at = ? WHERE id = ?").run(old, oldDoneId);
    db.prepare("UPDATE scheduled_job SET status = 'cancelled', updated_at = ? WHERE id = ?").run(recent, recentCancelledId);
    db.prepare("UPDATE scheduled_job SET status = 'needs-attention', updated_at = ? WHERE id = ?").run(old, oldAttentionId);
    db.close();

    const report = await scheduler.runRetention();
    assert.equal(report.module, 'scheduler');
    assert.equal(report.deletedRows, 1, 'only the old terminal job qualifies');
    assert.equal(report.skipped.length, 0);

    const remaining = await scheduler.list('repo-a' as never, null);
    const remainingIds = remaining.map((job) => job.id).sort();
    assert.deepEqual(remainingIds, [recentCancelledId, oldAttentionId].sort());
  });
});
