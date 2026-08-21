import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { ClientId, DeclarationId, Generation, GrantId, IsoUtcTimestamp, McpResourceUri, SaltedHash, SessionId, Subject, TokenId } from '../shared/brands.ts';
import type { BearerToken, HttpsUrl } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { Session } from '../shared/session.ts';
import type { Clock } from '../clock/clock.ts';
import { appendIdentityEvent, type Audit } from '../audit/audit.ts';
import type { IdentityEvent } from '../audit/types.ts';
import type { Declarations } from '../declarations/declarations.ts';
import { MCP_PROFILE, type Declaration } from '../declarations/types.ts';
import type { ContractCapabilitySet, DeploymentCeiling, CapabilityName, McpScope, Scope, OperatorScope } from '../contract/capabilities.ts';
import type { StoreTransaction } from '../store/structured-store.ts';
import { storeError } from '../store/errors.ts';
import { retentionCutoff, toRetentionReport, type RetentionReport } from '../shared/retention.ts';
import { timingSafeStringEqual } from '../shared/timing-safe.ts';
import { authorizationError, type AuthorizationError } from './errors.ts';
import type { ClientRegistrationRequest, Grant, GrantKind, GrantView, IssuedMcpGrant, IssuedToken, McpGrantInput, OAuthClient, RefreshedTokens } from './types.ts';

export interface Authorization {
  registerClient(request: ClientRegistrationRequest): Promise<Outcome<OAuthClient, AuthorizationError>>;
  /** The registered client named by `clientId`, or `null` if no such client exists. `handleAuthorize` needs this to check a presented `redirect_uri` against what the client actually registered — the same row `registerClient` wrote. */
  getClient(clientId: ClientId): Promise<OAuthClient | null>;
  issueMcpGrant(input: McpGrantInput, actor: ActorRef): Promise<Outcome<IssuedMcpGrant, AuthorizationError>>;
  establishMcpSession(bearer: BearerToken, resource: McpResourceUri): Promise<Outcome<Session, AuthorizationError>>;
  verifyOperatorApiToken(bearer: BearerToken): Promise<Outcome<Session, AuthorizationError>>;
  issueOperatorApiToken(subject: Subject, scopes: readonly OperatorScope[], actor: ActorRef): Promise<Outcome<IssuedToken, AuthorizationError>>;
  refresh(bearer: BearerToken): Promise<Outcome<RefreshedTokens, AuthorizationError>>;

  recomputeSessionGrant(session: Session, declaration: Declaration | null): Outcome<Session, AuthorizationError>;
  grantIsLive(grantId: GrantId): Promise<boolean>;

