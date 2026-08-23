import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compiler, MIN_LIMIT, MONITORING_WAIT_CAP_SECONDS } from './compiler.ts';
import { fixtureTool, httpTarget, moduleTarget } from './fixtures.ts';
import { SELF_TEST_FIXTURES } from './self-test-fixtures.ts';
import type { ToolDeclaration } from './tool-declaration.ts';

const WATCHER_PLAN_SCHEMA = { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } as never;
const WATCHER_PLAN_INPUT_SCHEMA = {
  type: 'object',
  properties: { sourceFile: { type: 'string' }, content: { type: 'string' } },
  required: ['sourceFile', 'content'],
} as never;
const WATCHER_PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commitMessage: { type: 'string' },
    pullRequest: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
    permittedPaths: { type: 'array', items: { type: 'string' } },
    plan: WATCHER_PLAN_SCHEMA,
  },
  required: ['branch', 'commitMessage', 'pullRequest', 'permittedPaths', 'plan'],
} as never;
const WATCHER_APPLY_INPUT_SCHEMA = {
  type: 'object',
  properties: { permittedPaths: { type: 'array', items: { type: 'string' } }, plan: WATCHER_PLAN_SCHEMA },
  required: ['permittedPaths', 'plan'],
} as never;
const WATCHER_APPLY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { changedPaths: { type: 'array', items: { type: 'string' } } },
  required: ['changedPaths'],
} as never;

function watcherPlan(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return fixtureTool({
    name: 'watch_plan',
    target: moduleTarget('watch.plan'),
    inputSchema: WATCHER_PLAN_INPUT_SCHEMA,
    outputSchema: WATCHER_PLAN_OUTPUT_SCHEMA,
    scopes: ['write'],
    capabilities: [],
    capabilityScope: 'declaration',
    executionClass: 'read',
    annotations: { schedulable: false, fileWatcher: 'plan', untrustedOutput: true },
    ...overrides,
  });
}

function watcherApply(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return fixtureTool({
    name: 'watch_apply',
    target: moduleTarget('watch.apply'),
    inputSchema: WATCHER_APPLY_INPUT_SCHEMA,
    outputSchema: WATCHER_APPLY_OUTPUT_SCHEMA,
    scopes: ['write'],
    capabilities: ['git.local.write'],
    capabilityScope: 'declaration',
    executionClass: 'mutating',
    annotations: { schedulable: false, fileWatcher: 'apply', untrustedOutput: true },
    ...overrides,
  });
}

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
    'capability-unscopable',
  ];
  const covered = new Set(SELF_TEST_FIXTURES.map((f) => f.expected));
  for (const code of allCodes) {
    assert.ok(covered.has(code as never), `no self-test fixture covers '${code}'`);
  }
});

test('S23.1 — file-watcher entry shapes state 2 accepted and 8 rejected fixtures', () => {
  const plan = watcherPlan();
  const apply = watcherApply();
  const accepted = [plan, apply];
  const rejected: ToolDeclaration[] = [
    { ...plan, target: httpTarget('watch.plan') },
    { ...plan, executionClass: 'mutating' },
    { ...plan, scopes: ['read'] },
    { ...plan, capabilities: ['repo.read'] },
    { ...apply, target: httpTarget('watch.apply') },
    { ...apply, executionClass: 'read' },
    { ...apply, capabilities: [] },
    { ...apply, annotations: { schedulable: true, fileWatcher: 'apply', untrustedOutput: true } as never },
  ];
  assert.equal(accepted.filter((entry) => compiler.compile([entry]).ok).length, 2);
  assert.equal(rejected.filter((entry) => {
    const result = compiler.compile([entry]);
    return !result.ok && result.error.some((error) => error.code === 'annotation-contradiction');
  }).length, 8);
});

/** A deep copy of one of the fixed watcher schemas, for mutating a single field out of shape. */
function bend(schema: unknown, mutate: (copy: Record<string, never>) => void): never {
  const copy = structuredClone(schema) as Record<string, never>;
  mutate(copy);
  return copy as never;
}

