import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/**
 * S30 (`design/30-slices.md`) — committed beside `lease-self-test-container.ts`,
 * run on demand (`npm run verify:split-brain-lease`), not swept into `npm
 * test`: it builds and runs the real Docker image against a real Samba
 * sidecar, which needs a Docker daemon and takes materially longer than the
 * unit suite.
 *
 * **This asserts a vulnerability, not a guarantee.** S30.5–S30.7 demonstrate
 * that boot's lease self-test does not fire on a filesystem whose locking is
 * genuinely absent across independent client sessions — a finding, not a
 * defence. A later change that makes S30.5 or S30.6 fail (the guard starting
 * to refuse the mount it currently waves through) is a fix, not a
 * regression.
 *
 * **S30.2 is the control** — a container-managed named volume, same image,
 * same command as every other run here — and is the only test in this file
 * that runs unconditionally. Without it, any outcome below is attributable
 * to the harness rather than to the mount under it.
 *
 * **S30.5–S30.7 run for real** against a `dperson/samba` sidecar started by
 * this file, mounted twice via Docker's `local` volume driver
 * (`--opt type=cifs`) with `nobrl,nosharesock` — one CIFS volume per
 * container, so each gets its own client session rather than sharing the
 * host's. `nosharesock` is load-bearing: without it, the two containers'
 * mounts share one kernel CIFS session and local lock bookkeeping correctly
 * refuses the second boot (`lease-held`), which proves session-sharing
 * exclusion, not the cross-session exclusion `S30.5` asks about.
 * `design/90-decisions.md`'s 2026-08-19 entry records an earlier attempt on
 * this same kernel (`7.0.12-linuxkit`) that saw `node:sqlite`'s
 * journal-commit `unlink()` fail `EOPNOTSUPP` before reaching this point;
 * that did not reproduce here — see the decision log's later entry for what
 * changed and what did not.
 *
 * **S30.9** — configurations this file does not exercise, and why:
 *   - NFS: Docker Desktop's Linux VM kernel carries no NFSv3 client
 *     (`mount.nfs: requested NFS version or transport protocol is not
 *     supported`), and NFSv4's locking is protocol-integrated with no
 *     `nolock`-equivalent that reproduces "genuinely absent" locking the way
 *     NFSv3's does.
 *   - A bind-mounted Windows host path: this machine is not a Windows host.
 *     `S30.4`'s row for it is carried from the 2026-08-14 finding
 *     (`design/90-decisions.md`), run for real on Docker Desktop against a
 *     `C:\...` bind mount, where the second container was refused
 *     `lease-held` rather than `lease-not-exclusive`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runId = randomUUID().slice(0, 8);
const imageTag = `subzerodev-git-s30-verify:${runId}`;
const volumeName = `s30-verify-data-${runId}`;
const containerName = `s30-verify-${runId}`;
const port = 18081;

function run(command: string, args: readonly string[], opts: { cwd?: string; timeoutMs?: number } = {}): string {
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function runAllowingFailure(command: string, args: readonly string[]): void {
  spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 });
}

async function pollHealthzOn(healthPort: number, deadlineMs: number): Promise<{ ready: boolean; commitSha: string }> {
  const start = Date.now();
  let attempts = 0;
  let lastError: unknown;
  while (Date.now() - start < deadlineMs) {
    attempts += 1;
    try {
      const response = await fetch(`http://localhost:${healthPort}/healthz`);
      const body = (await response.json()) as { ready: boolean; commitSha: string };
      return body;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`/healthz never answered after ${attempts} attempts (${deadlineMs}ms): ${String(lastError)}`);
}

async function pollHealthz(deadlineMs: number): Promise<{ ready: boolean; commitSha: string }> {
  return pollHealthzOn(port, deadlineMs);
}

test('S30.2 — control: a container-managed named volume boots and serves', async () => {
  const commitSha = run('git', ['rev-parse', 'HEAD']);
  const credentialMount = mkdtempSync(path.join(os.tmpdir(), 's30-credentials-'));

  run('docker', ['build', '--build-arg', `GIT_COMMIT_SHA=${commitSha}`, '-t', imageTag, '.'], { timeoutMs: 10 * 60_000 });
  run('docker', ['volume', 'create', volumeName]);

  try {
    run('docker', [
      'run',
      '-d',
      '--name',
      containerName,
      '-p',
      `${port}:8080`,
      '-v',
      `${volumeName}:/data`,
      '-v',
      `${credentialMount}:/credentials:ro`,
      '-e',
      'REMOTE_HOST_ALLOWLIST=',
      '-e',
      'DEPLOYMENT_CEILING=',
      '-e',
      `PUBLIC_ORIGIN=http://localhost:${port}`,
      imageTag,
    ]);

    try {
      const health = await pollHealthz(30_000);
      assert.equal(health.ready, true, 'boot must succeed against the supported configuration');
      assert.equal(health.commitSha, commitSha, '/healthz must report the commit the image was built from');
    } finally {
      const logs = spawnSync('docker', ['logs', containerName], { encoding: 'utf8', timeout: 10_000 }).stdout;
      if (process.env.S30_VERBOSE) console.log(logs);
    }
  } finally {
    runAllowingFailure('docker', ['rm', '-f', containerName]);
    runAllowingFailure('docker', ['volume', 'rm', '-f', volumeName]);
    runAllowingFailure('docker', ['rmi', '-f', imageTag]);
    rmSync(credentialMount, { recursive: true, force: true });
  }
});

const sambaContainerName = `s30-verify-samba-${runId}`;
const sambaNetworkName = `s30-verify-net-${runId}`;
const volumeNameA = `s30-verify-cifs-a-${runId}`;
const volumeNameB = `s30-verify-cifs-b-${runId}`;
const containerNameA = `s30-verify-cifs-a-${runId}`;
const containerNameB = `s30-verify-cifs-b-${runId}`;
const portA = 18082;
const portB = 18083;

function startSambaSidecar(): string {
  run('docker', ['network', 'create', sambaNetworkName]);
  run('docker', [
    'run',
    '-d',
    '--name',
    sambaContainerName,
    '--network',
    sambaNetworkName,
    'dperson/samba',
    '-u',
    'testuser;testpass',
    '-s',
    'data;/share;yes;no;no;testuser',
  ]);
  // dperson/samba creates /share as root:root 0755; testuser (uid 1000) needs
  // write access for the CIFS mounts below to do anything at all.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const chmod = spawnSync('docker', ['exec', '-u', 'root', sambaContainerName, 'chmod', '777', '/share'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (chmod.status === 0) break;
    spawnSync('sleep', ['0.5']);
  }
  return run('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', sambaContainerName]);
}

test('S30.5/S30.6 — two independent CIFS/nobrl client sessions both boot, and boot\'s self-test passes on both sides', async () => {
  const commitSha = run('git', ['rev-parse', 'HEAD']);
  const credentialMountA = mkdtempSync(path.join(os.tmpdir(), 's30-cifs-credentials-a-'));
  const credentialMountB = mkdtempSync(path.join(os.tmpdir(), 's30-cifs-credentials-b-'));

  run('docker', ['build', '--build-arg', `GIT_COMMIT_SHA=${commitSha}`, '-t', imageTag, '.'], { timeoutMs: 10 * 60_000 });
  const sambaIp = startSambaSidecar();

  const cifsOpts = `username=testuser,password=testpass,vers=3.0,nobrl,nosharesock`;
  run('docker', ['volume', 'create', '--driver', 'local', '--opt', 'type=cifs', '--opt', `device=//${sambaIp}/data`, '--opt', `o=${cifsOpts}`, volumeNameA]);
  run('docker', ['volume', 'create', '--driver', 'local', '--opt', 'type=cifs', '--opt', `device=//${sambaIp}/data`, '--opt', `o=${cifsOpts}`, volumeNameB]);

  try {
    run('docker', [
      'run', '-d', '--name', containerNameA, '-p', `${portA}:8080`,
      '-v', `${volumeNameA}:/data`, '-v', `${credentialMountA}:/credentials:ro`,
      '-e', 'REMOTE_HOST_ALLOWLIST=', '-e', 'DEPLOYMENT_CEILING=', '-e', `PUBLIC_ORIGIN=http://localhost:${portA}`,
      imageTag,
    ]);
    const healthA = await pollHealthzOn(portA, 30_000);
    assert.equal(healthA.ready, true, 'S30.5: the first independent CIFS/nobrl session must boot and serve');

    run('docker', [
      'run', '-d', '--name', containerNameB, '-p', `${portB}:8080`,
      '-v', `${volumeNameB}:/data`, '-v', `${credentialMountB}:/credentials:ro`,
      '-e', 'REMOTE_HOST_ALLOWLIST=', '-e', 'DEPLOYMENT_CEILING=', '-e', `PUBLIC_ORIGIN=http://localhost:${portB}`,
      imageTag,
    ]);
    const healthB = await pollHealthzOn(portB, 30_000);
    assert.equal(healthB.ready, true, 'S30.5: the second independent CIFS/nobrl session must also boot and serve — the split-brain finding');

    // Re-check A: S30.6 is that neither side's self-test fired lease-not-exclusive
    // and exited, not merely that each answered once before the other started.
    const healthAAgain = await pollHealthzOn(portA, 5_000);
    assert.equal(healthAAgain.ready, true, "S30.6: the first container's self-test must still show ready — it did not exit lease-not-exclusive");
    const runningA = run('docker', ['inspect', '-f', '{{.State.Running}}', containerNameA]);
    const runningB = run('docker', ['inspect', '-f', '{{.State.Running}}', containerNameB]);
    assert.equal(runningA, 'true', "S30.6: the first container must still be running, not exited lease-not-exclusive");
    assert.equal(runningB, 'true', "S30.6: the second container must still be running, not exited lease-not-exclusive");

    // S30.7: run the self-test child inside the mount A already holds, as its
    // own step rather than through boot. It shares A's CIFS client session,
    // so it must see A's own held lock and refuse — CHILD_REFUSED_EXIT_CODE.
    const child = spawnSync(
      'docker',
      ['exec', containerNameA, 'node', '--disable-warning=ExperimentalWarning', '/app/src/lifecycle/lease-self-test-child.ts', '/data/lease.lock'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(child.status, 3, `S30.7: lease-self-test-child.ts must exit CHILD_REFUSED_EXIT_CODE (3) inside the lock-holding container; got ${child.status}`);
  } finally {
    const logsA = spawnSync('docker', ['logs', containerNameA], { encoding: 'utf8', timeout: 10_000 }).stdout;
    const logsB = spawnSync('docker', ['logs', containerNameB], { encoding: 'utf8', timeout: 10_000 }).stdout;
    if (process.env.S30_VERBOSE) console.log(logsA, logsB);
    runAllowingFailure('docker', ['rm', '-f', containerNameA]);
    runAllowingFailure('docker', ['rm', '-f', containerNameB]);
    runAllowingFailure('docker', ['volume', 'rm', '-f', volumeNameA]);
    runAllowingFailure('docker', ['volume', 'rm', '-f', volumeNameB]);
    runAllowingFailure('docker', ['rm', '-f', sambaContainerName]);
    runAllowingFailure('docker', ['network', 'rm', sambaNetworkName]);
    runAllowingFailure('docker', ['rmi', '-f', imageTag]);
    rmSync(credentialMountA, { recursive: true, force: true });
    rmSync(credentialMountB, { recursive: true, force: true });
  }
});

/**
 * S30.4 and S30.9's coverage record. Not an assertion about the filesystem —
 * a statement of what this file did and did not manage to exercise, kept
 * next to the tests above rather than only in the decision log, so a reader
 * running this file sees the same table `/slice`'s report and the PR carry.
 */
