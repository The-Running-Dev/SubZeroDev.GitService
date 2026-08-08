import type { DeclarationId, Generation, OperationId } from '../shared/brands.ts';
import type { Finding, ResultKind } from '../shared/result-kind.ts';
import type { CapabilityName } from '../contract/capabilities.ts';
import type { LockHolder } from '../locks/types.ts';

export type { ResultKind, Finding } from '../shared/result-kind.ts';
export { isError } from '../shared/result-kind.ts';

export interface Diagnostics {
  readonly operationId: OperationId | null;
  readonly declarationId: DeclarationId | null;
  readonly generation: Generation | null;
  readonly durationMs: number;
}

export interface ToolResult<TData = never> {
  readonly ok: boolean;
  readonly kind: ResultKind;
  readonly summary: string;
  readonly data?: TData;
  readonly findings?: readonly Finding[];
  readonly diagnostics?: Diagnostics;
}

export interface ReadStamp {
  readonly lastSettledOperationId: OperationId | null;
  readonly mutationInFlight: boolean;
}

export function success<TData>(summary: string, data: TData, diagnostics: Diagnostics): ToolResult<TData> {
  return { ok: true, kind: 'success', summary, data, diagnostics };
}

export function validation(summary: string, findings: readonly Finding[]): ToolResult<never> {
  return { ok: false, kind: 'validation', summary, findings };
}

export function precondition(summary: string, findings: readonly Finding[]): ToolResult<never> {
  return { ok: false, kind: 'precondition', summary, findings };
}

export function conflict(summary: string, holder: LockHolder | null): ToolResult<never> {
  return holder === null ? { ok: false, kind: 'conflict', summary } : { ok: false, kind: 'conflict', summary, findings: [holderFinding(holder)] };
}

function holderFinding(holder: LockHolder): Finding {
  return {
    path: 'lock',
    rule: 'held-by-another-operation',
    message: `held by operation ${holder.operationId} (${holder.tool}) on ${holder.declarationId} since ${holder.heldSince}`,
  };
}

export function authorization(summary: string, missing: readonly CapabilityName[]): ToolResult<never> {
  return { ok: false, kind: 'authorization', summary, findings: missing.map(missingCapabilityFinding) };
}

function missingCapabilityFinding(capability: CapabilityName): Finding {
  return { path: 'capabilities', rule: 'missing', message: capability };
}

export function upstream(summary: string, retryAfterSeconds: number | null): ToolResult<never> {
  return retryAfterSeconds === null
    ? { ok: false, kind: 'upstream', summary }
    : { ok: false, kind: 'upstream', summary, findings: [{ path: 'retry', rule: 'retry-after-seconds', message: String(retryAfterSeconds) }] };
}

export function timeout(summary: string, limitSeconds: number): ToolResult<never> {
  return { ok: false, kind: 'timeout', summary, findings: [{ path: 'timeout', rule: 'limit-seconds', message: String(limitSeconds) }] };
}

export function infrastructure(summary: string): ToolResult<never> {
  return { ok: false, kind: 'infrastructure', summary };
}