/**
 * Each case names the finding path it must produce, not merely that *something*
 * was rejected. Counting rejections alone let a fixture pass for the wrong
 * reason — every case below whose schema is malformed in one specific place
 * would still "reject" against a validator that only checked the outer type.
 */
const REJECTED_PROJECTIONS: readonly (readonly [string, ToolDeclaration, string])[] = [
  ['plan input is bare', watcherPlan({ inputSchema: { type: 'object' } as never }), 'inputSchema.properties.sourceFile'],
  ['plan output is bare', watcherPlan({ outputSchema: { type: 'object' } as never }), 'outputSchema.properties.branch'],
  ['apply input is bare', watcherApply({ inputSchema: { type: 'object' } as never }), 'inputSchema.properties.permittedPaths'],
  ['apply output is bare', watcherApply({ outputSchema: { type: 'object' } as never }), 'outputSchema.properties.changedPaths'],
  ['outer schema declares no type', watcherPlan({ inputSchema: bend(WATCHER_PLAN_INPUT_SCHEMA, (s) => delete s.type) }), 'inputSchema'],
  ['outer schema is an array', watcherPlan({ inputSchema: [] as never }), 'inputSchema'],
  ['sourceFile is not a string', watcherPlan({ inputSchema: bend(WATCHER_PLAN_INPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).sourceFile = { type: 'number' }; }) }), 'inputSchema.properties.sourceFile.type'],
  ['sourceFile is a nullable union', watcherPlan({ inputSchema: bend(WATCHER_PLAN_INPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).sourceFile = { type: ['string', 'null'] }; }) }), 'inputSchema.properties.sourceFile.type'],
  ['permittedPaths is not an array', watcherPlan({ outputSchema: bend(WATCHER_PLAN_OUTPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).permittedPaths = { type: 'string' }; }) }), 'outputSchema.properties.permittedPaths.type'],
  ['permittedPaths holds non-strings', watcherPlan({ outputSchema: bend(WATCHER_PLAN_OUTPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).permittedPaths = { type: 'array', items: { type: 'number' } }; }) }), 'outputSchema.properties.permittedPaths.items.type'],
  ['pullRequest is not an object', watcherPlan({ outputSchema: bend(WATCHER_PLAN_OUTPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).pullRequest = { type: 'string' }; }) }), 'outputSchema.properties.pullRequest'],
  ['pullRequest omits body', watcherPlan({ outputSchema: bend(WATCHER_PLAN_OUTPUT_SCHEMA, (s) => { (s.properties as never as Record<string, { properties: Record<string, unknown>; required: string[] }>).pullRequest = { properties: { title: { type: 'string' } }, required: ['title'], type: 'object' } as never; }) }), 'outputSchema.properties.pullRequest.properties.body'],
  ['changedPaths holds non-strings', watcherApply({ outputSchema: bend(WATCHER_APPLY_OUTPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).changedPaths = { type: 'array', items: { type: 'number' } }; }) }), 'outputSchema.properties.changedPaths.items.type'],
  // The four below are what "projection is exact" buys. Before it, each of
  // these compiled — and the two input cases would then have failed schema
  // validation on every dispatch the watcher ever made, since the watcher
  // sends exactly the contract's fields and nothing else.
  ['plan input requires a sixth field', watcherPlan({ inputSchema: bend(WATCHER_PLAN_INPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).surprise = { type: 'string' }; (s.required as never as string[]).push('surprise'); }) }), 'inputSchema.properties.surprise'],
  ['plan output declares an extra field', watcherPlan({ outputSchema: bend(WATCHER_PLAN_OUTPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).surprise = { type: 'string' }; }) }), 'outputSchema.properties.surprise'],
  ['apply input requires a third field', watcherApply({ inputSchema: bend(WATCHER_APPLY_INPUT_SCHEMA, (s) => { (s.properties as never as Record<string, unknown>).surprise = { type: 'string' }; (s.required as never as string[]).push('surprise'); }) }), 'inputSchema.properties.surprise'],
  ['pullRequest declares an extra field', watcherPlan({ outputSchema: bend(WATCHER_PLAN_OUTPUT_SCHEMA, (s) => { (s.properties as never as Record<string, { properties: Record<string, unknown> }>)['pullRequest']!.properties['surprise'] = { type: 'string' }; }) }), 'outputSchema.properties.pullRequest.properties.surprise'],
];

