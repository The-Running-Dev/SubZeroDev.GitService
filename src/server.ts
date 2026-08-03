import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSha, type GitSha } from './shared/brands.ts';
import { systemClock } from './clock/clock.ts';
import { createStructuredStore } from './store/structured-store.ts';
import { createAudit } from './audit/audit.ts';
import { createLifecycle } from './lifecycle/boot.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './surfaces/http-server.ts';

/**
 * The composition root. It never imports the compiler (invariant B8, enforced
 * by `scripts/check-no-compiler-in-runtime.ts`): it wires the lifecycle module,
 * which reads the already-built artifact under `build/`, takes the instance
 * lease, and migrates the store. No transport starts unless boot succeeds.
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

  const volumeRoot = process.env.VOLUME_ROOT ?? path.join(repoRoot, 'volume');
  const commitSha = resolveCommitSha();
  const port = resolvePort();

  const store = createStructuredStore({ volumeRoot, clock: systemClock });
  const audit = createAudit({ volumeRoot, clock: systemClock });
  const lifecycle = createLifecycle({
    volumeRoot,
    buildDir,
    clock: systemClock,
    store,
    audit,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    onTakeover: (previous, current) => {
      // The durable `lease-takeover` audit record is written by boot itself
      // (S3); this is operator-visible defense in depth, so a takeover is
      // never silent even if the trail were somehow unwritable.
      console.warn(
        `server: took over the volume from instance ${previous.instanceId} on ${previous.hostName} ` +
          `(started ${previous.startedAt}), which did not release its lease. Now held by ${current.instanceId}.`,
      );
    },
  });

  // Readiness is false until boot returns success: the lease must be held and
  // migrations applied before this instance reports that it can serve.
  let ready = false;

  const booted = await lifecycle.boot();
  if (!booted.ok) {
    console.error(`server: boot failed (${booted.error.code}) — ${booted.error.summary}`);
    console.error('server: refusing to start; no transport starts.');
    await lifecycle.shutdown('fatal');
    process.exit(1);
    return;
  }
  ready = true;

  const server = createSurfacesServer({
    commitSha,
    contractFingerprint: booted.value.registryFingerprint,
    consoleFingerprint: booted.value.consoleFingerprint,
    ready: () => ready,
    provisioningPending: () => booted.value.provisioningPending,
    auditChain: () => audit.chainState(),
    operatorApiToken,
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    ready = false;
    server.close(() => {
      void lifecycle.shutdown('signal').then(() => process.exit(0));
    });
    void signal;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(port, () => {
    console.log(
      `server: listening on :${port} (commit ${commitSha}, contract ${booted.value.registryFingerprint}, ` +
        `instance ${booted.value.lease.instanceId}, migrations applied ${booted.value.migrationsApplied})`,
    );
  });
}

await main();
