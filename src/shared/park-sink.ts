import { AsyncLocalStorage } from 'node:async_hooks';
import type { OperationId } from './brands.ts';
import { infrastructure, type ToolResult } from '../result/envelope.ts';

/**
 * `20-contract.md` § L4 — dispatch pipeline, **R13**. Why a call must park
 * when its envelope alone cannot say so. Declared here rather than in
 * `dispatch-pipeline.ts` (which re-exports both) because the writers are L2
 * modules and L2 may not import L4 (invariant B1).
 */
export type ParkCause = { readonly kind: 'signalled'; readonly signal: string | null };
export type ParkSink = Map<OperationId, ParkCause>;

interface ParkScope {
  /** `null` for a read: it notes the kill so the call can refuse, and writes no entry. */
  readonly sink: ParkSink | null;
  readonly operationId: OperationId;
  observed: string | null;
}

/**
 * The mutating call the current async chain belongs to. A scope exists only
 * inside a mutating handler, so a read that runs the very same helpers finds
 * none and writes nothing (**R13**: no read writes an entry).
 */
const active = new AsyncLocalStorage<ParkScope>();

/**
 * Runs a mutating handler as a park-sink writer. A child that ends
 * `signalled` anywhere inside it — a preflight read and a cleanup included —
 * leaves one entry for the call's `operationId`, and the call then returns
 * `infrastructure` naming that child and its signal whatever it would have
 * returned. The sink is optional because the composition root wires it to every
 * writer and to the pipeline, or to none.
 */
export async function withParkScope<T>(sink: ParkSink | undefined, operationId: OperationId, run: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  if (sink === undefined) return run();
  return scoped(sink, operationId, run);
}

/**
 * Runs a read so that a child ending `signalled` anywhere inside it makes the
 * call return `infrastructure` rather than a result built from a killed
 * command's missing output. It writes no entry, so nothing parks and nothing
 * changes (**R13**, S46.13).
 */
export function refusingSignalled<T>(operationId: OperationId, run: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  return scoped(null, operationId, run);
}

async function scoped<T>(sink: ParkSink | null, operationId: OperationId, run: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  const parent = active.getStore();
  const scope: ParkScope = { sink, operationId, observed: null };
  const result = await active.run(scope, run);
  if (scope.observed === null) return result;
  if (parent !== undefined && parent.observed === null) parent.observed = scope.observed;
  return infrastructure(scope.observed);
}

/** Called wherever a child's `signalled` end is observed. A no-op outside a mutating handler. */
export function noteSignalled(signal: string | null, summary: string): void {
  const scope = active.getStore();
  if (scope === undefined || scope.observed !== null) return;
  scope.sink?.set(scope.operationId, { kind: 'signalled', signal });
  scope.observed = summary;
}

/** Passes an exec outcome through unchanged, noting a `signalled` end on the way. */
export function observeChild<R extends { readonly ok: boolean }>(result: R): R {
  const failure = result as unknown as { readonly ok: false; readonly error: { readonly code: string; readonly signal?: string | null; readonly summary: string } };
  if (!failure.ok && failure.error.code === 'signalled') noteSignalled(failure.error.signal ?? null, failure.error.summary);
  return result;
}
