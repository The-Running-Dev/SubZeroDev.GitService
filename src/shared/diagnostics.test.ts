import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clock } from '../clock/clock.ts';
import type { CallContext } from './call-context.ts';
import { diagnosticsFor } from './diagnostics.ts';

const CTX = { operationId: 'op-1', declarationId: 'repo-a', generation: 1 } as unknown as CallContext;

/** A clock whose wall time is stepped by `wallStepMs` between two readings while `monotonic` advances normally. */
function steppedClock(wallStartIso: string, wallStepMs: number, monotonic: number[]): Clock {
  let wall = Date.parse(wallStartIso);
  let tick = 0;
  return {
    now: () => {
      const reading = new Date(wall).toISOString();
      wall += wallStepMs;
      return reading as ReturnType<Clock['now']>;
    },
    monotonicMs: () => monotonic[Math.min(tick++, monotonic.length - 1)]!,
  };
}

test('S46.6 — durationMs is the monotonic elapsed time, whatever the wall clock did in between', () => {
  // Wall clock stepped back an hour (NTP, a manual change): subtracting two `now()` readings would be negative.
  const back = steppedClock('2026-10-03T10:00:00.000Z', -3_600_000, [1000, 1250]);
  const started = back.monotonicMs();
  assert.equal(diagnosticsFor(CTX, started, back).durationMs, 250);

  // Stepped forward a day: the wall subtraction would report a day.
  const forward = steppedClock('2026-10-03T10:00:00.000Z', 86_400_000, [5000, 5042]);
  const startedForward = forward.monotonicMs();
  assert.equal(diagnosticsFor(CTX, startedForward, forward).durationMs, 42);
});

test('S46.6 — durationMs is never negative and carries the context ids', () => {
  const clock = steppedClock('2026-10-03T10:00:00.000Z', 0, [10, 10]);
  const result = diagnosticsFor(CTX, clock.monotonicMs(), clock);
  assert.equal(result.durationMs, 0);
  assert.equal(result.operationId, 'op-1');
});
