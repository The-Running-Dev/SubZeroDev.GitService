import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import { gitSha, watchedFileName, type DeclarationId, type WatchedFileName, type GitSha, type IsoUtcTimestamp, type OperationId, type RegistryToolName, type SessionId, type Subject } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { Session } from '../shared/session.ts';
import type { Clock } from '../clock/clock.ts';
import type { Dispatch } from '../dispatch/dispatch-pipeline.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { CloneStoreError } from '../clone/errors.ts';
import type { Audit } from '../audit/audit.ts';
import type { PullRequestRef, WatchedFileOutcome } from '../audit/types.ts';
import type { Notifier } from '../notifier/notifier.ts';
import type { StructuredStore, StoreTransaction } from '../store/structured-store.ts';
import { capabilityScopeOf, type CapabilityName, type ContractCapabilitySet } from '../contract/capabilities.ts';
import type { JsonValue } from '../contract/json.ts';
import type { ToolResult } from '../result/envelope.ts';
import { isError, type ResultKind } from '../shared/result-kind.ts';
import type { OperationContextKind } from '../shared/actor.ts';
import { directoryBytes, unlinkAndCountBytes, type RetentionReport } from '../shared/retention.ts';
import { watcherError, type WatcherError } from './errors.ts';
import type { FileWatcherPlanData, PendingPullRequest, WatchTickReport } from './types.ts';
import { readPendingPullRequestsWithDiscards, readPendingPullRequests, writePendingPullRequests, type DiscardedPendingEntry } from './pending-pull-requests.ts';

/** `20-contract.md` § L2 — watcher. */
export interface Watcher {
  start(): Promise<Outcome<void, WatcherError>>;
  stop(): Promise<void>;
  recoverInterruptedClaims(): Promise<readonly WatchTickReport[]>;
  tick(): Promise<readonly WatchTickReport[]>;
  runRetention(): Promise<RetentionReport>;
  /**
   * `VolumeUsage.byConsumer['watcher-files']` (2026-08-13 post-S27
   * reconciliation) — the real byte total across every declaration's inbox
   * (`inbox/`, `processing/`, `processed/`, `failed/` alike), not only the
   * `processed/` window `runRetention` above already ages out.
   */
  usageBytes(): Promise<number>;
}

export interface WatcherDependencies {
  readonly volumeRoot: string;
  readonly clock: Clock;
  readonly dispatch: Dispatch;
  readonly declarations: Pick<Declarations, 'list'>;
  readonly cloneStore: Pick<CloneStore, 'describe' | 'ensure' | 'isClean' | 'markAttention'>;
  readonly audit: Pick<Audit, 'append'>;
  readonly notifier: Pick<Notifier, 'enqueue'>;
  readonly store: Pick<StructuredStore, 'transaction'>;
  readonly contractCapabilitySet: ContractCapabilitySet;
  /** `DeploymentConfig.remoteOperationsPermitted`. Default off. */
  readonly remoteOperationsPermitted: boolean;
  /** `DeploymentConfig.watcher.enabled`. Default off. */
  readonly watcherEnabled: boolean;
  /** `DeploymentConfig.watcher.pollIntervalSeconds`. Contract default 15. */
  readonly pollIntervalSeconds?: number;
  readonly processedFileDays?: number;
}

const POLL_INTERVAL_SECONDS_DEFAULT = 15;
const PROCESSED_FILE_DAYS_DEFAULT = 14;
const RESERVED_INBOX_ENTRIES = new Set(['processing', 'processed', 'failed']);

function rejectedOutcome(step: string, result: ResultKind, reason: string): WatchedFileOutcome {
  return { kind: 'rejected', step, result, reason };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}

function isSubset(a: readonly string[], b: readonly string[]): boolean {
  const setB = new Set(b);
  return a.every((value) => setB.has(value));
}

/**
 * `20-contract.md` § File watcher / `apply-paths-mismatch`: the sibling error
 * file must carry all four sets so an operator can see exactly what the
 * consumer's apply handler claimed against what the watcher independently
 * observed.
 */
function mismatchReason(observation: 'after-apply' | 'after-stage', declared: readonly string[], observed: readonly string[], unstaged: readonly string[], permitted: readonly string[]): string {
  return [
    `apply-paths-mismatch at ${observation}: the consumer's apply handler broke the protocol`,
    `declared: ${JSON.stringify(declared)}`,
    `observed: ${JSON.stringify(observed)}`,
    `unstaged: ${JSON.stringify(unstaged)}`,
    `permitted: ${JSON.stringify(permitted)}`,
  ].join('\n');
}

type StateDirectory = 'processing' | 'processed' | 'failed';

/** A declaration's id, or the one tick-level key (S50.2). */
type ExceptionLatchKey = string;

/** Whether anything in one declaration's work caught an exception; the declaration's page latch re-arms only when nothing did. */
interface WorkState {
  caught: boolean;
}

/**
 * A terminal move's result: refusing a tampered directory is data, never a throw (D18),
 * and a filesystem error during the move is data too (S50.1), so neither escapes the tick unrecorded.
 */
type MoveFailure =
  | { readonly directory: StateDirectory; readonly cause: 'refused' }
  | { readonly directory: StateDirectory; readonly cause: 'error'; readonly message: string };
type MoveResult = { readonly moved: true } | { readonly moved: false; readonly failure: MoveFailure };

function describeMoveFailure(failure: MoveFailure): string {
  return failure.cause === 'refused'
    ? `'${failure.directory}/' is not a real directory, so the file stays in 'processing/' (D18)`
    : `the move into '${failure.directory}/' failed (${failure.message}), so the file may remain in 'processing/' (D8)`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `20-contract.md` § L2 — watcher, D18: `processing/`, `processed/`, and
 * `failed/` are names the untrusted drop mount can also write, ahead of the
 * watcher itself. A link-preserving `lstatSync` — never `existsSync` or
 * `statSync`, both of which follow a symlink — is checked before any of the
 * three is created or used, and a missing entry is not a tamper: `mkdirSync`
 * will make it a real directory. `lstatSync` never reports a symlink as a
 * directory, so `!isDirectory()` alone also catches it, without a second
 * `isSymbolicLink()` check.
 */
function isTamperedStateDir(dir: string): boolean {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return false;
  }
  return !stat.isDirectory();
}

const PROTECTED_DIR_MODE = 0o700;

/** Windows and Linux both refuse `:` in a filename, so the ISO timestamp prefix is sanitised for both. */
function timestampPrefix(at: IsoUtcTimestamp): string {
  return (at as string).replace(/[:.]/g, '-');
}

