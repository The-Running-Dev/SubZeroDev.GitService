import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compiler } from './compiler.ts';
import { fixtureTool, moduleTarget } from './fixtures.ts';
import { SELF_TEST_FIXTURES } from './self-test-fixtures.ts';

test('compile([]) returns an empty, fingerprinted registry', () => {
  const result = compiler.compile([]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.registry.entries, []);
  assert.match(result.value.fingerprint, /^[0-9a-f]{64}$/);
});

test('the fingerprint is stable across repeated compiles and invariant to reordering — three runs, one value', () => {
  const a = fixtureTool({ name: 'alpha_tool' });
  const b = fixtureTool({ name: 'beta_tool', target: moduleTarget('beta_tool') });

  const run1 = compiler.compile([a, b]);
  const run2 = compiler.compile([a, b]);
  const run3 = compiler.compile([b, a]);

  assert.equal(run1.ok, true);
  assert.equal(run2.ok, true);
  assert.equal(run3.ok, true);
  if (!run1.ok || !run2.ok || !run3.ok) return;

  assert.equal(run1.value.fingerprint, run2.value.fingerprint);
  assert.equal(run2.value.fingerprint, run3.value.fingerprint);
});

test('the fingerprint is invariant to the order of a single entry\'s capabilities and scopes', () => {
  const a = fixtureTool({
    name: 'git_status',
    capabilities: ['repo.read', 'host.pr.read'],
    scopes: ['read', 'raw'],
  });
  const b = fixtureTool({
    name: 'git_status',
    capabilities: ['host.pr.read', 'repo.read'],
    scopes: ['raw', 'read'],
  });

  const resultA = compiler.compile([a]);
  const resultB = compiler.compile([b]);
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  if (!resultA.ok || !resultB.ok) return;

  assert.equal(resultA.value.fingerprint, resultB.value.fingerprint);
});

test('compiling a fixture set emits a sanitised manifest with no schemas, and documentation', () => {
  const tools = [fixtureTool({ name: 'git_status' }), fixtureTool({ name: 'git_log', target: moduleTarget('git_log') })];
  const result = compiler.compile(tools);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.manifest.tools.length, 2);
  for (const entry of result.value.manifest.tools) {
    assert.equal('inputSchema' in entry, false);
    assert.equal('outputSchema' in entry, false);
  }
  assert.match(result.value.documentation.markdown, /git_status/);
  assert.match(result.value.documentation.markdown, /git_log/);
});

for (const fixture of SELF_TEST_FIXTURES) {
  test(`self-test fixture: ${fixture.description}`, () => {
    const result = compiler.compile(fixture.declarations);
    if (fixture.expected === 'accept') {
      assert.equal(result.ok, true, `expected fixture to be accepted, got errors: ${!result.ok ? result.error.map((e) => e.code).join(', ') : ''}`);
    } else {
      assert.equal(result.ok, false, 'expected fixture to be rejected');
      if (result.ok) return;
      assert.ok(
        result.error.some((e) => e.code === fixture.expected),
        `expected a '${fixture.expected}' error, got: ${result.error.map((e) => e.code).join(', ')}`,
      );
    }
  });
}

test('every CompilerError variant is exercised by the self-test fixtures (definition-of-done item 2)', () => {
  const allCodes: readonly string[] = [
    'duplicate-tool-name',
    'no-executor',
    'multiple-executors',
    'capability-scope-mismatch',
    'schema-invalid',
    'annotation-contradiction',
    'reserved-name',
    'limit-exceeds-cap',
  ];
  const covered = new Set(SELF_TEST_FIXTURES.map((f) => f.expected));
  for (const code of allCodes) {
    assert.ok(covered.has(code as never), `no self-test fixture covers '${code}'`);
  }
});
