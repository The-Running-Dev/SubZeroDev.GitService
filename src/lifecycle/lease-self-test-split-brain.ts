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
 * **This asserts a vulnerability, not a guarantee.** S30.5–S30.7 are written
 * to demonstrate that boot's lease self-test does not fire on a filesystem
 * whose locking is genuinely absent across independent client sessions — a
 * finding, not a defence. A later change that makes S30.5 or S30.6 fail (the
 * guard starting to refuse the mount it currently waves through) is a fix,
 * not a regression.
 *
 * **S30.2 is the control** — a container-managed named volume, same image,
 * same command as every other run here — and is the only test in this file
 * that runs unconditionally. Without it, any outcome below is attributable
 * to the harness rather than to the mount under it.
 *
 * **S30.5–S30.7 are marked `skip` on this host, with the reason stated
 * rather than the tests deleted or faked.** Run for real on 2026-08-19
 * against a Samba sidecar (`dperson/samba` 4.12.2 and, separately,
 * `ghcr.io/servercontainers/samba` 4.23.8) mounted via Docker's `local`
 * volume driver (`--opt type=cifs`) with `nobrl`: the real production image,
 * booting against that mount, fails before any lock-exclusivity behaviour is
 * reachable. `node:sqlite`'s `BEGIN EXCLUSIVE`/`CREATE TABLE` sequence that
 * `lease.ts`'s `openLocked` runs on every boot commits its journal by
 * `unlink()`-ing the `-journal` file, and the CIFS client
 * (`kernel 7.0.12-linuxkit`, this machine's Docker Desktop VM) returns
 * `EOPNOTSUPP` for that unlink whenever the mount carries `nobrl` — confirmed
 * independent of `nosharesock`, and independent of which Samba server or
 * server-side locking/oplock settings were tried. This is a different,
 * earlier failure than `design/90-decisions.md`'s 2026-08-19 entry describes
 * (two containers both reaching `ready: true`): that entry's environment is
 * not reproducible with what is available here. The new finding is recorded
 * in the decision log's own 2026-08-19 entry alongside it, and `S30.4`–`S30.8`
 * are left unmet — not silently marked passing — until a host is found where
 * the mount itself does not break `node:sqlite` outright.
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

async function pollHealthz(deadlineMs: number): Promise<{ ready: boolean; commitSha: string }> {
  const start = Date.now();
  let attempts = 0;
  let lastError: unknown;
  while (Date.now() - start < deadlineMs) {
    attempts += 1;
    try {
      const response = await fetch(`http://localhost:${port}/healthz`);
      const body = (await response.json()) as { ready: boolean; commitSha: string };
      return body;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`/healthz never answered after ${attempts} attempts (${deadlineMs}ms): ${String(lastError)}`);
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

const SQLITE_OVER_NOBRL_CIFS_BLOCKED =
  'blocked: node:sqlite\'s journal-commit unlink() returns EOPNOTSUPP over a CIFS mount carrying nobrl ' +
  'on this host (kernel 7.0.12-linuxkit, both dperson/samba 4.12.2 and ghcr.io/servercontainers/samba ' +
  '4.23.8) — the real image cannot boot against this mount at all, so no lock-exclusivity behaviour is ' +
  'reachable. See design/90-decisions.md, 2026-08-19.';

test(
  'S30.5 — two independent CIFS/nobrl client sessions both boot and both report ready:true',
  { skip: SQLITE_OVER_NOBRL_CIFS_BLOCKED },
  () => {},
);

test('S30.6 — boot\'s self-test passes on both sides of that run', { skip: SQLITE_OVER_NOBRL_CIFS_BLOCKED }, () => {});

test(
  'S30.7 — lease-self-test-child.ts, run inside the lock-holding container, exits CHILD_REFUSED_EXIT_CODE',
  { skip: SQLITE_OVER_NOBRL_CIFS_BLOCKED },
  () => {},
);

/**
 * S30.4 and S30.9's coverage record. Not an assertion about the filesystem —
 * a statement of what this file did and did not manage to exercise, kept
 * next to the tests above rather than only in the decision log, so a reader
 * running this file sees the same table `/slice`'s report and the PR carry.
 */
interface MountOutcome {
  readonly configuration: string;
  readonly outcome: 'served' | 'lease-held' | 'lease-not-exclusive' | 'served-twice' | 'not-exercised' | 'blocked';
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
    configuration: 'CIFS/SMB share mounted nobrl, forced-independent client sessions',
    outcome: 'blocked',
    evidence: 'design/90-decisions.md, 2026-08-19 (this entry) — SQLITE_OVER_NOBRL_CIFS_BLOCKED, above',
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
