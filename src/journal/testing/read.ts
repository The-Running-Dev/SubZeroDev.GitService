import assert from 'node:assert/strict';
import type { Outcome } from '../../shared/outcome.ts';
import type { JournalError } from '../errors.ts';

/**
 * Unwraps one of `Journal`'s four query `Outcome`s in a test whose subject is
 * what the journal holds, not whether it could be read. A test that is about
 * the read failing asserts on the `Outcome` directly instead of calling this.
 */
export function read<T>(result: Outcome<T, JournalError>): T {
  assert.equal(result.ok, true, result.ok ? '' : `the journal could not be read: ${result.error.summary}`);
  if (!result.ok) throw new Error('unreachable: the assertion above already failed');
  return result.value;
}
