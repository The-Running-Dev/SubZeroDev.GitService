import { randomUUID } from 'node:crypto';
import type { DeclarationId, OperationId, RegistryToolName, ScheduledJobId } from '../shared/brands.ts';
import type { ActorRef, OperationContextKind } from '../shared/actor.ts';
import type { Session } from '../shared/session.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { Clock } from '../clock/clock.ts';
import type { ModuleAdapter } from '../module-adapter/module-adapter.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { Locks } from '../locks/locks.ts';
import type { Audit } from '../audit/audit.ts';
import type { CapabilityName, ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';
import type { CompiledRegistry, ToolDeclaration } from '../contract/tool-declaration.ts';
import type { JsonValue } from '../contract/json.ts';
import { validateAgainstSchema } from '../contract/json-schema.ts';
import { authorization, infrastructure, precondition, timeout as timeoutResult, upstream, validation, type ToolResult } from '../result/envelope.ts';
import { OPERATOR_PROFILE, MCP_PROFILE, SCHEDULER_PROFILE, WATCHER_PROFILE, type Declaration } from '../declarations/types.ts';
import type { ActorProfile } from '../declarations/types.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';

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
  readonly cloneStore: Pick<CloneStore, 'ensure'>;
  readonly locks: Pick<Locks, 'pinActiveOperation'>;
  readonly audit: Pick<Audit, 'append'>;
  readonly clock: Clock;
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
 * `20-contract.md` § L4 — dispatch pipeline. This slice (S6) wires the read
 * path only: identify, authorize, validate input, materialise the clone
 * (released immediately per invariant C3, since a read holds the
 * materialisation lock only until the tree is ready), invoke, validate
 * output, enforce the size limit, envelope. Mutating and monitoring-wait
 * execution classes have no registry entries yet (S6 ships five `read`
 * tools only) and are refused with `infrastructure` rather than silently
 * mishandled if one somehow reached this pipeline before S7 builds the
 * journal and the mutation-lock path they need.
 */
export function createDispatchPipeline(deps: DispatchPipelineDependencies): DispatchPipeline {
  const { registry, ceiling, moduleAdapter, declarations, cloneStore, locks, audit, clock } = deps;

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

      if (entry.executionClass !== 'read') {
        // No mutating or monitoring-wait registry entry exists yet (S6 ships
        // read tools only) — this branch is unreachable from the current
        // registry, and documented rather than silently misrouted.
        return infrastructure(`execution class '${entry.executionClass}' is not dispatched until its owning slice builds the journal/lock path`);
      }

      const inputFindings = validateAgainstSchema(entry.inputSchema, request.input);
      if (inputFindings.length > 0) {
        return validation(`input for '${entry.name}' does not satisfy its schema`, inputFindings);
      }

      const operationId = randomUUID() as OperationId;
      const actorRef: ActorRef = request.session.actorRef;

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

      const effectiveGrant = declarations.effectiveGrant(registry.contractCapabilitySet, ceiling, declaration, request.session.grant);
      const profile = PROFILE_BY_KIND[request.session.kind];
      const writablePathPrefixes = declaration !== null ? declarations.effectiveWritablePrefixes(declaration, profile) : [];

      const ctx: CallContext = {
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

      try {
        if (entry.target.kind !== 'module') {
          return infrastructure(`http-targeted tools are not dispatched until an http adapter exists`);
        }
        const result = await moduleAdapter.invoke(entry.target.target, ctx, request.input);

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
      } finally {
        if (releasePin) releasePin();
      }
    },
  };
}