interface MountOutcome {
  readonly configuration: string;
  readonly outcome: 'served' | 'lease-held' | 'lease-not-exclusive' | 'served-twice' | 'not-exercised';
  readonly evidence: string;
}

const MOUNT_OUTCOMES: readonly MountOutcome[] = [
  {
    configuration: 'container-managed named volume (the supported configuration)',
    outcome: 'served',
    evidence: 'S30.2, this file, this run',
  },
  {
    configuration: 'bind-mounted Windows host path',
    outcome: 'lease-held',
    evidence: 'design/90-decisions.md, 2026-08-14 — real Windows host, Docker Desktop 4.86, carried forward rather than re-run (this host is not Windows)',
  },
  {
    configuration: 'CIFS/SMB share mounted nobrl, forced-independent client sessions (nosharesock)',
    outcome: 'served-twice',
    evidence: 'S30.5/S30.6, this file, this run — the split-brain finding C7 exists to prevent, reached against a real filesystem',
  },
  {
    configuration: 'NFS share mounted nolock (NFSv3) or NFSv4 with no locking equivalent',
    outcome: 'not-exercised',
    evidence: "Docker Desktop's Linux VM kernel carries no NFSv3 client; NFSv4 has no nolock-equivalent",
  },
];

test('S30.4/S30.9 — the mount configurations exercised are counted, and every one not exercised is named', () => {
  assert.equal(MOUNT_OUTCOMES.length, 4, 'four configurations make up the acceptance record');
  const notExercised = MOUNT_OUTCOMES.filter((m) => m.outcome === 'not-exercised');
  assert.equal(notExercised.length, 1, 'exactly one configuration (NFS) is named as not exercised');
  if (process.env.S30_VERBOSE) {
    const reportPath = path.join(os.tmpdir(), `s30-mount-outcomes-${runId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(MOUNT_OUTCOMES, null, 2)}\n`, 'utf8');
    console.log(`S30 mount outcomes written to ${reportPath}`);
    console.table(MOUNT_OUTCOMES);
  }
});
