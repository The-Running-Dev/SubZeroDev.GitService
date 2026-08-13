/**
 * `ResultKind`, `Finding` and `ModuleErrorBase` are shared by the result
 * envelope (L1) and every module's own error union (including the compiler's,
 * L0) — declared once here rather than duplicated per consumer.
 */
export type ResultKind =
  | 'success'
  | 'validation'
  | 'precondition'
  | 'conflict'
  | 'authorization'
  | 'upstream'
  | 'timeout'
  | 'infrastructure';

export interface Finding {
  readonly path: string;
  readonly rule: string;
  readonly message: string;
}

export interface ModuleErrorBase {
  readonly resultKind: ResultKind;
  readonly retryable: boolean;
  readonly summary: string;
  /** Optional structured detail, read generically by `moduleErrorToToolResult` (`dispatch-pipeline.ts`) regardless of which module's error carries it — e.g. `CloneStoreError`'s `disk-full`. */
  readonly findings?: readonly Finding[];
}

/** `isError` is true exactly for `upstream`, `timeout` and `infrastructure` (invariant E2). */
export function isError(kind: ResultKind): boolean {
  return kind === 'upstream' || kind === 'timeout' || kind === 'infrastructure';
}
