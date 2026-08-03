/**
 * S4 — Operator identity
 *
 * Provisioning, local login (password + enforced TOTP), recovery codes,
 * break-glass, sessions, retention.  OIDC (S18) stubs are present but
 * always return `oidc-unavailable`.
 *
 * The module holds its own `DatabaseSync` connection to the structured store,
 * following the same pattern as `Audit` — it must stay operational while the
 * main store connection undergoes migration.
 *
 * File layout under `volumeRoot` (the data volume):
 *   provisioning.secret  — one line: the provisioning secret; burned at enrolment
 *   break-glass.token    — one line: a single-use token; consumed at login
 *
 * TOTP sealing key is at `totpKeyPath` (in the credential mount, never on
 * the data volume).  The path is passed in as a dependency so the caller
 * controls the mount location.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock/clock.ts';
import type { IsoUtcTimestamp, SessionId, Subject } from '../shared/brands.ts';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { RetentionReport } from '../shared/retention.ts';
import type { Audit } from '../audit/audit.ts';
import {
  generateTotpSecret,
  readSealingKey,
  sealTotp,
  unsealTotp,
  verifyTotp,
} from './totp.ts';
import type {
  EnrolmentRequest,
  EnrolmentResult,
  LocalLoginRequest,
  OidcRedirect,
  OperatorIdentity,
  OperatorIdentityError,
  OperatorSession,
  ProvisioningState,
} from './types.ts';

// ─── Constants ───────────────────────────────────────────────────────────────

const PROVISIONING_FILE = 'provisioning.secret';
const BREAK_GLASS_FILE = 'break-glass.token';

/** Session idle default: 1 hour. */
const DEFAULT_SESSION_IDLE_SECONDS = 3600;
/** Session absolute default: 12 hours. */
const DEFAULT_SESSION_ABSOLUTE_SECONDS = 43_200;

const RECOVERY_CODE_BYTES = 10; // 80 bits, base64url-encoded → 14 chars
const RECOVERY_CODE_COUNT = 10;

// ─── Error helpers ───────────────────────────────────────────────────────────

function identityErr(
  code: OperatorIdentityError['code'],
  summary: string,
  extra?: Partial<OperatorIdentityError>,
): OperatorIdentityError {
  return {
    resultKind: 'authorization',
    retryable: false,
    summary,
    code,
    ...extra,
  } as unknown as OperatorIdentityError;
}

function storeErr(cause: unknown): OperatorIdentityError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return {
    resultKind: 'infrastructure',
    retryable: false,
    summary: `store error: ${msg}`,
    code: 'store-failed',
    cause: { resultKind: 'infrastructure', retryable: false, summary: msg, code: 'query-failed' },
  } as OperatorIdentityError;
}

// ─── Hashing helpers ─────────────────────────────────────────────────────────

const scryptAsync = promisify(scrypt);

