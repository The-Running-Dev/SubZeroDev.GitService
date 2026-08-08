import type { ClonePath, DeclarationId, Generation, IsoUtcTimestamp, OperationId, PathPrefix, ScheduledJobId } from './brands.ts';
import type { ActorRef, OperationContextKind } from './actor.ts';
import type { EffectiveGrant } from '../contract/capabilities.ts';
import type { ToolResult } from '../result/envelope.ts';

/**
 * `20-contract.md` § L2 — git operations. Constructed by the dispatch
 * pipeline (L4) and passed down to a domain function (L2); declared here,
 * outside both layers, so neither has to import the other to share the type
 * (invariant B1: L4 may not import L2).
 */
export interface CallContext {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId | null;
  readonly generation: Generation | null;
  readonly cloneRoot: ClonePath | null;
  readonly actorRef: ActorRef;
  readonly capabilities: EffectiveGrant;
  readonly writablePathPrefixes: readonly PathPrefix[];
  readonly context: OperationContextKind;
  readonly scheduledJobId: ScheduledJobId | null;
  readonly deadline: IsoUtcTimestamp;
  readonly signal: AbortSignal;
}

export type DomainOperation<TInput, TData> = (ctx: CallContext, input: TInput) => Promise<ToolResult<TData>>;
