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

export type Layer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export const LAYER_BY_TOP_DIR: Readonly<Record<string, Layer>> = {
  contract: 'L0',
  declarations: 'L1',
  credentials: 'L1',
  clone: 'L1',
  exec: 'L1',
  locks: 'L1',
  lifecycle: 'L1',
  notifier: 'L1',
  audit: 'L1',
  journal: 'L1',
  store: 'L1',
  recovery: 'L1',
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
  'mcp-proxy': 'L5',
};

/**
 * Top-level `src/` entries that carry no layer, each for a stated reason.
 * Together with `LAYER_BY_TOP_DIR` this must cover every entry under `src/`,
 * and the walk below fails when it does not — otherwise the gate's coverage
 * is invisible: an unlisted directory was silently skipped, so renaming
 * `src/surfaces`, or adding a new L4 or L5 directory, disabled B1 for it
 * while the run still printed OK (review of PR #112). Being made to classify
 * a new directory here is the point, not friction.
 */
export const UNLAYERED_TOP_ENTRIES: ReadonlySet<string> = new Set([
  // The composition root, in two files. Exempt from B1 by name — it wires
  // every layer together by construction.
  'server.ts',
  'composition-root',
  // Cross-cutting primitives with no layer of their own: branded types,
  // `Outcome`, the result envelope, the clock. Depended on from everywhere,
  // depending on nothing, so no edge through them can violate a direction.
  'shared',
  'result',
  'clock',
]);

function normalise(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function layerOf(srcRoot: string, filePath: string): Layer | null {
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

export interface LayerDirectionResult {
  /** Top-level `src/` entries that are neither layered nor explicitly unlayered. */
  unclassified: string[];
  /** One line per L0/L3/L4/L5 module that imports an L2 module. */
  violations: string[];
  /** Count of L0/L3/L4/L5 modules the walk actually inspected. */
  checkedFiles: number;
  /** Count of all non-test `.ts` files walked under `srcRoot`. */
  totalFiles: number;
}

/**
 * Walks `srcRoot` and reports invariant B1 violations. `exemptPath` is
 * compared by resolved file path, never by directory or by name — the one
 * exemption is the composition root itself, nothing beside it.
 */
export function checkLayerDirection(srcRoot: string, exemptPath: string): LayerDirectionResult {
  const unclassified = readdirSync(srcRoot).filter(
    (entry) => !(entry in LAYER_BY_TOP_DIR) && !UNLAYERED_TOP_ENTRIES.has(entry),
  );

  const files: string[] = [];
  walk(srcRoot, files);

  const violations: string[] = [];
  let checkedFiles = 0;
  const normalisedExempt = normalise(exemptPath);

  for (const file of files) {
    const normalisedFile = normalise(file);
    if (normalisedFile === normalisedExempt) continue;
    const fromLayer = layerOf(srcRoot, file);
    // L1, L2 and the unlayered primitives are not checked source layers: B1
    // as written in `20-contract.md` names only L0, L3, L4 and L5, and this
    // check enforces exactly what is written.
    if (fromLayer === null || fromLayer === 'L1' || fromLayer === 'L2') continue;
    checkedFiles += 1;

    const sourceText = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2023, true);

    sourceFile.forEachChild((node) => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      }
      if (!specifier || !specifier.startsWith('.')) return;

      const resolved = normalise(path.resolve(path.dirname(file), specifier));
      const toLayer = layerOf(srcRoot, resolved);
      if (toLayer === 'L2') {
        violations.push(`${path.relative(srcRoot, file)} (${fromLayer}) imports ${path.relative(srcRoot, resolved)} (L2)`);
      }
    });
  }

  return { unclassified, violations, checkedFiles, totalFiles: files.length };
}

// CLI entrypoint — only runs when this file is executed directly, not when
// imported by the test.
const isMain = process.argv[1] !== undefined && normalise(process.argv[1]) === normalise(fileURLToPath(import.meta.url));
if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const srcRoot = path.join(repoRoot, 'src');
  const exemptPath = path.join(srcRoot, 'server.ts');

  const result = checkLayerDirection(srcRoot, exemptPath);

  if (result.unclassified.length > 0) {
    console.error(`check-layer-direction: ${result.unclassified.length} top-level src/ entr(y|ies) carry no layer, so B1 is not being checked for them:`);
    for (const entry of result.unclassified) console.error(`  src/${entry}`);
    console.error('  Add each to LAYER_BY_TOP_DIR, or to UNLAYERED_TOP_ENTRIES with the reason it has no layer.');
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`check-layer-direction: ${result.violations.length} violation(s) of invariant B1 — L0/L3/L4/L5 importing L2:`);
    for (const violation of result.violations) console.error(`  ${violation}`);
    process.exit(1);
  }

  console.log(
    `check-layer-direction: OK — ${result.checkedFiles} L0/L3/L4/L5 module(s) checked of ${result.totalFiles} walked, none imports L2`,
  );
}
