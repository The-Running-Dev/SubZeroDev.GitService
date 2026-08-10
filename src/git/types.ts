import type { BranchName, GitSha, IsoUtcTimestamp, PathPrefix, RepoRelativePath } from '../shared/brands.ts';
import type { CloneUrl } from '../shared/brands.ts';
import type { ReadStamp } from '../result/envelope.ts';

/** `20-contract.md` § L2 — git operations, S6's resolution of U1 for the five read operations. */

export interface RepoStatusInput {}

export interface RepoStatusEntry {
  readonly path: RepoRelativePath;
  readonly staged: boolean;
}

export interface RepoStatusData {
  readonly branch: BranchName;
  readonly baseBranch: BranchName;
  readonly dirty: boolean;
  readonly parkedOffBase: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly changedPaths: readonly RepoStatusEntry[];
  readonly observedRemote: CloneUrl | null;
  readonly readStamp: ReadStamp;
}

export interface GitLogInput {
  readonly ref: BranchName | null;
}

export interface GitLogEntry {
  readonly sha: GitSha;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: IsoUtcTimestamp;
  readonly subject: string;
}

export interface GitLogData {
  readonly ref: BranchName;
  readonly commits: readonly GitLogEntry[];
  readonly readStamp: ReadStamp;
}

export interface BranchesInput {}

export interface BranchSummary {
  readonly name: BranchName;
  readonly current: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly lastCommitAt: IsoUtcTimestamp | null;
}

export interface BranchesData {
  readonly baseBranch: BranchName;
  readonly branches: readonly BranchSummary[];
  readonly readStamp: ReadStamp;
}

export interface RepoHealthInput {}

export interface StaleBranchSummary {
  readonly count: number;
  readonly names: readonly BranchName[];
}

export interface RepoHealthData {
  readonly branch: BranchName;
  readonly baseBranch: BranchName;
  readonly dirty: boolean;
  readonly parkedOffBase: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly commitsLast7Days: number;
  readonly daysSinceLastCommit: number | null;
  readonly staleBranches: StaleBranchSummary;
  readonly readStamp: ReadStamp;
}

export interface GitDiffInput {
  readonly staged: boolean;
  readonly paths: readonly RepoRelativePath[] | null;
}

export interface GitDiffData {
  readonly diff: string;
  readonly checkClean: boolean;
  readonly checkOutput: string;
  readonly readStamp: ReadStamp;
}

/** `20-contract.md` § L2 — git operations, S7's resolution of U1 for the three local mutating operations. */

export interface GitStageInput {
  readonly paths: readonly RepoRelativePath[];
}

export interface GitStageData {
  readonly staged: readonly RepoRelativePath[];
}

export interface GitCommitInput {
  readonly message: string;
}

export interface GitCommitData {
  readonly sha: GitSha;
  readonly branch: BranchName;
  readonly changedPaths: readonly RepoRelativePath[];
}

export interface RestorePathsInput {
  readonly paths: readonly RepoRelativePath[];
}

export interface RestorePathsData {
  readonly restored: readonly RepoRelativePath[];
}

/** `20-contract.md` § L2 — git operations, S9's resolution of U1 for the three remote operations. */

export interface GitPushInput {
  /** Null pushes the checked-out branch. There is no force option, here or anywhere in this input. */
  readonly branch: BranchName | null;
}

export interface GitPushData {
  readonly branch: BranchName;
  readonly headSha: GitSha;
  readonly alreadyUpToDate: boolean;
}

export interface GitFetchInput {}

export interface GitFetchData {
  readonly baseBranch: BranchName;
  readonly upstreamSha: GitSha | null;
  readonly updatedRefs: readonly BranchName[];
}

export interface SyncBaseInput {}

export interface SyncBaseData {
  readonly baseBranch: BranchName;
  readonly headSha: GitSha;
  readonly upstreamSha: GitSha;
  readonly fastForwarded: boolean;
}

/** `20-contract.md` § L2 — git operations, S15's resolution of U1 for the escape hatch. */
export interface GitRawInput {
  readonly argv: readonly string[];
}

export interface GitRawData {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly changedPaths: readonly RepoRelativePath[];
}

/** `20-contract.md` § L2 — git operations, `validateWritePath`'s three-way refusal. */
export type PathRejection =
  | { readonly kind: 'malformed'; readonly rule: string }
  | { readonly kind: 'outside-allowlist'; readonly prefixes: readonly PathPrefix[] }
  | { readonly kind: 'stripped-by-profile'; readonly prefix: PathPrefix };
