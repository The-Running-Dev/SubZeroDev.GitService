// GENERATED from `design/20-contract.md` § Persisted schemas by
// scripts/generate-migration-0001.ts — do not hand-edit.
//
// Migration 0001 creates every table in `StoreTableName` against an empty
// store. Migrations are explicit, numbered and forward-only. Once released
// this text is immutable: its checksum is recorded in `schema_migration`, and
// definition-of-done item 18 restores a retained pre-migration copy against
// exactly this schema.

export const MIGRATION_0001_SQL = `CREATE TABLE schema_migration (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT    NOT NULL,
  checksum    TEXT    NOT NULL
) STRICT;

CREATE TABLE declaration (
  id                      TEXT    NOT NULL,
  generation              INTEGER NOT NULL,
  clone_url               TEXT    NOT NULL,
  host                    TEXT    NOT NULL CHECK (host IN ('github','generic')),
  credential_ref          TEXT    NOT NULL,
  capability_grant        TEXT    NOT NULL,
  writable_path_prefixes  TEXT    NOT NULL,
  pinned                  INTEGER NOT NULL CHECK (pinned IN (0,1)),
  content_drop_tool       TEXT,
  content_drop_auto_merge INTEGER CHECK (content_drop_auto_merge IN (0,1)),
  git_user_name           TEXT    NOT NULL,
  git_user_email          TEXT    NOT NULL,
  state                   TEXT    NOT NULL CHECK (state IN ('active','orphaned')),
  grant_epoch             INTEGER NOT NULL,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  PRIMARY KEY (id, generation),
  CHECK (generation >= 1),
  CHECK ((content_drop_tool IS NULL) = (content_drop_auto_merge IS NULL))
) STRICT;

CREATE UNIQUE INDEX declaration_active_id ON declaration (id) WHERE state = 'active';
CREATE INDEX declaration_by_state ON declaration (state);
CREATE INDEX declaration_with_drop ON declaration (id) WHERE content_drop_tool IS NOT NULL;

CREATE TABLE clone (
  declaration_id    TEXT    PRIMARY KEY,
  generation        INTEGER NOT NULL,
  state             TEXT    NOT NULL CHECK (state IN
                      ('absent','materialising','ready','dirty',
                       'recovery-pending','needs-attention','evicted')),
  path              TEXT    NOT NULL,
  size_bytes        INTEGER NOT NULL,
  last_operation_at TEXT,
  observed_remote   TEXT,
  attention_reason  TEXT
) STRICT;

CREATE INDEX clone_eviction_order ON clone (last_operation_at);

CREATE TABLE oauth_client (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  revoked_at    TEXT
) STRICT;

CREATE TABLE "grant" (
  grant_id       TEXT    PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('mcp','operator-api')),
  client_id      TEXT    REFERENCES oauth_client(client_id),
  subject        TEXT    NOT NULL,
  resource       TEXT,
  declaration_id TEXT,
  generation     INTEGER,
  scopes         TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT,
  CHECK ((kind = 'mcp') = (resource IS NOT NULL)),
  CHECK ((kind = 'mcp') = (declaration_id IS NOT NULL)),
  CHECK ((kind = 'mcp') = (generation IS NOT NULL)),
  CHECK ((kind = 'operator-api') = (client_id IS NULL))
) STRICT;

CREATE INDEX grant_by_resource ON "grant" (declaration_id, generation);
CREATE INDEX grant_by_client ON "grant" (client_id);
CREATE INDEX grant_live ON "grant" (grant_id) WHERE revoked_at IS NULL;

CREATE TABLE token (
  jti           TEXT PRIMARY KEY,
  grant_id      TEXT NOT NULL REFERENCES "grant"(grant_id),
  kind          TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  verifier_hash TEXT NOT NULL,
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
) STRICT;

CREATE UNIQUE INDEX token_by_verifier ON token (verifier_hash);
CREATE INDEX token_by_grant ON token (grant_id);
CREATE INDEX token_retention ON token (expires_at, revoked_at);

CREATE TABLE operator_credential (
  singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
  subject               TEXT    NOT NULL,
  password_hash         TEXT    NOT NULL,
  totp_secret_sealed    TEXT    NOT NULL,
  totp_reenrol_required INTEGER NOT NULL CHECK (totp_reenrol_required IN (0,1)),
  enrolled_at           TEXT    NOT NULL
) STRICT;

CREATE TABLE operator_recovery_code (
  code_hash TEXT PRIMARY KEY,
  issued_at TEXT NOT NULL,
  used_at   TEXT
) STRICT;

CREATE TABLE operator_session (
  id                  TEXT PRIMARY KEY,
  subject             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  idle_expires_at     TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at          TEXT
) STRICT;

CREATE INDEX operator_session_retention ON operator_session (absolute_expires_at, revoked_at);

CREATE TABLE scheduled_job (
  id                 TEXT    PRIMARY KEY,
  declaration_id     TEXT    NOT NULL,
  generation         INTEGER NOT NULL,
  tool               TEXT    NOT NULL,
  input              TEXT    NOT NULL,
  not_before         TEXT    NOT NULL,
  on_missed_mode     TEXT    NOT NULL CHECK (on_missed_mode IN ('catch_up','skip_if_older_than')),
  on_missed_seconds  INTEGER,
  frozen_grant       TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN
                       ('pending','running','done','skipped','cancelled','needs-attention')),
  reason             TEXT,
  created_by_kind    TEXT    NOT NULL,
  created_by_subject TEXT    NOT NULL,
  created_by_client  TEXT,
  created_by_grant   TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  CHECK ((on_missed_mode = 'skip_if_older_than') = (on_missed_seconds IS NOT NULL))
) STRICT;

CREATE INDEX scheduled_job_due ON scheduled_job (not_before) WHERE status = 'pending';
CREATE INDEX scheduled_job_by_declaration ON scheduled_job (declaration_id, generation);
CREATE INDEX scheduled_job_retention ON scheduled_job (status, updated_at);

CREATE TABLE journal_entry (
  operation_id        TEXT    PRIMARY KEY,
  declaration_id      TEXT    NOT NULL,
  generation          INTEGER NOT NULL,
  tool                TEXT    NOT NULL,
  input               TEXT    NOT NULL,
  actor_kind          TEXT    NOT NULL,
  actor_subject       TEXT    NOT NULL,
  actor_client        TEXT,
  actor_grant         TEXT,
  scheduled_job_id    TEXT,
  context             TEXT    NOT NULL CHECK (context IN ('normal','repair','recovery','hatch')),
  pre_branch          TEXT,
  pre_head_sha        TEXT,
  pre_upstream_sha    TEXT,
  pre_index_digest    TEXT    NOT NULL,
  pre_worktree_digest TEXT    NOT NULL,
  state               TEXT    NOT NULL CHECK (state IN ('intended','applied','settled','attention')),
  attention_reason    TEXT,
  started_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
) STRICT;

CREATE INDEX journal_unsettled ON journal_entry (declaration_id, generation) WHERE state <> 'settled';
CREATE UNIQUE INDEX journal_by_job ON journal_entry (scheduled_job_id) WHERE scheduled_job_id IS NOT NULL;
CREATE INDEX journal_retention ON journal_entry (state, updated_at);

CREATE TABLE journal_step (
  operation_id TEXT    NOT NULL REFERENCES journal_entry(operation_id),
  ordinal      INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  state        TEXT    NOT NULL CHECK (state IN ('applied')),
  at           TEXT    NOT NULL,
  PRIMARY KEY (operation_id, ordinal)
) STRICT;

CREATE TABLE notification_outbox (
  id              TEXT    PRIMARY KEY,
  severity        TEXT    NOT NULL CHECK (severity IN ('attention','info')),
  declaration_id  TEXT,
  payload         TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('pending','delivered','failed')),
  attempts        INTEGER NOT NULL,
  last_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT    NOT NULL,
  delivered_at    TEXT
) STRICT;

CREATE INDEX outbox_pending ON notification_outbox (created_at) WHERE status = 'pending';
CREATE INDEX outbox_retention ON notification_outbox (status, delivered_at);

CREATE TABLE audit_chain_head (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  sequence   INTEGER NOT NULL,
  head_hash  TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
) STRICT;

CREATE TABLE audit_retained_anchor (
  segment           INTEGER PRIMARY KEY,
  terminal_sequence INTEGER NOT NULL,
  terminal_hash     TEXT    NOT NULL,
  retained_at       TEXT    NOT NULL
) STRICT;

CREATE TABLE credential_failure_mark (
  credential_ref TEXT NOT NULL,
  declaration_id TEXT NOT NULL,
  reason         TEXT NOT NULL,
  marked_at      TEXT NOT NULL,
  PRIMARY KEY (credential_ref, declaration_id)
) STRICT;
`;
