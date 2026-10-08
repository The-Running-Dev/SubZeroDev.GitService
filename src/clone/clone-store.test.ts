import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { createAudit } from '../audit/audit.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createExec, type CredentialBinding, type Exec, type ExecRequest, type ExecResult } from '../exec/exec.ts';
import { execError, type ExecError } from '../exec/errors.ts';
import { createLocks } from '../locks/locks.ts';
import { ok, type Outcome } from '../shared/outcome.ts';
import type { CredentialResolver } from '../credentials/credentials.ts';
import type { DeclarationId, EnvVarName, OperationId } from '../shared/brands.ts';
import type { DeploymentCeiling } from '../contract/capabilities.ts';
import { createDeclarations, type Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import type { Journal } from '../journal/journal.ts';
import type { OperationJournalEntry } from '../journal/types.ts';
import type { MaintenanceReason } from '../shared/retention.ts';
import { createCloneStore } from './clone-store.ts';
import { createBareGitRemote } from './testing/git-fixture.ts';

/** A `statfsSync`-shaped reading that reports `usedPercent` above `pct`, for a volume small enough that `bfree`/`bavail` stay integers. No reserved blocks on this fixture, so `bfree` equals `bavail`. */
function diskStatsAtPercent(pct: number): () => { readonly blocks: number; readonly bsize: number; readonly bfree: number; readonly bavail: number } {
  const blocks = 1000;
  const bsize = 1;
  const bavail = Math.max(0, Math.round(blocks * (1 - pct / 100)));
  return () => ({ blocks, bsize, bfree: bavail, bavail });
}

const OPERATOR = { kind: 'operator' as const, subject: 'op' as never, clientId: null, grantId: null };

function fixtureDeclaration(id: string, cloneUrl: string): Declaration {
  return {
    id: id as Declaration['id'],
    generation: 1 as Declaration['generation'],
    cloneUrl: cloneUrl as Declaration['cloneUrl'],
    host: 'generic',
    // S44.1: a clone with no resolver wired is anonymous only for a null ref, which the type forbids and the clone path still honours.
    credentialRef: null as unknown as Declaration['credentialRef'],
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

test('ensure() resolves and passes the declaration credential to the initial clone (issue #178)', async () => {
  await withMigratedVolume(async (volume) => {
    const remote = createBareGitRemote();
    const declaration = { ...fixtureDeclaration('repo-credentialed', remote), credentialRef: 'ref-178' as Declaration['credentialRef'] };
    const real = createExec({ volumeRoot: volume });
    let cloneCredential: CredentialBinding | null = null;
    const exec: Exec = {
      ...real,
      async runGit(request) {
        if (request.argv[0] === 'clone') cloneCredential = request.credential;
        return real.runGit(request);
      },
    };
    const locks = createLocks();
    const credentialEnv = new Map<EnvVarName, string>();
    const binding: CredentialBinding = {
      ref: declaration.credentialRef,
      declarationId: declaration.id,
      variableName: 'SZG_CREDENTIAL_FIXTURE_178' as EnvVarName,
      username: null,
    };
    const credentials: Pick<CredentialResolver, 'allowedHosts' | 'resolveInto'> = {
      async allowedHosts() {
        return ok([]);
      },
      async resolveInto(_ref, _declarationId, env) {
        env.set(binding.variableName, 'secret-value');
        return ok(binding);
      },
    };

    const cloneStore = createCloneStore({
      volumeRoot: volume,
      clock: systemClock,
      exec,
      locks,
      declarations: declarationsStubFor(declaration),
      credentials,
      credentialEnv,
    });

    const result = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(result.ok, true);
    if (result.ok) result.value.materialisationLock.release();

    // Before the fix, the initial clone hardcoded `credential: null`,
    // silently ignoring a valid, resolved credential — issue #178.
    assert.deepEqual(cloneCredential, binding);
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
    // S44.1: the stored row carries a real credential reference, so a first clone needs a resolver that can honour it.
    const binding: CredentialBinding = { ref: 'unused' as CredentialBinding['ref'], declarationId: declarationId as DeclarationId, variableName: 'SZG_CREDENTIAL_FIXTURE_ORPHAN' as EnvVarName, username: null };
    const credentials: Pick<CredentialResolver, 'allowedHosts' | 'resolveInto'> = {
      async allowedHosts() {
        return ok([]);
      },
      async resolveInto(_ref, _declarationId, env) {
        env.set(binding.variableName, 'secret-value');
        return ok(binding);
      },
    };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations, credentials, credentialEnv: new Map<EnvVarName, string>() });

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

test('isSafeToEvict refuses a clone holding unpushed commits on a branch that is not checked out (issue #264)', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-other-branch-unpushed', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();
    const clonePath = ensured.value.clone.path;

    // A commit sitting on a branch that is not checked out — the checked-out
    // branch (`main`) stays clean throughout.
    const branchResult = await exec.runGit({ argv: ['checkout', '-b', 'side-branch'], cwd: clonePath as never, timeoutSeconds: 30, credential: null, signal: noopSignal() });
    assert.equal(branchResult.ok, true);
    writeFileSync(path.join(clonePath, 'unpushed.txt'), 'local only, on a branch nobody checked back out of\n', 'utf8');
    const addResult = await exec.runGit({ argv: ['add', 'unpushed.txt'], cwd: clonePath as never, timeoutSeconds: 30, credential: null, signal: noopSignal() });
    assert.equal(addResult.ok, true);
    const commitResult = await exec.runGit({
      argv: ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'unpushed work on side-branch'],
      cwd: clonePath as never,
      timeoutSeconds: 30,
      credential: null,
      signal: noopSignal(),
    });
    assert.equal(commitResult.ok, true);
    const backToMainResult = await exec.runGit({ argv: ['checkout', 'main'], cwd: clonePath as never, timeoutSeconds: 30, credential: null, signal: noopSignal() });
    assert.equal(backToMainResult.ok, true);

    const verdict = await cloneStore.isSafeToEvict(declaration.id, false);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.value.safe, false, `expected the side-branch commit to block eviction, got ${JSON.stringify(verdict.value)}`);
    if (verdict.value.safe) return;
    assert.ok(
      verdict.value.blockers.some((b) => b.kind === 'unreachable-commits'),
      `expected unreachable-commits for the non-checked-out branch, got ${JSON.stringify(verdict.value.blockers)}`,
    );
  });
});

