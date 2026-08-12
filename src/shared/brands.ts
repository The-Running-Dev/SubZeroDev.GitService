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
export type WatchedFileName = Brand<string, 'WatchedFileName'>;
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

// The five validators below are S5's (`30-slices.md` § S5, Declarations):
// the first module that needs `DeclarationId`, `Generation`, `GrantEpoch`,
// `CredentialRef`, `RepoRelativePath`, `PathPrefix` and `CloneUrl` for real,
// rather than typechecking against them as placeholders.

const DECLARATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function declarationId(value: string): Outcome<DeclarationId, ValidationFailure> {
  if (!DECLARATION_ID_PATTERN.test(value)) {
    return { ok: false, error: fail('DeclarationId', DECLARATION_ID_PATTERN.source, value) };
  }
  return { ok: true, value: value as DeclarationId };
}

/** `20-contract.md` § L5 — surfaces: the resource indicator is fixed as `/mcp/{declarationId}`. */
const MCP_RESOURCE_URI_PATTERN = /^\/mcp\/[a-z0-9][a-z0-9-]{0,62}$/;

export function mcpResourceUri(value: string): Outcome<McpResourceUri, ValidationFailure> {
  if (!MCP_RESOURCE_URI_PATTERN.test(value)) {
    return { ok: false, error: fail('McpResourceUri', MCP_RESOURCE_URI_PATTERN.source, value) };
  }
  return { ok: true, value: value as McpResourceUri };
}

/** The declaration id embedded in an already-validated `McpResourceUri` — the inverse of the template `mcpResourceUri` validates against. */
export function declarationIdFromResource(resource: McpResourceUri): DeclarationId {
  return (resource as unknown as string).slice('/mcp/'.length) as DeclarationId;
}

export function generation(value: number): Outcome<Generation, ValidationFailure> {
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, error: fail('Generation', 'integer >= 1', String(value)) };
  }
  return { ok: true, value: value as Generation };
}

export function grantEpoch(value: number): Outcome<GrantEpoch, ValidationFailure> {
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, error: fail('GrantEpoch', 'integer >= 0', String(value)) };
  }
  return { ok: true, value: value as GrantEpoch };
}

const CREDENTIAL_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function credentialRef(value: string): Outcome<CredentialRef, ValidationFailure> {
  if (!CREDENTIAL_REF_PATTERN.test(value)) {
    return { ok: false, error: fail('CredentialRef', CREDENTIAL_REF_PATTERN.source, value) };
  }
  return { ok: true, value: value as CredentialRef };
}

/**
 * `repoRelativePath()`'s rule set, per `20-contract.md`'s brand table: non-empty,
 * no leading `/`, no segment `..`, no `;`, not `.`, not `-A`, not `--all`. This
 * is also the rule `GitOperations.validateWritePath`'s `malformed` branch maps
 * to `validation` — S7 owns that call site; this is the shared predicate.
 */
export function repoRelativePath(value: string): Outcome<RepoRelativePath, ValidationFailure> {
  const rule = 'non-empty, no leading /, no .. segment, no ;, not ".", "-A" or "--all"';
  if (value.length === 0 || value === '.' || value === '-A' || value === '--all') {
    return { ok: false, error: fail('RepoRelativePath', rule, value) };
  }
  if (value.startsWith('/') || value.includes(';')) {
    return { ok: false, error: fail('RepoRelativePath', rule, value) };
  }
  if (value.split('/').includes('..')) {
    return { ok: false, error: fail('RepoRelativePath', rule, value) };
  }
  return { ok: true, value: value as RepoRelativePath };
}

/** A `RepoRelativePath` ending in `/`, or a `RepoRelativePath` naming one file — any valid one qualifies as both readings. */
export function pathPrefix(value: string): Outcome<PathPrefix, ValidationFailure> {
  const asRepoPath = repoRelativePath(value);
  if (!asRepoPath.ok) {
    return { ok: false, error: fail('PathPrefix', asRepoPath.error.rule, value) };
  }
  return { ok: true, value: value as PathPrefix };
}

const HTTPS_CLONE_URL_PATTERN = /^https:\/\/([^/@\s]+)\/.+$/;
// scp-style: user@host:path — the classic `git@github.com:owner/repo.git` form.
const SCP_CLONE_URL_PATTERN = /^[\w.-]+@([a-zA-Z0-9.-]+):.+$/;

/**
 * Exported for S9's remote operations, which check a clone URL's host against
 * the *credential reference's* own allowed-host list — the second, independent
 * guard alongside `cloneUrl`'s deployment allowlist. Both must read the host
 * the same way, which is why there is one function and not two.
 */
export function cloneUrlHost(value: string): string | null {
  const https = HTTPS_CLONE_URL_PATTERN.exec(value);
  if (https) return https[1]!.toLowerCase();
  const scp = SCP_CLONE_URL_PATTERN.exec(value);
  if (scp) return scp[1]!.toLowerCase();
  return null;
}

/**
 * `watchedFileName()` is S17's (`30-slices.md` § S17, Watcher): the first
 * slice that needs `WatchedFileName` for real rather than as a
 * type-checking placeholder — `20-contract.md`'s own brand table lists no
 * row for it, the same gap `repoRelativePath` and friends filled for S5. A
 * watched file is a bare basename directly inside a declaration's inbox
 * root (`10-design.md` § "The directory is the state machine": "only files
 * sitting directly here are considered; subdirectories are left alone"), so
 * the invariant is non-empty, no path separator, and not `.` or `..`.
 */
const WATCHED_FILE_NAME_RULE = 'non-empty basename, no / or \\, not "." or ".."';

export function watchedFileName(value: string): Outcome<WatchedFileName, ValidationFailure> {
  if (value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    return { ok: false, error: fail('WatchedFileName', WATCHED_FILE_NAME_RULE, value) };
  }
  return { ok: true, value: value as WatchedFileName };
}

export function cloneUrl(value: string, allowed: readonly RemoteHost[]): Outcome<CloneUrl, ValidationFailure> {
  const host = cloneUrlHost(value);
  if (host === null) {
    return { ok: false, error: fail('CloneUrl', 'https or scp-style remote', value) };
  }
  const allowedLower = new Set(allowed.map((h) => (h as string).toLowerCase()));
  if (!allowedLower.has(host)) {
    return { ok: false, error: fail('CloneUrl', 'host on the deployment remote-host allowlist', value) };
  }
  return { ok: true, value: value as CloneUrl };
}
