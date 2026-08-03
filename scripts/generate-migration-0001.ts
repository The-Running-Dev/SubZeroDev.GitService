import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Transcribes `design/20-contract.md` § Persisted schemas into
 * `src/store/migration-0001.ts`, mechanically, so the shipped migration cannot
 * drift from the contract through a typo.
 *
 * This runs by hand, not as part of `npm run build`. Migration 0001 is
 * immutable once released — its checksum is recorded in `schema_migration` —
 * so regenerating it against an amended contract would silently change a
 * released migration. A contract amendment after release needs migration
 * 0002, written by hand. `npm run check:migration` verifies the committed
 * file still matches the contract, which is the check that belongs in CI.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function renderMigration0001(contractMarkdown: string): string {
  const start = contractMarkdown.indexOf('## Persisted schemas');
  const end = contractMarkdown.indexOf('## Public signatures');
  if (start < 0 || end < 0) {
    throw new Error('could not locate the Persisted schemas section in the contract');
  }

  const blocks = [...contractMarkdown.slice(start, end).matchAll(/```sql\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? '').trimEnd(),
  );
  if (blocks.length !== 7) {
    throw new Error(`expected 7 sql blocks in the contract, found ${blocks.length}`);
  }

  const sql = blocks.join('\n\n');
  const escaped = sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

  return `// GENERATED from \`design/20-contract.md\` § Persisted schemas by
// scripts/generate-migration-0001.ts — do not hand-edit.
//
// Migration 0001 creates every table in \`StoreTableName\` against an empty
// store. Migrations are explicit, numbered and forward-only. Once released
// this text is immutable: its checksum is recorded in \`schema_migration\`, and
// definition-of-done item 18 restores a retained pre-migration copy against
// exactly this schema.

export const MIGRATION_0001_SQL = \`${escaped}
\`;
`;
}

export function contractPath(): string {
  return path.join(repoRoot, 'design', '20-contract.md');
}

export function migrationPath(): string {
  return path.join(repoRoot, 'src', 'store', 'migration-0001.ts');
}

// Only write when run directly, so `check:migration` can import the renderer.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderMigration0001(fs.readFileSync(contractPath(), 'utf8'));
  fs.writeFileSync(migrationPath(), rendered, 'utf8');
  console.log(`generate-migration-0001: wrote ${migrationPath()}`);
}
