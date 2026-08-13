import type { CapabilitySet } from '../contract/capabilities.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { DeclarationId, Generation, IsoUtcTimestamp, RegistryToolName, ScheduledJobId } from '../shared/brands.ts';
import type { JsonValue } from '../contract/json.ts';

/** `20-contract.md` § Scheduled jobs. */
export type ScheduledJobStatus = 'pending' | 'running' | 'done' | 'skipped' | 'cancelled' | 'needs-attention';

export type OnMissedPolicy = { readonly mode: 'catch_up' } | { readonly mode: 'skip_if_older_than'; readonly seconds: number };

export interface ScheduledJob {
  readonly id: ScheduledJobId;
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly notBefore: IsoUtcTimestamp;
  readonly onMissed: OnMissedPolicy;
  readonly frozenGrant: CapabilitySet;
  readonly status: ScheduledJobStatus;
  readonly reason: string | null;
  readonly createdBy: ActorRef;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface CreateJobInput {
  readonly declarationId: DeclarationId;
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly notBefore: IsoUtcTimestamp;
  readonly onMissed: OnMissedPolicy;
}

/** The tool-facing input — no `declarationId`: the declaration-scoped dispatch context is the only source of that binding (`20-contract.md` § Scheduled jobs). */
export interface ScheduledJobCreateInput {
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly notBefore: IsoUtcTimestamp;
  readonly onMissed: OnMissedPolicy;
}

export interface ScheduledJobCreateData {
  readonly job: ScheduledJob;
}

export interface ScheduledJobListInput {
  readonly status: ScheduledJobStatus | null;
}

export interface ScheduledJobListData {
  readonly jobs: readonly ScheduledJob[];
}

export interface ScheduledJobCancelInput {
  readonly id: ScheduledJobId;
  readonly reason: string;
}

export interface ScheduledJobCancelData {
  readonly job: ScheduledJob;
}

export interface SkippedJob {
  readonly id: ScheduledJobId;
  readonly reason: string;
}

export interface TickReport {
  readonly fired: readonly ScheduledJobId[];
  readonly skipped: readonly SkippedJob[];
  readonly cancelled: readonly SkippedJob[];
}

/**
 * `20-contract.md` § L1 — lifecycle. Declared here, alongside the module that
 * produces it (`Scheduler.resolveRunningAtBoot`), rather than in `lifecycle/boot.ts`
 * — `Lifecycle` (L1) imports this type-only shape from `Scheduler` (L2) the same
 * way it already imports `RecoveryClassification` from `recovery/types.ts`;
 * only the runtime module factories are layered, not the plain data shapes.
 */
export interface BootJobReport {
  readonly markedDone: readonly ScheduledJobId[];
  readonly markedNeedsAttention: readonly ScheduledJobId[];
  readonly returnedToPending: readonly ScheduledJobId[];
  readonly leftRunning: readonly ScheduledJobId[];
}
