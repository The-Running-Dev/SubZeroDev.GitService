import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { HttpsUrl, IsoUtcTimestamp, SessionId, Subject } from '../shared/brands.ts';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import { timingSafeStringEqual } from '../shared/timing-safe.ts';
import type { RetentionReport } from '../shared/retention.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { Clock } from '../clock/clock.ts';
import type { Audit } from '../audit/audit.ts';
import { storeError } from '../store/errors.ts';
import { operatorIdentityError, type OperatorIdentityError } from './errors.ts';
import { base32Encode, generateTotpSecret, sealTotpSecret, unsealTotpSecret, verifyTotpCode } from './totp.ts';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  hashSecret,
  normalizeRecoveryCode,
  verifyRecoveryCode,
  verifySecret,
} from './secrets.ts';

export type ProvisioningState = 'pending' | 'complete';

export interface EnrolmentRequest {
  readonly provisioningSecret: string;
  readonly subject: Subject;
  readonly password: string;
}

export interface EnrolmentResult {
  readonly totpSecret: string;
  readonly recoveryCodes: readonly string[];
}

export interface LocalLoginRequest {
  readonly subject: Subject;
  readonly password: string;
  readonly totpCode: string;
}

export interface OidcRedirect {
  readonly authorizeUrl: HttpsUrl;
  readonly state: string;
}

export interface OperatorSession {
  readonly id: SessionId;
  readonly subject: Subject;
  readonly createdAt: IsoUtcTimestamp;
  readonly lastSeenAt: IsoUtcTimestamp;
  readonly idleExpiresAt: IsoUtcTimestamp;
  readonly absoluteExpiresAt: IsoUtcTimestamp;
  readonly revokedAt: IsoUtcTimestamp | null;
}

export interface OperatorIdentity {
  provisioningState(): Promise<ProvisioningState>;
  enrol(request: EnrolmentRequest): Promise<Outcome<EnrolmentResult, OperatorIdentityError>>;

  loginLocal(request: LocalLoginRequest): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  loginWithRecoveryCode(subject: Subject, password: string, code: string): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  loginWithBreakGlass(token: string): Promise<Outcome<OperatorSession, OperatorIdentityError>>;

  beginOidc(): Promise<Outcome<OidcRedirect, OperatorIdentityError>>;
  completeOidc(code: string, state: string): Promise<Outcome<OperatorSession, OperatorIdentityError>>;

  touch(sessionId: SessionId): Promise<Outcome<OperatorSession, OperatorIdentityError>>;
  logout(sessionId: SessionId): Promise<Outcome<void, OperatorIdentityError>>;
  revokeSession(sessionId: SessionId, actor: ActorRef): Promise<Outcome<void, OperatorIdentityError>>;
  listSessions(): Promise<readonly OperatorSession[]>;
  runRetention(): Promise<RetentionReport>;
}

export const PROVISIONING_FILENAME = 'provisioning.secret';
export const BREAK_GLASS_FILENAME = 'break-glass.token';
/**
 * `_`-prefixed so `CredentialRef`'s own pattern (`^[a-z0-9][a-z0-9._-]{0,63}$`)
 * can never produce it — a declaration cannot name this key by construction,
 * per the 2026-08-04 TOTP-sealing decision.
 */
export const TOTP_SEALING_KEY_FILENAME = '_totp-sealing-key';

export const SESSION_IDLE_SECONDS_DEFAULT = 3600;
export const SESSION_ABSOLUTE_SECONDS_DEFAULT = 43200;

export interface OperatorIdentityDependencies {
  readonly volumeRoot: string;
  readonly credentialMountRoot: string;
  readonly clock: Clock;
  readonly audit: Audit;
  readonly sessionIdleSeconds?: number;
  readonly sessionAbsoluteSeconds?: number;
}

interface CredentialRow {
  readonly subject: string;
  readonly password_hash: string;
  readonly totp_secret_sealed: string;
  readonly totp_reenrol_required: number;
  readonly enrolled_at: string;
}

interface SessionRow {
  readonly id: string;
  readonly subject: string;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly idle_expires_at: string;
  readonly absolute_expires_at: string;
  readonly revoked_at: string | null;
}

function toOperatorSession(row: SessionRow): OperatorSession {
  return {
    id: row.id as SessionId,
    subject: row.subject as Subject,
    createdAt: row.created_at as IsoUtcTimestamp,
    lastSeenAt: row.last_seen_at as IsoUtcTimestamp,
    idleExpiresAt: row.idle_expires_at as IsoUtcTimestamp,
    absoluteExpiresAt: row.absolute_expires_at as IsoUtcTimestamp,
    revokedAt: row.revoked_at as IsoUtcTimestamp | null,
  };
}

function readTrimmedFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

const IDENTITY_ACTOR = (subject: Subject): ActorRef => ({ kind: 'operator', subject, clientId: null, grantId: null });

/**
 * Every method opens and closes its own `DatabaseSync` connection rather than
 * holding one for the module's lifetime the way `Audit` does. `OperatorIdentity`
 * has no `close()` in `20-contract.md` — deliberately not added here, since a
 * contract amendment for a shutdown-hygiene method belongs to the person who
 * signs off the contract, not to whichever slice happens to need one. Login,
 * enrolment and session touches are low-frequency operator actions, not a hot
 * path, so opening a handle per call costs nothing worth avoiding, and it
 * means no handle ever outlives a call for a test runner (or a Windows host)
 * to trip over.
 */
function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): Outcome<T, OperatorIdentityError> {
  mkdirSync(volumeRoot, { recursive: true });
  const dbPath = path.join(volumeRoot, 'store.sqlite');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    return err(operatorIdentityError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, 'could not open the store') }, 'the structured store is unavailable'));
  }
  try {
    return ok(fn(db));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Mirrors `StructuredStore.transaction`'s own classification (S2), so a
    // constraint violation reaching this module carries the same distinct
    // `StoreError` shape rather than collapsing into an opaque `io-failed` —
    // `enrol`'s singleton race reads `constraint-violated` off this to
    // report `already-provisioned` instead of a bare store failure.
    const storeCause = /CHECK constraint|UNIQUE constraint|FOREIGN KEY|NOT NULL constraint/i.test(message)
      ? storeError({ code: 'constraint-violated', constraint: message }, message)
      : storeError({ code: 'io-failed' }, message);
    return err(operatorIdentityError({ code: 'store-failed', cause: storeCause }, message));
  } finally {
    db.close();
  }
}

