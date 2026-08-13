import type { ModuleErrorBase, Finding } from '../shared/result-kind.ts';
import type { CapabilityName } from '../contract/capabilities.ts';
import type { GrantId, RegistryToolName, ScheduledJobId } from '../shared/brands.ts';
import type { StoreError } from '../store/errors.ts';
import type { ScheduledJobStatus } from './types.ts';

/** `20-contract.md` § Error semantics › Scheduler. */
export type SchedulerError = ModuleErrorBase &
  (
    | { readonly code: 'tool-not-in-registry'; readonly tool: RegistryToolName }
    | { readonly code: 'tool-not-schedulable'; readonly tool: RegistryToolName }
    | { readonly code: 'input-invalid'; readonly findings: readonly Finding[] }
    | { readonly code: 'job-not-found'; readonly id: ScheduledJobId }
    | { readonly code: 'job-not-pending'; readonly id: ScheduledJobId; readonly status: ScheduledJobStatus }
    | { readonly code: 'grant-revoked'; readonly grantId: GrantId }
    | { readonly code: 'grant-insufficient'; readonly missing: readonly CapabilityName[] }
    | { readonly code: 'store-failed'; readonly cause: StoreError }
  );

/**
 * `20-contract.md` § Error semantics › Scheduler, one row at a time:
 * `tool-not-in-registry`/`tool-not-schedulable`/`input-invalid` map to
 * `validation` at creation; `job-not-found`/`job-not-pending` to
 * `precondition`; `store-failed` to `infrastructure`. `grant-revoked` and
 * `grant-insufficient` are never returned from `create`/`cancel` — they are
 * `tick`'s own internal fire-time outcomes, resolved into a job status
 * rather than surfaced through this `Outcome` channel — so their
 * `resultKind` is unused in practice and set to `infrastructure` only so
 * `ModuleErrorBase` stays total.
 */
export function schedulerError<T extends { readonly code: SchedulerError['code'] }>(variant: T, summary: string): SchedulerError {
  const resultKind =
    variant.code === 'job-not-found' || variant.code === 'job-not-pending'
      ? 'precondition'
      : variant.code === 'grant-revoked' || variant.code === 'grant-insufficient' || variant.code === 'store-failed'
        ? 'infrastructure'
        : 'validation';
  return { resultKind, retryable: false, summary, ...variant } as unknown as SchedulerError;
}
