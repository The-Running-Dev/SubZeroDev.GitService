import type { BranchName, GitSha, HttpsUrl, IsoUtcTimestamp } from '../shared/brands.ts';

/**
 * Type only. The host adapter (L2) that produces these is S10; `WatchedFileOutcome`
 * (needed for `AuditRecordBody`'s `file-watcher` form) references it, so the
 * type is needed before the module that owns it exists.
 */
export interface PullRequestRef {
  readonly number: number;
  readonly url: HttpsUrl;
  readonly branch: BranchName;
}

export type PullRequestState = 'open' | 'merged' | 'closed';

export interface PullRequestStatus {
  readonly ref: PullRequestRef;
  readonly state: PullRequestState;
  readonly headSha: GitSha;
  readonly baseSha: GitSha;
  readonly mergeCommitSha: GitSha | null;
  readonly mergeable: boolean | null;
  readonly autoMergeEnabled: boolean;
}

export type CheckConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'pending';

export interface CheckStatus {
  readonly name: string;
  readonly conclusion: CheckConclusion;
  readonly detailsUrl: HttpsUrl | null;
}

export interface DeployStatus {
  readonly workflow: string;
  readonly commitSha: GitSha;
  readonly conclusion: 'success' | 'failure' | 'cancelled' | 'pending';
  readonly detailsUrl: HttpsUrl | null;
}

/**
 * `body` is author-controlled text from a pull request thread. It is carried
 * as data and never interpreted; the tool returning it is annotated
 * `untrustedOutput` (`20-contract.md` § L2 — host adapter).
 */
export interface HostComment {
  readonly author: string;
  readonly body: string;
  readonly createdAt: IsoUtcTimestamp;
}

export interface RequestBudget {
  readonly remaining: number;
  readonly resetsAt: IsoUtcTimestamp | null;
}

// --- S10's tool input and output types (`20-contract.md` § L2 — host adapter) ---

/**
 * Carries **no base branch**, deliberately: the base is the declaration's
 * `RepositoryConfig.baseBranch`, for the same reason `git_push` takes no
 * remote. An input-supplied base would let a caller open a pull request
 * against a branch the declaration never named.
 */
export interface CreatePullRequestInput {
  readonly title: string;
  readonly body: string;
  /** Null means the checked-out branch, matching `GitPushInput.branch`. */
  readonly headBranch: BranchName | null;
  readonly draft: boolean;
}

export interface PrOpenData {
  readonly ref: PullRequestRef;
}

export interface PrStatusInput {
  readonly number: number;
}

export interface PrStatusData {
  readonly status: PullRequestStatus;
}

export interface PrListInput {
  readonly state: PullRequestState | null;
}

export interface PrListData {
  readonly pullRequests: readonly PullRequestStatus[];
}

export interface PrCommentsInput {
  readonly number: number;
}

export interface PrCommentsData {
  readonly comments: readonly HostComment[];
}

export interface PrEnableAutoMergeInput {
  readonly number: number;
}

export interface PrEnableAutoMergeData {
  readonly number: number;
  readonly autoMergeEnabled: boolean;
}

export interface ChecksStatusInput {
  /** Null means the clone's current head. */
  readonly ref: GitSha | null;
}

export interface ChecksStatusData {
  readonly ref: GitSha;
  readonly checks: readonly CheckStatus[];
}

export interface ChecksAwaitInput {
  readonly ref: GitSha | null;
  readonly timeoutSeconds: number;
}

export interface ChecksAwaitData {
  readonly ref: GitSha;
  readonly checks: readonly CheckStatus[];
  /**
   * False when the wait returned without every check reaching a conclusion.
   * Callers read this rather than inferring conclusion from the check list.
   */
  readonly concluded: boolean;
  readonly waitedSeconds: number;
}
