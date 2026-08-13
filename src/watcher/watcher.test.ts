import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { systemClock } from '../clock/clock.ts';
import { success, validation, authorization, upstream, infrastructure, precondition } from '../result/envelope.ts';
import type { ToolResult } from '../result/envelope.ts';
import type { DispatchRequest, Dispatch } from '../dispatch/dispatch-pipeline.ts';
import type { Declaration } from '../declarations/types.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { DeclarationFilter } from '../declarations/types.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { Clone, CloneState } from '../clone/types.ts';
import type { Audit } from '../audit/audit.ts';
import type { AuditAppendInput } from '../audit/types.ts';
import type { Notifier } from '../notifier/notifier.ts';
import type { NotificationRequest } from '../journal/types.ts';
import type { StructuredStore, StoreTransaction } from '../store/structured-store.ts';
import type { ContractCapabilitySet } from '../contract/capabilities.ts';
import { createWatcher, type WatcherDependencies } from './watcher.ts';
import { pendingPullRequestsPath, readPendingPullRequests, writePendingPullRequests } from './pending-pull-requests.ts';
import type { PendingPullRequest } from './types.ts';

const CAPABILITY_SET = new Set(['repo.read', 'git.local.write', 'git.remote.write', 'host.pr.write']) as unknown as ContractCapabilitySet;

function fixtureDeclaration(overrides: Partial<Declaration> = {}): Declaration {
  return {
    id: 'repo-a' as Declaration['id'],
    generation: 1 as Declaration['generation'],
    cloneUrl: 'https://example.com/repo-a.git' as Declaration['cloneUrl'],
    host: 'github',
    credentialRef: 'cred' as Declaration['credentialRef'],
    capabilityGrant: new Set(['repo.read', 'git.local.write', 'git.remote.write', 'host.pr.write']) as unknown as Declaration['capabilityGrant'],
    writablePathPrefixes: ['content/'] as unknown as Declaration['writablePathPrefixes'],
    pinned: false,
    fileWatcher: { planTool: 'plan_tool' as never, applyTool: 'apply_tool' as never, autoMerge: false },
    identity: { gitUserName: 'watcher', gitUserEmail: 'watcher@example.com' },
    state: 'active',
    grantEpoch: 0 as Declaration['grantEpoch'],
    createdAt: systemClock.now(),
    updatedAt: systemClock.now(),
    ...overrides,
  };
}

function stubDeclarations(active: { current: readonly Declaration[] }): Pick<Declarations, 'list'> {
  return {
    async list(filter: DeclarationFilter): Promise<readonly Declaration[]> {
      return active.current.filter((d) => (filter.state === null || d.state === filter.state) && (filter.hasFileWatcher === null || (d.fileWatcher !== null) === filter.hasFileWatcher));
    },
  };
}

function stubCloneStore(state: { current: CloneState }): Pick<CloneStore, 'describe'> {
  return {
    async describe(declarationId) {
      const clone: Clone = { declarationId, generation: 1 as never, state: state.current, path: 'unused' as never, sizeBytes: 0, lastOperationAt: null, observedRemote: null, attentionReason: null };
      return { ok: true, value: clone };
    },
  };
}

function stubAudit(log: AuditAppendInput[]): Pick<Audit, 'append'> {
  return {
    async append(input) {
      log.push(input);
      return { appended: true, sequence: log.length };
    },
  };
}

function stubNotifier(log: NotificationRequest[]): Pick<Notifier, 'enqueue'> {
  return {
    enqueue(request) {
      log.push(request);
    },
  };
}

function stubStore(): Pick<StructuredStore, 'transaction'> {
  const tx: StoreTransaction = { id: 'tx', run() {}, all() { return []; } };
  return {
    async transaction(work) {
      return { ok: true, value: await work(tx) };
    },
  };
}

