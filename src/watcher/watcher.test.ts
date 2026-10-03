import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { systemClock, type Clock } from '../clock/clock.ts';
import { isoUtcTimestamp } from '../shared/brands.ts';
import { success, validation, authorization, upstream, infrastructure, precondition } from '../result/envelope.ts';
import type { ToolResult } from '../result/envelope.ts';
import type { DispatchRequest, Dispatch } from '../dispatch/dispatch-pipeline.ts';
import type { Declaration } from '../declarations/types.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { DeclarationFilter } from '../declarations/types.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { Clone, CloneState } from '../clone/types.ts';
import type { CloneStoreError } from '../clone/errors.ts';
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

/**
 * `clean` defaults to `true` (a `ready` clone is clean unless a test says
 * otherwise) — `cleanError` forces `isClean` to fail closed instead, and
 * `calls` (when given) counts invocations, for tests proving the
 * needs-attention short-circuit never reaches `isClean` at all.
 */
function stubCloneStore(
  state: { current: CloneState; clean?: boolean; cleanError?: boolean },
  calls?: { isClean: number },
  attentionLog?: { readonly declarationId: unknown; readonly reason: string }[],
): Pick<CloneStore, 'describe' | 'isClean' | 'markAttention'> {
  return {
    async describe(declarationId) {
      const clone: Clone = { declarationId, generation: 1 as never, state: state.current, path: 'unused' as never, sizeBytes: 0, lastOperationAt: null, observedRemote: null, attentionReason: null };
      return { ok: true, value: clone };
    },
    async isClean(_declarationId) {
      if (calls) calls.isClean += 1;
      if (state.cleanError) {
        const error: CloneStoreError = { resultKind: 'precondition', retryable: false, code: 'corrupt-tree', summary: 'stub: forced isClean failure' };
        return { ok: false, error };
      }
      return state.clean === false
        ? { ok: true, value: { clean: false, blockers: [{ kind: 'modified', count: 1 }] } }
        : { ok: true, value: { clean: true } };
    },
    async markAttention(declarationId, reason) {
      attentionLog?.push({ declarationId, reason });
      return { ok: true, value: undefined };
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
        // The pre-claim clean-tree gate is `CloneStore.isClean`, not this
        // dispatched tool (issue #78) — call 1 is the post-apply observation,
        // call 2 the post-stage observation.
        return call === 1 ? repoStatus(true, [{ path: 'content/post.md', staged: false }]) : repoStatus(true, [{ path: 'content/post.md', staged: true }]);
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
 * call count instead, since it legitimately runs twice within the protocol
 * (post-apply, post-stage) regardless of where `failAt` falls, so its fixed
 * position in `order` cannot double as "have we passed the failure point"
 * the way every other step's can. The pre-claim clean-tree gate is
 * `CloneStore.isClean`, not this dispatched tool (issue #78).
 */
function handlersUpTo(failAt: string, failureResult: ToolResult<never>): Record<string, (req: DispatchRequest) => ToolResult<never>> {
  const base = successfulHandlers();
  const wrapped: Record<string, (req: DispatchRequest) => ToolResult<never>> = {};
  const order = ['plan_tool', 'prepare_branch', 'apply_tool', 'git_stage', 'git_commit', 'git_push', 'pr_open', 'pr_enable_auto_merge'];
  const failIndex = order.indexOf(failAt);
  let repoStatusCalls = 0;
  wrapped.repo_status = () => {
    repoStatusCalls += 1;
    return repoStatusCalls === 1 ? repoStatus(true, [{ path: 'content/post.md', staged: false }]) : repoStatus(true, [{ path: 'content/post.md', staged: true }]);
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
    const isCleanCalls = { isClean: 0 };
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations(active),
      cloneStore: stubCloneStore({ current: 'ready' }, isCleanCalls),
      dispatch: scriptedDispatch(dispatchLog, {}),
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
    assert.equal(isCleanCalls.isClean, 1, 'the newly-eligible declaration was resolved without a restart');
  });
});

test('#86 — start() schedules the poll timer using the configured pollIntervalSeconds, not the hardcoded 15s default', async (t) => {
  await withVolumeAsync(async (volume) => {
    const { deps } = baseDeps(volume, { pollIntervalSeconds: 5 });
    const scheduledDelaysMs: unknown[] = [];
    const realSetInterval = globalThis.setInterval;
    t.mock.method(globalThis, 'setInterval', ((_handler: () => void, delay?: number) => {
      scheduledDelaysMs.push(delay);
      // A real, long-delay, unref'd timer so `stop()`'s `clearInterval` has a genuine handle to clear, but the fake schedule never actually fires during the test.
      return realSetInterval(() => undefined, 2 ** 30);
    }) as typeof setInterval);

    const watcher = createWatcher(deps);
    const started = await watcher.start();
    assert.equal(started.ok, true);
    assert.deepEqual(scheduledDelaysMs, [5000], 'the configured 5s interval must reach setInterval, not the 15s contract default');
    await watcher.stop();
  });
});

test('#86 — start() falls back to the contract default of 15s when pollIntervalSeconds is not configured', async (t) => {
  await withVolumeAsync(async (volume) => {
    const { deps } = baseDeps(volume);
    assert.equal(deps.pollIntervalSeconds, undefined);
    const scheduledDelaysMs: unknown[] = [];
    const realSetInterval = globalThis.setInterval;
    t.mock.method(globalThis, 'setInterval', ((_handler: () => void, delay?: number) => {
      scheduledDelaysMs.push(delay);
      return realSetInterval(() => undefined, 2 ** 30);
    }) as typeof setInterval);

    const watcher = createWatcher(deps);
    const started = await watcher.start();
    assert.equal(started.ok, true);
    assert.deepEqual(scheduledDelaysMs, [15000]);
    await watcher.stop();
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

type StateDirectoryName = 'processing' | 'processed' | 'failed';
const STATE_DIRECTORIES: readonly StateDirectoryName[] = ['processing', 'processed', 'failed'];

/** A plain file at a state directory's name is a tamper that needs no symlink privilege to plant, so it runs on every dev host. */
function tamper(root: string, name: StateDirectoryName): void {
  writeFileSync(path.join(root, name), 'not a directory', 'utf8');
}

function tamperPages(notifications: readonly NotificationRequest[]): NotificationRequest[] {
  return notifications.filter((n) => n.subject.kind === 'watcher-state-directory-tampered');
}

function failurePages(notifications: readonly NotificationRequest[]): NotificationRequest[] {
  return notifications.filter((n) => n.subject.kind === 'file-watcher-failed');
}

function pageReason(page: NotificationRequest): string {
  return (page.subject as { reason: string }).reason;
}

function watcherOutcomeKinds(auditLog: readonly AuditAppendInput[]): string[] {
  return auditLog.flatMap((record) => (record.form === 'file-watcher' ? [record.outcome.kind] : []));
}

test('S53.1 — a tick refuses a declaration whose state directory is tampered, with an empty inbox, and makes no dispatch, Git or host call', async () => {
  for (const name of STATE_DIRECTORIES) {
    await withVolumeAsync(async (volume) => {
      const root = inboxRoot(volume, 'repo-a');
      mkdirSync(root, { recursive: true });
      tamper(root, name);

      const calls = { isClean: 0 };
      const { deps, dispatchLog } = baseDeps(volume, {
        declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
        cloneStore: stubCloneStore({ current: 'ready' }, calls),
      });
      const reports = await createWatcher(deps).tick();

      assert.equal(reports[0]!.skipped, 'state-directory-tampered', `${name}/ tampered`);
      assert.equal(reports[0]!.claimed, null);
      assert.equal(reports[0]!.outcome, null);
      assert.equal(dispatchLog.length, 0);
      assert.equal(calls.isClean, 0, 'the tree is never observed either');
      assert.equal(readFileSync(path.join(root, name), 'utf8'), 'not a directory', 'the tampering entry is left untouched');
    });
  }
});

test('S53.1 — the tamper gate runs ahead of the clone gates: a tampered processed/ with a dirty or parked clone is still state-directory-tampered', async () => {
  const states: { current: CloneState; clean?: boolean }[] = [{ current: 'ready', clean: false }, { current: 'needs-attention' }];
  for (const state of states) {
    await withVolumeAsync(async (volume) => {
      const root = inboxRoot(volume, 'repo-a');
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');
      tamper(root, 'processed');

      const { deps } = baseDeps(volume, {
        declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
        cloneStore: stubCloneStore(state),
      });
      const reports = await createWatcher(deps).tick();

      assert.equal(reports[0]!.skipped, 'state-directory-tampered');
      assert.equal(existsSync(path.join(root, 'post.md')), true, 'the file stays in the inbox');
    });
  }
});

test('S53.1 — a symlinked processing/ is refused by the gate and nothing is written through the link', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');
    const outsideDir = path.join(volume, 'outside-processing');
    mkdirSync(outsideDir, { recursive: true });
    try {
      symlinkSync(outsideDir, path.join(root, 'processing'), 'dir');
    } catch {
      return; // No symlink privilege on this host (common on unelevated Windows); the plain-file tests carry the same assertions.
    }

    const { deps, dispatchLog } = baseDeps(volume, { declarations: stubDeclarations({ current: [fixtureDeclaration()] }) });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.skipped, 'state-directory-tampered');
    assert.equal(existsSync(path.join(root, 'post.md')), true);
    assert.deepEqual(readdirSync(outsideDir), []);
    assert.equal(dispatchLog.length, 0);
  });
});

test('S53.2 — a sound declaration beside a tampered one still opens its pull request', async () => {
  await withVolumeAsync(async (volume) => {
    const rootA = inboxRoot(volume, 'repo-a');
    const rootB = inboxRoot(volume, 'repo-b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    writeFileSync(path.join(rootA, 'post.md'), 'content', 'utf8');
    writeFileSync(path.join(rootB, 'post.md'), 'content', 'utf8');
    tamper(rootA, 'processed');

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration(), fixtureDeclaration({ id: 'repo-b' as Declaration['id'] })] }),
      dispatch: scriptedDispatch(dispatchLog, successfulHandlers()),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.skipped, 'state-directory-tampered');
    assert.equal(reports[1]!.skipped, null);
    assert.equal(reports[1]!.outcome?.kind, 'succeeded');
    assert.deepEqual(dispatchLog.filter((r) => r.toolName === 'pr_open').map((r) => r.declarationId), ['repo-b']);
    assert.equal(dispatchLog.some((r) => r.declarationId === 'repo-a'), false, 'nothing at all was dispatched for the tampered declaration');
    assert.equal(existsSync(path.join(rootA, 'post.md')), true, 'the tampered declaration keeps its file in the inbox');
  });
});

