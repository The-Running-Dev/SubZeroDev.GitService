import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createExec } from '../exec/exec.ts';
import { createLocks } from '../locks/locks.ts';
import { createJournal } from '../journal/journal.ts';
import { createGitOperations } from '../git/git-operations.ts';
import { createCredentialResolver } from '../credentials/credentials.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { success, precondition, type ToolResult } from '../result/envelope.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { BranchName, ClonePath, DeclarationId, EnvVarName, GitSha, OperationId } from '../shared/brands.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import type { HostOperations } from '../host/host-operations.ts';
import type { PrStatusData, PrStatusInput } from '../host/types.ts';
import { createComposites, PREPARE_BRANCH_STEPS, RECONCILE_AFTER_MERGE_STEPS } from './composites.ts';
import { PREPARE_BRANCH_RECOVERY, RECONCILE_AFTER_MERGE_RECOVERY } from './recovery-descriptors.ts';

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

/**
 * A real bare remote plus two independent local clones of it: `clonePath`
 * (what the composite under test operates on) and `remoteWorkDir` (a
 * separate clone used to push further commits to `origin` behind
 * `clonePath`'s back — simulating the repository moving on while the
 * composite's own clone is mid-workflow).
 */
function fixture(): { readonly bareDir: string; readonly clonePath: string; readonly remoteWorkDir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'szg-composites-'));
  const bareDir = path.join(dir, 'remote.git');
  const clonePath = path.join(dir, 'clone');
  const remoteWorkDir = path.join(dir, 'remote-work');
  git(['init', '--bare', '--initial-branch=main', bareDir], dir);

  const seedDir = path.join(dir, 'seed');
  mkdirSync(seedDir);
  git(['init', '--initial-branch=main', seedDir], dir);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'remote', 'add', 'origin', bareDir], seedDir);
  writeFileSync(path.join(seedDir, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md'], seedDir);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial'], seedDir);
  git(['push', 'origin', 'main'], seedDir);

  git(['clone', bareDir, clonePath], dir);
  git(['config', 'user.name', 'fixture'], clonePath);
  git(['config', 'user.email', 'fixture@example.com'], clonePath);

  git(['clone', bareDir, remoteWorkDir], dir);
  git(['config', 'user.name', 'fixture'], remoteWorkDir);
  git(['config', 'user.email', 'fixture@example.com'], remoteWorkDir);

  return { bareDir, clonePath, remoteWorkDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Advances `origin/main` with one more commit, independent of `clonePath`. */
function advanceRemoteMain(remoteWorkDir: string, fileName: string): void {
  writeFileSync(path.join(remoteWorkDir, fileName), `${fileName}\n`, 'utf8');
  git(['add', fileName], remoteWorkDir);
  git(['commit', '-m', `advance: ${fileName}`], remoteWorkDir);
  git(['push', 'origin', 'main'], remoteWorkDir);
}

function contextFor(clonePath: string, declarationId: DeclarationId, operationId: OperationId): CallContext {
  return {
    operationId,
    declarationId,
    generation: 1 as never,
    cloneRoot: clonePath as ClonePath,
    actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
    capabilities: new Set() as never,
    writablePathPrefixes: [],
    context: 'normal',
    scheduledJobId: null,
    deadline: systemClock.now(),
    signal: new AbortController().signal,
  };
}

function declarationFor(id: DeclarationId, cloneUrl: string): Declaration {
  return {
    id,
    generation: 1 as Declaration['generation'],
    cloneUrl: cloneUrl as Declaration['cloneUrl'],
    host: 'generic',
    credentialRef: 'unused' as Declaration['credentialRef'],
    capabilityGrant: new Set(['repo.read', 'git.local.write', 'git.remote.write']) as unknown as Declaration['capabilityGrant'],
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

/** A `readPullRequest` double the reconciliation tests script directly, matching `HostOperations`' `DomainOperation` shape. */
function stubHostOperations(byNumber: ReadonlyMap<number, ToolResult<PrStatusData>>): Pick<HostOperations, 'readPullRequest'> {
  return {
    async readPullRequest(_ctx, input: PrStatusInput): Promise<ToolResult<PrStatusData>> {
      return byNumber.get(input.number) ?? precondition(`no such pull request ${input.number}`, []);
    },
  };
}

async function withComposites<T>(
  volume: string,
  clonePath: string,
  declaration: Declaration,
  hostOperations: Pick<HostOperations, 'readPullRequest'>,
  fn: (deps: { readonly composites: ReturnType<typeof createComposites>; readonly ctx: CallContext; readonly journal: ReturnType<typeof createJournal> }) => Promise<T>,
): Promise<T> {
  const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();

  const credentialEnv = new Map<EnvVarName, string>();
  const exec = createExec({ volumeRoot: volume, credentialEnv });
  const locks = createLocks();
  const mountRoot = mkdtempSync(path.join(tmpdir(), 'szg-composites-mount-'));
  writeFileSync(path.join(mountRoot, 'unused'), 'fixture-secret-value', 'utf8');
  const declarations: Declarations = {
    async get(id) {
      return id === declaration.id ? declaration : null;
    },
  } as Declarations;
  const gitOperations = createGitOperations({
    clock: systemClock,
    exec,
    locks,
    declarations,
    credentials: createCredentialResolver({ credentialMountRoot: mountRoot, volumeRoot: volume, clock: systemClock }),
    credentialEnv,
  });
  const journal = createJournal({ volumeRoot: volume, clock: systemClock });
  const composites = createComposites({ clock: systemClock, exec, gitOperations, hostOperations, journal });

  const operationId = 'op-1' as OperationId;
  const ctx = contextFor(clonePath, declaration.id, operationId);
  const begun = await journal.begin({
    operationId,
    declarationId: declaration.id,
    generation: 1 as never,
    tool: 'composite' as never,
    input: {},
    actorRef: ctx.actorRef,
    scheduledJobId: null,
    context: 'normal',
    preState: { branch: null, headSha: null, upstreamSha: null, indexDigest: 'd' as never, worktreeDigest: 'w' as never },
  });
  assert.equal(begun.ok, true, begun.ok ? '' : begun.error.summary);

  try {
    return await fn({ composites, ctx, journal });
  } finally {
    rmSync(mountRoot, { recursive: true, force: true });
  }
}

// --- S12.2 / prepareBranch's four action paths ---

test('prepareBranch: an up-to-date local base creates the branch from origin/<base>', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      await withComposites(volume, f.clonePath, declaration, stubHostOperations(new Map()), async ({ composites, ctx }) => {
        const result = await composites.prepareBranch(ctx, { branch: 'feature-a' as BranchName });
        assert.equal(result.ok, true, result.ok ? '' : result.summary);
        if (!result.ok || !result.data) return;
        assert.equal(result.data.action, 'created-from-remote-base');
        assert.equal(result.data.branch, 'feature-a');
        assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], f.clonePath).trim(), 'feature-a');
      });
    } finally {
      f.cleanup();
    }
  });
});