test('the eviction interlock evaluates origin/<base> from the declaration, so a repository whose base branch is not main is not reported corrupt', async () => {
  await withMigratedVolume(async (volume) => {
    // A remote with no `main` at all. The hardcoded `origin/main..HEAD` this
    // replaces exited non-zero here, which `computeBlockers` reads as
    // `'corrupt'` — so every such declaration reported `corrupt-tree` and was
    // permanently unevictable and unremovable without the override.
    const dir = mkdtempSync(path.join(tmpdir(), 'szg-trunk-remote-'));
    const bareDir = path.join(dir, 'remote.git');
    const workDir = path.join(dir, 'work');
    gitIn(['init', '--bare', '--initial-branch=trunk', bareDir], dir);
    gitIn(['init', '--initial-branch=trunk', workDir], dir);
    gitIn(['remote', 'add', 'origin', bareDir], workDir);
    writeFileSync(path.join(workDir, 'README.md'), 'fixture\n', 'utf8');
    gitIn(['add', 'README.md'], workDir);
    gitIn(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial'], workDir);
    gitIn(['push', 'origin', 'trunk'], workDir);

    const declaration = fixtureDeclaration('repo-trunk', bareDir);
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({
      volumeRoot: volume,
      clock: systemClock,
      exec,
      locks,
      declarations: declarationsStubFor(declaration),
      // Stands in for the composition root's wiring to
      // `GitOperations.loadRepositoryConfig`. What is under test here is that
      // the clone store *uses* the declaration's base rather than assuming
      // one; reading it out of `.config/subzerodev-git.json` is git
      // operations' own, and tested there.
      baseBranchFor: async () => 'trunk' as never,
    });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();

    const verdict = await cloneStore.isSafeToEvict(declaration.id, false);
    assert.equal(verdict.ok, true, 'a readable clone on a non-main base is evaluated, not refused as unreadable');
    if (!verdict.ok) return;
    assert.equal(verdict.value.safe, true, `a clean trunk-based clone is safe to evict, not blocked; got ${JSON.stringify(verdict.value)}`);
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

test('computeBlockers reads a detached HEAD as no branch, not the literal string "HEAD" (issue #60)', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-detached', createBareGitRemote());
    const real = createExec({ volumeRoot: volume });
    const locks = createLocks();

    // Real git never lets `@{u}` succeed with no current branch to carry an
    // upstream, which is exactly why this defect was latent (issue #60's own
    // analysis). Forcing `@{u}` to report commits ahead here isolates the one
    // thing under test — whether `computeBlockers` normalises a detached
    // `--abbrev-ref HEAD` the same way `observeInternal`/`currentBranch`
    // already do — from that real-git precondition.
    const detachedWithForcedUpstream: Exec = {
      ...real,
      async runGit(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>> {
        if (request.argv[0] === 'rev-parse' && request.argv[1] === '--abbrev-ref' && request.argv[2] === 'HEAD') {
          return ok({ exitCode: 0, stdout: 'HEAD\n', stderr: '', durationMs: 0, timedOut: false });
        }
        if (request.argv[0] === 'rev-list' && request.argv[1] === '--count' && request.argv[2] === '@{u}..HEAD') {
          return ok({ exitCode: 0, stdout: '3\n', stderr: '', durationMs: 0, timedOut: false });
        }
        return real.runGit(request);
      },
    };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: detachedWithForcedUpstream, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();

    const verdict = await cloneStore.isSafeToEvict(declaration.id, false);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    if (verdict.value.safe) return; // no blockers at all also satisfies "no branch-ahead-of-upstream blocker naming 'HEAD'"
    const branchAhead = verdict.value.blockers.find((b) => b.kind === 'branch-ahead-of-upstream');
    assert.equal(branchAhead, undefined, `a detached HEAD must never surface as a branch name: ${JSON.stringify(branchAhead)}`);
  });
});

function gitIn(args: readonly string[], cwd: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('#78 — isClean reports clean:true for a freshly materialised clone with nothing changed', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-clean', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();

    const verdict = await cloneStore.isClean(declaration.id);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.deepEqual(verdict.value, { clean: true });
  });
});

test('#78 — isClean observes real Git state, not Clone.state — a `ready` clone with an actually dirty tree reports each kind of change it finds', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-dirty', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    const clonePath = ensured.value.clone.path as unknown as string;

    // A stash entry left behind by earlier work — pushed first, and from its
    // own change, so it neither depends on nor disturbs the dirty state built
    // below.
    writeFileSync(path.join(clonePath, 'stashed.md'), 'stash me\n', 'utf8');
    gitIn(['add', 'stashed.md'], clonePath);
    gitIn(['stash', 'push', '-m', 'fixture stash'], clonePath);

    // A modified tracked file, unstaged...
    writeFileSync(path.join(clonePath, 'README.md'), 'modified content\n', 'utf8');
    // ...a staged new file...
    writeFileSync(path.join(clonePath, 'staged.md'), 'new file, staged\n', 'utf8');
    gitIn(['add', 'staged.md'], clonePath);
    // ...and an untracked file.
    writeFileSync(path.join(clonePath, 'untracked.md'), 'new file, untracked\n', 'utf8');

    // `describe()` still reports the lifecycle state alone — `ready` — which
    // is exactly the defect issue #78 names: a lifecycle state is not a
    // clean-tree check.
    const described = await cloneStore.describe(declaration.id);
    assert.equal(described.ok, true);
    if (described.ok) assert.equal(described.value.state, 'ready');

    const verdict = await cloneStore.isClean(declaration.id);
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.value.clean, false);
    if (verdict.value.clean) return;
    const kinds = verdict.value.blockers.map((b) => b.kind).sort();
    assert.deepEqual(kinds, ['modified', 'stash-present', 'staged', 'untracked'].sort(), `got blockers: ${JSON.stringify(verdict.value.blockers)}`);
  });
});