test('S53.3 — the gate pages once per tamper at attention, writes no audit record, and a sound tick re-arms the page', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    tamper(root, 'failed');

    const { deps, notifications, auditLog } = baseDeps(volume, { declarations: stubDeclarations({ current: [fixtureDeclaration()] }) });
    const watcher = createWatcher(deps);

    for (let i = 0; i < 3; i += 1) assert.equal((await watcher.tick())[0]!.skipped, 'state-directory-tampered');
    const pages = tamperPages(notifications);
    assert.equal(pages.length, 1, 'three consecutive refusing ticks leave one row');
    assert.equal(pages[0]!.severity, 'attention');
    assert.deepEqual(pages[0]!.subject, { kind: 'watcher-state-directory-tampered', directory: 'failed' });
    assert.equal(auditLog.length, 0, 'a file-less refusal writes no audit record');

    rmSync(path.join(root, 'failed'));
    assert.equal((await watcher.tick())[0]!.skipped, null, 'all three directories sound again');
    tamper(root, 'failed');
    assert.equal((await watcher.tick())[0]!.skipped, 'state-directory-tampered');
    assert.equal(tamperPages(notifications).length, 2, 'a refusal after a sound tick pages again');
    assert.equal(auditLog.length, 0);
  });
});

test('S53.3 — a tampered processing/ at recoverInterruptedClaims pages once at attention and writes no audit record', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    tamper(root, 'processing');

    const { deps, notifications, auditLog } = baseDeps(volume, { declarations: stubDeclarations({ current: [fixtureDeclaration()] }) });
    const recovered = await createWatcher(deps).recoverInterruptedClaims();

    assert.equal(recovered.length, 0);
    const pages = tamperPages(notifications);
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.severity, 'attention');
    assert.deepEqual(pages[0]!.subject, { kind: 'watcher-state-directory-tampered', directory: 'processing' });
    assert.equal(auditLog.length, 0);
  });
});

