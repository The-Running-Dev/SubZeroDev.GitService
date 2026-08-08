import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryCatalogue } from './catalogue.ts';
import type { RecoveryDescriptor } from './types.ts';

function descriptorFor(tool: string, resume: RecoveryDescriptor['resume'] = null): RecoveryDescriptor {
  return { tool: tool as never, expectedPostState: () => false, resume };
}

test('a registered descriptor is resolved by tool name, and an unregistered one resolves to null rather than failing', () => {
  const catalogue = createRecoveryCatalogue();
  const stage = descriptorFor('git_stage');

  assert.equal(catalogue.register(stage).ok, true);
  assert.equal(catalogue.lookup('git_stage' as never), stage);

  // A missing descriptor is deliberately not an error of this module: the
  // ladder parks the entry, which is how an entry whose tool lost its
  // descriptor reaches a human instead of vanishing.
  assert.equal(catalogue.lookup('git_commit' as never), null);
});

test('registering two descriptors for the same tool is refused as duplicate-registration, and the first one stands', () => {
  const catalogue = createRecoveryCatalogue();
  const first = descriptorFor('git_stage');
  const second = descriptorFor('git_stage');

  assert.equal(catalogue.register(first).ok, true);
  const clash = catalogue.register(second);

  assert.equal(clash.ok, false);
  if (clash.ok) return;
  assert.equal(clash.error.code, 'duplicate-registration');
  assert.equal(clash.error.tool, 'git_stage');
  assert.equal(clash.error.resultKind, 'infrastructure');
  // The loser of the clash never displaces the winner — a silent overwrite
  // would make composition order decide which recovery rule applies.
  assert.equal(catalogue.lookup('git_stage' as never), first);
});

test('registeredTools reports exactly what was registered, and is a snapshot rather than a live view', () => {
  const catalogue = createRecoveryCatalogue();
  catalogue.register(descriptorFor('git_stage'));
  catalogue.register(descriptorFor('git_commit'));

  const before = catalogue.registeredTools();
  assert.deepEqual([...before].sort(), ['git_commit', 'git_stage']);

  catalogue.register(descriptorFor('git_restore_paths'));
  assert.equal(before.size, 2, 'a previously returned set must not mutate under the caller');
  assert.equal(catalogue.registeredTools().size, 3);
});