test('#78 — isClean fails closed: a failed git status check reports an error, never clean:true', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-isclean-failclosed', createBareGitRemote());
    const real = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: real, locks, declarations: declarationsStubFor(declaration) });

    const ensured = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();

    const flaky: Exec = {
      ...real,
      async runGit(request: ExecRequest): Promise<Outcome<ExecResult, ExecError>> {
        if (request.argv[0] === 'status') {
          return { ok: false, error: execError({ code: 'nonzero-exit', exitCode: 1, stderr: 'simulated status failure' }, 'forced failure for test') };
        }
        return real.runGit(request);
      },
    };
    const flakyCloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: flaky, locks, declarations: declarationsStubFor(declaration) });

    const verdict = await flakyCloneStore.isClean(declaration.id);
    assert.equal(verdict.ok, false, 'a git command that cannot be verified must refuse, never report clean:true');
    if (!verdict.ok) assert.equal(verdict.error.code, 'corrupt-tree');
  });
});

test('#78 — isClean on a declaration with no materialised clone reports an error, not clean:true (S44.5: and not needs-attention)', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-isclean-absent', createBareGitRemote());
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations: declarationsStubFor(declaration) });

    const verdict = await cloneStore.isClean(declaration.id);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.notEqual(verdict.error.code, 'needs-attention');
  });
});

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