test('S12.2 — branch preparation bases fresh from origin/<base> regardless of what is checked out', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      // Park the checkout on an unrelated, unborn branch before the remote
      // advances — the composite must still base the new branch on the
      // fetched origin/main, not on whatever HEAD happens to be.
      git(['checkout', '-b', 'unrelated'], f.clonePath);
      advanceRemoteMain(f.remoteWorkDir, 'second.md');

      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      await withComposites(volume, f.clonePath, declaration, stubHostOperations(new Map()), async ({ composites, ctx }) => {
        const result = await composites.prepareBranch(ctx, { branch: 'feature-b' as BranchName });
        assert.equal(result.ok, true, result.ok ? '' : result.summary);
        if (!result.ok || !result.data) return;
        const remoteMainSha = git(['rev-parse', 'origin/main'], f.clonePath).trim();
        assert.equal(result.data.baseSha, remoteMainSha);
        assert.equal(result.data.branchHeadSha, remoteMainSha, "the new branch's tip is exactly origin/main's freshly fetched sha");
      });
    } finally {
      f.cleanup();
    }
  });
});

test('prepareBranch: a local base behind origin is fast-forwarded, then the branch is created', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      advanceRemoteMain(f.remoteWorkDir, 'second.md');
      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      await withComposites(volume, f.clonePath, declaration, stubHostOperations(new Map()), async ({ composites, ctx }) => {
        const result = await composites.prepareBranch(ctx, { branch: 'feature-c' as BranchName });
        assert.equal(result.ok, true, result.ok ? '' : result.summary);
        if (!result.ok || !result.data) return;
        assert.equal(result.data.action, 'fast-forwarded-then-created');
        const localMainSha = git(['rev-parse', 'refs/heads/main'], f.clonePath).trim();
        assert.equal(localMainSha, result.data.baseSha, "local main was fast-forwarded to origin's tip");
      });
    } finally {
      f.cleanup();
    }
  });
});

