import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { AuditChainBreak } from './types.ts';

export type AuditError = ModuleErrorBase &
  (
    | { readonly code: 'query-failed' }
    | { readonly code: 'segment-unreadable'; readonly segment: number }
    | { readonly code: 'chain-broken'; readonly at: AuditChainBreak }
  );