test('S27.2 — at the refuse watermark, ensure() refuses a fresh materialisation with disk-full naming all five consumers, the seventeen-table breakdown, and the blocking declaration', async () => {
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
    assert.equal(tableFindings.length, 17, 'the structured-store breakdown names all seventeen tables');

    const blockedFindings = findings.filter((f) => f.path === 'volume.evictionBlocked');
    assert.ok(blockedFindings.some((f) => f.rule === blockingDeclaration.id), 'the declaration whose clone blockers prevented release is named');
    assert.ok(blockedFindings.every((f) => f.rule !== newDeclaration.id), 'the never-materialised declaration is not itself reported as a blocker');

    if (result.error.code === 'disk-full') {
      assert.ok(result.error.usage.usedPercent >= 96, 'the reported usage reflects the forced reading');
      assert.ok(result.error.evictionBlockers.length > 0);
    }
  });
});

test('2026-08-13 post-S27 reconciliation — audit-log, backups-and-snapshots and watcher-files carry real bytes once their owning module is wired, honest zeros otherwise', async () => {
  await withMigratedVolume(async (volume) => {
    const exec = createExec({ volumeRoot: volume });
    const locks = createLocks();
    const declaration = fixtureDeclaration('repo-usage', createBareGitRemote());
    const declarations = declarationsStubFor(declaration);

    const unwired = createCloneStore({ volumeRoot: volume, clock: systemClock, exec, locks, declarations });
    const beforeWiring = await unwired.readVolumeUsage();
    assert.equal(beforeWiring.ok, true);
    if (!beforeWiring.ok) return;
    assert.equal(beforeWiring.value.byConsumer['audit-log'], 0, 'unwired: audit-log stays an honest zero');
    assert.equal(beforeWiring.value.byConsumer['backups-and-snapshots'], 0, 'unwired: backups-and-snapshots stays an honest zero');
    assert.equal(beforeWiring.value.byConsumer['watcher-files'], 0, 'unwired: watcher-files stays an honest zero');

    // Real bytes on disk for each of the three: an audit segment, a
    // structured-store backup, and a watcher inbox file.
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    await audit.append({
      at: systemClock.now(),
      operationId: null,
      declarationId: null,
      generation: null,
      tool: null,
      actorRef: { kind: 'operator', subject: 'ben' as never, clientId: null, grantId: null },
      context: 'recovery',
      form: 'lease-takeover',
      previousHolder: { instanceId: 'prev', bootId: 'prev', hostName: 'prev', startedAt: '2026-01-01T00:00:00.000Z' as never },
    } as never);

    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate(); // takes its own insurance pre-migration backup

    mkdirSync(path.join(volume, 'watcher-inboxes', 'repo-usage'), { recursive: true });
    writeFileSync(path.join(volume, 'watcher-inboxes', 'repo-usage', 'plan.md'), 'hello', 'utf8');

    const wired = createCloneStore({
      volumeRoot: volume,
      clock: systemClock,
      exec,
      locks,
      declarations,
      audit,
      store,
      watcherUsageBytes: async () => Buffer.byteLength('hello', 'utf8'),
    });
    const afterWiring = await wired.readVolumeUsage();
    assert.equal(afterWiring.ok, true);
    if (!afterWiring.ok) return;
    assert.ok(afterWiring.value.byConsumer['audit-log'] > 0, 'wired: audit-log is the real segment-directory total');
    assert.ok(afterWiring.value.byConsumer['backups-and-snapshots'] > 0, 'wired: backups-and-snapshots is the real backups/ total');
    assert.equal(afterWiring.value.byConsumer['watcher-files'], Buffer.byteLength('hello', 'utf8'), 'wired: watcher-files is exactly what the callback reported');

    await store.close();
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

/** Credentialed declaration for the S44.1 cases. */
function credentialedDeclaration(id: string, cloneUrl: string): Declaration {
  return { ...fixtureDeclaration(id, cloneUrl), credentialRef: 'ref-s44' as Declaration['credentialRef'] };
}

function cloneRowState(volume: string, declarationId: string): string | null {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  try {
    const row = db.prepare('SELECT state FROM clone WHERE declaration_id = ?').get(declarationId) as { state: string } | undefined;
    return row?.state ?? null;
  } finally {
    db.close();
  }
}

function setCloneRowState(volume: string, declarationId: string, state: string): void {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  try {
    db.prepare('UPDATE clone SET state = ? WHERE declaration_id = ?').run(state, declarationId);
  } finally {
    db.close();
  }
}

test('S44.1 — a credential that cannot be resolved aborts the first clone under its own result kind and leaves no directory', async () => {
  await withMigratedVolume(async (volume) => {
    const real = createExec({ volumeRoot: volume });
    const counting = countingExec(real);
    const locks = createLocks();

    // No resolver configured at all.
    const noResolver = credentialedDeclaration('repo-s44-no-resolver', createBareGitRemote());
    const storeWithoutResolver = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks, declarations: declarationsStubFor(noResolver) });
    const first = await storeWithoutResolver.ensure(noResolver, fixtureHolder(noResolver.id), noopSignal());
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.error.resultKind, 'infrastructure');
    assert.equal(existsSync(path.join(volume, 'clones', noResolver.id)), false, 'no directory is left behind');
    assert.equal(counting.cloneCount, 0, 'git was never invoked');

    // A reference that is not permitted to reach the declared host.
    const credentialEnv = new Map<EnvVarName, string>();
    const notPermitted: Pick<CredentialResolver, 'allowedHosts' | 'resolveInto'> = {
      async allowedHosts() {
        return ok([]);
      },
      async resolveInto() {
        throw new Error('must not resolve a secret for a host the reference is not permitted to reach');
      },
    };
    const hostDeclaration = credentialedDeclaration('repo-s44-not-permitted', 'https://example.invalid/repo.git');
    const permissionStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks, declarations: declarationsStubFor(hostDeclaration), credentials: notPermitted, credentialEnv });
    const second = await permissionStore.ensure(hostDeclaration, fixtureHolder(hostDeclaration.id), noopSignal());
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.resultKind, 'authorization');
    assert.equal(existsSync(path.join(volume, 'clones', hostDeclaration.id)), false);
    assert.equal(counting.cloneCount, 0, 'git was never invoked');

    // A secret that is unavailable: the resolver's own error, kind and all.
    const unavailable: Pick<CredentialResolver, 'allowedHosts' | 'resolveInto'> = {
      async allowedHosts() {
        return ok([]);
      },
      async resolveInto() {
        return { ok: false, error: { resultKind: 'precondition', retryable: false, summary: 'secret unavailable' } } as never;
      },
    };
    const secretDeclaration = credentialedDeclaration('repo-s44-unavailable', createBareGitRemote());
    const secretStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks, declarations: declarationsStubFor(secretDeclaration), credentials: unavailable, credentialEnv });
    const third = await secretStore.ensure(secretDeclaration, fixtureHolder(secretDeclaration.id), noopSignal());
    assert.equal(third.ok, false);
    if (!third.ok) {
      assert.equal(third.error.resultKind, 'precondition');
      assert.equal(third.error.summary, 'secret unavailable');
    }
    assert.equal(existsSync(path.join(volume, 'clones', secretDeclaration.id)), false);
    assert.equal(counting.cloneCount, 0, 'git was never invoked');

    // Every abort released the lock, and an explicit null ref clones anonymously with no resolver.
    const anonymous = fixtureDeclaration('repo-s44-anonymous', createBareGitRemote());
    const anonymousStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks, declarations: declarationsStubFor(anonymous) });
    const cloned = await anonymousStore.ensure(anonymous, fixtureHolder(anonymous.id), noopSignal());
    assert.equal(cloned.ok, true);
    if (cloned.ok) cloned.value.materialisationLock.release();
    const retried = await storeWithoutResolver.ensure(noResolver, fixtureHolder(noResolver.id), noopSignal());
    assert.equal(retried.ok, false, 'a released lock is acquired again and refuses for the same reason, not for a stuck lock');
    if (!retried.ok) assert.equal(retried.error.resultKind, 'infrastructure');
  });
});

