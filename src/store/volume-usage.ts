import type { StoreTableName } from './structured-store.ts';

/**
 * `20-contract.md` § Volume, retention and maintenance. `S27` wires real
 * disk-wide accounting and the watermark machinery (`clones` and the total/
 * used/percent figures, via `CloneStore.readVolumeUsage`) and real
 * `structured-store` bytes (via `Lifecycle.runMaintenance`'s own overlay of
 * `StructuredStore.usageByTable`). `audit-log`, `backups-and-snapshots` and
 * `watcher-files` are outside this slice's `Touches` list (Audit, Structured
 * store and Watcher own those directories) and stay honest zeros rather than
 * fabricating a number nothing has measured yet.
 */
export type VolumeConsumer = 'clones' | 'audit-log' | 'structured-store' | 'backups-and-snapshots' | 'watcher-files';

/** `20-contract.md` § Deployment configuration. Defaults fixed there: 85 and 95. */
export interface DiskWatermarks {
  readonly maintenanceAtPercent: number;
  readonly refuseAtPercent: number;
}

export const DISK_WATERMARKS_DEFAULT: DiskWatermarks = { maintenanceAtPercent: 85, refuseAtPercent: 95 };

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
  'watcher-files': 0,
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
