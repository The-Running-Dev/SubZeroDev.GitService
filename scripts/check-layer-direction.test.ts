import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkLayerDirection } from './check-layer-direction.ts';

/**
 * Invariant B1 (`20-contract.md` § Boundaries), counted per `agent.md` §
 * Verification — "a validator that has never failed is not known to
 * constrain anything." Each fixture builds a throwaway `src/`-shaped tree
 * under a temp directory rather than mutating the real one.
 */

function write(root: string, relativePath: string, contents: string): void {
  const full = path.join(root, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

function withFixtureRoot(build: (srcRoot: string) => void): { srcRoot: string; cleanup: () => void } {
  const srcRoot = mkdtempSync(path.join(tmpdir(), 'check-layer-direction-'));
  build(srcRoot);
  return { srcRoot, cleanup: () => rmSync(srcRoot, { recursive: true, force: true }) };
}

test('check-layer-direction rejects an L2 import from each of L0, L3, L4 and L5, counted', () => {
  const cases: readonly { readonly layerDir: string; readonly layerName: string }[] = [
    { layerDir: 'contract', layerName: 'L0' },
    { layerDir: 'http', layerName: 'L3' },
    { layerDir: 'dispatch', layerName: 'L4' },
    { layerDir: 'surfaces', layerName: 'L5' },
  ];

  let rejected = 0;
  for (const { layerDir, layerName } of cases) {
    const { srcRoot, cleanup } = withFixtureRoot((root) => {
      write(root, 'server.ts', '// composition root, exempt by path\n');
      write(root, 'git/domain.ts', 'export const domain = true;\n');
      write(root, `${layerDir}/offender.ts`, "import { domain } from '../git/domain.ts';\nexport { domain };\n");
    });
    try {
      const result = checkLayerDirection(srcRoot, path.join(srcRoot, 'server.ts'));
      assert.equal(result.unclassified.length, 0, `${layerName} fixture: unexpected unclassified entries ${JSON.stringify(result.unclassified)}`);
      assert.equal(result.violations.length, 1, `${layerName} fixture: expected exactly one violation, got ${JSON.stringify(result.violations)}`);
      const violation = result.violations[0]!;
      assert.match(violation, new RegExp(`^${layerDir}/offender\\.ts \\(${layerName}\\) imports git/domain\\.ts \\(L2\\)$`));
      rejected += 1;
    } finally {
      cleanup();
    }
  }
  assert.equal(rejected, 4, 'expected all four L0/L3/L4/L5 fixtures to be rejected');
});

test('check-layer-direction accepts the real src/ graph, with a stated checked-file count', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const srcRoot = path.join(repoRoot, 'src');
  const result = checkLayerDirection(srcRoot, path.join(srcRoot, 'server.ts'));
  assert.equal(result.unclassified.length, 0);
  assert.equal(result.violations.length, 0, `expected no B1 violations in the real graph, got ${JSON.stringify(result.violations)}`);
  assert.ok(result.checkedFiles > 0, 'expected at least one L0/L3/L4/L5 module to be checked');
  assert.ok(result.totalFiles >= result.checkedFiles);
});

test('check-layer-direction exempts only the literal composition-root path, not files sharing its name or its directory', () => {
  const { srcRoot, cleanup } = withFixtureRoot((root) => {
    write(root, 'server.ts', '// the real composition root, exempt\n');
    write(root, 'git/domain.ts', 'export const domain = true;\n');
    // Same filename as the composition root, but not the same path — inside
    // a checked layer directory. A directory- or name-scoped exemption would
    // wrongly let this through; a path-scoped one must not.
    write(root, 'http/server.ts', "import { domain } from '../git/domain.ts';\nexport { domain };\n");
  });
  try {
    const result = checkLayerDirection(srcRoot, path.join(srcRoot, 'server.ts'));
    assert.equal(result.violations.length, 1, `expected the same-named non-root file to be rejected, got ${JSON.stringify(result.violations)}`);
    assert.match(result.violations[0]!, /^http\/server\.ts \(L3\) imports git\/domain\.ts \(L2\)$/);
  } finally {
    cleanup();
  }
});