test('S53.4 — a processing/ swapped after the gate passed leaves the file in the inbox and reports state-directory-tampered, never claim-failed', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const base = stubCloneStore({ current: 'ready' });
    const { deps, dispatchLog, notifications, auditLog } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      cloneStore: {
        ...base,
        async isClean(declarationId) {
          tamper(root, 'processing'); // the swap lands between the gate and the claim
          return base.isClean(declarationId);
        },
      },
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.skipped, 'state-directory-tampered');
    assert.equal(reports[0]!.claimed, null);
    assert.equal(reports[0]!.outcome, null, 'not a claim-failed rejection');
    assert.equal(existsSync(path.join(root, 'post.md')), true);
    assert.equal(dispatchLog.length, 0);
    assert.equal(auditLog.length, 0);
    assert.equal(tamperPages(notifications).length, 1);
  });
});

test('S53.5 — a terminal move into a tampered processed/ throws nothing: the file stays in processing/, the audit outcome is the protocol\'s own, and a page names the directory', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const handlers = successfulHandlers();
    const realPrOpen = handlers.pr_open!;
    handlers.pr_open = (req) => {
      tamper(root, 'processed'); // swapped after the gate passed, before the terminal move
      return realPrOpen(req);
    };
    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], handlers),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.outcome?.kind, 'succeeded', 'the tick returns its report normally');
    assert.equal(existsSync(path.join(root, 'processing', 'post.md')), true, 'the file stays in processing/');
    assert.deepEqual(watcherOutcomeKinds(auditLog), ['succeeded'], 'the protocol\'s own outcome');
    const failures = failurePages(notifications);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.severity, 'attention');
    assert.match(pageReason(failures[0]!), /'processed\/'/);
  });
});

test('S53.5 — a terminal move into a tampered failed/ throws nothing and names failed/', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const handlers = handlersUpTo('plan_tool', upstream('remote rejected', null) as unknown as ToolResult<never>);
    const failing = handlers.plan_tool!;
    handlers.plan_tool = (req) => {
      tamper(root, 'failed');
      return failing(req);
    };
    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], handlers),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.outcome?.kind, 'rejected');
    assert.equal(existsSync(path.join(root, 'processing', 'post.md')), true);
    assert.deepEqual(watcherOutcomeKinds(auditLog), ['rejected']);
    const failures = failurePages(notifications);
    assert.equal(failures.length, 1, 'one page, carrying both the protocol failure and the refused directory');
    assert.match(pageReason(failures[0]!), /'failed\/'/);
  });
});

test('S53.6 — a pull request the protocol opened is in the pending list before its terminal move, and the next reconciliation poll reads it (D19)', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const handlers = successfulHandlers();
    const realPrOpen = handlers.pr_open!;
    handlers.pr_open = (req) => {
      tamper(root, 'processed');
      return realPrOpen(req);
    };
    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, { ...handlers, pr_status: () => prStatusResult('open') }),
    });
    const watcher = createWatcher(deps);
    await watcher.tick();

    const pending = readPendingPullRequests(volume, 'repo-a' as never);
    assert.equal(pending.entries.length, 1, 'the entry exists although the terminal move was refused');
    assert.equal(pending.entries[0]!.number, 7);

    rmSync(path.join(root, 'processed'));
    mkdirSync(path.join(root, 'processed'));
    const reports = await watcher.tick();
    assert.equal(reports[0]!.stillPending.length, 1);
    assert.equal(dispatchLog.some((r) => r.toolName === 'pr_status'), true, 'the poll reads the recorded pull request');
  });
});

test('S53.7 — recovery with a tampered failed/ leaves the file in processing/, audits it, pages, and start succeeds', async () => {
  await withVolumeAsync(async (volume) => {
    const rootA = inboxRoot(volume, 'repo-a');
    mkdirSync(path.join(rootA, 'processing'), { recursive: true });
    writeFileSync(path.join(rootA, 'processing', 'stuck.md'), 'content', 'utf8');
    tamper(rootA, 'failed');

    const { deps, auditLog, notifications } = baseDeps(volume, { declarations: stubDeclarations({ current: [fixtureDeclaration()] }) });
    const watcher = createWatcher(deps);
    const started = await watcher.start();
    await watcher.stop();

    assert.equal(started.ok, true);
    assert.equal(existsSync(path.join(rootA, 'processing', 'stuck.md')), true, 'offered again on the next start');
    assert.deepEqual(watcherOutcomeKinds(auditLog), ['interrupted-claim']);
    const failures = failurePages(notifications);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.severity, 'attention');
    assert.match(pageReason(failures[0]!), /'failed\/'/);
  });
});

test('S53.7 — recovery with a tampered processing/ reads nothing through it, start succeeds, and another declaration is still recovered', async () => {
  await withVolumeAsync(async (volume) => {
    const rootA = inboxRoot(volume, 'repo-a');
    const rootB = inboxRoot(volume, 'repo-b');
    mkdirSync(rootA, { recursive: true });
    tamper(rootA, 'processing');
    mkdirSync(path.join(rootB, 'processing'), { recursive: true });
    writeFileSync(path.join(rootB, 'processing', 'stuck.md'), 'content', 'utf8');

    const { deps, auditLog } = baseDeps(volume, { declarations: stubDeclarations({ current: [fixtureDeclaration()] }) });
    const watcher = createWatcher(deps);
    const started = await watcher.start();
    await watcher.stop();

    assert.equal(started.ok, true);
    assert.equal(readFileSync(path.join(rootA, 'processing'), 'utf8'), 'not a directory');
    assert.equal(existsSync(path.join(rootB, 'processing', 'stuck.md')), false);
    assert.equal(readdirSync(path.join(rootB, 'failed')).some((name) => name.endsWith('-stuck.md')), true, 'the second declaration is recovered');
    assert.deepEqual(auditLog.map((a) => a.declarationId), ['repo-b']);
  });
});