test('S26.4 — runRetention deletes only aged files in processed/, never inbox, processing, or failed files', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    const old = new Date('2026-01-01T00:00:00.000Z');
    for (const dir of ['', 'processed', 'processing', 'failed']) mkdirSync(path.join(root, dir), { recursive: true });
    for (const relative of ['inbox.md', 'processed/old.md', 'processed/new.md', 'processing/held.md', 'failed/failed.md']) {
      const file = path.join(root, relative);
      writeFileSync(file, relative, 'utf8');
      if (relative !== 'processed/new.md') utimesSync(file, old, old);
    }
    const watcher = createWatcher({
      volumeRoot: volume,
      clock: systemClock,
      declarations: stubDeclarations({ current: [] }),
      cloneStore: stubCloneStore({ current: 'ready' }),
      audit: stubAudit([]), notifier: stubNotifier([]), store: stubStore(),
      dispatch: scriptedDispatch([], {}), contractCapabilitySet: CAPABILITY_SET,
      remoteOperationsPermitted: false, watcherEnabled: false,
    });
    const report = await watcher.runRetention();
    assert.equal(existsSync(path.join(root, 'processed', 'old.md')), false);
    for (const relative of ['inbox.md', 'processed/new.md', 'processing/held.md', 'failed/failed.md']) assert.equal(existsSync(path.join(root, relative)), true, `${relative} is never deleted by retention`);
    assert.equal(report.deletedRows, 1);
  });
});

/** Every call is logged; a per-tool handler decides the response. Missing handlers fail the test loudly rather than hanging. */
function scriptedDispatch(log: DispatchRequest[], handlers: Record<string, (req: DispatchRequest) => ToolResult<never> | Promise<ToolResult<never>>>): Dispatch {
  return async (request) => {
    log.push(request);
    const handler = handlers[request.toolName as string];
    if (!handler) throw new Error(`unscripted dispatch call: ${request.toolName}`);
    return handler(request);
  };
}

function repoStatus(dirty: boolean, changedPaths: readonly { path: string; staged: boolean }[] = []): ToolResult<never> {
  return success(
    'status',
    { branch: 'main', baseBranch: 'main', dirty, parkedOffBase: false, ahead: 0, behind: 0, changedPaths, observedRemote: null, readStamp: { lastSettledOperationId: null, mutationInFlight: false } },
    { operationId: null, declarationId: null, generation: null, durationMs: 0 },
  ) as unknown as ToolResult<never>;
}

const PLAN_DATA = {
  branch: 'watcher/post-1',
  commitMessage: 'publish post',
  pullRequest: { title: 'New post', body: 'body' },
  permittedPaths: ['content/post.md'],
  plan: { slug: 'post' },
};

const APPLY_DATA = { changedPaths: ['content/post.md'] };

function successfulHandlers(autoMergeCalled: { count: number } = { count: 0 }): Record<string, (req: DispatchRequest) => ToolResult<never>> {
  return {
    plan_tool: () => success('planned', PLAN_DATA, diag()) as unknown as ToolResult<never>,
    prepare_branch: () => success('prepared', {}, diag()) as unknown as ToolResult<never>,
    apply_tool: () => success('applied', APPLY_DATA, diag()) as unknown as ToolResult<never>,
    repo_status: (() => {
      let call = 0;
      return () => {
        call += 1;
        // Call 1 is the pre-claim clean-tree gate, call 2 the post-apply observation, call 3 the post-stage observation.
        if (call === 1) return repoStatus(false);
        return call === 2 ? repoStatus(true, [{ path: 'content/post.md', staged: false }]) : repoStatus(true, [{ path: 'content/post.md', staged: true }]);
      };
    })(),
    git_stage: () => success('staged', { staged: ['content/post.md'] }, diag()) as unknown as ToolResult<never>,
    git_commit: () => success('committed', { sha: 'a'.repeat(40), branch: 'watcher/post-1', changedPaths: ['content/post.md'] }, diag()) as unknown as ToolResult<never>,
    git_push: () => success('pushed', { branch: 'watcher/post-1', headSha: 'a'.repeat(40), alreadyUpToDate: false }, diag()) as unknown as ToolResult<never>,
    pr_open: () => success('opened', { ref: { number: 7, url: 'https://example.com/pr/7', branch: 'watcher/post-1' } }, diag()) as unknown as ToolResult<never>,
    pr_enable_auto_merge: () => {
      autoMergeCalled.count += 1;
      return success('auto-merge enabled', { number: 7, autoMergeEnabled: true }, diag()) as unknown as ToolResult<never>;
    },
  };
}

function diag() {
  return { operationId: null, declarationId: null, generation: null, durationMs: 0 };
}

/**
 * Handlers gated so anything after `failAt` throws if reached — proves the
 * sequence stops. `repo_status` is excluded from that gate and answered by
 * call count instead: it legitimately runs once before `failAt` (the
 * pre-claim clean-tree gate) regardless of where in the protocol `failAt`
 * falls, so its fixed position in `order` cannot double as "have we passed
 * the failure point" the way every other step's can.
 */
