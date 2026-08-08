import type { RegistryToolName } from '../shared/brands.ts';
import type { JsonValue } from '../contract/json.ts';
import type { ObservedGitState } from '../clone/types.ts';
import type { OperationJournalEntry, TerminalState } from '../journal/types.ts';

/**
 * `20-contract.md` § Recovery. Type only — the registered-by-composition
 * `RecoveryCatalogue` module and every real descriptor arrive with the
 * composites that need them (S8, S12); `Journal.classify`'s signature needs
 * the type before any of that exists.
 */
export interface RecoveryResumeStep {
  readonly tool: RegistryToolName;
  readonly input: JsonValue;
}

export interface RecoveryDescriptor {
  readonly tool: RegistryToolName;
  readonly expectedPostState: (entry: OperationJournalEntry, observed: ObservedGitState) => boolean;
  readonly resume: ((entry: OperationJournalEntry) => RecoveryResumeStep) | null;
}

export type RecoveryClassification =
  | { readonly verdict: 'nothing-happened' }
  | { readonly verdict: 'completed'; readonly terminal: TerminalState | null }
  | { readonly verdict: 'resume'; readonly step: RecoveryResumeStep }
  | { readonly verdict: 'park'; readonly reason: string };
