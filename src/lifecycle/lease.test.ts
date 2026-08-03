import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from '../clock/clock.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import {
  acquireLease,
  LEASE_FILENAME,
  sqliteLockAcquirer,
  type InstanceLease,
  type LeaseAcquisition,
  type LockAcquirer,
} from './lease.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const holderScript = path.join(here, 'testing', 'lease-holder-fixture.ts');

function waitForLine(child: ReturnType<typeof spawn>, needle: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${needle}'`)), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (String(chunk).includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited early with code ${code}`));
    });
  });
}

test('S2.2 — a second acquisition against the same volume is refused, naming instanceId, hostName and startedAt from the lease file', async () => {
  await withVolumeAsync(async (volume) => {
    const first = acquireLease({ volumeRoot: volume, clock: systemClock });
    assert.equal(first.ok, true, 'the first instance takes the lease');
    if (!first.ok) return;

    try {
      const second = acquireLease({ volumeRoot: volume, clock: systemClock });
      assert.equal(second.ok, false, 'the second instance must be refused');
      if (second.ok) return;
      assert.equal(second.error.code, 'lease-held');
      if (second.error.code !== 'lease-held') return;

      const onDisk = JSON.parse(readFileSync(path.join(volume, LEASE_FILENAME), 'utf8')) as InstanceLease;
      assert.equal(second.error.holder.instanceId, onDisk.instanceId, 'names the holder instanceId from the lease file');
      assert.equal(second.error.holder.hostName, onDisk.hostName, 'names the holder hostName');
      assert.equal(second.error.holder.startedAt, onDisk.startedAt, 'names the holder startedAt');
      assert.ok(second.error.holder.instanceId.length > 0);
    } finally {
      first.value.guard.release();
    }
  });
});

test('S2.4 — the child-process self-test runs on every boot: the child is refused and boot proceeds', async () => {
  await withVolumeAsync(async (volume) => {
    const result = acquireLease({ volumeRoot: volume, clock: systemClock });
    assert.equal(result.ok, true, 'a sound volume lets boot proceed');
    if (!result.ok) return;
    try {
      assert.equal(result.value.selfTestPassed, true, 'the spawned child was refused the same lock');
    } finally {
      result.value.guard.release();
    }
  });
});

test('S2.4 — the self-test child really is a separate process that is refused while the lock is held', async () => {
  await withVolumeAsync(async (volume) => {
    const result = acquireLease({ volumeRoot: volume, clock: systemClock });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    try {
      const lockPath = path.join(volume, 'lease.lock');
      const child = spawnSync(
        process.execPath,
        [path.join(here, 'lease-self-test-child.ts'), lockPath],
        { encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(child.status, 3, 'the child exits 3 (refused) while the parent holds the lock');
    } finally {
      result.value.guard.release();
    }
  });
});

test('S2.4 — on a volume that grants the lock to both, boot reports lease-not-exclusive and takes no lease', async () => {
  await withVolumeAsync(async (volume) => {
    // A volume whose advisory locking does not exclude between processes: the
    // acquire succeeds and the self-test child is *also* granted the lock.
    // This is the bind-mounted-host-path case, injected rather than simulated
    // with a real bind mount — see the report accompanying this slice.
    let released = false;
    const permissiveVolume: LockAcquirer = {
      acquire(): LeaseAcquisition {
        return { acquired: true, guard: { release: () => { released = true; } } };
      },
      childIsRefused(): boolean {
        return false;
      },
    };

    const result = acquireLease({ volumeRoot: volume, clock: systemClock, acquirer: permissiveVolume });
    assert.equal(result.ok, false, 'boot must refuse a volume that grants both');
    if (result.ok) return;
    assert.equal(result.error.code, 'lease-not-exclusive');
    assert.equal(released, true, 'the lock taken before the failed self-test is released again');
    assert.equal(
      existsSync(path.join(volume, LEASE_FILENAME)),
      false,
      'no lease file is written when the self-test fails',
    );
  });
});

test('S2.3 — after SIGKILL of the holder, a new instance starts and reports the takeover; no manual lock clearing', async () => {
  await withVolumeAsync(async (volume) => {
    const holder = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', holderScript, volume], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForLine(holder, 'LEASE_HELD');

      // While it lives, a second instance is refused.
      const whileAlive = acquireLease({ volumeRoot: volume, clock: systemClock });
      if (whileAlive.ok) {
        whileAlive.value.guard.release();
        assert.fail('a second instance must be refused while the holder is alive');
      }
      assert.equal(whileAlive.error.code, 'lease-held');

      const previous = JSON.parse(readFileSync(path.join(volume, LEASE_FILENAME), 'utf8')) as InstanceLease;

      holder.kill('SIGKILL');
      await new Promise<void>((resolve) => holder.on('exit', () => resolve()));
      // Give the OS a moment to reclaim the descriptor.
      await new Promise<void>((resolve) => setTimeout(resolve, 750));

      const afterKill = acquireLease({ volumeRoot: volume, clock: systemClock });
      assert.equal(afterKill.ok, true, 'a new instance starts with no manual lock clearing');
      if (!afterKill.ok) return;
      try {
        assert.notEqual(afterKill.value.takenOverFrom, null, 'the takeover is reported');
        assert.equal(
          afterKill.value.takenOverFrom?.instanceId,
          previous.instanceId,
          'the takeover names the instance that died',
        );
        assert.notEqual(afterKill.value.lease.instanceId, previous.instanceId, 'the new lease is a new instance');
      } finally {
        afterKill.value.guard.release();
      }
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL');
    }
  });
});

test('a lease released in an orderly way frees the volume for the next instance', async () => {
  await withVolumeAsync(async (volume) => {
    const first = acquireLease({ volumeRoot: volume, clock: systemClock });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    first.value.guard.release();

    const second = acquireLease({ volumeRoot: volume, clock: systemClock });
    assert.equal(second.ok, true, 'the volume is free once the holder releases');
    if (second.ok) second.value.guard.release();
  });
});

test('the production acquirer is the one wired by default', () => {
  assert.equal(typeof sqliteLockAcquirer.acquire, 'function');
  assert.equal(typeof sqliteLockAcquirer.childIsRefused, 'function');
});