  listGrants(kind: GrantKind | null): Promise<readonly GrantView[]>;
  revokeClient(clientId: ClientId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>>;
  revokeGrant(grantId: GrantId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>>;
  revokeToken(jti: TokenId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>>;
  revokeGrantsForResource(declarationId: DeclarationId, generation: Generation, tx: StoreTransaction): readonly GrantId[];
  revokeBearerToken(bearer: BearerToken, actor: ActorRef): Promise<Outcome<void, AuthorizationError>>;
  runRetention(): Promise<RetentionReport>;
}

export interface AuthorizationDependencies {
  readonly volumeRoot: string;
  readonly clock: Clock;
  /** Only used to intersect a token's granted scopes against what the deployment actually registers — never widens past it (invariant A1). */
  readonly contractCapabilitySet: ContractCapabilitySet;
  /** The deployment ceiling (layer 2), needed to compute an MCP session's real effective grant the same way `Declarations.effectiveGrant` does for every other layer-4 caller. */
  readonly ceiling: DeploymentCeiling;
  /** Declaration lookups and the shared four-layer intersection — `establishMcpSession` and `recomputeSessionGrant` both need it, and duplicating `effectiveGrant`'s logic here would be the second copy `git/primitives.ts` already exists to warn against. */
  readonly declarations: Pick<Declarations, 'get' | 'effectiveGrant' | 'effectiveWritablePrefixes'>;
  /**
   * Issuing and revoking a durable credential are audited here rather than at
   * the console route, because the store write is what actually happened —
   * a route that recorded its own intent would log a revocation the store
   * then failed to perform. Append-only, and only on the success path.
   */
  readonly audit: Pick<Audit, 'append'>;
  /** `RetentionWindows.tokenDays` (`20-contract.md` § Deployment configuration, default 7). Local, overridable default — no `DeploymentConfig` is wired yet. */
  readonly tokenDays?: number;
  /** `RetentionWindows.revokedGrantDays` (default 180). Same reasoning as `tokenDays`. */
  readonly revokedGrantDays?: number;
  /** `DeploymentConfig.tokens.mcpAccessSeconds` (`20-contract.md` § Deployment configuration, default 3600). */
  readonly mcpAccessTokenTtlSeconds?: number;
  /** `DeploymentConfig.tokens.mcpRefreshSeconds` (default 2592000, 30 days). */
  readonly mcpRefreshTokenTtlSeconds?: number;
  /** `DeploymentConfig.tokens.operatorApiSeconds` (default 31536000, 365 days). */
  readonly operatorApiTokenTtlSeconds?: number;
}

/**
 * A year — long enough that a script's credential outlives ordinary use,
 * short enough that an abandoned token does not stay live forever.
 * `DeploymentConfig.tokens.operatorApiSeconds` (`20-contract.md` § Deployment
 * configuration) — deployment-overridable since the 2026-08-13 post-S27
 * reconciliation; this is only the documented default.
 */
export const OPERATOR_API_TOKEN_TTL_SECONDS_DEFAULT = 365 * 24 * 60 * 60;

/**
 * An hour and thirty days — the same pair `SubZeroDev.Blog/tools/blog-mcp`'s
 * `OAuthService` uses. Short-lived access tokens limit what a leaked one is
 * worth; the refresh token is what carries S14.7's "reconnects after a
 * container restart without re-authorising" — durable, unlike blog-mcp's
 * process-local version, because it is a real row in `token` rather than an
 * in-memory `Map`. `DeploymentConfig.tokens.mcpAccessSeconds` /
 * `.mcpRefreshSeconds` — deployment-overridable defaults, same as the operator
 * token TTL above.
 *
 * All three are exported because the composition root resolves the same three
 * lifetimes from the environment and needs a fallback for each. It wrote the
 * literals out a second time until the review of PR #112: the `??` fallbacks
 * below are dead once `server.ts` always passes a value, so the second copy
 * was the one actually governing production, and shortening a lifetime here —
 * a security-relevant edit — would have left the deployment minting the old
 * one with every test still green.
 */
export const MCP_ACCESS_TOKEN_TTL_SECONDS_DEFAULT = 60 * 60;
export const MCP_REFRESH_TOKEN_TTL_SECONDS_DEFAULT = 30 * 24 * 60 * 60;

const TOKEN_RETENTION_DAYS_DEFAULT = 7;
const REVOKED_GRANT_RETENTION_DAYS_DEFAULT = 180;

interface ClientRow {
  readonly client_id: string;
  readonly redirect_uris: string;
  readonly registered_at: string;
  readonly revoked_at: string | null;
}

interface GrantRow {
  readonly grant_id: string;
  readonly kind: string;
  readonly client_id: string | null;
  readonly subject: string;
  readonly resource: string | null;
  readonly declaration_id: string | null;
  readonly generation: number | null;
  readonly scopes: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

interface TokenRow {
  readonly jti: string;
  readonly grant_id: string;
  readonly kind: string;
  readonly verifier_hash: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

function toClient(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id as ClientId,
    redirectUris: JSON.parse(row.redirect_uris) as readonly HttpsUrl[],
    registeredAt: row.registered_at as IsoUtcTimestamp,
    revokedAt: row.revoked_at as IsoUtcTimestamp | null,
  };
}

function toGrant(row: GrantRow): Grant {
  return {
    grantId: row.grant_id as GrantId,
    kind: row.kind as GrantKind,
    clientId: row.client_id as ClientId | null,
    subject: row.subject as Subject,
    resource: row.resource as never,
    declarationId: row.declaration_id as never,
    generation: row.generation as never,
    scopes: JSON.parse(row.scopes) as readonly Scope[],
    createdAt: row.created_at as IsoUtcTimestamp,
    lastUsedAt: row.last_used_at as IsoUtcTimestamp | null,
    revokedAt: row.revoked_at as IsoUtcTimestamp | null,
  };
}

function sha256Digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Both halves of a token pair, written as two `token` rows under the same grant. Shared by `issueMcpGrant` and `refresh`, since the pair they mint is identical in shape. */
function issueTokenPair(db: DatabaseSync, grantId: string, now: string, accessTtlSeconds: number, refreshTtlSeconds: number): { readonly access: IssuedToken; readonly refresh: IssuedToken } {
  const accessJti = randomUUID() as TokenId;
  const accessValue = randomBytes(32).toString('hex') as BearerToken;
  const accessExpiresAt = new Date(new Date(now).getTime() + accessTtlSeconds * 1000).toISOString() as IsoUtcTimestamp;
  db.prepare('INSERT INTO token (jti, grant_id, kind, verifier_hash, issued_at, expires_at, revoked_at) VALUES (?, ?, \'access\', ?, ?, ?, NULL)').run(
    accessJti,
    grantId,
    sha256Digest(accessValue),
    now,
    accessExpiresAt,
  );

  const refreshJti = randomUUID() as TokenId;
  const refreshValue = randomBytes(32).toString('hex') as BearerToken;
  const refreshExpiresAt = new Date(new Date(now).getTime() + refreshTtlSeconds * 1000).toISOString() as IsoUtcTimestamp;
  db.prepare('INSERT INTO token (jti, grant_id, kind, verifier_hash, issued_at, expires_at, revoked_at) VALUES (?, ?, \'refresh\', ?, ?, ?, NULL)').run(
    refreshJti,
    grantId,
    sha256Digest(refreshValue),
    now,
    refreshExpiresAt,
  );

  return {
    access: { jti: accessJti, value: accessValue, expiresAt: accessExpiresAt },
    refresh: { jti: refreshJti, value: refreshValue, expiresAt: refreshExpiresAt },
  };
}

function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): Outcome<T, AuthorizationError> {
  let db: DatabaseSync;
  try {
    mkdirSync(volumeRoot, { recursive: true });
    db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(authorizationError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, message) }, `could not open the structured store: ${message}`));
  }
  try {
    return ok(fn(db));
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'resultKind' in cause && 'code' in cause) {
      return err(cause as AuthorizationError);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(authorizationError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, message) }, message));
  } finally {
    db.close();
  }
}

