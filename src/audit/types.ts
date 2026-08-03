import type { IsoUtcTimestamp, Sha256Hex } from '../shared/brands.ts';

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