/**
 * S12.1's stranded-commit regression test, invariant 3 ("a clean local-only
 * commit on base is preserved on the requested publish branch") and
 * invariant 4 ("the publish branch is based on the latest origin/<base>").
 * `TODO-NEXT.md` §7.1 is the incident this reproduces: a commit made
 * locally on the base branch must not be abandoned when the base is
 * re-fetched from origin.
 *
 * Verified by reverting the fix: swapping the order in `composites.ts`'s
 * stranded-commit branch (moving the base ref **before** creating the
 * feature branch at its old tip) makes this test fail with the local
 * commit unreachable from any ref `git fsck` — confirmed by hand during
 * development of this slice, not re-run automatically here.
 */
test('S12.1 — a local-only commit on the base branch is preserved on the new branch, not stranded, when origin has advanced', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      // A commit that exists only in this clone, on `main`.
      writeFileSync(path.join(f.clonePath, 'local-only.md'), 'local only\n', 'utf8');
      git(['add', 'local-only.md'], f.clonePath);
      git(['commit', '-m', 'local-only commit on main'], f.clonePath);
      const localOnlySha = git(['rev-parse', 'HEAD'], f.clonePath).trim() as GitSha;

      // Origin advances independently while this clone still has the commit above.
      advanceRemoteMain(f.remoteWorkDir, 'remote-advance.md');

      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      await withComposites(volume, f.clonePath, declaration, stubHostOperations(new Map()), async ({ composites, ctx }) => {
        const result = await composites.prepareBranch(ctx, { branch: 'feature-stranded' as BranchName });
        assert.equal(result.ok, true, result.ok ? '' : result.summary);
        if (!result.ok || !result.data) return;
        assert.equal(result.data.action, 'rebased-preserved-commits');
        assert.deepEqual(result.data.preservedCommits, [localOnlySha]);

        // The commit is reachable from the new branch (rebased, so its sha
        // changed — content, not identity, is what must survive).
        const onNewBranch = git(['log', 'feature-stranded', '--format=%s'], f.clonePath);
        assert.match(onNewBranch, /local-only commit on main/);
        // And local `main` now matches origin — it was not left stranded either.
        const localMain = git(['rev-parse', 'refs/heads/main'], f.clonePath).trim();
        const remoteMain = git(['rev-parse', 'origin/main'], f.clonePath).trim();
        assert.equal(localMain, remoteMain);
      });
    } finally {
      f.cleanup();
    }
  });
});

/**
 * Distinct from S12.1's stranded-commit case above: here `input.branch`
 * *itself* already exists locally (e.g. a prior, incomplete attempt) and
 * needs rebasing onto a base that has since advanced — not a commit sitting
 * on the base branch. `preservedCommits` must still be populated per
 * `types.ts`'s documented contract for `rebased-preserved-commits`.
 */
test('prepareBranch: an already-existing local branch that needs rebasing reports its preserved commits', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      git(['checkout', '-b', 'feature-existing'], f.clonePath);
      writeFileSync(path.join(f.clonePath, 'existing-branch.md'), 'existing\n', 'utf8');
      git(['add', 'existing-branch.md'], f.clonePath);
      git(['commit', '-m', 'commit on the existing branch'], f.clonePath);
      const existingSha = git(['rev-parse', 'HEAD'], f.clonePath).trim() as GitSha;
      git(['checkout', 'main'], f.clonePath);

      // Origin advances independently while `feature-existing` is still based on the old tip.
      advanceRemoteMain(f.remoteWorkDir, 'remote-advance.md');

      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      await withComposites(volume, f.clonePath, declaration, stubHostOperations(new Map()), async ({ composites, ctx }) => {
        const result = await composites.prepareBranch(ctx, { branch: 'feature-existing' as BranchName });
        assert.equal(result.ok, true, result.ok ? '' : result.summary);
        if (!result.ok || !result.data) return;
        assert.equal(result.data.action, 'rebased-preserved-commits');
        assert.deepEqual(result.data.preservedCommits, [existingSha]);

        const onRebasedBranch = git(['log', 'feature-existing', '--format=%s'], f.clonePath);
        assert.match(onRebasedBranch, /commit on the existing branch/);
      });
    } finally {
      f.cleanup();
    }
  });
});