function handlersUpTo(failAt: string, failureResult: ToolResult<never>): Record<string, (req: DispatchRequest) => ToolResult<never>> {
  const base = successfulHandlers();
  const wrapped: Record<string, (req: DispatchRequest) => ToolResult<never>> = {};
  const order = ['plan_tool', 'prepare_branch', 'apply_tool', 'git_stage', 'git_commit', 'git_push', 'pr_open', 'pr_enable_auto_merge'];
  const failIndex = order.indexOf(failAt);
  let repoStatusCalls = 0;
  wrapped.repo_status = () => {
    repoStatusCalls += 1;
    // Call 1 is the pre-claim clean-tree gate, call 2 the post-apply observation, call 3 the post-stage observation.
    if (repoStatusCalls === 1) return repoStatus(false);
    return repoStatusCalls === 2 ? repoStatus(true, [{ path: 'content/post.md', staged: false }]) : repoStatus(true, [{ path: 'content/post.md', staged: true }]);
  };
  for (const name of order) {
    wrapped[name] = (req) => {
      if (order.indexOf(name) > failIndex) throw new Error(`dispatched '${name}' after '${failAt}' was supposed to stop the sequence`);
      if (name === failAt) return failureResult;
      return base[name]!(req);
    };
  }
  return wrapped;
}

function baseDeps(volume: string, overrides: Partial<WatcherDependencies> = {}): { deps: WatcherDependencies; auditLog: AuditAppendInput[]; notifications: NotificationRequest[]; dispatchLog: DispatchRequest[] } {
  const auditLog: AuditAppendInput[] = [];
  const notifications: NotificationRequest[] = [];
  const dispatchLog: DispatchRequest[] = [];
  const deps: WatcherDependencies = {
    volumeRoot: volume,
    clock: systemClock,
    dispatch: scriptedDispatch(dispatchLog, {}),
    declarations: stubDeclarations({ current: [] }),
    cloneStore: stubCloneStore({ current: 'ready' }),
    audit: stubAudit(auditLog),
    notifier: stubNotifier(notifications),
    store: stubStore(),
    contractCapabilitySet: CAPABILITY_SET,
    remoteOperationsPermitted: true,
    watcherEnabled: true,
    ...overrides,
  };
  return { deps, auditLog, notifications, dispatchLog };
}

function inboxRoot(volume: string, declarationId: string): string {
  return path.join(volume, 'watcher-inboxes', declarationId);
}

test('S17.1 — start() refuses not-permitted naming the switch when either default-off deployment switch is off', async () => {
  await withVolumeAsync(async (volume) => {
    const { deps: withoutRemote } = baseDeps(volume, { remoteOperationsPermitted: false });
    const r1 = await createWatcher(withoutRemote).start();
    assert.equal(r1.ok, false);
    if (!r1.ok && r1.error.code === 'not-permitted') assert.equal(r1.error.missingSwitch, 'remote-operations');

    const { deps: withoutWatcher } = baseDeps(volume, { watcherEnabled: false });
    const r2 = await createWatcher(withoutWatcher).start();
    assert.equal(r2.ok, false);
    if (!r2.ok && r2.error.code === 'not-permitted') assert.equal(r2.error.missingSwitch, 'watcher-enabled');
  });
});

test('S17.1 — with both switches on and no active file-watcher declarations, start() is healthy and idle; a declaration added at runtime is eligible on the next tick', async () => {
  await withVolumeAsync(async (volume) => {
    const active = { current: [] as Declaration[] };
    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations(active),
      dispatch: scriptedDispatch(dispatchLog, { repo_status: () => repoStatus(false) }),
    });
    const watcher = createWatcher(deps);
    const started = await watcher.start();
    assert.equal(started.ok, true);
    await watcher.stop();

    const emptyTick = await watcher.tick();
    assert.deepEqual(emptyTick, []);

    active.current = [fixtureDeclaration()];
    const nextTick = await watcher.tick();
    assert.equal(nextTick.length, 1);
    assert.equal(nextTick[0]!.declarationId, 'repo-a');
    assert.equal(dispatchLog.some((r) => r.toolName === 'repo_status'), true, 'the newly-eligible declaration was resolved without a restart');
  });
});

