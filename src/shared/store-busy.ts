import type { DatabaseSync } from 'node:sqlite';

/**
 * The one busy timeout every store connection sets (S47.3). SQLite waits and
 * retries internally with bounded backoff for up to this long when another
 * connection holds the lock, then fails with `SQLITE_BUSY` — so a moment of
 * contention is waited out and a long one still fails, as `infrastructure`.
 *
 * The wait is synchronous: `DatabaseSync` blocks the event loop for it, which
 * is why the bound is seconds, not minutes. The lease connection is the one
 * store connection that does *not* use this — it needs an immediate refusal
 * (`PRAGMA busy_timeout = 0`), because losing the race is its whole answer.
 */
export const STORE_BUSY_TIMEOUT_MS = 2000;

export function applyStoreBusyTimeout(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS};`);
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** True when `cause` is SQLite refusing because another connection holds the lock. */
export function isStoreBusy(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  const { errcode, message } = cause as { errcode?: unknown; message?: unknown };
  if (typeof errcode === 'number') return errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED;
  return typeof message === 'string' && /database (table )?is (locked|busy)/i.test(message);
}
