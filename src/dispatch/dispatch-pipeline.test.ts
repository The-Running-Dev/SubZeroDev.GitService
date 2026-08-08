import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createExec } from '../exec/exec.ts';
import { createLocks } from '../locks/locks.ts';
import { createAudit } from '../audit/audit.ts';
import { createJournal } from '../journal/journal.ts';
import { journalError, type JournalError } from '../journal/errors.ts';
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
import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { Session } from '../shared/session.ts';
import { createDispatchPipeline } from './dispatch-pipeline.ts';

const CAPABILITY_SET = new Set(['repo.read']) as unknown as DeploymentCeiling;
const MUTATION_CAPABILITY_SET = new Set(['repo.read', 'git.local.write']) as unknown as DeploymentCeiling;

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

function mutatingRegistryOf(entries: readonly ToolDeclaration[]): CompiledRegistry {
  return {
    fingerprint: 'a'.repeat(64) as never,
    compiledAt: systemClock.now(),
    entries,
    contractCapabilitySet: MUTATION_CAPABILITY_SET as unknown as CompiledRegistry['contractCapabilitySet'],
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

function grantWrite(fixture: { current: Declaration | null }, writablePathPrefixes: readonly string[]): void {
  fixture.current = {
    ...fixture.current!,
    capabilityGrant: new Set(['repo.read', 'git.local.write']) as unknown as Declaration['capabilityGrant'],
    writablePathPrefixes: writablePathPrefixes as unknown as Declaration['writablePathPrefixes'],
  };
}

const STAGE_ENTRY = fixtureTool({ name: 'git_stage', capabilities: ['git.local.write'], scopes: ['write'], executionClass: 'mutating', target: { kind: 'module', target: 'git.stage' as never } });
const COMMIT_ENTRY = fixtureTool({ name: 'git_commit', capabilities: ['git.local.write'], scopes: ['write'], executionClass: 'mutating', target: { kind: 'module', target: 'git.commit' as never } });

test('a real git_stage + git_commit mutation runs end to end: journal settles, audit records the call, locks are released', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));
    moduleAdapter.register('git.commit' as never, toModuleHandler(gitOperations.commit));

    const pipeline = createDispatchPipeline({
      registry: mutatingRegistryOf([STAGE_ENTRY, COMMIT_ENTRY]),
      ceiling: MUTATION_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
    });

    // Materialise directly so the file to stage exists on disk before dispatch.
    const declaration = (await declarations.get('repo-a' as never))!;
    const holder = { operationId: 'setup' as never, declarationId: declaration.id, tool: 'setup' as never, heldSince: systemClock.now() };
    const ensured = await cloneStore.ensure(declaration, holder, new AbortController().signal);
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    writeFileSync(path.join(ensured.value.clone.path, 'README.md'), 'fixture\nchanged\n', 'utf8');
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();

    const stageResult = await pipeline.dispatch({
      toolName: 'git_stage' as never,
      input: { paths: ['README.md'] },
      session: sessionWith(['repo.read', 'git.local.write']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(stageResult.kind, 'success');

    const commitResult = await pipeline.dispatch({
      toolName: 'git_commit' as never,
      input: { message: 'update readme' },
      session: sessionWith(['repo.read', 'git.local.write']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(commitResult.kind, 'success');

    // The journal entry for the commit settled.
    const parked = await journal.parked();
    assert.equal(parked.length, 0);
    const unsettled = await journal.allUnsettled();
    assert.equal(unsettled.length, 0, 'both mutations settled — nothing left unsettled');

    // A `call` audit record exists for the commit.
    const page = await audit.query({ declarationId: 'repo-a' as never, tool: 'git_commit' as never, actorSubject: null, form: 'call', from: null, to: null, limit: 10, cursor: null });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(page.value.records.length, 1);

    // Both locks are free — a third mutation on the same repo does not queue behind anything left held.
    assert.equal(locks.currentMutationHolder(), null);
  });
});

test('mutation with the journal forced to fail returns infrastructure, and the working tree is byte-identical before and after — no side effect ran', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    let handlerEntered = false;
    moduleAdapter.register('git.stage' as never, async (ctx, input) => {
      handlerEntered = true;
      return toModuleHandler(gitOperations.stage)(ctx, input);
    });

    const failingJournal = {
      async begin(): Promise<Outcome<never, JournalError>> {
        return err(journalError({ code: 'intent-write-failed', cause: { resultKind: 'infrastructure', retryable: false, summary: 'forced failure', code: 'io-failed' } as never }, 'forced failure'));
      },
      async appendStep() {
        throw new Error('unreachable — begin() already failed');
      },
      async markApplied() {
        throw new Error('unreachable — begin() already failed');
      },
      async settle() {
        throw new Error('unreachable — begin() already failed');
      },
    };

    const pipeline = createDispatchPipeline({
      registry: mutatingRegistryOf([STAGE_ENTRY]),
      ceiling: MUTATION_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal: failingJournal,
      clock: systemClock,
    });

    const declaration = (await declarations.get('repo-a' as never))!;
    const holder = { operationId: 'setup' as never, declarationId: declaration.id, tool: 'setup' as never, heldSince: systemClock.now() };
    const ensured = await cloneStore.ensure(declaration, holder, new AbortController().signal);
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    const readmePath = path.join(ensured.value.clone.path, 'README.md');
    const before = readFileSync(readmePath, 'utf8');
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();

    const result = await pipeline.dispatch({
      toolName: 'git_stage' as never,
      input: { paths: ['README.md'] },
      session: sessionWith(['repo.read', 'git.local.write']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'infrastructure');
    assert.equal(handlerEntered, false, 'the domain handler — the first side effect — never ran');
    const after = readFileSync(readmePath, 'utf8');
    assert.equal(before, after, 'the working tree is byte-identical before and after the aborted mutation');
    assert.equal(locks.currentMutationHolder(), null, 'the mutation lock was released even on this abort path');
  });
});

test('two concurrent mutations against the same repository never overlap — instrumented, not inferred from timing', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    let inFlight = 0;
    let overlapped = false;
    moduleAdapter.register('git.stage' as never, async (ctx, input) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 20));
      const result = await toModuleHandler(gitOperations.stage)(ctx, input);
      inFlight -= 1;
      return result;
    });

    const pipeline = createDispatchPipeline({
      registry: mutatingRegistryOf([STAGE_ENTRY]),
      ceiling: MUTATION_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
    });

    const declaration = (await declarations.get('repo-a' as never))!;
    const holder = { operationId: 'setup' as never, declarationId: declaration.id, tool: 'setup' as never, heldSince: systemClock.now() };
    const ensured = await cloneStore.ensure(declaration, holder, new AbortController().signal);
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    writeFileSync(path.join(ensured.value.clone.path, 'README.md'), 'fixture\nchanged\n', 'utf8');
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();

    const call = () =>
      pipeline.dispatch({
        toolName: 'git_stage' as never,
        input: { paths: ['README.md'] },
        session: sessionWith(['repo.read', 'git.local.write']),
        declarationId: 'repo-a' as never,
        scheduledJobId: null,
        context: 'normal',
        signal: new AbortController().signal,
      });

    const [first, second] = await Promise.all([call(), call()]);
    assert.equal(overlapped, false, 'the two mutations never ran concurrently — the second waited on the global mutation lock');
    assert.equal(first.kind, 'success');
    assert.equal(second.kind, 'success');
  });
});

