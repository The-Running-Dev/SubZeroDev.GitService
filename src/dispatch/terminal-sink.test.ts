import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore, type StructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createExec } from '../exec/exec.ts';
import { createLocks } from '../locks/locks.ts';
import { createAudit } from '../audit/audit.ts';
import { createJournal } from '../journal/journal.ts';
import { createNotifier } from '../notifier/notifier.ts';
import type { TerminalState } from '../journal/types.ts';
import { createDeclarations, type Declarations } from '../declarations/declarations.ts';
import { createCloneStore, type CloneStore } from '../clone/clone-store.ts';
import { createBareGitRemote } from '../clone/testing/git-fixture.ts';
import type { Declaration } from '../declarations/types.ts';
import type { DeploymentCeiling, DeclarationScopedCapability } from '../contract/capabilities.ts';
import { fixtureTool } from '../contract/fixtures.ts';
import type { CompiledRegistry, ToolDeclaration } from '../contract/tool-declaration.ts';
import { createModuleAdapter } from '../module-adapter/module-adapter.ts';
import { conflict, precondition, success, timeout as timeoutResult } from '../result/envelope.ts';
import { err } from '../shared/outcome.ts';
import type { OperationId, RegistryToolName } from '../shared/brands.ts';
import type { Session } from '../shared/session.ts';
import { createDispatchPipeline } from './dispatch-pipeline.ts';

const CEILING = new Set(['repo.read', 'git.local.write']) as unknown as DeploymentCeiling;

function sessionWith(grant: readonly DeclarationScopedCapability[]): Session {
  return {
    id: 'sess-1' as never,
    kind: 'mcp',
    actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
    repositoryBinding: null,
    grant: new Set(grant) as unknown as Session['grant'],
    frozenAtEpoch: 0 as never,
  };
}

function fixtureDeclaration(cloneUrl: string): Declaration {
  return {
    id: 'repo-a' as Declaration['id'],
    generation: 1 as Declaration['generation'],
    cloneUrl: cloneUrl as Declaration['cloneUrl'],
    host: 'generic',
    // S44.1: a clone with no resolver wired is anonymous only for a null ref, which the type forbids and the clone path still honours.
    credentialRef: null as unknown as Declaration['credentialRef'],
    capabilityGrant: new Set(['repo.read', 'git.local.write']) as unknown as Declaration['capabilityGrant'],
    writablePathPrefixes: [],
    pinned: false,
    fileWatcher: null,
    identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
    state: 'active',
    grantEpoch: 0 as Declaration['grantEpoch'],
    createdAt: systemClock.now(),
    updatedAt: systemClock.now(),
  };
}

interface Harness {
  readonly volume: string;
  readonly declarations: Declarations;
  readonly cloneStore: CloneStore;
  readonly exec: ReturnType<typeof createExec>;
  readonly locks: ReturnType<typeof createLocks>;
  readonly store: StructuredStore;
  readonly sink: Map<OperationId, TerminalState>;
}

async function withHarness<T>(fn: (h: Harness) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    try {
      const exec = createExec({ volumeRoot: volume });
      const locks = createLocks();
      const fixture = fixtureDeclaration(createBareGitRemote());
      const real = createDeclarations({
        volumeRoot: volume,
        clock: systemClock,
        remoteHostAllowlist: [],
        ceiling: CEILING,
        cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
      });
      const declarations: Declarations = { ...real, async get(id) { return id === fixture.id ? fixture : null; } };
      const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations });
      return await fn({ volume, declarations, cloneStore, exec, locks, store, sink: new Map() });
    } finally {
      await store.close();
    }
  });
}

function registryOf(entries: readonly ToolDeclaration[]): CompiledRegistry {
  return { fingerprint: 'a'.repeat(64) as never, compiledAt: systemClock.now(), entries, contractCapabilitySet: CEILING as unknown as CompiledRegistry['contractCapabilitySet'] };
}

function mutatingTool(name: string, target: string): ToolDeclaration {
  return fixtureTool({
    name, capabilities: ['git.local.write'], scopes: ['write'], executionClass: 'mutating',
    target: { kind: 'module', target: target as never }, limits: { timeoutSeconds: 300, maxResultBytes: 4_194_304 },
  });
}

function waitTool(name: string): ToolDeclaration {
  return fixtureTool({ name, capabilities: ['repo.read'], scopes: ['read'], executionClass: 'monitoring-wait', limits: { timeoutSeconds: 1800, maxResultBytes: 1_000_000 } });
}

function requestFor(toolName: string, grant: readonly DeclarationScopedCapability[]) {
  return {
    toolName: toolName as RegistryToolName,
    input: {},
    session: sessionWith(grant),
    declarationId: 'repo-a' as never,
    scheduledJobId: null,
    context: 'normal' as const,
    signal: new AbortController().signal,
  };
}

