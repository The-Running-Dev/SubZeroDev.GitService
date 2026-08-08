import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { CredentialRef, DeclarationId, EnvVarName, IsoUtcTimestamp, RemoteHost } from '../shared/brands.ts';
import type { Clock } from '../clock/clock.ts';
import type { CredentialBinding, MutableEnv } from '../exec/exec.ts';
import { credentialError, type CredentialError } from './errors.ts';
import type { CredentialFailureMark } from './types.ts';

export interface CredentialResolver {
  resolveInto(ref: CredentialRef, declarationId: DeclarationId, env: MutableEnv): Promise<Outcome<CredentialBinding, CredentialError>>;
  allowedHosts(ref: CredentialRef): Promise<Outcome<readonly RemoteHost[], CredentialError>>;
  markFailing(ref: CredentialRef, declarationId: DeclarationId, reason: string): Promise<void>;
  clearFailing(ref: CredentialRef, declarationId: DeclarationId): Promise<void>;
  listFailing(): Promise<readonly CredentialFailureMark[]>;
}

export interface CredentialResolverDependencies {
  /** The read-only secrets mount. A separate mount from the data volume — see `server.ts`. */
  readonly credentialMountRoot: string;
  /** The data volume, which is where the marks live (`credential_failure_mark`). */
  readonly volumeRoot: string;
  readonly clock: Clock;
}

/**
 * `20-contract.md` § L1 — credentials: the manifest name begins with `_`,
 * which `CredentialRef`'s pattern forbids as a first character, so it can
 * never be mistaken for a reference.
 */
const ALLOWED_HOSTS_MANIFEST = '_allowed-hosts.json';

const ENV_VAR_PREFIX = 'SZG_CREDENTIAL_';

/** Derived, never operator-configured — a channel name between this module and `Exec`. */
export function envVarNameFor(ref: CredentialRef): EnvVarName {
  return `${ENV_VAR_PREFIX}${(ref as string).toUpperCase().replace(/[^A-Z0-9]/g, '_')}` as EnvVarName;
}

interface MarkRow {
  readonly credential_ref: string;
  readonly declaration_id: string;
  readonly reason: string;
  readonly marked_at: string;
}

