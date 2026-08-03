import fs from 'node:fs';
import { contractPath, migrationPath, renderMigration0001, toLf } from './generate-migration-0001.ts';

/**
 * Fails the build if the committed migration has drifted from the contract's
 * § Persisted schemas. Two ways that happens, and both are worth catching:
 * someone hand-edits the generated file, or someone amends the contract's
 * schema without writing the follow-on migration.
 */

// Both sides are normalised to LF before comparing, so a CRLF checkout reports
// a real schema difference if there is one, rather than failing the build on a
// line ending nobody chose.
const expected = toLf(renderMigration0001(fs.readFileSync(contractPath(), 'utf8')));
const actual = toLf(fs.readFileSync(migrationPath(), 'utf8'));

if (expected !== actual) {
  console.error(
    'check-migration: src/store/migration-0001.ts does not match design/20-contract.md § Persisted schemas.\n' +
      'If the contract schema changed after 0001 was released, migration 0001 must NOT be regenerated —\n' +
      'write migration 0002 instead. Migration 0001 is immutable once its checksum is in schema_migration.',
  );
  process.exit(1);
}

console.log('check-migration: OK — migration 0001 matches the contract schema verbatim');
