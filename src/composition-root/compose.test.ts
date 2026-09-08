import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWatcherPollIntervalSeconds } from './compose.ts';

const ENV_VAR = 'WATCHER_POLL_INTERVAL_SECONDS';

function withEnv(value: string | undefined, run: () => void): void {
  const previous = process.env[ENV_VAR];
  if (value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = previous;
  }
}

test('#86 — resolveWatcherPollIntervalSeconds defaults to the contract value 15 when unset', () => {
  withEnv(undefined, () => {
    assert.equal(resolveWatcherPollIntervalSeconds(true), 15);
    assert.equal(resolveWatcherPollIntervalSeconds(false), 15);
  });
});

test('#86 — resolveWatcherPollIntervalSeconds reads a valid configured override', () => {
  withEnv('5', () => {
    assert.equal(resolveWatcherPollIntervalSeconds(true), 5);
  });
});

test('#86 — resolveWatcherPollIntervalSeconds is fatal on a non-positive value when the watcher is enabled', (t) => {
  withEnv('0', () => {
    const exitCalls: number[] = [];
    t.mock.method(process, 'exit', ((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error('server: process.exit(1) called');
    }) as typeof process.exit);
    t.mock.method(console, 'error', () => {});
    assert.throws(() => resolveWatcherPollIntervalSeconds(true));
    assert.deepEqual(exitCalls, [1]);
  });
});

test('#86 — resolveWatcherPollIntervalSeconds ignores a malformed value and keeps the default when the watcher is disabled, never exiting', (t) => {
  withEnv('not-a-number', () => {
    const exitCalls: number[] = [];
    t.mock.method(process, 'exit', ((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error('server: process.exit(1) called');
    }) as typeof process.exit);
    assert.equal(resolveWatcherPollIntervalSeconds(false), 15);
    assert.deepEqual(exitCalls, []);
  });
});
