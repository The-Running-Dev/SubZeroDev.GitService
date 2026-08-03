import type { Outcome } from './outcome.ts';

declare const BRAND: unique symbol;
export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

export interface ValidationFailure {
  readonly field: string;
  readonly rule: string;
  readonly received: string;
}

function fail(field: string, rule: string, received: string): ValidationFailure {
  return { field, rule, received };
}

// Identifier and constrained-string brands used across the contract. Only the
// three this slice's Compiler/Clock/Surfaces need (Sha256Hex, GitSha,
// IsoUtcTimestamp) carry a validating constructor below; the rest are declared
// as types only, so signatures elsewhere in the contract type-check without
// this slice fabricating validation logic that belongs to a module it does
// not touch.
export type DeclarationId = Brand<string, 'DeclarationId'>;
export type Generation = Brand<number, 'Generation'>;
export type GrantEpoch = Brand<number, 'GrantEpoch'>;
export type CredentialRef = Brand<string, 'CredentialRef'>;
export type RegistryToolName = Brand<string, 'RegistryToolName'>;
export type ModuleTargetName = Brand<string, 'ModuleTargetName'>;
export type HttpOperationName = Brand<string, 'HttpOperationName'>;
export type OperationId = Brand<string, 'OperationId'>;
export type ScheduledJobId = Brand<string, 'ScheduledJobId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type ClientId = Brand<string, 'ClientId'>;
export type GrantId = Brand<string, 'GrantId'>;
export type TokenId = Brand<string, 'TokenId'>;
export type OutboxRowId = Brand<string, 'OutboxRowId'>;
export type ConsoleViewId = Brand<string, 'ConsoleViewId'>;
export type Subject = Brand<string, 'Subject'>;
export type IsoUtcTimestamp = Brand<string, 'IsoUtcTimestamp'>;
export type Sha256Hex = Brand<string, 'Sha256Hex'>;
export type GitSha = Brand<string, 'GitSha'>;
export type BranchName = Brand<string, 'BranchName'>;
export type RepoRelativePath = Brand<string, 'RepoRelativePath'>;
export type PathPrefix = Brand<string, 'PathPrefix'>;
export type ClonePath = Brand<string, 'ClonePath'>;
export type DropFileName = Brand<string, 'DropFileName'>;
export type RemoteHost = Brand<string, 'RemoteHost'>;
export type CloneUrl = Brand<string, 'CloneUrl'>;
export type HttpsUrl = Brand<string, 'HttpsUrl'>;
export type McpResourceUri = Brand<string, 'McpResourceUri'>;
export type BearerToken = Brand<string, 'BearerToken'>;
export type SaltedHash = Brand<string, 'SaltedHash'>;
export type EnvVarName = Brand<string, 'EnvVarName'>;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function sha256Hex(value: string): Outcome<Sha256Hex, ValidationFailure> {
  if (!SHA256_HEX_PATTERN.test(value)) {
    return { ok: false, error: fail('Sha256Hex', SHA256_HEX_PATTERN.source, value) };
  }
  return { ok: true, value: value as Sha256Hex };
}

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function gitSha(value: string): Outcome<GitSha, ValidationFailure> {
  if (!GIT_SHA_PATTERN.test(value)) {
    return { ok: false, error: fail('GitSha', GIT_SHA_PATTERN.source, value) };
  }
  return { ok: true, value: value as GitSha };
}

// RFC 3339, `Z` suffix, millisecond precision.
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isoUtcTimestamp(value: string): Outcome<IsoUtcTimestamp, ValidationFailure> {
  if (!ISO_UTC_TIMESTAMP_PATTERN.test(value)) {
    return { ok: false, error: fail('IsoUtcTimestamp', ISO_UTC_TIMESTAMP_PATTERN.source, value) };
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return { ok: false, error: fail('IsoUtcTimestamp', 'valid-calendar-date', value) };
  }
  return { ok: true, value: value as IsoUtcTimestamp };
}
