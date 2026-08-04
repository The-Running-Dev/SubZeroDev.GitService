import type { ModuleErrorBase } from '../shared/result-kind.ts';

export type ExecError = ModuleErrorBase &
  (
    | { readonly code: 'spawn-failed' }
    | { readonly code: 'nonzero-exit'; readonly exitCode: number; readonly stderr: string }
    | { readonly code: 'timed-out'; readonly limitSeconds: number }
    | { readonly code: 'argv-rejected'; readonly rule: string }
    | { readonly code: 'cancelled' }
  );

/**
 * `20-contract.md` § Error semantics › Exec. `spawn-failed` and `nonzero-exit`
 * map to `infrastructure`/caller-classified respectively at the call site, not
 * here — this module only knows the child failed, not what the failure means
 * to a git operation, so `resultKind` is the closest umbrella each variant's
 * own table row names: `infrastructure` for the two the caller re-classifies
 * from `cause`, `timeout` for the cap, `validation` for a rejected vector
 * (`argv-rejected`: "no authority could ever permit it"), `conflict` for a
 * cancelled signal.
 */
export function execError<T extends { readonly code: ExecError['code'] }>(variant: T, summary: string): ExecError {
  const resultKind =
    variant.code === 'timed-out' ? 'timeout' : variant.code === 'argv-rejected' ? 'validation' : variant.code === 'cancelled' ? 'conflict' : 'infrastructure';
  return { resultKind, retryable: false, summary, ...variant } as unknown as ExecError;
}