interface OutboxRow {
  readonly severity: string;
  readonly declaration_id: string | null;
  readonly status: string;
  readonly subject: { readonly kind: string; readonly operationId?: string };
}

function outboxRows(volume: string): OutboxRow[] {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  try {
    const rows = db.prepare('SELECT severity, declaration_id, status, payload FROM notification_outbox ORDER BY created_at ASC').all() as { severity: string; declaration_id: string | null; status: string; payload: string }[];
    return rows.map((row) => ({ severity: row.severity, declaration_id: row.declaration_id, status: row.status, subject: (JSON.parse(row.payload) as { subject: OutboxRow['subject'] }).subject }));
  } finally {
    db.close();
  }
}

const MERGE_CONFLICT = (): TerminalState => ({ kind: 'merge-conflict', branch: 'feature/x' as never, headSha: 'a'.repeat(40) as never, baseSha: 'b'.repeat(40) as never });
const CHECK_FAILED = (): TerminalState => ({ kind: 'required-check-failed', check: 'build', pullRequest: { number: 7, branch: 'feature/x' as never } as never });
const WAIT_TIMEOUT = (): TerminalState => ({ kind: 'wait-timeout', waitedSeconds: 30, tool: 'checks_await' as RegistryToolName });

// --- S41.1 / S41.8 — a mutating call's terminal state settles with its outbox row ---

test('S41.1/S41.8 — a mutating host call that ends in merge-conflict leaves exactly one attention row naming merge-conflict, and the sink empties', async () => {
  await withHarness(async ({ volume, declarations, cloneStore, exec, locks, sink }) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('host.enableAutoMerge' as never, async (ctx) => {
      sink.set(ctx.operationId, MERGE_CONFLICT());
      return conflict('the pull request has a merge conflict', null);
    });
    const pipeline = createDispatchPipeline({
      registry: registryOf([mutatingTool('pr_enable_auto_merge', 'host.enableAutoMerge')]), ceiling: CEILING, moduleAdapter, declarations, cloneStore, locks,
      audit: createAudit({ volumeRoot: volume, clock: systemClock }), journal, exec, clock: systemClock, terminalSink: sink,
    });

    const result = await pipeline.dispatch(requestFor('pr_enable_auto_merge', ['git.local.write']));

    assert.equal(result.kind, 'conflict', 'the envelope is the handler\'s, unchanged');
    const rows = outboxRows(volume);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.severity, 'attention');
    assert.equal(rows[0]!.subject.kind, 'merge-conflict');
    assert.equal(rows[0]!.declaration_id, 'repo-a');
    assert.equal(sink.size, 0, 'R11 — no entry survives the settle');
    const unsettled = await journal.allUnsettled();
    assert.equal(unsettled.ok && unsettled.value.length, 0, 'the entry settled in the same call that wrote the row');
  });
});

// --- S41.3 — a host failure that is not terminal writes nothing ---

test('S41.3 — a mutating call that fails without writing the sink enqueues no terminal notification', async () => {
  await withHarness(async ({ volume, declarations, cloneStore, exec, locks, sink }) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('host.enableAutoMerge' as never, async () => conflict('some other conflict, not a merge conflict', null));
    const pipeline = createDispatchPipeline({
      registry: registryOf([mutatingTool('pr_enable_auto_merge', 'host.enableAutoMerge')]), ceiling: CEILING, moduleAdapter, declarations, cloneStore, locks,
      audit: createAudit({ volumeRoot: volume, clock: systemClock }), journal, exec, clock: systemClock, terminalSink: sink,
    });

    await pipeline.dispatch(requestFor('pr_enable_auto_merge', ['git.local.write']));

    assert.deepEqual(outboxRows(volume), []);
    assert.equal(sink.size, 0);
  });
});

test('S41.3 — a sink entry left by a mutating call that never reaches its settle is still cleared (R11)', async () => {
  await withHarness(async ({ volume, declarations, cloneStore, exec, locks, sink }) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('host.enableAutoMerge' as never, async (ctx) => {
      sink.set(ctx.operationId, MERGE_CONFLICT());
      return timeoutResult('the call exceeded its timeout', 300);
    });
    const pipeline = createDispatchPipeline({
      registry: registryOf([mutatingTool('pr_enable_auto_merge', 'host.enableAutoMerge')]), ceiling: CEILING, moduleAdapter, declarations, cloneStore, locks,
      audit: createAudit({ volumeRoot: volume, clock: systemClock }), journal, exec, clock: systemClock, terminalSink: sink,
    });

    const result = await pipeline.dispatch(requestFor('pr_enable_auto_merge', ['git.local.write']));

    assert.equal(result.kind, 'timeout');
    assert.equal(sink.size, 0, 'the park path takes the entry rather than leaving it to leak');
  });
});