test('S44.2 — ensure() removes a directory left by a crash mid-clone instead of adopting it, and re-clones', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-s44-crash-ensure', createBareGitRemote());
    const counting = countingExec(createExec({ volumeRoot: volume }));
    const locks = createLocks();
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks, declarations: declarationsStubFor(declaration) });

    const first = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(first.ok, true);
    if (!first.ok) return;
    first.value.materialisationLock.release();
    first.value.activePin.release();
    const clonePath = first.value.clone.path;
    assert.equal(counting.cloneCount, 1);

    // What a process killed between writing `materialising` and finishing the clone leaves: a readable tree under a `materialising` row.
    writeFileSync(path.join(clonePath, 'half-written.bin'), 'partial', 'utf8');
    setCloneRowState(volume, declaration.id, 'materialising');

    const second = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(second.ok, true);
    if (!second.ok) return;
    second.value.materialisationLock.release();
    second.value.activePin.release();
    assert.equal(counting.cloneCount, 2, 'the crash directory was not adopted, the clone was redone');
    assert.equal(second.value.clone.state, 'ready');
    assert.equal(existsSync(path.join(clonePath, 'half-written.bin')), false, 'the partial tree is gone');
  });
});

test('S44.2 — boot re-derivation removes a crash-mid-clone directory, and the next ensure() re-clones', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-s44-crash-boot', createBareGitRemote());
    const counting = countingExec(createExec({ volumeRoot: volume }));
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks: createLocks(), declarations: declarationsStubFor(declaration) });

    const first = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(first.ok, true);
    if (!first.ok) return;
    first.value.materialisationLock.release();
    first.value.activePin.release();
    const clonePath = first.value.clone.path;
    setCloneRowState(volume, declaration.id, 'materialising');

    // "Restart": a fresh store over the same volume and a fresh lock table.
    const restarted = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: counting.exec, locks: createLocks(), declarations: declarationsStubFor(declaration) });
    const derived = await restarted.deriveAllStatesFromDisk();
    assert.equal(derived.find((clone) => clone.declarationId === declaration.id)?.state, 'absent');
    assert.equal(existsSync(clonePath), false, 'the crash directory was removed, not adopted as ready');
    assert.equal(cloneRowState(volume, declaration.id), 'absent');

    const again = await restarted.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(again.ok, true);
    if (again.ok) again.value.materialisationLock.release();
    assert.equal(counting.cloneCount, 2, 'the next ensure re-cloned');
  });
});