test('S53.8 — runRetention refuses a symlinked processed/, never deleting through the link, and names the declaration', async () => {
  await withVolumeAsync(async (volume) => {
    const outsideDir = path.join(volume, 'outside-processed');
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'old.md');
    writeFileSync(outsideFile, 'not the watcher\'s to delete', 'utf8');
    const old = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(outsideFile, old, old);

    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    try {
      symlinkSync(outsideDir, path.join(root, 'processed'), 'dir');
    } catch {
      return; // No symlink privilege on this host; the plain-file test below carries the same assertions.
    }

    const { deps } = baseDeps(volume, { declarations: stubDeclarations({ current: [] }) });
    const report = await createWatcher(deps).runRetention();

    assert.equal(existsSync(outsideFile), true, 'the file outside the inbox is never deleted through the link');
    assert.equal(report.deletedRows, 0);
    assert.equal(report.skipped.some((s) => s.includes('processed') && s.includes('repo-a')), true, 'the refusal names the declaration');
  });
});

test('S53.8 — runRetention refuses a processed/ that is a plain file, not a directory, and names the declaration', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    tamper(root, 'processed');

    const { deps } = baseDeps(volume, { declarations: stubDeclarations({ current: [] }) });
    const report = await createWatcher(deps).runRetention();

    assert.equal(report.deletedRows, 0);
    assert.equal(report.skipped.some((s) => s.includes('processed') && s.includes('repo-a')), true, 'the refusal names the declaration');
    assert.equal(readFileSync(path.join(root, 'processed'), 'utf8'), 'not a directory', 'the tampering file is left untouched');
  });
});

test('S53.9 — an existing real directory at each state-directory name is used as found, and its mode is not changed', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');
    for (const name of STATE_DIRECTORIES) mkdirSync(path.join(root, name), { mode: 0o755 });

    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], successfulHandlers()),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.outcome?.kind, 'succeeded');
    assert.equal(readdirSync(path.join(root, 'processed')).some((name) => name.endsWith('-post.md')), true, 'used as found');
    if (process.platform !== 'win32') {
      for (const name of ['processing', 'processed'] as const) assert.equal(statSync(path.join(root, name)).mode & 0o777, 0o755, `${name}/ mode untouched`);
    }
  });
});

test('S53.9 — protected watcher directories the watcher creates are owner-only on POSIX', async () => {
  if (process.platform === 'win32') return; // POSIX mode bits are not enforced the same way on Windows.
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, successfulHandlers()),
    });
    await createWatcher(deps).tick();

    assert.equal(statSync(path.join(root, 'processing')).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(root, 'processed')).mode & 0o777, 0o700);

    const pendingDir = path.dirname(pendingPullRequestsPath(volume, 'repo-a' as never));
    assert.equal(statSync(pendingDir).mode & 0o777, 0o700);
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
      cloneStore: stubCloneStore({ current: 'ready', clean: false }),
      dispatch: scriptedDispatch(dirtyLog, {}),
    });
    const dirtyReports = await createWatcher(dirtyDeps).tick();
    assert.equal(dirtyReports[0]!.skipped, 'clone-not-clean');
    assert.equal(existsSync(path.join(root, 'post.md')), true, 'the file stays in the inbox');
    assert.equal(dirtyLog.length, 0, 'a dirty clone makes no dispatch, git, or host call at all (W03.3)');

    const attentionLog: DispatchRequest[] = [];
    const isCleanCalls = { isClean: 0 };
    const { deps: attentionDeps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      cloneStore: stubCloneStore({ current: 'needs-attention' }, isCleanCalls),
      dispatch: scriptedDispatch(attentionLog, {}),
    });
    const attentionReports = await createWatcher(attentionDeps).tick();
    assert.equal(attentionReports[0]!.skipped, 'clone-needs-attention');
    assert.equal(existsSync(path.join(root, 'post.md')), true, 'the file stays in the inbox');
    assert.equal(attentionLog.length, 0, 'needs-attention is decided before any dispatch call');
    assert.equal(isCleanCalls.isClean, 0, 'needs-attention is decided before isClean is even called');
  });
});

test('#78 — a clean-tree check that fails to observe (isClean returns an error) is treated as not clean, never as clean', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      cloneStore: stubCloneStore({ current: 'ready', cleanError: true }),
      dispatch: scriptedDispatch(dispatchLog, {}),
    });
    const reports = await createWatcher(deps).tick();
    assert.equal(reports[0]!.skipped, 'clone-not-clean');
    assert.equal(existsSync(path.join(root, 'post.md')), true, 'the file stays in the inbox');
    assert.equal(dispatchLog.length, 0, 'a failure to observe cleanliness makes no dispatch, git, or host call either');
  });
});

test('#76 W01.15 — a post-apply observation that leaves the declared set parks the clone and stops before git_stage', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const dispatchLog: DispatchRequest[] = [];
    const attentionLog: { readonly declarationId: unknown; readonly reason: string }[] = [];
    const handlers: Record<string, (req: DispatchRequest) => ToolResult<never>> = {
      plan_tool: () => success('planned', PLAN_DATA, diag()) as unknown as ToolResult<never>,
      prepare_branch: () => success('prepared', {}, diag()) as unknown as ToolResult<never>,
      apply_tool: () => success('applied', APPLY_DATA, diag()) as unknown as ToolResult<never>,
      repo_status: () => repoStatus(true, [{ path: 'content/rogue.md', staged: false }]),
      git_stage: () => {
        throw new Error('git_stage dispatched after a post-apply mismatch was supposed to stop the sequence');
      },
    };
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      cloneStore: stubCloneStore({ current: 'ready' }, undefined, attentionLog),
      dispatch: scriptedDispatch(dispatchLog, handlers),
    });
    const auditLog: AuditAppendInput[] = [];
    const reports = await createWatcher({ ...deps, audit: stubAudit(auditLog) }).tick();

    assert.equal(reports[0]!.outcome!.kind, 'rejected');
    if (reports[0]!.outcome!.kind === 'rejected') {
      assert.equal(reports[0]!.outcome!.step, 'repo_status_after_apply');
      assert.equal(reports[0]!.outcome!.result, 'infrastructure');
      assert.match(reports[0]!.outcome!.reason, /after-apply/);
      assert.match(reports[0]!.outcome!.reason, /content\/rogue\.md/);
    }

    assert.equal(attentionLog.length, 1, 'a post-apply mismatch marks the clone needs-attention');
    assert.equal(attentionLog[0]!.declarationId, 'repo-a');
    assert.match(attentionLog[0]!.reason, /declared/);
    assert.match(attentionLog[0]!.reason, /observed/);
    assert.match(attentionLog[0]!.reason, /permitted/);

    const failedDir = path.join(root, 'failed');
    const failedFiles = readdirSync(failedDir);
    const errorFile = failedFiles.find((name) => name.endsWith('.error.txt'));
    assert.ok(errorFile, 'a sibling error file is written to failed/');
    const errorText = readFileSync(path.join(failedDir, errorFile!), 'utf8');
    assert.match(errorText, /declared/);
    assert.match(errorText, /observed/);
    assert.match(errorText, /unstaged/);
    assert.match(errorText, /permitted/);
  });
});

