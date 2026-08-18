import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/**
 * S28.7 (`design/30-slices.md`) — proves boot's real lease self-test, wired
 * the way `server.ts` wires it (no injected `LockAcquirer`; `20-contract.md`
 * § L1 — "the deployment supplies one implementation"), passes against the
 * real image when the data mount is a container-managed named volume, and
 * the service serves. If it did not pass, boot would be fatal with
 * `lease-not-exclusive` (`boot.ts`), the HTTP server would never start, and
 * `/healthz` would never answer — so a `ready: true` response here is proof
 * of the self-test's own outcome, not a separate assertion about it.
 *
 * Run explicitly (`npm run verify:container-lease`), not swept into `npm
 * test`: it builds and runs the real Docker image, which needs a Docker
 * daemon and takes materially longer than the unit suite.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runId = randomUUID().slice(0, 8);
const imageTag = `subzerodev-git-s28-7-verify:${runId}`;
const volumeName = `s28-7-verify-data-${runId}`;
const containerName = `s28-7-verify-${runId}`;
const port = 18080;

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

test('S28.7 — against a container-managed named volume, the real image boots (self-test and all) and serves', async () => {
  const commitSha = run('git', ['rev-parse', 'HEAD']);
  const credentialMount = mkdtempSync(path.join(os.tmpdir(), 's28-7-credentials-'));

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
      assert.equal(health.ready, true, 'boot must succeed — a failed lease self-test would have kept the server unstarted');
      assert.equal(health.commitSha, commitSha, '/healthz must report the commit the image was built from');

      const running = run('docker', ['inspect', '-f', '{{.State.Running}}', containerName]);
      assert.equal(running, 'true', 'the container must still be running, not restarted or exited after boot');
    } finally {
      const logs = spawnSync('docker', ['logs', containerName], { encoding: 'utf8', timeout: 10_000 }).stdout;
      if (process.env.S28_7_VERBOSE) console.log(logs);
    }
  } finally {
    runAllowingFailure('docker', ['rm', '-f', containerName]);
    runAllowingFailure('docker', ['volume', 'rm', '-f', volumeName]);
    runAllowingFailure('docker', ['rmi', '-f', imageTag]);
    rmSync(credentialMount, { recursive: true, force: true });
  }
});
