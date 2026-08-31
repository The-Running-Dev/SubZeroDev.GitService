import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALLOWED_UPWARD_TYPE_EDGES, EXEMPT_PATHS, checkLayerDirection } from './check-layer-direction.ts';

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

/**
 * The direction rule's own negative cases. Each fixture makes one of the five
 * checks added post-S36 reject something; a validator that has never failed is
 * not known to constrain anything (`AGENTS.md` § *Verification*). Counts are
 * asserted, not eyeballed.
 */

test('check-layer-direction rejects an upward value import, and accepts the same edge as a type import', () => {
  const build = (kind: 'value' | 'type') => (root: string) => {
    write(root, 'server.ts', '// composition root\n');
    write(root, 'dispatch/pipeline.ts', 'export const dispatch = true;\nexport type Dispatch = boolean;\n');
    write(
      root,
      'journal/journal.ts',
      kind === 'value'
        ? "import { dispatch } from '../dispatch/pipeline.ts';\nexport { dispatch };\n"
        : "import type { Dispatch } from '../dispatch/pipeline.ts';\nexport type { Dispatch };\n",
    );
  };

  const asValue = withFixtureRoot(build('value'));
  try {
    const result = checkLayerDirection(asValue.srcRoot, path.join(asValue.srcRoot, 'server.ts'), []);
    assert.equal(result.upwardValueViolations.length, 1, JSON.stringify(result.upwardValueViolations));
    assert.match(result.upwardValueViolations[0]!, /^journal\/journal\.ts \(L1\) value-imports dispatch\/pipeline\.ts \(L4\)$/);
    assert.equal(result.violations.length, 0, 'L1 importing L4 is not a B1 violation — B1 is about L2');
  } finally {
    asValue.cleanup();
  }

  const asType = withFixtureRoot(build('type'));
  try {
    const result = checkLayerDirection(asType.srcRoot, path.join(asType.srcRoot, 'server.ts'), [
      { from: 'journal/journal.ts', to: 'dispatch/pipeline.ts', kind: 'injected collaborator', why: 'fixture' },
    ]);
    assert.equal(result.upwardValueViolations.length, 0, JSON.stringify(result.upwardValueViolations));
    assert.equal(result.unlistedUpwardTypeEdges.length, 0, JSON.stringify(result.unlistedUpwardTypeEdges));
  } finally {
    asType.cleanup();
  }
});

test('check-layer-direction rejects a type-only upward edge that is not listed, and reports a listed edge that is gone', () => {
  const { srcRoot, cleanup } = withFixtureRoot((root) => {
    write(root, 'server.ts', '// composition root\n');
    write(root, 'dispatch/pipeline.ts', 'export type Dispatch = boolean;\n');
    write(root, 'journal/journal.ts', "import type { Dispatch } from '../dispatch/pipeline.ts';\nexport type { Dispatch };\n");
    write(root, 'audit/audit.ts', 'export const audit = true;\n');
  });
  try {
    const result = checkLayerDirection(srcRoot, path.join(srcRoot, 'server.ts'), [
      // Names a file that exists, but an edge it does not have.
      { from: 'audit/audit.ts', to: 'host/types.ts', kind: 'shared shape', why: 'fixture' },
    ]);
    assert.equal(result.unlistedUpwardTypeEdges.length, 1, JSON.stringify(result.unlistedUpwardTypeEdges));
    assert.match(result.unlistedUpwardTypeEdges[0]!, /^journal\/journal\.ts \(L1\) type-imports dispatch\/pipeline\.ts \(L4\)$/);
    assert.equal(result.staleAllowances.length, 1, JSON.stringify(result.staleAllowances));
    assert.match(result.staleAllowances[0]!, /^audit\/audit\.ts -> host\/types\.ts is allowed here but no longer exists$/);
  } finally {
    cleanup();
  }
});

test('check-layer-direction rejects a composition-root file that is not named in the exemption list', () => {
  const { srcRoot, cleanup } = withFixtureRoot((root) => {
    write(root, 'server.ts', '// composition root, named\n');
    write(root, 'git/domain.ts', 'export const domain = true;\n');
    // A second file under the root's own directory. Exempting the directory
    // would let this inherit the exemption with no diff to the gate — the
    // habit `EXEMPT_PATHS` exists to prevent.
    write(root, 'composition-root/compose.ts', "import { domain } from '../git/domain.ts';\nexport { domain };\n");
    write(root, 'composition-root/sneaked-in.ts', "import { domain } from '../git/domain.ts';\nexport { domain };\n");
  });
  try {
    const result = checkLayerDirection(
      srcRoot,
      [path.join(srcRoot, 'server.ts'), path.join(srcRoot, 'composition-root/compose.ts')],
      [],
    );
    assert.equal(result.unexemptedRootFiles.length, 1, JSON.stringify(result.unexemptedRootFiles));
    assert.match(result.unexemptedRootFiles[0]!, /^composition-root\/sneaked-in\.ts is under the composition root/);
    assert.equal(result.violations.length, 0, 'the named file stays exempt from B1');
  } finally {
    cleanup();
  }
});

test('check-layer-direction rejects a value import out of an unlayered primitive, and accepts a type-only one', () => {
  const build = (kind: 'value' | 'type') => (root: string) => {
    write(root, 'server.ts', '// composition root\n');
    write(root, 'declarations/types.ts', 'export const sessionKinds = 1;\nexport type SessionKind = string;\n');
    write(
      root,
      'shared/session.ts',
      kind === 'value'
        ? "import { sessionKinds } from '../declarations/types.ts';\nexport { sessionKinds };\n"
        : "import type { SessionKind } from '../declarations/types.ts';\nexport type { SessionKind };\n",
    );
  };

  for (const [kind, expected] of [['value', 1], ['type', 0]] as const) {
    const { srcRoot, cleanup } = withFixtureRoot(build(kind));
    try {
      const result = checkLayerDirection(srcRoot, path.join(srcRoot, 'server.ts'), []);
      assert.equal(result.primitiveValueViolations.length, expected, `${kind}: ${JSON.stringify(result.primitiveValueViolations)}`);
    } finally {
      cleanup();
    }
  }
});

test('check-layer-direction accepts the real src/ graph under every rule, with the allowance list fully live', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const srcRoot = path.join(repoRoot, 'src');
  const result = checkLayerDirection(srcRoot, EXEMPT_PATHS.map((relative) => path.join(srcRoot, relative)));

  assert.deepEqual(result.unexemptedRootFiles, []);
  assert.deepEqual(result.upwardValueViolations, [], 'a runtime edge from a lower layer to a higher one');
  assert.deepEqual(result.primitiveValueViolations, []);
  assert.deepEqual(result.unlistedUpwardTypeEdges, []);
  assert.deepEqual(result.staleAllowances, [], 'every listed upward type edge must still exist');
  assert.equal(ALLOWED_UPWARD_TYPE_EDGES.length, 12, 'the allowance list is meant to shrink, never to drift upward unnoticed');
});
