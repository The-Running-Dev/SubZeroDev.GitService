import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Invariant B1: "Nothing in L0, L3, L4 or L5 imports anything from L2, and
 * the exemption is exactly one path — the composition root."
 * (`20-contract.md` § Boundaries). `10-design.md`'s module table
 * (`L5 Surfaces` / `L4 Runtime` / `L3 Adapters` / `L2 Domain` / `L1 Platform`
 * / `L0 Contract`) fixes which top-level `src/` directory is which layer;
 * this walks the real module graph and fails on any edge the table forbids.
 *
 * L1 is deliberately not a source layer checked here — B1 as written in
 * `20-contract.md` names only L0, L3, L4 and L5, and this check enforces
 * exactly what is written, nothing wider.
 *
 * `src/server.ts` is the one named exemption (the composition root wires
 * every layer together by construction) — exempt by path, so widening the
 * exemption to a second file is a visible diff here. Test files are excluded
 * from the walk entirely: a test composing L0 and L2 together is exercising
 * the seam on purpose, not violating the boundary the seam sits behind.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');
const exemptPath = path.join(srcRoot, 'server.ts');

type Layer = 'L0' | 'L2' | 'L3' | 'L4' | 'L5';

const LAYER_BY_TOP_DIR: Readonly<Record<string, Layer>> = {
  contract: 'L0',
  git: 'L2',
  composites: 'L2',
  host: 'L2',
  scheduler: 'L2',
  watcher: 'L2',
  'module-adapter': 'L3',
  http: 'L3',
  dispatch: 'L4',
  authorization: 'L4',
  'operator-identity': 'L4',
  surfaces: 'L5',
};

function normalise(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function layerOf(filePath: string): Layer | null {
  const relative = path.relative(srcRoot, filePath);
  const topDir = relative.split(path.sep)[0] ?? '';
  return LAYER_BY_TOP_DIR[topDir] ?? null;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

const files: string[] = [];
walk(srcRoot, files);

const violations: string[] = [];

for (const file of files) {
  const normalisedFile = normalise(file);
  if (normalisedFile === normalise(exemptPath)) continue;
  const fromLayer = layerOf(file);
  if (fromLayer === null || fromLayer === 'L2') continue; // L1/unclassified, and L2 itself — not a checked source layer.

  const sourceText = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2023, true);

  sourceFile.forEachChild((node) => {
    let specifier: string | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier.text;
    }
    if (!specifier || !specifier.startsWith('.')) return;

    const resolved = normalise(path.resolve(path.dirname(file), specifier));
    const toLayer = layerOf(resolved);
    if (toLayer === 'L2') {
      violations.push(`${path.relative(repoRoot, file)} (${fromLayer}) imports ${path.relative(repoRoot, resolved)} (L2)`);
    }
  });
}

if (violations.length > 0) {
  console.error(`check-layer-direction: ${violations.length} violation(s) of invariant B1 — L0/L3/L4/L5 importing L2:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`check-layer-direction: OK — ${files.length} runtime module(s) walked, no L0/L3/L4/L5 module imports L2`);
