import type { BranchName, DeclarationId, IsoUtcTimestamp, RepoRelativePath, WatchedFileName } from '../shared/brands.ts';
import type { JsonValue } from '../contract/json.ts';
import type { WatchedFileOutcome } from '../audit/types.ts';

export type { WatchedFileOutcome } from '../audit/types.ts';

/** `20-contract.md` § File watcher. */
export type WatchedFileStage = 'inbox' | 'processing' | 'processed' | 'failed';

export interface FileWatcherPlanInput {
  readonly sourceFile: WatchedFileName;
  readonly content: string;
}

export interface FileWatcherPullRequestPlan {
  readonly title: string;
  readonly body: string;
}

export interface FileWatcherPlanData<TPlan extends JsonValue = JsonValue> {
  readonly branch: BranchName;
  readonly commitMessage: string;
  readonly pullRequest: FileWatcherPullRequestPlan;
  readonly permittedPaths: readonly RepoRelativePath[];
  readonly plan: TPlan;
}

export interface FileWatcherApplyInput<TPlan extends JsonValue = JsonValue> {
  readonly permittedPaths: readonly RepoRelativePath[];
  readonly plan: TPlan;
}

export interface FileWatcherApplyData {
  readonly changedPaths: readonly RepoRelativePath[];
}

export interface WatchedFileCandidate {
  readonly declarationId: DeclarationId;
  readonly file: WatchedFileName;
  readonly stage: WatchedFileStage;
  readonly sizeBytes: number;
  readonly isSymlink: boolean;
}

/** S24 (`30-slices.md` § S24, depends on S17) owns recording and reconciling these; S17 only reserves the shape. */
export interface PendingPullRequest {
  readonly declarationId: DeclarationId;
  readonly number: number;
  readonly branch: BranchName;
  readonly openedAt: IsoUtcTimestamp;
  readonly sourceFile: WatchedFileName;
}

export interface PendingPullRequestList {
  readonly entries: readonly PendingPullRequest[];
}

export interface WatchTickReport {
  readonly declarationId: DeclarationId;
  readonly skipped: 'clone-not-clean' | 'clone-needs-attention' | null;
  readonly claimed: WatchedFileName | null;
  readonly outcome: WatchedFileOutcome | null;
  readonly reconciled: readonly PendingPullRequest[];
  readonly stillPending: readonly PendingPullRequest[];
}
