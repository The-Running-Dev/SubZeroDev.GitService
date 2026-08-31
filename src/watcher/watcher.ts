import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import { watchedFileName, type DeclarationId, type IsoUtcTimestamp, type RegistryToolName, type SessionId, type Subject } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { Session } from '../shared/session.ts';
import type { Clock } from '../clock/clock.ts';
import type { Dispatch } from '../dispatch/dispatch-pipeline.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import type { CloneStore } from '../clone/clone-store.ts';
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
import { readPendingPullRequests, writePendingPullRequests } from './pending-pull-requests.ts';

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
  readonly cloneStore: Pick<CloneStore, 'describe'>;
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
 * `HostAdapter`. `CloneStore.describe` is the one exception: distinguishing
 * `clone-not-clean` from `clone-needs-attention` (`WatchTickReport.skipped`)
 * needs the clone's own state, which a `repo_status` read cannot report —
 * `dispatchRead` serves reads through a parked clone unchanged (`20-contract.md`
 * § Error semantics › Clone store: "Reads ... still work"), so `dirty` alone
 * cannot tell the two apart.
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

/** `pr_status`'s `state` and `headSha` — the only two the reconciliation reads. */
function readPullRequestState(value: JsonValue | undefined): { readonly state: string; readonly headSha: string } | null {
  const status = asRecord(asRecord(value)?.status);
  if (status === null || typeof status.state !== 'string' || typeof status.headSha !== 'string') return null;
  return { state: status.state, headSha: status.headSha };
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
      writablePathPrefixes: [],
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

  /**
   * The full per-file protocol `20-contract.md` § L2 — watcher fixes: the
   * declaration-selected plan tool, `prepare_branch`, the declaration-selected
   * apply tool, the two independent `repo_status` observations and `git_stage`
   * (invariants D12/D13), `git_commit`, `git_push`, `pr_open`, then
   * `pr_enable_auto_merge` when configured. Each call is dispatched
   * independently with no outer lock, per the design's own "the composite is
   * not wrapped in an outer lock".
   */
  async function runProtocol(declaration: Declaration, session: Session, file: string, content: string): Promise<WatchedFileOutcome> {
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
      return rejectedOutcome(
        'repo_status_after_apply',
        'infrastructure',
        'the independently observed changed paths do not equal the apply result, or are not a subset of the plan\'s permitted paths',
      );
    }

    const staged = await callTool('git_stage', { paths: declaredChangedPaths }, declaration, session);
    if (!staged.ok) return rejectedOutcome('git_stage', staged.kind, staged.summary);

    const statusAfterStage = await callTool('repo_status', {}, declaration, session);
    if (!statusAfterStage.ok || statusAfterStage.data === undefined) return rejectedOutcome('repo_status_after_stage', statusAfterStage.kind, statusAfterStage.summary);
    const afterStageData = readRepoStatus(statusAfterStage.data);
    if (afterStageData === null) return rejectedOutcome('repo_status_after_stage', 'infrastructure', 'the status observation was unreadable, so the staged set could not be independently confirmed');
    const stagedPaths = afterStageData.changedPaths.map((entry) => entry.path);
    const allStaged = afterStageData.changedPaths.every((entry) => entry.staged);
    if (!sameSet(stagedPaths, declaredChangedPaths) || !allStaged) {
      return rejectedOutcome('repo_status_after_stage', 'infrastructure', 'the independently observed staged paths do not equal the apply result, fully staged');
    }

    const committed = await callTool('git_commit', { message: plan.commitMessage }, declaration, session);
    if (!committed.ok) return rejectedOutcome('git_commit', committed.kind, committed.summary);

    const pushed = await callTool('git_push', { branch: plan.branch }, declaration, session);
    if (!pushed.ok) return rejectedOutcome('git_push', pushed.kind, pushed.summary);

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
      // Best-effort: the pull request is already open, which is the point at
      // which the design calls the file delivered (`10-design.md` §
      // "the unattended pull request is followed to its end" — "a local
      // commit nobody is told about is not delivery", not "an
      // auto-merge-enabled pull request"). A failed enable-call must not
      // relabel an already-delivered file as failed; it is not retried here.
      await callTool('pr_enable_auto_merge', { number: prRef.number }, declaration, session);
    }

    return { kind: 'succeeded', pullRequest: prRef };
  }

  async function auditAndNotify(
    declarationId: DeclarationId,
    generation: Declaration['generation'] | null,
    actorRef: ActorRef,
    context: OperationContextKind,
    file: string,
    outcome: WatchedFileOutcome,
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
      file: file as never,
      outcome,
    });

    if (outcome.kind === 'succeeded') return;
    const reason = outcome.kind === 'rejected' ? `step '${outcome.step}' returned ${outcome.result}: ${outcome.reason}` : outcome.reason;
    const notified = await store.transaction(async (tx: StoreTransaction) => {
      notifier.enqueue(
        {
          severity: 'attention',
          declarationId,
          subject: { kind: 'file-watcher-failed', file: file as never, reason },
          summary: `watched file '${file}' failed for declaration '${declarationId}': ${reason}`,
        },
        tx,
      );
    });
    if (!notified.ok) {
      console.error(`watcher: failed to enqueue attention notification for '${file}' (declaration '${declarationId}'): ${notified.error.summary}`);
    }
  }

  function moveToFailed(declarationId: DeclarationId, sourcePath: string, file: string, reasonText: string): void {
    const failedDir = failedDirFor(declarationId);
    mkdirSync(failedDir, { recursive: true });
    const failedName = `${timestampPrefix(clock.now())}-${file}`;
    renameSync(sourcePath, path.join(failedDir, failedName));
    writeFileSync(path.join(failedDir, `${failedName}.error.txt`), reasonText, 'utf8');
  }

  function moveToProcessed(declarationId: DeclarationId, sourcePath: string, file: string): void {
    const processedDir = processedDirFor(declarationId);
    mkdirSync(processedDir, { recursive: true });
    const target = path.join(processedDir, `${timestampPrefix(clock.now())}-${file}`);
    renameSync(sourcePath, target);
    // `renameSync` never updates mtime, and `runRetention` ages files in
    // `processed/` off their mtime — left alone, a file that sat unclaimed in
    // the inbox for close to `processedFileDays` would carry that original
    // drop-time mtime through delivery and become eligible for deletion right
    // after landing here.
    const deliveredAt = new Date(clock.now());
    utimesSync(target, deliveredAt, deliveredAt);
  }

  /** The candidate the next claim should try, or null when the inbox holds no eligible file — a symlink (S17.4) or a subdirectory never qualifies. */
  function pickCandidate(declarationId: DeclarationId): string | null {
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
      return name;
    }
    return null;
  }

  function claim(declarationId: DeclarationId, file: string): boolean {
    const processingDir = processingDirFor(declarationId);
    mkdirSync(processingDir, { recursive: true });
    try {
      renameSync(path.join(inboxRootFor(declarationId), file), path.join(processingDir, file));
      return true;
    } catch {
      return false;
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
   * control flow #1) — no separate audit or notification is added here.
   *
   * The list is written after **each** entry is resolved, not once after the
   * whole loop: a process killed mid-tick — the same event
   * `recoverInterruptedClaims` exists to recover from — must not re-dispatch
   * `reconcile_after_merge` for an entry this tick already reconciled. Each
   * write reflects every decision made so far plus the entries not yet
   * reached this tick.
   */
  async function reconcilePendingPullRequests(declaration: Declaration, session: Session): Promise<{ reconciled: readonly PendingPullRequest[]; stillPending: readonly PendingPullRequest[] }> {
    const list = readPendingPullRequests(volumeRoot, declaration.id);
    if (list.entries.length === 0) return { reconciled: [], stillPending: [] };

    const reconciled: PendingPullRequest[] = [];
    const stillPending: PendingPullRequest[] = [];

    for (let index = 0; index < list.entries.length; index += 1) {
      const entry = list.entries[index]!;
      const statusResult = await callTool('pr_status', { number: entry.number }, declaration, session);
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
          await callTool('reconcile_after_merge', { pullRequestNumber: entry.number, expectedHeadSha: statusData.headSha }, declaration, session);
          reconciled.push(entry);
        }
      }

      writePendingPullRequests(volumeRoot, declaration.id, { entries: [...stillPending, ...list.entries.slice(index + 1)] });
    }

    return { reconciled, stillPending };
  }

  async function tickOneDeclaration(declaration: Declaration): Promise<WatchTickReport> {
    const session = watcherSessionFor(declaration);
    const { reconciled, stillPending } = await reconcilePendingPullRequests(declaration, session);

    const described = await cloneStore.describe(declaration.id);
    if (!described.ok || described.value.state !== 'ready') {
      // Any non-`ready` clone state (`absent`, `materialising`, `dirty`,
      // `recovery-pending`, `evicted`, `needs-attention`) is reported as
      // `clone-needs-attention` here — a `repo_status` read against a
      // not-yet-materialised or otherwise non-ready clone would trigger
      // clone-on-demand and, on failure, get misreported as `clone-not-clean`.
      return emptyReport(declaration.id, 'clone-needs-attention', reconciled, stillPending);
    }

    const status = await callTool('repo_status', {}, declaration, session);
    const statusData = status.ok ? readRepoStatus(status.data) : null;
    if (!status.ok || statusData === null || statusData.dirty !== false) {
      return emptyReport(declaration.id, 'clone-not-clean', reconciled, stillPending);
    }

    const candidate = pickCandidate(declaration.id);
    if (candidate === null) return emptyReport(declaration.id, null, reconciled, stillPending);

    if (!claim(declaration.id, candidate)) {
      // `20-contract.md` § Watcher, `claim-failed`: "every outcome above is
      // audited, and every failure notifies at attention" — the file stays
      // in the inbox (nothing is moved) and is retried on the next tick.
      const outcome = rejectedOutcome('claim', 'infrastructure', 'the claim into processing/ failed');
      await auditAndNotify(declaration.id, declaration.generation, session.actorRef, 'normal', candidate, outcome);
      return { declarationId: declaration.id, skipped: null, claimed: null, outcome, reconciled, stillPending };
    }

    const processingPath = path.join(processingDirFor(declaration.id), candidate);
    const read = readStrictUtf8(processingPath);
    let outcome: WatchedFileOutcome;
    if (!read.ok) {
      outcome = rejectedOutcome('read', 'validation', 'the claimed file is not readable as strict UTF-8');
    } else {
      outcome = await runProtocol(declaration, session, candidate, read.value);
    }

    if (outcome.kind === 'succeeded') {
      moveToProcessed(declaration.id, processingPath, candidate);
      const pending = readPendingPullRequests(volumeRoot, declaration.id);
      const entry: PendingPullRequest = {
        declarationId: declaration.id,
        number: outcome.pullRequest.number,
        branch: outcome.pullRequest.branch,
        openedAt: clock.now(),
        sourceFile: candidate as never,
      };
      writePendingPullRequests(volumeRoot, declaration.id, { entries: [...pending.entries, entry] });
    } else {
      const reasonText = outcome.kind === 'rejected' ? `step '${outcome.step}' returned ${outcome.result}: ${outcome.reason}` : outcome.reason;
      moveToFailed(declaration.id, processingPath, candidate, reasonText);
    }

    await auditAndNotify(declaration.id, declaration.generation, session.actorRef, 'normal', candidate, outcome);

    return { declarationId: declaration.id, skipped: null, claimed: candidate as never, outcome, reconciled, stillPending };
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
          moveToFailed(declarationId, full, fileEntry, reason);
          await auditAndNotify(declarationId, null, RECOVERY_ACTOR_REF, 'recovery', fileEntry, outcome);
          reports.push({ declarationId, skipped: null, claimed: fileEntry as never, outcome, reconciled: [], stillPending: [] });
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
      const active = await declarations.list({ state: 'active', hasFileWatcher: true });
      const reports: WatchTickReport[] = [];
      for (const declaration of active) {
        reports.push(await tickOneDeclaration(declaration));
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
