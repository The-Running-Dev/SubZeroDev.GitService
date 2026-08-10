import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Audit } from '../audit/audit.ts';
import type { Clock } from '../clock/clock.ts';
import type { JsonValue } from '../contract/json.ts';
import type { Declaration } from '../declarations/types.ts';
import type { CloneState } from '../clone/types.ts';
import type { Dispatch, DispatchRequest } from '../dispatch/dispatch-pipeline.ts';
import type { PullRequestRef } from '../host/types.ts';
import type { ToolResult } from '../result/envelope.ts';
import type { Session } from '../shared/session.ts';
import type { DeclarationId, DropFileName, RegistryToolName, SessionId, Subject } from '../shared/brands.ts';
import { err, ok, type Outcome } from '../shared/outcome.ts';

export type DropOutcome =
  | { readonly kind: 'succeeded'; readonly pullRequest: PullRequestRef }
  | { readonly kind: 'rejected'; readonly step: string; readonly result: string; readonly reason: string }
  | { readonly kind: 'interrupted-claim'; readonly reason: string };

export interface PendingPullRequest {
  readonly declarationId: DeclarationId;
  readonly number: number;
  readonly branch: string;
  readonly openedAt: string;
  readonly sourceFile: DropFileName;
}

export interface WatchTickReport {
  readonly declarationId: DeclarationId;
  readonly skipped: 'clone-not-clean' | 'clone-needs-attention' | null;
  readonly claimed: DropFileName | null;
  readonly outcome: DropOutcome | null;
  readonly reconciled: readonly PendingPullRequest[];
  readonly stillPending: readonly PendingPullRequest[];
}

export type WatcherError =
  | { readonly resultKind: 'precondition'; readonly retryable: false; readonly summary: string; readonly code: 'not-permitted'; readonly missingSwitch: 'remote-operations' | 'watcher-enabled' | 'no-declaration-declares-a-drop' }
  | { readonly resultKind: 'precondition'; readonly retryable: false; readonly summary: string; readonly code: 'drop-unreadable'; readonly file: DropFileName }
  | { readonly resultKind: 'infrastructure'; readonly retryable: false; readonly summary: string; readonly code: 'claim-failed'; readonly file: DropFileName }
  | { readonly resultKind: 'precondition'; readonly retryable: false; readonly summary: string; readonly code: 'step-failed'; readonly step: string; readonly result: string; readonly reason: string }
  | { readonly resultKind: 'precondition'; readonly retryable: false; readonly summary: string; readonly code: 'interrupted-claim'; readonly file: DropFileName };

export interface Watcher {
  start(): Promise<Outcome<void, WatcherError>>;
  stop(): Promise<void>;
  recoverInterruptedClaims(): Promise<readonly WatchTickReport[]>;
  tick(): Promise<readonly WatchTickReport[]>;
}

export interface WatcherDependencies {
  readonly volumeRoot: string;
  readonly clock: Clock;
  readonly remoteOperationsPermitted: boolean;
  readonly enabled: boolean;
  readonly pollIntervalSeconds: number;
  readonly declarations: Pick<{ list(filter: { readonly state: 'active' | null; readonly hasContentDrop: boolean | null }): Promise<readonly Declaration[]> }, 'list'>;
  readonly cloneStore: Pick<{ describe(id: DeclarationId): Promise<Outcome<{ readonly state: CloneState }, unknown>> }, 'describe'>;
  readonly isDropTarget: (tool: RegistryToolName) => boolean;
  readonly dispatch: Dispatch;
  readonly audit: Pick<Audit, 'append'>;
}

const PROCESSING = 'processing';
const PROCESSED = 'processed';
const FAILED = 'failed';
const PENDING = 'pending-pull-requests.json';

function dropError<T extends Omit<WatcherError, 'resultKind' | 'retryable' | 'summary'>>(variant: T, summary: string): WatcherError {
  const resultKind = variant.code === 'claim-failed' ? 'infrastructure' : 'precondition';
  return { resultKind, retryable: false, summary, ...variant } as unknown as WatcherError;
}

function watcherSession(declaration: Declaration): Session {
  return {
    id: `watcher:${declaration.id}` as SessionId,
    kind: 'watcher',
    actorRef: { kind: 'watcher', subject: 'watcher' as Subject, clientId: null, grantId: null },
    repositoryBinding: declaration.id,
    grant: declaration.capabilityGrant as unknown as Session['grant'],
    writablePathPrefixes: declaration.writablePathPrefixes,
    frozenAtEpoch: declaration.grantEpoch,
  };
}

function toolResultFailure(result: ToolResult<JsonValue>, step: string): DropOutcome {
  return {
    kind: 'rejected',
    step,
    result: result.ok ? 'infrastructure' : result.kind,
    reason: result.ok ? `step '${step}' did not return the data the watcher requires` : result.summary,
  };
}