test('S23.1 — file-watcher schema projections state 2 accepted and 17 rejected fixtures', () => {
  const accepted = [watcherPlan(), watcherApply()];
  assert.equal(accepted.filter((entry) => compiler.compile([entry]).ok).length, 2);

  assert.equal(REJECTED_PROJECTIONS.length, 17);
  for (const [label, declaration, expectedPath] of REJECTED_PROJECTIONS) {
    const result = compiler.compile([declaration]);
    assert.equal(result.ok, false, `${label}: expected rejection`);
    if (result.ok) continue;
    const findings = result.error.flatMap((error) => (error.code === 'schema-invalid' ? error.findings : []));
    assert.ok(
      findings.some((finding) => finding.path === expectedPath && finding.rule === 'watcher-schema-projection'),
      `${label}: expected a watcher-schema-projection finding at '${expectedPath}', got ${JSON.stringify(findings)}`,
    );
  }
});

test('contract limits state 1 accepted and 6 non-positive or fractional fixtures rejected', () => {
  const accepted = [fixtureTool({ name: 'valid_limits', limits: { timeoutSeconds: 1, maxResultBytes: 1 } })];
  const rejected = [
    fixtureTool({ name: 'zero_timeout', limits: { timeoutSeconds: 0, maxResultBytes: 1 } }),
    fixtureTool({ name: 'negative_timeout', limits: { timeoutSeconds: -1, maxResultBytes: 1 } }),
    fixtureTool({ name: 'fractional_timeout', limits: { timeoutSeconds: 1.5, maxResultBytes: 1 } }),
    fixtureTool({ name: 'zero_result_limit', limits: { timeoutSeconds: 1, maxResultBytes: 0 } }),
    fixtureTool({ name: 'negative_result_limit', limits: { timeoutSeconds: 1, maxResultBytes: -1 } }),
    fixtureTool({ name: 'fractional_result_limit', limits: { timeoutSeconds: 1, maxResultBytes: 1.5 } }),
  ];

  assert.equal(accepted.filter((entry) => compiler.compile([entry]).ok).length, 1);
  assert.equal(rejected.filter((entry) => {
    const result = compiler.compile([entry]);
    return !result.ok && result.error.some((error) => error.code === 'limit-exceeds-cap');
  }).length, 6);

  // `cap` is the bound the value failed against, and for these it is the lower
  // one — the smallest value the field admits, not something the declaration
  // exceeded (`20-contract.md` § Compiler). A consumer rendering `cap` reads it
  // as "what this field accepts".
  for (const entry of rejected) {
    const result = compiler.compile([entry]);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    const capped = result.error.filter((error) => error.code === 'limit-exceeds-cap');
    assert.equal(capped.length, 1, `${entry.name}: exactly one limit is out of shape`);
    assert.equal(capped[0]!.code === 'limit-exceeds-cap' && capped[0]!.cap, MIN_LIMIT);
  }

  // The monitoring-wait ceiling still reports the ceiling, not the floor.
  const overCap = compiler.compile([
    fixtureTool({ name: 'slow_wait', executionClass: 'monitoring-wait', limits: { timeoutSeconds: MONITORING_WAIT_CAP_SECONDS + 1, maxResultBytes: 1024 } }),
  ]);
  assert.equal(overCap.ok, false);
  if (!overCap.ok) {
    const capped = overCap.error.find((error) => error.code === 'limit-exceeds-cap');
    assert.equal(capped?.code === 'limit-exceeds-cap' && capped.cap, MONITORING_WAIT_CAP_SECONDS);
  }
});
