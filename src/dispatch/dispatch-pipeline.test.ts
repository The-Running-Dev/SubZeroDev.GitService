import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { createCredentialResolver } from '../credentials/credentials.ts';
import type { EnvVarName } from '../shared/brands.ts';
import { success } from '../result/envelope.ts';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { Session } from '../shared/session.ts';
import { createRecoveryCatalogue } from '../recovery/catalogue.ts';
import { recoverDeclaration } from '../lifecycle/recovery.ts';
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

test('two concurrent mutations against *different* repositories never overlap either — the global mutation lock, not the per-declaration materialisation lock, is what serialises them', async () => {
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

    const [first, second] = await Promise.all([call('repo-a'), call('repo-b')]);
    assert.equal(overlapped, false, 'two different repositories still never mutate concurrently — the global mutation lock, not a per-declaration one, serialises them');
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
    let signalHandlerEntered = () => {};
    const handlerEntered = new Promise<void>((resolve) => {
      signalHandlerEntered = resolve;
    });
    moduleAdapter.register('git.stage' as never, async (ctx, input) => {
      // Signals that this call already holds the global mutation lock — the
      // handler only runs once `dispatchMutating` has acquired it — rather
      // than a fixed sleep guessing how long acquisition takes.
      signalHandlerEntered();
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
    await handlerEntered; // the holder is inside its handler, so it already holds the mutation lock
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
    const instrumentedCloneStore: Pick<CloneStore, 'ensure' | 'observeGitState' | 'describe'> = {
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
      describe: (...args) => cloneStore.describe(...args),
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

/**
 * S8's recovery and repair gates. `REPAIR_CAPABILITY_SET` adds the
 * instance-scoped `attention.resolve` to the mutation set — instance-scoped,
 * so it passes `effectiveGrant` on the contract/ceiling/session intersection
 * alone and is never gated by the declaration's own grant.
 */
const REPAIR_CAPABILITY_SET = new Set(['repo.read', 'git.local.write', 'attention.resolve']) as unknown as DeploymentCeiling;

function repairRegistryOf(entries: readonly ToolDeclaration[]): CompiledRegistry {
  return {
    fingerprint: 'a'.repeat(64) as never,
    compiledAt: systemClock.now(),
    entries,
    contractCapabilitySet: REPAIR_CAPABILITY_SET as unknown as CompiledRegistry['contractCapabilitySet'],
  };
}

/** Invariant A7 keeps `attention.resolve` out of every non-operator profile, so a repair session is an operator session. */
function operatorSessionWith(grant: readonly string[]): Session {
  return {
    id: 'sess-repair' as never,
    kind: 'operator',
    actorRef: { kind: 'operator', subject: 'operator' as never, clientId: null, grantId: null },
    repositoryBinding: null,
    grant: new Set(grant) as unknown as Session['grant'],
    writablePathPrefixes: [],
    frozenAtEpoch: 0 as never,
  };
}

const REPAIR_ACTOR = { kind: 'operator' as const, subject: 'operator' as never, clientId: null, grantId: null };

async function materialise(cloneStore: CloneStore, declarations: Declarations): Promise<string> {
  const declaration = (await declarations.get('repo-a' as never))!;
  const holder = { operationId: 'setup' as never, declarationId: declaration.id, tool: 'setup' as never, heldSince: systemClock.now() };
  const ensured = await cloneStore.ensure(declaration, holder, new AbortController().signal);
  assert.equal(ensured.ok, true);
  if (!ensured.ok) throw new Error('fixture could not materialise');
  ensured.value.materialisationLock.release();
  ensured.value.activePin.release();
  return ensured.value.clone.path;
}

test('S8.6 — a parked declaration still serves reads and refuses ordinary mutations', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));
    // The read used to prove 'reads are unaffected' is a stub, deliberately:
    // this test is about the gate, and a real git.status would make it also a
    // test of git.status. Its target is the fixture tool's default — its name.
    moduleAdapter.register('repo_status' as never, async () => success('read served', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 }));

    const clonePath = await materialise(cloneStore, declarations);
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');
    await cloneStore.markAttention('repo-a' as never, 'an earlier operation was parked');

    const pipeline = createDispatchPipeline({
      registry: mutatingRegistryOf([STAGE_ENTRY, fixtureTool({ name: 'repo_status', capabilities: ['repo.read'] })]),
      ceiling: MUTATION_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
    });

    const mutation = await pipeline.dispatch({
      toolName: 'git_stage' as never,
      input: { paths: ['README.md'] },
      session: sessionWith(['repo.read', 'git.local.write']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(mutation.kind, 'precondition');
    assert.match(mutation.summary, /parked operation/);
    assert.match(mutation.summary, /an earlier operation was parked/, 'the refusal must name why, not merely that');

    const read = await pipeline.dispatch({
      toolName: 'repo_status' as never,
      input: {},
      session: sessionWith(['repo.read']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(read.kind, 'success', 'reads are unaffected by a parked declaration');

    // And the clone is still parked afterwards — serving a read must not
    // quietly unpark it.
    const described = await cloneStore.describe('repo-a' as never);
    assert.equal(described.ok && described.value.state, 'needs-attention');
  });
});

test('S8.8 — a session holding attention.resolve reaches the same mutating tool on a parked declaration, audited as repair', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));

    const clonePath = await materialise(cloneStore, declarations);
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');
    await cloneStore.markAttention('repo-a' as never, 'parked for repair');

    const pipeline = createDispatchPipeline({
      registry: repairRegistryOf([STAGE_ENTRY]),
      ceiling: REPAIR_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
    });

    const repair = await pipeline.dispatch({
      toolName: 'git_stage' as never,
      input: { paths: ['README.md'] },
      // `attention.resolve` waives the parked-state refusal; it does not
      // substitute for the tool's own `git.local.write`, which is still here.
      session: operatorSessionWith(['repo.read', 'git.local.write', 'attention.resolve']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(repair.kind, 'success');

    const page = await audit.query({ declarationId: 'repo-a' as never, tool: 'git_stage' as never, actorSubject: null, form: 'call', from: null, to: null, limit: 10, cursor: null });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(page.value.records.length, 1);
    assert.equal(page.value.records[0]!.context, 'repair', 'the caller asked for normal; the gate records what it actually was');
  });
});

test('S8.8 — the repair gate is a predicate on executionClass, not a list of tool names', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));
    // A mutating tool this slice has never heard of, standing in for the one
    // S12 will register. If the gate enumerated today's three tool names,
    // this would be refused — and branch preparation would be withheld from
    // the repair session at exactly the moment it is most needed.
    const futureTool = fixtureTool({
      name: 'prepare_publish_branch',
      capabilities: ['git.local.write'],
      scopes: ['write'],
      executionClass: 'mutating',
      target: { kind: 'module', target: 'git.stage' as never },
    });

    const clonePath = await materialise(cloneStore, declarations);
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');
    await cloneStore.markAttention('repo-a' as never, 'parked');

    const pipeline = createDispatchPipeline({
      registry: repairRegistryOf([futureTool]),
      ceiling: REPAIR_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'prepare_publish_branch' as never,
      input: { paths: ['README.md'] },
      session: operatorSessionWith(['repo.read', 'git.local.write', 'attention.resolve']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'success', 'a mutating tool registered after S8 must be admitted by the same gate');
  });
});