test('#76 W01.15 — a post-stage observation reporting an unstaged path parks the clone and stops before git_commit', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const dispatchLog: DispatchRequest[] = [];
    const attentionLog: { readonly declarationId: unknown; readonly reason: string }[] = [];
    let repoStatusCalls = 0;
    const handlers: Record<string, (req: DispatchRequest) => ToolResult<never>> = {
      plan_tool: () => success('planned', PLAN_DATA, diag()) as unknown as ToolResult<never>,
      prepare_branch: () => success('prepared', {}, diag()) as unknown as ToolResult<never>,
      apply_tool: () => success('applied', APPLY_DATA, diag()) as unknown as ToolResult<never>,
      repo_status: () => {
        repoStatusCalls += 1;
        return repoStatusCalls === 1
          ? repoStatus(true, [{ path: 'content/post.md', staged: false }])
          : repoStatus(true, [{ path: 'content/post.md', staged: false }]);
      },
      git_stage: () => success('staged', { staged: ['content/post.md'] }, diag()) as unknown as ToolResult<never>,
      git_commit: () => {
        throw new Error('git_commit dispatched after a post-stage mismatch was supposed to stop the sequence');
      },
    };
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      cloneStore: stubCloneStore({ current: 'ready' }, undefined, attentionLog),
      dispatch: scriptedDispatch(dispatchLog, handlers),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.outcome!.kind, 'rejected');
    if (reports[0]!.outcome!.kind === 'rejected') {
      assert.equal(reports[0]!.outcome!.step, 'repo_status_after_stage');
      assert.match(reports[0]!.outcome!.reason, /after-stage/);
    }
    assert.equal(attentionLog.length, 1, 'a post-stage mismatch marks the clone needs-attention');
    assert.match(attentionLog[0]!.reason, /unstaged.*content\/post\.md/s);
  });
});

test('#76 W01.16 — a candidate that is not readable as strict UTF-8 is rejected before any dispatch, Git, or host call', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    // 0xff is not a valid UTF-8 lead byte in any sequence.
    writeFileSync(path.join(root, 'post.md'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, {}),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(dispatchLog.length, 0, 'malformed UTF-8 makes no dispatch, Git, or host call (W01.16)');
    assert.equal(reports[0]!.outcome!.kind, 'rejected');
    if (reports[0]!.outcome!.kind === 'rejected') {
      assert.equal(reports[0]!.outcome!.step, 'read');
      assert.equal(reports[0]!.outcome!.result, 'validation');
    }
    assert.equal(existsSync(path.join(root, 'post.md')), false, 'the unreadable candidate is moved out of the inbox');
    const failedDir = path.join(root, 'failed');
    assert.equal(readdirSync(failedDir).some((name) => !name.endsWith('.error.txt')), true, 'the unreadable file itself lands in failed/');
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
      ['plan_tool', 'prepare_branch', 'apply_tool', 'repo_status', 'git_stage', 'repo_status', 'git_commit', 'git_push', 'pr_open', 'pr_enable_auto_merge'],
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

/**
 * The sibling of S17.7 below, for an observation that is *unreadable* rather
 * than merely mismatched. The dispatch pipeline validates every result against
 * the tool's own output schema, so this shape cannot arrive through the wired
 * pipeline — which is the point: **D12** is the watcher's own comparison, and
 * it must hold against any injected `Dispatch`, not only a validating one.
 * Before the readers, this reached `.changedPaths.map(...)` on `undefined` and
 * threw out of `tick()` mid-apply, with a commit possibly already made and no
 * `failed/` entry saying so (post-S36 reconciliation).
 */
test('S17.7/D12 — an unreadable post-apply observation is refused as a terminal failure, not thrown, and git_stage is never dispatched', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const dispatchLog: DispatchRequest[] = [];
    const handlers = successfulHandlers();
    handlers.repo_status = () => {
      // The one `repo_status` call reached here is the post-apply observation
      // — the pre-claim clean-tree gate is `CloneStore.isClean`, not this
      // dispatched tool (issue #78). A body with no `changedPaths` at all —
      // the shape the cast used to assert rather than check.
      return success(
        'status',
        { branch: 'main', baseBranch: 'main', dirty: true, parkedOffBase: false, ahead: 0, behind: 0, observedRemote: null, readStamp: { lastSettledOperationId: null, mutationInFlight: false } },
        { operationId: null, declarationId: null, generation: null, durationMs: 0 },
      ) as unknown as ToolResult<never>;
    };

    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, handlers),
    });

    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.outcome?.kind, 'rejected');
    if (reports[0]!.outcome?.kind === 'rejected') {
      assert.equal(reports[0]!.outcome.step, 'repo_status_after_apply');
      assert.equal(reports[0]!.outcome.result, 'infrastructure');
    }
    assert.equal(dispatchLog.some((r) => r.toolName === 'git_stage'), false, 'no staging may start from an observation nobody could read');

    const failedFiles = readdirSync(path.join(root, 'failed'));
    assert.ok(failedFiles.find((f) => f.endsWith('-post.md')), 'the file is preserved in failed/');
    const errorFile = failedFiles.find((f) => f.endsWith('-post.md.error.txt'));
    assert.ok(errorFile);
    assert.match(readFileSync(path.join(root, 'failed', errorFile!), 'utf8'), /repo_status_after_apply/);
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
        // The one `repo_status` call reached here is the post-apply
        // observation, reporting a DIFFERENT path than the apply result
        // claimed — the pre-claim clean-tree gate is `CloneStore.isClean`,
        // not this dispatched tool (issue #78).
        repo_status: () => repoStatus(true, [{ path: 'content/unexpected.md', staged: false }]),
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
        // Call 1 is the post-apply observation (matches the apply result,
        // unstaged); call 2 is the post-stage observation, still not staged —
        // the pre-claim clean-tree gate is `CloneStore.isClean`, not this
        // dispatched tool (issue #78).
        repo_status: () => repoStatus(true, [{ path: 'content/post.md', staged: false }]),
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

