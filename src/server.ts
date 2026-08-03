import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSha, type GitSha } from './shared/brands.ts';
import { verifyRegistryArtifact } from './lifecycle/registry-integrity.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './surfaces/http-server.ts';

/**
 * The composition root. It never imports the compiler (invariant B8,
 * enforced by `scripts/check-no-compiler-in-runtime.ts`) — it reads the
 * already-built artifact under `build/` and refuses to start a transport if
 * that artifact fails its integrity check (boot steps 2 and 3).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(repoRoot, 'build');

function resolvePort(): number {
  const raw = process.env.PORT ?? '8080';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`server: PORT must be an integer between 0 and 65535 (got '${raw}')`);
    process.exit(1);
  }
  return port;
}

function resolveCommitSha(): GitSha {
  const fromEnv = process.env.GIT_COMMIT_SHA;
  const raw = fromEnv ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const parsed = gitSha(raw);
  if (!parsed.ok) {
    console.error(`server: could not determine the running commit SHA (got '${raw}')`);
    process.exit(1);
  }
  return parsed.value;
}

async function main(): Promise<void> {
  const operatorApiToken = process.env.OPERATOR_API_TOKEN;
  if (!operatorApiToken) {
    console.error('server: OPERATOR_API_TOKEN is not set — refusing to start without a way to authenticate the version route');
    process.exit(1);
    return;
  }

  const verified = await verifyRegistryArtifact(buildDir);
  if (!verified.ok) {
    if (verified.error.code === 'fingerprint-mismatch') {
      console.error(
        `server: registry fingerprint-mismatch — expected ${verified.error.expected}, found ${verified.error.found}. Refusing to start; no transport starts.`,
      );
    } else {
      console.error(`server: registry-unreadable — ${verified.error.reason}. Refusing to start; no transport starts.`);
    }
    process.exit(1);
    return;
  }

  const commitSha = resolveCommitSha();
  const port = resolvePort();

  const server = createSurfacesServer({
    commitSha,
    contractFingerprint: verified.value.contractFingerprint,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    operatorApiToken,
  });

  server.listen(port, () => {
    console.log(`server: listening on :${port} (commit ${commitSha}, contract ${verified.value.contractFingerprint})`);
  });
}

await main();
