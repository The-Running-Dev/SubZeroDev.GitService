import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createExec, type Exec, type ExecRequest, type ExecResult } from '../exec/exec.ts';
import { execError, type ExecError } from '../exec/errors.ts';
import { createLocks } from '../locks/locks.ts';
import type { Outcome } from '../shared/outcome.ts';
import type { DeclarationId } from '../shared/brands.ts';
import type { DeploymentCeiling } from '../contract/capabilities.ts';
import { createDeclarations, type Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import { createCloneStore } from './clone-store.ts';
import { createBareGitRemote } from './testing/git-fixture.ts';

const OPERATOR = { kind: 'operator' as const, subject: 'op' as never, clientId: null, grantId: null };

function fixtureDeclaration(id: string, cloneUrl: string): Declaration {
  return {
    id: id as Declaration['id'],
    generation: 1 as Declaration['generation'],
    cloneUrl: cloneUrl as Declaration['cloneUrl'],
    host: 'generic',
    credentialRef: 'unused' as Declaration['credentialRef'],
    capabilityGrant: new Set() as unknown as Declaration['capabilityGrant'],
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

function fixtureHolder(declarationId: string) {
  return {
    operationId: 'op-1' as never,
    declarationId: declarationId as DeclarationId,
    tool: 'fixture_tool' as never,
    heldSince: systemClock.now(),
  };
}

/** A `Declarations` view sufficient for `CloneStore`'s reverse lookup — no store-backed declaration exists in these tests, just the in-memory fixture. */
function declarationsStubFor(declaration: Declaration): Pick<Declarations, 'get'> {
  return {
    async get(id) {
      return id === declaration.id ? declaration : null;
    },
  };
}

function noopSignal(): AbortSignal {
  return new AbortController().signal;
}

/** The `clone` table `CloneStore` reads and writes only exists after migration 0001 runs — every test needs it applied first. */
async function withMigratedVolume<T>(fn: (volume: string) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();
    return fn(volume);
  });
}

interface CountingExec {
  readonly exec: Exec;
  cloneCount: number;
  forceNextCloneTimeout: boolean;
}

/** Counts `git clone` invocations and lets a test force the next one to time out, without waiting on a real slow clone. */
function countingExec(real: Exec): CountingExec {
  const state: CountingExec = {
    cloneCount: 0,
    forceNextCloneTimeout: false,
    exec: {
      ...real,
      async runGit(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>> {
        if (request.argv[0] === 'clone') {
          state.cloneCount += 1;
          if (state.forceNextCloneTimeout) {
            state.forceNextCloneTimeout = false;
            return { ok: false, error: execError({ code: 'timed-out', limitSeconds: 0 }, 'forced timeout for test') };
          }
        }
        return real.runGit(request);
      },
    },
  };
  return state;
}

test('describe() reports absent for a declared repository with no clone', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-a', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const described = await cloneStore.describe(declaration.id);
    assert.equal(described.ok, true);
    if (!described.ok) return;
    assert.equal(described.value.state, 'absent');
  });
});

test('ensure() clones on first use, and describe() then reports ready', async () => {
  await withMigratedVolume(async (volume) => {
    const remote = createBareGitRemote();
    const declaration = fixtureDeclaration('repo-b', remote);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const result = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.clone.state, 'ready');
    assert.ok(existsSync(path.join(result.value.clone.path, 'README.md')), 'the clone actually materialised on disk');
    result.value.materialisationLock.release();

    const described = await cloneStore.describe(declaration.id);
    assert.equal(described.ok, true);
    if (described.ok) assert.equal(described.value.state, 'ready');
  });
});

test('a clone exceeding the cap returns timeout and leaves the clone absent with the partial directory removed', async () => {
  await withMigratedVolume(async (volume) => {
    const remote = createBareGitRemote();
    const declaration = fixtureDeclaration('repo-timeout', remote);
    const real = createExec({ volumeRoot: volume });
    const counting = countingExec(real);
    counting.forceNextCloneTimeout = true;
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks, declarations: declarationsStubFor(declaration) });

    const result = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'clone-timeout');

    const described = await cloneStore.describe(declaration.id);
    assert.equal(described.ok, true);
    if (described.ok) {
      assert.equal(described.value.state, 'absent');
      assert.equal(existsSync(described.value.path), false, 'the partial directory was removed');
    }
  });
});

