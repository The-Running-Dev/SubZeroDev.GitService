import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createExec } from '../exec/exec.ts';
import { createLocks } from '../locks/locks.ts';
import { createAudit } from '../audit/audit.ts';
import { createDeclarations, type Declarations } from '../declarations/declarations.ts';
import { createCloneStore, type CloneStore } from '../clone/clone-store.ts';
import { createBareGitRemote } from '../clone/testing/git-fixture.ts';
import type { Declaration } from '../declarations/types.ts';
import type { DeploymentCeiling, DeclarationScopedCapability } from '../contract/capabilities.ts';
import { fixtureTool } from '../contract/fixtures.ts';
import type { CompiledRegistry, ToolDeclaration } from '../contract/tool-declaration.ts';
import type { JsonSchema } from '../contract/json.ts';
import { createModuleAdapter, toModuleHandler } from '../module-adapter/module-adapter.ts';
import { createGitOperations } from '../git/git-operations.ts';
import { success } from '../result/envelope.ts';
import type { Session } from '../shared/session.ts';
import { createDispatchPipeline } from './dispatch-pipeline.ts';

const CAPABILITY_SET = new Set(['repo.read']) as unknown as DeploymentCeiling;

function sessionWith(grant: readonly DeclarationScopedCapability[]): Session {
  return {
    id: 'sess-1' as never,
    kind: 'mcp',
    actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
    repositoryBinding: null,
    grant: new Set(grant) as unknown as Session['grant'],
    writablePathPrefixes: [],
    frozenAtEpoch: 0 as never,
  };
}

/**
 * A real local bare remote's path (`createBareGitRemote`) never satisfies
 * `cloneUrl()`'s https-or-scp pattern, so a real `declarations.declare()`
 * call against one always fails `remote-host-not-allowed` before ever
 * reaching a row — the same reason `clone-store.test.ts`'s own
 * `fixtureDeclaration` bypasses `declare()` entirely. This does the same,
 * while keeping `effectiveGrant`/`effectiveWritablePrefixes` as the real,
 * pure implementation from a genuine `Declarations` instance — only `get`
 * is overridden, and it is mutable so a test can simulate the grant
 * narrowing without a real store write.
 */
function fixtureDeclaration(id: string, cloneUrl: string, capabilityGrant: readonly DeclarationScopedCapability[]): Declaration {
  return {
    id: id as Declaration['id'],
    generation: 1 as Declaration['generation'],
    cloneUrl: cloneUrl as Declaration['cloneUrl'],
    host: 'generic',
    credentialRef: 'unused' as Declaration['credentialRef'],
    capabilityGrant: new Set(capabilityGrant) as unknown as Declaration['capabilityGrant'],
    writablePathPrefixes: [],
    pinned: false,
    contentDrop: null,
    identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
    state: 'active',
    grantEpoch: 0 as Declaration['grantEpoch'],
    createdAt: systemClock.now(),
    updatedAt: systemClock.now(),
  };
}

function declarationsWithFixture(volume: string, fixture: { current: Declaration | null }): Declarations {
  const real = createDeclarations({
    volumeRoot: volume,
    clock: systemClock,
    remoteHostAllowlist: [],
    ceiling: CAPABILITY_SET,
    cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
  });
  return {
    ...real,
    async get(id) {
      return fixture.current !== null && fixture.current.id === id ? fixture.current : null;
    },
  };
}

async function withDeclaredRepo<T>(
  fn: (ctx: {
    readonly volume: string;
    readonly declarations: Declarations;
    readonly cloneStore: CloneStore;
    readonly declarationId: string;
    readonly exec: ReturnType<typeof createExec>;
    readonly locks: ReturnType<typeof createLocks>;
    readonly fixture: { current: Declaration | null };
  }) => Promise<T>,
): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();

    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const fixture = { current: fixtureDeclaration('repo-a', createBareGitRemote(), ['repo.read']) };
    const declarations = declarationsWithFixture(volume, fixture);
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations });

    return fn({ volume, declarations, cloneStore, declarationId: 'repo-a', exec, locks, fixture });
  });
}