const PUSHED_SHA = 'a'.repeat(40);
const MOVED_SHA = 'b'.repeat(40);

function pendingEntry(overrides: Partial<PendingPullRequest> = {}): PendingPullRequest {
  return {
    declarationId: 'repo-a' as never,
    number: 7,
    branch: 'watcher/post-1' as never,
    openedAt: systemClock.now(),
    sourceFile: 'post.md' as never,
    headSha: PUSHED_SHA as never,
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

    await createWatcher(deps).tick();

    const remaining = readPendingPullRequests(volume, 'repo-a' as never);
    assert.deepEqual(
      remaining.entries.map((e) => e.number),
      [11],
      'entry 10 was already resolved (closed, removed) and persisted before entry 11 threw; entry 11 stays pending',
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

test('usageBytes never follows a symlink — not to a file outside the inbox, and not into a loop', async () => {
  // The candidate scan already refuses symlinks with a link-preserving stat
  // (S17.4 above), so a symlink in an inbox is anticipated input rather than
  // a hypothetical. The usage walk used `statSync`, which follows: it counted
  // a target living elsewhere on the volume against `watcher-files`, and a
  // link to its own parent made the walk push the same subtree forever —
  // an unbounded synchronous loop that wedged the process, since
  // `readVolumeUsage` runs on the post-mutation path (review of PR #112).
  await withVolumeAsync(async (volume) => {
    const { deps } = baseDeps(volume);
    const watcher = createWatcher(deps);

    const rootA = inboxRoot(volume, 'repo-a');
    mkdirSync(rootA, { recursive: true });
    writeFileSync(path.join(rootA, 'plan.md'), 'hello world');

    // A file that lives outside the inboxes entirely, linked from inside one.
    const outside = path.join(volume, 'not-a-watcher-file.bin');
    writeFileSync(outside, 'x'.repeat(10_000));

    let symlinked = true;
    try {
      symlinkSync(outside, path.join(rootA, 'link-to-outside.md'));
      // And a directory symlink pointing back at its own parent.
      symlinkSync(rootA, path.join(rootA, 'loop'), 'dir');
    } catch {
      symlinked = false;
    }
    if (!symlinked) {
      // No symlink privilege on this host (common on unelevated Windows) — nothing to assert.
      return;
    }

    const total = await watcher.usageBytes();
    assert.equal(
      total,
      Buffer.byteLength('hello world', 'utf8'),
      'only the one real file counts — the link target is not watcher usage, and the loop terminates',
    );
  });
});

function fixedClock(at: string): Clock {
  const parsed = isoUtcTimestamp(at);
  if (!parsed.ok) throw new Error('bad fixture timestamp');
  return { now: () => parsed.value, monotonicMs: () => 0 };
}

test('#80 — a second terminal drop sharing the first drop\'s original name is not overwritten in failed/', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'first content', 'utf8');

    // A frozen clock: both terminal moves below build the identical
    // timestamp-prefixed target name, `${timestampPrefix(clock.now())}-post.md`.
    // `repo_status` cycles 1=post-apply, 2=post-stage on every tick — the
    // pre-claim clean-tree gate is `CloneStore.isClean`, not this dispatched
    // tool (issue #78) — `handlersUpTo`'s own counter never resets, so it
    // cannot be reused across two full ticks the way this reproduction needs.
    let repoStatusCalls = 0;
    const dispatch = scriptedDispatch([], {
      ...successfulHandlers(),
      repo_status: () => {
        repoStatusCalls += 1;
        const pos = ((repoStatusCalls - 1) % 2) + 1;
        return pos === 1 ? repoStatus(true, [{ path: 'content/post.md', staged: false }]) : repoStatus(true, [{ path: 'content/post.md', staged: true }]);
      },
      git_push: () => upstream('remote rejected the push', null) as unknown as ToolResult<never>,
    });
    const { deps } = baseDeps(volume, {
      clock: fixedClock('2026-01-01T00:00:00.000Z'),
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch,
    });
    const watcher = createWatcher(deps);

    const first = await watcher.tick();
    assert.equal(first[0]!.outcome?.kind, 'rejected');
    const afterFirst = readdirSync(path.join(root, 'failed'));
    assert.equal(afterFirst.filter((f) => f.endsWith('-post.md')).length, 1, 'first drop landed in failed/');

    // A second drop under the same original name, same declaration, same clock tick.
    writeFileSync(path.join(root, 'post.md'), 'second content', 'utf8');
    const second = await watcher.tick();
    assert.equal(second[0]!.outcome?.kind, 'rejected');

    const afterSecond = readdirSync(path.join(root, 'failed'));
    const dataFiles = afterSecond.filter((f) => f.endsWith('-post.md'));
    assert.equal(dataFiles.length, 2, 'both drops are retained under distinct paths in failed/, not clobbering each other');
  });
});

test('S49.2/S49.4 — auto-merge and the pending record carry the head git_push returned, and reconciliation pins to it', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');
    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration({ fileWatcher: { planTool: 'plan_tool' as never, applyTool: 'apply_tool' as never, autoMerge: true } })] }),
      dispatch: scriptedDispatch(dispatchLog, successfulHandlers()),
    });
    await createWatcher(deps).tick();

    const enable = dispatchLog.find((r) => r.toolName === 'pr_enable_auto_merge')!;
    assert.deepEqual(enable.input, { number: 7, expectedHeadSha: PUSHED_SHA });
    assert.equal(readPendingPullRequests(volume, 'repo-a' as never).entries[0]!.headSha, PUSHED_SHA);
  });
});

