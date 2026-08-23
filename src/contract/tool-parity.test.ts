import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compiler } from './compiler.ts';
import { fixtureTool } from './fixtures.ts';
import { captureToolParity, compareToolParity, TOOL_PARITY_PROFILES } from './tool-parity.ts';
import type { CompiledRegistry } from './tool-declaration.ts';
import type { JsonSchema } from './json.ts';

function registryOf(...declarations: Parameters<typeof fixtureTool>[0][]): CompiledRegistry {
  const result = compiler.compile(declarations.map(fixtureTool));
  assert.ok(result.ok, `fixture registry failed to compile: ${result.ok ? '' : result.error.map((e) => e.code).join(', ')}`);
  return result.value.registry;
}

test('S36.1: capture produces one snapshot per profile the service defines, four in total', () => {
  const registry = registryOf({ name: 'git_status' });
  const snapshots = captureToolParity(registry);
  assert.equal(TOOL_PARITY_PROFILES.length, 4);
  assert.equal(snapshots.length, TOOL_PARITY_PROFILES.length);
  assert.deepEqual(
    snapshots.map((s) => s.profile).sort(),
    [...TOOL_PARITY_PROFILES].sort(),
  );
});

test('S36.2: comparing an unchanged image against its own fixtures reports zero differences, for every profile', () => {
  const registry = registryOf(
    { name: 'git_status', capabilities: ['repo.read'] },
    { name: 'git_commit', capabilities: ['git.local.write'], executionClass: 'mutating' },
    { name: 'declaration_manage', capabilityScope: 'instance', capabilities: ['declaration.manage'], executionClass: 'mutating' },
  );
  const baseline = captureToolParity(registry);
  const current = captureToolParity(registry);
  const comparison = compareToolParity(baseline, current);
  assert.deepEqual(comparison.differences, []);
  assert.equal(comparison.failed, false);
});

test('S36.3: three deliberate breaks are each detected, named, and counted — a removal, a narrowed capability set, and a changed input', () => {
  const before = registryOf(
    { name: 'git_status', capabilities: ['repo.read'] },
    { name: 'git_commit', capabilities: ['repo.read', 'git.local.write'], executionClass: 'mutating' },
    { name: 'git_log', capabilities: ['repo.read'], inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } as unknown as JsonSchema },
  );
  const after = registryOf(
    // git_status removed entirely.
    { name: 'git_commit', capabilities: ['git.local.write'], executionClass: 'mutating' }, // narrowed: repo.read dropped.
    { name: 'git_log', capabilities: ['repo.read'], inputSchema: { type: 'object', properties: { limit: { type: 'number' }, since: { type: 'string' } } } as unknown as JsonSchema }, // input changed.
  );

  const baseline = captureToolParity(before);
  const current = captureToolParity(after);
  const comparison = compareToolParity(baseline, current);

  assert.equal(comparison.failed, true);

  const removed = comparison.differences.filter((d) => d.kind === 'removed' && d.tool === 'git_status');
  const narrowed = comparison.differences.filter((d) => d.kind === 'capabilities-changed' && d.tool === 'git_commit');
  const inputChanged = comparison.differences.filter((d) => d.kind === 'input-changed' && d.tool === 'git_log');

  // Every profile whose maximal grant could ever see these read/write tools reports each break once.
  assert.ok(removed.length > 0, 'expected at least one removal difference for git_status');
  assert.ok(narrowed.length > 0, 'expected at least one capabilities-changed difference for git_commit');
  assert.ok(inputChanged.length > 0, 'expected at least one input-changed difference for git_log');
  assert.equal(removed.length + narrowed.length + inputChanged.length, comparison.differences.length, `unexpected extra differences: ${JSON.stringify(comparison.differences)}`);
});

test('S36.4: an addition is reported as an addition and does not fail a run; a removal fails', () => {
  const before = registryOf({ name: 'git_status', capabilities: ['repo.read'] });
  const addedOnly = registryOf({ name: 'git_status', capabilities: ['repo.read'] }, { name: 'git_log', capabilities: ['repo.read'] });

  const baselineBefore = captureToolParity(before);
  const additionComparison = compareToolParity(baselineBefore, captureToolParity(addedOnly));
  assert.equal(additionComparison.failed, false);
  assert.ok(additionComparison.differences.every((d) => d.kind === 'added'));
  assert.ok(additionComparison.differences.some((d) => d.tool === 'git_log' && d.kind === 'added'));

  const removalComparison = compareToolParity(captureToolParity(addedOnly), baselineBefore);
  assert.equal(removalComparison.failed, true);
  assert.ok(removalComparison.differences.some((d) => d.tool === 'git_log' && d.kind === 'removed'));
});

test('S36.5/S39.7: a capture records what a caller of that profile would actually be shown, not the whole registry', () => {
  const registry = registryOf(
    { name: 'content_publish', capabilities: ['content.publish.write'], executionClass: 'mutating' }, // S39: content.* is reachable from mcp via its own tail's scope
    { name: 'declaration_manage', capabilityScope: 'instance', capabilities: ['declaration.manage'], executionClass: 'mutating' }, // instance-scoped: absent from mcp/scheduler/watcher (A7)
  );
  const snapshots = captureToolParity(registry);
  const byProfile = new Map(snapshots.map((s) => [s.profile, new Set(s.tools.map((t) => t.name))]));

  assert.ok(byProfile.get('operator')!.has('content_publish'));
  // scheduler and watcher share one declaration-scoped-only grant shape, which includes content.*.
  assert.ok(byProfile.get('watcher')!.has('content_publish'));
  assert.ok(byProfile.get('scheduler')!.has('content_publish'));
  assert.ok(byProfile.get('mcp')!.has('content_publish'), "S39: mcp's maximal grant (all four scopes) reaches content.publish.write via the write scope");

  assert.ok(byProfile.get('operator')!.has('declaration_manage'));
  for (const profile of ['mcp', 'scheduler', 'watcher'] as const) {
    assert.equal(byProfile.get(profile)!.has('declaration_manage'), false, `A7: 'declaration.manage' must be absent from the '${profile}' profile`);
  }
});

test('S36.5: a capability change hiding a tool from one profile alone shows up as a removal in that profile\'s comparison only', () => {
  const before = registryOf({ name: 'git_raw_probe', capabilities: ['git.raw'], executionClass: 'mutating' });
  // Requiring an instance-scoped capability instead makes this invisible to
  // mcp/scheduler/watcher (A7) while it stays visible to operator — a hide
  // that must show up as a removal for those three profiles alone, not for
  // operator. (A tool's capabilities must share one `capabilityScope`, so
  // this changes what it requires rather than adding to a mixed set.)
  const after = registryOf({ name: 'git_raw_probe', capabilityScope: 'instance', capabilities: ['declaration.manage'], executionClass: 'mutating' });

  const comparison = compareToolParity(captureToolParity(before), captureToolParity(after));
  const removedProfiles = new Set(comparison.differences.filter((d) => d.kind === 'removed' && d.tool === 'git_raw_probe').map((d) => d.profile));

  assert.deepEqual([...removedProfiles].sort(), ['mcp', 'scheduler', 'watcher']);
  assert.ok(!removedProfiles.has('operator'), 'operator still holds declaration.manage, so it must not report a removal');
});

test('S36.6: unattended — capture and compare run start to finish with no manual input required', () => {
  const registry = registryOf({ name: 'git_status' });
  const comparison = compareToolParity(captureToolParity(registry), captureToolParity(registry));
  assert.equal(comparison.failed, false);
});
