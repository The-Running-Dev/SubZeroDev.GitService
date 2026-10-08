// Hand-written, like 0002 — migration 0001 is immutable once released.
//
// S57 — a generation number is never issued twice for one declaration id.
// `declaration` rows do not survive `declaration.remove`, so the highest
// generation an id has ever had needs a row of its own that nothing deletes.
// The backfill seeds it from the rows already on file; `design/20-contract.md`
// § Persisted schemas (Migration 0003) states the rules this table carries.

export const MIGRATION_0003_SQL = `CREATE TABLE declaration_generation_mark (
  id          TEXT    PRIMARY KEY,
  high_water  INTEGER NOT NULL CHECK (high_water >= 1)
) STRICT;

INSERT INTO declaration_generation_mark (id, high_water)
  SELECT id, MAX(generation) FROM declaration GROUP BY id;
`;
