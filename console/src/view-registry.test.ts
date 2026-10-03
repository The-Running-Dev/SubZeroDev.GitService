import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { eligibleViews, type ConsoleViewRegistration } from './view-registry.ts';

function view(id: string, capabilities: readonly string[]): ConsoleViewRegistration {
  // `satisfies` rather than a type annotation: if a future edit added a
  // field naming the declaration a view belongs to, this object literal
  // would still compile against a widened type, but only a literal with
  // exactly these four members satisfies the interface as it stands today
  // — S19.5, checked here rather than left to review alone.
  return { id, title: id, capabilities, render: () => createElement('div', null, id) } satisfies ConsoleViewRegistration;
}

test('S19.4 — a view renders when the grant contains every capability it declares', () => {
  const v = view('audit-plus', ['audit.read']);
  assert.deepEqual(eligibleViews([v], ['audit.read', 'declaration.manage']), [v]);
});

test('S19.4 — a view is absent when the grant is missing one of the capabilities it declares', () => {
  const v = view('audit-plus', ['audit.read', 'attention.resolve']);
  assert.deepEqual(eligibleViews([v], ['audit.read']), []);
});

test('S19.4 — a view with no declared capabilities is always eligible', () => {
  const v = view('no-op', []);
  assert.deepEqual(eligibleViews([v], []), [v]);
});

test('S48.2 — a view whose capability is in the declared grant but excluded by the ceiling is not offered', () => {
  // The shape `GET /declarations` returns: the declared grant still carries
  // `attention.resolve`, the server-computed effective grant has lost it.
  const declaration = { capabilityGrant: ['audit.read', 'attention.resolve'], effectiveGrant: ['audit.read'] };
  const offered = view('audit-only', ['audit.read']);
  const excluded = view('resolve-view', ['attention.resolve']);
  assert.deepEqual(eligibleViews([offered, excluded], declaration.effectiveGrant), [offered]);
  assert.deepEqual(
    eligibleViews([offered, excluded], declaration.capabilityGrant),
    [offered, excluded],
    'the raw declared grant would have offered it — the reason the landing screen reads effectiveGrant',
  );
});

test('eligibleViews filters independently per view, preserving registration order', () => {
  const allowed = view('allowed', ['audit.read']);
  const denied = view('denied', ['auth.manage']);
  assert.deepEqual(eligibleViews([allowed, denied], ['audit.read']), [allowed]);
});
