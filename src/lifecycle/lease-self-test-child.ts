import { DatabaseSync } from 'node:sqlite';

/**
 * Boot step 1's self-test child. Spawned by `sqliteLockAcquirer.childIsRefused`
 * while the parent holds the instance lease, it attempts the same exclusive
 * advisory lock and reports the answer through its exit code.
 *
 * Exit 3 — refused, which is what a sound volume must do.
 * Exit 0 — granted, meaning the filesystem does not honour exclusion between
 *          processes. The parent turns that into a fatal `lease-not-exclusive`
 *          rather than letting two instances share one store.
 *
 * This is a separate process on purpose: same-process re-acquisition tests the
 * locking API, not the filesystem, and can pass on the broken configuration
 * and fail on the good one.
 */

const REFUSED = 3;
const ACQUIRED = 0;

const lockPath = process.argv[2];
if (!lockPath) {
  // No path to test is not evidence of exclusion. Exit non-zero and not the
  // "refused" code, so the parent treats it as a failed self-test.
  console.error('lease-self-test-child: no lock path given');
  process.exit(1);
}

try {
  const db = new DatabaseSync(lockPath);
  db.exec('PRAGMA busy_timeout = 0;');
  db.exec('BEGIN EXCLUSIVE;');
  // Got the lock while the parent holds it — the volume does not exclude.
  db.exec('ROLLBACK;');
  db.close();
  process.exit(ACQUIRED);
} catch {
  process.exit(REFUSED);
}
