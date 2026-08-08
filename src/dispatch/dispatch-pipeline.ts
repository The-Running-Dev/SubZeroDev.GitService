import { randomUUID } from 'node:crypto';
import type { DeclarationId, OperationId, RegistryToolName, RepoRelativePath, ScheduledJobId } from '../shared/brands.ts';
import type { ActorRef, OperationContextKind } from '../shared/actor.ts';
import type { Session } from '../shared/session.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { Clock } from '../clock/clock.ts';
import type { ModuleAdapter } from '../module-adapter/module-adapter.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { PreState } from '../clone/types.ts';
import type { Locks } from '../locks/locks.ts';
import type { Audit } from '../audit/audit.ts';
import type { Exec } from '../exec/exec.ts';
import type { Journal } from '../journal/journal.ts';
import type { CapabilityName, ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';
import type { CompiledRegistry, ToolDeclaration } from '../contract/tool-declaration.ts';
import type { JsonValue } from '../contract/json.ts';
import { validateAgainstSchema } from '../contract/json-schema.ts';
import { authorization, conflict, infrastructure, precondition, timeout as timeoutResult, upstream, validation, type ToolResult } from '../result/envelope.ts';
import { OPERATOR_PROFILE, MCP_PROFILE, SCHEDULER_PROFILE, WATCHER_PROFILE, type Declaration } from '../declarations/types.ts';
import type { ActorProfile } from '../declarations/types.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';

const MUTATION_LOCK_ACQUIRE_MS_DEFAULT = 30_000;

export interface DispatchRequest {
  readonly toolName: RegistryToolName;
  readonly input: JsonValue;
  readonly session: Session;
  readonly declarationId: DeclarationId | null;
  readonly scheduledJobId: ScheduledJobId | null;
  readonly context: OperationContextKind;
  readonly signal: AbortSignal;
}

export type Dispatch = (request: DispatchRequest) => Promise<ToolResult<JsonValue>>;

export interface DispatchPipeline {
  readonly dispatch: Dispatch;
  visibleTools(session: Session, declaration: Declaration | null): readonly ToolDeclaration[];
}

export interface DispatchPipelineDependencies {
  readonly registry: CompiledRegistry;
  readonly ceiling: DeploymentCeiling;
  readonly moduleAdapter: Pick<ModuleAdapter, 'invoke'>;
  readonly declarations: Pick<Declarations, 'get' | 'effectiveGrant' | 'effectiveWritablePrefixes'>;
  readonly cloneStore: Pick<CloneStore, 'ensure' | 'observeGitState'>;
  readonly locks: Pick<Locks, 'pinActiveOperation' | 'acquireMutation'>;
  readonly audit: Pick<Audit, 'append'>;
  /** Required only once a `mutating` registry entry exists (S7); every S6-only registry never reaches the branch that calls it. */
  readonly journal?: Pick<Journal, 'begin' | 'markApplied' | 'settle'>;
  /** `scrubJson` only — `JournalBeginInput.input` must be scrubbed before it is persisted (`20-contract.md` § Operation journal). Optional so every pre-S7 read-only call site keeps compiling; the mutating path is the only one that ever reaches it. */
  readonly exec?: Pick<Exec, 'scrubJson'>;
  readonly clock: Clock;
  readonly mutationLockAcquireMs?: number;
}

const PROFILE_BY_KIND: Readonly<Record<Session['kind'], ActorProfile>> = {
  operator: OPERATOR_PROFILE,
  mcp: MCP_PROFILE,
  scheduler: SCHEDULER_PROFILE,
  watcher: WATCHER_PROFILE,
};

function isVisible(entry: ToolDeclaration, contract: ContractCapabilitySet, ceiling: DeploymentCeiling, declaration: Declaration | null, session: Session, declarations: Pick<Declarations, 'effectiveGrant'>): boolean {
  const grant = declarations.effectiveGrant(contract, ceiling, declaration, session.grant);
  return entry.capabilities.every((c) => grant.has(c));
}

function missingCapabilities(entry: ToolDeclaration, contract: ContractCapabilitySet, ceiling: DeploymentCeiling, declaration: Declaration | null, session: Session, declarations: Pick<Declarations, 'effectiveGrant'>): readonly CapabilityName[] {
  const grant = declarations.effectiveGrant(contract, ceiling, declaration, session.grant);
  return entry.capabilities.filter((c) => !grant.has(c));
}

/** Maps any module's `ModuleErrorBase`-shaped error into the envelope, by its own `resultKind`. */
function moduleErrorToToolResult(error: ModuleErrorBase & { readonly findings?: readonly { readonly path: string; readonly rule: string; readonly message: string }[] }): ToolResult<never> {
  switch (error.resultKind) {
    case 'validation':
      return validation(error.summary, error.findings ?? []);
    case 'precondition':
      return precondition(error.summary, error.findings ?? []);
    case 'timeout':
      return timeoutResult(error.summary, 0);
    case 'upstream':
      return upstream(error.summary, null);
    default:
      return infrastructure(error.summary);
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * The audit trail's `changedPaths` describes what actually changed, not what
 * was requested — a rejected or partially-applied stage/restore must not
 * report its input paths as changed, and `git_commit` (no `paths` input at
 * all) must report the paths its own output names. Every S7 mutating tool's
 * `*Data` carries one of these three field names for exactly this reason;
 * checked in that order because a single result only ever carries one.
 */
function extractChangedPathsFromResultData(data: unknown): readonly RepoRelativePath[] {
  if (data === null || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  for (const field of ['staged', 'restored', 'changedPaths'] as const) {
    const value = record[field];
    if (Array.isArray(value)) return value.filter((p): p is string => typeof p === 'string') as RepoRelativePath[];
  }
  return [];
}

/**
 * `20-contract.md` § L4 — dispatch pipeline. S6 wired the read path:
 * identify, authorize, validate input, materialise the clone (released
 * immediately per invariant C3), invoke, validate output, enforce the size
 * limit, envelope. S7 adds the mutating path alongside it: the
 * materialisation lock held for the whole call (invariant C3's other half),
 * the global mutation lock, pre-state captured under it, the journal's
 * intent record written before the first side effect, and both locks
 * released in reverse acquisition order once the call and its journal/audit
 * bookkeeping are done (invariant C2). Monitoring-wait entries still have no
 * registry entry (S10) and are refused with `infrastructure`.
 */
export function createDispatchPipeline(deps: DispatchPipelineDependencies): DispatchPipeline {
  const { registry, ceiling, moduleAdapter, declarations, cloneStore, locks, audit, journal, clock } = deps;
  const exec: Pick<Exec, 'scrubJson'> = deps.exec ?? { scrubJson: (value) => value };
  const mutationLockAcquireMs = deps.mutationLockAcquireMs ?? MUTATION_LOCK_ACQUIRE_MS_DEFAULT;

  function entryFor(toolName: RegistryToolName): ToolDeclaration | null {
    return registry.entries.find((e) => e.name === toolName) ?? null;
  }

  async function auditRejection(request: DispatchRequest, tool: RegistryToolName | null, missing: readonly CapabilityName[]): Promise<void> {
    await audit.append({
      at: clock.now(),
      operationId: null,
      declarationId: request.declarationId,
      generation: null,
      tool,
      actorRef: request.session.actorRef,
      context: request.context,
      form: 'authorization-rejection',
      missing,
      rejectedPath: null,
    });
  }

  function buildContext(request: DispatchRequest, entry: ToolDeclaration, declaration: Declaration | null, operationId: OperationId, actorRef: ActorRef, cloneRoot: CallContext['cloneRoot']): CallContext {
    const effectiveGrant = declarations.effectiveGrant(registry.contractCapabilitySet, ceiling, declaration, request.session.grant);
    const profile = PROFILE_BY_KIND[request.session.kind];
    const writablePathPrefixes = declaration !== null ? declarations.effectiveWritablePrefixes(declaration, profile) : [];
    return {
      operationId,
      declarationId: declaration?.id ?? null,
      generation: declaration?.generation ?? null,
      cloneRoot,
      actorRef,
      capabilities: effectiveGrant,
      writablePathPrefixes,
      context: request.context,
      scheduledJobId: request.scheduledJobId,
      deadline: clock.now(),
      signal: request.signal,
    };
  }

  async function invokeAndEnvelope(entry: ToolDeclaration, ctx: CallContext, input: JsonValue): Promise<ToolResult<JsonValue>> {
    if (entry.target.kind !== 'module') {
      return infrastructure(`http-targeted tools are not dispatched until an http adapter exists`);
    }
    const result = await moduleAdapter.invoke(entry.target.target, ctx, input);

    if (result.ok && result.data !== undefined) {
      const outputFindings = validateAgainstSchema(entry.outputSchema, result.data as JsonValue);
      if (outputFindings.length > 0) {
        return infrastructure(`'${entry.name}' returned a value its own output schema rejects`);
      }
    }

    const bytes = byteLength(result);
    if (bytes > entry.limits.maxResultBytes) {
      return infrastructure(`result of '${entry.name}' is ${bytes} bytes, exceeding its ${entry.limits.maxResultBytes}-byte limit`);
    }
    return result;
  }

  async function dispatchRead(request: DispatchRequest, entry: ToolDeclaration, declaration: Declaration | null, operationId: OperationId, actorRef: ActorRef): Promise<ToolResult<JsonValue>> {
    let cloneRoot: CallContext['cloneRoot'] = null;
    let releasePin: (() => void) | null = null;

    if (declaration !== null) {
      const holder = { operationId, declarationId: declaration.id, tool: entry.name, heldSince: clock.now() };
      const ensured = await cloneStore.ensure(declaration, holder, request.signal);
      if (!ensured.ok) return moduleErrorToToolResult(ensured.error);
      // Invariant C3: a read releases the materialisation lock once the
      // clone is ready, rather than holding it for the call's duration.
      ensured.value.materialisationLock.release();
      cloneRoot = ensured.value.clone.path;
      releasePin = () => ensured.value.activePin.release();
    }

    const ctx = buildContext(request, entry, declaration, operationId, actorRef, cloneRoot);
    try {
      return await invokeAndEnvelope(entry, ctx, request.input);
    } finally {
      if (releasePin) releasePin();
    }
  }

  async function dispatchMutating(request: DispatchRequest, entry: ToolDeclaration, declaration: Declaration, operationId: OperationId, actorRef: ActorRef): Promise<ToolResult<JsonValue>> {
    if (!journal) {
      return infrastructure(`mutating tool '${entry.name}' has no journal configured`);
    }

    const holder = { operationId, declarationId: declaration.id, tool: entry.name, heldSince: clock.now() };

    // Rule 1: materialisation is always acquired before mutation, and held
    // for the mutating call's whole duration (`10-design.md` § the lock
    // protocol, rules 1-2) — never released early the way a read releases it.
    const ensured = await cloneStore.ensure(declaration, holder, request.signal);
    if (!ensured.ok) return moduleErrorToToolResult(ensured.error);
    const materialisationLock = ensured.value.materialisationLock;
    const activePin = ensured.value.activePin;
    const cloneRoot = ensured.value.clone.path;

    // Reverse acquisition order on release (invariant C2): mutation first,
    // then materialisation. `mutationLock` is filled in once acquired below;
    // `release` is safe to call before that (it simply has nothing to
    // release on that side yet) and safe to call more than once (every
    // underlying `release()` is itself idempotent).
    let mutationLock: { release(): void } | null = null;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      mutationLock?.release();
      materialisationLock.release();
      activePin.release();
    };

    try {
      const mutationAcquired = await locks.acquireMutation(holder, mutationLockAcquireMs, request.signal);
      if (!mutationAcquired.ok) {
        // `20-contract.md` § Error semantics › Locks: every `LockError`
        // variant maps to `conflict`; `acquire-timeout` is the only one
        // naming a holder.
        const holderOfLock = 'holder' in mutationAcquired.error ? mutationAcquired.error.holder : null;
        return conflict(mutationAcquired.error.summary, holderOfLock);
      }
      mutationLock = mutationAcquired.value;

      // Pre-state is captured under the mutation lock, before the intent record.
      const observed = await cloneStore.observeGitState(declaration.id);
      if (!observed.ok) {
        // `20-contract.md` § Error semantics › Journal: `prestate-capture-failed`
        // aborts before acting — `infrastructure`, no side effects.
        return infrastructure(`could not capture pre-state for '${declaration.id}': ${observed.error.summary}`);
      }
      const preState: PreState = {
        branch: observed.value.branch,
        headSha: observed.value.headSha,
        upstreamSha: observed.value.upstreamSha,
        indexDigest: observed.value.indexDigest,
        worktreeDigest: observed.value.worktreeDigest,
      };

      // `input` is scrubbed by `Exec.scrubJson` before it reaches the
      // journal (`20-contract.md` § Operation journal) — a commit message
      // or path carrying a credential-bearing URL must not persist verbatim.
      const begun = await journal.begin({
        operationId,
        declarationId: declaration.id,
        generation: declaration.generation,
        tool: entry.name,
        input: exec.scrubJson(request.input),
        actorRef,
        scheduledJobId: request.scheduledJobId,
        context: request.context,
        preState,
      });
      if (!begun.ok) {
        // `intent-write-failed` aborts before acting, same as above — the
        // first side effect never runs, so the tree is untouched.
        return infrastructure(`could not write the journal intent record: ${begun.error.summary}`);
      }

      // No `appendStep` here: a step marks a call whose effect local
      // pre-state cannot observe (a composite's sub-step, a push, a PR —
      // `10-design.md` § control flow #1, step 9). A single local mutation's
      // effect *is* observable in local pre-state, via `preState` itself —
      // recording a step unconditionally, before the domain handler even
      // runs, would leave a crash between here and the handler indistinguishable
      // from one after it, which is exactly the `nothing-happened` case
      // `classify()` exists to detect.
      const ctx = buildContext(request, entry, declaration, operationId, actorRef, cloneRoot);
      const result = await invokeAndEnvelope(entry, ctx, request.input);

      await journal.markApplied(operationId);

      await audit.append({
        at: clock.now(),
        operationId,
        declarationId: declaration.id,
        generation: declaration.generation,
        tool: entry.name,
        actorRef,
        context: request.context,
        form: 'call',
        resultKind: result.kind,
        changedPaths: result.ok ? extractChangedPathsFromResultData(result.data) : [],
      });

      await journal.settle(operationId, null);

      return result;
    } finally {
      // Idempotent and safe at every exit — the normal-completion path
      // above, a `return` on any error branch, or an unexpected rejection
      // from `acquireMutation`, `observeGitState`, `journal.begin`,
      // `moduleAdapter.invoke`, `journal.markApplied`, `audit.append` or
      // `journal.settle`. Without this `finally`, a thrown error at any of
      // those points would leak the global mutation lock forever.
      release();
    }
  }

  return {
    visibleTools(session: Session, declaration: Declaration | null): readonly ToolDeclaration[] {
      return registry.entries.filter((entry) => isVisible(entry, registry.contractCapabilitySet, ceiling, declaration, session, declarations));
    },

    async dispatch(request: DispatchRequest): Promise<ToolResult<JsonValue>> {
      const entry = entryFor(request.toolName);
      if (!entry) {
        await auditRejection(request, request.toolName, []);
        return authorization(`tool '${request.toolName}' does not exist`, []);
      }

      const declaration = request.declarationId !== null ? await declarations.get(request.declarationId) : null;

      if (entry.capabilityScope === 'declaration' && declaration === null) {
        return validation(`tool '${entry.name}' requires a declaration in context`, [{ path: 'declarationId', rule: 'required', message: 'no declaration bound to this call' }]);
      }

      const missing = missingCapabilities(entry, registry.contractCapabilitySet, ceiling, declaration, request.session, declarations);
      if (missing.length > 0) {
        await auditRejection(request, entry.name, missing);
        return authorization(`session lacks capabilit(y/ies) for '${entry.name}'`, missing);
      }

      if (entry.executionClass === 'monitoring-wait') {
        // No monitoring-wait registry entry exists yet (S10) — unreachable
        // from the current registry, documented rather than silently misrouted.
        return infrastructure(`execution class '${entry.executionClass}' is not dispatched until its owning slice builds it`);
      }

      const inputFindings = validateAgainstSchema(entry.inputSchema, request.input);
      if (inputFindings.length > 0) {
        return validation(`input for '${entry.name}' does not satisfy its schema`, inputFindings);
      }

      const operationId = randomUUID() as OperationId;
      const actorRef: ActorRef = request.session.actorRef;

      if (entry.executionClass === 'read') {
        return dispatchRead(request, entry, declaration, operationId, actorRef);
      }

      // `entry.capabilityScope === 'declaration'` was already checked above
      // for every entry, mutating ones included, so `declaration` is never
      // null here — every S7 mutating tool carries that scope.
      if (declaration === null) {
        return infrastructure(`mutating tool '${entry.name}' requires a declaration, and capabilityScope: 'instance' mutating tools do not exist yet`);
      }
      return dispatchMutating(request, entry, declaration, operationId, actorRef);
    },
  };
}
