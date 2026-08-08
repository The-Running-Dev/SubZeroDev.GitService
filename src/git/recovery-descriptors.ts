import type { RecoveryDescriptor } from '../recovery/types.ts';

/**
 * Recovery descriptors for S7's three local mutations.
 *
 * These are L2 knowledge — "what was this operation supposed to achieve" is a
 * fact about the git domain — held here and registered into the L1 catalogue
 * by the composition root, which is the cut that keeps L1 from importing L2
 * (`10-design.md` § the recovery catalogue).
 *
 * **All three set `resume: null`, deliberately.** A local mutation's whole
 * effect is visible in local pre-state, so `classify` can already tell
 * "never ran" from "ran" without help: an unchanged tree with no steps is
 * `nothing-happened`, and anything else reaches `expectedPostState` below.
 * There is nothing left for a resume to decide. `git_restore_paths` is the
 * case that makes this a rule rather than a convenience — re-running it
 * would restore paths to HEAD a second time, discarding whatever a human put
 * there in between, and invariant R7 forbids any recovery path that discards
 * work.
 *
 * `expectedPostState` returning `false` parks the entry, because none of
 * these registers a resume. That is reachable only if a tool recorded a
 * journal step and then left the tree untouched, which none of the three
 * does today — the branch exists so a future tool that does record steps
 * fails safe rather than being silently reported complete.
 */
export const GIT_STAGE_RECOVERY: RecoveryDescriptor = {
  tool: 'git_stage' as never,
  // Staging moves the index and nothing else. `worktreeDigest` covers tracked
  // paths that differ from the index, so it moves too — but the index is the
  // thing `git add` is *for*, and it is the honest signal.
  expectedPostState: (entry, observed) => observed.indexDigest !== entry.preState.indexDigest,
  resume: null,
};

export const GIT_COMMIT_RECOVERY: RecoveryDescriptor = {
  tool: 'git_commit' as never,
  // A commit that happened moved HEAD. Nothing else this service does can
  // move HEAD while the global mutation lock is held.
  expectedPostState: (entry, observed) => observed.headSha !== entry.preState.headSha,
  resume: null,
};

export const GIT_RESTORE_PATHS_RECOVERY: RecoveryDescriptor = {
  tool: 'git_restore_paths' as never,
  // Restoring discards staged *and* working-tree changes for the named paths,
  // so either digest moving is evidence it ran.
  expectedPostState: (entry, observed) =>
    observed.indexDigest !== entry.preState.indexDigest || observed.worktreeDigest !== entry.preState.worktreeDigest,
  resume: null,
};

export const LOCAL_MUTATION_RECOVERY_DESCRIPTORS: readonly RecoveryDescriptor[] = [
  GIT_STAGE_RECOVERY,
  GIT_COMMIT_RECOVERY,
  GIT_RESTORE_PATHS_RECOVERY,
];

/**
 * Recovery descriptors for S9's three remote operations.
 *
 * A remote operation's effect is not local, so `classify` cannot see it in the
 * tree the way it sees a commit — but it is not invisible either: every one of
 * the three moves a remote-tracking ref, and `ObservedGitState.upstreamSha` is
 * exactly that. These read that ref rather than re-contacting the remote,
 * which keeps `classify` pure and keeps recovery off the network.
 *
 * **All three set `resume: null`, and that is the safe direction.** A resume
 * would have to re-enter the dispatch pipeline, which the composition root
 * does not wire into recovery until S12 brings descriptors that need it; until
 * then an operation whose post-state does not hold parks for the operator
 * rather than being retried blind. `10-design.md` § retries is explicit that
 * nothing mutating a repository is retried automatically.
 */
export const GIT_PUSH_RECOVERY: RecoveryDescriptor = {
  tool: 'git_push' as never,
  // A push that landed left the tracked ref for the pushed branch at the local
  // head. Nothing else moves it while the global mutation lock is held.
  expectedPostState: (entry, observed) => observed.upstreamSha !== null && observed.upstreamSha === observed.headSha,
  resume: null,
};

export const GIT_FETCH_RECOVERY: RecoveryDescriptor = {
  tool: 'git_fetch' as never,
  // A fetch changes remote-tracking refs and nothing else, so a fetch that ran
  // shows a moved `upstreamSha` — and one that had nothing to fetch is
  // indistinguishable from one that never ran, which is precisely the case
  // where re-running it costs nothing. Parking on the ambiguity would be worse
  // than the ambiguity.
  expectedPostState: (entry, observed) => observed.upstreamSha !== entry.preState.upstreamSha,
  resume: null,
};

export const SYNC_BASE_RECOVERY: RecoveryDescriptor = {
  tool: 'sync_base' as never,
  // A base sync that completed left the local base branch at the fetched
  // upstream. Checked against the tracked ref rather than the fetched sha,
  // which the journal entry does not carry.
  expectedPostState: (entry, observed) => observed.upstreamSha !== entry.preState.upstreamSha || observed.headSha !== entry.preState.headSha,
  resume: null,
};

export const REMOTE_OPERATION_RECOVERY_DESCRIPTORS: readonly RecoveryDescriptor[] = [
  GIT_PUSH_RECOVERY,
  GIT_FETCH_RECOVERY,
  SYNC_BASE_RECOVERY,
];
