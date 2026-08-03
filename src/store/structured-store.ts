import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import { isoUtcTimestamp, type IsoUtcTimestamp } from '../shared/brands.ts';
import type { Clock } from '../clock/clock.ts';
import type { RetentionReport } from '../shared/retention.ts';
import { storeError, type BackupStamp, type StoreError } from './errors.ts';
import { MIGRATION_0001_SQL } from './migration-0001.ts';

export interface StoreTransaction {
  readonly id: string;
}

export type StoreTableName =
  | 'schema_migration'
  | 'declaration'
  | 'clone'
  | 'oauth_client'
  | 'grant'
  | 'token'
  | 'operator_credential'
  | 'operator_recovery_code'
  | 'operator_session'
  | 'scheduled_job'
  | 'journal_entry'
  | 'journal_step'
  | 'notification_outbox'
  | 'audit_chain_head'
  | 'audit_retained_anchor'
  | 'credential_failure_mark';

export const STORE_TABLE_NAMES: readonly StoreTableName[] = [
  'schema_migration',
  'declaration',
  'clone',
  'oauth_client',
  'grant',
  'token',
  'operator_credential',
  'operator_recovery_code',
  'operator_session',
  'scheduled_job',
  'journal_entry',
  'journal_step',
  'notification_outbox',
  'audit_chain_head',
  'audit_retained_anchor',
  'credential_failure_mark',
];

export interface StructuredStore {
  open(): Promise<Outcome<void, StoreError>>;
  integrityCheck(): Promise<Outcome<void, StoreError>>;
  backupBeforeMigration(): Promise<Outcome<IsoUtcTimestamp, StoreError>>;
  migrate(): Promise<Outcome<number, StoreError>>;
  transaction<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<Outcome<T, StoreError>>;
  snapshot(): Promise<Outcome<IsoUtcTimestamp, StoreError>>;
  incrementalVacuum(): Promise<Outcome<number, StoreError>>;
  usageByTable(): Promise<Outcome<Readonly<Record<StoreTableName, number>>, StoreError>>;
  newestSnapshot(): Promise<BackupStamp | null>;
  newestPreMigrationBackup(): Promise<BackupStamp | null>;
  runRetention(): Promise<RetentionReport>;
  close(): Promise<void>;
}

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: MIGRATION_0001_SQL }];

/** Filename stems, so a backup and a snapshot are never mistaken for each other. */
const PRE_MIGRATION_PREFIX = 'pre-migration-';
const SNAPSHOT_PREFIX = 'snapshot-';
const BACKUP_SUFFIX = '.sqlite';

export interface StructuredStoreOptions {
  readonly volumeRoot: string;
  readonly clock: Clock;
  /**
   * Injectable so a test can induce a migration failure — criterion 5 needs a
   * migration that fails *after* the pre-migration copy is taken. Not part of
   * the `StructuredStore` interface, so no contract signature widens.
   */
  readonly migrations?: readonly Migration[];
}

function isAlreadyApplied(database: DatabaseSync, version: number): boolean {
  const schemaMigrationExists =
    database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').all('table', 'schema_migration')
      .length > 0;
  if (!schemaMigrationExists) return false;
  return database.prepare('SELECT version FROM schema_migration WHERE version = ?').all(version).length > 0;
}

function timestampForFilename(at: IsoUtcTimestamp): string {
  return at.replace(/[:.]/g, '-');
}

function isoFromFilename(name: string, prefix: string): IsoUtcTimestamp | null {
  if (!name.startsWith(prefix) || !name.endsWith(BACKUP_SUFFIX)) return null;
  const stamp = name.slice(prefix.length, -BACKUP_SUFFIX.length);
  // Reverse of timestampForFilename: YYYY-MM-DDTHH-MM-SS-mmmZ
  const restored = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const parsed = isoUtcTimestamp(restored);
  return parsed.ok ? parsed.value : null;
}