// --- S41.4 / S41.5 — the timeout park ---

test('S41.4/S41.5 — a mutating call that times out appends its audit record before the park, and leaves exactly one operation-parked row', async () => {
  await withHarness(async ({ volume, declarations, cloneStore, exec, locks, sink }) => {
    const realAudit = createAudit({ volumeRoot: volume, clock: systemClock });
    const realJournal = createJournal({ volumeRoot: volume, clock: systemClock });
    const events: string[] = [];
    const audited: { operationId: OperationId | null; form: string; resultKind?: string }[] = [];
    let parkedId: OperationId | null = null;
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.slow' as never, async () => timeoutResult('the mutation exceeded its timeout', 300));
    const pipeline = createDispatchPipeline({
      registry: registryOf([mutatingTool('git_slow', 'git.slow')]), ceiling: CEILING, moduleAdapter, declarations, cloneStore, locks, exec, clock: systemClock, terminalSink: sink,
      audit: {
        append: async (record) => {
          events.push('audit');
          audited.push({ operationId: record.operationId, form: record.form, ...(record.form === 'call' ? { resultKind: record.resultKind } : {}) });
          return realAudit.append(record);
        },
      },
      journal: {
        begin: realJournal.begin,
        markApplied: realJournal.markApplied,
        settle: realJournal.settle,
        park: async (operationId, reason) => {
          events.push('park');
          parkedId = operationId;
          return realJournal.park(operationId, reason);
        },
      },
    });

    const result = await pipeline.dispatch(requestFor('git_slow', ['git.local.write']));

    assert.equal(result.kind, 'timeout');
    assert.deepEqual(events, ['audit', 'park'], 'the audit record is written before the park, as on every other park path');
    assert.ok(parkedId);
    assert.deepEqual(audited, [{ operationId: parkedId, form: 'call', resultKind: 'timeout' }]);
    const rows = outboxRows(volume);
    assert.equal(rows.length, 1, 'exactly one row — the park\'s');
    assert.equal(rows[0]!.subject.kind, 'operation-parked');
    assert.equal(rows[0]!.severity, 'attention');
    assert.equal(rows[0]!.subject.operationId, parkedId);
  });
});

test('S41.4 — a timeout whose journal park fails leaves no operation-parked row', async () => {
  await withHarness(async ({ volume, declarations, cloneStore, exec, locks, sink }) => {
    const realJournal = createJournal({ volumeRoot: volume, clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.slow' as never, async () => timeoutResult('the mutation exceeded its timeout', 300));
    const pipeline = createDispatchPipeline({
      registry: registryOf([mutatingTool('git_slow', 'git.slow')]), ceiling: CEILING, moduleAdapter, declarations, cloneStore, locks, exec, clock: systemClock, terminalSink: sink,
      audit: createAudit({ volumeRoot: volume, clock: systemClock }),
      journal: {
        begin: realJournal.begin,
        markApplied: realJournal.markApplied,
        settle: realJournal.settle,
        park: async () => err({ resultKind: 'infrastructure', retryable: false, summary: 'disk gone', code: 'intent-write-failed' } as never),
      },
    });

    const result = await pipeline.dispatch(requestFor('git_slow', ['git.local.write']));

    assert.equal(result.kind, 'infrastructure');
    assert.deepEqual(outboxRows(volume), []);
  });
});

// --- S41.9 — a monitoring wait's terminal state reaches the outbox without a journal entry ---

async function dispatchWait(h: Harness, handler: (ctx: { operationId: OperationId }) => Promise<ReturnType<typeof success> | ReturnType<typeof precondition> | ReturnType<typeof timeoutResult>>, wiring: { readonly notifier?: boolean; readonly store?: Pick<StructuredStore, 'transaction'> } = {}) {
  const moduleAdapter = createModuleAdapter();
  moduleAdapter.register('checks_await' as never, handler as never);
  const notifier = createNotifier({ volumeRoot: h.volume, clock: systemClock, webhookUrl: null });
  const pipeline = createDispatchPipeline({
    registry: registryOf([waitTool('checks_await')]), ceiling: CEILING, moduleAdapter, declarations: h.declarations, cloneStore: h.cloneStore, locks: h.locks,
    audit: createAudit({ volumeRoot: h.volume, clock: systemClock }), exec: h.exec, clock: systemClock, terminalSink: h.sink,
    ...(wiring.notifier === false ? {} : { notifier }),
    store: wiring.store ?? h.store,
  });
  return pipeline.dispatch(requestFor('checks_await', ['repo.read']));
}

test('S41.9 — a checks_await that ends in required-check-failed leaves exactly one attention row naming it, and the sink empties', async () => {
  await withHarness(async (h) => {
    const result = await dispatchWait(h, async (ctx) => {
      h.sink.set(ctx.operationId, CHECK_FAILED());
      return precondition('a required check failed', []);
    });

    assert.equal(result.kind, 'precondition', 'the wait\'s result is unchanged');
    const rows = outboxRows(h.volume);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.severity, 'attention');
    assert.equal(rows[0]!.subject.kind, 'required-check-failed');
    assert.equal(rows[0]!.declaration_id, 'repo-a');
    assert.equal(h.sink.size, 0);
    const unsettled = await createJournal({ volumeRoot: h.volume, clock: systemClock }).allUnsettled();
    assert.equal(unsettled.ok && unsettled.value.length, 0, 'a monitoring wait journals nothing (R12)');
  });
});

test('S41.9 — a checks_await that ends in wait-timeout leaves exactly one attention row naming it, and the sink empties', async () => {
  await withHarness(async (h) => {
    const result = await dispatchWait(h, async (ctx) => {
      h.sink.set(ctx.operationId, WAIT_TIMEOUT());
      return timeoutResult('the checks did not settle in time', 30);
    });

    assert.equal(result.kind, 'timeout');
    const rows = outboxRows(h.volume);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.subject.kind, 'wait-timeout');
    assert.equal(h.sink.size, 0);
  });
});