function readStrictUtf8(fullPath: string): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  let buffer: Buffer;
  try {
    buffer = readFileSync(fullPath);
  } catch {
    return { ok: false };
  }
  try {
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
  } catch {
    return { ok: false };
  }
}

/**
 * `20-contract.md` § L2 — watcher. Constructed with `Dispatch` injected,
 * exactly as the scheduler is (that module does not exist yet — the watcher
 * is the first unattended actor to ship). Every git and host step goes
 * through `dispatch`, so this module imports neither `GitOperations` nor
 * `HostAdapter`. `CloneStore.describe` and `CloneStore.isClean` are the two
 * exceptions, and both are read directly rather than through `dispatch`
 * (issue #78); `CloneStore.ensure` is the third, called only to materialise
 * an `absent` or `evicted` clone on first use (S51). Distinguishing
 * `clone-not-clean` from `clone-needs-attention`
 * (`WatchTickReport.skipped`) needs the clone's own lifecycle state, which a
 * `repo_status` read cannot report, and the clean-tree gate itself must
 * observe Git at the moment of the call rather than trust that lifecycle
 * state — `Clone.state === 'ready'` says the directory is materialised and
 * carries no attention mark, and says nothing about the working tree (**D16**).
 * Going through `dispatch` for the gate would also audit and journal a call
 * whose only purpose is deciding whether to act at all.
 */
/**
 * A dispatch result is opaque JSON. The watcher narrows only the fields it
 * uses, and checks them — it does not import the producing module's output
 * type and assert the shape.
 *
 * These were `as unknown as` casts. On the production path they were backed by
 * something real — the dispatch pipeline validates every result against the
 * tool's own `outputSchema` before returning it, and `repo_status`'s schema
 * requires `changedPaths` with both members — so this is not a bug being
 * fixed. It is where **D12** and **D13** stop depending on a guarantee made
 * two modules away: the watcher asserts what it reads, so its own comparison
 * holds against any injected `Dispatch`, validating or not, rather than only
 * against the one the composition root happens to wire (post-S36
 * reconciliation). Removing the casts also removed the watcher's direct edges
 * onto `git/types.ts` and `host/types.ts`, which `10-design.md`'s module table
 * had claimed it did not have.
 *
 * Every reader below returns `null` on anything it cannot verify, and every
 * caller treats `null` as a refusal.
 *
 * `pending-pull-requests.ts`'s `isWellFormedEntry` is the same idiom, applied
 * to the same problem one file over.
 */

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, JsonValue>;
}

/** `repo_status`'s `dirty` and `changedPaths`, the only two the watcher reads. */
function readRepoStatus(value: JsonValue | undefined): { readonly dirty: boolean; readonly changedPaths: readonly { readonly path: string; readonly staged: boolean }[] } | null {
  const record = asRecord(value);
  if (record === null || typeof record.dirty !== 'boolean' || !Array.isArray(record.changedPaths)) return null;
  const changedPaths: { readonly path: string; readonly staged: boolean }[] = [];
  for (const entry of record.changedPaths) {
    const item = asRecord(entry);
    if (item === null || typeof item.path !== 'string' || typeof item.staged !== 'boolean') return null;
    changedPaths.push({ path: item.path, staged: item.staged });
  }
  return { dirty: record.dirty, changedPaths };
}

/** The apply handler's declared changed paths. Already schema-validated by dispatch (**D11**); read here because the comparison below must not trust a cast. */
function readAppliedChangedPaths(value: JsonValue | undefined): readonly string[] | null {
  const record = asRecord(value);
  if (record === null || !Array.isArray(record.changedPaths)) return null;
  if (!record.changedPaths.every((entry): entry is string => typeof entry === 'string')) return null;
  return record.changedPaths;
}

/** `pr_open`'s `ref`. The two branded members are checked as strings and branded here, where the check is. */
function readPullRequestRef(value: JsonValue | undefined): PullRequestRef | null {
  const ref = asRecord(asRecord(value)?.ref);
  if (ref === null) return null;
  if (typeof ref.number !== 'number' || !Number.isFinite(ref.number)) return null;
  if (typeof ref.url !== 'string' || typeof ref.branch !== 'string') return null;
  return { number: ref.number, url: ref.url as PullRequestRef['url'], branch: ref.branch as PullRequestRef['branch'] };
}

/** `git_push`'s `headSha`, validated. D20: the only source of the SHA both merge operations are pinned to. */
function readPushedHeadSha(value: JsonValue | undefined): GitSha | null {
  const headSha = asRecord(value)?.headSha;
  if (typeof headSha !== 'string') return null;
  const parsed = gitSha(headSha);
  return parsed.ok ? parsed.value : null;
}

/** `pr_status`'s `state` and `headSha` — the only two the reconciliation reads. */
function readPullRequestState(value: JsonValue | undefined): { readonly state: string; readonly headSha: string; readonly ref: PullRequestRef } | null {
  const status = asRecord(asRecord(value)?.status);
  if (status === null || typeof status.state !== 'string' || typeof status.headSha !== 'string') return null;
  const ref = readPullRequestRef(status);
  if (ref === null) return null;
  return { state: status.state, headSha: status.headSha, ref };
}

