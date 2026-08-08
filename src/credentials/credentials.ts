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

/**
 * Returns an outcome rather than `null`, because for the mark store the two
 * are not the same answer. "No row" means this reference is healthy for this
 * declaration; "the store could not be read" means nothing is known about it,
 * and collapsing the second into the first would let a busy or corrupt store
 * silently readmit a credential that is marked failing. `resolveInto` is the
 * caller that must tell them apart.
 */
type DbOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): DbOutcome<T> {
  let db: DatabaseSync;
  try {
    mkdirSync(volumeRoot, { recursive: true });
    db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  try {
    return { ok: true, value: fn(db) };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
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

  /**
   * `declarationId` is here only to be named in the summary. The contract's
   * error table requires `reference-not-found` to name "the reference and the
   * declaration, never a value", and the variant itself carries only `ref` —
   * so the declaration has to reach the operator through the prose, which is
   * the half an operator actually reads when deciding which repository is
   * misconfigured.
   */
  function readSecret(ref: CredentialRef, declarationId: DeclarationId): Outcome<string, CredentialError> {
    const file = secretPath(ref);
    if (!existsSync(file)) {
      return err(
        credentialError({ code: 'reference-not-found', ref }, `no credential reference named '${ref}' in the mount, required by declaration '${declarationId}'`),
      );
    }
    try {
      // A file written by an editor almost always ends in a newline, and a
      // token with a trailing newline authenticates as a different token.
      return ok(readFileSync(file, 'utf8').replace(/\r?\n$/, ''));
    } catch {
      return err(credentialError({ code: 'reference-unreadable', ref }, `credential reference '${ref}', required by declaration '${declarationId}', could not be read`));
    }
  }

  function toMark(row: MarkRow): CredentialFailureMark {
    return {
      ref: row.credential_ref as CredentialRef,
      declarationId: row.declaration_id as DeclarationId,
      reason: row.reason,
      markedAt: row.marked_at as IsoUtcTimestamp,
    };
  }

  /** `ok: true` with a `null` value means "no mark"; `ok: false` means "unknown", which is not the same thing. */
  function readMark(ref: CredentialRef, declarationId: DeclarationId): DbOutcome<CredentialFailureMark | null> {
    const rows = withDb(volumeRoot, (db) =>
      db
        .prepare('SELECT credential_ref, declaration_id, reason, marked_at FROM credential_failure_mark WHERE credential_ref = ? AND declaration_id = ?')
        .all(ref as string, declarationId as string) as unknown as MarkRow[],
    );
    if (!rows.ok) return rows;
    const found = rows.value[0];
    return { ok: true, value: found ? toMark(found) : null };
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
      // Floored, and strictly greater. `mtimeMs` carries sub-millisecond
      // precision while an `IsoUtcTimestamp` is truncated to whole
      // milliseconds, so a file written *before* the mark but inside the same
      // millisecond compares as newer — and the mark clears itself the instant
      // it is taken. Flooring puts both on the same scale, and requiring a
      // strictly later millisecond makes a tie mean "not changed", which is
      // the direction that keeps the mark.
      return Math.floor(statSync(secretPath(ref)).mtimeMs) > Date.parse(markedAt);
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
      const secret = readSecret(ref, declarationId);
      if (!secret.ok) return secret;

      // Fail closed. A store that cannot be read is not a store with no marks
      // in it, and treating the two alike would hand out a credential the
      // service has already been told is failing. `reference-unreadable` is
      // the only `infrastructure`-class variant the contract's four-way
      // `CredentialError` gives this module; its summary names the real cause
      // so an operator is not sent to look at the mount for a store fault.
      const markRead = readMark(ref, declarationId);
      if (!markRead.ok) {
        return err(
          credentialError(
            { code: 'reference-unreadable', ref },
            `could not read the failure marks for '${ref}' on '${declarationId}', so it is not known whether this credential is marked failing: ${markRead.reason}`,
          ),
        );
      }

      const mark = markRead.value;
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

    /**
     * Returns `[]` on a store read failure, which is indistinguishable from
     * "no references are failing" — the same gap issue #42 records for
     * `Journal`'s four query methods, and for the same reason: the contract
     * fixes this signature with no error channel. `resolveInto` above does not
     * share the gap, because its signature *has* one and it fails closed.
     */
    async listFailing(): Promise<readonly CredentialFailureMark[]> {
      const rows = withDb(volumeRoot, (db) =>
        db.prepare('SELECT credential_ref, declaration_id, reason, marked_at FROM credential_failure_mark ORDER BY marked_at').all() as unknown as MarkRow[],
      );
      return rows.ok ? rows.value.map(toMark) : [];
    },
  };
}
