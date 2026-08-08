import type { DeclarationId, IsoUtcTimestamp, OutboxRowId } from '../shared/brands.ts';
import type { JsonValue } from '../contract/json.ts';
import type { NotificationSeverity } from '../journal/types.ts';
import type { NotifierError } from './errors.ts';

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

/**
 * `errors` is where `no-transport-configured`, `delivery-failed` and
 * `retries-exhausted` surface. They are carried as data rather than raised:
 * one row failing must not abandon the rest of the pass, and a caller that
 * ignores this field behaves exactly as it did before the field existed —
 * which is what keeps delivery from ever blocking the operation it describes.
 */
export interface DeliveryReport {
  readonly delivered: number;
  readonly failed: number;
  readonly stillPending: number;
  readonly errors: readonly NotifierError[];
}