export function createWatcher(deps: WatcherDependencies): Watcher {
  const { volumeRoot, clock, dispatch, declarations, cloneStore, audit, notifier, store, contractCapabilitySet, remoteOperationsPermitted, watcherEnabled } = deps;
  const pollIntervalSeconds = deps.pollIntervalSeconds ?? POLL_INTERVAL_SECONDS_DEFAULT;
  const processedFileDays = deps.processedFileDays ?? PROCESSED_FILE_DAYS_DEFAULT;

  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let tickInFlight: Promise<readonly WatchTickReport[]> | null = null;

  function watcherInboxesRoot(): string {
    return path.join(volumeRoot, 'watcher-inboxes');
  }
  function inboxRootFor(declarationId: DeclarationId): string {
    return path.join(watcherInboxesRoot(), declarationId as string);
  }
  function processingDirFor(declarationId: DeclarationId): string {
    return path.join(inboxRootFor(declarationId), 'processing');
  }
  function processedDirFor(declarationId: DeclarationId): string {
    return path.join(inboxRootFor(declarationId), 'processed');
  }
  function failedDirFor(declarationId: DeclarationId): string {
    return path.join(inboxRootFor(declarationId), 'failed');
  }

  /**
   * `20-contract.md` invariant A7: `declaration.manage`, `auth.manage`,
   * `audit.read` and `attention.resolve` are absent from every profile whose
   * kind is `mcp`, `scheduler` or `watcher`. The watcher's grant is scoped to
   * declaration-scoped capabilities only, so it never inherits an
   * instance-scoped capability a future tool declaration might add to
   * `contractCapabilitySet`.
   */
  const declarationScopedCapabilities = new Set(
    [...(contractCapabilitySet as unknown as ReadonlySet<CapabilityName>)].filter((capability) => capabilityScopeOf(capability) === 'declaration'),
  ) as unknown as Session['grant'];

  function watcherSessionFor(declaration: Declaration): Session {
    return {
      id: randomUUID() as SessionId,
      kind: 'watcher',
      actorRef: { kind: 'watcher', subject: `watcher:${declaration.id}` as Subject, clientId: null, grantId: null },
      repositoryBinding: declaration.id,
      grant: declarationScopedCapabilities,
      frozenAtEpoch: declaration.grantEpoch as unknown as Session['frozenAtEpoch'],
    };
  }

  const RECOVERY_ACTOR_REF: ActorRef = { kind: 'watcher', subject: 'watcher:recovery' as Subject, clientId: null, grantId: null };

  async function callTool(toolName: string, input: JsonValue, declaration: Declaration, session: Session): Promise<ToolResult<JsonValue>> {
    const controller = new AbortController();
    return dispatch({
      toolName: toolName as RegistryToolName,
      input,
      session,
      declarationId: declaration.id,
      scheduledJobId: null,
      context: 'normal',
      signal: controller.signal,
    });
  }

  /** What `runProtocol` learned that its `WatchedFileOutcome` has no room for. */
  interface ProtocolProgress {
    headSha: GitSha | null;
    autoMergeFailure: { readonly result: ResultKind; readonly reason: string } | null;
  }

  /**
   * The full per-file protocol `20-contract.md` § L2 — watcher fixes: the
   * declaration-selected plan tool, `prepare_branch`, the declaration-selected
   * apply tool, the two independent `repo_status` observations and `git_stage`
   * (invariants D12/D13), `git_commit`, `git_push`, `pr_open`, then
   * `pr_enable_auto_merge` when configured. Each call is dispatched
   * independently with no outer lock, per the design's own "the composite is
   * not wrapped in an outer lock".
   */
  async function runProtocol(declaration: Declaration, session: Session, file: string, content: string, progress: ProtocolProgress): Promise<WatchedFileOutcome> {
    const fw = declaration.fileWatcher;
    if (fw === null) {
      // Unreachable in practice: `tick` only selects declarations from
      // `declarations.list({ hasFileWatcher: true })`. Guarded because
      // `Declaration.fileWatcher` is nullable in the type.
      return rejectedOutcome('plan', 'infrastructure', 'declaration no longer names a file watcher');
    }

    const planResult = await callTool(fw.planTool, { sourceFile: file, content }, declaration, session);
    if (!planResult.ok || planResult.data === undefined) return rejectedOutcome('plan', planResult.kind, planResult.summary);
    const plan = planResult.data as unknown as FileWatcherPlanData;

    const prepared = await callTool('prepare_branch', { branch: plan.branch }, declaration, session);
    if (!prepared.ok) return rejectedOutcome('prepare_branch', prepared.kind, prepared.summary);

    const applied = await callTool(fw.applyTool, { permittedPaths: plan.permittedPaths, plan: plan.plan }, declaration, session);
    if (!applied.ok || applied.data === undefined) return rejectedOutcome('apply', applied.kind, applied.summary);
    const declaredChangedPaths = readAppliedChangedPaths(applied.data);
    if (declaredChangedPaths === null) return rejectedOutcome('apply', 'infrastructure', 'the apply result did not carry a readable changedPaths array');

    const statusAfterApply = await callTool('repo_status', {}, declaration, session);
    if (!statusAfterApply.ok || statusAfterApply.data === undefined) return rejectedOutcome('repo_status_after_apply', statusAfterApply.kind, statusAfterApply.summary);
    const afterApplyData = readRepoStatus(statusAfterApply.data);
    if (afterApplyData === null) return rejectedOutcome('repo_status_after_apply', 'infrastructure', 'the status observation was unreadable, so the apply result could not be independently confirmed');
    const observedAfterApply = afterApplyData.changedPaths.map((entry) => entry.path);
    if (!sameSet(observedAfterApply, declaredChangedPaths) || !isSubset(observedAfterApply, plan.permittedPaths as readonly string[])) {
      const reason = mismatchReason('after-apply', declaredChangedPaths, observedAfterApply, [], plan.permittedPaths as readonly string[]);
      await cloneStore.markAttention(declaration.id, reason);
      return rejectedOutcome('repo_status_after_apply', 'infrastructure', reason);
    }

    const staged = await callTool('git_stage', { paths: declaredChangedPaths }, declaration, session);
    if (!staged.ok) return rejectedOutcome('git_stage', staged.kind, staged.summary);

    const statusAfterStage = await callTool('repo_status', {}, declaration, session);
    if (!statusAfterStage.ok || statusAfterStage.data === undefined) return rejectedOutcome('repo_status_after_stage', statusAfterStage.kind, statusAfterStage.summary);
    const afterStageData = readRepoStatus(statusAfterStage.data);
    if (afterStageData === null) return rejectedOutcome('repo_status_after_stage', 'infrastructure', 'the status observation was unreadable, so the staged set could not be independently confirmed');
    const stagedPaths = afterStageData.changedPaths.map((entry) => entry.path);
    const unstagedPaths = afterStageData.changedPaths.filter((entry) => !entry.staged).map((entry) => entry.path);
    if (!sameSet(stagedPaths, declaredChangedPaths) || unstagedPaths.length > 0) {
      const reason = mismatchReason('after-stage', declaredChangedPaths, stagedPaths, unstagedPaths, plan.permittedPaths as readonly string[]);
      await cloneStore.markAttention(declaration.id, reason);
      return rejectedOutcome('repo_status_after_stage', 'infrastructure', reason);
    }

    const committed = await callTool('git_commit', { message: plan.commitMessage }, declaration, session);
    if (!committed.ok) return rejectedOutcome('git_commit', committed.kind, committed.summary);

    const pushResult = await callTool('git_push', { branch: plan.branch }, declaration, session);
    if (!pushResult.ok) return rejectedOutcome('git_push', pushResult.kind, pushResult.summary);
    // D20: no valid pushed head, no pull request — nothing reaches the host.
    const pushedHeadSha = readPushedHeadSha(pushResult.data);
    if (pushedHeadSha === null) return rejectedOutcome('git_push', 'infrastructure', 'the push result did not carry a valid headSha, so auto-merge and reconciliation cannot be pinned to the pushed commit');
    progress.headSha = pushedHeadSha;

    const prOpened = await callTool(
      'pr_open',
      { title: plan.pullRequest.title, body: plan.pullRequest.body, headBranch: plan.branch, draft: false },
      declaration,
      session,
    );
    if (!prOpened.ok || prOpened.data === undefined) return rejectedOutcome('pr_open', prOpened.kind, prOpened.summary);
    const prRef = readPullRequestRef(prOpened.data);
    if (prRef === null) return rejectedOutcome('pr_open', 'infrastructure', 'the pull request was opened but its ref was unreadable, so the file cannot be recorded as delivered');

    if (fw.autoMerge) {
      // The pull request is already open, which is the point at which the
      // design calls the file delivered (`10-design.md` § "the unattended pull
      // request is followed to its end" — "a local commit nobody is told
      // about is not delivery", not "an auto-merge-enabled pull request"). A
      // failed enable-call must not relabel an already-delivered file as
      // failed and is not retried here, but it is recorded for the caller to
      // audit and notify (S50.3), naming the pull request that stays open.
      try {
        const enabled = await callTool('pr_enable_auto_merge', { number: prRef.number, expectedHeadSha: pushedHeadSha as string }, declaration, session);
        if (!enabled.ok) progress.autoMergeFailure = { result: enabled.kind, reason: enabled.summary };
      } catch (error) {
        progress.autoMergeFailure = { result: 'infrastructure', reason: errorMessage(error) };
      }
    }

    return { kind: 'succeeded', pullRequest: prRef };
  }

  async function auditAndNotify(
    declarationId: DeclarationId,
    generation: Declaration['generation'] | null,
    actorRef: ActorRef,
    context: OperationContextKind,
    file: WatchedFileName,
    outcome: WatchedFileOutcome,
    moveFailure: MoveFailure | null = null,
    latchKey: ExceptionLatchKey | null = null,
  ): Promise<void> {
    await audit.append({
      at: clock.now(),
      operationId: null,
      declarationId,
      generation,
      tool: null,
      actorRef,
      context,
      form: 'file-watcher',
      file,
      outcome,
    });

    // D18, S50.1: a failed terminal move keeps the protocol's own audit outcome above and adds a page naming the directory.
    if (outcome.kind === 'succeeded' && moveFailure === null) return;
    const outcomeReason =
      outcome.kind === 'succeeded' ? `pull request #${outcome.pullRequest.number} was opened` : outcome.kind === 'rejected' ? `step '${outcome.step}' returned ${outcome.result}: ${outcome.reason}` : outcome.reason;
    const reason = moveFailure === null ? outcomeReason : `${outcomeReason}; ${describeMoveFailure(moveFailure)}`;
    // S50.2: the audit record above is written every time; only the page is latched.
    if (latchKey !== null) {
      if (exceptionPaged.has(latchKey)) return;
      exceptionPaged.add(latchKey);
    }
    const notified = await store.transaction(async (tx: StoreTransaction) => {
      notifier.enqueue(
        {
          severity: 'attention',
          declarationId,
          subject: { kind: 'file-watcher-failed', file, reason },
          summary: `watched file '${file}' failed for declaration '${declarationId}': ${reason}`,
        },
        tx,
      );
    });
    if (!notified.ok) {
      if (latchKey !== null) exceptionPaged.delete(latchKey);
      console.error(`watcher: failed to enqueue attention notification for '${file}' (declaration '${declarationId}'): ${notified.error.summary}`);
    }
  }

  /**
   * S50.2's latch (`20-contract.md` § L2 — watcher, *Exceptions in a tick*): one page per key per
   * process, for a file-less exception or a throw while following a pending pull request. The key is
   * the declaration, or one tick-level key. In-memory by design, and separate from `tamperPaged`.
   */
  const exceptionPaged = new Set<ExceptionLatchKey>();
  const TICK_LATCH_KEY: ExceptionLatchKey = '<tick>';
  const TICK_ACTOR_REF: ActorRef = { kind: 'watcher', subject: 'watcher:tick' as Subject, clientId: null, grantId: null };

  /** A file-less exception: audited every time as `watcher-tick-failed`, paged once per latch key. */
  async function reportTickFailure(declaration: Declaration | null, error: unknown): Promise<void> {
    const reason = errorMessage(error);
    const key: ExceptionLatchKey = declaration === null ? TICK_LATCH_KEY : declaration.id;
    await audit.append({
      at: clock.now(),
      operationId: null,
      declarationId: declaration === null ? null : declaration.id,
      generation: declaration === null ? null : declaration.generation,
      tool: null,
      actorRef: declaration === null ? TICK_ACTOR_REF : watcherSessionFor(declaration).actorRef,
      context: 'normal',
      form: 'watcher-tick-failed',
      reason,
    });
    if (exceptionPaged.has(key)) return;
    exceptionPaged.add(key);
    const notified = await store.transaction(async (tx: StoreTransaction) => {
      notifier.enqueue(
        {
          severity: 'attention',
          declarationId: declaration === null ? null : declaration.id,
          subject: { kind: 'watcher-tick-failed', reason },
          summary: `a watcher tick${declaration === null ? '' : ` for declaration '${declaration.id}'`} failed with an exception, and what it interrupted is unknown: ${reason}`,
        },
        tx,
      );
    });
    if (!notified.ok) {
      exceptionPaged.delete(key);
      console.error(`watcher: failed to enqueue tick-failed notification: ${notified.error.summary}`);
    }
  }

  async function notifyDiscardedPending(declarationId: DeclarationId, discarded: DiscardedPendingEntry): Promise<void> {
    const label = discarded.pullRequestNumber === null ? 'a pull request whose number is unreadable' : `pull request #${discarded.pullRequestNumber}`;
    const notified = await store.transaction(async (tx: StoreTransaction) => {
      notifier.enqueue(
        {
          severity: 'attention',
          declarationId,
          subject: { kind: 'watcher-pending-record-discarded', pullRequestNumber: discarded.pullRequestNumber, branch: discarded.branch },
          summary: `the pending record for ${label} failed validation and was discarded without reconciliation; finish it by hand`,
        },
        tx,
      );
    });
    if (!notified.ok) {
      console.error(`watcher: failed to enqueue discarded-record notification for declaration '${declarationId}': ${notified.error.summary}`);
    }
  }

  /**
   * `20-contract.md` § L2 — watcher: two terminal moves landing on the same
   * timestamp-prefixed name (the same original filename delivered again
   * within the same clock tick) must never let the later one overwrite the
   * earlier — `renameSync` would otherwise silently clobber it. The prefix
   * gets a deterministic `-2`, `-3`, … counter suffix ahead of the preserved
   * original filename, so the target always still ends in `-${file}`.
   */
  function uniqueTerminalName(dir: string, prefix: string, file: string): string {
    let candidatePrefix = prefix;
    let n = 2;
    while (existsSync(path.join(dir, `${candidatePrefix}-${file}`))) {
      candidatePrefix = `${prefix}-${n}`;
      n += 1;
    }
    return `${candidatePrefix}-${file}`;
  }

  /** The first of the declaration's three state directories that is tampered (D18), or null. */
  function tamperedStateDirectory(declarationId: DeclarationId): StateDirectory | null {
    if (isTamperedStateDir(processingDirFor(declarationId))) return 'processing';
    if (isTamperedStateDir(processedDirFor(declarationId))) return 'processed';
    if (isTamperedStateDir(failedDirFor(declarationId))) return 'failed';
    return null;
  }

  /**
   * D18's latch: declarations already paged for a tamper in this process. Paging
   * only — every refusing tick still reports its skip. In-memory by design, so a
   * restart re-pages a tamper that is still present.
   */
  const tamperPaged = new Set<DeclarationId>();

  async function pageTamperOnce(declarationId: DeclarationId, directory: StateDirectory): Promise<void> {
    if (tamperPaged.has(declarationId)) return;
    tamperPaged.add(declarationId);
    const notified = await store.transaction(async (tx: StoreTransaction) => {
      notifier.enqueue(
        {
          severity: 'attention',
          declarationId,
          subject: { kind: 'watcher-state-directory-tampered', directory },
          summary: `the watcher's '${directory}/' directory for declaration '${declarationId}' is not a real directory; delivery for it is stopped until it is replaced or removed`,
        },
        tx,
      );
    });
    if (!notified.ok) {
      // A page that was never enqueued must not count as given: release the latch so the next refusal tries again.
      tamperPaged.delete(declarationId);
      console.error(`watcher: failed to enqueue state-directory-tampered notification for declaration '${declarationId}': ${notified.error.summary}`);
    }
  }

  function moveToFailed(declarationId: DeclarationId, sourcePath: string, file: string, reasonText: string): MoveResult {
    const failedDir = failedDirFor(declarationId);
    if (isTamperedStateDir(failedDir)) return { moved: false, failure: { directory: 'failed', cause: 'refused' } };
    try {
      mkdirSync(failedDir, { recursive: true, mode: PROTECTED_DIR_MODE });
      const failedName = uniqueTerminalName(failedDir, timestampPrefix(clock.now()), file);
      renameSync(sourcePath, path.join(failedDir, failedName));
      writeFileSync(path.join(failedDir, `${failedName}.error.txt`), reasonText, 'utf8');
      return { moved: true };
    } catch (error) {
      return { moved: false, failure: { directory: 'failed', cause: 'error', message: errorMessage(error) } };
    }
  }

  function moveToProcessed(declarationId: DeclarationId, sourcePath: string, file: string): MoveResult {
    const processedDir = processedDirFor(declarationId);
    if (isTamperedStateDir(processedDir)) return { moved: false, failure: { directory: 'processed', cause: 'refused' } };
    try {
      mkdirSync(processedDir, { recursive: true, mode: PROTECTED_DIR_MODE });
      const target = path.join(processedDir, uniqueTerminalName(processedDir, timestampPrefix(clock.now()), file));
      renameSync(sourcePath, target);
      // `renameSync` never updates mtime, and `runRetention` ages files in
      // `processed/` off their mtime — left alone, a file that sat unclaimed in
      // the inbox for close to `processedFileDays` would carry that original
      // drop-time mtime through delivery and become eligible for deletion right
      // after landing here.
      const deliveredAt = new Date(clock.now());
      utimesSync(target, deliveredAt, deliveredAt);
      return { moved: true };
    } catch (error) {
      return { moved: false, failure: { directory: 'processed', cause: 'error', message: errorMessage(error) } };
    }
  }

  /** The candidate the next claim should try, or null when the inbox holds no eligible file — a symlink (S17.4) or a subdirectory never qualifies. */
  function pickCandidate(declarationId: DeclarationId): WatchedFileName | null {
    const root = inboxRootFor(declarationId);
    if (!existsSync(root)) return null;
    const names = readdirSync(root)
      .filter((name) => !RESERVED_INBOX_ENTRIES.has(name))
      .sort();
    for (const name of names) {
      const full = path.join(root, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const validated = watchedFileName(name);
      if (!validated.ok) continue;
      return validated.value;
    }
    return null;
  }

  /** `tampered` is D18's condition caught after the gate passed; `failed` is a rename that failed, which is `claim-failed`. */
  function claim(declarationId: DeclarationId, file: string): 'claimed' | 'tampered' | 'failed' {
    const processingDir = processingDirFor(declarationId);
    if (isTamperedStateDir(processingDir)) return 'tampered';
    mkdirSync(processingDir, { recursive: true, mode: PROTECTED_DIR_MODE });
    try {
      renameSync(path.join(inboxRootFor(declarationId), file), path.join(processingDir, file));
      return 'claimed';
    } catch {
      return 'failed';
    }
  }

  function emptyReport(
    declarationId: DeclarationId,
    skipped: WatchTickReport['skipped'],
    reconciled: readonly PendingPullRequest[] = [],
    stillPending: readonly PendingPullRequest[] = [],
  ): WatchTickReport {
    return { declarationId, skipped, claimed: null, outcome: null, reconciled, stillPending };
  }

  /** S50.4: one `reconcile_after_merge` attempt for a pull request reported merged; the normal outcome is audited, a failure audited and notified at `attention`. */
  async function reconcileMerged(declaration: Declaration, session: Session, entry: PendingPullRequest, ref: PullRequestRef): Promise<void> {
    let failure: { readonly result: ResultKind; readonly reason: string } | null = null;
    try {
      const result = await callTool('reconcile_after_merge', { pullRequestNumber: entry.number, expectedHeadSha: entry.headSha as string }, declaration, session);
      if (!result.ok) failure = { result: result.kind, reason: result.summary };
    } catch (error) {
      failure = { result: 'infrastructure', reason: errorMessage(error) };
    }
    const outcome: WatchedFileOutcome =
      failure === null
        ? { kind: 'succeeded', pullRequest: ref }
        : rejectedOutcome(
            'reconcile_after_merge',
            failure.result,
            `pull request #${entry.number} on branch '${entry.branch}' merged at pushed head ${entry.headSha as string}, but reconciling the clone failed: ${failure.reason}`,
          );
    await auditAndNotify(declaration.id, declaration.generation, session.actorRef, 'normal', entry.sourceFile, outcome);
  }

  /**
   * `20-contract.md` § L2 — watcher, `PendingPullRequestList`, and `30-slices.md`
   * § S24. "Each tick re-reads host state" (S24.2) — independent of the
   * clean-tree gate `tickOneDeclaration` applies before claiming a new file
   * (S24.3: "No watcher lock spans either the status read or the composite").
   * An open pull request or a transient `pr_status` failure stays pending; a
   * closed one is dropped without reconciliation; a merged one dispatches
   * `reconcile_after_merge` once and is dropped whether that succeeds or
   * fails — never retried, per S24.2's own text. Both dispatch calls go
   * through the ordinary pipeline, which already audits the call and, for a
   * timeout, parks and later notifies via boot recovery (`10-design.md` §
   * control flow #1). On top of that, S50.4 audits the file's terminal
   * outcome once a merged pull request is reconciled, and tells the operator
   * when that reconciliation failed.
   *
   * The list is written after **each** entry is resolved, not once after the
   * whole loop: a process killed mid-tick — the same event
   * `recoverInterruptedClaims` exists to recover from — must not re-dispatch
   * `reconcile_after_merge` for an entry this tick already reconciled. Each
   * write reflects every decision made so far plus the entries not yet
   * reached this tick.
   */
  async function reconcilePendingPullRequests(declaration: Declaration, session: Session, work: WorkState): Promise<{ reconciled: readonly PendingPullRequest[]; stillPending: readonly PendingPullRequest[] }> {
    const list = readPendingPullRequestsWithDiscards(volumeRoot, declaration.id);
    if (list.entries.length === 0 && list.discarded.length === 0) return { reconciled: [], stillPending: [] };

    // D20: page before the rewrite that drops them. A failed rewrite leaves the
    // entry in place and the next tick pages again, which is accepted.
    if (list.discarded.length > 0) {
      for (const discarded of list.discarded) await notifyDiscardedPending(declaration.id, discarded);
      writePendingPullRequests(volumeRoot, declaration.id, { entries: list.entries });
    }

    const reconciled: PendingPullRequest[] = [];
    const stillPending: PendingPullRequest[] = [];

    for (let index = 0; index < list.entries.length; index += 1) {
      const entry = list.entries[index]!;
      let statusResult: ToolResult<JsonValue>;
      try {
        statusResult = await callTool('pr_status', { number: entry.number }, declaration, session);
      } catch (error) {
        // S50.2: an exception while following a pull request is attributed to the file that opened it; the entry stays pending.
        work.caught = true;
        const reason = `pull request #${entry.number} on branch '${entry.branch}' could not be followed: ${errorMessage(error)}`;
        await auditAndNotify(declaration.id, declaration.generation, session.actorRef, 'normal', entry.sourceFile, rejectedOutcome('pr_status', 'infrastructure', reason), null, declaration.id);
        stillPending.push(entry);
        writePendingPullRequests(volumeRoot, declaration.id, { entries: [...stillPending, ...list.entries.slice(index + 1)] });
        continue;
      }
      const statusData = statusResult.ok ? readPullRequestState(statusResult.data) : null;

      if (!statusResult.ok || statusData === null) {
        // `isError` (`upstream`/`timeout`/`infrastructure`) is a transient
        // read failure and stays pending for the next tick. A non-transient
        // one — `validation`/`authorization`/`precondition`/`conflict`, e.g.
        // the declaration's grant no longer includes `host.pr.read` — will
        // never succeed on retry either, so it is dropped here instead of
        // retried forever. There is no `TerminalState` variant this can
        // raise an `attention` notification through without widening the
        // closed union in `20-contract.md`; the per-call audit record
        // `dispatch` already wrote for this `pr_status` call is this entry's
        // only trail until that contract amendment exists.
        if (statusResult.ok || isError(statusResult.kind)) stillPending.push(entry);
      } else {
        if (statusData.state === 'open') {
          stillPending.push(entry);
        } else if (statusData.state === 'closed') {
          // Removed without reconciliation (S24.2) — neither list.
        } else {
          // S50.4: the record leaves the list after this one attempt whatever it returns — the write
          // below runs on every path out of here — so a failure is told rather than retried forever.
          await reconcileMerged(declaration, session, entry, statusData.ref);
          reconciled.push(entry);
        }
      }

      writePendingPullRequests(volumeRoot, declaration.id, { entries: [...stillPending, ...list.entries.slice(index + 1)] });
    }

    return { reconciled, stillPending };
  }

  /**
   * S51: the same `CloneStore.ensure` every other first use goes through. The handle is released at
   * once — the clean-tree gate and the protocol's dispatched calls each take what they need, and the
   * watcher holds nothing across them (invariant C3, as a read does).
   */
  async function materialiseClone(declaration: Declaration): Promise<Outcome<void, CloneStoreError>> {
    const holder = { operationId: randomUUID() as OperationId, declarationId: declaration.id, tool: 'file-watcher' as RegistryToolName, heldSince: clock.now() };
    const ensured = await cloneStore.ensure(declaration, holder, new AbortController().signal);
    if (!ensured.ok) return ensured;
    ensured.value.materialisationLock.release();
    ensured.value.activePin.release();
    return ok(undefined);
  }

  async function tickOneDeclaration(declaration: Declaration, work: WorkState): Promise<WatchTickReport> {
    const session = watcherSessionFor(declaration);

    // D18's gate comes first: it makes no dispatch, Git or host call, so a dirty or
    // parked clone cannot mask a tamper, and reconciliation waits with everything else.
    const tampered = tamperedStateDirectory(declaration.id);
    if (tampered !== null) {
      await pageTamperOnce(declaration.id, tampered);
      return emptyReport(declaration.id, 'state-directory-tampered', [], readPendingPullRequests(volumeRoot, declaration.id).entries);
    }
    tamperPaged.delete(declaration.id);

    const { reconciled, stillPending } = await reconcilePendingPullRequests(declaration, session, work);

    const described = await cloneStore.describe(declaration.id);
    const cloneState = described.ok ? described.value.state : null;
    // S51: only a clone genuinely parked is a mark to clear. A clone whose state cannot be read, or
    // that waits on recovery, has no tree the gate can vouch for — "a failure to observe is not a clean
    // tree either", the same fold `isClean` below gets.
    if (cloneState === 'needs-attention') {
      return emptyReport(declaration.id, 'clone-needs-attention', reconciled, stillPending);
    }
    if (cloneState === null || cloneState === 'dirty' || cloneState === 'recovery-pending') {
      return emptyReport(declaration.id, 'clone-not-clean', reconciled, stillPending);
    }

    let candidate: WatchedFileName | null = null;
    if (cloneState !== 'ready') {
      // `absent`, `evicted`, `materialising`: servable on first use (`10-design.md` § Servability of an
      // unmaterialised declaration, D15). First use is a dropped file, so a poll over an empty inbox
      // clones nothing.
      candidate = pickCandidate(declaration.id);
      if (candidate === null) return emptyReport(declaration.id, null, reconciled, stillPending);
      const materialised = await materialiseClone(declaration);
      if (!materialised.ok) {
        // S51.3: told, not parked. The file stays in the inbox, so the next tick retries it.
        const outcome = rejectedOutcome('clone', materialised.error.resultKind, materialised.error.summary);
        await auditAndNotify(declaration.id, declaration.generation, session.actorRef, 'normal', candidate, outcome);
        return { declarationId: declaration.id, skipped: null, claimed: null, outcome, reconciled, stillPending };
      }
    }

    // `20-contract.md` § L2 — watcher: "the clean-tree gate is
    // `CloneStore.isClean`, and it runs before the claim, not after it." A
    // failure to observe is not a clean tree either (`isClean`'s own
    // contract) — `cleanliness.ok === false` is folded into `clone-not-clean`
    // the same as `clean: false`, both leaving the inbox untouched.
    const cleanliness = await cloneStore.isClean(declaration.id);
    if (!cleanliness.ok || !cleanliness.value.clean) {
      return emptyReport(declaration.id, 'clone-not-clean', reconciled, stillPending);
    }

    candidate ??= pickCandidate(declaration.id);
    if (candidate === null) return emptyReport(declaration.id, null, reconciled, stillPending);

    const claimed = claim(declaration.id, candidate);
    if (claimed === 'tampered') {
      await pageTamperOnce(declaration.id, 'processing');
      return emptyReport(declaration.id, 'state-directory-tampered', reconciled, stillPending);
    }
    if (claimed === 'failed') {
      // `20-contract.md` § Watcher, `claim-failed`: "every outcome above is
      // audited, and every failure notifies at attention" — the file stays
      // in the inbox (nothing is moved) and is retried on the next tick.
      const outcome = rejectedOutcome('claim', 'infrastructure', 'the claim into processing/ failed');
      await auditAndNotify(declaration.id, declaration.generation, session.actorRef, 'normal', candidate, outcome);
      return { declarationId: declaration.id, skipped: null, claimed: null, outcome, reconciled, stillPending };
    }

    const processingPath = path.join(processingDirFor(declaration.id), candidate);
    const progress: ProtocolProgress = { headSha: null, autoMergeFailure: null };
    let outcome: WatchedFileOutcome;
    let moveFailure: MoveFailure | null = null;
    try {
      const read = readStrictUtf8(processingPath);
      if (!read.ok) {
        outcome = rejectedOutcome('read', 'validation', 'the claimed file is not readable as strict UTF-8');
      } else {
        outcome = await runProtocol(declaration, session, candidate, read.value, progress);
      }

      if (outcome.kind === 'succeeded') {
        // D19: the pull request is recorded before the terminal move is attempted, so a
        // refused or failed move can never leave an open pull request nobody follows.
        const pending = readPendingPullRequests(volumeRoot, declaration.id);
        const entry: PendingPullRequest = {
          declarationId: declaration.id,
          number: outcome.pullRequest.number,
          branch: outcome.pullRequest.branch,
          openedAt: clock.now(),
          sourceFile: candidate,
          headSha: progress.headSha as GitSha, // runProtocol only succeeds after recording it (D20)
        };
        writePendingPullRequests(volumeRoot, declaration.id, { entries: [...pending.entries, entry] });
        const moved = moveToProcessed(declaration.id, processingPath, candidate);
        if (!moved.moved) moveFailure = moved.failure;
      } else {
        const reasonText = outcome.kind === 'rejected' ? `step '${outcome.step}' returned ${outcome.result}: ${outcome.reason}` : outcome.reason;
        const moved = moveToFailed(declaration.id, processingPath, candidate, reasonText);
        if (!moved.moved) moveFailure = moved.failure;
      }
    } catch (error) {
      work.caught = true;
      // S50.2: an exception after the claim is recorded against the claimed file. The file stays in
      // 'processing/' — what the protocol did before throwing is unknown — and D8 moves it at the next start.
      outcome = rejectedOutcome('tick', 'infrastructure', `the tick threw while delivering the file, which stays in 'processing/': ${errorMessage(error)}`);
    }

    await auditAndNotify(declaration.id, declaration.generation, session.actorRef, 'normal', candidate, outcome, moveFailure);
    if (progress.autoMergeFailure !== null && outcome.kind === 'succeeded') {
      // S50.3: the file is delivered and stays where it moved to; the open pull request is what the operator is told about.
      await auditAndNotify(
        declaration.id,
        declaration.generation,
        session.actorRef,
        'normal',
        candidate,
        rejectedOutcome(
          'pr_enable_auto_merge',
          progress.autoMergeFailure.result,
          `pull request #${outcome.pullRequest.number} (${outcome.pullRequest.url as string}) is open but auto-merge could not be enabled: ${progress.autoMergeFailure.reason}`,
        ),
      );
    }

    return { declarationId: declaration.id, skipped: null, claimed: candidate, outcome, reconciled, stillPending };
  }

  /** S50.2's first boundary: nothing escaping one declaration's work stops another's. */
  async function tickGuarded(declaration: Declaration): Promise<WatchTickReport> {
    const work: WorkState = { caught: false };
    try {
      const report = await tickOneDeclaration(declaration, work);
      if (!work.caught) exceptionPaged.delete(declaration.id);
      return report;
    } catch (error) {
      await reportTickFailure(declaration, error);
      return emptyReport(declaration.id, 'tick-failed');
    }
  }

  return {
    async start(): Promise<Outcome<void, WatcherError>> {
      if (!remoteOperationsPermitted) {
        return err(watcherError({ code: 'not-permitted', missingSwitch: 'remote-operations' }, 'remote operations are not permitted; the watcher will not start'));
      }
      if (!watcherEnabled) {
        return err(watcherError({ code: 'not-permitted', missingSwitch: 'watcher-enabled' }, 'the watcher is not enabled; the watcher will not start'));
      }

      await this.recoverInterruptedClaims();

      if (pollHandle === null) {
        pollHandle = setInterval(() => {
          // Reentrancy guard, matching the notifier's `deliveryInFlight`
          // pattern (`src/server.ts`): a tick whose network-bound protocol
          // steps outlast `pollIntervalSeconds` must not let the next firing
          // start a second, overlapping tick on the same working tree. The
          // `.catch` also ensures a thrown fs error (e.g. a locked file)
          // never becomes an unhandled rejection that kills the process.
          if (tickInFlight !== null) return;
          tickInFlight = this.tick()
            .catch((error: unknown) => {
              console.error(`watcher: tick failed: ${error instanceof Error ? error.message : String(error)}`);
              return [] as readonly WatchTickReport[];
            })
            .finally(() => {
              tickInFlight = null;
            });
        }, pollIntervalSeconds * 1000);
        pollHandle.unref?.();
      }
      return ok(undefined);
    },

    async stop(): Promise<void> {
      if (pollHandle !== null) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      // Mirrors the shutdown path's `deliveryInFlight` wait (`src/server.ts`):
      // releasing the volume lease while a tick is still pushing/opening a
      // pull request would let this process keep writing after a replacement
      // has taken the volume.
      if (tickInFlight !== null) {
        await tickInFlight;
      }
    },

    /**
     * `20-contract.md` § Watcher, `interrupted-claim`. Scans every
     * declaration's `processing/` directory on disk — not just the currently
     * active file-watcher declarations — so a file orphaned by a declaration
     * that was since amended or removed is still recovered rather than left
     * to sit forever. Never reprocessed: no dispatch call is made for these
         * files at all, only the move to `failed/`.
     */
    async recoverInterruptedClaims(): Promise<readonly WatchTickReport[]> {
      const root = watcherInboxesRoot();
      if (!existsSync(root)) return [];
      const reports: WatchTickReport[] = [];

      for (const entry of readdirSync(root)) {
        const declarationId = entry as DeclarationId;
        const processingDir = processingDirFor(declarationId);
        // D18: a drop mount can plant `processing/` itself as a symlink or
        // reparse point ahead of restart — refuse it exactly as `claim` does,
        // rather than following it into `readdirSync` below. Checked before
        // `existsSync`, which follows a link and would hide a dangling one.
        if (isTamperedStateDir(processingDir)) {
          await pageTamperOnce(declarationId, 'processing');
          continue;
        }
        if (!existsSync(processingDir)) continue;

        for (const fileEntry of readdirSync(processingDir)) {
          const full = path.join(processingDir, fileEntry);
          let stat;
          try {
            stat = lstatSync(full);
          } catch {
            continue;
          }
          if (!stat.isFile()) continue;

          const reason =
            "found in 'processing/' at startup — a prior run was interrupted mid-delivery and this file may already have an open pull request; it is never reprocessed";
          const outcome: WatchedFileOutcome = { kind: 'interrupted-claim', reason };
          const moved = moveToFailed(declarationId, full, fileEntry, reason);
          const name = watchedFileName(fileEntry);
          if (!name.ok) {
            // Only a name this watcher did not claim fails the check; no WatchedFileName exists to record it under.
            console.error(`watcher: '${fileEntry}' in processing/ for declaration '${declarationId}' is not a valid watched file name; it was moved without an audit record`);
            continue;
          }
          await auditAndNotify(declarationId, null, RECOVERY_ACTOR_REF, 'recovery', name.value, outcome, moved.moved ? null : moved.failure);
          reports.push({ declarationId, skipped: null, claimed: name.value, outcome, reconciled: [], stillPending: [] });
        }
      }

      return reports;
    },

    /**
     * `20-contract.md` § L2 — watcher: "Every `tick` resolves the current
     * active declarations before selecting work" — a declaration added or
     * amended at runtime is eligible on the next tick with no restart.
     * `reconciled`/`stillPending` come from `reconcilePendingPullRequests`
     * (S24, `30-slices.md`), which every declaration's tick runs regardless
     * of that declaration's clone-readiness gate for claiming a new file.
     */
    async tick(): Promise<readonly WatchTickReport[]> {
      let active: readonly Declaration[];
      try {
        active = await declarations.list({ state: 'active', hasFileWatcher: true });
      } catch (error) {
        // S50.2's second boundary: a failure before any declaration is selected.
        await reportTickFailure(null, error);
        return [];
      }
      exceptionPaged.delete(TICK_LATCH_KEY);
      const reports: WatchTickReport[] = [];
      for (const declaration of active) {
        reports.push(await tickGuarded(declaration));
      }
      return reports;
    },

    async runRetention(): Promise<RetentionReport> {
      try {
        const cutoff = Date.parse(clock.now()) - processedFileDays * 86_400_000;
        let deletedRows = 0;
        let freedBytes = 0;
        const skipped: string[] = [];
        const root = watcherInboxesRoot();
        if (!existsSync(root)) return { module: 'watcher', deletedRows, freedBytes, skipped };
        for (const declarationDir of readdirSync(root)) {
          const processed = path.join(root, declarationDir, 'processed');
          // D18: `processed/` itself can be a symlink/reparse point planted by
          // the drop mount — `unlinkAndCountBytes` below has no cross-device
          // constraint, so following one here would let a tampered mount delete
          // arbitrary files anywhere on the host. Checked before `existsSync`,
          // which follows a link.
          if (isTamperedStateDir(processed)) {
            skipped.push(`refused tampered 'processed/' for declaration '${declarationDir}'`);
            continue;
          }
          if (!existsSync(processed)) continue;
          for (const name of readdirSync(processed)) {
            const file = path.join(processed, name);
            const stat = lstatSync(file);
            if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
            const removed = unlinkAndCountBytes(file);
            if (removed.ok) {
              deletedRows += 1;
              freedBytes += removed.value;
            } else {
              skipped.push(`could not remove processed/${name}`);
            }
          }
        }
        return { module: 'watcher', deletedRows, freedBytes, skipped };
      } catch {
        return { module: 'watcher', deletedRows: 0, freedBytes: 0, skipped: ['retention pass failed'] };
      }
    },

    async usageBytes(): Promise<number> {
      return directoryBytes(watcherInboxesRoot());
    },
  };
}