test('S8.7 — the lazy recovery pass finishes before the triggering mutation acquires either lock', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));

    const clonePath = await materialise(cloneStore, declarations);
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');

    const order: string[] = [];
    const instrumentedLocks: Pick<typeof locks, 'pinActiveOperation' | 'acquireMutation'> = {
      pinActiveOperation: (...args) => locks.pinActiveOperation(...args),
      async acquireMutation(...args) {
        order.push('mutation-lock');
        return locks.acquireMutation(...args);
      },
    };
    const instrumentedCloneStore: Pick<CloneStore, 'ensure' | 'observeGitState' | 'describe'> = {
      async ensure(...args) {
        order.push('materialisation-lock');
        return cloneStore.ensure(...args);
      },
      observeGitState: (...args) => cloneStore.observeGitState(...args),
      describe: (...args) => cloneStore.describe(...args),
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
      recoverDeclaration: async () => {
        order.push('recovery-start');
        await new Promise((resolve) => setImmediate(resolve));
        order.push('recovery-end');
      },
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

    // Acquisition order, not timing. Recovery is wholly finished before
    // either lock is taken — including the materialisation lock, because a
    // resume step re-enters this pipeline and takes it for itself.
    assert.deepEqual(order, ['recovery-start', 'recovery-end', 'materialisation-lock', 'mutation-lock']);
  });
});

