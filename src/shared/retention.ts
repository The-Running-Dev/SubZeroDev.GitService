/**
 * Shared by every module that owns a retention window (`runRetention`).
 * Declared once here rather than in whichever module happened to need it
 * first; the lifecycle module drives them all in a fixed order (invariant D5).
 */
export interface RetentionReport {
  readonly module: string;
  readonly deletedRows: number;
  readonly freedBytes: number;
  readonly skipped: readonly string[];
}

/** A day-count window relative to `now`, as the ISO cutoff every `runRetention` compares row timestamps against. */
export function retentionCutoff(now: string, days: number): string {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

/**
 * The `Outcome`-to-`RetentionReport` translation every owning module repeats:
 * a store failure reports itself honestly in `skipped` rather than as a
 * deletion count, and a real pass reports its row count with nothing skipped.
 * Each module's own `Outcome` error type differs, so callers normalise to
 * `{ok:false, summary}` at the call site rather than this helper depending on
 * any one module's error shape.
 */
export function toRetentionReport(module: string, result: { readonly ok: true; readonly value: number } | { readonly ok: false; readonly summary: string }): RetentionReport {
  if (!result.ok) return { module, deletedRows: 0, freedBytes: 0, skipped: [`retention pass failed: ${result.summary}`] };
  return { module, deletedRows: result.value, freedBytes: 0, skipped: [] };
}