test('S44.2 — boot re-derivation leaves a materialising directory alone while its ensure still holds the lock', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-s44-in-flight', createBareGitRemote());
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: createExec({ volumeRoot: volume }), locks: createLocks(), declarations: declarationsStubFor(declaration) });

    const first = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(first.ok, true);
    if (!first.ok) return;
    setCloneRowState(volume, declaration.id, 'materialising');

    // `first` still holds the materialisation lock: a clone in flight, not wreckage.
    await cloneStore.deriveAllStatesFromDisk();
    assert.equal(existsSync(first.value.clone.path), true);
    assert.equal(cloneRowState(volume, declaration.id), 'materialising');
    first.value.materialisationLock.release();
    first.value.activePin.release();
  });
});

test('S44.3 — a lock refusal inside ensure() is a conflict', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-s44-busy', createBareGitRemote());
    const cloneStore = createCloneStore({
      volumeRoot: volume,
      clock: systemClock,
      exec: createExec({ volumeRoot: volume }),
      locks: createLocks(),
      declarations: declarationsStubFor(declaration),
      materialisationLockAcquireMs: 20,
    });

    const holding = await cloneStore.ensure(declaration, fixtureHolder(declaration.id), noopSignal());
    assert.equal(holding.ok, true);
    if (!holding.ok) return;

    const refused = await cloneStore.ensure(declaration, { ...fixtureHolder(declaration.id), operationId: 'op-2' as never }, noopSignal());
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.error.resultKind, 'conflict');
    }
    holding.value.materialisationLock.release();
    holding.value.activePin.release();
  });
});

