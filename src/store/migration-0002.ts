// Hand-written, not generated — `scripts/generate-migration-0001.ts` transcribes
// only migration 0001, which is immutable once released (its checksum is
// recorded in `schema_migration`). A contract amendment after release needs
// the next migration written by hand, per that script's own header comment.
//
// S31.1 — adds the column `beginTotpReenrol`/`completeTotpReenrol` need to
// hold a freshly generated TOTP secret between the two calls, without
// touching `totp_secret_sealed` until the operator proves they captured it.
// `design/20-contract.md` § Persisted schemas documents this column in prose
// next to the `operator_credential` block rather than in that block itself,
// since the block is migration 0001's frozen text.

export const MIGRATION_0002_SQL = `ALTER TABLE operator_credential ADD COLUMN totp_pending_secret_sealed TEXT;
`;
