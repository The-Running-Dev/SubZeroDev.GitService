import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSha, type GitSha, type RemoteHost } from './shared/brands.ts';
import type { CapabilityName, DeploymentCeiling } from './contract/capabilities.ts';
import { systemClock } from './clock/clock.ts';
import { createStructuredStore } from './store/structured-store.ts';
import { createAudit } from './audit/audit.ts';
import { createLifecycle } from './lifecycle/boot.ts';
import { createOperatorIdentity, SESSION_ABSOLUTE_SECONDS_DEFAULT } from './operator-identity/operator-identity.ts';
import { createExec } from './exec/exec.ts';
import { createLocks } from './locks/locks.ts';
import { createDeclarations, type Declarations } from './declarations/declarations.ts';
import { createCloneStore, type CloneStore } from './clone/clone-store.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './surfaces/http-server.ts';
import { createGitOperations } from './git/git-operations.ts';
import { createJournal } from './journal/journal.ts';
import { createRecoveryCatalogue } from './recovery/catalogue.ts';
import { LOCAL_MUTATION_RECOVERY_DESCRIPTORS, REMOTE_OPERATION_RECOVERY_DESCRIPTORS } from './git/recovery-descriptors.ts';
import { createCredentialResolver } from './credentials/credentials.ts';
import { prepareDeclarationCredential } from './credentials/declaration-credential.ts';
import { ok, err } from './shared/outcome.ts';
import { createGitHubAdapter } from './host/github-adapter.ts';
import { createHostOperations } from './host/host-operations.ts';
import { hostError } from './host/errors.ts';
import { PR_ENABLE_AUTO_MERGE_RECOVERY, PR_OPEN_RECOVERY } from './host/recovery-descriptors.ts';
import type { EnvVarName } from './shared/brands.ts';
import { createModuleAdapter, toModuleHandler } from './module-adapter/module-adapter.ts';
import { createDispatchPipeline } from './dispatch/dispatch-pipeline.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from './composition-root/production-declarations.ts';
import type { ModuleTargetName } from './shared/brands.ts';
import type { ContractCapabilitySet } from './contract/capabilities.ts';
import type { CompiledRegistry } from './contract/tool-declaration.ts';

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

/** `DeploymentConfig.remoteHostAllowlist` (`20-contract.md` § Deployment configuration) — a deployment-set value with no fixed default; empty until configured means nothing can be declared, which is the safe direction to fail in. */
function resolveRemoteHostAllowlist(): readonly RemoteHost[] {
  const raw = process.env.REMOTE_HOST_ALLOWLIST;
  if (!raw) return [];
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0) as RemoteHost[];
}

