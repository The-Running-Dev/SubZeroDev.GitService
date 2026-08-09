import type { RecoveryDescriptor } from '../recovery/types.ts';

/**
 * Recovery descriptors for S12's two composites — the first descriptors in
 * this codebase that ever return a `resume` step (`lifecycle/recovery.ts`'s
 * own doc comment: "The first real resume arrives with S12's composites").
 *
 * **Both always resume, never claim `completed`, and never park on their
 * own.** Neither composite's effect is fully visible in `ObservedGitState`
 * — `prepareBranch` may have finished on a branch other than the one
 * currently checked out mid-algorithm, and `reconcileAfterMerge`'s
 * "deleted the feature branch" half has no field in `ObservedGitState` at
 * all — so `expectedPostState` has nothing it could honestly read, the same
 * reasoning `sync_base`'s own descriptor already gives (`git/recovery-descriptors.ts`).
 *
 * The resume step re-dispatches the **same composite tool with the entry's
 * original input**, not a narrower step. This is safe only because both
 * composites are written to be idempotent from any partial state: each
 * inspects real git/host state on every call and does the minimum work
 * remaining — a killed `prepareBranch` re-run finds its stale rebase (if
 * any) and aborts it, finds a branch already properly based and reuses it;
 * a killed `reconcileAfterMerge` re-run finds the base already
 * fast-forwarded and the feature branch already deleted and does nothing
 * further. Re-running is exactly what `resume` is for, and unlike a host
 * mutation (`host/recovery-descriptors.ts`), re-running either composite
 * cannot duplicate anything — there is no create-a-second-of-something path
 * through either algorithm.
 */
export const PREPARE_BRANCH_RECOVERY: RecoveryDescriptor = {
  tool: 'prepare_branch' as never,
  expectedPostState: () => false,
  resume: (entry) => ({ tool: entry.tool, input: entry.input }),
};

export const RECONCILE_AFTER_MERGE_RECOVERY: RecoveryDescriptor = {
  tool: 'reconcile_after_merge' as never,
  expectedPostState: () => false,
  resume: (entry) => ({ tool: entry.tool, input: entry.input }),
};

export const COMPOSITE_RECOVERY_DESCRIPTORS: readonly RecoveryDescriptor[] = [PREPARE_BRANCH_RECOVERY, RECONCILE_AFTER_MERGE_RECOVERY];