test('S8.6 — a mutation arriving while the lazy pass is still running is refused as recovery-pending, and the pass runs once', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));
    // The read used to prove 'reads are unaffected' is a stub, deliberately:
    // this test is about the gate, and a real git.status would make it also a
    // test of git.status. Its target is the fixture tool's default — its name.
    moduleAdapter.register('repo_status' as never, async () => success('read served', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 }));

    const clonePath = await materialise(cloneStore, declarations);
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');

    let passes = 0;
    let releasePass: (() => void) | null = null;
    const pipeline = createDispatchPipeline({
      registry: mutatingRegistryOf([STAGE_ENTRY, fixtureTool({ name: 'repo_status', capabilities: ['repo.read'] })]),
      ceiling: MUTATION_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
      recoverDeclaration: async () => {
        passes += 1;
        await new Promise<void>((resolve) => {
          releasePass = resolve;
        });
      },
    });

    const mutate = () =>
      pipeline.dispatch({
        toolName: 'git_stage' as never,
        input: { paths: ['README.md'] },
        session: sessionWith(['repo.read', 'git.local.write']),
        declarationId: 'repo-a' as never,
        scheduledJobId: null,
        context: 'normal',
        signal: new AbortController().signal,
      });

    const first = mutate();
    await new Promise((resolve) => setImmediate(resolve));

    // Arrives mid-pass.
    const second = await mutate();
    assert.equal(second.kind, 'precondition');
    assert.match(second.summary, /recovering unsettled operations/);

    // A read during the same window is untouched.
    const read = await pipeline.dispatch({
      toolName: 'repo_status' as never,
      input: {},
      session: sessionWith(['repo.read']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(read.kind, 'success');

    releasePass!();
    assert.equal((await first).kind, 'success');

    // A third mutation, after the pass has completed, does not re-run it.
    assert.equal((await mutate()).kind, 'success');
    assert.equal(passes, 1, 'the lazy pass runs once per declaration per process — "on first use"');
  });
});

test('S8.9 — resolving a parked entry returns the clone to ready and the declaration to ordinary service', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));

    const clonePath = await materialise(cloneStore, declarations);
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');

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

    const mutate = () =>
      pipeline.dispatch({
        toolName: 'git_stage' as never,
        input: { paths: ['README.md'] },
        session: sessionWith(['repo.read', 'git.local.write']),
        declarationId: 'repo-a' as never,
        scheduledJobId: null,
        context: 'normal',
        signal: new AbortController().signal,
      });

    // A parked entry, and the clone marked to match — the state the ladder leaves behind.
    await journal.begin({
      operationId: 'op-parked' as never,
      declarationId: 'repo-a' as never,
      generation: 1 as never,
      tool: 'git_stage' as never,
      input: {},
      actorRef: REPAIR_ACTOR,
      scheduledJobId: null,
      context: 'normal',
      preState: { branch: null, headSha: null, upstreamSha: null, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never },
    });
    await journal.park('op-parked' as never, 'needs a human');
    await cloneStore.markAttention('repo-a' as never, 'needs a human');

    assert.equal((await mutate()).kind, 'precondition', 'parked: ordinary mutations refused');

    // The resolution itself: settle the entry, clear the clone's mark.
    const settled = await journal.settle('op-parked' as never, null);
    assert.equal(settled.ok, true);
    const cleared = await cloneStore.clearAttention('repo-a' as never, REPAIR_ACTOR);
    assert.equal(cleared.ok, true);

    const described = await cloneStore.describe('repo-a' as never);
    assert.equal(described.ok && described.value.state, 'ready');
    assert.equal(described.ok && described.value.attentionReason, null);
    assert.equal((await journal.parked()).length, 0);

    assert.equal((await mutate()).kind, 'success', 'ordinary service resumes');
  });
});

