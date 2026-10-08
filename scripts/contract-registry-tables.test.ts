import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRODUCTION_TOOL_DECLARATIONS } from '../src/composition-root/production-declarations.ts';
import type { ToolDeclaration } from '../src/contract/tool-declaration.ts';
import type { HttpOperationName, ModuleTargetName, RegistryToolName } from '../src/shared/brands.ts';
import type { JsonSchema } from '../src/contract/json.ts';
import { contractPath, findRegistryTableDrift, renderRegistryRow, renderRegistryTables } from './generate-contract-registry-tables.ts';
import { toLf } from './generate-migration-0001.ts';

/**
 * S63 (`30-slices.md` § S63): the contract's registry tables are generated from
 * the tree's `ToolDeclaration` values, and the build fails when the committed
 * tables differ from what the generator would write.
 */

const EMPTY_SCHEMA = { type: 'object' } as unknown as JsonSchema;

function declaration(overrides: Omit<Partial<ToolDeclaration>, 'name'> & { readonly name: string }): ToolDeclaration {
  return {
    description: 'fixture',
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    scopes: ['read'],
    capabilities: ['repo.read'],
    capabilityScope: 'declaration',
    executionClass: 'read',
    annotations: { schedulable: false, fileWatcher: false, untrustedOutput: false },
    limits: { timeoutSeconds: 30, maxResultBytes: 65536 },
    target: { kind: 'module', target: 'git.status' as ModuleTargetName },
    ...overrides,
    name: overrides.name as RegistryToolName,
  };
}

const ALPHA = declaration({ name: 'alpha' });
const BETA = declaration({
  name: 'beta',
  scopes: ['write'],
  capabilities: ['git.local.write', 'git.remote.write'],
  executionClass: 'mutating',
  annotations: { schedulable: true, fileWatcher: 'plan', untrustedOutput: true },
  limits: { timeoutSeconds: 300, maxResultBytes: 4194304 },
  target: { kind: 'http', operation: 'verify-published-url' as HttpOperationName },
});

const HEADER =
  '| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |\n' +
  '|---|---|---|---|---|---|---|';

function miniContract(table: string, names = 'alpha beta'): string {
  return `# Contract\n\nIntro.\n\n<!-- registry-table: ${names} -->\n${table}\n<!-- /registry-table -->\n\nAfter.\n`;
}

test('S63.1 a row renders every column from the declaration, in the contract’s literal notation', () => {
  assert.equal(
    renderRegistryRow(ALPHA),
    "| `alpha` | `{ kind: 'module', target: 'git.status' }` | `['repo.read']` | `['read']` | `read` | " +
      '`{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30, maxResultBytes: 65536 }` |',
  );
  assert.equal(
    renderRegistryRow(BETA),
    "| `beta` | `{ kind: 'http', operation: 'verify-published-url' }` | `['git.local.write', 'git.remote.write']` | `['write']` | `mutating` | " +
      "`{ schedulable: true, fileWatcher: 'plan', untrustedOutput: true }` | `{ timeoutSeconds: 300, maxResultBytes: 4194304 }` |",
  );
});

test('S63.1 a marked block is replaced by the generated table, in the order the marker names, and nothing else moves', () => {
  const rendered = renderRegistryTables(miniContract('stale text that is not a table'), [BETA, ALPHA]);
  assert.equal(rendered, miniContract(`${HEADER}\n${renderRegistryRow(ALPHA)}\n${renderRegistryRow(BETA)}`));
});

test('S63.2 the committed contract matches the generator’s output for the production declarations', () => {
  const contract = readFileSync(contractPath(), 'utf8');
  assert.deepEqual(findRegistryTableDrift(contract, PRODUCTION_TOOL_DECLARATIONS), []);
  assert.equal(toLf(contract).match(/<!-- registry-table: /g)?.length, 8, 'expected eight marked registry tables');
});

test('S63.2 a deliberately edited table cell is reported as drift', () => {
  const contract = toLf(readFileSync(contractPath(), 'utf8'));
  const edited = contract.replace(
    "| `git_push` | `{ kind: 'module', target: 'git.push' }` | `['git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 300,",
    "| `git_push` | `{ kind: 'module', target: 'git.push' }` | `['git.remote.write']` | `['write']` | `mutating` | `{ schedulable: false, fileWatcher: false, untrustedOutput: false }` | `{ timeoutSeconds: 30,",
  );
  assert.notEqual(edited, contract, 'the fixture edit must land on the real git_push row');
  const drift = findRegistryTableDrift(edited, PRODUCTION_TOOL_DECLARATIONS);
  assert.equal(drift.length, 1);
  assert.match(drift[0] ?? '', /git_push/);
});

test('S63.2 a marker naming a tool the tree does not declare is refused', () => {
  assert.throws(() => renderRegistryTables(miniContract('', 'alpha beta gamma'), [ALPHA, BETA]), /'gamma'.*not a declared tool/);
});

test('S63.2 a declared tool missing from every table is refused', () => {
  assert.throws(() => renderRegistryTables(miniContract('', 'alpha'), [ALPHA, BETA]), /'beta'.*no registry table/);
});

test('S63.2 a tool named by two tables is refused', () => {
  const twice = `${miniContract('', 'alpha beta')}\n<!-- registry-table: beta -->\n<!-- /registry-table -->\n`;
  assert.throws(() => renderRegistryTables(twice, [ALPHA, BETA]), /'beta'.*more than one registry table/);
});

test('S63.2 an unclosed marker is refused rather than swallowing the rest of the document', () => {
  assert.throws(() => renderRegistryTables('<!-- registry-table: alpha beta -->\n| stale |\n', [ALPHA, BETA]), /unclosed/);
});