/** `DeploymentConfig.ceiling` — same reasoning: empty until configured, which is always valid against the contract set (Ø ⊆ anything). */
function resolveCeiling(): DeploymentCeiling {
  const raw = process.env.DEPLOYMENT_CEILING;
  const names = raw
    ? raw
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
    : [];
  return new Set(names as CapabilityName[]) as unknown as DeploymentCeiling;
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
  // The credential mount is a second, separate mount from the data volume —
  // the TOTP sealing key must never share a backup with the secret it opens
  // (`20-contract.md` § `operator_credential`). `CREDENTIAL_MOUNT_ROOT`
  // follows `VOLUME_ROOT`'s own convention rather than inventing a new one.
  const credentialMountRoot = process.env.CREDENTIAL_MOUNT_ROOT ?? path.join(repoRoot, 'credentials');
  const commitSha = resolveCommitSha();
  const port = resolvePort();

  const store = createStructuredStore({ volumeRoot, clock: systemClock });
  const audit = createAudit({ volumeRoot, clock: systemClock });
  const operatorIdentity = createOperatorIdentity({ volumeRoot, credentialMountRoot, clock: systemClock, audit });
  // The one `MutableEnv` the resolver writes a secret into and `Exec` reads it
  // back out of, by variable name. Sharing the map here is what keeps the
  // value out of every signature in between (`20-contract.md` § L1 —
  // credentials).
  const credentialEnv = new Map<EnvVarName, string>();
  const exec = createExec({ volumeRoot, credentialEnv });
  const credentials = createCredentialResolver({ credentialMountRoot, volumeRoot, clock: systemClock });
  const locks = createLocks();
  const ceiling = resolveCeiling();
  const remoteHostAllowlist = resolveRemoteHostAllowlist();

  // `Declarations` and `CloneStore` depend on each other for different
  // reasons (`declarations.ts`'s `CloneAdoptionCheck` doc comment): adoption
  // safety needs `CloneStore`, and `CloneStore.ensure`/`describe` need
  // `Declarations` to resolve a bare id into a full record. Neither is
  // called during construction, only once both exist and boot has run, so a
  // mutable forward reference breaks the cycle without either module
  // depending on the other's factory function.
  let cloneStoreRef: CloneStore | null = null;
  const declarations: Declarations = createDeclarations({
    volumeRoot,
    clock: systemClock,
    remoteHostAllowlist,
    ceiling,
    cloneAdoptionCheck: () => {
      const store = cloneStoreRef;
      if (!store) throw new Error('cloneStore accessed before composition finished');
      return {
        observedRemote: async (id) => {
          const described = await store.describe(id);
          // A failed lookup can't be reported as "no clone" — that would
          // let adoption through on unverifiable data. Fail closed: report
          // a clone as present with an unknown remote, which `declare()`
          // refuses (review finding #3).
          if (!described.ok) return { cloneExists: true, remote: null };
          if (described.value.state === 'absent') return { cloneExists: false };
          return { cloneExists: true, remote: described.value.observedRemote };
        },
        isSafeToAdopt: async (id) => {
          const verdict = await store.isSafeToEvict(id, true);
          return verdict.ok ? verdict.value : { safe: false, blockers: [{ kind: 'corrupt-tree' }] };
        },
      };
    },
  });
  const cloneStore = createCloneStore({ volumeRoot, clock: systemClock, exec, locks, declarations });
  cloneStoreRef = cloneStore;

  // The five S6 read tools plus S7's three local mutating tools: git
  // operations dispatched through a module adapter and the dispatch
  // pipeline. `PRODUCTION_TOOL_DECLARATIONS` is plain data (no compiler
  // call), which is what keeps invariant B8 (the compiler absent from the
  // runtime image) intact here.
  const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit, declarations, credentials, credentialEnv });
  const journal = createJournal({ volumeRoot, clock: systemClock });
  const moduleAdapter = createModuleAdapter();
  moduleAdapter.register('git.status' as ModuleTargetName, toModuleHandler(gitOperations.status));
  moduleAdapter.register('git.log' as ModuleTargetName, toModuleHandler(gitOperations.log));
  moduleAdapter.register('git.branches' as ModuleTargetName, toModuleHandler(gitOperations.branches));
  moduleAdapter.register('git.health' as ModuleTargetName, toModuleHandler(gitOperations.health));
  moduleAdapter.register('git.diff' as ModuleTargetName, toModuleHandler(gitOperations.diff));
  moduleAdapter.register('git.stage' as ModuleTargetName, toModuleHandler(gitOperations.stage));
  moduleAdapter.register('git.commit' as ModuleTargetName, toModuleHandler(gitOperations.commit));
  moduleAdapter.register('git.restorePaths' as ModuleTargetName, toModuleHandler(gitOperations.restorePaths));
  moduleAdapter.register('git.push' as ModuleTargetName, toModuleHandler(gitOperations.push));
  moduleAdapter.register('git.fetch' as ModuleTargetName, toModuleHandler(gitOperations.fetch));
  moduleAdapter.register('git.syncBase' as ModuleTargetName, toModuleHandler(gitOperations.syncBase));

  // S10 — the host surface behind the adapter. The credential goes through
  // the same three-step preparation the remote git operations use, so the
  // reference's own allowed-host constraint is checked before `gh` runs.
  const hostAdapter = createGitHubAdapter({
    clock: systemClock,
    exec,
    credentialFor: async (ctx) => {
      const prepared = await prepareDeclarationCredential({ declarations, credentials, credentialEnv }, ctx);
      if (!prepared.ok) return err(hostError({ code: 'unreachable' }, prepared.error.summary));
      return ok(prepared.value.credential);
    },
  });
  const hostOperations = createHostOperations({
    clock: systemClock,
    adapter: hostAdapter,
    journal,
    headShaFor: async (ctx) => {
      if (ctx.cloneRoot === null) return null;
      const head = await exec.runGit({ argv: ['rev-parse', 'HEAD'], cwd: ctx.cloneRoot, timeoutSeconds: 30, credential: null, signal: ctx.signal });
      if (!head.ok) return null;
      const sha = head.value.stdout.trim();
      return sha.length > 0 ? (sha as GitSha) : null;
    },
  });
  moduleAdapter.register('host.createPullRequest' as ModuleTargetName, toModuleHandler(hostOperations.createPullRequest));
  moduleAdapter.register('host.readPullRequest' as ModuleTargetName, toModuleHandler(hostOperations.readPullRequest));
  moduleAdapter.register('host.listPullRequests' as ModuleTargetName, toModuleHandler(hostOperations.listPullRequests));
  moduleAdapter.register('host.readPullRequestComments' as ModuleTargetName, toModuleHandler(hostOperations.readPullRequestComments));
  moduleAdapter.register('host.enableAutoMerge' as ModuleTargetName, toModuleHandler(hostOperations.enableAutoMerge));
  moduleAdapter.register('host.readChecks' as ModuleTargetName, toModuleHandler(hostOperations.readChecks));
  moduleAdapter.register('host.awaitChecks' as ModuleTargetName, toModuleHandler(hostOperations.awaitChecks));

  const contractCapabilitySet = new Set(PRODUCTION_TOOL_DECLARATIONS.flatMap((e) => e.capabilities)) as unknown as ContractCapabilitySet;

  // S8 — the recovery catalogue, populated here from L2 and read by L1. A
  // duplicate registration is a wiring defect and fatal at composition time,
  // which is the only time it can happen.
  const recoveryCatalogue = createRecoveryCatalogue();
  for (const descriptor of [...LOCAL_MUTATION_RECOVERY_DESCRIPTORS, ...REMOTE_OPERATION_RECOVERY_DESCRIPTORS, PR_OPEN_RECOVERY, PR_ENABLE_AUTO_MERGE_RECOVERY]) {
    const registered = recoveryCatalogue.register(descriptor);
    if (!registered.ok) {
      console.error(`server: ${registered.error.summary}`);
      process.exit(1);
      return;
    }
  }

  // `dispatch` is not wired into recovery here: no descriptor registered
  // above returns a resume step, so no resume can be reached. The seam is in
  // `RecoveryDependencies` and S12's composites fill it when they bring
  // descriptors that do resume.
  const recovery = {
    journal,
    catalogue: recoveryCatalogue,
    clock: systemClock,
    declarations,
    cloneStore,
  };

  const lifecycle = createLifecycle({
    volumeRoot,
    buildDir,
    clock: systemClock,
    store,
    audit,
    operatorIdentity,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ceiling,
    deriveCloneStatesFromDisk: () => cloneStore.deriveAllStatesFromDisk(),
    registryEntries: PRODUCTION_TOOL_DECLARATIONS,
    registeredModuleTargets: moduleAdapter.registeredTargets(),
    recovery,
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

  const registry: CompiledRegistry = {
    fingerprint: booted.value.registryFingerprint,
    compiledAt: systemClock.now(),
    entries: PRODUCTION_TOOL_DECLARATIONS,
    contractCapabilitySet,
  };
  const dispatchPipeline = createDispatchPipeline({
    registry,
    ceiling,
    moduleAdapter,
    declarations,
    cloneStore,
    locks,
    audit,
    journal,
    exec,
    clock: systemClock,
    recoverDeclaration: (declarationId) => lifecycle.recoverDeclaration(declarationId),
  });

  const server = createSurfacesServer({
    commitSha,
    contractFingerprint: booted.value.registryFingerprint,
    consoleFingerprint: booted.value.consoleFingerprint,
    ready: () => ready,
    // Live, not `booted.value.provisioningPending`: that field is a one-time
    // snapshot from boot, and enrolment can complete afterwards with no
    // restart (`10-design.md` § First provisioning).
    provisioningPending: () => operatorIdentity.provisioningState().then((state) => state === 'pending'),
    auditChain: () => audit.chainState(),
    operatorApiToken,
    declarationsAwaitingRecovery: async () => new Set((await journal.allUnsettled()).map((entry) => entry.declarationId as string)),
    parkedOperations: () => journal.parked(),
    observeGitState: async (declarationId) => {
      const observed = await cloneStore.observeGitState(declarationId);
      return observed.ok ? observed.value : null;
    },
    // The parked view's way out. Settling the entry and clearing the clone's
    // mark are two writes to two stores and cannot be atomic; the entry is
    // settled first, because a settled entry with a still-marked clone is
    // repairable from this same route, whereas a cleared clone with a parked
    // entry would readmit ordinary traffic to a tree still under question.
    resolveParkedOperation: async (operationId, actor) => {
      // The entry is located before anything is written: settling an
      // operation that is not parked would be a state change nobody asked
      // for, and `settle` alone cannot tell the difference.
      const parkedBefore = await journal.parked();
      const entry = parkedBefore.find((candidate) => candidate.operationId === operationId);
      if (!entry) return { ok: false, summary: `no parked operation '${operationId}'` };

      const settled = await journal.settle(operationId, null);
      if (!settled.ok) return { ok: false, summary: settled.error.summary };

      // The clone is unparked only when this was the declaration's *last*
      // parked entry. Two entries can park the same repository, and clearing
      // on the first would readmit ordinary traffic while the second is still
      // outstanding.
      const othersStillParked = parkedBefore.some(
        (candidate) => candidate.declarationId === entry.declarationId && candidate.operationId !== operationId,
      );
      if (othersStillParked) {
        return { ok: true, summary: `operation ${operationId} settled; '${entry.declarationId}' stays parked on its remaining entries` };
      }

      const cleared = await cloneStore.clearAttention(entry.declarationId, actor);
      return cleared.ok
        ? { ok: true, summary: `operation ${operationId} settled and '${entry.declarationId}' returned to ready` }
        : { ok: false, summary: cleared.error.summary };
    },
    failingCredentialRefs: () => credentials.listFailing(),
    clearFailingCredential: (ref, declarationId) => credentials.clearFailing(ref, declarationId),
    identity: operatorIdentity,
    sessionAbsoluteSeconds: SESSION_ABSOLUTE_SECONDS_DEFAULT,
    declarations,
    cloneStore,
    dispatchPipeline,
    contractCapabilitySet,
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