test('S17.2 — a watched file is claimed by rename into processing/ before any git or host action', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, {
        repo_status: () => repoStatus(false),
        plan_tool: () => {
          // The claim must already have happened by the time the first git/host action (the plan tool) is dispatched.
          assert.equal(existsSync(path.join(root, 'post.md')), false, 'the file must already be out of the inbox root');
          assert.equal(existsSync(path.join(root, 'processing', 'post.md')), true, 'the file must already be claimed into processing/');
          return success('planned', PLAN_DATA, diag()) as unknown as ToolResult<never>;
        },
        prepare_branch: () => success('prepared', {}, diag()) as unknown as ToolResult<never>,
        apply_tool: () => success('applied', APPLY_DATA, diag()) as unknown as ToolResult<never>,
      }),
    });

    const watcher = createWatcher(deps);
    await watcher.tick();
  });
});

test('S17.3 — a file found in processing/ at startup is moved to failed/ with an explanation and never reprocessed', async () => {
  await withVolumeAsync(async (volume) => {
    const processingDir = path.join(inboxRoot(volume, 'repo-a'), 'processing');
    mkdirSync(processingDir, { recursive: true });
    writeFileSync(path.join(processingDir, 'orphan.md'), 'content', 'utf8');

    const { deps, dispatchLog, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
    });
    const watcher = createWatcher(deps);

    const recovered = await watcher.recoverInterruptedClaims();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.outcome?.kind, 'interrupted-claim');
    assert.equal(dispatchLog.length, 0, 'an interrupted claim is never reprocessed — no dispatch call is made for it');
    assert.equal(existsSync(path.join(processingDir, 'orphan.md')), false);

    const failedDir = path.join(inboxRoot(volume, 'repo-a'), 'failed');
    const failedFiles = readdirSync(failedDir);
    assert.equal(failedFiles.some((f) => f.endsWith('orphan.md')), true);
    assert.equal(failedFiles.some((f) => f.endsWith('orphan.md.error.txt')), true);

    assert.equal(auditLog.length, 1);
    assert.equal(auditLog[0]!.form, 'file-watcher');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.severity, 'attention');

    // A later tick must not touch it again — it is gone from processing/ already, so nothing to reprocess.
    const secondRecovery = await watcher.recoverInterruptedClaims();
    assert.equal(secondRecovery.length, 0);
  });
});

test('S17.4 — a symlink is never a candidate; a link-preserving stat refuses it regardless of what it points at', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    const outsideTarget = path.join(volume, 'outside-target.md');
    writeFileSync(outsideTarget, 'not part of the inbox', 'utf8');

    let symlinked = true;
    try {
      symlinkSync(outsideTarget, path.join(root, 'evil-link.md'), 'file');
    } catch {
      symlinked = false;
    }
    if (!symlinked) {
      // No symlink privilege on this host (common on unelevated Windows) — nothing to assert.
      return;
    }

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, { repo_status: () => repoStatus(false) }),
    });
    const watcher = createWatcher(deps);
    const reports = await watcher.tick();

    assert.equal(reports[0]!.claimed, null, 'the symlink was never claimed');
    assert.equal(existsSync(path.join(root, 'evil-link.md')), true, 'the symlink is left untouched, still in the inbox');
    assert.equal(dispatchLog.some((r) => r.toolName === 'plan_tool'), false);
  });
});

test('S17.5 — a tick is a no-op when the clone is not clean, and when the clone needs-attention the file stays in the inbox', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const dirtyLog: DispatchRequest[] = [];
    const { deps: dirtyDeps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      cloneStore: stubCloneStore({ current: 'ready' }),
      dispatch: scriptedDispatch(dirtyLog, { repo_status: () => repoStatus(true, [{ path: 'content/other.md', staged: false }]) }),
    });
    const dirtyReports = await createWatcher(dirtyDeps).tick();
    assert.equal(dirtyReports[0]!.skipped, 'clone-not-clean');
    assert.equal(existsSync(path.join(root, 'post.md')), true, 'the file stays in the inbox');

    const attentionLog: DispatchRequest[] = [];
    const { deps: attentionDeps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      cloneStore: stubCloneStore({ current: 'needs-attention' }),
      dispatch: scriptedDispatch(attentionLog, { repo_status: () => repoStatus(false) }),
    });
    const attentionReports = await createWatcher(attentionDeps).tick();
    assert.equal(attentionReports[0]!.skipped, 'clone-needs-attention');
    assert.equal(existsSync(path.join(root, 'post.md')), true, 'the file stays in the inbox');
    assert.equal(attentionLog.length, 0, 'needs-attention is decided before repo_status is even dispatched');
  });
});