test('a mutation that times out waiting for the mutation lock returns conflict naming the holding operation', async () => {
  // Two *different* declarations, deliberately — the materialisation lock is
  // per-declaration and a mutating call holds it for its whole duration, so
  // two calls against the *same* declaration would queue there first and
  // never reach the global mutation lock this test means to exercise. Two
  // declarations share nothing but that one global mutex.
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();

    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const declarationA = fixtureDeclaration('repo-a', createBareGitRemote(), ['repo.read', 'git.local.write']);
    const declarationB = fixtureDeclaration('repo-b', createBareGitRemote(), ['repo.read', 'git.local.write']);
    const byId = new Map([
      [declarationA.id, { ...declarationA, writablePathPrefixes: ['README.md'] as unknown as Declaration['writablePathPrefixes'] }],
      [declarationB.id, { ...declarationB, writablePathPrefixes: ['README.md'] as unknown as Declaration['writablePathPrefixes'] }],
    ]);
    const declarationsReal = createDeclarations({
      volumeRoot: volume,
      clock: systemClock,
      remoteHostAllowlist: [],
      ceiling: CAPABILITY_SET,
      cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
    });
    const declarations: Declarations = { ...declarationsReal, async get(id) { return byId.get(id) ?? null; } };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations });

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    let releaseHeld = () => {};
    const heldGate = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    moduleAdapter.register('git.stage' as never, async (ctx, input) => {
      await heldGate;
      return toModuleHandler(gitOperations.stage)(ctx, input);
    });

    const pipeline = createDispatchPipeline({
      registry: mutatingRegistryOf([STAGE_ENTRY]),
      ceiling: MUTATION_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
      mutationLockAcquireMs: 50,
    });

    for (const declaration of [declarationA, declarationB]) {
      const holder = { operationId: 'setup' as never, declarationId: declaration.id, tool: 'setup' as never, heldSince: systemClock.now() };
      const ensured = await cloneStore.ensure(byId.get(declaration.id)!, holder, new AbortController().signal);
      assert.equal(ensured.ok, true);
      if (!ensured.ok) return;
      writeFileSync(path.join(ensured.value.clone.path, 'README.md'), 'fixture\nchanged\n', 'utf8');
      ensured.value.materialisationLock.release();
      ensured.value.activePin.release();
    }

    const call = (declarationId: string) =>
      pipeline.dispatch({
        toolName: 'git_stage' as never,
        input: { paths: ['README.md'] },
        session: sessionWith(['repo.read', 'git.local.write']),
        declarationId: declarationId as never,
        scheduledJobId: null,
        context: 'normal',
        signal: new AbortController().signal,
      });

    const holderCall = call('repo-a');
    await new Promise((r) => setTimeout(r, 5)); // let the first call actually acquire the mutation lock
    const waiterCall = call('repo-b');

    const waiterResult = await waiterCall;
    assert.equal(waiterResult.kind, 'conflict');
    assert.ok((waiterResult.findings ?? []).some((f) => f.rule === 'held-by-another-operation' && f.message.includes('git_stage')), 'names the holding operation');

    releaseHeld();
    const holderResult = await holderCall;
    assert.equal(holderResult.kind, 'success');
  });
});

