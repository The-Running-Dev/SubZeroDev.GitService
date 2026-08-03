import type { ClientId, GrantId, Subject } from './brands.ts';

/**
 * Type only. `ActorRef` and `OperationContextKind` are stamped onto every
 * mutating call, every journal entry and every audit record — used by
 * modules across L1 through L4, none of which singly owns it. Declared here
 * so it type-checks wherever it is needed ahead of the modules (Dispatch
 * pipeline, Journal, Authorization) that construct real values.
 */
export type ActorKind = 'operator' | 'mcp' | 'scheduler' | 'watcher' | 'recovery';

export interface ActorRef {
  readonly kind: ActorKind;
  readonly subject: Subject;
  readonly clientId: ClientId | null;
  readonly grantId: GrantId | null;
}

export type OperationContextKind = 'normal' | 'repair' | 'recovery' | 'hatch';
