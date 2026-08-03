import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from './clock.ts';

test('now() returns an IsoUtcTimestamp-shaped, millisecond-precision UTC string', () => {
  const value = systemClock.now();
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('monotonicMs() is non-decreasing between two calls', () => {
  const a = systemClock.monotonicMs();
  const b = systemClock.monotonicMs();
  assert.ok(b >= a);
});