/**
 * scrypt parameters: N=32768, r=8, p=1, keylen=64.
 * A 16-byte random salt is prepended to the hash as `salt$hash`, both
 * hex-encoded. This format is never equal to the plaintext it covers.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
/** 32 MiB — enough headroom for N=16384, r=8, p=1 (requires ~16 MiB). */
const SCRYPT_MAXMEM = 32 * 1024 * 1024;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }) as Buffer;
  return `${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 2) return false;
  const salt = Buffer.from(parts[0]!, 'hex');
  const expected = Buffer.from(parts[1]!, 'hex');
  if (salt.length !== SCRYPT_SALT_BYTES || expected.length !== SCRYPT_KEYLEN) return false;
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }) as Buffer;
  return timingSafeEqual(derived, expected);
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function timingSafeEqual64(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ─── Recovery code generation ────────────────────────────────────────────────

function generateRecoveryCodes(): readonly string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    codes.push(randomBytes(RECOVERY_CODE_BYTES).toString('base64url'));
  }
  return codes;
}

// ─── DB row types ─────────────────────────────────────────────────────────────

interface CredentialRow {
  singleton: number;
  subject: string;
  password_hash: string;
  totp_secret_sealed: string;
  totp_reenrol_required: number;
  enrolled_at: string;
}

interface RecoveryCodeRow {
  code_hash: string;
  issued_at: string;
  used_at: string | null;
}

interface SessionRow {
  id: string;
  subject: string;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
}

function rowToSession(row: SessionRow): OperatorSession {
  return {
    id: row.id as SessionId,
    subject: row.subject as Subject,
    createdAt: row.created_at as IsoUtcTimestamp,
    lastSeenAt: row.last_seen_at as IsoUtcTimestamp,
    idleExpiresAt: row.idle_expires_at as IsoUtcTimestamp,
    absoluteExpiresAt: row.absolute_expires_at as IsoUtcTimestamp,
    revokedAt: row.revoked_at ? (row.revoked_at as IsoUtcTimestamp) : null,
  };
}

// ─── Session ID ───────────────────────────────────────────────────────────────

function newSessionId(): SessionId {
  return randomBytes(24).toString('base64url') as SessionId;
}

// ─── Public factory ───────────────────────────────────────────────────────────

export interface OperatorIdentityOptions {
  readonly volumeRoot: string;
  /** Path to the 32-byte TOTP sealing key, in the credential mount. */
  readonly totpKeyPath: string;
  readonly clock: Clock;
  readonly audit: Audit;
  readonly sessionIdleSeconds?: number;
  readonly sessionAbsoluteSeconds?: number;
}

export function createOperatorIdentity(options: OperatorIdentityOptions): OperatorIdentity {
  const {
    volumeRoot,
    totpKeyPath,
    clock,
    audit,
    sessionIdleSeconds = DEFAULT_SESSION_IDLE_SECONDS,
    sessionAbsoluteSeconds = DEFAULT_SESSION_ABSOLUTE_SECONDS,
  } = options;

  const dbPath = path.join(volumeRoot, 'store.sqlite');
  const provisioningFilePath = path.join(volumeRoot, PROVISIONING_FILE);
  const breakGlassFilePath = path.join(volumeRoot, BREAK_GLASS_FILE);

  let db: DatabaseSync | null = null;

  function getDb(): DatabaseSync {
    if (!db) db = new DatabaseSync(dbPath);
    return db;
  }

  function readCredential(): CredentialRow | null {
    const rows = getDb()
      .prepare('SELECT * FROM operator_credential WHERE singleton = 1')
      .all() as CredentialRow[];
    return rows[0] ?? null;
  }

  function readProvisioningSecret(): string | null {
    if (!existsSync(provisioningFilePath)) return null;
    try {
      return readFileSync(provisioningFilePath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  function readBreakGlassToken(): string | null {
    if (!existsSync(breakGlassFilePath)) return null;
    try {
      return readFileSync(breakGlassFilePath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /** Atomically replace the break-glass file with a consumed marker by deleting it. */
  function consumeBreakGlass(): void {
    try {
      unlinkSync(breakGlassFilePath);
    } catch {
      // best-effort; a second use will fail `break-glass-invalid` anyway
    }
  }

  function burnProvisioningFile(): void {
    // Write a zero-byte file over it, then unlink — best-effort on platforms
    // where unlink of an open file fails.
    try {
      const tmp = provisioningFilePath + '.tmp';
      writeFileSync(tmp, '');
      renameSync(tmp, provisioningFilePath);
      unlinkSync(provisioningFilePath);
    } catch {
      // If we cannot delete it, a second enrolment attempt will hit
      // already-provisioned because the credential row already exists.
    }
  }

  function computeSessionExpiry(now: Date): { idle: string; absolute: string } {
    const idle = new Date(now.getTime() + sessionIdleSeconds * 1000).toISOString();
    const absolute = new Date(now.getTime() + sessionAbsoluteSeconds * 1000).toISOString();
    return { idle, absolute };
  }

  function createSession(subject: string): OperatorSession {
    const now = new Date(clock.now());
    const { idle, absolute } = computeSessionExpiry(now);
    const id = newSessionId();
    const nowStr = now.toISOString();
    getDb()
      .prepare(
        `INSERT INTO operator_session
           (id, subject, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, subject, nowStr, nowStr, idle, absolute);
    return rowToSession({
      id,
      subject,
      created_at: nowStr,
      last_seen_at: nowStr,
      idle_expires_at: idle,
      absolute_expires_at: absolute,
      revoked_at: null,
    });
  }

  const impl: OperatorIdentity = {
    async provisioningState(): Promise<ProvisioningState> {
      try {
        const row = readCredential();
        return row ? 'complete' : 'pending';
      } catch {
        return 'pending';
      }
    },

    async enrol(
      request: EnrolmentRequest,
    ): Promise<Outcome<EnrolmentResult, OperatorIdentityError>> {
      try {
        const existing = readCredential();
        if (existing) {
          return err(identityErr('already-provisioned', 'operator credential already exists'));
        }

        const fileSecret = readProvisioningSecret();
        if (fileSecret === null) {
          return err(
            identityErr(
              'provisioning-secret-invalid',
              'provisioning file absent or unreadable',
            ),
          );
        }

        // Timing-safe comparison against the provisioning secret
        const fileHash = sha256Hex(fileSecret);
        const reqHash = sha256Hex(request.provisioningSecret);
        if (!timingSafeEqual64(fileHash, reqHash)) {
          return err(
            identityErr('provisioning-secret-invalid', 'provisioning secret does not match'),
          );
        }

        const passwordHash = await hashPassword(request.password);
        const { raw: totpRaw, base32: totpBase32 } = generateTotpSecret();
        const sealingKey = readSealingKey(totpKeyPath);

        // The key is required for sealing; if absent we cannot enrol.
        if (!sealingKey) {
          return err(
            identityErr(
              'totp-key-unavailable',
              `TOTP sealing key absent or wrong length at ${totpKeyPath}`,
            ),
          );
        }

        const totpSealed = sealTotp(totpRaw, sealingKey);
        const recoveryCodes = generateRecoveryCodes();
        const now = clock.now();

        const database = getDb();
        database.exec('BEGIN EXCLUSIVE');
        try {
          // Insert credential
          database
            .prepare(
              `INSERT INTO operator_credential
                 (singleton, subject, password_hash, totp_secret_sealed, totp_reenrol_required, enrolled_at)
               VALUES (1, ?, ?, ?, 0, ?)`,
            )
            .run(request.subject as string, passwordHash, totpSealed, now);

          // Insert recovery code hashes
          const insertCode = database.prepare(
            'INSERT INTO operator_recovery_code (code_hash, issued_at, used_at) VALUES (?, ?, NULL)',
          );
          for (const code of recoveryCodes) {
            insertCode.run(sha256Hex(code), now);
          }

          database.exec('COMMIT');
        } catch (e) {
          database.exec('ROLLBACK');
          return err(storeErr(e));
        }

        burnProvisioningFile();

        // Audit the enrolment
        await audit.append({
          at: now,
          operationId: null,
          declarationId: null,
          generation: null,
          tool: null,
          actorRef: {
            kind: 'operator',
            subject: request.subject,
            clientId: null,
            grantId: null,
          },
          context: 'normal',
          form: 'identity-event',
          event: 'enrolment',
        });

        return ok({ totpSecret: totpBase32, recoveryCodes });
      } catch (e) {
        return err(storeErr(e));
      }
    },

    async loginLocal(
      request: LocalLoginRequest,
    ): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      try {
        const credential = readCredential();
        if (!credential) {
          return err(identityErr('not-provisioned', 'no operator credential'));
        }

        const passwordOk = await verifyPassword(request.password, credential.password_hash);
        if (!passwordOk) {
          return err(identityErr('credentials-invalid', 'password incorrect'));
        }

        const sealingKey = readSealingKey(totpKeyPath);
        if (!sealingKey) {
          return err(
            identityErr(
              'totp-key-unavailable',
              `TOTP sealing key absent or wrong length at ${totpKeyPath}`,
            ),
          );
        }

        const totpSecret = unsealTotp(credential.totp_secret_sealed, sealingKey);
        if (!totpSecret) {
          return err(
            identityErr('totp-key-unavailable', 'TOTP secret could not be decrypted'),
          );
        }

        const nowMs = new Date(clock.now()).getTime();
        if (!verifyTotp(totpSecret, request.totpCode, nowMs)) {
          return err(identityErr('totp-invalid', 'TOTP code incorrect'));
        }

        const session = createSession(credential.subject);
        return ok(session);
      } catch (e) {
        return err(storeErr(e));
      }
    },

    async loginWithRecoveryCode(
      subject: Subject,
      password: string,
      code: string,
    ): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      try {
        const credential = readCredential();
        if (!credential) {
          return err(identityErr('not-provisioned', 'no operator credential'));
        }

        const passwordOk = await verifyPassword(password, credential.password_hash);
        if (!passwordOk) {
          return err(identityErr('credentials-invalid', 'password incorrect'));
        }

        const codeHash = sha256Hex(code);
        const rows = getDb()
          .prepare('SELECT * FROM operator_recovery_code WHERE code_hash = ?')
          .all(codeHash) as RecoveryCodeRow[];
        const row = rows[0];

        if (!row) {
          return err(identityErr('recovery-code-invalid', 'recovery code not found'));
        }
        if (row.used_at !== null) {
          return err(identityErr('recovery-code-used', 'recovery code already used'));
        }

        const now = clock.now();

        // Mark code used and force TOTP re-enrolment atomically
        const database = getDb();
        database.exec('BEGIN EXCLUSIVE');
        try {
          database
            .prepare('UPDATE operator_recovery_code SET used_at = ? WHERE code_hash = ?')
            .run(now, codeHash);
          database
            .prepare(
              'UPDATE operator_credential SET totp_reenrol_required = 1 WHERE singleton = 1',
            )
            .run();
          database.exec('COMMIT');
        } catch (e) {
          database.exec('ROLLBACK');
          return err(storeErr(e));
        }

        await audit.append({
          at: now,
          operationId: null,
          declarationId: null,
          generation: null,
          tool: null,
          actorRef: { kind: 'operator', subject, clientId: null, grantId: null },
          context: 'normal',
          form: 'identity-event',
          event: 'recovery-code-used',
        });

        const session = createSession(credential.subject);
        return ok(session);
      } catch (e) {
        return err(storeErr(e));
      }
    },

    async loginWithBreakGlass(
      token: string,
    ): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      try {
        const credential = readCredential();
        if (!credential) {
          return err(identityErr('not-provisioned', 'no operator credential'));
        }

        const fileToken = readBreakGlassToken();
        if (fileToken === null) {
          return err(identityErr('break-glass-invalid', 'break-glass file absent'));
        }

        const fileHash = sha256Hex(fileToken);
        const reqHash = sha256Hex(token);
        if (!timingSafeEqual64(fileHash, reqHash)) {
          return err(identityErr('break-glass-invalid', 'break-glass token does not match'));
        }

        consumeBreakGlass();

        const now = clock.now();
        await audit.append({
          at: now,
          operationId: null,
          declarationId: null,
          generation: null,
          tool: null,
          actorRef: {
            kind: 'operator',
            subject: credential.subject as Subject,
            clientId: null,
            grantId: null,
          },
          context: 'hatch',
          form: 'identity-event',
          event: 'break-glass-used',
        });

        const session = createSession(credential.subject);
        return ok(session);
      } catch (e) {
        return err(storeErr(e));
      }
    },

    async beginOidc(): Promise<Outcome<OidcRedirect, OperatorIdentityError>> {
      return err({
        resultKind: 'authorization',
        retryable: false,
        summary: 'OIDC is not configured (S18)',
        code: 'oidc-unavailable',
        reason: 'discovery',
      } as OperatorIdentityError);
    },

    async completeOidc(
      _code: string,
      _state: string,
    ): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      return err({
        resultKind: 'authorization',
        retryable: false,
        summary: 'OIDC is not configured (S18)',
        code: 'oidc-unavailable',
        reason: 'discovery',
      } as OperatorIdentityError);
    },

    async touch(
      sessionId: SessionId,
    ): Promise<Outcome<OperatorSession, OperatorIdentityError>> {
      try {
        const rows = getDb()
          .prepare('SELECT * FROM operator_session WHERE id = ?')
          .all(sessionId as string) as SessionRow[];
        const row = rows[0];

        if (!row) return err(identityErr('session-unknown', 'session not found'));
        if (row.revoked_at !== null) return err(identityErr('session-revoked', 'session revoked'));

        const now = clock.now();
        const nowDate = new Date(now);
        if (nowDate > new Date(row.absolute_expires_at)) {
          return err(identityErr('session-expired', 'session absolutely expired'));
        }
        if (nowDate > new Date(row.idle_expires_at)) {
          return err(identityErr('session-expired', 'session idle-expired'));
        }

        const newIdle = new Date(nowDate.getTime() + sessionIdleSeconds * 1000).toISOString();
        getDb()
          .prepare(
            'UPDATE operator_session SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?',
          )
          .run(now, newIdle, sessionId as string);

        return ok(
          rowToSession({ ...row, last_seen_at: now, idle_expires_at: newIdle }),
        );
      } catch (e) {
        return err(storeErr(e));
      }
    },

    async logout(sessionId: SessionId): Promise<Outcome<void, OperatorIdentityError>> {
      try {
        const rows = getDb()
          .prepare('SELECT * FROM operator_session WHERE id = ?')
          .all(sessionId as string) as SessionRow[];
        const row = rows[0];
        if (!row) return err(identityErr('session-unknown', 'session not found'));

        const now = clock.now();
        getDb()
          .prepare('UPDATE operator_session SET revoked_at = ? WHERE id = ?')
          .run(now, sessionId as string);

        await audit.append({
          at: now,
          operationId: null,
          declarationId: null,
          generation: null,
          tool: null,
          actorRef: {
            kind: 'operator',
            subject: row.subject as Subject,
            clientId: null,
            grantId: null,
          },
          context: 'normal',
          form: 'identity-event',
          event: 'session-revoked',
        });

        return ok(undefined);
      } catch (e) {
        return err(storeErr(e));
      }
    },

    async revokeSession(
      sessionId: SessionId,
      actorSubject: Subject,
    ): Promise<Outcome<void, OperatorIdentityError>> {
      try {
        const rows = getDb()
          .prepare('SELECT * FROM operator_session WHERE id = ?')
          .all(sessionId as string) as SessionRow[];
        const row = rows[0];
        if (!row) return err(identityErr('session-unknown', 'session not found'));

        const now = clock.now();
        getDb()
          .prepare('UPDATE operator_session SET revoked_at = ? WHERE id = ?')
          .run(now, sessionId as string);

        await audit.append({
          at: now,
          operationId: null,
          declarationId: null,
          generation: null,
          tool: null,
          actorRef: { kind: 'operator', subject: actorSubject, clientId: null, grantId: null },
          context: 'normal',
          form: 'identity-event',
          event: 'session-revoked',
        });

        return ok(undefined);
      } catch (e) {
        return err(storeErr(e));
      }
    },

    async listSessions(): Promise<readonly OperatorSession[]> {
      try {
        const rows = getDb()
          .prepare('SELECT * FROM operator_session ORDER BY created_at DESC')
          .all() as SessionRow[];
        return rows.map(rowToSession);
      } catch {
        return [];
      }
    },

    async runRetention(): Promise<RetentionReport> {
      try {
        // Expire sessions past their absolute deadline
        const now = clock.now();
        const result = getDb()
          .prepare(
            `DELETE FROM operator_session
             WHERE absolute_expires_at < ? AND revoked_at IS NULL`,
          )
          .run(now);
        return {
          module: 'operator-identity',
          deletedRows: result.changes ?? 0,
          freedBytes: 0,
          skipped: [],
        };
      } catch {
        return { module: 'operator-identity', deletedRows: 0, freedBytes: 0, skipped: [] };
      }
    },
  };

  return impl;
}