test('S8.10 — recovery discards nothing: a real clone keeps every commit, stash, untracked file and unpushed branch across every verdict', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));

    // The real clone the ladder will observe — not a synthetic
    // `ObservedGitState`. Everything below happens in this directory, and it
    // is this directory that is compared before and after.
    const clonePath = await materialise(cloneStore, declarations);
    const git = (...args: string[]): string => {
      const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: clonePath, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout;
    };

    // One of each thing the criterion names, all of them unreachable from the
    // remote, so nothing but this service could restore them if it lost them.
    git('checkout', '-b', 'unpushed-work');
    writeFileSync(path.join(clonePath, 'feature.txt'), 'work in progress\n', 'utf8');
    git('add', 'feature.txt');
    git('commit', '-m', 'unpushed');
    git('checkout', 'main');
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture, stashed\n', 'utf8');
    git('stash', 'push', '-m', 'operator work in progress');
    writeFileSync(path.join(clonePath, 'scratch.txt'), 'untracked\n', 'utf8');
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture, edited\n', 'utf8');

    // The four things the criterion names, and nothing else: a legitimate
    // resume may stage a path, which moves `git status` without *removing*
    // anything. Widening this to a whole-tree snapshot would make the test
    // fail on correct behaviour, which is a different bug.
    const survivors = (): string =>
      [git('log', '--all', '--format=%H %s'), git('stash', 'list'), git('branch', '--list'), String(existsSync(path.join(clonePath, 'scratch.txt')))].join('\n--\n');

    const before = survivors();
    assert.match(before, /unpushed/, 'the fixture must actually hold an unpushed commit');
    assert.match(before, /operator work in progress/, 'the fixture must actually hold a stash');
    assert.match(before, /unpushed-work/, 'the fixture must actually hold the branch');
    assert.match(before, /true$/, 'the fixture must actually hold an untracked file');

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

    // The pre-state a `nothing-happened` verdict needs is the tree as it
    // actually stands, read through the real clone store.
    const observedNow = await cloneStore.observeGitState('repo-a' as never);
    assert.equal(observedNow.ok, true);
    if (!observedNow.ok) return;
    const livePreState = {
      branch: observedNow.value.branch,
      headSha: observedNow.value.headSha,
      upstreamSha: observedNow.value.upstreamSha,
      indexDigest: observedNow.value.indexDigest,
      worktreeDigest: observedNow.value.worktreeDigest,
    };
    const stalePreState = { ...livePreState, headSha: 'f'.repeat(40) as never };

    const entryFor = (operationId: string, tool: string, preState: typeof livePreState) => ({
      operationId: operationId as never,
      declarationId: 'repo-a' as never,
      generation: 1 as never,
      tool: tool as never,
      input: { paths: ['README.md'] },
      actorRef: { kind: 'operator' as const, subject: 'operator' as never, clientId: null, grantId: null },
      scheduledJobId: null,
      context: 'normal' as const,
      preState,
    });

    // Every verdict, over this one real tree.
    await journal.begin(entryFor('live-nothing', 'git_stage', livePreState));
    await journal.begin(entryFor('live-park', 'no_descriptor_tool', stalePreState));
    await journal.begin(entryFor('live-completed', 'git_commit', stalePreState));
    await journal.begin(entryFor('live-resume', 'git_stage', stalePreState));

    const catalogue = createRecoveryCatalogue();
    catalogue.register({ tool: 'git_commit' as never, expectedPostState: () => true, resume: null });
    catalogue.register({
      tool: 'git_stage' as never,
      expectedPostState: (entry) => entry.operationId !== ('live-resume' as never),
      resume: () => ({ tool: 'git_stage' as never, input: { paths: ['README.md'] } }),
    });

    const verdicts = await recoverDeclaration(
      {
        journal,
        catalogue,
        clock: systemClock,
        declarations,
        cloneStore,
        // The real pipeline, so the resume genuinely re-enters dispatch,
        // takes both locks and runs a real git subprocess.
        dispatch: pipeline.dispatch,
        recoverySession: sessionWith(['repo.read', 'git.local.write']),
      },
      'repo-a' as never,
    );

    // The ladder must actually have done all four things — a test that
    // silently classified nothing would also report an unchanged tree.
    assert.deepEqual(
      verdicts.map((v) => v.verdict),
      ['nothing-happened', 'park', 'completed', 'resume'],
    );
    assert.equal(survivors(), before, 'recovery removed a commit, a stash, an untracked file or a branch');
  });
});