function prRef(data: JsonValue): PullRequestRef | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const ref = (data as { ref?: unknown }).ref;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const candidate = ref as { number?: unknown; url?: unknown; branch?: unknown };
  return typeof candidate.number === 'number' && typeof candidate.url === 'string' && typeof candidate.branch === 'string'
    ? (candidate as PullRequestRef)
    : null;
}

function pendingPath(root: string): string {
  return path.join(root, PENDING);
}

function readPending(root: string): readonly PendingPullRequest[] {
  try {
    const parsed = JSON.parse(readFileSync(pendingPath(root), 'utf8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry): entry is PendingPullRequest => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const value = entry as Record<string, unknown>;
      return typeof value.declarationId === 'string' && typeof value.number === 'number' && typeof value.branch === 'string' && typeof value.openedAt === 'string' && typeof value.sourceFile === 'string';
    });
  } catch {
    return [];
  }
}

function writePending(root: string, entries: readonly PendingPullRequest[]): void {
  const target = pendingPath(root);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ entries })}\n`, 'utf8');
  renameSync(temporary, target);
}

export function createWatcher(deps: WatcherDependencies): Watcher {
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  function rootFor(declarationId: DeclarationId): string {
    return path.join(deps.volumeRoot, 'drops', declarationId as string);
  }

  function prepareDirectories(root: string): void {
    mkdirSync(path.join(root, PROCESSING), { recursive: true });
    mkdirSync(path.join(root, PROCESSED), { recursive: true });
    mkdirSync(path.join(root, FAILED), { recursive: true });
  }

  function moveToFailed(root: string, source: string, file: DropFileName, reason: string): void {
    const target = path.join(root, FAILED, file as string);
    renameSync(source, target);
    writeFileSync(`${target}.error.txt`, `${reason}\n`, 'utf8');
  }

  async function dispatch(declaration: Declaration, toolName: RegistryToolName, input: JsonValue): Promise<ToolResult<JsonValue>> {
    const request: DispatchRequest = {
      toolName,
      input,
      session: watcherSession(declaration),
      declarationId: declaration.id,
      scheduledJobId: null,
      context: 'normal',
      signal: new AbortController().signal,
    };
    return deps.dispatch(request);
  }

  async function auditOutcome(declaration: Declaration, file: DropFileName, outcome: DropOutcome): Promise<void> {
    await deps.audit.append({
      at: deps.clock.now(),
      operationId: null,
      declarationId: declaration.id,
      generation: declaration.generation,
      tool: declaration.contentDrop?.tool ?? null,
      actorRef: watcherSession(declaration).actorRef,
      context: 'normal',
      form: 'content-drop',
      file,
      outcome,
    } as never);
  }

  async function reconcile(root: string, declaration: Declaration): Promise<{ readonly reconciled: readonly PendingPullRequest[]; readonly stillPending: readonly PendingPullRequest[] }> {
    const retained: PendingPullRequest[] = [];
    const reconciled: PendingPullRequest[] = [];
    for (const pending of readPending(root)) {
      const status = await dispatch(declaration, 'pr_status' as RegistryToolName, { number: pending.number });
      if (!status.ok || !status.data || typeof status.data !== 'object' || Array.isArray(status.data)) {
        retained.push(pending);
        continue;
      }
      const state = ((status.data as { status?: { state?: unknown } }).status?.state);
      if (state !== 'merged') {
        if (state !== 'closed') retained.push(pending);
        continue;
      }
      const applied = await dispatch(declaration, 'reconcile_after_merge' as RegistryToolName, { pullRequestNumber: pending.number, expectedHeadSha: null });
      if (applied.ok) reconciled.push(pending);
      else retained.push(pending);
    }
    writePending(root, retained);
    return { reconciled, stillPending: retained };
  }

  async function publish(root: string, declaration: Declaration, file: DropFileName): Promise<DropOutcome> {
    const claimedPath = path.join(root, PROCESSING, file as string);
    let content: string;
    try {
      content = readFileSync(claimedPath, 'utf8');
    } catch {
      return { kind: 'rejected', step: 'read-drop', result: 'precondition', reason: `could not read '${file}'` };
    }
    if (!declaration.contentDrop || !deps.isDropTarget(declaration.contentDrop.tool)) {
      return { kind: 'rejected', step: 'validate-drop-target', result: 'precondition', reason: `declaration '${declaration.id}' names no registered drop target` };
    }
    const applied = await dispatch(declaration, declaration.contentDrop.tool, { fileName: file as string, content });
    if (!applied.ok) return toolResultFailure(applied, 'drop-target');
    const pushed = await dispatch(declaration, 'git_push' as RegistryToolName, { branch: null });
    if (!pushed.ok) return toolResultFailure(pushed, 'git-push');
    const opened = await dispatch(declaration, 'pr_open' as RegistryToolName, {
      title: `Content drop: ${file}`,
      body: `Applied by the content-drop watcher from \`${file}\`.`,
      headBranch: null,
      draft: false,
    });
    if (!opened.ok) return toolResultFailure(opened, 'pr-open');
    const ref = opened.data === undefined ? null : prRef(opened.data);
    if (!ref) return { kind: 'rejected', step: 'pr-open', result: 'infrastructure', reason: 'pr_open did not return a pull-request reference' };
    const next = [...readPending(root), { declarationId: declaration.id, number: ref.number, branch: ref.branch, openedAt: deps.clock.now(), sourceFile: file }];
    writePending(root, next);
    if (declaration.contentDrop.autoMerge) {
      const autoMerge = await dispatch(declaration, 'pr_enable_auto_merge' as RegistryToolName, { number: ref.number });
      if (!autoMerge.ok) return toolResultFailure(autoMerge, 'pr-enable-auto-merge');
    }
    return { kind: 'succeeded', pullRequest: ref };
  }

  async function tickDeclaration(declaration: Declaration): Promise<WatchTickReport> {
    const root = rootFor(declaration.id);
    prepareDirectories(root);
    const pending = await reconcile(root, declaration);
    const clone = await deps.cloneStore.describe(declaration.id);
    if (!clone.ok || clone.value.state === 'needs-attention') {
      return { declarationId: declaration.id, skipped: 'clone-needs-attention', claimed: null, outcome: null, ...pending };
    }
    if (clone.value.state !== 'ready') {
      return { declarationId: declaration.id, skipped: 'clone-not-clean', claimed: null, outcome: null, ...pending };
    }
    const candidates = readdirSync(root)
      .filter((name) => name !== PROCESSING && name !== PROCESSED && name !== FAILED && name !== PENDING && !name.endsWith('.tmp'))
      .sort();
    for (const candidate of candidates) {
      const inboxPath = path.join(root, candidate);
      let stat;
      try {
        stat = lstatSync(inboxPath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const file = candidate as DropFileName;
      const claimedPath = path.join(root, PROCESSING, candidate);
      try {
        renameSync(inboxPath, claimedPath);
      } catch {
        return { declarationId: declaration.id, skipped: null, claimed: null, outcome: { kind: 'rejected', step: 'claim', result: 'infrastructure', reason: `could not claim '${candidate}'` }, ...pending };
      }
      const outcome = await publish(root, declaration, file);
      try {
        if (outcome.kind === 'succeeded') renameSync(claimedPath, path.join(root, PROCESSED, candidate));
        else moveToFailed(root, claimedPath, file, outcome.reason);
      } catch {
        return { declarationId: declaration.id, skipped: null, claimed: file, outcome: { kind: 'rejected', step: 'terminal-move', result: 'infrastructure', reason: `could not preserve '${file}' after processing` }, ...pending };
      }
      await auditOutcome(declaration, file, outcome);
      return { declarationId: declaration.id, skipped: null, claimed: file, outcome, ...pending };
    }
    return { declarationId: declaration.id, skipped: null, claimed: null, outcome: null, ...pending };
  }

  async function activeDeclarations(): Promise<readonly Declaration[]> {
    return (await deps.declarations.list({ state: 'active', hasContentDrop: true })).filter((declaration) => declaration.contentDrop !== null);
  }

  return {
    async start(): Promise<Outcome<void, WatcherError>> {
      if (!deps.remoteOperationsPermitted) return err(dropError({ code: 'not-permitted', missingSwitch: 'remote-operations' }, 'remote operations are disabled'));
      if (!deps.enabled) return err(dropError({ code: 'not-permitted', missingSwitch: 'watcher-enabled' }, 'the watcher is disabled'));
      if ((await activeDeclarations()).length === 0) return err(dropError({ code: 'not-permitted', missingSwitch: 'no-declaration-declares-a-drop' }, 'no declaration has a content drop configured'));
      await this.recoverInterruptedClaims();
      if (!timer) {
        timer = setInterval(() => {
          if (ticking) return;
          ticking = true;
          void this.tick().catch(() => undefined).finally(() => { ticking = false; });
        }, deps.pollIntervalSeconds * 1000);
        timer.unref();
      }
      return ok(undefined);
    },

    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
    },

    async recoverInterruptedClaims(): Promise<readonly WatchTickReport[]> {
      const reports: WatchTickReport[] = [];
      for (const declaration of await activeDeclarations()) {
        const root = rootFor(declaration.id);
        prepareDirectories(root);
        const pending = await reconcile(root, declaration);
        for (const name of readdirSync(path.join(root, PROCESSING)).sort()) {
          const file = name as DropFileName;
          const source = path.join(root, PROCESSING, name);
          moveToFailed(root, source, file, 'processing was interrupted before the watcher could prove the file was not published');
          const outcome: DropOutcome = { kind: 'interrupted-claim', reason: 'processing was interrupted; the file is never reprocessed' };
          await auditOutcome(declaration, file, outcome);
          reports.push({ declarationId: declaration.id, skipped: null, claimed: file, outcome, ...pending });
        }
      }
      return reports;
    },

    async tick(): Promise<readonly WatchTickReport[]> {
      const reports: WatchTickReport[] = [];
      for (const declaration of await activeDeclarations()) reports.push(await tickDeclaration(declaration));
      return reports;
    },
  };
}
