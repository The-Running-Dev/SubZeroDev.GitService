import type {
  DeclarationId,
  DropFileName,
  Generation,
  IsoUtcTimestamp,
  OperationId,
  RegistryToolName,
  RepoRelativePath,
  Sha256Hex,
  Subject,
} from '../shared/brands.ts';
import type { CapabilityName } from '../contract/capabilities.ts';
import type { ResultKind } from '../shared/result-kind.ts';
import type { ActorRef, OperationContextKind } from '../shared/actor.ts';
import type { InstanceLease } from '../lifecycle/lease.ts';
import type { PullRequestRef } from '../host/types.ts';

/**
 * Type only. The audit module (L1) that maintains the chain is S3, which is
 * also where U9 — the record's canonical serialisation — must be answered
 * before the first line is appended. Boot reports the chain state, so the
 * types are needed before the module exists.
 */
export interface RetainedAnchor {
  readonly segment: number;
  readonly terminalSequence: number;
  readonly terminalHash: Sha256Hex;
  readonly retainedAt: IsoUtcTimestamp;
}

export interface AuditChainBreak {
  readonly atSequence: number;
  readonly expectedHash: Sha256Hex;
  readonly foundHash: Sha256Hex | null;
}

export interface AuditChainState {
  readonly verifiedThrough: number | null;
  readonly headHash: Sha256Hex | null;
  readonly mirroredHeadHash: Sha256Hex | null;
  readonly retainedAnchors: readonly RetainedAnchor[];
  readonly chainBreak: AuditChainBreak | null;
}

/**
 * What boot reports before the audit module exists: nothing verified, no
 * head, no anchors, no break. Distinct from "a chain that verified clean",
 * which `verifiedThrough: null` deliberately does not claim.
 */
export const UNVERIFIED_AUDIT_CHAIN: AuditChainState = {
  verifiedThrough: null,
  headHash: null,
  mirroredHeadHash: null,
  retainedAnchors: [],
  chainBreak: null,
};

export type AuditRecordForm =
  | 'call'
  | 'authorization-rejection'
  | 'hatch-intent'
  | 'hatch-outcome'
  | 'content-drop'
  | 'identity-event'
  | 'lease-takeover';

export interface AuditRecordBase {
  readonly sequence: number;
  readonly at: IsoUtcTimestamp;
  readonly operationId: OperationId | null;
  readonly declarationId: DeclarationId | null;
  readonly generation: Generation | null;
  readonly tool: RegistryToolName | null;
  readonly actorRef: ActorRef;
  readonly context: OperationContextKind;
  readonly previousHash: Sha256Hex | null;
  readonly hash: Sha256Hex;
}

export type IdentityEvent =
  | 'enrolment'
  | 'recovery-code-used'
  | 'break-glass-used'
  | 'totp-reenrolled'
  | 'session-revoked'
  | 'token-issued'
  | 'client-revoked'
  | 'grant-revoked'
  | 'token-revoked';

export type DropOutcome =
  | { readonly kind: 'succeeded'; readonly pullRequest: PullRequestRef }
  | { readonly kind: 'rejected'; readonly step: string; readonly result: ResultKind; readonly reason: string }
  | { readonly kind: 'interrupted-claim'; readonly reason: string };

export type AuditRecordBody =
  | { readonly form: 'call'; readonly resultKind: ResultKind; readonly changedPaths: readonly RepoRelativePath[] }
  | { readonly form: 'authorization-rejection'; readonly missing: readonly CapabilityName[]; readonly rejectedPath: RepoRelativePath | null }
  | { readonly form: 'hatch-intent'; readonly argv: readonly string[] }
  | { readonly form: 'hatch-outcome'; readonly resultKind: ResultKind; readonly changedPaths: readonly RepoRelativePath[] }
  | { readonly form: 'content-drop'; readonly file: DropFileName; readonly outcome: DropOutcome }
  | { readonly form: 'identity-event'; readonly event: IdentityEvent }
  | { readonly form: 'lease-takeover'; readonly previousHolder: InstanceLease };

export type AuditRecord = AuditRecordBase & AuditRecordBody;
export type AuditAppendInput = Omit<AuditRecordBase, 'sequence' | 'previousHash' | 'hash'> & AuditRecordBody;

export type AuditAppendFailure = 'write-failed' | 'segment-rotation-failed' | 'volume-full';

export type AuditAppendOutcome =
  | { readonly appended: true; readonly sequence: number }
  | { readonly appended: false; readonly reason: AuditAppendFailure };

export interface AuditQuery {
  readonly declarationId: DeclarationId | null;
  readonly tool: RegistryToolName | null;
  readonly actorSubject: Subject | null;
  readonly form: AuditRecordForm | null;
  readonly from: IsoUtcTimestamp | null;
  readonly to: IsoUtcTimestamp | null;
  readonly limit: number;
  readonly cursor: string | null;
}

export interface AuditPage {
  readonly records: readonly AuditRecord[];
  readonly nextCursor: string | null;
  readonly chain: AuditChainState;
}