test('a resume dispatched from inside the lazy pass is not refused by the pass it is part of', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));

    const clonePath = await materialise(cloneStore, declarations);
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');

    const catalogue = createRecoveryCatalogue();
    catalogue.register({
      tool: 'git_stage' as never,
      expectedPostState: () => false,
      resume: () => ({ tool: 'git_stage' as never, input: { paths: ['README.md'] } }),
    });

    // The real cycle: the pipeline runs the ladder on first mutating use, and
    // the ladder dispatches its resume back through that same pipeline. A
    // stubbed dispatch cannot show this — the resume has to actually re-enter.
    let pipeline!: ReturnType<typeof createDispatchPipeline>;
    pipeline = createDispatchPipeline({
      registry: mutatingRegistryOf([STAGE_ENTRY]),
      ceiling: MUTATION_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
      recoverDeclaration: (declarationId) =>
        recoverDeclaration(
          {
            journal,
            catalogue,
            clock: systemClock,
            declarations,
            cloneStore,
            dispatch: (request) => pipeline.dispatch(request),
            recoverySession: sessionWith(['repo.read', 'git.local.write']),
          },
          declarationId,
        ),
    });

    // An unsettled entry from a previous run whose tree has moved, so the
    // ladder reaches `resume` rather than `nothing-happened`.
    await journal.begin({
      operationId: 'op-resume' as never,
      declarationId: 'repo-a' as never,
      generation: 1 as never,
      tool: 'git_stage' as never,
      input: { paths: ['README.md'] },
      actorRef: { kind: 'operator' as const, subject: 'operator' as never, clientId: null, grantId: null },
      scheduledJobId: null,
      context: 'normal',
      preState: { branch: null, headSha: 'f'.repeat(40) as never, upstreamSha: null, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never },
    });

    const triggering = await pipeline.dispatch({
      toolName: 'git_stage' as never,
      input: { paths: ['README.md'] },
      session: sessionWith(['repo.read', 'git.local.write']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(triggering.kind, 'success');

    // The resume succeeded, so the entry settled. If the resume had been
    // refused as `recovery-pending` by the very pass that issued it, the
    // ladder would have read that as a failed resume and parked it instead.
    assert.equal((await journal.parked()).length, 0, 'the resumed entry must not be parked');
    assert.equal((await journal.allUnsettled()).length, 0, 'both the resumed entry and the triggering call settled');

    const repairAudit = await audit.query({ declarationId: 'repo-a' as never, tool: 'git_stage' as never, actorSubject: null, form: 'call', from: null, to: null, limit: 10, cursor: null });
    assert.equal(repairAudit.ok, true);
    if (!repairAudit.ok) return;
    const contexts = repairAudit.value.records.map((r) => r.context).sort();
    assert.deepEqual(contexts, ['normal', 'recovery'], 'the resume is audited as recovery, not relabelled as repair');
  });
});