function registryOf(entries: readonly ToolDeclaration[]): CompiledRegistry {
  return {
    fingerprint: 'a'.repeat(64) as never,
    compiledAt: systemClock.now(),
    entries,
    contractCapabilitySet: CAPABILITY_SET as unknown as CompiledRegistry['contractCapabilitySet'],
  };
}

test('visibleTools returns the tool for a declaration granting repo.read, and nothing once the grant is removed', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, fixture }) => {
    const audit = createAudit({ volumeRoot: '/dev/null-unused', clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    const entry = fixtureTool({ name: 'repo_status', capabilities: ['repo.read'] });
    const pipeline = createDispatchPipeline({
      registry: registryOf([entry]),
      ceiling: CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks: createLocks(),
      audit,
      clock: systemClock,
    });

    const declaration = await declarations.get('repo-a' as never);
    const visible = pipeline.visibleTools(sessionWith(['repo.read']), declaration);
    assert.equal(visible.length, 1);
    assert.equal(visible[0]!.name, 'repo_status');

    fixture.current = fixtureDeclaration('repo-a', fixture.current!.cloneUrl, []);
    const declarationNoGrant = await declarations.get('repo-a' as never);
    const emptyVisible = pipeline.visibleTools(sessionWith(['repo.read']), declarationNoGrant);
    assert.equal(emptyVisible.length, 0, 'the tool is absent once the declaration no longer grants repo.read — not merely refused');
  });
});

test('a by-name call for a tool absent from visibleTools returns authorization, audits the rejection, and never reaches the handler', async () => {
  await withVolumeAsync(async (volume) => {
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    let entered = false;
    moduleAdapter.register('fixture.target' as never, async () => {
      entered = true;
      return success('should not run', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 });
    });
    const entry = fixtureTool({ name: 'fixture_read', capabilities: ['repo.read'], target: { kind: 'module', target: 'fixture.target' as never } });

    // Declared with an EMPTY capability grant — the session asks for
    // `repo.read` but the declaration itself never granted it, so the tool
    // is invisible and any by-name call must still be refused.
    const fixture = { current: fixtureDeclaration('repo-b', createBareGitRemote(), []) };
    const declarations = declarationsWithFixture(volume, fixture);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations });

    const pipeline = createDispatchPipeline({
      registry: registryOf([entry]),
      ceiling: CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'fixture_read' as never,
      input: {},
      session: sessionWith(['repo.read']),
      declarationId: 'repo-b' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'authorization');
    assert.equal(entered, false, 'the handler was never entered');

    const page = await audit.query({ declarationId: null, tool: null, actorSubject: null, form: 'authorization-rejection', from: null, to: null, limit: 10, cursor: null });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(page.value.records.length, 1);
  });
});

test('a tool absent from the registry entirely returns authorization and audits the rejection', async () => {
  await withVolumeAsync(async (volume) => {
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const fixture = { current: null };
    const declarations = declarationsWithFixture(volume, fixture);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations });
    const pipeline = createDispatchPipeline({
      registry: registryOf([]),
      ceiling: CAPABILITY_SET,
      moduleAdapter: createModuleAdapter(),
      declarations,
      cloneStore,
      locks,
      audit,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'no_such_tool' as never,
      input: {},
      session: sessionWith(['repo.read']),
      declarationId: null,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'authorization');

    const page = await audit.query({ declarationId: null, tool: null, actorSubject: null, form: 'authorization-rejection', from: null, to: null, limit: 10, cursor: null });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(page.value.records.length, 1);
  });
});

test('input failing the declared schema returns validation with findings, and the handler never runs', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore }) => {
    const audit = createAudit({ volumeRoot: '/dev/null-unused', clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    let entered = false;
    moduleAdapter.register('fixture.target' as never, async () => {
      entered = true;
      return success('should not run', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 });
    });
    const entry = fixtureTool({
      name: 'fixture_read',
      capabilities: ['repo.read'],
      target: { kind: 'module', target: 'fixture.target' as never },
      inputSchema: { type: 'object', properties: { staged: { type: 'boolean' } }, required: ['staged'] } as unknown as JsonSchema,
    });

    const pipeline = createDispatchPipeline({
      registry: registryOf([entry]),
      ceiling: CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks: createLocks(),
      audit,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'fixture_read' as never,
      input: {},
      session: sessionWith(['repo.read']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'validation');
    assert.ok((result.findings ?? []).length > 0);
    assert.equal(entered, false);
  });
});