export function createStructuredStore(options: StructuredStoreOptions): StructuredStore {
  const { volumeRoot, clock } = options;
  const migrations = options.migrations ?? MIGRATIONS;
  const storePath = path.join(volumeRoot, 'store.sqlite');
  const backupDir = path.join(volumeRoot, 'backups');

  let db: DatabaseSync | null = null;

  function requireDb(): DatabaseSync {
    if (!db) throw new Error('structured store used before open()');
    return db;
  }

  function ageSeconds(at: IsoUtcTimestamp): number {
    const elapsed = Date.parse(clock.now()) - Date.parse(at);
    return Math.max(0, Math.round(elapsed / 1000));
  }

  function newestWithPrefix(prefix: string): BackupStamp | null {
    if (!existsSync(backupDir)) return null;
    let newest: IsoUtcTimestamp | null = null;
    for (const name of readdirSync(backupDir)) {
      const at = isoFromFilename(name, prefix);
      if (at && (newest === null || at > newest)) newest = at;
    }
    return newest === null ? null : { at: newest, ageSeconds: ageSeconds(newest) };
  }

  function copyTo(prefix: string): Outcome<IsoUtcTimestamp, StoreError> {
    try {
      mkdirSync(backupDir, { recursive: true });
      const at = clock.now();
      const target = path.join(backupDir, `${prefix}${timestampForFilename(at)}${BACKUP_SUFFIX}`);
      // The store is quiescent at both call sites (boot, and the maintenance
      // pass), so a plain file copy is a consistent image. Nothing is mid
      // transaction, and journal_mode is the default rollback journal.
      copyFileSync(storePath, target);
      return ok(at);
    } catch {
      return err(storeError({ code: 'io-failed' }, 'could not write the store copy'));
    }
  }

  return {
    async open(): Promise<Outcome<void, StoreError>> {
      try {
        mkdirSync(volumeRoot, { recursive: true });
        db = new DatabaseSync(storePath);
        db.exec('PRAGMA foreign_keys = ON;');
        return ok(undefined);
      } catch {
        return err(storeError({ code: 'io-failed' }, `could not open the store at ${storePath}`));
      }
    },

    async integrityCheck(): Promise<Outcome<void, StoreError>> {
      try {
        const rows = requireDb().prepare('PRAGMA integrity_check').all() as { integrity_check?: string }[];
        const verdict = rows[0]?.integrity_check;
        if (verdict === 'ok') return ok(undefined);
        return err(
          storeError(
            {
              code: 'corrupt',
              newestSnapshot: newestWithPrefix(SNAPSHOT_PREFIX),
              newestPreMigrationBackup: newestWithPrefix(PRE_MIGRATION_PREFIX),
            },
            `store integrity check failed: ${verdict ?? 'unknown'}`,
          ),
        );
      } catch {
        // A file too damaged for SQLite to even read reports the same way a
        // failed check does — from the operator's side they are one condition,
        // and both are answered by the same two offers.
        return err(
          storeError(
            {
              code: 'corrupt',
              newestSnapshot: newestWithPrefix(SNAPSHOT_PREFIX),
              newestPreMigrationBackup: newestWithPrefix(PRE_MIGRATION_PREFIX),
            },
            'store could not be read for an integrity check',
          ),
        );
      }
    },

    async backupBeforeMigration(): Promise<Outcome<IsoUtcTimestamp, StoreError>> {
      return copyTo(PRE_MIGRATION_PREFIX);
    },

    async migrate(): Promise<Outcome<number, StoreError>> {
      const database = requireDb();
      let applied = 0;

      // A migration must never run without a rollback target on disk, because
      // `migration-failed` promises one and definition-of-done item 18 restores
      // it. Boot always calls `backupBeforeMigration` first, so this is a
      // backstop for any other caller rather than a second copy on the normal
      // path — it only fires when no pre-migration copy exists at all.
      const pending = migrations.filter((m) => !isAlreadyApplied(database, m.version));
      if (pending.length > 0 && newestWithPrefix(PRE_MIGRATION_PREFIX) === null) {
        const insurance = copyTo(PRE_MIGRATION_PREFIX);
        if (!insurance.ok) return insurance;
      }

      for (const migration of migrations) {
        if (isAlreadyApplied(database, migration.version)) continue;

        const checksum = createHash('sha256').update(migration.sql, 'utf8').digest('hex');
        try {
          database.exec('BEGIN;');
          database.exec(migration.sql);
          database
            .prepare('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?, ?, ?)')
            .run(migration.version, clock.now(), checksum);
          database.exec('COMMIT;');
          applied += 1;
        } catch (cause) {
          try {
            database.exec('ROLLBACK;');
          } catch {
            // The failure already aborted the transaction; nothing to undo.
          }
          // Guaranteed non-null by the backstop above: a migration never runs
          // without a pre-migration copy, so `backupAt` always names a real
          // rollback target rather than an empty string wearing the brand.
          const newest = newestWithPrefix(PRE_MIGRATION_PREFIX);
          if (newest === null) {
            return err(
              storeError(
                { code: 'io-failed' },
                `migration ${migration.version} failed and no pre-migration copy could be found to roll back to`,
              ),
            );
          }
          return err(
            storeError(
              { code: 'migration-failed', version: migration.version, backupAt: newest.at },
              `migration ${migration.version} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          );
        }
      }
      return ok(applied);
    },

    async transaction<T>(work: (tx: StoreTransaction) => Promise<T>): Promise<Outcome<T, StoreError>> {
      const database = requireDb();
      const tx: StoreTransaction = { id: createHash('sha256').update(String(clock.monotonicMs())).digest('hex').slice(0, 16) };
      try {
        database.exec('BEGIN;');
        const value = await work(tx);
        database.exec('COMMIT;');
        return ok(value);
      } catch (cause) {
        try {
          database.exec('ROLLBACK;');
        } catch {
          // Already rolled back by the failure itself.
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/CHECK constraint|UNIQUE constraint|FOREIGN KEY|NOT NULL constraint/i.test(message)) {
          return err(storeError({ code: 'constraint-violated', constraint: message }, message));
        }
        return err(storeError({ code: 'io-failed' }, message));
      }
    },

    async snapshot(): Promise<Outcome<IsoUtcTimestamp, StoreError>> {
      return copyTo(SNAPSHOT_PREFIX);
    },

    async incrementalVacuum(): Promise<Outcome<number, StoreError>> {
      // Retention and vacuuming are S17. Reporting zero bytes returned is the
      // honest answer while nothing prunes yet.
      return ok(0);
    },

    async usageByTable(): Promise<Outcome<Readonly<Record<StoreTableName, number>>, StoreError>> {
      const database = requireDb();
      const usage = {} as Record<StoreTableName, number>;
      for (const table of STORE_TABLE_NAMES) usage[table] = 0;

      try {
        // Bytes, not row counts: this feeds `VolumeUsage.storeByTable`, and the
        // question disk pressure asks is how much of the volume a table is
        // taking. A table's indexes are charged to the table they index, so the
        // figure is the space that table actually costs.
        const owner = new Map<string, string>();
        for (const row of database
          .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type IN ('table','index')")
          .all() as { name: string; tbl_name: string }[]) {
          owner.set(row.name, row.tbl_name);
        }

        for (const row of database.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all() as {
          name: string;
          bytes: number;
        }[]) {
          const table = owner.get(row.name) ?? row.name;
          if (table in usage) {
            usage[table as StoreTableName] += Number(row.bytes ?? 0);
          }
        }
        return ok(usage);
      } catch {
        // `dbstat` is a compile-time option. Say the figure is unavailable
        // rather than substituting row counts, which answer a different
        // question and would understate a large table with few rows.
        return err(storeError({ code: 'io-failed' }, 'per-table byte usage is unavailable: the dbstat virtual table is not compiled in'));
      }
    },

    async newestSnapshot(): Promise<BackupStamp | null> {
      return newestWithPrefix(SNAPSHOT_PREFIX);
    },

    async newestPreMigrationBackup(): Promise<BackupStamp | null> {
      return newestWithPrefix(PRE_MIGRATION_PREFIX);
    },

    async runRetention(): Promise<RetentionReport> {
      // S17 owns retention windows. Nothing is pruned here yet, and the report
      // says so rather than implying a pass ran.
      return { module: 'structured-store', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },

    async close(): Promise<void> {
      if (db) {
        db.close();
        db = null;
      }
    },
  };
}

export function removeStoreFiles(volumeRoot: string): void {
  const target = path.join(volumeRoot, 'store.sqlite');
  if (existsSync(target)) unlinkSync(target);
}

export function storeFileSize(volumeRoot: string): number {
  const target = path.join(volumeRoot, 'store.sqlite');
  return existsSync(target) ? statSync(target).size : 0;
}
