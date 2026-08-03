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
