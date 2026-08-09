import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { ClientId, GrantId, IsoUtcTimestamp, McpResourceUri, SaltedHash, SessionId, Subject, TokenId } from '../shared/brands.ts';
import type { BearerToken, HttpsUrl } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { Session } from '../shared/session.ts';
import type { Clock } from '../clock/clock.ts';
import type { Declaration } from '../declarations/types.ts';
import type { ContractCapabilitySet, CapabilityName, Scope, OperatorScope } from '../contract/capabilities.ts';
import { storeError } from '../store/errors.ts';
import { timingSafeStringEqual } from '../shared/timing-safe.ts';
import { authorizationError, type AuthorizationError } from './errors.ts';
import type { ClientRegistrationRequest, Grant, GrantKind, GrantView, IssuedToken, OAuthClient, RefreshedTokens } from './types.ts';

export interface Authorization {
  registerClient(request: ClientRegistrationRequest): Promise<Outcome<OAuthClient, AuthorizationError>>;
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
  runRetention(): Promise<{ readonly module: string; readonly deletedRows: number; readonly freedBytes: number; readonly skipped: readonly string[] }>;
}

export interface AuthorizationDependencies {
  readonly volumeRoot: string;
  readonly clock: Clock;
  /** Only used to intersect an operator-api token's granted scopes against what the deployment actually registers — never widens past it (invariant A1). */
  readonly contractCapabilitySet: ContractCapabilitySet;
}

/** A year — long enough that a script's credential outlives ordinary use, short enough that an abandoned token does not stay live forever. Not fixed by the contract (`design/90-decisions.md` follows S4's `sessionAbsoluteSeconds` precedent: a number this interface cannot exist without). */
const OPERATOR_API_TOKEN_TTL_SECONDS_DEFAULT = 365 * 24 * 60 * 60;

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
 */
const SCOPE_CAPABILITIES: Readonly<Record<OperatorScope, readonly CapabilityName[]>> = {
  read: ['repo.read', 'host.pr.read', 'host.checks.read', 'audit.read'],
  write: ['git.local.write', 'git.remote.write', 'host.pr.write', 'declaration.manage', 'attention.resolve', 'auth.manage'],
  raw: ['git.raw'],
  schedule: ['scheduler.manage'],
};

function expandScopes(scopes: readonly OperatorScope[], contractCapabilitySet: ContractCapabilitySet): Session['grant'] {
  const granted = new Set<CapabilityName>();
  for (const scope of scopes) {
    for (const capability of SCOPE_CAPABILITIES[scope] ?? []) {
      if ((contractCapabilitySet as unknown as ReadonlySet<CapabilityName>).has(capability)) granted.add(capability);
    }
  }
  return granted as unknown as Session['grant'];
}

const NOT_WIRED = authorizationError(
  { code: 'store-failed', cause: storeError({ code: 'io-failed' }, 'MCP session establishment is not wired until S14') },
  'MCP session establishment is not wired until S14',
);

export function createAuthorization(deps: AuthorizationDependencies): Authorization {
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

    async establishMcpSession(): Promise<Outcome<Session, AuthorizationError>> {
      return err(NOT_WIRED);
    },

    async refresh(): Promise<Outcome<RefreshedTokens, AuthorizationError>> {
      return err(NOT_WIRED);
    },

    async issueOperatorApiToken(subject: Subject, scopes: readonly OperatorScope[], actor: ActorRef): Promise<Outcome<IssuedToken, AuthorizationError>> {
      const now = deps.clock.now();
      const grantId = randomUUID() as GrantId;
      const jti = randomUUID() as TokenId;
      const rawValue = randomBytes(32).toString('hex') as BearerToken;
      const verifierHash = sha256Digest(rawValue) as SaltedHash;
      const expiresAt = new Date(new Date(now).getTime() + OPERATOR_API_TOKEN_TTL_SECONDS_DEFAULT * 1000).toISOString() as IsoUtcTimestamp;

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
      void actor; // audited by the caller (the console route), same as every other console-issued mutation.
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
      void declaration;
      // No declaration dimension reaches an operator-api or operator session
      // (`repositoryBinding` is null for both), so there is nothing to
      // narrow against here — the four-layer intersection this exists to
      // perform is exercised by S14's MCP sessions instead. Total and a
      // no-op, which trivially satisfies invariant A2 (a no-op recomputation
      // is its own subset).
      return ok(session);
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
      const result = withDb(deps.volumeRoot, (db) => {
        const rows = (kind ? db.prepare('SELECT * FROM "grant" WHERE kind = ? ORDER BY created_at ASC').all(kind) : db.prepare('SELECT * FROM "grant" ORDER BY created_at ASC').all()) as unknown as GrantRow[];
        return rows.map((row): GrantView => {
          const grant = toGrant(row);
          const clientRow = grant.clientId ? (db.prepare('SELECT * FROM oauth_client WHERE client_id = ?').get(grant.clientId) as ClientRow | undefined) : undefined;
          const activeTokens = (db.prepare('SELECT COUNT(*) AS n FROM token WHERE grant_id = ? AND revoked_at IS NULL').get(row.grant_id) as { n: number }).n;
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
      void actor;
      const now = deps.clock.now();
      return withDb(deps.volumeRoot, (db) => {
        const info = db.prepare('UPDATE oauth_client SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL').run(now, clientId);
        if (info.changes === 0) {
          const existing = db.prepare('SELECT client_id FROM oauth_client WHERE client_id = ?').get(clientId);
          if (!existing) throw authorizationError({ code: 'token-unknown' }, `no such client '${clientId}'`);
          // Already revoked — revocation is idempotent, not an error.
        }
      });
    },

    async revokeGrant(grantId: GrantId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>> {
      void actor;
      const now = deps.clock.now();
      return withDb(deps.volumeRoot, (db) => {
        const info = db.prepare('UPDATE "grant" SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(now, grantId);
        if (info.changes === 0) {
          const existing = db.prepare('SELECT grant_id FROM "grant" WHERE grant_id = ?').get(grantId);
          if (!existing) throw authorizationError({ code: 'token-unknown' }, `no such grant '${grantId}'`);
        }
      });
    },

    async revokeToken(jti: TokenId, actor: ActorRef): Promise<Outcome<void, AuthorizationError>> {
      void actor;
      const now = deps.clock.now();
      return withDb(deps.volumeRoot, (db) => {
        const info = db.prepare('UPDATE token SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL').run(now, jti);
        if (info.changes === 0) {
          const existing = db.prepare('SELECT jti FROM token WHERE jti = ?').get(jti);
          if (!existing) throw authorizationError({ code: 'token-unknown' }, `no such token '${jti}'`);
        }
      });
    },

    async runRetention() {
      // S17 owns retention, the same as every other module's stub today
      // (`journal.ts`'s own `runRetention`) — nothing prunes yet.
      return { module: 'authorization', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },
  };
}
