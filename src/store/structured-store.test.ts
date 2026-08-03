import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore, MIGRATIONS, STORE_TABLE_NAMES } from './structured-store.ts';
import { withVolumeAsync } from './volume-fixture.ts';

const EXPECTED_INDEXES = [
  'declaration_active_id',
  'declaration_by_state',
  'declaration_with_drop',
  'clone_eviction_order',
  'grant_by_resource',
  'grant_by_client',
  'grant_live',
  'token_by_verifier',
  'token_by_grant',
  'token_retention',
  'operator_session_retention',
  'scheduled_job_due',
  'scheduled_job_by_declaration',
  'scheduled_job_retention',
  'journal_unsettled',
  'journal_by_job',
  'journal_retention',
  'outbox_pending',
  'outbox_retention',
];

test('S2.1 — migration 0001 applies against a fresh volume: all sixteen tables, the declared indexes, and one schema_migration row', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    assert.equal((await store.open()).ok, true);

    const migrated = await store.migrate();
    assert.equal(migrated.ok, true);
    if (!migrated.ok) return;
    assert.equal(migrated.value, 1, 'exactly one migration applied');
    await store.close();

    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      assert.equal(STORE_TABLE_NAMES.length, 16, 'StoreTableName names sixteen tables');
      for (const expected of STORE_TABLE_NAMES) {
        assert.ok(tables.includes(expected), `table '${expected}' exists`);
      }

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      for (const expected of EXPECTED_INDEXES) {
        assert.ok(indexes.includes(expected), `index '${expected}' exists`);
      }

      const rows = db.prepare('SELECT version, applied_at, checksum FROM schema_migration').all() as {
        version: number;
        checksum: string;
      }[];
      assert.equal(rows.length, 1, 'schema_migration holds exactly one row');
      assert.equal(rows[0]?.version, 1);
      assert.match(String(rows[0]?.checksum), /^[0-9a-f]{64}$/, 'the migration checksum is recorded');
    } finally {
      db.close();
    }
  });
});

test('S2.1 — migrate is idempotent: a second run applies nothing and leaves one row', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    try {
      await store.open();
      assert.equal((await store.migrate()).ok, true);

      const second = await store.migrate();
      assert.equal(second.ok, true);
      if (!second.ok) return;
      assert.equal(second.value, 0, 'no migration re-applied');

      const usage = await store.usageByTable();
      assert.equal(usage.ok, true);
      if (!usage.ok) return;
      assert.equal(usage.value.schema_migration, 1);
    } finally {
      await store.close();
    }
  });
});

test('S2.5 — backupBeforeMigration writes a timestamped copy before migrate runs', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    try {
      await store.open();

      const backup = await store.backupBeforeMigration();
      assert.equal(backup.ok, true);

      const copies = readdirSync(path.join(volume, 'backups')).filter((f) => f.startsWith('pre-migration-'));
      assert.equal(copies.length, 1, 'one pre-migration copy exists before migrate is called');

      const stamp = await store.newestPreMigrationBackup();
      assert.notEqual(stamp, null);
      assert.ok((stamp?.ageSeconds ?? -1) >= 0, 'the copy reports its age in seconds');
    } finally {
      await store.close();
    }
  });
});

test('S2.5 — an induced migration failure leaves the pre-migration copy intact and reports migration-failed', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({
      volumeRoot: volume,
      clock: systemClock,
      migrations: [...MIGRATIONS, { version: 2, sql: 'CREATE TABLE this_is_not_valid_sql (((;' }],
    });
    try {
      await store.open();
      assert.equal((await store.backupBeforeMigration()).ok, true);

      const migrated = await store.migrate();
      assert.equal(migrated.ok, false, 'a failing migration must fail the boot');
      if (migrated.ok) return;
      assert.equal(migrated.error.code, 'migration-failed');
      if (migrated.error.code !== 'migration-failed') return;
      assert.equal(migrated.error.version, 2, 'names the migration that failed');
      assert.ok(migrated.error.backupAt.length > 0, 'names the rollback target');

      const copies = readdirSync(path.join(volume, 'backups')).filter((f) => f.startsWith('pre-migration-'));
      assert.equal(copies.length, 1, 'the pre-migration copy survives the failure intact');

      // The failed migration rolled back: 0001's tables are still there and
      // no partial row was left behind for version 2.
      const applied = await store.usageByTable();
      assert.equal(applied.ok, true);
      if (!applied.ok) return;
      assert.equal(applied.value.schema_migration, 1, 'only migration 0001 is recorded');
    } finally {
      await store.close();
    }
  });
});

test('S2.6 — a corrupt store reports corrupt, naming the newest snapshot with its age in seconds alongside the pre-migration copy, as two distinct offers', async () => {
  await withVolumeAsync(async (volume) => {
    const first = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await first.open();
    await first.migrate();
    await first.backupBeforeMigration();
    await first.snapshot();
    await first.close();

    // Corrupt the store on disk, leaving both kinds of copy untouched.
    writeFileSync(path.join(volume, 'store.sqlite'), 'this is not a sqlite database at all', 'utf8');

    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    try {
      await store.open();
      const checked = await store.integrityCheck();

      assert.equal(checked.ok, false, 'a corrupt store must fail its integrity check');
      if (checked.ok) return;
      assert.equal(checked.error.code, 'corrupt');
      if (checked.error.code !== 'corrupt') return;

      assert.notEqual(checked.error.newestSnapshot, null, 'offers the newest snapshot');
      assert.notEqual(checked.error.newestPreMigrationBackup, null, 'offers the pre-migration copy');
      assert.equal(
        typeof checked.error.newestSnapshot?.ageSeconds,
        'number',
        'the snapshot carries its age in seconds, not only its timestamp',
      );

      // "Two distinct offers": two separately-reported fields, backed by two
      // distinct files on disk. Their timestamps are deliberately not compared
      // — the two copies can be taken within the same millisecond, and the
      // criterion is about not conflating the two, not about clock resolution.
      const backups = readdirSync(path.join(volume, 'backups'));
      assert.equal(backups.filter((f) => f.startsWith('snapshot-')).length, 1);
      assert.equal(backups.filter((f) => f.startsWith('pre-migration-')).length, 1);
    } finally {
      await store.close();
    }
  });
});

test('a healthy store passes its integrity check', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    try {
      await store.open();
      await store.migrate();
      assert.equal((await store.integrityCheck()).ok, true);
    } finally {
      await store.close();
    }
  });
});

test('the schema enforces D10 — at most one active generation per declaration id', async () => {
  await withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();

    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    try {
      const insert = db.prepare(
        `INSERT INTO declaration (id, generation, clone_url, host, credential_ref, capability_grant,
          writable_path_prefixes, pinned, git_user_name, git_user_email, state, grant_epoch, created_at, updated_at)
         VALUES (?, ?, 'https://example.invalid/r.git', 'github', 'c', '[]', '[]', 0, 'n', 'e', 'active', 0, 't', 't')`,
      );
      insert.run('repo-a', 1);
      assert.throws(() => insert.run('repo-a', 2), /UNIQUE/i, 'a second active generation is rejected by the index');
    } finally {
      db.close();
    }
  });
});