test('an existing clone whose remote differs from declared returns remote-mismatch and never repoints the checkout', async () => {
  await withMigratedVolume(async (volume) => {
    const declaredRemote = createBareGitRemote();
    const actualRemote = createBareGitRemote();
    const declaration = fixtureDeclaration('repo-mismatch', declaredRemote);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    // Materialise a directory pointed at a *different* remote than declared —
    // the state `ensure()` must find already on disk (an orphaned clone
    // adopted under a since-changed declaration, in the real flow).
    const clonePath = path.join(volume, 'clones', declaration.id);
    const setupResult = await exec.runGit({ argv: ['clone', '--', actualRemote, clonePath], cwd: volume as never, timeoutSeconds: 30, credential: null, signal: noopSignal() });
    assert.equal(setupResult.ok, true);

    const before = readdirSync(clonePath).sort();
    const beforeStat = statSync(path.join(clonePath, 'README.md'));

    const result = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'remote-mismatch');

    const after = readdirSync(clonePath).sort();
    const afterStat = statSync(path.join(clonePath, 'README.md'));
    assert.deepEqual(after, before, 'directory contents are byte-identical before and after');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'the file was never rewritten');
  });
});

test('a directory git will not read returns corrupt-tree naming clone.remove as the exit', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-corrupt', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const clonePath = path.join(volume, 'clones', declaration.id);
    mkdirSync(clonePath, { recursive: true });
    writeFileSync(path.join(clonePath, 'not-a-real-repo'), 'nope', 'utf8');

    const result = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'corrupt-tree');

    const actor = { kind: 'operator' as const, subject: 'op' as never, clientId: null, grantId: null };

    // `clone.remove` without the override refuses the same way, and the tree is untouched.
    const removeWithoutOverride = await cloneStore.remove(declaration.id, { permitCorruptTree: false }, actor);
    assert.equal(removeWithoutOverride.ok, false);
    if (!removeWithoutOverride.ok) assert.equal(removeWithoutOverride.error.code, 'corrupt-tree');
    assert.equal(existsSync(clonePath), true, 'refused without the override — nothing removed');

    // With the override, the corrupt tree is removed even though the
    // unreachable-commits predicate could never be computed on it.
    const removeWithOverride = await cloneStore.remove(declaration.id, { permitCorruptTree: true }, actor);
    assert.equal(removeWithOverride.ok, true);
    assert.equal(existsSync(clonePath), false, 'the override removed the unreadable tree');
  });
});

test('two concurrent ensure() calls against the same declaration produce exactly one clone; the second waits on the materialisation lock', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-concurrent', createBareGitRemote());
    const real = createExec({ volumeRoot: volume });
    const counting = countingExec(real);
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks, declarations: declarationsStubFor(declaration) });

    const first = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(first.ok, true);
    if (!first.ok) return;

    let secondResolved = false;
    const secondPromise = cloneStore
      .ensure(declaration, fixtureHolder(declaration.id), noopSignal())
      .then((r) => {
        secondResolved = true;
        return r;
      });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(secondResolved, false, 'the second caller is still waiting on the materialisation lock');

    first.value.materialisationLock.release();
    const second = await secondPromise;
    assert.equal(secondResolved, true);
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.value.clone.state, 'ready');
      second.value.materialisationLock.release();
    }

    assert.equal(counting.cloneCount, 1, 'exactly one clone happened');
  });
});

test('a clone of repository A does not block a read of repository B', async () => {
  await withMigratedVolume(async (volume) => {
    const declarationA = fixtureDeclaration('repo-a-slow', createBareGitRemote());
    const declarationB = fixtureDeclaration('repo-b-fast', createBareGitRemote());
    const real = createExec({ volumeRoot: volume });

    // A clone of A that never actually completes during the test — held via
    // the materialisation lock rather than a real slow subprocess, since a
    // real one would only prove timing on this host, not the property.
    const locks = createLocks();
    const declarations: Pick<Declarations, 'get'> = {
      async get(id) {
        if (id === declarationA.id) return declarationA;
        if (id === declarationB.id) return declarationB;
        return null;
      },
    };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: real, locks, declarations });

    const holderA = fixtureHolder(declarationA.id);
    const lockA = await locks.acquireMaterialisation(declarationA.id, holderA, 30_000, noopSignal());
    assert.equal(lockA.ok, true);

    // B's read (`describe`) takes no lock at all, so it must resolve immediately.
    const started = Date.now();
    const describedB = await cloneStore.describe(declarationB.id);
    const elapsedMs = Date.now() - started;
    assert.equal(describedB.ok, true);
    assert.ok(elapsedMs < 1000, `describe(B) returned in ${elapsedMs}ms, unblocked by A's held lock`);

    if (lockA.ok) lockA.value.release();
  });
});

