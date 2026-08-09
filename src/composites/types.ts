import type { BranchName, GitSha } from '../shared/brands.ts';

/**
 * `20-contract.md` § L2 — composites, S12's resolution of U1 for the two
 * composites. `TODO-NEXT.md` §7.3's `PreparePublishBranchInput` carries
 * `name`/`slug`/`kind`/`checkoutExisting` — blog-specific branch-naming
 * policy this repository does not own (`AGENTS.md`: "general git-workflow
 * safety, not blog-specific"). The caller names the branch directly.
 */
export interface PrepareBranchInput {
  readonly branch: BranchName;
}

/**
 * Which path the algorithm actually took, named so a caller (and a test) can
 * tell "nothing to do" from "the stranded-commit case just ran" without
 * re-deriving it from `preservedCommits`' length alone.
 */
export type PrepareBranchAction = 'reused-existing' | 'created-from-remote-base' | 'fast-forwarded-then-created' | 'rebased-preserved-commits';

export interface PrepareBranchData {
  readonly branch: BranchName;
  readonly baseBranch: BranchName;
  readonly branchHeadSha: GitSha;
  readonly baseSha: GitSha;
  /** Non-empty only for `rebased-preserved-commits` — the original, pre-rebase commit shas that were carried onto the new base. */
  readonly preservedCommits: readonly GitSha[];
  readonly action: PrepareBranchAction;
}

export interface ReconcileAfterMergeInput {
  readonly pullRequestNumber: number;
  /** When given, reconciliation refuses unless the merged pull request's head matches — the same guard `TODO-NEXT.md` §7.5 step 2 names. */
  readonly expectedHeadSha: GitSha | null;
}

export interface ReconcileAfterMergeData {
  readonly baseBranch: BranchName;
  readonly baseSha: GitSha;
  readonly mergeCommitSha: GitSha;
  /** Null when the pull request's branch was not present locally to delete — reconciliation from a clone that never checked it out. */
  readonly deletedBranch: BranchName | null;
}
