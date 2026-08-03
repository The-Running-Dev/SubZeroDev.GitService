import type { BranchName, HttpsUrl } from '../shared/brands.ts';

/**
 * Type only. The host adapter (L2) that produces these is S10; `DropOutcome`
 * (needed for `AuditRecordBody`'s `content-drop` form) references it, so the
 * type is needed before the module that owns it exists.
 */
export interface PullRequestRef {
  readonly number: number;
  readonly url: HttpsUrl;
  readonly branch: BranchName;
}
