import type { RecoveryDescriptor } from '../recovery/types.ts';

/**
 * Recovery descriptors for S10's two host mutations.
 *
 * **Both park, always, and that is the design rather than a shortfall.** A
 * host mutation's effect lands on the host; `ObservedGitState` describes the
 * local clone, and opening a pull request or enabling auto-merge changes
 * nothing in it. So `expectedPostState` has nothing it could honestly read,
 * and returning `true` would report an operation complete on no evidence.
 *
 * The journal step written before the network call (see `host-operations.ts`)
 * is what makes parking reachable at all: with a step recorded, `classify`
 * refuses to call the entry `nothing-happened`, falls through to the
 * descriptor, and parks. Without the step, a kill in that window would look
 * exactly like a call that never happened — and the retry would open a second
 * pull request, which is the outcome S10 exists to prevent.
 *
 * `resume: null` for the same reason `git_restore_paths` sets it: re-running
 * a host mutation is precisely the duplicate the step ordering was built to
 * avoid, and invariant R7 forbids a recovery path that can discard work.
 * An operator reading the parked entry can see the host and decide; the
 * service cannot.
 */
export const PR_OPEN_RECOVERY: RecoveryDescriptor = {
  tool: 'pr_open' as never,
  expectedPostState: () => false,
  resume: null,
};

export const PR_ENABLE_AUTO_MERGE_RECOVERY: RecoveryDescriptor = {
  tool: 'pr_enable_auto_merge' as never,
  expectedPostState: () => false,
  resume: null,
};