test('S44.4 — isSafeToEvict counts unsettled entries from every generation only when asked to', async () => {
  await withMigratedVolume(async (volume) => {
    const generationTwo: Declaration = { ...fixtureDeclaration('repo-s44-generations', createBareGitRemote()), generation: 2 as Declaration['generation'] };
    const earlierEntry = { operationId: 'op-earlier-generation' as OperationId } as OperationJournalEntry;
    const journal: Pick<Journal, 'unsettled'> = {
      async unsettled(_id, generation) {
        return ok(generation === 1 ? [earlierEntry] : []);
      },
    };
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: createExec({ volumeRoot: volume }), locks: createLocks(), declarations: declarationsStubFor(generationTwo), journal });

    const ensured = await cloneStore.ensure(generationTwo, fixtureHolder(generationTwo.id), noopSignal());
    assert.equal(ensured.ok, true);
    if (!ensured.ok) return;
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();
    assert.equal(ensured.value.clone.generation, 2);

    const acrossAll = await cloneStore.isSafeToEvict(generationTwo.id, true);
    assert.equal(acrossAll.ok, true);
    if (acrossAll.ok) {
      assert.equal(acrossAll.value.safe, false);
      if (!acrossAll.value.safe) assert.deepEqual(acrossAll.value.blockers, [{ kind: 'open-journal-entry', operationId: earlierEntry.operationId }]);
    }

    const storedOnly = await cloneStore.isSafeToEvict(generationTwo.id, false);
    assert.equal(storedOnly.ok, true);
    if (storedOnly.ok) assert.equal(storedOnly.value.safe, true);
  });
});

test('S44.5 — no path reports needs-attention for a clone with no row and no directory', async () => {
  await withMigratedVolume(async (volume) => {
    const declaration = fixtureDeclaration('repo-s44-nothing', createBareGitRemote());
    const cloneStore = createCloneStore({ volumeRoot: volume, clock: systemClock, exec: createExec({ volumeRoot: volume }), locks: createLocks(), declarations: declarationsStubFor(declaration) });

    const results = [
      await cloneStore.observeGitState(declaration.id),
      await cloneStore.isClean(declaration.id),
      await cloneStore.markAttention(declaration.id, 'nothing to mark'),
      await cloneStore.clearAttention(declaration.id, OPERATOR),
    ];
    for (const result of results) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.notEqual(result.error.code, 'needs-attention');
    }
    assert.equal(cloneRowState(volume, declaration.id), null, 'refusing wrote no row');
  });
});
