import { randomUUID } from 'node:crypto';
import { repoRelativePath, type DeclarationId, type OperationId, type PathPrefix, type RegistryToolName, type RepoRelativePath, type ScheduledJobId } from '../shared/brands.ts';
import type { ActorRef, OperationContextKind } from '../shared/actor.ts';
import type { Session } from '../shared/session.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { Clock } from '../clock/clock.ts';
import type { ModuleAdapter } from '../module-adapter/module-adapter.ts';
import type { HttpAdapter } from '../http/http-adapter.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { PreState } from '../clone/types.ts';
import { DISK_WATERMARKS_DEFAULT, type DiskWatermarks } from '../store/volume-usage.ts';
import type { Locks } from '../locks/locks.ts';
import type { Audit } from '../audit/audit.ts';
import type { Exec } from '../exec/exec.ts';
import type { Journal } from '../journal/journal.ts';
import type { CapabilityName, ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';
import type { CompiledRegistry, ToolDeclaration } from '../contract/tool-declaration.ts';
import type { JsonValue } from '../contract/json.ts';
import { validateAgainstSchema } from '../contract/json-schema.ts';
import type { VolumeUsage } from '../store/volume-usage.ts';
import { authorization, conflict, infrastructure, precondition, timeout as timeoutResult, upstream, validation, type ToolResult } from '../result/envelope.ts';
import { OPERATOR_PROFILE, MCP_PROFILE, SCHEDULER_PROFILE, WATCHER_PROFILE, type Declaration } from '../declarations/types.ts';
import type { ActorProfile } from '../declarations/types.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';

const MUTATION_LOCK_ACQUIRE_MS_DEFAULT = 30_000;
/** `20-contract.md` § Deployment configuration fixes this default at 1800 s. */
const MONITORING_WAIT_CAP_SECONDS_DEFAULT = 1800;

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
  /**
   * S12. Optional so every pre-S12 test and every registry with no
   * `http`-targeted entry keeps compiling unchanged — `invokeAndEnvelope`
   * below refuses an http-targeted entry exactly as it always has when this
   * is absent.
   */
  readonly httpAdapter?: Pick<HttpAdapter, 'invoke'>;
  readonly declarations: Pick<Declarations, 'get' | 'effectiveGrant' | 'effectiveWritablePrefixes'>;
  readonly cloneStore: Pick<CloneStore, 'ensure' | 'observeGitState' | 'describe'> & Partial<Pick<CloneStore, 'markAttention' | 'readVolumeUsage' | 'requestMaintenance' | 'diskFullFindings'>>;
  readonly locks: Pick<Locks, 'pinActiveOperation' | 'acquireMutation'> & Partial<Pick<Locks, 'admitLockFreeWait'>>;
  /** `20-contract.md` § Deployment configuration. Only `maintenanceAtPercent` governs the post-mutation watermark check below — `refuseAtPercent` is `CloneStore.ensure`'s own threshold. */
  readonly watermarks?: DiskWatermarks;
  readonly audit: Pick<Audit, 'append'>;
  /** Required only once a `mutating` registry entry exists (S7); every S6-only registry never reaches the branch that calls it. */
  readonly journal?: Pick<Journal, 'begin' | 'markApplied' | 'settle'> & Partial<Pick<Journal, 'park'>>;
  /** `scrubJson` only — `JournalBeginInput.input` must be scrubbed before it is persisted (`20-contract.md` § Operation journal). Optional so every pre-S7 read-only call site keeps compiling; the mutating path is the only one that ever reaches it. */
  readonly exec?: Pick<Exec, 'scrubJson'>;
  readonly clock: Clock;
  readonly mutationLockAcquireMs?: number;
  /**
   * `DeploymentConfig.timeouts.monitoringWaitCapSeconds`. Every monitoring
   * wait's effective timeout is at most this, regardless of what was
   * requested (invariant C6).
   */
  readonly monitoringWaitCapSeconds?: number;
  /**
   * The lazy recovery pass (S8), injected rather than imported so L4 keeps
   * no dependency on the lifecycle module. Called on a declaration's first
   * mutating use in this process, **before** either lock is taken — a resume
   * step it runs goes back through this same pipeline and must be able to
   * acquire both locks in its own right.
   */
  readonly recoverDeclaration?: (declarationId: DeclarationId) => Promise<unknown>;
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
 * Whether dispatching this entry requires a materialised clone. An
 * http-targeted entry's own module carries no credential dependency (S12.7) —
 * materialising a clone for one would force a credentialed clone-on-demand
 * onto a tool that never touches the tree. One predicate, consulted by every
 * dispatch path that materialises early, so the paths cannot drift apart.
 */
function needsClone(entry: ToolDeclaration): boolean {
  return entry.target.kind !== 'http' && entry.annotations.fileWatcher !== 'plan';
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
 * bookkeeping are done (invariant C2). S10 adds the third path: a monitoring
 * wait, which holds neither lock, is admitted against the two lock-free
 * counters, and has its requested timeout clamped to the cap.
 */
export function createDispatchPipeline(deps: DispatchPipelineDependencies): DispatchPipeline {
  const { registry, ceiling, moduleAdapter, httpAdapter, declarations, cloneStore, locks, audit, journal, clock } = deps;
  const exec: Pick<Exec, 'scrubJson'> = deps.exec ?? { scrubJson: (value) => value };
  const mutationLockAcquireMs = deps.mutationLockAcquireMs ?? MUTATION_LOCK_ACQUIRE_MS_DEFAULT;
  const monitoringWaitCapSeconds = deps.monitoringWaitCapSeconds ?? MONITORING_WAIT_CAP_SECONDS_DEFAULT;
  const watermarks = deps.watermarks ?? DISK_WATERMARKS_DEFAULT;

  /**
   * The last usage reading `checkWatermarkAfterMutation` observed, in
   * process memory. The pre-`Journal.begin` refuse check below reads this
   * rather than taking a fresh reading itself — deliberately one operation
   * stale rather than current, per the 2026-08-13 post-S27 reconciliation
   * decision: a fresh `statfs` plus a `SUM` over the clone table inside the
   * global mutation lock on every commit is the cost the design's own
   * control-flow step 10 avoided by making the post-mutation reading
   * advisory in the first place. `null` until the first mutation completes —
   * a mutation before then is not gated, the same gap "last observed" already
   * accepts.
   */
  let lastObservedUsage: VolumeUsage | null = null;

  /**
   * `10-design.md` § control flow #1, step 10: "A disk-pressure watermark
   * reading taken here only *requests* a maintenance pass; eviction never
   * runs on this path, because it would acquire a materialisation lock after
   * a mutation lock." Fire-and-forget, never awaited by the caller — invoked
   * from the mutating path's own `finally`, so it always runs after both
   * locks have released regardless of which return statement produced the
   * result (S27.1).
   */
  async function checkWatermarkAfterMutation(): Promise<void> {
    if (!cloneStore.readVolumeUsage || !cloneStore.requestMaintenance) return;
    try {
      const usage = await cloneStore.readVolumeUsage();
      if (usage.ok) {
        lastObservedUsage = usage.value;
        if (usage.value.usedPercent >= watermarks.maintenanceAtPercent) {
          cloneStore.requestMaintenance('watermark');
        }
      }
    } catch (cause) {
      // Called fire-and-forget from the mutating path's own `finally`
      // (`void checkWatermarkAfterMutation()`) — a rejection here must not
      // become an unhandled rejection that takes the process down over a
      // volume-usage reading nobody is waiting on.
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`dispatch: post-mutation watermark check failed: ${message}`);
    }
  }

  /**
   * Declarations whose lazy recovery pass has already run in this process.
   * "On first use" is exactly right and no weaker than it sounds: unsettled
   * entries exist at boot from a previous process, or are created and settled
   * inline by this one. A restart is the only thing that adds more, and a
   * restart empties this set with the process.
   */
  const recovered = new Set<DeclarationId>();

  /**
   * Declarations whose lazy pass is running right now. This is the window the
   * contract's `recovery-pending` names — "a mutation was attempted before
   * the lazy pass reached this declaration". The call that *triggers* the
   * pass waits for it and then proceeds; a second mutation arriving while it
   * is still in flight is refused rather than queued, because it would
   * otherwise sit behind a pass that may be resuming a whole composite.
   * Reads never consult this at all.
   */
  const recovering = new Set<DeclarationId>();

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

  function isSortedUnique(values: readonly string[]): boolean {
    const sorted = [...values].sort();
    return new Set(values).size === values.length && values.every((value, index) => value === sorted[index]);
  }

  async function validateWatcherApplyInput(request: DispatchRequest, entry: ToolDeclaration, declaration: Declaration): Promise<{ readonly failure: ToolResult<never> | null; readonly writablePathPrefixes: readonly PathPrefix[] | null }> {
    if (entry.annotations.fileWatcher !== 'apply') return { failure: null, writablePathPrefixes: null };
    const rawPaths = request.input !== null && typeof request.input === 'object' && !Array.isArray(request.input)
      ? (request.input as Record<string, JsonValue>).permittedPaths
      : undefined;
    if (!Array.isArray(rawPaths) || !rawPaths.every((path) => typeof path === 'string')) {
      return { failure: validation(`input for '${entry.name}' has malformed permittedPaths`, [{ path: 'permittedPaths', rule: 'array-of-paths', message: 'expected strings' }]), writablePathPrefixes: null };
    }
    if (!isSortedUnique(rawPaths)) {
      return { failure: validation(`input for '${entry.name}' requires sorted, duplicate-free permittedPaths`, [{ path: 'permittedPaths', rule: 'sorted-unique', message: 'paths must be canonical' }]), writablePathPrefixes: null };
    }
    const prefixes = declarations.effectiveWritablePrefixes(declaration, PROFILE_BY_KIND[request.session.kind]);
    for (const rawPath of rawPaths) {
      const parsed = repoRelativePath(rawPath);
      if (!parsed.ok) return { failure: validation(`'${rawPath}' is not a valid repository-relative path`, [{ path: 'permittedPaths', rule: parsed.error.rule, message: rawPath }]), writablePathPrefixes: null };
      const allowed = prefixes.some((prefix) => (prefix as string).endsWith('/') ? rawPath.startsWith(prefix as string) : rawPath === prefix as string);
      if (!allowed) {
        await audit.append({ at: clock.now(), operationId: null, declarationId: declaration.id, generation: declaration.generation, tool: entry.name, actorRef: request.session.actorRef, context: request.context, form: 'authorization-rejection', missing: [], rejectedPath: parsed.value });
        return { failure: authorization(`'${rawPath}' is outside this declaration's effective writable paths`, []), writablePathPrefixes: null };
      }
    }
    return { failure: null, writablePathPrefixes: prefixes };
  }

  function buildContext(request: DispatchRequest, entry: ToolDeclaration, declaration: Declaration | null, operationId: OperationId, actorRef: ActorRef, cloneRoot: CallContext['cloneRoot'], precomputedWritablePathPrefixes: readonly PathPrefix[] | null = null): CallContext {
    const effectiveGrant = declarations.effectiveGrant(registry.contractCapabilitySet, ceiling, declaration, request.session.grant);
    const profile = PROFILE_BY_KIND[request.session.kind];
    const writablePathPrefixes = precomputedWritablePathPrefixes ?? (declaration !== null ? declarations.effectiveWritablePrefixes(declaration, profile) : []);
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
    let result: ToolResult<JsonValue>;
    if (entry.target.kind === 'module') {
      result = await moduleAdapter.invoke(entry.target.target, ctx, input);
    } else if (httpAdapter) {
      result = await httpAdapter.invoke(entry.target.operation, ctx, input, entry.limits);
    } else {
      return infrastructure(`http-targeted tools are not dispatched until an http adapter exists`);
    }

    if (result.ok && result.data !== undefined) {
      const outputFindings = validateAgainstSchema(entry.outputSchema, result.data as JsonValue);
      if (outputFindings.length > 0) {
        return infrastructure(`'${entry.name}' returned a value its own output schema rejects`);
      }
      if (entry.annotations.fileWatcher !== false) {
        const field = entry.annotations.fileWatcher === 'plan' ? 'permittedPaths' : 'changedPaths';
        const paths = typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)
          ? (result.data as Record<string, unknown>)[field]
          : undefined;
        if (!Array.isArray(paths) || !paths.every((value) => typeof value === 'string' && repoRelativePath(value).ok)) {
          return infrastructure(`'${entry.name}' returned malformed ${field}`);
        }
        if (!isSortedUnique(paths as readonly string[])) {
          return infrastructure(`'${entry.name}' returned ${field} that is not sorted and duplicate-free`);
        }
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

    if (declaration !== null && needsClone(entry)) {
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

  /**
   * Invariant C6: every monitoring wait's effective timeout is at most
   * `monitoringWaitCapSeconds`, **regardless of what was requested**. A
   * request for 3600 s waits 1800 s rather than being refused — the cap is a
   * ceiling on how long the service will hold a wait open, not a validation
   * rule the caller failed.
   *
   * Applied generically, on the field name rather than on a known input type,
   * because L4 may not import L2 (invariant B1) and so cannot know
   * `ChecksAwaitInput`. The registry entry's own `timeoutSeconds` is the other
   * half of the same limit, enforced by the compiler (`limit-exceeds-cap`), so
   * the effective cap is the lower of the two.
   */
  function clampMonitoringWaitInput(entry: ToolDeclaration, input: JsonValue): JsonValue {
    const cap = Math.min(entry.limits.timeoutSeconds, monitoringWaitCapSeconds);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
    const requested = (input as Record<string, JsonValue>).timeoutSeconds;
    if (typeof requested !== 'number' || requested <= cap) return input;
    return { ...(input as Record<string, JsonValue>), timeoutSeconds: cap };
  }

  /**
   * A monitoring wait takes **neither lock**. It materialises the clone the
   * same way a read does and releases the materialisation lock the moment the
   * clone is ready (invariant C3), so a thirty-minute wait on one repository
   * delays no mutation on another and blocks nothing on its own.
   *
   * What bounds it instead is admission: the two counters on `Locks`, which
   * refuse outright rather than queueing. Both refusals surface as `conflict`,
   * the same envelope every `LockError` maps to.
   */
  async function dispatchMonitoringWait(request: DispatchRequest, entry: ToolDeclaration, declaration: Declaration | null, operationId: OperationId, actorRef: ActorRef): Promise<ToolResult<JsonValue>> {
    if (!locks.admitLockFreeWait) {
      return infrastructure(`monitoring-wait tool '${entry.name}' has no admission control configured`);
    }
    const admitted = locks.admitLockFreeWait(request.session.id);
    if (!admitted.ok) {
      return conflict(admitted.error.summary, null);
    }

    let cloneRoot: CallContext['cloneRoot'] = null;
    let releasePin: (() => void) | null = null;

    try {
      if (declaration !== null && needsClone(entry)) {
        const holder = { operationId, declarationId: declaration.id, tool: entry.name, heldSince: clock.now() };
        const ensured = await cloneStore.ensure(declaration, holder, request.signal);
        if (!ensured.ok) return moduleErrorToToolResult(ensured.error);
        // Released before the wait begins, not after it ends. Holding it for
        // the wait's duration is exactly the thing this execution class
        // exists not to do.
        ensured.value.materialisationLock.release();
        cloneRoot = ensured.value.clone.path;
        releasePin = () => ensured.value.activePin.release();
      }

      const ctx = buildContext(request, entry, declaration, operationId, actorRef, cloneRoot);
      return await invokeAndEnvelope(entry, ctx, clampMonitoringWaitInput(entry, request.input));
    } finally {
      if (releasePin) releasePin();
      admitted.value.release();
    }
  }

  /**
   * S8's repair gate. A parked declaration refuses ordinary mutations and
   * still serves reads; what it additionally admits is **any mutating
   * registry entry** to a session holding `attention.resolve`, audited as
   * repair.
   *
   * Deliberately a predicate on `executionClass`, not a list of tool names.
   * `10-design.md` § the parked-operations view puts it as "the existing
   * typed write tools — stage, restore-paths, commit, branch ... No new
   * mutation surface appears: these are the same operations, **under the same
   * path allowlist**, that the declaration already permits when healthy."
   *
   * Two halves, and both matter:
   *
   * - **A class, not a list.** An enumerated allowlist would name the three
   *   tools that exist today and silently withhold branch preparation from
   *   the repair session the moment S12 registers it — the one time an
   *   operator would most need it.
   * - **Local writes only.** `executionClass: 'mutating'` alone is too wide:
   *   `git_push` (S9) is a mutating entry too, and admitting a push to a
   *   parked declaration is new authority the design never granted. The
   *   design's own capability table (`10-design.md` § capabilities) maps
   *   `git.local.write` to exactly "branch preparation, stage, commit,
   *   restore-paths" — the four the repair session names. Requiring that
   *   capability *is* the design's list, expressed as a predicate.
   *
   * The tool's own declared capabilities are still checked, upstream in
   * `dispatch`. `attention.resolve` waives the parked-state refusal; it does
   * not substitute for `git.local.write`.
   */
  function admittedAsRepair(entry: ToolDeclaration, declaration: Declaration | null, session: Session): boolean {
    if (entry.executionClass !== 'mutating') return false;
    if (!entry.capabilities.includes('git.local.write')) return false;
    const grant = declarations.effectiveGrant(registry.contractCapabilitySet, ceiling, declaration, session.grant);
    return grant.has('attention.resolve');
  }

  async function dispatchMutating(request: DispatchRequest, entry: ToolDeclaration, declaration: Declaration, operationId: OperationId, actorRef: ActorRef, precomputedWritablePathPrefixes: readonly PathPrefix[] | null = null): Promise<ToolResult<JsonValue>> {
    if (!journal) {
      return infrastructure(`mutating tool '${entry.name}' has no journal configured`);
    }

    // The lazy recovery pass, ahead of **both** locks. Ahead of the mutation
    // lock because the contract requires the resume to take that lock in its
    // own right; ahead of the materialisation lock because a resume step
    // re-enters this pipeline and calls `ensure` itself, and running it under
    // a materialisation lock this call already holds would deadlock the two
    // against each other.
    // `context: 'recovery'` is the ladder's own resume step re-entering this
    // pipeline from inside the pass. It must not consult the lazy pass at
    // all: the declaration is in `recovering` precisely because the call
    // above it is the pass, so the guard below would refuse the resume, the
    // ladder would read that refusal as a failed resume, and every real
    // resume would park. The recursion is the reason this exemption exists,
    // not a loophole in it — a resume still takes both locks in its own
    // right, which is the property the contract actually requires.
    const isRecoveryResume = request.context === 'recovery';

    if (deps.recoverDeclaration && !isRecoveryResume && !recovered.has(declaration.id)) {
      if (recovering.has(declaration.id)) {
        return precondition(
          `'${declaration.id}' is recovering unsettled operations from a previous run and is not accepting mutations yet. Reads are unaffected.`,
          [],
        );
      }
      recovering.add(declaration.id);
      try {
        await deps.recoverDeclaration(declaration.id);
        recovered.add(declaration.id);
      } finally {
        recovering.delete(declaration.id);
      }
    }

    // Read clone state only after recovery has had its turn — recovery is
    // exactly what moves a declaration out of `needs-attention`, and checking
    // first would refuse a mutation the pass was about to make admissible.
    const described = await cloneStore.describe(declaration.id);
    // A resume is exempt for the same reason it skips the pass above: it *is*
    // the recovery of this declaration. An earlier entry parking the clone
    // must not stop the ladder from resuming a later one — that would make
    // one parked entry permanently block every other entry's recovery.
    const isRepair = isRecoveryResume || admittedAsRepair(entry, declaration, request.session);
    if (described.ok && described.value.state === 'needs-attention' && !isRepair) {
      return precondition(
        `'${declaration.id}' has a parked operation and refuses ordinary mutations: ${described.value.attentionReason ?? 'no reason recorded'}. ` +
          `Reads are unaffected, and a session holding 'attention.resolve' can still repair the tree.`,
        [],
      );
    }

    // `context: 'repair'` is the audit trail's record that this mutation
    // reached a parked declaration through the exception rather than through
    // ordinary service. Set here rather than trusted from the caller: the
    // caller does not decide whether it was repair, the gate does.
    // A resume keeps `context: 'recovery'` — it reached a parked declaration
    // as recovery, not as an operator repairing one, and the audit trail must
    // not relabel it.
    const repairing = isRepair && !isRecoveryResume && described.ok && described.value.state === 'needs-attention';
    const repaired: DispatchRequest = repairing ? { ...request, context: 'repair' } : request;
    const effective: DispatchRequest = (entry.name as string) === 'git_raw' ? { ...repaired, context: 'hatch' } : repaired;

    const holder = { operationId, declarationId: declaration.id, tool: entry.name, heldSince: clock.now() };

    // Rule 1: materialisation is always acquired before mutation, and held
    // for the mutating call's whole duration (`10-design.md` § the lock
    // protocol, rules 1-2) — never released early the way a read releases it.
    const ensured = await cloneStore.ensure(declaration, holder, effective.signal);
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
      const mutationAcquired = await locks.acquireMutation(holder, mutationLockAcquireMs, effective.signal);
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

      // 2026-08-13 post-S27 reconciliation: the refuse watermark gates every
      // mutation, not only materialisation. `CloneStore.ensure` above only
      // ever refuses a *fresh* clone; a declaration whose clone is already
      // `ready` reaches this point unchecked at any usage percentage. Checked
      // against `lastObservedUsage` (the post-mutation reading, up to one
      // operation stale) rather than a fresh read, and after pre-state
      // capture rather than before it, so the check itself never taxes the
      // hot path with disk I/O of its own.
      if (lastObservedUsage !== null && lastObservedUsage.usedPercent >= watermarks.refuseAtPercent) {
        const findings = cloneStore.diskFullFindings ? await cloneStore.diskFullFindings(lastObservedUsage) : [];
        return precondition(
          `the volume is at ${lastObservedUsage.usedPercent.toFixed(1)}% — refusing '${entry.name}' for '${declaration.id}'`,
          findings,
        );
      }

      // `input` is scrubbed by `Exec.scrubJson` before it reaches the
      // journal (`20-contract.md` § Operation journal) — a commit message
      // or path carrying a credential-bearing URL must not persist verbatim.
      const begun = await journal.begin({
        operationId,
        declarationId: declaration.id,
        generation: declaration.generation,
        tool: entry.name,
        input: exec.scrubJson(effective.input),
        actorRef,
        scheduledJobId: effective.scheduledJobId,
        context: effective.context,
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
      const ctx = buildContext(effective, entry, declaration, operationId, actorRef, cloneRoot, precomputedWritablePathPrefixes);
      const result = await invokeAndEnvelope(entry, ctx, effective.input);

      // git_raw completes its own journal entry (settled or parked) inside
      // the handler, for the same reason it writes its own audit trail
      // there: its argv is caller-authored, so a post-state that came back
      // unknown for a reason other than a timeout (a failed post-observation
      // after a successful or cancelled child) still needs parking, and only
      // the handler that made that observation can tell the two apart.
      if ((entry.name as string) === 'git_raw') {
        return result;
      }

      // `20-contract.md`'s `ExecError` table maps a timed-out child to
      // `timeout` and requires the journal entry parked — what the command
      // achieved is not knowable. Generic on `result.kind`, not on the tool
      // name: `git_raw` is not the only mutating entry whose child can time
      // out, and the invariant is the same one regardless of which entry hit it.
      if (result.kind === 'timeout') {
        const parked = await journal.park?.(operationId, result.summary);
        if (!parked?.ok) return infrastructure(`'${entry.name}' timed out, but its journal entry could not be parked: ${parked?.error.summary ?? 'journal park is unavailable'}`);
        await cloneStore.markAttention?.(declaration.id, result.summary);
        return result;
      }

      await journal.markApplied(operationId);

      await audit.append({
        at: clock.now(),
        operationId,
        declarationId: declaration.id,
        generation: declaration.generation,
        tool: entry.name,
        actorRef,
        context: effective.context,
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
      // S27.1 — after release, so the reading and the maintenance request it
      // may trigger never run while this call's locks are held. Fired, not
      // awaited: the caller's response must not wait on a volume-usage read.
      void checkWatermarkAfterMutation();
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

      const inputFindings = validateAgainstSchema(entry.inputSchema, request.input);
      if (inputFindings.length > 0) {
        return validation(`input for '${entry.name}' does not satisfy its schema`, inputFindings);
      }

      const operationId = randomUUID() as OperationId;
      const actorRef: ActorRef = request.session.actorRef;

      if (entry.executionClass === 'read') {
        return dispatchRead(request, entry, declaration, operationId, actorRef);
      }

      if (entry.executionClass === 'monitoring-wait') {
        return dispatchMonitoringWait(request, entry, declaration, operationId, actorRef);
      }

      // `entry.capabilityScope === 'declaration'` was already checked above
      // for every entry, mutating ones included, so `declaration` is never
      // null here — every S7 mutating tool carries that scope.
      if (declaration === null) {
        return infrastructure(`mutating tool '${entry.name}' requires a declaration, and capabilityScope: 'instance' mutating tools do not exist yet`);
      }

      // File-watcher apply validation only ever applies to mutating tools
      // (the compiler's file-watcher shape check requires `executionClass:
      // 'mutating'` for `fileWatcher: 'apply'`), so it belongs on this branch
      // rather than running unconditionally ahead of the read/monitoring-wait
      // split above, mirroring how monitoring-wait's own specialization stays
      // out of the shared path until its branch is chosen.
      const watcherCheck = await validateWatcherApplyInput(request, entry, declaration);
      if (watcherCheck.failure) return watcherCheck.failure;

      return dispatchMutating(request, entry, declaration, operationId, actorRef, watcherCheck.writablePathPrefixes);
    },
  };
}
