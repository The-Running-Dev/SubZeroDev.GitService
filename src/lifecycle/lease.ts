import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock/clock.ts';

export interface InstanceLease {
  readonly instanceId: string;
  readonly bootId: string;
  readonly hostName: string;
  readonly startedAt: string;
}

export const LEASE_LOCK_FILENAME = 'lease.lock';
export const LEASE_FILENAME = 'lease.json';

/**
 * The exclusive advisory OS lock the design's boot step 1 requires.
 *
 * Node ships no `flock` binding, so the lock is taken by holding a
 * `BEGIN EXCLUSIVE` transaction open on a dedicated SQLite file that exists
 * only to be locked. That is a real OS advisory lock — SQLite takes `fcntl`
 * locks on POSIX and `LockFileEx` on Windows — which is what makes the two
 * properties the design depends on true:
 *
 *   - a second process is refused while the holder lives; and
 *   - the kernel releases it when the holder dies, `SIGKILL` included, so an
 *     unclean kill leaves no stale lock to clear by hand.
 *
 * Both are verified by tests against real child processes rather than assumed.
 * The lease *contents* are a separate JSON file, per the contract's file
 * table; this module writes it only while the lock is held.
 */
export interface LeaseGuard {
  /** Releases the advisory lock. Called on orderly shutdown; the kernel does it on death. */
  release(): void;
}

export type LeaseAcquisition =
  | { readonly acquired: true; readonly guard: LeaseGuard }
  | { readonly acquired: false };

export interface LockAcquirer {
  /** Attempts the exclusive advisory lock without waiting. */
  acquire(lockPath: string): LeaseAcquisition;
  /**
   * Spawns a real second process that attempts the same lock, and reports
   * whether it was refused. A child rather than a second acquire from this
   * process, because the property relied on is *cross-process* exclusion:
   * a same-process re-acquire tests the locking API, and can pass on a broken
   * volume and fail on a sound one.
   */
  childIsRefused(lockPath: string): boolean;
}

function openLocked(lockPath: string): DatabaseSync | null {
  try {
    const db = new DatabaseSync(lockPath);
    db.exec('PRAGMA busy_timeout = 0;');
    db.exec('CREATE TABLE IF NOT EXISTS lease_lock (held INTEGER PRIMARY KEY) STRICT;');
    db.exec('BEGIN EXCLUSIVE;');
    return db;
  } catch {
    return null;
  }
}

const selfTestChildPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lease-self-test-child.ts');

/**
 * Strong, process-wide references to every open lock handle.
 *
 * This is load-bearing rather than tidiness. The advisory lock lives in the
 * OS, but it is only held for as long as the `DatabaseSync` behind it stays
 * open — and a handle reachable only through a returned closure is eligible
 * for collection, at which point Node finalises it and the kernel drops the
 * lock while the process is still running and still believes it owns the
 * volume. That failure is invisible in a short-lived test (the process exits
 * before any GC) and appears in production the moment the service goes idle,
 * which is the worst possible place to find it. Holding the handle in
 * module scope ties the lock's lifetime to the process, which is what the
 * design means by "one instance owns the volume".
 */
const heldLocks = new Set<DatabaseSync>();

export const sqliteLockAcquirer: LockAcquirer = {
  acquire(lockPath: string): LeaseAcquisition {
    const db = openLocked(lockPath);
    if (!db) return { acquired: false };
    heldLocks.add(db);
    return {
      acquired: true,
      guard: {
        release(): void {
          heldLocks.delete(db);
          try {
            db.exec('ROLLBACK;');
          } catch {
            // Already released.
          }
          db.close();
        },
      },
    };
  },

  childIsRefused(lockPath: string): boolean {
    const result = spawnSync(process.execPath, [selfTestChildPath, lockPath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    // The child exits 3 when refused, 0 when it got the lock. Any other exit
    // (spawn failure, timeout, crash) is not evidence that exclusion holds,
    // so it is treated as a failed self-test rather than a pass.
    return result.status === CHILD_REFUSED_EXIT_CODE;
  },
};

export const CHILD_REFUSED_EXIT_CODE = 3;
export const CHILD_ACQUIRED_EXIT_CODE = 0;

export interface LeaseOutcome {
  readonly lease: InstanceLease;
  readonly guard: LeaseGuard;
  readonly selfTestPassed: boolean;
  /** The lease left behind by a holder that died without releasing, if there was one. */
  readonly takenOverFrom: InstanceLease | null;
}

export type LeaseFailure =
  | { readonly code: 'lease-held'; readonly holder: InstanceLease }
  | { readonly code: 'lease-not-exclusive' };

function readLeaseFile(leasePath: string): InstanceLease | null {
  if (!existsSync(leasePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(leasePath, 'utf8')) as Partial<InstanceLease>;
    if (
      typeof parsed.instanceId === 'string' &&
      typeof parsed.bootId === 'string' &&
      typeof parsed.hostName === 'string' &&
      typeof parsed.startedAt === 'string'
    ) {
      return parsed as InstanceLease;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * An unreadable or absent lease file alongside a *held* lock still refuses
 * startup — the lock is the exclusion, the file only names the holder. This
 * placeholder is what the operator sees when the holder died between taking
 * the lock and writing its name, which is a real interleaving.
 */
const UNKNOWN_HOLDER: InstanceLease = {
  instanceId: 'unknown',
  bootId: 'unknown',
  hostName: 'unknown',
  startedAt: 'unknown',
};

export interface AcquireLeaseOptions {
  readonly volumeRoot: string;
  readonly clock: Clock;
  readonly acquirer?: LockAcquirer;
  readonly instanceId?: string;
  readonly bootId?: string;
}

export function acquireLease(options: AcquireLeaseOptions): { ok: true; value: LeaseOutcome } | { ok: false; error: LeaseFailure } {
  const acquirer = options.acquirer ?? sqliteLockAcquirer;
  mkdirSync(options.volumeRoot, { recursive: true });

  const lockPath = path.join(options.volumeRoot, LEASE_LOCK_FILENAME);
  const leasePath = path.join(options.volumeRoot, LEASE_FILENAME);

  // Read before acquiring: if a lease file is present and we then win the
  // lock, its writer died without releasing, and this is a takeover.
  const previous = readLeaseFile(leasePath);

  const attempt = acquirer.acquire(lockPath);
  if (!attempt.acquired) {
    return { ok: false, error: { code: 'lease-held', holder: previous ?? UNKNOWN_HOLDER } };
  }

  // Boot step 1's self-test, on every boot, while we hold the lock.
  if (!acquirer.childIsRefused(lockPath)) {
    attempt.guard.release();
    return { ok: false, error: { code: 'lease-not-exclusive' } };
  }

  const lease: InstanceLease = {
    instanceId: options.instanceId ?? crypto.randomUUID(),
    bootId: options.bootId ?? crypto.randomUUID(),
    hostName: hostname(),
    startedAt: options.clock.now(),
  };
  writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    value: { lease, guard: attempt.guard, selfTestPassed: true, takenOverFrom: previous },
  };
}