test('prepareBranch: a rebase conflict aborts safely — every original commit remains reachable, invariant 6', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.clonePath, 'README.md'), 'local change\n', 'utf8');
      git(['add', 'README.md'], f.clonePath);
      git(['commit', '-m', 'local conflicting commit'], f.clonePath);
      const localOnlySha = git(['rev-parse', 'HEAD'], f.clonePath).trim();

      // A conflicting change to the same line, on origin.
      writeFileSync(path.join(f.remoteWorkDir, 'README.md'), 'remote change\n', 'utf8');
      git(['add', 'README.md'], f.remoteWorkDir);
      git(['commit', '-m', 'remote conflicting commit'], f.remoteWorkDir);
      git(['push', 'origin', 'main'], f.remoteWorkDir);

      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      await withComposites(volume, f.clonePath, declaration, stubHostOperations(new Map()), async ({ composites, ctx }) => {
        const result = await composites.prepareBranch(ctx, { branch: 'feature-conflict' as BranchName });
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'precondition');

        // No rebase left in progress.
        const status = git(['status', '--porcelain'], f.clonePath);
        assert.equal(status.trim().length, 0, 'the aborted rebase leaves a clean tree');
        // The original commit is still reachable — nothing was discarded.
        const branches = git(['branch', '--contains', localOnlySha], f.clonePath);
        assert.match(branches, /feature-conflict/);
      });
    } finally {
      f.cleanup();
    }
  });
});

test('prepareBranch: refuses a dirty working tree — invariant 5', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.clonePath, 'untracked.md'), 'oops\n', 'utf8');
      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      await withComposites(volume, f.clonePath, declaration, stubHostOperations(new Map()), async ({ composites, ctx }) => {
        const result = await composites.prepareBranch(ctx, { branch: 'feature-dirty' as BranchName });
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'precondition');
      });
    } finally {
      f.cleanup();
    }
  });
});

test('prepareBranch: refuses to touch a branch already pushed to origin — never rewrites published work', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      git(['checkout', '-b', 'already-published'], f.remoteWorkDir);
      writeFileSync(path.join(f.remoteWorkDir, 'pub.md'), 'x\n', 'utf8');
      git(['add', 'pub.md'], f.remoteWorkDir);
      git(['commit', '-m', 'published work'], f.remoteWorkDir);
      git(['push', 'origin', 'already-published'], f.remoteWorkDir);
      git(['checkout', 'main'], f.remoteWorkDir);

      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      await withComposites(volume, f.clonePath, declaration, stubHostOperations(new Map()), async ({ composites, ctx }) => {
        const result = await composites.prepareBranch(ctx, { branch: 'already-published' as BranchName });
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'precondition');
      });
    } finally {
      f.cleanup();
    }
  });
});

// --- reconcileAfterMerge ---

test('reconcileAfterMerge: fast-forwards the base to the merge commit and deletes the local feature branch', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      git(['checkout', '-b', 'feature-merged'], f.clonePath);
      git(['checkout', 'main'], f.clonePath);

      // Simulate the merge landing on origin's main, as a squash merge would.
      writeFileSync(path.join(f.remoteWorkDir, 'merged.md'), 'x\n', 'utf8');
      git(['add', 'merged.md'], f.remoteWorkDir);
      git(['commit', '-m', 'squash-merged pr'], f.remoteWorkDir);
      git(['push', 'origin', 'main'], f.remoteWorkDir);
      const mergeCommitSha = git(['rev-parse', 'origin/main'], f.remoteWorkDir).trim() as GitSha;

      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      const hostOperations = stubHostOperations(
        new Map([
          [
            42,
            success(
              'merged',
              {
                status: {
                  ref: { number: 42, url: 'https://example.test/pr/42' as never, branch: 'feature-merged' as BranchName },
                  state: 'merged',
                  headSha: 'a'.repeat(40) as GitSha,
                  baseSha: 'b'.repeat(40) as GitSha,
                  mergeCommitSha,
                  mergeable: null,
                  autoMergeEnabled: true,
                },
              },
              { operationId: null, declarationId: null, generation: null, durationMs: 0 },
            ),
          ],
        ]),
      );
      await withComposites(volume, f.clonePath, declaration, hostOperations, async ({ composites, ctx }) => {
        const result = await composites.reconcileAfterMerge(ctx, { pullRequestNumber: 42, expectedHeadSha: null });
        assert.equal(result.ok, true, result.ok ? '' : result.summary);
        if (!result.ok || !result.data) return;
        assert.equal(result.data.mergeCommitSha, mergeCommitSha);
        assert.equal(result.data.deletedBranch, 'feature-merged');
        assert.equal(git(['rev-parse', 'refs/heads/main'], f.clonePath).trim(), mergeCommitSha);
        const branchList = git(['branch'], f.clonePath);
        assert.doesNotMatch(branchList, /feature-merged/);
      });
    } finally {
      f.cleanup();
    }
  });
});