test('S41.9 — the take runs on a thrown handler too: the entry is cleared and its row still lands', async () => {
  await withHarness(async (h) => {
    await dispatchWait(h, async (ctx) => {
      h.sink.set(ctx.operationId, WAIT_TIMEOUT());
      throw new Error('handler blew up');
    }).catch(() => undefined);

    assert.equal(h.sink.size, 0, 'R12 — exactly one take on every exit after the handler is invoked');
    assert.equal(outboxRows(h.volume).length, 1);
  });
});

test('S41.9 — the sink decides, not the envelope: a timeout the handler did not attribute to the wait writes no row', async () => {
  await withHarness(async (h) => {
    let transactions = 0;
    const store: Pick<StructuredStore, 'transaction'> = { transaction: (work) => { transactions += 1; return h.store.transaction(work); } };
    const result = await dispatchWait(h, async () => timeoutResult('cancelled', 0), { store });

    assert.equal(result.kind, 'timeout');
    assert.deepEqual(outboxRows(h.volume), []);
    assert.equal(transactions, 0, 'no entry found, so no transaction is opened');
  });
});

test('S41.9 — a failed enqueue is logged with the operationId and kind and leaves the envelope unchanged', async () => {
  await withHarness(async (h) => {
    const logged = mock.method(console, 'error', () => {});
    try {
      let seenId: OperationId | null = null;
      const store: Pick<StructuredStore, 'transaction'> = { transaction: async () => err({ resultKind: 'infrastructure', retryable: false, summary: 'store is down', code: 'io-failed' } as never) };
      const result = await dispatchWait(h, async (ctx) => {
        seenId = ctx.operationId;
        h.sink.set(ctx.operationId, CHECK_FAILED());
        return precondition('a required check failed', []);
      }, { store });

      assert.equal(result.kind, 'precondition', 'delivery never changes the operation it describes');
      assert.equal(h.sink.size, 0);
      const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
      assert.ok(lines.some((line) => line.includes(String(seenId)) && line.includes('required-check-failed') && line.includes('store is down')), `expected a log naming the operationId and kind, got: ${lines.join(' | ')}`);
    } finally {
      logged.mock.restore();
    }
  });
});

test('S41.9 — an entry taken with no notifier to deliver it is logged as a composition defect, and never left in the sink', async () => {
  await withHarness(async (h) => {
    const logged = mock.method(console, 'error', () => {});
    try {
      let seenId: OperationId | null = null;
      const result = await dispatchWait(h, async (ctx) => {
        seenId = ctx.operationId;
        h.sink.set(ctx.operationId, WAIT_TIMEOUT());
        return timeoutResult('the checks did not settle in time', 30);
      }, { notifier: false });

      assert.equal(result.kind, 'timeout');
      assert.equal(h.sink.size, 0);
      assert.deepEqual(outboxRows(h.volume), []);
      const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
      assert.ok(lines.some((line) => line.includes(String(seenId)) && /composition/i.test(line)), `expected a composition-defect log naming the operationId, got: ${lines.join(' | ')}`);
    } finally {
      logged.mock.restore();
    }
  });
});