test('S8.8 — the repair gate is scoped to local writes: a mutating remote tool is not admitted to a parked declaration', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, exec, locks, fixture, volume }) => {
    grantWrite(fixture, ['README.md']);
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit });
    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.stage' as never, toModuleHandler(gitOperations.stage));

    // Stands in for S9's `git_push`: mutating, but a remote write. A parked
    // declaration admits repair, not new reach — `10-design.md` scopes the
    // repair tools to the typed *local* writes under the path allowlist.
    const remoteTool = fixtureTool({
      name: 'git_push',
      capabilities: ['git.remote.write'],
      scopes: ['write'],
      executionClass: 'mutating',
      target: { kind: 'module', target: 'git.stage' as never },
    });

    const clonePath = await materialise(cloneStore, declarations);
    writeFileSync(path.join(clonePath, 'README.md'), 'fixture\nchanged\n', 'utf8');
    await cloneStore.markAttention('repo-a' as never, 'parked');

    fixture.current = { ...fixture.current!, capabilityGrant: new Set(['repo.read', 'git.local.write', 'git.remote.write']) as never };

    const pipeline = createDispatchPipeline({
      registry: {
        fingerprint: 'a'.repeat(64) as never,
        compiledAt: systemClock.now(),
        entries: [remoteTool],
        contractCapabilitySet: new Set(['repo.read', 'git.local.write', 'git.remote.write', 'attention.resolve']) as never,
      },
      ceiling: new Set(['repo.read', 'git.local.write', 'git.remote.write', 'attention.resolve']) as unknown as DeploymentCeiling,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      clock: systemClock,
    });

    const result = await pipeline.dispatch({
      toolName: 'git_push' as never,
      input: { paths: ['README.md'] },
      session: operatorSessionWith(['repo.read', 'git.remote.write', 'attention.resolve']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'precondition', 'attention.resolve must not buy a remote write on a parked declaration');
    assert.match(result.summary, /parked operation/);
  });
});

test('a pass that finds an entry already parked re-marks the clone, closing the crash window between the two writes', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, volume }) => {
    const journal = createJournal({ volumeRoot: volume, clock: systemClock });
    await materialise(cloneStore, declarations);

    // Exactly the state a kill between `journal.park` and `markAttention`
    // leaves: the entry is parked, the clone still reads ready.
    await journal.begin({
      operationId: 'op-half-parked' as never,
      declarationId: 'repo-a' as never,
      generation: 1 as never,
      tool: 'git_stage' as never,
      input: {},
      actorRef: { kind: 'operator' as const, subject: 'operator' as never, clientId: null, grantId: null },
      scheduledJobId: null,
      context: 'normal',
      preState: { branch: null, headSha: null, upstreamSha: null, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never },
    });
    await journal.park('op-half-parked' as never, 'parked before the clone was marked');

    const beforePass = await cloneStore.describe('repo-a' as never);
    assert.equal(beforePass.ok && beforePass.value.state, 'ready', 'the fixture must reproduce the inconsistency it claims to');

    await recoverDeclaration(
      { journal, catalogue: createRecoveryCatalogue(), clock: systemClock, declarations, cloneStore },
      'repo-a' as never,
    );

    const afterPass = await cloneStore.describe('repo-a' as never);
    assert.equal(afterPass.ok && afterPass.value.state, 'needs-attention', 'the pass must reconcile the clone to the still-parked entry');
  });
});

const REMOTE_CAPABILITY_SET = new Set(['repo.read', 'git.local.write', 'git.remote.write']) as unknown as DeploymentCeiling;

const PUSH_ENTRY = fixtureTool({
  name: 'git_push',
  capabilities: ['git.remote.write'],
  scopes: ['write'],
  executionClass: 'mutating',
  target: { kind: 'module', target: 'git.push' as never },
  inputSchema: { type: 'object', properties: { branch: { type: ['string', 'null'] } }, required: ['branch'], additionalProperties: false } as unknown as JsonSchema,
});