test('S49.2 — a push result without a valid headSha fails closed at git_push and reaches no host operation', async () => {
  for (const data of [{ branch: 'watcher/post-1', alreadyUpToDate: false }, { branch: 'watcher/post-1', headSha: 'not-a-sha', alreadyUpToDate: false }, { branch: 'watcher/post-1', headSha: 'A'.repeat(40), alreadyUpToDate: false }]) {
    await withVolumeAsync(async (volume) => {
      const root = inboxRoot(volume, 'repo-a');
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');
      const dispatchLog: DispatchRequest[] = [];
      const { deps } = baseDeps(volume, {
        declarations: stubDeclarations({ current: [fixtureDeclaration({ fileWatcher: { planTool: 'plan_tool' as never, applyTool: 'apply_tool' as never, autoMerge: true } })] }),
        dispatch: scriptedDispatch(dispatchLog, { ...successfulHandlers(), git_push: () => success('pushed', data, diag()) as unknown as ToolResult<never> }),
      });
      const reports = await createWatcher(deps).tick();
      assert.equal(reports[0]!.outcome?.kind, 'rejected');
      if (reports[0]!.outcome?.kind === 'rejected') assert.equal(reports[0]!.outcome.step, 'git_push');
      const names = dispatchLog.map((r) => r.toolName as string);
      assert.equal(names.includes('pr_open'), false);
      assert.equal(names.includes('pr_enable_auto_merge'), false);
      assert.equal(existsSync(path.join(root, 'processed')), false);
      assert.equal(readPendingPullRequests(volume, 'repo-a' as never).entries.length, 0);
    });
  }
});

test('S49.4/S49.5 — reconciliation supplies the persisted head, not the head pr_status now reports', async () => {
  await withVolumeAsync(async (volume) => {
    writePendingPullRequests(volume, 'repo-a' as never, { entries: [pendingEntry({ number: 9 })] });
    const dispatchLog: DispatchRequest[] = [];
    const { deps } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, {
        repo_status: () => repoStatus(false),
        pr_status: () => prStatusResult('merged', { number: 9, headSha: MOVED_SHA }),
        reconcile_after_merge: () => success('reconciled', {}, diag()) as unknown as ToolResult<never>,
      }),
    });
    await createWatcher(deps).tick();
    const reconcile = dispatchLog.find((r) => r.toolName === 'reconcile_after_merge')!;
    assert.deepEqual(reconcile.input, { pullRequestNumber: 9, expectedHeadSha: PUSHED_SHA });
  });
});

test('S49.2 — an invalid pending entry is discarded with no dispatch and paged once at attention', async () => {
  await withVolumeAsync(async (volume) => {
    const { headSha: _dropped, ...legacy } = pendingEntry({ number: 11 });
    writePendingPullRequests(volume, 'repo-a' as never, { entries: [legacy as never, pendingEntry({ number: 12, headSha: 'zz' as never })] });
    const dispatchLog: DispatchRequest[] = [];
    const { deps, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch(dispatchLog, { repo_status: () => repoStatus(false) }),
    });
    const watcher = createWatcher(deps);
    await watcher.tick();
    assert.equal(dispatchLog.some((r) => r.toolName === 'pr_status' || r.toolName === 'reconcile_after_merge'), false);
    assert.equal(notifications.length, 2);
    assert.equal(notifications.every((n) => n.subject.kind === 'watcher-pending-record-discarded' && n.severity === 'attention'), true);
    assert.deepEqual(readPendingPullRequests(volume, 'repo-a' as never).entries, []);
    await watcher.tick();
    assert.equal(notifications.length, 2, 'paged once, not per tick');
  });
});

// ---- S50 — every watcher outcome is audited, and every failure is told ----

test('S50.1 — a terminal move into processed/ that throws is audited and notified at attention, and the tick still returns its report', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const handlers = successfulHandlers();
    const realPrOpen = handlers.pr_open!;
    handlers.pr_open = (req) => {
      rmSync(path.join(root, 'processing', 'post.md')); // the rename source vanishes, so the move throws
      return realPrOpen(req);
    };
    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], handlers),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.outcome?.kind, 'succeeded');
    assert.deepEqual(watcherOutcomeKinds(auditLog), ['succeeded']);
    const failures = failurePages(notifications);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.severity, 'attention');
    assert.match(pageReason(failures[0]!), /the move into 'processed\/' failed/);
    assert.equal(readPendingPullRequests(volume, 'repo-a' as never).entries.length, 1, 'D19: the pull request is still followed');
  });
});

test('S50.1 — a terminal move into failed/ that throws is audited and notified at attention, naming failed/', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const handlers = handlersUpTo('plan_tool', upstream('remote rejected', null) as unknown as ToolResult<never>);
    const failing = handlers.plan_tool!;
    handlers.plan_tool = (req) => {
      rmSync(path.join(root, 'processing', 'post.md'));
      return failing(req);
    };
    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], handlers),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.outcome?.kind, 'rejected');
    assert.deepEqual(watcherOutcomeKinds(auditLog), ['rejected']);
    const failures = failurePages(notifications);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.severity, 'attention');
    assert.match(pageReason(failures[0]!), /the move into 'failed\/' failed/);
  });
});

test('S50.2 — an exception thrown mid-protocol is audited and notified at attention, the file stays in processing/, and the tick resolves', async () => {
  await withVolumeAsync(async (volume) => {
    const root = inboxRoot(volume, 'repo-a');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

    const handlers = successfulHandlers();
    handlers.git_commit = () => {
      throw new Error('simulated disk failure');
    };
    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], handlers),
    });
    const reports = await createWatcher(deps).tick();

    assert.equal(reports[0]!.claimed, 'post.md');
    assert.equal(reports[0]!.outcome?.kind, 'rejected');
    assert.deepEqual(watcherOutcomeKinds(auditLog), ['rejected']);
    const failures = failurePages(notifications);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.severity, 'attention');
    assert.match(pageReason(failures[0]!), /simulated disk failure/);
    assert.equal(existsSync(path.join(root, 'processing', 'post.md')), true, 'what the protocol did before throwing is unknown, so D8 moves the file at the next start');
  });
});

