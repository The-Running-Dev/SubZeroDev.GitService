import { systemClock } from '../../clock/clock.ts';
import { acquireLease } from '../lease.ts';

/**
 * A real second process that takes the instance lease and then stays alive
 * until it is killed. Used by the S2.3 test to prove that a `SIGKILL`ed holder
 * leaves no stale lock — a property of the kernel and the filesystem, which
 * only a genuinely separate, genuinely killed process can demonstrate.
 */

const volumeRoot = process.argv[2];
if (!volumeRoot) {
  console.error('lease-holder-fixture: no volume root given');
  process.exit(1);
}

const result = acquireLease({ volumeRoot, clock: systemClock });
if (!result.ok) {
  console.error(`lease-holder-fixture: could not take the lease (${result.error.code})`);
  process.exit(1);
}

console.log('LEASE_HELD');

// Hold the lease open. The test kills this process; it never exits on its own.
setInterval(() => {}, 1_000);