test('S9.7 — a push holds the global mutation lock across the whole transfer, and a commit on another repository queues rather than interleaving', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();

    // A real secrets mount, because `push` resolves at point of use and a
    // declaration naming a reference that is not there never reaches a remote.
    const mountRoot = mkdtempSync(path.join(tmpdir(), 'szg-pipeline-mount-'));
    writeFileSync(path.join(mountRoot, 'unused'), 'fixture-secret-value', 'utf8');

    const credentialEnv = new Map<EnvVarName, string>();
    const exec = createExec({ volumeRoot: volume, credentialEnv });
    const locks = createLocks();

    const remoteA = createBareGitRemote();
    const declarationA = fixtureDeclaration('repo-a', remoteA, ['repo.read', 'git.local.write', 'git.remote.write']);
    const declarationB = fixtureDeclaration('repo-b', createBareGitRemote(), ['repo.read', 'git.local.write', 'git.remote.write']);
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
    const gitOperations = createGitOperations({
      clock: systemClock,
      exec,
      locks,
      audit,
      declarations,
      credentials: createCredentialResolver({ credentialMountRoot: mountRoot, volumeRoot: volume, clock: systemClock }),
      credentialEnv,
    });

    // Instrumented, not inferred from timing: `holdersDuringTransfer` records
    // who actually held the global mutation lock at each moment the transfer
    // was running, and `commitRanDuringPush` records whether the other
    // repository's commit got in while it did.
    const holdersDuringTransfer: (string | null)[] = [];
    let pushInFlight = false;
    let commitRanDuringPush = false;

    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register('git.push' as never, async (ctx, input) => {
      pushInFlight = true;
      holdersDuringTransfer.push(locks.currentMutationHolder()?.declarationId ?? null);
      const result = await toModuleHandler(gitOperations.push)(ctx, input);
      // Sampled again after the transfer and before release, so the assertion
      // covers the span rather than one instant at the start of it.
      holdersDuringTransfer.push(locks.currentMutationHolder()?.declarationId ?? null);
      pushInFlight = false;
      return result;
    });
    moduleAdapter.register('git.commit' as never, async (ctx, input) => {
      if (pushInFlight) commitRanDuringPush = true;
      return toModuleHandler(gitOperations.commit)(ctx, input);
    });

    const pipeline = createDispatchPipeline({
      registry: {
        fingerprint: 'a'.repeat(64) as never,
        compiledAt: systemClock.now(),
        entries: [PUSH_ENTRY, COMMIT_ENTRY],
        contractCapabilitySet: REMOTE_CAPABILITY_SET as unknown as CompiledRegistry['contractCapabilitySet'],
      },
      ceiling: REMOTE_CAPABILITY_SET,
      moduleAdapter,
      declarations,
      cloneStore,
      locks,
      audit,
      journal,
      exec,
      clock: systemClock,
    });

    // Both repositories materialised, each with a local commit waiting: one to
    // push, one to commit.
    for (const declaration of [declarationA, declarationB]) {
      const holder = { operationId: 'setup' as never, declarationId: declaration.id, tool: 'setup' as never, heldSince: systemClock.now() };
      const ensured = await cloneStore.ensure(byId.get(declaration.id)!, holder, new AbortController().signal);
      assert.equal(ensured.ok, true);
      if (!ensured.ok) return;
      writeFileSync(path.join(ensured.value.clone.path, 'README.md'), `fixture\n${declaration.id}\n`, 'utf8');
      spawnSync('git', ['add', 'README.md'], { cwd: ensured.value.clone.path, encoding: 'utf8' });
      if (declaration.id === declarationA.id) {
        spawnSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@e.com', 'commit', '-m', 'to push'], { cwd: ensured.value.clone.path, encoding: 'utf8' });
      }
      ensured.value.materialisationLock.release();
      ensured.value.activePin.release();
    }

    const push = pipeline.dispatch({
      toolName: 'git_push' as never,
      input: { branch: null },
      session: sessionWith(['repo.read', 'git.local.write', 'git.remote.write']),
      declarationId: 'repo-a' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });
    const commit = pipeline.dispatch({
      toolName: 'git_commit' as never,
      input: { message: 'concurrent' },
      session: sessionWith(['repo.read', 'git.local.write', 'git.remote.write']),
      declarationId: 'repo-b' as never,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    });

    const [pushed, committed] = await Promise.all([push, commit]);

    assert.equal(pushed.kind, 'success', pushed.summary);
    assert.equal(committed.kind, 'success', committed.summary);
    assert.equal(commitRanDuringPush, false, 'a commit on another repository must queue behind a push, not interleave with its transfer');
    assert.deepEqual(
      holdersDuringTransfer,
      ['repo-a', 'repo-a'],
      'the pushing declaration must hold the global mutation lock at both ends of the transfer',
    );

    rmSync(mountRoot, { recursive: true, force: true });
  });
});
