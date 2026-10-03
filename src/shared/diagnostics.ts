import type { CallContext } from './call-context.ts';
import type { Clock } from '../clock/clock.ts';
import type { Diagnostics } from '../result/envelope.ts';

/**
 * Every module builds its `Diagnostics` this same way — one shared
 * implementation rather than a private copy per module. Lives here, next to
 * `CallContext`, rather than in `result/envelope.ts`: the envelope module
 * depends on nothing above it, and `call-context.ts` already imports from it,
 * so a context-shaped helper inside the envelope would close a cycle this
 * direction never has to.
 *
 * `startedAtMs` is a `clock.monotonicMs()` reading and nothing else. A duration
 * taken between two `clock.now()` readings goes negative, or jumps, when the
 * wall clock is stepped in between, and it was clamped to zero rather than
 * reported wrong.
 */
export function diagnosticsFor(ctx: CallContext, startedAtMs: number, clock: Clock): Diagnostics {
  return {
    operationId: ctx.operationId,
    declarationId: ctx.declarationId,
    generation: ctx.generation,
    durationMs: Math.max(0, Math.round(clock.monotonicMs() - startedAtMs)),
  };
}
