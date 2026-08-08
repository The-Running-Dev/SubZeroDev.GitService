import type { DeclarationId, IsoUtcTimestamp, OutboxRowId } from '../shared/brands.ts';
import type { JsonValue } from '../contract/json.ts';
import type { NotificationSeverity } from '../journal/types.ts';

/** `20-contract.md` § Notification. */
export type OutboxRowStatus = 'pending' | 'delivered' | 'failed';

export interface OutboxRow {
  readonly id: OutboxRowId;
  readonly severity: NotificationSeverity;
  readonly declarationId: DeclarationId | null;
  readonly payload: JsonValue;
  readonly status: OutboxRowStatus;
  readonly attempts: number;
  readonly lastAttemptAt: IsoUtcTimestamp | null;
  readonly lastError: string | null;
  readonly createdAt: IsoUtcTimestamp;
  readonly deliveredAt: IsoUtcTimestamp | null;
}

export interface DeliveryReport {
  readonly delivered: number;
  readonly failed: number;
  readonly stillPending: number;
}
