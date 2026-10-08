import fs from 'node:fs';
import { PRODUCTION_TOOL_DECLARATIONS } from '../src/composition-root/production-declarations.ts';
import { contractPath, findRegistryTableDrift } from './generate-contract-registry-tables.ts';

/**
 * Fails the build if a registry table in `design/20-contract.md` has drifted
 * from the tree's `ToolDeclaration` values: a declaration changed without the
 * generator being rerun, a table was hand-edited, or a tool was added to the
 * tree without a table to carry it.
 */

let drift: string[];
try {
  drift = findRegistryTableDrift(fs.readFileSync(contractPath(), 'utf8'), PRODUCTION_TOOL_DECLARATIONS);
} catch (error) {
  drift = [(error as Error).message];
}

if (drift.length > 0) {
  for (const line of drift) console.error(`check-registry-tables: ${line}`);
  console.error(
    'check-registry-tables: run `node scripts/generate-contract-registry-tables.ts` to rewrite the tables from the declarations.\n' +
      'A tool new to the tree needs its name added to a `<!-- registry-table: ... -->` marker first.',
  );
  process.exit(1);
}

console.log(`check-registry-tables: OK — ${PRODUCTION_TOOL_DECLARATIONS.length} tools, every registry table matches its declarations`);
