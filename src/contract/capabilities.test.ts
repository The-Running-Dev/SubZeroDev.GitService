import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityScopeOf, isContentCapability, scopeForCapability, type CapabilityName, type ContentCapability } from './capabilities.ts';

// S39.1: the tail is fixed at the type. A literal whose final segment is
// neither 'read' nor 'write' fails the repository's own typecheck gate;
// a conforming name of each tail compiles. This block is exercised by
// `npm run typecheck`, not by the test runner — assigning to a typed
// variable is what makes the assignment itself the check.
{
  const readOk: ContentCapability = 'content.post.read';
  const writeOk: ContentCapability = 'content.gitUtility.write';
  void readOk;
  void writeOk;
  // @ts-expect-error — 'delete' is neither 'read' nor 'write'; this literal must fail to typecheck.
  const badTail: ContentCapability = 'content.post.delete';
  void badTail;
}

test('S39.5: the nine fixed declaration-scoped literals expand exactly as before, pinned name-by-name', () => {
  const expected: ReadonlyMap<CapabilityName, string> = new Map([
    ['repo.read', 'read'],
    ['host.pr.read', 'read'],
    ['host.checks.read', 'read'],
    ['git.local.write', 'write'],
    ['git.remote.write', 'write'],
    ['host.pr.write', 'write'],
    ['git.raw', 'raw'],
    // scheduler.read ends in 'read' and belongs to 'schedule', never 'read' — the case a uniform tail rule would silently widen.
    ['scheduler.manage', 'schedule'],
    ['scheduler.read', 'schedule'],
  ]);
  for (const [capability, scope] of expected) {
    assert.equal(scopeForCapability(capability), scope, `${capability} must resolve to '${scope}'`);
  }
});

test("S39.2's runtime half: scopeForCapability derives a content.* capability's scope from its own tail", () => {
  assert.equal(scopeForCapability('content.post.read' as CapabilityName), 'read');
  assert.equal(scopeForCapability('content.gitUtility.write' as CapabilityName), 'write');
  // Reached only via a widened `string`, since ContentCapability's own type refuses this as a literal (S39.1).
  assert.equal(scopeForCapability('content.post.delete' as CapabilityName), null);
});

test('scopeForCapability places no instance-scoped capability in any scope — unscoped by design (A7), not unscopable', () => {
  for (const capability of ['declaration.manage', 'auth.manage', 'audit.read', 'attention.resolve'] as const) {
    assert.equal(scopeForCapability(capability), null);
    assert.equal(capabilityScopeOf(capability), 'instance');
  }
});

test('isContentCapability recognises the content.* prefix and nothing else', () => {
  assert.equal(isContentCapability('content.post.read' as CapabilityName), true);
  assert.equal(isContentCapability('repo.read'), false);
  assert.equal(isContentCapability('scheduler.read'), false);
});