test('S17.6 and S17.7 — the full protocol delivers a claimed file to processed/ with a succeeded outcome carrying the pull request', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const autoMergeCalled = { count: 0 };
    const dispatchLog: DispatchRequest[] = [];
    const { deps, auditLog } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration({ fileWatcher: { planTool: 'plan_tool' as never, applyTool: 'apply_tool' as never, autoMerge: true } })] }),
      dispatch: scriptedDispatch(dispatchLog, successfulHandlers(autoMergeCalled)),
    });

    const reports = await createWatcher(deps).tick();
    assert.equal(reports[0]!.outcome?.kind, 'succeeded');
    assert.equal(existsSync(path.join(root, 'post.md')), false);
    assert.equal(existsSync(path.join(root, 'processing', 'post.md')), false);

    const processedDir = path.join(root, 'processed');
    const processedFiles = readdirSync(processedDir);
    assert.equal(processedFiles.length, 1);
    assert.equal(processedFiles[0]!.endsWith('-post.md'), true);

    assert.deepEqual(
      dispatchLog.map((r) => r.toolName),
      ['repo_status', 'plan_tool', 'prepare_branch', 'apply_tool', 'repo_status', 'git_stage', 'repo_status', 'git_commit', 'git_push', 'pr_open', 'pr_enable_auto_merge'],
    );
    assert.equal(autoMergeCalled.count, 1);
    assert.equal(auditLog.length, 1);
    assert.equal(auditLog[0]!.form, 'file-watcher');
  });
});

test('S17.6 — a terminal failure moves the file to failed/ with a sibling error file naming the failing step and result kind, and deletes nothing', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], handlersUpTo('git_push', upstream('remote rejected the push', null) as unknown as ToolResult<never>)),
    });

    const reports = await createWatcher(deps).tick();
    assert.equal(reports[0]!.outcome?.kind, 'rejected');
    if (reports[0]!.outcome?.kind === 'rejected') {
      assert.equal(reports[0]!.outcome.step, 'git_push');
      assert.equal(reports[0]!.outcome.result, 'upstream');
    }

    assert.equal(existsSync(path.join(root, 'post.md')), false);
    assert.equal(existsSync(path.join(root, 'processing', 'post.md')), false);
    assert.equal(existsSync(path.join(root, 'processed')), false, 'nothing was ever written to processed/');

    const failedDir = path.join(root, 'failed');
    const failedFiles = readdirSync(failedDir);
    const dataFile = failedFiles.find((f) => f.endsWith('-post.md'));
    const errorFile = failedFiles.find((f) => f.endsWith('-post.md.error.txt'));
    assert.ok(dataFile);
    assert.ok(errorFile);
    const errorText = readFileSync(path.join(failedDir, errorFile!), 'utf8');
    assert.match(errorText, /git_push/);
    assert.match(errorText, /upstream/);

    assert.equal(auditLog.length, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.subject && (notifications[0]!.subject as { kind: string }).kind, 'file-watcher-failed');
  });
});

test('S17.7/D12 — a mismatched post-apply observation fails before git_stage is ever dispatched', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], {
        repo_status: (() => {
          let call = 0;
          return () => {
            call += 1;
            if (call === 1) return repoStatus(false); // pre-claim clean check
            // Post-apply observation reports a DIFFERENT path than the apply result claimed.
            return repoStatus(true, [{ path: 'content/unexpected.md', staged: false }]);
          };
        })(),
        plan_tool: () => success('planned', PLAN_DATA, diag()) as unknown as ToolResult<never>,
        prepare_branch: () => success('prepared', {}, diag()) as unknown as ToolResult<never>,
        apply_tool: () => success('applied', APPLY_DATA, diag()) as unknown as ToolResult<never>,
        git_stage: () => {
          throw new Error('git_stage must not be dispatched when the post-apply observation mismatches');
        },
      }),
    });

    const reports = await createWatcher(deps).tick();
    assert.equal(reports[0]!.outcome?.kind, 'rejected');
    if (reports[0]!.outcome?.kind === 'rejected') assert.equal(reports[0]!.outcome.step, 'repo_status_after_apply');
  });
});