/**
 * Every `McpScope` value expands to a fixed, hand-picked capability subset,
 * intersected against `contractCapabilitySet` so a token can never carry a
 * capability this deployment did not register (invariant A1). Provisional:
 * the real per-scope mapping belongs wherever S14 builds MCP session
 * establishment's own scope expansion, and this local copy exists only
 * because `verifyOperatorApiToken` needs *some* honest, non-decorative
 * answer now — a token issued with only `read` must not carry `git.raw`.
 * `design/90-decisions.md`, 2026-08-09.
 *
 * Declaration-scoped capabilities only. The four instance-level ones —
 * `declaration.manage`, `auth.manage`, `audit.read`, `attention.resolve` —
 * appear in no scope, because `20-contract.md` § Scopes says of them "no
 * `OperatorScope` value names them, and no operator-api token can exercise
 * them", and the 2026-08-09 decision rejected the superset reading by name.
 * Adding one here is how that decision gets reversed by accident.
 */
const SCOPE_CAPABILITIES: Readonly<Record<OperatorScope, readonly CapabilityName[]>> = {
  read: ['repo.read', 'host.pr.read', 'host.checks.read'],
  write: ['git.local.write', 'git.remote.write', 'host.pr.write'],
  raw: ['git.raw'],
  schedule: ['scheduler.manage', 'scheduler.read'],
};

/**
 * Exported so `src/contract/tool-parity.ts` (S36) can compute the widest grant
 * an `mcp` session can actually hold — the same scope-to-capability mapping
 * `establishMcpSession` uses, not a second copy of it that could drift.
 */
export function expandScopes(scopes: readonly OperatorScope[], contractCapabilitySet: ContractCapabilitySet): Session['grant'] {
  const granted = new Set<CapabilityName>();
  for (const scope of scopes) {
    for (const capability of SCOPE_CAPABILITIES[scope] ?? []) {
      if ((contractCapabilitySet as unknown as ReadonlySet<CapabilityName>).has(capability)) granted.add(capability);
    }
  }
  return granted as unknown as Session['grant'];
}