test('the materialisation lock is released after the mutation lock, not before — release order asserted', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);

    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));

    const releaseOrder: string[] = [];
    const declaration = (await declarations.get('repo-a' as never))!;
    const setupHolder = { operationId: 'setup' as never, declarationId: declaration.id, tool: 'setup' as never, heldSince: systemClock.now() };
    const setupEnsured = await cloneStore.ensure(declaration, setupHolder, new AbortController().signal);
    assert.equal(setupEnsured.ok, true);
    if (!setupEnsured.ok) return;
    writeFileSync(path.join(setupEnsured.value.clone.path, 'README.md'), 'fixture\nchanged\n', 'utf8');
    setupEnsured.value.materialisationLock.release();
    setupEnsured.value.activePin.release();

    // Spy on the two lock classes' `release()` without changing their
    // behaviour — order is recorded, not simulated.
    const instrumentedCloneStore: Pick<CloneStore, 'ensure' | 'observeGitState'> = {
      async ensure(...args) {
        const result = await cloneStore.ensure(...args);
        if (!result.ok) return result;
        const originalRelease = result.value.materialisationLock.release.bind(result.value.materialisationLock);
        return ok({
          ...result.value,
          materialisationLock: {
            holder: result.value.materialisationLock.holder,
            release: () => {
              releaseOrder.push('materialisation');
              originalRelease();
            },
          },
        });
      },
      observeGitState: (...args) => cloneStore.observeGitState(...args),
    };
    const instrumentedLocks: Pick<typeof locks, 'pinActiveOperation' | 'acquireMutation'> = {
      pinActiveOperation: (...args) => locks.pinActiveOperation(...args),
      async acquireMutation(...args) {
        const result = await locks.acquireMutation(...args);
        if (!result.ok) return result;
        const originalRelease = result.value.release.bind(result.value);
        return ok({
          holder: result.value.holder,
          release: () => {
            releaseOrder.push('mutation');
            originalRelease();
          },
        });
      },
    };

    const pipeline = createDispatchPipeline({
      registry: mutatingRegistryOf([STAGE_ENTRY]),
      ceiling: MUTATION_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore: instrumentedCloneStore,
      locks: instrumentedLocks,
      audit,
      journal,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'git_stage' as never,
      input: { paths: ['README.md'] },
      session: sessionWith(['repo.read', 'git.local.write']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });

    assert.equal(result.kind, 'success');
    assert.deepEqual(releaseOrder, ['mutation', 'materialisation'], 'mutation released before materialisation — reverse acquisition order');
  });
});