test('S17.7/D13 — a post-stage observation short of fully staged fails before git_commit is ever dispatched', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], {
        repo_status: (() => {
          let call = 0;
          return () => {
            call += 1;
            if (call === 1) return repoStatus(false);
            if (call === 2) return repoStatus(true, [{ path: 'content/post.md', staged: false }]);
            // Post-stage observation says the path is still not staged.
            return repoStatus(true, [{ path: 'content/post.md', staged: false }]);
          };
        })(),
        plan_tool: () => success('planned', PLAN_DATA, diag()) as unknown as ToolResult<never>,
        prepare_branch: () => success('prepared', {}, diag()) as unknown as ToolResult<never>,
        apply_tool: () => success('applied', APPLY_DATA, diag()) as unknown as ToolResult<never>,
        git_stage: () => success('staged', { staged: ['content/post.md'] }, diag()) as unknown as ToolResult<never>,
        git_commit: () => {
          throw new Error('git_commit must not be dispatched when the post-stage observation is not fully staged');
        },
      }),
    });

    const reports = await createWatcher(deps).tick();
    assert.equal(reports[0]!.outcome?.kind, 'rejected');
    if (reports[0]!.outcome?.kind === 'rejected') assert.equal(reports[0]!.outcome.step, 'repo_status_after_stage');
  });
});

test('S17.9 — a rejected apply (a plan naming a stripped path, enforced by dispatch) dispatches no later git or host step', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const { deps, auditLog } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], handlersUpTo('apply_tool', authorization('outside the effective writable paths', []) as unknown as ToolResult<never>)),
    });

    const reports = await createWatcher(deps).tick();
    assert.equal(reports[0]!.outcome?.kind, 'rejected');
    if (reports[0]!.outcome?.kind === 'rejected') {
      assert.equal(reports[0]!.outcome.step, 'apply');
      assert.equal(reports[0]!.outcome.result, 'authorization');
    }
    assert.equal(auditLog.length, 1);
  });
});

test('S17.15 — a failed file in one declaration does not block the tick from processing another declaration\'s file', async () => {
  await withVolumeAsync(async (volume) => {
    const rootA = inboxRoot(volume, 'repo-a');
    const rootB = inboxRoot(volume, 'repo-b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    writeFileSync(path.join(rootA, 'fails.md'), 'content', 'utf8');
    writeFileSync(path.join(rootB, 'succeeds.md'), 'content', 'utf8');

    const handlersB = successfulHandlers();
    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({
        current: [fixtureDeclaration({ id: 'repo-a' as never }), fixtureDeclaration({ id: 'repo-b' as never })],
      }),
      dispatch: async (request: DispatchRequest) => {
        if (request.declarationId === 'repo-a') {
          if (request.toolName === 'repo_status') return repoStatus(false);
          return validation('the plan is incomplete', [{ path: 'sourceFile', rule: 'complete', message: 'missing front matter' }]) as unknown as ToolResult<never>;
        }
        return handlersB[request.toolName as string]!(request);
      },
    });

    const reports = await createWatcher(deps).tick();
    const reportA = reports.find((r) => r.declarationId === 'repo-a')!;
    const reportB = reports.find((r) => r.declarationId === 'repo-b')!;
    assert.equal(reportA.outcome?.kind, 'rejected');
    assert.equal(reportB.outcome?.kind, 'succeeded');

    assert.equal(auditLog.length, 2, 'one file-watcher audit record per claimed file');
    assert.equal(notifications.length, 1, 'only the failed file notifies');
  });
});

function pendingEntry(overrides: Partial<PendingPullRequest> = {}): PendingPullRequest {
  return {
    declarationId: 'repo-a' as never,
    number: 7,
    branch: 'watcher/post-1' as never,
    openedAt: systemClock.now(),
    sourceFile: 'post.md' as never,
    ...overrides,
  };
}

function prStatusResult(state: 'open' | 'merged' | 'closed', overrides: Partial<{ headSha: string; number: number; branch: string }> = {}): ToolResult<never> {
  const number = overrides.number ?? 7;
  return success(
    'status',
    {
      status: {
        ref: { number, url: `https://example.com/pr/${number}`, branch: overrides.branch ?? 'watcher/post-1' },
        state,
        headSha: overrides.headSha ?? 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        mergeCommitSha: state === 'merged' ? 'c'.repeat(40) : null,
        mergeable: state === 'open' ? true : null,
        autoMergeEnabled: false,
      },
    },
    diag(),
  ) as unknown as ToolResult<never>;
}