/**
 * Inserted directly rather than through `Declarations.declare()`: `declare()`
 * re-validates `cloneUrl` against the https-or-scp-style pattern (the
 * "second, independent guard" `declarations.test.ts` covers), which a local
 * git fixture's bare path can never satisfy. This test is about
 * `Declarations.orphan()` leaving `CloneStore`'s directory alone, not about
 * `declare()`'s own format check, so a fixture row sidesteps it the same way
 * `declarations.test.ts`'s `clone-still-present` test does.
 */
function insertActiveDeclarationRow(volume: string, id: string, cloneUrl: string): void {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  const now = systemClock.now();
  db.prepare(
    `INSERT INTO declaration
       (id, generation, clone_url, host, credential_ref, capability_grant, writable_path_prefixes,
        pinned, content_drop_tool, content_drop_auto_merge, git_user_name, git_user_email,
        state, grant_epoch, created_at, updated_at)
     VALUES (?, 1, ?, 'generic', 'unused', '[]', '[]', 0, NULL, NULL, 'fixture', 'fixture@example.com', 'active', 0, ?, ?)`,
  ).run(id, cloneUrl, now, now);
  db.close();
}

test('orphaning marks the declaration orphaned and leaves the clone directory untouched on disk', async () => {
  await withMigratedVolume(async (volume) => {
    const remote = createBareGitRemote();
    const declarationId = 'repo-orphan';
    insertActiveDeclarationRow(volume, declarationId, remote);

    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const declarations = createDeclarations({
      volumeRoot: volume,
      clock: systemClock,
      remoteHostAllowlist: [],
      ceiling: new Set() as unknown as DeploymentCeiling,
      cloneAdoptionCheck: () => ({ observedRemote: async () => null, isSafeToAdopt: async () => ({ safe: true }) }),
    });
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations });

    const declaration = await declarations.get(declarationId as DeclarationId);
    assert.ok(declaration);
    if (!declaration) return;

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declarationId), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    const clonePath = ensured.value.clone.path;
    const readmeStat = statSync(path.join(clonePath, 'README.md'));

    const orphaned = await declarations.orphan(declarationId as DeclarationId, OPERATOR);
    assert.equal(orphaned.ok, true);
    if (orphaned.ok) assert.equal(orphaned.value.cloneLeftOnDisk, true);

    assert.equal(existsSync(clonePath), true, 'the clone directory still exists after orphaning');
    const readmeStatAfter = statSync(path.join(clonePath, 'README.md'));
    assert.equal(readmeStatAfter.mtimeMs, readmeStat.mtimeMs, 'and it was never rewritten');

    const describedAfter = await cloneStore.describe(declarationId as DeclarationId);
    assert.equal(describedAfter.ok, true);
    if (describedAfter.ok) assert.equal(describedAfter.value.state, 'ready', 'the clone metadata is unaffected by orphaning too');
  });
});

test('clone.remove refuses a tree holding commits unreachable from origin/<base>, override or not', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-unreachable', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    const clonePath = ensured.value.clone.path;

    // A local commit never pushed to `origin/main` — unreachable from it.
    writeFileSync(path.join(clonePath, 'unpushed.txt'), 'local only\n', 'utf8');
    const addResult = await exec.runGit({ argv: ['add', 'unpushed.txt'], cwd: clonePath as never, timeoutSeconds: 30, credential: null, signal: noopSignal() });
    assert.equal(addResult.ok, true);
    const commitResult = await exec.runGit({
      argv: ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'unpushed work'],
      cwd: clonePath as never,
      timeoutSeconds: 30,
      credential: null,
      signal: noopSignal(),
    });
    assert.equal(commitResult.ok, true);

    const actor = { kind: 'operator' as const, subject: 'op' as never, clientId: null, grantId: null };

    const withoutOverride = await cloneStore.remove(declaration.id, { permitCorruptTree: false }, actor);
    assert.equal(withoutOverride.ok, false);
    if (!withoutOverride.ok) {
      assert.equal(withoutOverride.error.code, 'not-safe-to-remove');
      if (withoutOverride.error.code === 'not-safe-to-remove') {
        assert.ok(withoutOverride.error.blockers.some((b) => b.kind === 'unreachable-commits'), `expected unreachable-commits, got ${JSON.stringify(withoutOverride.error.blockers)}`);
      }
    }

    // The override "permits only a tree git cannot read" — a readable tree
    // with unpushed commits is refused either way.
    const withOverride = await cloneStore.remove(declaration.id, { permitCorruptTree: true }, actor);
    assert.equal(withOverride.ok, false);
    if (!withOverride.ok) assert.equal(withOverride.error.code, 'not-safe-to-remove');

    assert.equal(existsSync(clonePath), true, 'nothing was removed on either attempt');
  });
});
