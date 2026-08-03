import type { StoreTableName } from './structured-store.ts';

/**
 * Type only, plus one honest placeholder. Real disk-space accounting (total
 * bytes, per-consumer breakdown across clones/audit-log/structured-store/
 * backups/drop-directories) needs the clone store (S5) and watermark
 * machinery (S17), neither of which exists. `HealthReport` requires the
 * field regardless, so this reports genuine zeros rather than fabricating a
 * number nothing has measured.
 */
export type VolumeConsumer = 'clones' | 'audit-log' | 'structured-store' | 'backups-and-snapshots' | 'drop-directories';

export interface VolumeUsage {
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly usedPercent: number;
  readonly byConsumer: Readonly<Record<VolumeConsumer, number>>;
  readonly storeByTable: Readonly<Record<StoreTableName, number>>;
}

const ZERO_BY_CONSUMER: Readonly<Record<VolumeConsumer, number>> = {
  clones: 0,
  'audit-log': 0,
  'structured-store': 0,
  'backups-and-snapshots': 0,
  'drop-directories': 0,
};

const ZERO_BY_TABLE: Readonly<Record<StoreTableName, number>> = {
  schema_migration: 0,
  declaration: 0,
  clone: 0,
  oauth_client: 0,
  grant: 0,
  token: 0,
  operator_credential: 0,
  operator_recovery_code: 0,
  operator_session: 0,
  scheduled_job: 0,
  journal_entry: 0,
  journal_step: 0,
  notification_outbox: 0,
  audit_chain_head: 0,
  audit_retained_anchor: 0,
  credential_failure_mark: 0,
};

export const NO_VOLUME_USAGE: VolumeUsage = {
  totalBytes: 0,
  usedBytes: 0,
  usedPercent: 0,
  byConsumer: ZERO_BY_CONSUMER,
  storeByTable: ZERO_BY_TABLE,
};