test('S24.1 — a missing or unparseable pending pull-request list is treated as empty and never crashes a tick; a delivered file records a new entry, written temp-then-rename', async () => {
  await withVolumeAsync(async (volume) => {
    assert.deepEqual(readPendingPullRequests(volume, 'repo-a' as never), { entries: [] });

    mkdirSync(path.dirname(pendingPullRequestsPath(volume, 'repo-a' as never)), { recursive: true });
    writeFileSync(pendingPullRequestsPath(volume, 'repo-a' as never), 'not json', 'utf8');
    assert.deepEqual(readPendingPullRequests(volume, 'repo-a' as never), { entries: [] });

    const emptyLog: DispatchRequest[] = [];
    const { deps: emptyDeps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(emptyLog, { repo_status: () => repoStatus(false) }),
    });
    await createWatcher(emptyDeps).tick();
    assert.equal(emptyLog.some((r) => r.toolName === 'pr_status'), false, 'an unparseable list dispatches no reconciliation calls');

    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');
    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, successfulHandlers()),
    });
    const reports = await createWatcher(deps).tick();
    assert.equal(reports[0]!.outcome?.kind, 'succeeded');

    const list = readPendingPullRequests(volume, 'repo-a' as never);
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0]!.number, 7);
    assert.equal(list.entries[0]!.branch, 'watcher/post-1');
    assert.equal(list.entries[0]!.sourceFile, 'post.md');
    assert.equal(list.entries[0]!.declarationId, 'repo-a');

    const siblingFiles = readdirSync(path.dirname(pendingPullRequestsPath(volume, 'repo-a' as never)));
    assert.deepEqual(
      siblingFiles.filter((f) => f.endsWith('.tmp')),
      [],
      'temp-then-rename leaves no stray .tmp file',
    );
  });
});

test('S24.1 — a structurally valid but malformed entry (missing fields) is dropped rather than dispatched with undefined input', async () => {
  await withVolumeAsync(async (volume) => {
    const full = pendingPullRequestsPath(volume, 'repo-a' as never);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify({ entries: [{}, pendingEntry({ number: 3 })] }), 'utf8');

    assert.deepEqual(
      readPendingPullRequests(volume, 'repo-a' as never).entries.map((e) => e.number),
      [3],
      'the well-formed entry survives; the malformed one is filtered out rather than reaching pr_status as { number: undefined }',
    );
  });
});

test('S24.2 — each tick re-reads host state: open and a transient status-read failure stay pending; closed is removed without reconciling; merged reconciles once and is removed whether it succeeds or fails', async () => {
  await withVolumeAsync(async (volume) => {
    const entries: PendingPullRequest[] = [
      pendingEntry({ number: 1 }), // open -> stays pending
      pendingEntry({ number: 2 }), // transient pr_status failure -> stays pending
      pendingEntry({ number: 3 }), // closed -> removed, not reconciled
      pendingEntry({ number: 4 }), // merged, reconciliation succeeds -> reconciled, removed
      pendingEntry({ number: 5 }), // merged, reconciliation fails -> reconciled anyway, removed
    ];
    writePendingPullRequests(volume, 'repo-a' as never, { entries });

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, {
        repo_status: () => repoStatus(false),
        pr_status: (req) => {
          const number = (req.input as { number: number }).number;
          if (number === 1) return prStatusResult('open', { number });
          if (number === 2) return infrastructure('transient host read failure');
          if (number === 3) return prStatusResult('closed', { number });
          return prStatusResult('merged', { number });
        },
        reconcile_after_merge: (req) => {
          const number = (req.input as { pullRequestNumber: number }).pullRequestNumber;
          return number === 5 ? precondition('base is not fast-forwardable', []) : (success('reconciled', {}, diag()) as unknown as ToolResult<never>);
        },
      }),
    });

    const reports = await createWatcher(deps).tick();
    const report = reports[0]!;
    assert.deepEqual(
      report.stillPending.map((e) => e.number).sort(),
      [1, 2],
    );
    assert.deepEqual(
      report.reconciled.map((e) => e.number).sort(),
      [4, 5],
    );

    const remaining = readPendingPullRequests(volume, 'repo-a' as never);
    assert.deepEqual(
      remaining.entries.map((e) => e.number).sort(),
      [1, 2],
    );
  });
});

