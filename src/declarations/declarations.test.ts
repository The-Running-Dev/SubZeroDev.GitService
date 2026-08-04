import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { RemoteHost } from '../shared/brands.ts';
import type { DeploymentCeiling } from '../contract/capabilities.ts';
import type { SafeToEvictVerdict } from '../clone/types.ts';
import { createDeclarations, type CloneAdoptionCheck } from './declarations.ts';
import type { DeclareInput } from './types.ts';

const OPERATOR = { kind: 'operator' as const, subject: 'op' as never, clientId: null, grantId: null };
const GITHUB_ALLOWLIST = ['github.com'] as unknown as readonly RemoteHost[];

function ceilingOf(...capabilities: readonly string[]): DeploymentCeiling {
  return new Set(capabilities) as unknown as DeploymentCeiling;
}

async function withMigratedVolume<T>(fn: (volume: string) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();
    return fn(volume);
  });
}

/**
 * `Declarations` unit tests stub `CloneAdoptionCheck` rather than wiring a
 * real `CloneStore` — the module under test here is the declaration table
 * and the lattice intersection (`10-design.md`'s own line for what
 * Declarations owns), not git plumbing, which `clone/clone-store.test.ts`
 * already exercises against real clones. A fixed verdict is what lets these
 * tests assert `declare()`'s own orchestration of the adoption check without
 * needing a clonable remote.
 */
function declarationsFor(
  volume: string,
  opts: { readonly remoteHostAllowlist?: readonly RemoteHost[]; readonly ceiling?: DeploymentCeiling; readonly adoptionCheck?: CloneAdoptionCheck } = {},
) {
  const adoptionCheck: CloneAdoptionCheck = opts.adoptionCheck ?? {
    observedRemote: async () => null,
    isSafeToAdopt: async () => ({ safe: true }),
  };
  return createDeclarations({
    volumeRoot: volume,
    clock: systemClock,
    remoteHostAllowlist: opts.remoteHostAllowlist ?? GITHUB_ALLOWLIST,
    ceiling: opts.ceiling ?? ceilingOf('repo.read', 'git.local.write', 'git.remote.write'),
    cloneAdoptionCheck: () => adoptionCheck,
  });
}

function declareInputFor(id: string, overrides: Partial<DeclareInput> = {}): DeclareInput {
  return {
    id: id as DeclareInput['id'],
    cloneUrl: `https://github.com/example/${id}.git` as DeclareInput['cloneUrl'],
    host: 'generic',
    credentialRef: 'unused' as DeclareInput['credentialRef'],
    capabilityGrant: ['repo.read'],
    writablePathPrefixes: [],
    pinned: false,
    contentDrop: null,
    identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
    ...overrides,
  };
}

function upsertCloneRow(volume: string, declarationId: string, state: string): void {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  db.prepare(
    `INSERT INTO clone (declaration_id, generation, state, path, size_bytes, last_operation_at, observed_remote, attention_reason)
     VALUES (?, 1, ?, ?, 0, NULL, NULL, NULL)
     ON CONFLICT(declaration_id) DO UPDATE SET state = excluded.state`,
  ).run(declarationId, state, path.join(volume, 'clones', declarationId));
  db.close();
}

test('declaring with a capability outside the ceiling returns capability-outside-ceiling', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume, { ceiling: ceilingOf('repo.read') });
    const result = await declarations.declare(declareInputFor('repo-1', { capabilityGrant: ['repo.read', 'git.raw'] }), OPERATOR);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'capability-outside-ceiling');
      if (result.error.code === 'capability-outside-ceiling') assert.deepEqual(result.error.capabilities, ['git.raw']);
    }
  });
});

test('a generic-host declaration granted host.pr.write returns capability-unsupported-by-host', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume, { ceiling: ceilingOf('repo.read', 'host.pr.write') });
    const result = await declarations.declare(declareInputFor('repo-2', { host: 'generic', capabilityGrant: ['repo.read', 'host.pr.write'] }), OPERATOR);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'capability-unsupported-by-host');
      if (result.error.code === 'capability-unsupported-by-host') assert.deepEqual(result.error.capabilities, ['host.pr.write']);
    }
  });
});