test('a handler returning a value the output schema rejects returns infrastructure', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore }) => {
    const audit = createAudit({ volumeRoot: '/dev/null-unused', clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('fixture.target' as never, async () =>
      success('bad output', { wrongField: true }, { operationId: null, declarationId: null, generation: null, durationMs: 0 }),
    );
    const entry = fixtureTool({
      name: 'fixture_read',
      capabilities: ['repo.read'],
      target: { kind: 'module', target: 'fixture.target' as never },
      outputSchema: { type: 'object', properties: { expected: { type: 'string' } }, required: ['expected'] } as unknown as JsonSchema,
    });

    const pipeline = createDispatchPipeline({
      registry: registryOf([entry]),
      ceiling: CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks: createLocks(),
      audit,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'fixture_read' as never,
      input: {},
      session: sessionWith(['repo.read']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'infrastructure');
  });
});

test('a result exceeding maxResultBytes returns infrastructure rather than a truncated payload', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore }) => {
    const audit = createAudit({ volumeRoot: '/dev/null-unused', clock: systemClock });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('fixture.target' as never, async () =>
      success('huge', { blob: 'x'.repeat(1000) }, { operationId: null, declarationId: null, generation: null, durationMs: 0 }),
    );
    const entry = fixtureTool({
      name: 'fixture_read',
      capabilities: ['repo.read'],
      target: { kind: 'module', target: 'fixture.target' as never },
      limits: { timeoutSeconds: 30, maxResultBytes: 100 },
    });

    const pipeline = createDispatchPipeline({
      registry: registryOf([entry]),
      ceiling: CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks: createLocks(),
      audit,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'fixture_read' as never,
      input: {},
      session: sessionWith(['repo.read']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'infrastructure');
    assert.equal(result.data, undefined, 'no truncated payload is returned');
  });
});

test('a real repo_status call succeeds end to end and carries a ReadStamp', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks }) => {
    const audit = createAudit({ volumeRoot: '/dev/null-unused', clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.status' as never, toModuleHandler(gitOperations.status));

    const entry = fixtureTool({ name: 'repo_status', capabilities: ['repo.read'], target: { kind: 'module', target: 'git.status' as never } });
    const pipeline = createDispatchPipeline({
      registry: registryOf([entry]),
      ceiling: CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'repo_status' as never,
      input: {},
      session: sessionWith(['repo.read']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'success');
    if (!result.ok || !result.data) return;
    const data = result.data as { readStamp?: { mutationInFlight: boolean } };
    assert.ok(data.readStamp);
    assert.equal(data.readStamp!.mutationInFlight, false);
  });
});

test('two dispatched reads of the same repository run concurrently — the materialisation lock is released once the clone is ready', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks }) => {
    const audit = createAudit({ volumeRoot: '/dev/null-unused', clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.status' as never, toModuleHandler(gitOperations.status));
    const entry = fixtureTool({ name: 'repo_status', capabilities: ['repo.read'], target: { kind: 'module', target: 'git.status' as never } });
    const pipeline = createDispatchPipeline({
      registry: registryOf([entry]),
      ceiling: CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      clock: systemClock,
    });

    const call = () =>
      pipeline.dispatch({
        toolName: 'repo_status' as never,
        input: {},
        session: sessionWith(['repo.read']),
        declarationId: 'repo-a' as never,
        scheduledJobId: null,
        context: 'normal',
        signal: new AbortController().signal,
      });

    // Materialise once up front so both calls below are hitting an
    // already-`ready` clone and the only lock in play is the brief
    // acquire-then-immediately-release `ensure()` does per call.
    const first = await call();
    assert.equal(first.kind, 'success');

    let secondStarted = 0;
    let firstOfPairFinished = 0;
    const a = (async () => {
      await call();
      firstOfPairFinished = Date.now();
    })();
    const b = (async () => {
      await new Promise((r) => setTimeout(r, 2));
      secondStarted = Date.now();
      await call();
    })();
    await Promise.all([a, b]);
    assert.ok(secondStarted < firstOfPairFinished, 'the second dispatch started before the first finished — neither held the materialisation lock for its duration');
  });
});
