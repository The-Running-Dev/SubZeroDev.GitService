import type { BranchName, DeclarationId, DropFileName, Generation, GitSha, IsoUtcTimestamp, OperationId, RegistryToolName, ScheduledJobId } from '../shared/brands.ts';
import type { ActorRef, OperationContextKind } from '../shared/actor.ts';
import type { JsonValue } from '../contract/json.ts';
import type { PreState } from '../clone/types.ts';
import type { RetentionReport } from '../shared/retention.ts';
import type { PullRequestRef } from '../host/types.ts';

/** `20-contract.md` § Operation journal. */
export type JournalEntryState = 'intended' | 'applied' | 'settled' | 'attention';
export type JournalStepState = 'applied';

export interface JournalStep {
  readonly name: string;
  readonly state: JournalStepState;
  readonly at: IsoUtcTimestamp;
}

export interface OperationJournalEntry {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly actorRef: ActorRef;
  readonly scheduledJobId: ScheduledJobId | null;
  readonly context: OperationContextKind;
  readonly preState: PreState;
  readonly steps: readonly JournalStep[];
  readonly state: JournalEntryState;
  readonly attentionReason: string | null;
  readonly startedAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface JournalBeginInput {
  readonly operationId: OperationId;
  readonly declarationId: DeclarationId;
  readonly generation: Generation;
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
  readonly actorRef: ActorRef;
  readonly scheduledJobId: ScheduledJobId | null;
  readonly context: OperationContextKind;
  readonly preState: PreState;
}

/**
 * `20-contract.md` § Notification — the type `Journal.settle` accepts. No
 * notifier module exists until S11; every S7 call site passes `null`, which
 * the contract already names as "the ordinary case".
 */
export type NotificationSeverity = 'attention' | 'info';

export type TerminalState =
  | { readonly kind: 'merge-conflict'; readonly branch: BranchName; readonly headSha: GitSha; readonly baseSha: GitSha }
  | { readonly kind: 'required-check-failed'; readonly check: string; readonly pullRequest: PullRequestRef }
  | { readonly kind: 'wait-timeout'; readonly waitedSeconds: number; readonly tool: RegistryToolName }
  | { readonly kind: 'operation-parked'; readonly operationId: OperationId; readonly reason: string }
  | { readonly kind: 'content-drop-failed'; readonly file: DropFileName; readonly reason: string };

export interface MaintenanceSummary {
  readonly kind: 'maintenance-pass';
  readonly releasedBytes: number;
  readonly evictedDeclarations: readonly DeclarationId[];
  readonly prunedByModule: readonly RetentionReport[];
}

export interface NotificationRequest {
  readonly severity: NotificationSeverity;
  readonly declarationId: DeclarationId | null;
  readonly subject: TerminalState | MaintenanceSummary;
  readonly summary: string;
}