test('S50.2 — an exception while following a pending pull request is audited and notified against the file that opened it, and the entry stays pending', async () => {
  await withVolumeAsync(async (volume) => {
    writePendingPullRequests(volume, 'repo-a' as never, { entries: [pendingEntry({ number: 11 })] });
    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], {
        repo_status: () => repoStatus(false),
        pr_status: () => {
          throw new Error('simulated crash mid-tick');
        },
      }),
    });
    const reports = await createWatcher(deps).tick();

    assert.deepEqual(reports[0]!.stillPending.map((e) => e.number), [11]);
    assert.deepEqual(watcherOutcomeKinds(auditLog), ['rejected']);
    const failures = failurePages(notifications);
    assert.equal(failures.length, 1);
    assert.match(pageReason(failures[0]!), /#11.*simulated crash mid-tick/);
    assert.equal(readPendingPullRequests(volume, 'repo-a' as never).entries.length, 1);
  });
});

test('S50.3 — a failed pr_enable_auto_merge after pr_open leaves the file in processed/, audits and notifies at attention naming the open pull request', async () => {
  for (const mode of ['error-result', 'throws'] as const) {
    await withVolumeAsync(async (volume) => {
      const root = inboxRoot(volume, 'repo-a');
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, 'post.md'), 'content', 'utf8');

      const handlers = successfulHandlers();
      handlers.pr_enable_auto_merge = () => {
        if (mode === 'throws') throw new Error('host exploded');
        return precondition('auto-merge is disabled on the repository', []) as unknown as ToolResult<never>;
      };
      const { deps, auditLog, notifications } = baseDeps(volume, {
        declarations: stubDeclarations({ current: [fixtureDeclaration({ fileWatcher: { planTool: 'plan_tool' as never, applyTool: 'apply_tool' as never, autoMerge: true } })] }),
        dispatch: scriptedDispatch([], handlers),
      });
      const reports = await createWatcher(deps).tick();

      assert.equal(reports[0]!.outcome?.kind, 'succeeded', `${mode}: the file is delivered`);
      assert.equal(readdirSync(path.join(root, 'processed')).length, 1, `${mode}: the file is in processed/`);
      assert.equal(existsSync(path.join(root, 'failed')) && readdirSync(path.join(root, 'failed')).length > 0, false, `${mode}: never moved to failed/`);
      assert.deepEqual(watcherOutcomeKinds(auditLog), ['succeeded', 'rejected']);
      const rejected = auditLog.find((r) => r.form === 'file-watcher' && r.outcome.kind === 'rejected');
      assert.equal(rejected?.form === 'file-watcher' && rejected.outcome.kind === 'rejected' ? rejected.outcome.step : null, 'pr_enable_auto_merge');
      const failures = failurePages(notifications);
      assert.equal(failures.length, 1, mode);
      assert.equal(failures[0]!.severity, 'attention');
      assert.match(pageReason(failures[0]!), /pull request #7 \(https:\/\/example\.com\/pr\/7\) is open/);
      assert.equal(readPendingPullRequests(volume, 'repo-a' as never).entries.length, 1, `${mode}: still followed`);
    });
  }
});

test('S50.4/S50.5 — a merged pull request whose reconciliation succeeds is audited as succeeded with its ref, raises no page, and leaves the list', async () => {
  await withVolumeAsync(async (volume) => {
    writePendingPullRequests(volume, 'repo-a' as never, { entries: [pendingEntry({ number: 9, branch: 'watcher/post-9' as never })] });
    const { deps, auditLog, notifications } = baseDeps(volume, {
      declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
      dispatch: scriptedDispatch([], {
        repo_status: () => repoStatus(false),
        pr_status: () => prStatusResult('merged', { number: 9, branch: 'watcher/post-9' }),
        reconcile_after_merge: () => success('reconciled', {}, diag()) as unknown as ToolResult<never>,
      }),
    });
    await createWatcher(deps).tick();

    const record = auditLog.find((r) => r.form === 'file-watcher');
    assert.equal(record?.form === 'file-watcher' ? record.outcome.kind : null, 'succeeded');
    if (record?.form === 'file-watcher' && record.outcome.kind === 'succeeded') {
      assert.equal(record.outcome.pullRequest.number, 9);
      assert.equal(record.file, 'post.md');
    }
    assert.equal(failurePages(notifications).length, 0);
    assert.equal(readPendingPullRequests(volume, 'repo-a' as never).entries.length, 0);
  });
});

test('S50.4/S50.5 — a merged pull request whose reconciliation fails is audited and paged at attention naming the PR, branch, pushed SHA and reason, and leaves the list', async () => {
  for (const mode of ['error-result', 'throws'] as const) {
    await withVolumeAsync(async (volume) => {
      writePendingPullRequests(volume, 'repo-a' as never, { entries: [pendingEntry({ number: 9, branch: 'watcher/post-9' as never })] });
      const { deps, auditLog, notifications } = baseDeps(volume, {
        declarations: stubDeclarations({ current: [fixtureDeclaration()] }),
        dispatch: scriptedDispatch([], {
          repo_status: () => repoStatus(false),
          pr_status: () => prStatusResult('merged', { number: 9, branch: 'watcher/post-9' }),
          reconcile_after_merge: () => {
            if (mode === 'throws') throw new Error('pipeline fell over');
            return precondition('base is not fast-forwardable', []) as unknown as ToolResult<never>;
          },
        }),
      });
      const reports = await createWatcher(deps).tick();

      assert.deepEqual(reports[0]!.reconciled.map((e) => e.number), [9], mode);
      assert.deepEqual(watcherOutcomeKinds(auditLog), ['rejected'], mode);
      const failures = failurePages(notifications);
      assert.equal(failures.length, 1, mode);
      assert.equal(failures[0]!.severity, 'attention');
      const reason = pageReason(failures[0]!);
      assert.match(reason, /#9/);
      assert.match(reason, /watcher\/post-9/);
      assert.match(reason, new RegExp(PUSHED_SHA));
      assert.match(reason, mode === 'throws' ? /pipeline fell over/ : /base is not fast-forwardable/);
      assert.equal(readPendingPullRequests(volume, 'repo-a' as never).entries.length, 0, `${mode}: removed after the first attempt`);
    });
  }
});

test('S50.7 — production watcher code contains no `as never` casts', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => /\bas never\b/.test(readFileSync(path.join(dir, name), 'utf8')));
  assert.deepEqual(offenders, []);
});