export function createOperatorIdentity(deps: OperatorIdentityDependencies): OperatorIdentity {
  const { volumeRoot, credentialMountRoot, clock, audit } = deps;
  const sessionIdleSeconds = deps.sessionIdleSeconds ?? SESSION_IDLE_SECONDS_DEFAULT;
  const sessionAbsoluteSeconds = deps.sessionAbsoluteSeconds ?? SESSION_ABSOLUTE_SECONDS_DEFAULT;

  const provisioningFile = path.join(volumeRoot, PROVISIONING_FILENAME);
  const breakGlassFile = path.join(volumeRoot, BREAK_GLASS_FILENAME);
  const totpKeyFile = path.join(credentialMountRoot, TOTP_SEALING_KEY_FILENAME);

  function readTotpSealingKey(): Buffer | null {
    if (!existsSync(totpKeyFile)) return null;
    try {
      const key = readFileSync(totpKeyFile);
      return key.length === 32 ? key : null;
    } catch {
      return null;
    }
  }

  /**
   * Atomically claims the break-glass file before comparing it, so two
   * concurrent requests can never both read-and-match the same token: a
   * filesystem rename either succeeds for exactly one caller or fails for
   * the rest, closing the check-then-delete window a plain read-then-unlink
   * leaves open. A wrong guess renames the file back so it stays usable —
   * consumption only ever happens on a real match, matching the file-burn
   * behaviour `enrol`'s provisioning secret already has.
   */
  function claimBreakGlassToken(token: string): 'match' | 'mismatch' | 'absent' {
    const claimPath = `${breakGlassFile}.claim-${crypto.randomUUID()}`;
    try {
      renameSync(breakGlassFile, claimPath);
    } catch {
      return 'absent';
    }

    let raw: Buffer;
    try {
      raw = readFileSync(claimPath);
    } catch {
      return 'absent';
    }

    const stored = raw.toString('utf8').trim();
    if (stored.length > 0 && timingSafeStringEqual(stored, token)) {
      try {
        unlinkSync(claimPath);
      } catch {
        // Already claimed and matched; a leftover claim file is not a second
        // usable token, since the check above only ever runs once per claim.
      }
      return 'match';
    }

    try {
      renameSync(claimPath, breakGlassFile);
    } catch {
      // The claim can't be restored — the token is lost rather than reused,
      // which is the safe direction for a single-use secret to fail in.
    }
    return 'mismatch';
  }

  function getCredentialRow(db: DatabaseSync): CredentialRow | null {
    const rows = db
      .prepare('SELECT subject, password_hash, totp_secret_sealed, totp_reenrol_required, enrolled_at FROM operator_credential WHERE singleton = 1')
      .all() as unknown as CredentialRow[];
    return rows[0] ?? null;
  }

  function addSeconds(at: IsoUtcTimestamp, seconds: number): IsoUtcTimestamp {
    return new Date(Date.parse(at) + seconds * 1000).toISOString() as IsoUtcTimestamp;
  }

  function createSession(db: DatabaseSync, subject: Subject): OperatorSession {
    const now = clock.now();
    const row: SessionRow = {
      id: crypto.randomUUID(),
      subject,
      created_at: now,
      last_seen_at: now,
      idle_expires_at: addSeconds(now, sessionIdleSeconds),
      absolute_expires_at: addSeconds(now, sessionAbsoluteSeconds),
      revoked_at: null,
    };
    db.prepare(
      'INSERT INTO operator_session (id, subject, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    ).run(row.id, row.subject, row.created_at, row.last_seen_at, row.idle_expires_at, row.absolute_expires_at);
    return toOperatorSession(row);
  }

  function getSessionRow(db: DatabaseSync, sessionId: SessionId): SessionRow | null {
    const rows = db
      .prepare('SELECT id, subject, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at FROM operator_session WHERE id = ?')
      .all(sessionId) as unknown as SessionRow[];
    return rows[0] ?? null;
  }

  function finishLogin(subject: Subject): Outcome<OperatorSession, OperatorIdentityError> {
    return withDb(volumeRoot, (db) => createSession(db, subject));
  }

  return {
    async provisioningState(): Promise<ProvisioningState> {
      const result = withDb(volumeRoot, (db) => getCredentialRow(db) !== null);
      return result.ok && result.value ? 'complete' : 'pending';
    },

    async enrol(request: EnrolmentRequest): Promise<Outcome<EnrolmentResult, OperatorIdentityError>> {
      const existing = withDb(volumeRoot, (db) => getCredentialRow(db));
      if (!existing.ok) return err(existing.error);
      if (existing.value !== null) {
        return err(operatorIdentityError({ code: 'already-provisioned' }, 'an operator identity already exists'));
      }

      const fileSecret = readTrimmedFile(provisioningFile);
      if (fileSecret === null || !timingSafeStringEqual(fileSecret, request.provisioningSecret)) {
        return err(operatorIdentityError({ code: 'provisioning-secret-invalid' }, 'the provisioning secret did not match'));
      }

      const sealingKey = readTotpSealingKey();
      if (!sealingKey) {
        return err(operatorIdentityError({ code: 'totp-key-unavailable' }, 'the TOTP sealing key is absent or unreadable'));
      }

      const totpSecret = generateTotpSecret();
      const sealed = sealTotpSecret(totpSecret, sealingKey);
      const recoveryCodes = generateRecoveryCodes();
      const now = clock.now();

      const written = withDb(volumeRoot, (db) => {
        db.exec('BEGIN;');
        try {
          db.prepare(
            'INSERT INTO operator_credential (singleton, subject, password_hash, totp_secret_sealed, totp_reenrol_required, enrolled_at) VALUES (1, ?, ?, ?, 0, ?)',
          ).run(request.subject, hashSecret(request.password), sealed, now);
          for (const code of recoveryCodes) {
            db.prepare('INSERT INTO operator_recovery_code (code_hash, issued_at, used_at) VALUES (?, ?, NULL)').run(
              hashRecoveryCode(normalizeRecoveryCode(code)),
              now,
            );
          }
          db.exec('COMMIT;');
        } catch (cause) {
          db.exec('ROLLBACK;');
          throw cause;
        }
      });
      if (!written.ok) {
        // Two concurrent enrolments can both pass the `existing` check above
        // and both attempt the insert; only one can win against the
        // `operator_credential` singleton's own primary key. The loser hits
        // a constraint violation, not an arbitrary store failure, and that
        // is exactly the same condition the `existing` check above reports
        // as `already-provisioned` — the race's loser gets the same answer
        // a slightly later caller would have, rather than a bare 503.
        if (written.error.code === 'store-failed' && written.error.cause.code === 'constraint-violated') {
          return err(operatorIdentityError({ code: 'already-provisioned' }, 'an operator identity already exists'));
        }
        return err(written.error);
      }

      // The secret is burned only once the credential is durably written —
      // an operator locked out mid-enrolment by a crash still has the file
      // to retry with, rather than a burnt bootstrap and no operator.
      try {
        unlinkSync(provisioningFile);
      } catch {
        // Already gone, or unremovable — either way the row above is what
        // `already-provisioned` checks from here on, not the file.
      }

      await audit.append({
        at: clock.now(),
        operationId: null,
        declarationId: null,
        generation: null,
        tool: null,
        actorRef: IDENTITY_ACTOR(request.subject),
        context: 'normal',
        form: 'identity-event',
        event: 'enrolment',
      });

      return ok({ totpSecret: base32Encode(totpSecret), recoveryCodes });
    },

    async loginLocal(request: LocalLoginRequest): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      const found = withDb(volumeRoot, (db) => getCredentialRow(db));
      if (!found.ok) return err(found.error);
      const credential = found.value;
      if (!credential) return err(operatorIdentityError({ code: 'not-provisioned' }, 'no operator identity exists yet'));

      if (credential.subject !== request.subject || !verifySecret(request.password, credential.password_hash)) {
        return err(operatorIdentityError({ code: 'credentials-invalid' }, 'subject or password did not match'));
      }

      const sealingKey = readTotpSealingKey();
      if (!sealingKey) {
        return err(operatorIdentityError({ code: 'totp-key-unavailable' }, 'the TOTP sealing key is absent or unreadable'));
      }
      const secret = unsealTotpSecret(credential.totp_secret_sealed, sealingKey);
      if (!secret || !verifyTotpCode(secret, request.totpCode, Date.parse(clock.now()) / 1000)) {
        return err(operatorIdentityError({ code: 'totp-invalid' }, 'the TOTP code did not verify'));
      }

      return finishLogin(request.subject);
    },

    async loginWithRecoveryCode(subject: Subject, password: string, code: string): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      const found = withDb(volumeRoot, (db) => getCredentialRow(db));
      if (!found.ok) return err(found.error);
      const credential = found.value;
      if (!credential) return err(operatorIdentityError({ code: 'not-provisioned' }, 'no operator identity exists yet'));
      if (credential.subject !== subject || !verifySecret(password, credential.password_hash)) {
        return err(operatorIdentityError({ code: 'credentials-invalid' }, 'subject or password did not match'));
      }

      const normalized = normalizeRecoveryCode(code);

      const outcome = withDb(volumeRoot, (db) => {
        const rows = db.prepare('SELECT code_hash, used_at FROM operator_recovery_code').all() as {
          code_hash: string;
          used_at: string | null;
        }[];
        const match = rows.find((row) => verifyRecoveryCode(normalized, row.code_hash));
        if (!match) return { kind: 'invalid' as const };
        if (match.used_at !== null) return { kind: 'used' as const };

        const now = clock.now();
        db.exec('BEGIN;');
        try {
          db.prepare('UPDATE operator_recovery_code SET used_at = ? WHERE code_hash = ?').run(now, match.code_hash);
          db.prepare('UPDATE operator_credential SET totp_reenrol_required = 1 WHERE singleton = 1').run();
          db.exec('COMMIT;');
        } catch (cause) {
          db.exec('ROLLBACK;');
          throw cause;
        }
        return { kind: 'consumed' as const };
      });
      if (!outcome.ok) return err(outcome.error);

      if (outcome.value.kind === 'invalid') {
        return err(operatorIdentityError({ code: 'recovery-code-invalid' }, 'no matching recovery code'));
      }
      if (outcome.value.kind === 'used') {
        return err(operatorIdentityError({ code: 'recovery-code-used' }, 'this recovery code was already used'));
      }

      await audit.append({
        at: clock.now(),
        operationId: null,
        declarationId: null,
        generation: null,
        tool: null,
        actorRef: IDENTITY_ACTOR(subject),
        context: 'normal',
        form: 'identity-event',
        event: 'recovery-code-used',
      });

      return finishLogin(subject);
    },

    async loginWithBreakGlass(token: string): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      const found = withDb(volumeRoot, (db) => getCredentialRow(db));
      if (!found.ok) return err(found.error);
      const credential = found.value;
      if (!credential) return err(operatorIdentityError({ code: 'not-provisioned' }, 'no operator identity exists yet'));

      if (claimBreakGlassToken(token) !== 'match') {
        return err(operatorIdentityError({ code: 'break-glass-invalid' }, 'the break-glass token is absent, stale or already consumed'));
      }

      await audit.append({
        at: clock.now(),
        operationId: null,
        declarationId: null,
        generation: null,
        tool: null,
        actorRef: IDENTITY_ACTOR(credential.subject as Subject),
        context: 'normal',
        form: 'identity-event',
        event: 'break-glass-used',
      });

      return finishLogin(credential.subject as Subject);
    },

    async beginOidc(): Promise<Outcome<OidcRedirect, OperatorIdentityError>> {
      // OIDC federation lands in S18 ("The local path must stand alone,
      // which is the whole reason recovery codes exist" — 30-slices.md § S4
      // Out of scope). Reported at its true empty state rather than invented,
      // the same way boot.ts reports subsystems that do not exist yet.
      return err(operatorIdentityError({ code: 'oidc-unavailable', reason: 'discovery' }, 'OIDC federation is not implemented until S18'));
    },

    async completeOidc(_code: string, _state: string): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      return err(operatorIdentityError({ code: 'oidc-unavailable', reason: 'discovery' }, 'OIDC federation is not implemented until S18'));
    },

    async touch(sessionId: SessionId): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      const now = clock.now();
      const result = withDb(volumeRoot, (db) => {
        const row = getSessionRow(db, sessionId);
        if (!row) return { kind: 'unknown' as const };
        if (row.revoked_at !== null) return { kind: 'revoked' as const };
        if (Date.parse(now) > Date.parse(row.absolute_expires_at) || Date.parse(now) > Date.parse(row.idle_expires_at)) {
          return { kind: 'expired' as const };
        }
        const idleExpiresAt = addSeconds(now, sessionIdleSeconds);
        db.prepare('UPDATE operator_session SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?').run(now, idleExpiresAt, sessionId);
        return {
          kind: 'ok' as const,
          session: toOperatorSession({ ...row, last_seen_at: now, idle_expires_at: idleExpiresAt }),
        };
      });
      if (!result.ok) return err(result.error);
      if (result.value.kind === 'unknown') return err(operatorIdentityError({ code: 'session-unknown' }, 'no such session'));
      if (result.value.kind === 'revoked') return err(operatorIdentityError({ code: 'session-revoked' }, 'this session was revoked'));
      if (result.value.kind === 'expired') return err(operatorIdentityError({ code: 'session-expired' }, 'this session has expired'));
      return ok(result.value.session);
    },

    async logout(sessionId: SessionId): Promise<Outcome<void, OperatorIdentityError>> {
      const now = clock.now();
      const result = withDb(volumeRoot, (db) => {
        const row = getSessionRow(db, sessionId);
        if (!row) return null;
        db.prepare('UPDATE operator_session SET revoked_at = ? WHERE id = ?').run(now, sessionId);
        return row.subject;
      });
      if (!result.ok) return err(result.error);
      if (result.value === null) return err(operatorIdentityError({ code: 'session-unknown' }, 'no such session'));

      await audit.append({
        at: now,
        operationId: null,
        declarationId: null,
        generation: null,
        tool: null,
        actorRef: IDENTITY_ACTOR(result.value as Subject),
        context: 'normal',
        form: 'identity-event',
        event: 'session-revoked',
      });
      return ok(undefined);
    },

    async revokeSession(sessionId: SessionId, actor: ActorRef): Promise<Outcome<void, OperatorIdentityError>> {
      const now = clock.now();
      const result = withDb(volumeRoot, (db) => {
        const row = getSessionRow(db, sessionId);
        if (!row) return null;
        db.prepare('UPDATE operator_session SET revoked_at = ? WHERE id = ?').run(now, sessionId);
        return row;
      });
      if (!result.ok) return err(result.error);
      if (result.value === null) return err(operatorIdentityError({ code: 'session-unknown' }, 'no such session'));

      await audit.append({
        at: now,
        operationId: null,
        declarationId: null,
        generation: null,
        tool: null,
        actorRef: actor,
        context: 'normal',
        form: 'identity-event',
        event: 'session-revoked',
      });
      return ok(undefined);
    },

    async listSessions(): Promise<readonly OperatorSession[]> {
      const result = withDb(volumeRoot, (db) => {
        const rows = db
          .prepare('SELECT id, subject, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at FROM operator_session ORDER BY created_at')
          .all() as unknown as SessionRow[];
        return rows.map(toOperatorSession);
      });
      return result.ok ? result.value : [];
    },

    async runRetention(): Promise<RetentionReport> {
      // S17 owns retention windows and the pass that runs them. Nothing
      // prunes yet, reported honestly rather than implying a pass ran.
      return { module: 'operator-identity', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },
  };
}

// Exported so a deployment script or a test fixture can write a well-formed
// provisioning file or break-glass token without duplicating the format —
// both are plain trimmed text, matching `readTrimmedFile` above.
export function writeProvisioningSecret(volumeRoot: string, secret: string): void {
  mkdirSync(volumeRoot, { recursive: true });
  writeFileSync(path.join(volumeRoot, PROVISIONING_FILENAME), `${secret}\n`, 'utf8');
}

export function writeBreakGlassToken(volumeRoot: string, token: string): void {
  mkdirSync(volumeRoot, { recursive: true });
  writeFileSync(path.join(volumeRoot, BREAK_GLASS_FILENAME), `${token}\n`, 'utf8');
}
