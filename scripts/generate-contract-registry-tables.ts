import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_TOOL_DECLARATIONS } from '../src/composition-root/production-declarations.ts';
import type { ExecutionTarget, ToolDeclaration } from '../src/contract/tool-declaration.ts';
import { toLf } from './generate-migration-0001.ts';

/**
 * Renders the registry tables in `design/20-contract.md` from the tree's
 * `ToolDeclaration` values, so a declaration change and the contract's table
 * for it cannot disagree (`90-decisions.md`, 2026-08-20, "The registry entry
 * tables in `20-contract.md` become generated output").
 *
 * Each table sits between a `<!-- registry-table: <tool> <tool> ... -->` marker
 * and `<!-- /registry-table -->`. The marker is the document's: which tools a
 * section discusses, and in what order, is not a fact the tree holds. Every
 * cell is the tree's. Unlike migration 0001, nothing here is immutable once
 * released, so this generator is safe to rerun after any declaration change;
 * `npm run check:registry-tables` is what fails the build when nobody did.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OPEN = /^<!-- registry-table: ([^>]*?) -->$/;
const CLOSE = '<!-- /registry-table -->';

const HEADER = [
  '| `name` | `target` | `capabilities` | `scopes` | `executionClass` | `annotations` | `limits` |',
  '|---|---|---|---|---|---|---|',
];

function quoted(value: string): string {
  return `'${value}'`;
}

function list(values: readonly string[]): string {
  return `[${values.map(quoted).join(', ')}]`;
}

function target(value: ExecutionTarget): string {
  return value.kind === 'module'
    ? `{ kind: 'module', target: ${quoted(value.target)} }`
    : `{ kind: 'http', operation: ${quoted(value.operation)} }`;
}

export function renderRegistryRow(declaration: ToolDeclaration): string {
  const { annotations, limits } = declaration;
  const fileWatcher = annotations.fileWatcher === false ? 'false' : quoted(annotations.fileWatcher);
  const cells = [
    declaration.name,
    target(declaration.target),
    list(declaration.capabilities),
    list(declaration.scopes),
    declaration.executionClass,
    `{ schedulable: ${annotations.schedulable}, fileWatcher: ${fileWatcher}, untrustedOutput: ${annotations.untrustedOutput} }`,
    `{ timeoutSeconds: ${limits.timeoutSeconds}, maxResultBytes: ${limits.maxResultBytes} }`,
  ];
  return `| ${cells.map((cell) => `\`${cell}\``).join(' | ')} |`;
}

interface MarkedBlock {
  /** Index of the opening marker line. */
  readonly open: number;
  /** Index of the closing marker line. */
  readonly close: number;
  readonly names: readonly string[];
}

function markedBlocks(lines: readonly string[], declarations: readonly ToolDeclaration[]): MarkedBlock[] {
  const declared = new Set<string>(declarations.map((d) => d.name));
  const placed = new Set<string>();
  const blocks: MarkedBlock[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = OPEN.exec(lines[i] ?? '');
    if (!match) continue;
    const close = lines.indexOf(CLOSE, i + 1);
    const nextOpen = lines.findIndex((line, j) => j > i && OPEN.test(line));
    if (close < 0 || (nextOpen >= 0 && nextOpen < close)) {
      throw new Error(`registry-table marker on line ${i + 1} is unclosed`);
    }
    const names = (match[1] ?? '').split(/\s+/).filter(Boolean);
    for (const name of names) {
      if (!declared.has(name)) throw new Error(`registry-table marker on line ${i + 1} names '${name}', which is not a declared tool`);
      if (placed.has(name)) throw new Error(`'${name}' is named by more than one registry table`);
      placed.add(name);
    }
    blocks.push({ open: i, close, names });
    i = close;
  }

  for (const name of declared) {
    if (!placed.has(name)) throw new Error(`'${name}' is declared in the tree but appears in no registry table`);
  }
  return blocks;
}

function generatedTable(names: readonly string[], declarations: readonly ToolDeclaration[]): string[] {
  const byName = new Map<string, ToolDeclaration>(declarations.map((d) => [d.name, d]));
  return [...HEADER, ...names.map((name) => renderRegistryRow(byName.get(name)!))];
}

/** The contract with every marked block's body replaced by the generated table. */
export function renderRegistryTables(contractMarkdown: string, declarations: readonly ToolDeclaration[]): string {
  const lines = toLf(contractMarkdown).split('\n');
  const blocks = markedBlocks(lines, declarations);
  for (const block of [...blocks].reverse()) {
    lines.splice(block.open + 1, block.close - block.open - 1, ...generatedTable(block.names, declarations));
  }
  return lines.join('\n');
}

/**
 * One message per marked table whose committed body differs from the
 * generator's, naming the tools whose rows differ. Empty when the contract is
 * current. A structural fault in the markers throws instead.
 */
export function findRegistryTableDrift(contractMarkdown: string, declarations: readonly ToolDeclaration[]): string[] {
  const lines = toLf(contractMarkdown).split('\n');
  const drift: string[] = [];
  for (const block of markedBlocks(lines, declarations)) {
    const committed = lines.slice(block.open + 1, block.close);
    const expected = generatedTable(block.names, declarations);
    if (committed.join('\n') === expected.join('\n')) continue;
    const differing = block.names.filter((name, k) => committed[HEADER.length + k] !== expected[HEADER.length + k]);
    const which = differing.length > 0 ? differing.join(', ') : 'the header or row count';
    drift.push(`registry table on line ${block.open + 1} differs from the declarations: ${which}`);
  }
  return drift;
}

export function contractPath(): string {
  return path.join(repoRoot, 'design', '20-contract.md');
}

// Only write when run directly, so `check:registry-tables` can import the renderer.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderRegistryTables(fs.readFileSync(contractPath(), 'utf8'), PRODUCTION_TOOL_DECLARATIONS);
  fs.writeFileSync(contractPath(), rendered, 'utf8');
  console.log(`generate-contract-registry-tables: wrote ${contractPath()}`);
}