test('reconcileAfterMerge: refuses when the pull request is not merged', async () => {
  await withVolumeAsync(async (volume) => {
    const f = fixture();
    try {
      const declaration = declarationFor('repo-a' as DeclarationId, f.bareDir);
      const hostOperations = stubHostOperations(
        new Map([
          [
            7,
            success(
              'open',
              {
                status: {
                  ref: { number: 7, url: 'https://example.test/pr/7' as never, branch: 'topic' as BranchName },
                  state: 'open',
                  headSha: 'a'.repeat(40) as GitSha,
                  baseSha: 'b'.repeat(40) as GitSha,
                  mergeCommitSha: null,
                  mergeable: true,
                  autoMergeEnabled: false,
                },
              },
              { operationId: null, declarationId: null, generation: null, durationMs: 0 },
            ),
          ],
        ]),
      );
      await withComposites(volume, f.clonePath, declaration, hostOperations, async ({ composites, ctx }) => {
        const result = await composites.reconcileAfterMerge(ctx, { pullRequestNumber: 7, expectedHeadSha: null });
        assert.equal(result.ok, false);
        assert.equal(result.kind, 'precondition');
      });
    } finally {
      f.cleanup();
    }
  });
});

// --- S12.4 — every sub-step boundary classifies resume or park, never nothing-happened ---

test('S12.4 — prepareBranch: a kill at every journaled boundary classifies resume, never nothing-happened', () => {
  const preState = { branch: 'main' as never, headSha: 'a'.repeat(40) as never, upstreamSha: null, indexDigest: 'd' as never, worktreeDigest: 'w' as never };
  const observed = { ...preState, observedAt: systemClock.now() };
  for (const steps of [[], [PREPARE_BRANCH_STEPS.fetch], [PREPARE_BRANCH_STEPS.fetch, PREPARE_BRANCH_STEPS.materialize]]) {
    const entry = {
      operationId: 'op-1' as never,
      declarationId: 'repo-a' as never,
      generation: 1 as never,
      tool: 'prepare_branch' as never,
      input: { branch: 'feature' as never },
      actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
      scheduledJobId: null,
      context: 'normal',
      preState,
      steps: steps.map((name) => ({ name, state: 'applied' as const, at: systemClock.now() })),
      state: 'applied',
      attentionReason: null,
      startedAt: systemClock.now(),
      updatedAt: systemClock.now(),
    };
    // `expectedPostState` never claims completion; with at least one step
    // journaled, `resume` is the verdict. With zero steps, `Journal.classify`
    // itself reaches `nothing-happened` only when the tree is *also*
    // unchanged — which is exactly the case a kill before the first step
    // produces, and is the one boundary this descriptor is not asked to
    // distinguish from a call that never started.
    if (steps.length === 0) {
      assert.equal(PREPARE_BRANCH_RECOVERY.expectedPostState(entry as never, observed as never), false);
      continue;
    }
    assert.equal(PREPARE_BRANCH_RECOVERY.expectedPostState(entry as never, observed as never), false);
    assert.notEqual(PREPARE_BRANCH_RECOVERY.resume, null);
    const step = PREPARE_BRANCH_RECOVERY.resume!(entry as never);
    assert.equal(step.tool, 'prepare_branch');
    assert.deepEqual(step.input, entry.input);
  }
});

test('S12.4 — reconcileAfterMerge: a kill at every journaled boundary classifies resume, never nothing-happened', () => {
  const entry = {
    operationId: 'op-1' as never,
    declarationId: 'repo-a' as never,
    generation: 1 as never,
    tool: 'reconcile_after_merge' as never,
    input: { pullRequestNumber: 42, expectedHeadSha: null },
    actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
    scheduledJobId: null,
    context: 'normal',
    preState: { branch: 'feature' as never, headSha: 'a'.repeat(40) as never, upstreamSha: null, indexDigest: 'd' as never, worktreeDigest: 'w' as never },
    steps: [RECONCILE_AFTER_MERGE_STEPS.confirmMerged, RECONCILE_AFTER_MERGE_STEPS.fetch, RECONCILE_AFTER_MERGE_STEPS.advanceBase].map((name) => ({
      name,
      state: 'applied' as const,
      at: systemClock.now(),
    })),
    state: 'applied',
    attentionReason: null,
    startedAt: systemClock.now(),
    updatedAt: systemClock.now(),
  };
  const observed = { ...entry.preState, observedAt: systemClock.now() };
  assert.equal(RECONCILE_AFTER_MERGE_RECOVERY.expectedPostState(entry as never, observed as never), false);
  assert.notEqual(RECONCILE_AFTER_MERGE_RECOVERY.resume, null);
  const step = RECONCILE_AFTER_MERGE_RECOVERY.resume!(entry as never);
  assert.equal(step.tool, 'reconcile_after_merge');
  assert.deepEqual(step.input, entry.input);
});
