import { statSync, unlinkSync } from 'node:fs';
import { err, ok, type Outcome } from './outcome.ts';

/**
 * `20-contract.md` § Volume, retention and maintenance. Declared once here
 * rather than separately by `Lifecycle.runMaintenance` and
 * `CloneStore.requestMaintenance` — both name the same reason a pass ran for,
 * and a second, independently-maintained copy is exactly what drifted `S27`
 * found (`clone-store.ts` had invented its own `'manual'` variant in place of
 * the contract's `'operator-requested'`).
 */
export type MaintenanceReason = 'scheduled' | 'watermark' | 'operator-requested';

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

/**
 * Deletes a file already selected for removal, returning the bytes freed —
 * the stat-then-unlink shape every filesystem-owning `runRetention` repeats
 * (audit segments, store backups/snapshots, watcher processed files).
 * Declared once here for the same reason `toRetentionReport` is; the caller
 * still builds its own skip-message text, since that names the
 * module-specific thing being pruned.
 */
export function unlinkAndCountBytes(file: string): Outcome<number, void> {
  try {
    const bytes = statSync(file).size;
    unlinkSync(file);
    return ok(bytes);
  } catch {
    return err(undefined);
  }
}
