import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createExec, type Exec, type ExecRequest, type ExecResult } from '../exec/exec.ts';
import { execError, type ExecError } from '../exec/errors.ts';
import { createLocks } from '../locks/locks.ts';
import { ok, type Outcome } from '../shared/outcome.ts';
import type { DeclarationId, OperationId } from '../shared/brands.ts';
import type { DeploymentCeiling } from '../contract/capabilities.ts';
import { createDeclarations, type Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import type { Journal } from '../journal/journal.ts';
import type { OperationJournalEntry } from '../journal/types.ts';
import type { MaintenanceReason } from '../shared/retention.ts';
import { createCloneStore } from './clone-store.ts';
import { createBareGitRemote } from './testing/git-fixture.ts';

/** A `statfsSync`-shaped reading that reports `usedPercent` above `pct`, for a volume small enough that `bavail` stays an integer. */
function diskStatsAtPercent(pct: number): () => { readonly blocks: number; readonly bsize: number; readonly bavail: number } {
  const blocks = 1000;
  const bsize = 1;
  const bavail = Math.max(0, Math.round(blocks * (1 - pct / 100)));
  return () => ({ blocks, bsize, bavail });
}

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
    fileWatcher: null,
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
        pinned, file_watcher_plan_tool, file_watcher_apply_tool, file_watcher_auto_merge, git_user_name, git_user_email,
        state, grant_epoch, created_at, updated_at)
     VALUES (?, 1, ?, 'generic', 'unused', '[]', '[]', 0, NULL, NULL, NULL, 'fixture', 'fixture@example.com', 'active', 0, ?, ?)`,
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
      cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
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

test('ensure() reconciles a stale clone-row generation to the declaration actually passed in', async () => {
  await withMigratedVolume(async (volume) => {
    const remote = createBareGitRemote();
    const genOne = fixtureDeclaration('repo-regen', remote);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    // Both generations resolve to the same declaration id, so a single
    // `declarationsStubFor` swap is enough to represent "this id got
    // re-declared under a new generation" without exercising `declare()`.
    let current = genOne;
    const declarations: Pick<Declarations, 'get'> = { async get(id) { return id === current.id ? current : null; } };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations });

    const first = await cloneStore.ensure(genOne, fixtureHolder(genOne.id), noopSignal());
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.clone.generation, 1);
    first.value.materialisationLock.release();

    const genTwo: Declaration = { ...genOne, generation: 2 as Declaration['generation'] };
    current = genTwo;

    const second = await cloneStore.ensure(genTwo, fixtureHolder(genTwo.id), noopSignal());
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.clone.generation, 2, 'the ready-clone short-circuit reconciles to the passed declaration\'s generation');
    second.value.materialisationLock.release();

    const described = await cloneStore.describe(genOne.id);
    assert.equal(described.ok, true);
    if (described.ok) assert.equal(described.value.generation, 2, 'and the persisted row reflects it too');
  });
});

test('computeBlockers fails closed: a failed git status check refuses removal rather than reporting no blockers', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-failclosed', createBareGitRemote());
    const real = createExec({ volumeRoot: volume });
    const locks = createLocks();

    // A clean clone with no real safety issue at all — if the fail-open bug
    // were still present, `git status` failing would report zero blockers
    // and `remove()` would proceed to delete a perfectly fine clone.
    const flaky: Exec = {
      ...real,
      async runGit(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>> {
        if (request.argv[0] === 'status') {
          return { ok: false, error: execError({ code: 'nonzero-exit', exitCode: 1, stderr: 'simulated status failure' }, 'forced failure for test') };
        }
        return real.runGit(request);
      },
    };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: real, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();

    const flakyCloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: flaky, locks, declarations: declarationsStubFor(declaration) });
    const actor = { kind: 'operator' as const, subject: 'op' as never, clientId: null, grantId: null };
    const removed = await flakyCloneStore.remove(declaration.id, { permitCorruptTree: false }, actor);
    assert.equal(removed.ok, false, 'a git command that cannot be verified must refuse, not silently allow removal');
    if (!removed.ok) assert.equal(removed.error.code, 'not-safe-to-remove');
    assert.equal(existsSync(ensured.value.clone.path), true, 'nothing was removed while safety could not be established');
  });
});

function gitIn(args: readonly string[], cwd: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('20-contract.md § Clone, U8 — observeGitState succeeds against a deliberately unmerged index, which git write-tree would refuse', async () => {
  await withMigratedVolume(async (volume) => {
    const remote = createBareGitRemote();
    const declaration = fixtureDeclaration('repo-unmerged', remote);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    const clonePath = ensured.value.clone.path;
    ensured.value.materialisationLock.release();

    // Produce a real, unmerged index: two branches touching the same line,
    // merged into each other.
    gitIn(['config', 'user.name', 'fixture'], clonePath);
    gitIn(['config', 'user.email', 'fixture@example.com'], clonePath);
    gitIn(['checkout', '-b', 'branch-a'], clonePath);
    writeFileSync(path.join(clonePath, 'README.md'), 'branch-a\n', 'utf8');
    gitIn(['commit', '-am', 'branch-a change'], clonePath);
    gitIn(['checkout', 'main'], clonePath);
    gitIn(['checkout', '-b', 'branch-b'], clonePath);
    writeFileSync(path.join(clonePath, 'README.md'), 'branch-b\n', 'utf8');
    gitIn(['commit', '-am', 'branch-b change'], clonePath);
    const merge = gitIn(['merge', 'branch-a'], clonePath);
    assert.notEqual(merge.status, 0, 'the merge must actually conflict for this test to mean anything');

    // `git write-tree` refuses outright on an unmerged index — the exact
    // failure `indexDigest`'s algorithm (`git ls-files --stage`) must not
    // reproduce, since pre-state capture has to succeed on a tree in
    // exactly this state.
    const writeTree = gitIn(['write-tree'], clonePath);
    assert.notEqual(writeTree.status, 0, 'git write-tree must fail here, confirming the index really is unmerged');

    const lsFilesStage = gitIn(['ls-files', '--stage'], clonePath);
    assert.match(lsFilesStage.stdout, /\s[123]\t/, 'a real stage 1/2/3 entry is present in the index');

    const observed = await cloneStore.observeGitState(declaration.id);
    assert.equal(observed.ok, true, 'pre-state capture succeeds against the unmerged index that write-tree refuses');
    if (!observed.ok) return;
    assert.match(observed.value.indexDigest, /^[0-9a-f]{64}$/);
    assert.match(observed.value.worktreeDigest, /^[0-9a-f]{64}$/);
  });
});

test('a preState captured before a change goes stale: a fresh observeGitState() after the change reports different digests', async () => {
  await withMigratedVolume(async (volume) => {
    const remote = createBareGitRemote();
    const declaration = fixtureDeclaration('repo-stale-prestate', remote);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    const clonePath = ensured.value.clone.path;
    ensured.value.materialisationLock.release();

    // The dirty-tree starting point a mutating operation's pre-state would
    // capture — one path already changed and staged, mirroring the case a
    // boolean "clean" flag cannot represent.
    writeFileSync(path.join(clonePath, 'README.md'), 'first change\n', 'utf8');
    gitIn(['add', 'README.md'], clonePath);
    const capturedBeforeKill = await cloneStore.observeGitState(declaration.id);
    assert.equal(capturedBeforeKill.ok, true);
    if (!capturedBeforeKill.ok) return;

    // Simulate the operation being killed mid-way: a further change lands
    // that the captured `preState` above never saw and can never reflect,
    // because nothing ever wrote it back.
    writeFileSync(path.join(clonePath, 'README.md'), 'second change, after the kill\n', 'utf8');
    gitIn(['add', 'README.md'], clonePath);
    const observedAfterKill = await cloneStore.observeGitState(declaration.id);
    assert.equal(observedAfterKill.ok, true);
    if (!observedAfterKill.ok) return;

    assert.notEqual(
      capturedBeforeKill.value.indexDigest,
      observedAfterKill.value.indexDigest,
      'the captured pre-state and the freshly observed state disagree — a boolean clean flag could not represent this',
    );
  });
});

test('S27.2 — at the refuse watermark, ensure() refuses a fresh materialisation with disk-full naming all five consumers, the sixteen-table breakdown, and the blocking declaration', async () => {
  await withMigratedVolume(async (volume) => {
    const blockingRemote = createBareGitRemote();
    const blockingDeclaration = fixtureDeclaration('repo-blocking', blockingRemote);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const declarationsMap = new Map<string, Declaration>([[blockingDeclaration.id, blockingDeclaration]]);
    const declarationsView: Pick<Declarations, 'get'> = { async get(id) { return declarationsMap.get(id) ?? null; } };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsView });

    // Materialise one clone with real unpushed work — the declaration S27.2's
    // findings must name as a blocked-eviction candidate.
    const ensuredBlocking = await cloneStore.ensure(blockingDeclaration, fixtureHolder(blockingDeclaration.id), noopSignal());
    assert.equal(ensuredBlocking.ok, true);
    if (!ensuredBlocking.ok) return;
    ensuredBlocking.value.materialisationLock.release();
    writeFileSync(path.join(ensuredBlocking.value.clone.path, 'unpushed.txt'), 'local only\n', 'utf8');
    await exec.runGit({ argv: ['add', 'unpushed.txt'], cwd: ensuredBlocking.value.clone.path, timeoutSeconds: 30, credential: null, signal: noopSignal() });
    await exec.runGit({
      argv: ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'unpushed work'],
      cwd: ensuredBlocking.value.clone.path,
      timeoutSeconds: 30,
      credential: null,
      signal: noopSignal(),
    });

    // A second declaration, not yet materialised — the one whose `ensure()`
    // actually needs new space and is refused.
    const newRemote = createBareGitRemote();
    const newDeclaration = fixtureDeclaration('repo-new', newRemote);
    declarationsMap.set(newDeclaration.id, newDeclaration);
    const fullCloneStore = createCloneStore({
      volumeRoot: volume,
      clock: systemClock,
      exec,
      locks,
      declarations: declarationsView,
      readDiskStats: diskStatsAtPercent(96),
    });

    const result = await fullCloneStore.ensure(newDeclaration, fixtureHolder(newDeclaration.id), noopSignal());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'disk-full');
    assert.equal(existsSync(path.join(volume, 'clones', newDeclaration.id)), false, 'nothing was materialised for the refused declaration');

    const findings = result.error.findings ?? [];
    const consumerFindings = findings.filter((f) => f.path === 'volume.byConsumer');
    assert.equal(consumerFindings.length, 5, 'all five volume consumers are named');
    assert.deepEqual(
      consumerFindings.map((f) => f.rule).sort(),
      ['audit-log', 'backups-and-snapshots', 'clones', 'structured-store', 'watcher-files'].sort(),
    );

    const tableFindings = findings.filter((f) => f.path === 'volume.storeByTable');
    assert.equal(tableFindings.length, 16, 'the structured-store breakdown names all sixteen tables');

    const blockedFindings = findings.filter((f) => f.path === 'volume.evictionBlocked');
    assert.ok(blockedFindings.some((f) => f.rule === blockingDeclaration.id), 'the declaration whose clone blockers prevented release is named');
    assert.ok(blockedFindings.every((f) => f.rule !== newDeclaration.id), 'the never-materialised declaration is not itself reported as a blocker');

    if (result.error.code === 'disk-full') {
      assert.ok(result.error.usage.usedPercent >= 96, 'the reported usage reflects the forced reading');
      assert.ok(result.error.evictionBlockers.length > 0);
    }
  });
});

test('S27.3 — evictIfSafe refuses while activeOperationCount is non-zero, and again while the materialisation lock is held, without touching the tree', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-evict-busy', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    const readmeStat = statSync(path.join(ensured.value.clone.path, 'README.md'));

    // Rule 4: a non-zero active-operation count refuses without even
    // attempting the materialisation lock.
    const pin = locks.pinActiveOperation(declaration.id);
    const blockedByCount = await cloneStore.evictIfSafe(declaration.id);
    assert.equal(blockedByCount.ok, true);
    if (blockedByCount.ok) {
      assert.equal(blockedByCount.value.evicted, false);
      assert.ok(blockedByCount.value.blockers.some((b) => b.kind === 'active-operations'));
    }
    pin.release();

    // Rule 3: eviction takes the materialisation lock in its own right — held
    // elsewhere (a concurrent `ensure()`/mutation), it refuses rather than
    // waiting indefinitely or evicting regardless.
    const externalLock = await locks.acquireMaterialisation(declaration.id, fixtureHolder(declaration.id), 30_000, noopSignal());
    assert.equal(externalLock.ok, true);
    const blockedByLock = await cloneStore.evictIfSafe(declaration.id);
    assert.equal(blockedByLock.ok, true);
    if (blockedByLock.ok) {
      assert.equal(blockedByLock.value.evicted, false);
      assert.ok(blockedByLock.value.blockers.some((b) => b.kind === 'active-operations'), 'a held materialisation lock is reported the same shape as an active operation');
    }
    if (externalLock.ok) externalLock.value.release();

    assert.equal(existsSync(ensured.value.clone.path), true, 'the clone is untouched by either refused attempt');
    const readmeStatAfter = statSync(path.join(ensured.value.clone.path, 'README.md'));
    assert.equal(readmeStatAfter.mtimeMs, readmeStat.mtimeMs, 'byte-identical — never rewritten');
  });
});

test('S27.4 — an open journal entry blocks eviction and leaves the clone byte-identical', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-evict-journal', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const openEntry = { operationId: 'op-open' as OperationId } as OperationJournalEntry;
    const journal: Pick<Journal, 'unsettled'> = { async unsettled() { return ok([openEntry]); } };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration), journal });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();
    const readmeStat = statSync(path.join(ensured.value.clone.path, 'README.md'));

    const outcome = await cloneStore.evictIfSafe(declaration.id);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.value.evicted, false);
      assert.deepEqual(
        outcome.value.blockers.filter((b) => b.kind === 'open-journal-entry'),
        [{ kind: 'open-journal-entry', operationId: openEntry.operationId }],
      );
    }
    assert.equal(existsSync(ensured.value.clone.path), true);
    assert.equal(statSync(path.join(ensured.value.clone.path, 'README.md')).mtimeMs, readmeStat.mtimeMs, 'byte-identical — never rewritten');
  });
});

test('S27.5 — a safe clone is evicted with its real freed bytes, and the next ensure() rematerialises it from the declared remote', async () => {
  await withMigratedVolume(async (volume) => {
    const remote = createBareGitRemote();
    const declaration = fixtureDeclaration('repo-evict-safe', remote);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();
    const clonePath = ensured.value.clone.path;
    assert.ok(existsSync(path.join(clonePath, 'README.md')));

    const outcome = await cloneStore.evictIfSafe(declaration.id);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.value.evicted, true);
      assert.ok(outcome.value.freedBytes > 0, 'real bytes, not a placeholder zero');
    }
    assert.equal(existsSync(clonePath), false, 'the directory is actually gone');

    const describedAfterEviction = await cloneStore.describe(declaration.id);
    assert.equal(describedAfterEviction.ok, true);
    if (describedAfterEviction.ok) assert.equal(describedAfterEviction.value.state, 'evicted');

    const rematerialised = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(rematerialised.ok, true);
    if (rematerialised.ok) {
      assert.equal(rematerialised.value.clone.state, 'ready');
      assert.ok(existsSync(path.join(rematerialised.value.clone.path, 'README.md')), 're-cloned from the declared remote');
      rematerialised.value.materialisationLock.release();
    }
  });
});

test('requestMaintenance forwards the reason to onMaintenanceRequested without awaiting anything', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-req-maint', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const requested: MaintenanceReason[] = [];
    const cloneStore = createCloneStore({
      volumeRoot: volume,
      clock: systemClock,
      exec,
      locks,
      declarations: declarationsStubFor(declaration),
      onMaintenanceRequested: (reason) => requested.push(reason),
    });

    cloneStore.requestMaintenance('watermark');
    assert.deepEqual(requested, ['watermark']);
  });
});
