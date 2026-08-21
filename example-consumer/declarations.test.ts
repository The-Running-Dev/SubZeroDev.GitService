import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../src/clock/clock.ts';
import { compiler } from '../src/contract/compiler.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../src/composition-root/production-declarations.ts';
import { createModuleAdapter, toModuleHandler } from '../src/module-adapter/module-adapter.ts';
import { createDispatchPipeline } from '../src/dispatch/dispatch-pipeline.ts';
import { createDeclarations, type Declarations } from '../src/declarations/declarations.ts';
import { createCloneStore, type CloneStore } from '../src/clone/clone-store.ts';
import { createBareGitRemote } from '../src/clone/testing/git-fixture.ts';
import { createExec } from '../src/exec/exec.ts';
import { createLocks } from '../src/locks/locks.ts';
import { createAudit } from '../src/audit/audit.ts';
import { createStructuredStore } from '../src/store/structured-store.ts';
import { withVolumeAsync } from '../src/store/volume-fixture.ts';
import type { Declaration } from '../src/declarations/types.ts';
import type { CompiledRegistry } from '../src/contract/tool-declaration.ts';
import type { DeploymentCeiling, DeclarationScopedCapability } from '../src/contract/capabilities.ts';
import type { Session } from '../src/shared/session.ts';
import { EXAMPLE_NOTE_ECHO_HANDLER, EXAMPLE_NOTE_ECHO_TARGET, EXTRA_TOOL_DECLARATIONS } from './declarations.ts';

/**
 * S35.2 and S35.5, proven against the same compiled-registry and
 * `visibleTools` mechanism the base's own `dispatch-pipeline.test.ts`
 * exercises (this file's fixture helpers mirror that one's) — no new
 * dispatch or visibility code exists for a consumer's own tool, only its own
 * declaration and handler wired through `compose.ts`'s
 * `extraToolDeclarations`/`extraModuleHandlers`. `example-consumer/Dockerfile`
 * and a manual boot (recorded in the S35 pull request) additionally prove
 * this against a real built and booted image, including S35.3's
 * fingerprint-mismatch refusal — this test covers the part a unit test can,
 * cheaply and repeatably.
 */

const CEILING = new Set(['repo.read', 'content.exampleNote.read']) as unknown as DeploymentCeiling;

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
    fileWatcher: null,
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
    ceiling: CEILING,
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
  fn: (ctx: { readonly declarations: Declarations; readonly cloneStore: CloneStore; readonly fixture: { current: Declaration | null } }) => Promise<T>,
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

    return fn({ declarations, cloneStore, fixture });
  });
}

test('S35.2/S35.3 — the union of base and example-consumer declarations compiles into one registry, both counts stated, with a fingerprint distinct from the base alone', () => {
  const baseResult = compiler.compile(PRODUCTION_TOOL_DECLARATIONS);
  assert.equal(baseResult.ok, true);

  const unionResult = compiler.compile([...PRODUCTION_TOOL_DECLARATIONS, ...EXTRA_TOOL_DECLARATIONS]);
  assert.equal(unionResult.ok, true);
  if (!baseResult.ok || !unionResult.ok) return;

  assert.equal(PRODUCTION_TOOL_DECLARATIONS.length, 25, 'base tool count');
  assert.equal(EXTRA_TOOL_DECLARATIONS.length, 1, 'example-consumer extra tool count');
  assert.equal(unionResult.value.registry.entries.length, 26, 'union registry carries both counts, one entry list');
  assert.notEqual(unionResult.value.fingerprint, baseResult.value.fingerprint, "the derived fingerprint differs from the base image's own");
});

test('S35.5 — example_note_echo is visible only once the declaration grants content.exampleNote.read, alongside the base tools its own grant already covers', async () => {
  await withDeclaredRepo(async ({ declarations, cloneStore, fixture }) => {
    const compiled = compiler.compile([...PRODUCTION_TOOL_DECLARATIONS, ...EXTRA_TOOL_DECLARATIONS]);
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;

    const registry: CompiledRegistry = {
      fingerprint: compiled.value.fingerprint,
      compiledAt: systemClock.now(),
      entries: compiled.value.registry.entries,
      contractCapabilitySet: compiled.value.registry.contractCapabilitySet,
    };

    const moduleAdapter = createModuleAdapter();
    moduleAdapter.register(EXAMPLE_NOTE_ECHO_TARGET, toModuleHandler(EXAMPLE_NOTE_ECHO_HANDLER));

    const pipeline = createDispatchPipeline({
      registry,
      ceiling: CEILING,
      moduleAdapter,
      declarations,
      cloneStore,
      locks: createLocks(),
      audit: createAudit({ volumeRoot: '/dev/null-unused', clock: systemClock }),
      clock: systemClock,
    });

    const withoutGrant = await declarations.get('repo-a' as never);
    const visibleWithout = pipeline.visibleTools(sessionWith(['repo.read', 'content.exampleNote.read']), withoutGrant);
    assert.ok(!visibleWithout.some((t) => t.name === 'example_note_echo'), 'absent, not merely refused, without the declaration granting the capability');
    assert.ok(visibleWithout.some((t) => t.name === 'repo_status'), "a base tool the declaration's own grant does cover stays visible alongside the absence");

    fixture.current = fixtureDeclaration('repo-a', fixture.current!.cloneUrl, ['repo.read', 'content.exampleNote.read']);
    const withGrant = await declarations.get('repo-a' as never);
    const visibleWith = pipeline.visibleTools(sessionWith(['repo.read', 'content.exampleNote.read']), withGrant);
    assert.ok(visibleWith.some((t) => t.name === 'example_note_echo'), 'present once the declaration grants the consumer-declared capability');
  });
});