export function createAuthorization(deps: AuthorizationDependencies): Authorization {
  const tokenDays = deps.tokenDays ?? TOKEN_RETENTION_DAYS_DEFAULT;
  const revokedGrantDays = deps.revokedGrantDays ?? REVOKED_GRANT_RETENTION_DAYS_DEFAULT;
  const mcpAccessTokenTtlSeconds = deps.mcpAccessTokenTtlSeconds ?? MCP_ACCESS_TOKEN_TTL_SECONDS_DEFAULT;
  const mcpRefreshTokenTtlSeconds = deps.mcpRefreshTokenTtlSeconds ?? MCP_REFRESH_TOKEN_TTL_SECONDS_DEFAULT;
  const operatorApiTokenTtlSeconds = deps.operatorApiTokenTtlSeconds ?? OPERATOR_API_TOKEN_TTL_SECONDS_DEFAULT;

  /**
   * One audit line per credential mutation that actually reached the store.
   * `operationId`/`declarationId`/`generation`/`tool` are all null: none of
   * these is a tool call against a repository, which is the same shape
   * `operator-identity.ts` already uses for its own identity events.
   */
  async function auditCredentialEvent(event: IdentityEvent, actor: ActorRef): Promise<void> {
    await appendIdentityEvent(deps.audit, deps.clock, event, actor);
  }

  return {
    async registerClient(request: ClientRegistrationRequest): Promise<Outcome<OAuthClient, AuthorizationError>> {
      const findings: { readonly path: string; readonly rule: string; readonly message: string }[] = request.redirectUris
        .filter((uri) => {
          try {
            return new URL(uri).protocol !== 'https:';
          } catch {
            return true;
          }
        })
        .map((uri) => ({ path: 'redirectUris', rule: 'https-only', message: uri as string }));
      if (request.redirectUris.length === 0) findings.push({ path: 'redirectUris', rule: 'non-empty', message: '' });
      if (findings.length > 0) {
        return err(authorizationError({ code: 'registration-invalid', findings }, 'client registration rejected: redirect URIs must be non-empty and https-only'));
      }

      const clientId = randomUUID() as ClientId;
      const registeredAt = deps.clock.now();
      const result = withDb(deps.volumeRoot, (db) => {
        db.prepare('INSERT INTO oauth_client (client_id, redirect_uris, registered_at, revoked_at) VALUES (?, ?, ?, NULL)').run(
          clientId,
          JSON.stringify(request.redirectUris),
          registeredAt,
        );
        return { clientId, redirectUris: request.redirectUris, registeredAt, revokedAt: null } satisfies OAuthClient;
      });
      return result;
    },

    async getClient(clientId: ClientId): Promise<OAuthClient | null> {
      const result = withDb(deps.volumeRoot, (db) => {
        const row = db.prepare('SELECT * FROM oauth_client WHERE client_id = ?').get(clientId) as ClientRow | undefined;
        return row ? toClient(row) : null;
      });
      return result.ok ? result.value : null;
    },

    /**
     * The one durable write the authorization-code exchange performs
     * (`20-contract.md` § L4 — authorization). Everything ahead of this —
     * the pending authorization, the PKCE challenge, the issued code — is
     * surface-owned and ephemeral; by the time a caller reaches here, PKCE
     * verification, the redirect URI and the client have already been
     * checked, so this method's only job is minting the durable `Grant` and
     * its access/refresh pair.
     */
    async issueMcpGrant(input: McpGrantInput, actor: ActorRef): Promise<Outcome<IssuedMcpGrant, AuthorizationError>> {
      const now = deps.clock.now();
      const grantId = randomUUID() as GrantId;

      const result = withDb(deps.volumeRoot, (db) => {
        db.prepare(
          `INSERT INTO "grant" (grant_id, kind, client_id, subject, resource, declaration_id, generation, scopes, created_at, last_used_at, revoked_at)
           VALUES (?, 'mcp', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        ).run(grantId, input.clientId, input.subject, input.resource, input.declarationId, input.generation, JSON.stringify(input.scopes), now);
        const pair = issueTokenPair(db, grantId, now, mcpAccessTokenTtlSeconds, mcpRefreshTokenTtlSeconds);
        const grantRow = db.prepare('SELECT * FROM "grant" WHERE grant_id = ?').get(grantId) as unknown as GrantRow;
        return { grant: toGrant(grantRow), access: pair.access, refresh: pair.refresh } satisfies IssuedMcpGrant;
      });
      if (result.ok) await auditCredentialEvent('token-issued', actor);
      return result;
    },

    /**
     * `20-contract.md` § control flow step 2: issuer, signature (the
     * lookup itself, since a hash match *is* the signature check for an
     * opaque token), expiry, audience against the exact resource URI, and —
     * once the token checks out — that the declaration it names still
     * exists, is not orphaned, and is still at the generation the grant was
     * issued against. Every failure here is one of the first nine
     * `AuthorizationError` variants: transport-level `401`, never a
     * `ToolResult`.
     */
    async establishMcpSession(bearer: BearerToken, resource: McpResourceUri): Promise<Outcome<Session, AuthorizationError>> {
      const candidateHash = sha256Digest(bearer);
      const now = deps.clock.now();

      const tokenResult = withDb(deps.volumeRoot, (db) => {
        const tokenRow = db.prepare("SELECT * FROM token WHERE verifier_hash = ? AND kind = 'access'").get(candidateHash) as TokenRow | undefined;
        if (!tokenRow || !timingSafeStringEqual(candidateHash, tokenRow.verifier_hash)) {
          throw authorizationError({ code: 'token-unknown' }, 'no access token matches the presented bearer value');
        }
        if (tokenRow.revoked_at !== null) throw authorizationError({ code: 'token-revoked' }, `token '${tokenRow.jti}' was revoked`);
        if (tokenRow.expires_at <= now) throw authorizationError({ code: 'token-expired' }, `token '${tokenRow.jti}' expired at ${tokenRow.expires_at}`);

        const grantRow = db.prepare('SELECT * FROM "grant" WHERE grant_id = ?').get(tokenRow.grant_id) as unknown as GrantRow | undefined;
        if (!grantRow || grantRow.kind !== 'mcp') {
          throw authorizationError({ code: 'token-unknown' }, 'the token names no live mcp grant');
        }
        if (grantRow.revoked_at !== null) throw authorizationError({ code: 'grant-revoked' }, `grant '${grantRow.grant_id}' was revoked`);
        if (grantRow.client_id !== null) {
          const clientRow = db.prepare('SELECT revoked_at FROM oauth_client WHERE client_id = ?').get(grantRow.client_id) as { revoked_at: string | null } | undefined;
          if (clientRow && clientRow.revoked_at !== null) throw authorizationError({ code: 'client-revoked' }, `client '${grantRow.client_id}' was revoked`);
        }
        if (grantRow.resource !== (resource as unknown as string)) {
          throw authorizationError(
            { code: 'audience-mismatch', expected: grantRow.resource as unknown as McpResourceUri },
            `this token's grant is for resource '${grantRow.resource}', not '${resource}'`,
          );
        }

        db.prepare('UPDATE "grant" SET last_used_at = ? WHERE grant_id = ?').run(now, grantRow.grant_id);
        return grantRow;
      });
      if (!tokenResult.ok) return tokenResult;
      const grantRow = tokenResult.value;

      const declaration = await deps.declarations.get(grantRow.declaration_id as DeclarationId);
      if (!declaration) {
        return err(authorizationError({ code: 'resource-unknown', resource }, `resource '${resource}' names no declaration`));
      }
      if (declaration.state === 'orphaned') {
        return err(authorizationError({ code: 'declaration-orphaned', declarationId: declaration.id }, `declaration '${declaration.id}' is orphaned`));
      }
      if (declaration.generation !== (grantRow.generation as unknown as Generation)) {
        return err(
          authorizationError(
            { code: 'generation-stale', granted: grantRow.generation as unknown as Generation, current: declaration.generation },
            `grant was issued against generation ${grantRow.generation}, declaration is now at ${declaration.generation}`,
          ),
        );
      }

      const scopes = JSON.parse(grantRow.scopes) as readonly McpScope[];
      const expanded = expandScopes(scopes, deps.contractCapabilitySet);
      const effective = deps.declarations.effectiveGrant(deps.contractCapabilitySet, deps.ceiling, declaration, expanded);
      const session: Session = {
        id: randomUUID() as SessionId,
        kind: 'mcp',
        actorRef: { kind: 'mcp', subject: grantRow.subject as Subject, clientId: grantRow.client_id as ClientId | null, grantId: grantRow.grant_id as GrantId },
        repositoryBinding: declaration.id,
        grant: effective as unknown as Session['grant'],
        writablePathPrefixes: deps.declarations.effectiveWritablePrefixes(declaration, MCP_PROFILE),
        frozenAtEpoch: declaration.grantEpoch,
      };
      return ok(session);
    },

    /**
     * RFC 6749 refresh-token rotation: the presented refresh token is
     * single-use, revoked here regardless of whether issuing its
     * replacement succeeds, and a fresh access/refresh pair is minted under
     * the same grant.
     */
    async refresh(bearer: BearerToken): Promise<Outcome<RefreshedTokens, AuthorizationError>> {
      const candidateHash = sha256Digest(bearer);
      const now = deps.clock.now();

      const result = withDb(deps.volumeRoot, (db) => {
        const tokenRow = db.prepare("SELECT * FROM token WHERE verifier_hash = ? AND kind = 'refresh'").get(candidateHash) as TokenRow | undefined;
        if (!tokenRow || !timingSafeStringEqual(candidateHash, tokenRow.verifier_hash)) {
          throw authorizationError({ code: 'token-unknown' }, 'no refresh token matches the presented bearer value');
        }
        if (tokenRow.revoked_at !== null) throw authorizationError({ code: 'token-revoked' }, `token '${tokenRow.jti}' was revoked`);
        if (tokenRow.expires_at <= now) throw authorizationError({ code: 'token-expired' }, `token '${tokenRow.jti}' expired at ${tokenRow.expires_at}`);

        const grantRow = db.prepare('SELECT * FROM "grant" WHERE grant_id = ?').get(tokenRow.grant_id) as unknown as GrantRow | undefined;
        if (!grantRow) throw authorizationError({ code: 'token-unknown' }, 'the refresh token names no grant');
        if (grantRow.revoked_at !== null) throw authorizationError({ code: 'grant-revoked' }, `grant '${grantRow.grant_id}' was revoked`);
        if (grantRow.client_id !== null) {
          const clientRow = db.prepare('SELECT revoked_at FROM oauth_client WHERE client_id = ?').get(grantRow.client_id) as { revoked_at: string | null } | undefined;
          if (clientRow && clientRow.revoked_at !== null) throw authorizationError({ code: 'client-revoked' }, `client '${grantRow.client_id}' was revoked`);
        }

        db.prepare('UPDATE token SET revoked_at = ? WHERE jti = ?').run(now, tokenRow.jti);
        return issueTokenPair(db, grantRow.grant_id, now, mcpAccessTokenTtlSeconds, mcpRefreshTokenTtlSeconds);
      });
      return result;
    },

    async issueOperatorApiToken(subject: Subject, scopes: readonly OperatorScope[], actor: ActorRef): Promise<Outcome<IssuedToken, AuthorizationError>> {
      const now = deps.clock.now();
      const grantId = randomUUID() as GrantId;
      const jti = randomUUID() as TokenId;
      const rawValue = randomBytes(32).toString('hex') as BearerToken;
      const verifierHash = sha256Digest(rawValue) as SaltedHash;
      const expiresAt = new Date(new Date(now).getTime() + operatorApiTokenTtlSeconds * 1000).toISOString() as IsoUtcTimestamp;

      const result = withDb(deps.volumeRoot, (db) => {
        db.prepare(
          `INSERT INTO "grant" (grant_id, kind, client_id, subject, resource, declaration_id, generation, scopes, created_at, last_used_at, revoked_at)
           VALUES (?, 'operator-api', NULL, ?, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
        ).run(grantId, subject, JSON.stringify(scopes), now);
        db.prepare(
          `INSERT INTO token (jti, grant_id, kind, verifier_hash, issued_at, expires_at, revoked_at)
           VALUES (?, ?, 'access', ?, ?, ?, NULL)`,
        ).run(jti, grantId, verifierHash, now, expiresAt);
        return { jti, value: rawValue, expiresAt } satisfies IssuedToken;
      });
      if (result.ok) await auditCredentialEvent('token-issued', actor);
      return result;
    },

    async verifyOperatorApiToken(bearer: BearerToken): Promise<Outcome<Session, AuthorizationError>> {
      const candidateHash = sha256Digest(bearer);
      const now = deps.clock.now();

      const result = withDb(deps.volumeRoot, (db) => {
        const tokenRow = db.prepare('SELECT * FROM token WHERE verifier_hash = ?').get(candidateHash) as TokenRow | undefined;
        // The indexed lookup above narrows to at most one candidate; this is
        // the comparison S13.4 actually requires demonstrated — constant-time
        // by construction (`shared/timing-safe.ts`'s own doc comment names
        // this exact call site), not merely by having used an index.
        if (!tokenRow || !timingSafeStringEqual(candidateHash, tokenRow.verifier_hash)) {
          throw authorizationError({ code: 'token-unknown' }, 'no token matches the presented bearer value');
        }
        if (tokenRow.revoked_at !== null) throw authorizationError({ code: 'token-revoked' }, `token '${tokenRow.jti}' was revoked`);
        if (tokenRow.expires_at <= now) throw authorizationError({ code: 'token-expired' }, `token '${tokenRow.jti}' expired at ${tokenRow.expires_at}`);

        const grantRow = db.prepare('SELECT * FROM "grant" WHERE grant_id = ?').get(tokenRow.grant_id) as unknown as GrantRow | undefined;
        if (!grantRow || grantRow.kind !== 'operator-api') {
          throw authorizationError({ code: 'token-unknown' }, 'the token names no live operator-api grant');
        }
        if (grantRow.revoked_at !== null) throw authorizationError({ code: 'grant-revoked' }, `grant '${grantRow.grant_id}' was revoked`);

        db.prepare('UPDATE "grant" SET last_used_at = ? WHERE grant_id = ?').run(now, grantRow.grant_id);

        const scopes = JSON.parse(grantRow.scopes) as readonly OperatorScope[];
        const session: Session = {
          id: randomUUID() as SessionId,
          kind: 'operator',
          actorRef: { kind: 'operator', subject: grantRow.subject as Subject, clientId: null, grantId: grantRow.grant_id as GrantId },
          repositoryBinding: null,
          grant: expandScopes(scopes, deps.contractCapabilitySet),
          writablePathPrefixes: [],
          frozenAtEpoch: 0 as unknown as Session['frozenAtEpoch'],
        };
        return session;
      });
      return result;
    },

    recomputeSessionGrant(session: Session, declaration: Declaration | null): Outcome<Session, AuthorizationError> {
      if (session.kind !== 'mcp') {
        // No declaration dimension reaches an operator-api or operator
        // session (`repositoryBinding` is null for both) — nothing to
        // narrow against. Total and a no-op, which trivially satisfies
        // invariant A2 (a no-op recomputation is its own subset).
        return ok(session);
      }
      // `effectiveGrant` filters the *existing* session grant against the
      // current contract/ceiling/declaration intersection — it only ever
      // removes a capability the session already carried, never introduces
      // one it did not. That is what makes a narrowed declaration grant
      // reach a live session on its next call (S14.4) while a widened one
      // cannot (S14.5): re-intersecting against a wider `capabilityGrant`
      // still filters the same frozen `session.grant`, so nothing new gets
      // in. `declaration: null` (orphaned/removed mid-session) drops every
      // declaration-scoped capability the same way it does for any other
      // caller of `effectiveGrant`.
      const recomputed = deps.declarations.effectiveGrant(deps.contractCapabilitySet, deps.ceiling, declaration, session.grant);
      return ok({
        ...session,
        grant: recomputed as unknown as Session['grant'],
        frozenAtEpoch: declaration ? declaration.grantEpoch : session.frozenAtEpoch,
      });
    },

    async grantIsLive(grantId: GrantId): Promise<boolean> {
      const result = withDb(deps.volumeRoot, (db) => {
        const grantRow = db.prepare('SELECT * FROM "grant" WHERE grant_id = ?').get(grantId) as unknown as GrantRow | undefined;
        if (!grantRow || grantRow.revoked_at !== null) return false;
        if (grantRow.client_id === null) return true;
        const clientRow = db.prepare('SELECT revoked_at FROM oauth_client WHERE client_id = ?').get(grantRow.client_id) as { revoked_at: string | null } | undefined;
        return !clientRow || clientRow.revoked_at === null;
      });
      return result.ok ? result.value : false;
    },

    async listGrants(kind: GrantKind | null): Promise<readonly GrantView[]> {
      const now = deps.clock.now();
      const result = withDb(deps.volumeRoot, (db) => {
        const rows = (kind ? db.prepare('SELECT * FROM "grant" WHERE kind = ? ORDER BY created_at ASC').all(kind) : db.prepare('SELECT * FROM "grant" ORDER BY created_at ASC').all()) as unknown as GrantRow[];

        // Batched rather than per-row: this view drives the console's own
        // bulk-revocation screen, which reloads it after every single
        // revoke, so a per-row client lookup and token count here turns an
        // N-row revocation session into O(N²) queries.
        const clientIds = Array.from(new Set(rows.map((row) => row.client_id).filter((id): id is string => id !== null)));
        const clientsById = new Map<string, ClientRow>();
        if (clientIds.length > 0) {
          const placeholders = clientIds.map(() => '?').join(', ');
          const clientRows = db.prepare(`SELECT * FROM oauth_client WHERE client_id IN (${placeholders})`).all(...clientIds) as unknown as ClientRow[];
          for (const clientRow of clientRows) clientsById.set(clientRow.client_id, clientRow);
        }

        // "Active" has to mean the same thing the verification path means by
        // it, or the view cannot be used to confirm a revocation took
        // effect: not revoked, not expired, and under a grant that is
        // itself still live. `expires_at` compares lexicographically
        // because every writer of it goes through `Date.toISOString()`.
        const liveGrantIds = rows.filter((row) => row.revoked_at === null).map((row) => row.grant_id);
        const activeTokensByGrantId = new Map<string, number>();
        if (liveGrantIds.length > 0) {
          const placeholders = liveGrantIds.map(() => '?').join(', ');
          const countRows = db
            .prepare(`SELECT grant_id, COUNT(*) AS n FROM token WHERE grant_id IN (${placeholders}) AND revoked_at IS NULL AND expires_at > ? GROUP BY grant_id`)
            .all(...liveGrantIds, now) as unknown as { grant_id: string; n: number }[];
          for (const countRow of countRows) activeTokensByGrantId.set(countRow.grant_id, countRow.n);
        }

        return rows.map((row): GrantView => {
          const grant = toGrant(row);
          const clientRow = grant.clientId ? clientsById.get(grant.clientId) : undefined;
          const activeTokens = row.revoked_at !== null ? 0 : (activeTokensByGrantId.get(row.grant_id) ?? 0);
          return {
            grant,
            client: clientRow ? toClient(clientRow) : null,
            activeTokens,
            // No live-session registry exists yet — MCP sessions are not
            // persisted (`10-design.md` § Data model) and operator-api
            // tokens are verified statelessly per call. Real until S14 gives
            // MCP connections somewhere to be counted from.
            liveSessions: 0,
          };
        });
      });
      return result.ok ? result.value : [];
    },

    async revokeClient(clientId: ClientId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>> {
      const now = deps.clock.now();
      const result = withDb(deps.volumeRoot, (db) => {
        const info = db.prepare('UPDATE oauth_client SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL').run(now, clientId);
        if (info.changes === 0) {
          const existing = db.prepare('SELECT client_id FROM oauth_client WHERE client_id = ?').get(clientId);
          if (!existing) throw authorizationError({ code: 'token-unknown' }, `no such client '${clientId}'`);
          // Already revoked — revocation is idempotent, not an error.
        }
      });
      if (result.ok) await auditCredentialEvent('client-revoked', actor);
      return result;
    },

    async revokeGrant(grantId: GrantId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>> {
      const now = deps.clock.now();
      const result = withDb(deps.volumeRoot, (db) => {
        const info = db.prepare('UPDATE "grant" SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now, grantId);
        if (info.changes === 0) {
          const existing = db.prepare('SELECT grant_id FROM "grant" WHERE grant_id = ?').get(grantId);
          if (!existing) throw authorizationError({ code: 'token-unknown' }, `no such grant '${grantId}'`);
        }
      });
      if (result.ok) await auditCredentialEvent('grant-revoked', actor);
      return result;
    },

    async revokeToken(jti: TokenId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>> {
      const now = deps.clock.now();
      const result = withDb(deps.volumeRoot, (db) => {
        const info = db.prepare('UPDATE token SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL').run(now, jti);
        if (info.changes === 0) {
          const existing = db.prepare('SELECT jti FROM token WHERE jti = ?').get(jti);
          if (!existing) throw authorizationError({ code: 'token-unknown' }, `no such token '${jti}'`);
        }
      });
      if (result.ok) await auditCredentialEvent('token-revoked', actor);
      return result;
    },

    /** `/oauth/revoke` (RFC 7009): resolves the presented opaque value to its `jti` by the same hash lookup `establishMcpSession`/`refresh` use, then revokes it exactly as `revokeToken` would. Unknown or already-revoked is not an error — revocation is idempotent, the same as every other revoke method here. */
    async revokeBearerToken(bearer: BearerToken, actor: ActorRef): Promise<Outcome<void, AuthorizationError>> {
      const candidateHash = sha256Digest(bearer);
      const now = deps.clock.now();
      const result = withDb(deps.volumeRoot, (db) => {
        const tokenRow = db.prepare('SELECT * FROM token WHERE verifier_hash = ?').get(candidateHash) as TokenRow | undefined;
        if (!tokenRow || !timingSafeStringEqual(candidateHash, tokenRow.verifier_hash)) return;
        db.prepare('UPDATE token SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL').run(now, tokenRow.jti);
      });
      if (result.ok) await auditCredentialEvent('token-revoked', actor);
      return result;
    },

    /**
     * `20-contract.md` § L4 — authorization: the one member this module
     * takes a `StoreTransaction` for, writing and reading back inside the
     * caller's own transaction rather than opening its own connection —
     * same shape as `Declarations.bumpGrantEpoch` (issue #50's note on the
     * four `tx`-taking members). No caller wires this in yet; it is correct
     * when one does, the same way `bumpGrantEpoch` was before this slice.
     * Revocation never deletes or writes a token row directly — `grant`
     * revoked is enough for both `establishMcpSession` and `grantIsLive` to
     * treat every token under it as dead, the same cascade
     * `revokeGrant`/`revokeClient` already rely on.
     */
    revokeGrantsForResource(declarationId: DeclarationId, generation: Generation, tx: StoreTransaction): readonly GrantId[] {
      const now = deps.clock.now();
      tx.run('UPDATE "grant" SET revoked_at = ? WHERE declaration_id = ? AND generation = ? AND revoked_at IS NULL', now, declarationId, generation);
      const rows = tx.all('SELECT grant_id FROM "grant" WHERE declaration_id = ? AND generation = ? AND revoked_at = ?', declarationId, generation, now) as { grant_id: string }[];
      return rows.map((row) => row.grant_id as GrantId);
    },

    /**
     * `token_retention` indexes exactly the token predicate. Tokens are
     * deleted first, deliberately: a revoked `grant`/`oauth_client` is only
     * eligible once no `token` row still references it (both are FK parents
     * under `PRAGMA foreign_keys = ON`), and every token this pass would
     * otherwise strand has already expired or been revoked well inside its
     * own 7-day window by the time a grant reaches 180 days revoked — access
     * tokens live an hour, refresh tokens 30 days, both far short of 180.
     */
    async runRetention(): Promise<RetentionReport> {
      const now = deps.clock.now();
      const tokenCutoff = retentionCutoff(now, tokenDays);
      const grantCutoff = retentionCutoff(now, revokedGrantDays);
      // BEGIN/COMMIT around the cascade: without it, a crash between the
      // token delete and the grant/client deletes that depend on it leaves a
      // transient state on disk until the next pass catches up. Cheap to
      // avoid outright since all three statements already run on one
      // connection.
      const result = withDb(deps.volumeRoot, (db) => {
        db.exec('BEGIN;');
        try {
          const tokenChanges = Number(
            db.prepare('DELETE FROM token WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at < ?)').run(tokenCutoff, tokenCutoff).changes,
          );
          const grantChanges = Number(
            db
              .prepare('DELETE FROM "grant" WHERE revoked_at IS NOT NULL AND revoked_at < ? AND NOT EXISTS (SELECT 1 FROM token WHERE token.grant_id = "grant".grant_id)')
              .run(grantCutoff).changes,
          );
          const clientChanges = Number(
            db
              .prepare('DELETE FROM oauth_client WHERE revoked_at IS NOT NULL AND revoked_at < ? AND NOT EXISTS (SELECT 1 FROM "grant" WHERE "grant".client_id = oauth_client.client_id)')
              .run(grantCutoff).changes,
          );
          db.exec('COMMIT;');
          return tokenChanges + grantChanges + clientChanges;
        } catch (cause) {
          try {
            db.exec('ROLLBACK;');
          } catch {
            // Already rolled back by the failure itself.
          }
          throw cause;
        }
      });
      return toRetentionReport('authorization', result.ok ? result : { ok: false, summary: result.error.summary });
    },
  };
}
