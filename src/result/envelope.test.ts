import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorization,
  conflict,
  infrastructure,
  isError,
  precondition,
  success,
  timeout,
  upstream,
  validation,
  type ResultKind,
} from './envelope.ts';

const ALL_KINDS: readonly ResultKind[] = [
  'success',
  'validation',
  'precondition',
  'conflict',
  'authorization',
  'upstream',
  'timeout',
  'infrastructure',
];

test('E1: result.ok === (result.kind === "success") for every constructor', () => {
  assert.equal(success('ok', { x: 1 }, { operationId: null, declarationId: null, generation: null, durationMs: 1 }).ok, true);
  assert.equal(validation('bad input', []).ok, false);
  assert.equal(precondition('bad state', []).ok, false);
  assert.equal(conflict('busy', null).ok, false);
  assert.equal(authorization('nope', []).ok, false);
  assert.equal(upstream('down', null).ok, false);
  assert.equal(timeout('too slow', 30).ok, false);
  assert.equal(infrastructure('broken').ok, false);
});

test('E2: isError is true exactly for upstream, timeout and infrastructure', () => {
  const expectedErrorKinds = new Set<ResultKind>(['upstream', 'timeout', 'infrastructure']);
  for (const kind of ALL_KINDS) {
    assert.equal(isError(kind), expectedErrorKinds.has(kind), `isError('${kind}')`);
  }
});

test('conflict(null) carries no findings; conflict(holder) names the holder', () => {
  const bare = conflict('busy', null);
  assert.equal(bare.findings, undefined);

  const holder = conflict('busy', {
    operationId: 'op-1' as never,
    declarationId: 'decl-1' as never,
    tool: 'git_status' as never,
    heldSince: '2026-01-01T00:00:00.000Z' as never,
  });
  assert.equal(holder.findings?.length, 1);
});