test('S24.3 — reconciliation is an independent dispatch, run even when the clone-readiness gate that guards claiming a new file skips the tick', async () => {
  await withVolumeAsync(async (volume) => {
    writePendingPullRequests(volume, 'repo-a' as never, { entries: [pendingEntry({ number: 9 })] });

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      cloneStore: stubCloneStore({ current: 'needs-attention' }),
      dispatch: scriptedDispatch(dispatchLog, {
        pr_status: () => prStatusResult('merged', { number: 9 }),
        reconcile_after_merge: () => success('reconciled', {}, diag()) as unknown as ToolResult<never>,
      }),
    });

    const reports = await createWatcher(deps).tick();
    assert.equal(reports[0]!.skipped, 'clone-needs-attention');
    assert.deepEqual(
      reports[0]!.reconciled.map((e) => e.number),
      [9],
    );
    assert.deepEqual(
      dispatchLog.map((r) => r.toolName),
      ['pr_status', 'reconcile_after_merge'],
    );
    assert.equal(readPendingPullRequests(volume, 'repo-a' as never).entries.length, 0);
  });
});

test('S24.2 — a non-transient pr_status failure (e.g. authorization) is dropped rather than retried forever; a transient one stays pending', async () => {
  await withVolumeAsync(async (volume) => {
    const entries: PendingPullRequest[] = [pendingEntry({ number: 20 }), pendingEntry({ number: 21 })];
    writePendingPullRequests(volume, 'repo-a' as never, { entries });

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, {
        repo_status: () => repoStatus(false),
        pr_status: (req) => {
          const number = (req.input as { number: number }).number;
          return number === 20 ? authorization('the grant no longer includes host.pr.read', []) : infrastructure('transient host read failure');
        },
      }),
    });

    const reports = await createWatcher(deps).tick();
    assert.deepEqual(reports[0]!.stillPending.map((e) => e.number), [21]);

    const remaining = readPendingPullRequests(volume, 'repo-a' as never);
    assert.deepEqual(
      remaining.entries.map((e) => e.number),
      [21],
      'the authorization failure is dropped rather than retried; the infrastructure failure stays pending',
    );
  });
});

test('S24.2 — an entry resolved earlier in a tick is durably removed even when a later entry in the same tick throws', async () => {
  await withVolumeAsync(async (volume) => {
    const entries: PendingPullRequest[] = [pendingEntry({ number: 10 }), pendingEntry({ number: 11 })];
    writePendingPullRequests(volume, 'repo-a' as never, { entries });

    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], {
        pr_status: (req) => {
          const number = (req.input as { number: number }).number;
          if (number === 10) return prStatusResult('closed', { number });
          throw new Error('simulated crash mid-tick');
        },
      }),
    });

    await assert.rejects(() => createWatcher(deps).tick());

    const remaining = readPendingPullRequests(volume, 'repo-a' as never);
    assert.deepEqual(
      remaining.entries.map((e) => e.number),
      [11],
      'entry 10 was already resolved (closed, removed) and persisted before entry 11 threw',
    );
  });
});

test('runRetention() reports an empty pass when no watcher-inboxes directory exists yet', async () => {
  await withVolumeAsync(async (volume) => {
    const { deps } = baseDeps(volume);
    const report = await createWatcher(deps).runRetention();
    assert.equal(report.module, 'watcher');
    assert.equal(report.deletedRows, 0);
  });
});

test('2026-08-13 post-S27 reconciliation — usageBytes reports the real byte total across every declaration\'s inbox', async () => {
  await withVolumeAsync(async (volume) => {
    const { deps } = baseDeps(volume);
    const watcher = createWatcher(deps);

    assert.equal(await watcher.usageBytes(), 0, 'no watcher-inboxes directory exists yet');

    const rootA = inboxRoot(volume, 'repo-a');
    mkdirSync(rootA, { recursive: true });
    writeFileSync(path.join(rootA, 'plan.md'), 'hello world');

    const processedB = path.join(inboxRoot(volume, 'repo-b'), 'processed');
    mkdirSync(processedB, { recursive: true });
    writeFileSync(path.join(processedB, '2026-08-13-old.md'), 'already delivered');

    const expected = Buffer.byteLength('hello world', 'utf8') + Buffer.byteLength('already delivered', 'utf8');
    assert.equal(await watcher.usageBytes(), expected, 'sums bytes across every declaration\'s inbox, inbox and processed alike');
  });
});