test('the same grant is accepted for a github-host declaration — positive and negative counts, both demonstrated', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume, { ceiling: ceilingOf('repo.read', 'host.pr.write') });
    let accepted = 0;
    let rejected = 0;

    const genericResult = await declarations.declare(declareInputFor('repo-3a', { host: 'generic', capabilityGrant: ['repo.read', 'host.pr.write'] }), OPERATOR);
    if (genericResult.ok) accepted += 1;
    else rejected += 1;

    const githubResult = await declarations.declare(declareInputFor('repo-3b', { host: 'github', capabilityGrant: ['repo.read', 'host.pr.write'] }), OPERATOR);
    if (githubResult.ok) accepted += 1;
    else rejected += 1;

    assert.equal(accepted, 1);
    assert.equal(rejected, 1);
    assert.equal(genericResult.ok, false);
    assert.equal(githubResult.ok, true);
  });
});

test('declaring a cloneUrl whose host is off the allowlist returns remote-host-not-allowed', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume, { remoteHostAllowlist: GITHUB_ALLOWLIST });
    // Bypasses the HTTP boundary's own `cloneUrl()` check (this is a unit
    // test of `declare()` itself) to prove the "second, independent guard"
    // the contract describes actually runs inside the module too.
    const result = await declarations.declare(declareInputFor('repo-4', { cloneUrl: 'https://attacker.example/owner/repo.git' as DeclareInput['cloneUrl'] }), OPERATOR);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'remote-host-not-allowed');
  });
});

test('declaring an id that is already active returns already-exists', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const first = await declarations.declare(declareInputFor('repo-5'), OPERATOR);
    assert.equal(first.ok, true);
    const second = await declarations.declare(declareInputFor('repo-5'), OPERATOR);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, 'already-exists');
  });
});

test('re-declaring an id whose orphaned clone is dirty returns adoption-refused naming the blockers', async () => {
  await withMigratedVolume(async (volume) => {
    const dirtyVerdict: SafeToEvictVerdict = { safe: false, blockers: [{ kind: 'worktree-dirty' }] };
    const declarations = declarationsFor(volume, {
      adoptionCheck: { observedRemote: async () => null, isSafeToAdopt: async () => dirtyVerdict },
    });

    const declared = await declarations.declare(declareInputFor('repo-6'), OPERATOR);
    assert.equal(declared.ok, true);

    const orphaned = await declarations.orphan('repo-6' as DeclareInput['id'], OPERATOR);
    assert.equal(orphaned.ok, true);

    const readopted = await declarations.declare(declareInputFor('repo-6'), OPERATOR);
    assert.equal(readopted.ok, false);
    if (!readopted.ok) {
      assert.equal(readopted.error.code, 'adoption-refused');
      if (readopted.error.code === 'adoption-refused') {
        assert.deepEqual(readopted.error.blockers, [{ kind: 'worktree-dirty' }]);
      }
    }
  });
});

test('re-declaring an id whose orphaned clone points at a different remote returns remote-mismatch', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume, {
      adoptionCheck: {
        observedRemote: async () => 'https://github.com/example/elsewhere.git' as never,
        isSafeToAdopt: async () => ({ safe: true }),
      },
    });

    const declared = await declarations.declare(declareInputFor('repo-6b'), OPERATOR);
    assert.equal(declared.ok, true);
    const orphaned = await declarations.orphan('repo-6b' as DeclareInput['id'], OPERATOR);
    assert.equal(orphaned.ok, true);

    const readopted = await declarations.declare(declareInputFor('repo-6b'), OPERATOR);
    assert.equal(readopted.ok, false);
    if (!readopted.ok) assert.equal(readopted.error.code, 'remote-mismatch');
  });
});

test('declaration.remove refuses while a clone remains, and succeeds once it does not', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const declared = await declarations.declare(declareInputFor('repo-7'), OPERATOR);
    assert.equal(declared.ok, true);

    upsertCloneRow(volume, 'repo-7', 'ready');

    const orphaned = await declarations.orphan('repo-7' as DeclareInput['id'], OPERATOR);
    assert.equal(orphaned.ok, true);

    const removed = await declarations.remove('repo-7' as DeclareInput['id'], OPERATOR);
    assert.equal(removed.ok, false);
    if (!removed.ok) assert.equal(removed.error.code, 'clone-still-present');

    upsertCloneRow(volume, 'repo-7', 'absent');
    const removedAgain = await declarations.remove('repo-7' as DeclareInput['id'], OPERATOR);
    assert.equal(removedAgain.ok, true);
  });
});

test('declaration.remove on an active declaration returns not-orphaned', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const declared = await declarations.declare(declareInputFor('repo-8'), OPERATOR);
    assert.equal(declared.ok, true);
    const removed = await declarations.remove('repo-8' as DeclareInput['id'], OPERATOR);
    assert.equal(removed.ok, false);
    if (!removed.ok) assert.equal(removed.error.code, 'not-orphaned');
  });
});
