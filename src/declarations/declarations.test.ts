import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
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
    observedRemote: async () => ({ cloneExists: false }),
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
    // A clone that exists and matches the declared remote (so the remote
    // check itself passes cleanly) but whose working tree is dirty per
    // `isSafeToAdopt` — the case this test targets.
    const declarations = declarationsFor(volume, {
      adoptionCheck: {
        observedRemote: async () => ({ cloneExists: true, remote: `https://github.com/example/repo-6.git` as never }),
        isSafeToAdopt: async () => dirtyVerdict,
      },
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
        observedRemote: async () => ({ cloneExists: true, remote: 'https://github.com/example/elsewhere.git' as never }),
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

test('re-declaring an id whose orphaned clone exists but whose remote could not be verified is refused, not silently adopted', async () => {
  await withMigratedVolume(async (volume) => {
    // `cloneExists: true, remote: null` — a directory is present but its
    // origin is unreadable. Must refuse, not pass as "nothing to compare
    // against" (review finding #3).
    const declarations = declarationsFor(volume, {
      adoptionCheck: {
        observedRemote: async () => ({ cloneExists: true, remote: null }),
        isSafeToAdopt: async () => ({ safe: true }),
      },
    });

    const declared = await declarations.declare(declareInputFor('repo-6c'), OPERATOR);
    assert.equal(declared.ok, true);
    const orphaned = await declarations.orphan('repo-6c' as DeclareInput['id'], OPERATOR);
    assert.equal(orphaned.ok, true);

    const readopted = await declarations.declare(declareInputFor('repo-6c'), OPERATOR);
    assert.equal(readopted.ok, false);
    if (!readopted.ok) {
      assert.equal(readopted.error.code, 'adoption-refused');
      if (readopted.error.code === 'adoption-refused') {
        assert.deepEqual(readopted.error.blockers, [{ kind: 'corrupt-tree' }]);
      }
    }
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

test('declaration.remove refuses when a clone directory exists on disk with no row in the clone table', async () => {
  await withMigratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const declared = await declarations.declare(declareInputFor('repo-7b'), OPERATOR);
    assert.equal(declared.ok, true);

    // No row in `clone` at all — simulates `ensure()` dying before its first
    // write, or a row otherwise lost. Only the directory is evidence.
    mkdirSync(path.join(volume, 'clones', 'repo-7b'), { recursive: true });

    const orphaned = await declarations.orphan('repo-7b' as DeclareInput['id'], OPERATOR);
    assert.equal(orphaned.ok, true);

    const removed = await declarations.remove('repo-7b' as DeclareInput['id'], OPERATOR);
    assert.equal(removed.ok, false);
    if (!removed.ok) assert.equal(removed.error.code, 'clone-still-present');
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

/** An open, migrated store — `withMigratedVolume` closes its own, and these tests need one live to hold a transaction. */
async function withOpenStore<T>(fn: (volume: string, store: ReturnType<typeof createStructuredStore>) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    try {
      return await fn(volume, store);
    } finally {
      await store.close();
    }
  });
}

function grantEpochOnDisk(volume: string, declarationId: string): number {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  const rows = db.prepare('SELECT grant_epoch FROM declaration WHERE id = ?').all(declarationId) as unknown as { grant_epoch: number }[];
  db.close();
  return rows[0]?.grant_epoch ?? -1;
}

test('bumpGrantEpoch writes inside the caller transaction: a committed one raises the epoch, and the value returned is the new one', async () => {
  await withOpenStore(async (volume, store) => {
    const declarations = declarationsFor(volume);
    assert.equal((await declarations.declare(declareInputFor('repo-e1'), OPERATOR)).ok, true);
    const before = grantEpochOnDisk(volume, 'repo-e1');

    const result = await store.transaction(async (tx) => declarations.bumpGrantEpoch('repo-e1' as DeclareInput['id'], tx));
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(grantEpochOnDisk(volume, 'repo-e1'), before + 1, 'the increment committed with the caller');
    // The read-back is the half `run` alone could not deliver: a second
    // connection cannot see the caller's uncommitted increment, so it would
    // have returned the stale epoch — the one value this member exists for.
    assert.equal(result.value, before + 1, 'and the epoch returned is the one just written, not the value before it');
  });
});

test('bumpGrantEpoch writes inside the caller transaction: a rolled-back one leaves the epoch untouched', async () => {
  await withOpenStore(async (volume, store) => {
    const declarations = declarationsFor(volume);
    assert.equal((await declarations.declare(declareInputFor('repo-e2'), OPERATOR)).ok, true);
    const before = grantEpochOnDisk(volume, 'repo-e2');

    // The regression for the defect this member shipped with. Opening a
    // private connection here made the bump survive this rollback — every
    // outstanding grant invalidated for a change that never happened, and
    // this member returns `GrantEpoch` rather than an `Outcome`, so there is
    // no channel through which a caller could ever learn it.
    const result = await store.transaction(async (tx) => {
      declarations.bumpGrantEpoch('repo-e2' as DeclareInput['id'], tx);
      throw new Error('the caller failed after bumping the epoch');
    });
    assert.equal(result.ok, false, 'the transaction faulted, as the test intends');

    assert.equal(grantEpochOnDisk(volume, 'repo-e2'), before, 'the epoch rolled back with the caller');
  });
});