function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): T | null {
  let db: DatabaseSync;
  try {
    mkdirSync(volumeRoot, { recursive: true });
    db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    db.exec('PRAGMA foreign_keys = ON;');
  } catch {
    return null;
  }
  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * The mounted-secrets-directory resolver (`10-design.md` § credential
 * resolution). One resolver ships, behind this interface a second could
 * satisfy.
 *
 * Three properties hold by construction rather than by discipline:
 *
 * - **The value goes only into a `MutableEnv`.** No member returns it, and the
 *   `CredentialBinding` handed back names a variable rather than carrying one.
 * - **Resolution happens at the moment of use.** Nothing is cached, so
 *   replacing a file in the mount takes effect on the next operation with no
 *   restart.
 * - **A mark is `(ref, declarationId)`, never reference-wide.** That is the
 *   composite primary key on `credential_failure_mark`, and it is what keeps
 *   one repository's misconfiguration from taking out every other repository
 *   sharing the reference.
 */
export function createCredentialResolver(deps: CredentialResolverDependencies): CredentialResolver {
  const { credentialMountRoot, volumeRoot, clock } = deps;

  function secretPath(ref: CredentialRef): string {
    // `CredentialRef`'s pattern admits no separator and no leading dot, so a
    // reference cannot traverse out of the mount. `path.basename` is belt and
    // braces for a caller that reached here with an unvalidated string.
    return path.join(credentialMountRoot, path.basename(ref as string));
  }

  function readSecret(ref: CredentialRef): Outcome<string, CredentialError> {
    const file = secretPath(ref);
    if (!existsSync(file)) {
      return err(credentialError({ code: 'reference-not-found', ref }, `no credential reference named '${ref}' in the mount`));
    }
    try {
      // A file written by an editor almost always ends in a newline, and a
      // token with a trailing newline authenticates as a different token.
      return ok(readFileSync(file, 'utf8').replace(/\r?\n$/, ''));
    } catch {
      return err(credentialError({ code: 'reference-unreadable', ref }, `credential reference '${ref}' could not be read`));
    }
  }

  function readMark(ref: CredentialRef, declarationId: DeclarationId): CredentialFailureMark | null {
    const rows = withDb(volumeRoot, (db) =>
      db
        .prepare('SELECT credential_ref, declaration_id, reason, marked_at FROM credential_failure_mark WHERE credential_ref = ? AND declaration_id = ?')
        .all(ref as string, declarationId as string) as unknown as MarkRow[],
    );
    const found = rows?.[0];
    if (!found) return null;
    return {
      ref: found.credential_ref as CredentialRef,
      declarationId: found.declaration_id as DeclarationId,
      reason: found.reason,
      markedAt: found.marked_at as IsoUtcTimestamp,
    };
  }

  /**
   * "The mark clears when the resolver observes a changed secret."
   *
   * `credential_failure_mark` has four columns and the contract fixes them, so
   * there is nowhere to persist a digest of the secret that failed — and
   * `reason` is operator-facing prose rather than somewhere to hide one. The
   * comparison that *is* available is the secret file's own modification time
   * against `marked_at`: a file written after the mark was taken is a secret
   * the resolver has now observed to differ from the one that was rejected.
   *
   * It survives a restart, which an in-process digest map would not, and it is
   * the signal the design already leans on — "rotation is a file write". The
   * one case it treats differently from a content digest is a rewrite with
   * identical bytes, which clears the mark and lets exactly one operation try
   * again; that operation re-marks immediately if the credential is still
   * wrong, so the failure is re-detected rather than masked.
   */
  function secretChangedSince(ref: CredentialRef, markedAt: IsoUtcTimestamp): boolean {
    try {
      return statSync(secretPath(ref)).mtimeMs > Date.parse(markedAt);
    } catch {
      return false;
    }
  }

  async function clearFailing(ref: CredentialRef, declarationId: DeclarationId): Promise<void> {
    withDb(volumeRoot, (db) => {
      db.prepare('DELETE FROM credential_failure_mark WHERE credential_ref = ? AND declaration_id = ?').run(ref as string, declarationId as string);
    });
  }

  return {
    async resolveInto(ref: CredentialRef, declarationId: DeclarationId, env: MutableEnv): Promise<Outcome<CredentialBinding, CredentialError>> {
      const secret = readSecret(ref);
      if (!secret.ok) return secret;

      const mark = readMark(ref, declarationId);
      if (mark !== null) {
        if (!secretChangedSince(ref, mark.markedAt)) {
          return err(
            credentialError(
              { code: 'marked-failing', mark },
              `credential reference '${ref}' is marked failing for '${declarationId}': ${mark.reason}. ` +
                `Replace the secret in the mount, or clear the mark from the health view.`,
            ),
          );
        }
        await clearFailing(ref, declarationId);
      }

      const variableName = envVarNameFor(ref);
      env.set(variableName, secret.value);
      return ok({ ref, declarationId, variableName });
    },

    async allowedHosts(ref: CredentialRef): Promise<Outcome<readonly RemoteHost[], CredentialError>> {
      const manifestPath = path.join(credentialMountRoot, ALLOWED_HOSTS_MANIFEST);
      // A reference absent from the manifest permits no host, and so does a
      // missing manifest. The design calls this a second guard independent of
      // the deployment's remote-host allowlist, and a guard that defaults open
      // is not one.
      if (!existsSync(manifestPath)) return ok([]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
      } catch {
        return err(credentialError({ code: 'reference-unreadable', ref }, `the credential mount's '${ALLOWED_HOSTS_MANIFEST}' could not be read`));
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ok([]);
      const entry = (parsed as Record<string, unknown>)[ref as string];
      if (!Array.isArray(entry)) return ok([]);
      return ok(entry.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase() as RemoteHost));
    },

    async markFailing(ref: CredentialRef, declarationId: DeclarationId, reason: string): Promise<void> {
      const at = clock.now();
      withDb(volumeRoot, (db) => {
        db.prepare(
          `INSERT INTO credential_failure_mark (credential_ref, declaration_id, reason, marked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (credential_ref, declaration_id) DO UPDATE SET reason = excluded.reason, marked_at = excluded.marked_at`,
        ).run(ref as string, declarationId as string, reason, at as string);
      });
    },

    clearFailing,

    async listFailing(): Promise<readonly CredentialFailureMark[]> {
      const rows =
        withDb(volumeRoot, (db) =>
          db.prepare('SELECT credential_ref, declaration_id, reason, marked_at FROM credential_failure_mark ORDER BY marked_at').all() as unknown as MarkRow[],
        ) ?? [];
      return rows.map((row) => ({
        ref: row.credential_ref as CredentialRef,
        declarationId: row.declaration_id as DeclarationId,
        reason: row.reason,
        markedAt: row.marked_at as IsoUtcTimestamp,
      }));
    },
  };
}
