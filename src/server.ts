import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSha, type BranchName, type GitSha, type HttpsUrl, type RemoteHost } from './shared/brands.ts';
import type { CapabilityName, DeploymentCeiling, SessionGrant } from './contract/capabilities.ts';
import { systemClock } from './clock/clock.ts';
import { createStructuredStore } from './store/structured-store.ts';
import { createAudit } from './audit/audit.ts';
import { createLifecycle } from './lifecycle/boot.ts';
import { createOperatorIdentity, SESSION_ABSOLUTE_SECONDS_DEFAULT } from './operator-identity/operator-identity.ts';
import { createExec } from './exec/exec.ts';
import type { CredentialBinding } from './exec/exec.ts';
import { createLocks } from './locks/locks.ts';
import type { AdmissionLimits } from './locks/types.ts';
import { createDeclarations } from './declarations/declarations.ts';
import { createCloneStore, type CloneStore } from './clone/clone-store.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './surfaces/http-server.ts';
import { createMcpRoutesState } from './surfaces/mcp-routes.ts';
import { createGitOperations } from './git/git-operations.ts';
import { createJournal } from './journal/journal.ts';
import { createNotifier } from './notifier/notifier.ts';
import { createRecoveryCatalogue } from './recovery/catalogue.ts';
import { GIT_RAW_RECOVERY, LOCAL_MUTATION_RECOVERY_DESCRIPTORS, REMOTE_OPERATION_RECOVERY_DESCRIPTORS } from './git/recovery-descriptors.ts';
import { createCredentialResolver } from './credentials/credentials.ts';
import { prepareDeclarationCredential } from './credentials/declaration-credential.ts';
import { ok, err } from './shared/outcome.ts';
import { NO_VOLUME_USAGE } from './store/volume-usage.ts';
import { createGitHubAdapter } from './host/github-adapter.ts';
import { createHostOperations } from './host/host-operations.ts';
import { PR_ENABLE_AUTO_MERGE_RECOVERY, PR_OPEN_RECOVERY } from './host/recovery-descriptors.ts';
import type { EnvVarName, OperationId } from './shared/brands.ts';
import { createModuleAdapter, toModuleHandler } from './module-adapter/module-adapter.ts';
import { createDispatchPipeline, type Dispatch } from './dispatch/dispatch-pipeline.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from './composition-root/production-declarations.ts';
import type { ModuleTargetName } from './shared/brands.ts';
import type { ContractCapabilitySet } from './contract/capabilities.ts';
import type { CompiledRegistry } from './contract/tool-declaration.ts';
import { createComposites } from './composites/composites.ts';
import { createWatcher } from './watcher/watcher.ts';
import { COMPOSITE_RECOVERY_DESCRIPTORS } from './composites/recovery-descriptors.ts';
import { createHttpAdapter } from './http/http-adapter.ts';
import { createAuthorization } from './authorization/authorization.ts';
import { createScheduler, createSchedulerOperations, type Scheduler } from './scheduler/scheduler.ts';
import type { Session } from './shared/session.ts';
import type { GrantEpoch, SessionId, Subject } from './shared/brands.ts';

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

/** The public origin MCP clients see — `20-contract.md` § L5, needed for absolute OAuth metadata URLs and the `resource_metadata` challenge. No fixed default a deployment can rely on; falls back to loopback so a local run still has something honest to report. */
function resolveOrigin(port: number): string {
  return process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
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

/**
 * `DeploymentConfig.admission`. The contract records these as deployment-set
 * and fixes no default (U6), so they are read here rather than left to
 * `createLocks`' own fallback — production running on a library default is
 * exactly the "invented values" case, and it is invisible.
 *
 * Unlike the allowlist and the ceiling, empty is not the safe direction: a
 * zero limit refuses every monitoring wait. So an unset variable takes the
 * documented default and a malformed one is fatal, rather than quietly
 * becoming zero.
 */
function resolveAdmissionLimits(): AdmissionLimits {
  const read = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim().length === 0) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      console.error(`server: ${name} must be an integer of at least 1 (got '${raw}')`);
      process.exit(1);
    }
    return value;
  };
  return {
    mutationQueueDepth: read('ADMISSION_MUTATION_QUEUE_DEPTH', 32),
    concurrentWaitsPerSession: read('ADMISSION_CONCURRENT_WAITS_PER_SESSION', 4),
    concurrentLockFreeOperations: read('ADMISSION_CONCURRENT_LOCK_FREE_OPERATIONS', 16),
  };
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

/** `DeploymentConfig.notifierWebhook` — `null` until configured is the safe direction: no transport means outbox rows accumulate `pending` rather than sending anywhere unintended. */
function resolveNotifierWebhook(): HttpsUrl | null {
  const raw = process.env.NOTIFIER_WEBHOOK_URL;
  if (!raw || raw.trim().length === 0) return null;
  if (!raw.startsWith('https://')) {
    console.error(`server: NOTIFIER_WEBHOOK_URL must be an https:// URL (got '${raw}')`);
    process.exit(1);
  }
  return raw as HttpsUrl;
}

/**
 * How often the composition root drives `deliverPending`.
 *
 * **The contract fixes no value for this.** `RetentionWindows` and
 * `TimeoutBudget` name every operational number the design settled, and a
 * notifier delivery cadence is not among them — so this is a deployment-set
 * value with a documented fallback, read the same way the admission limits
 * are, rather than a constant invented in a module and invisible in
 * production. 30 s is chosen to be well under any human's idea of "promptly"
 * while leaving a hanging endpoint's bounded retry room to finish between
 * passes; it is not a number the design blessed.
 */
function resolveNotifierIntervalSeconds(): number {
  const raw = process.env.NOTIFIER_INTERVAL_SECONDS;
  if (raw === undefined || raw.trim().length === 0) return 30;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`server: NOTIFIER_INTERVAL_SECONDS must be an integer of at least 1 (got '${raw}')`);
    process.exit(1);
  }
  return value;
}

/**
 * How often the composition root drives `Scheduler.tick`. No contract knob
 * exists for this — `20-contract.md`'s `Scheduler` interface has no
 * start/stop, unlike `Watcher`'s (§ L2 — watcher), because a tick engine
 * owning its own timer cannot be driven deterministically by a test; the
 * composition root's job, the same reasoning `resolveNotifierIntervalSeconds`
 * above already documents for the identical shape. 15 s matches the
 * watcher's own default poll interval — the slack a caller's `notBefore`
 * can be off by before firing.
 */
function resolveSchedulerIntervalSeconds(): number {
  const raw = process.env.SCHEDULER_TICK_INTERVAL_SECONDS;
  if (raw === undefined || raw.trim().length === 0) return 15;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`server: SCHEDULER_TICK_INTERVAL_SECONDS must be an integer of at least 1 (got '${raw}')`);
    process.exit(1);
  }
  return value;
}

/** `DeploymentConfig.remoteOperationsPermitted` (`20-contract.md` § Deployment configuration) — default off, so an unset variable never grants it. */
function resolveRemoteOperationsPermitted(): boolean {
  return process.env.REMOTE_OPERATIONS_PERMITTED === 'true';
}

/** `DeploymentConfig.watcher.enabled` — default off, the same direction as `remoteOperationsPermitted`. */
function resolveWatcherEnabled(): boolean {
  return process.env.WATCHER_ENABLED === 'true';
}

/**
 * `DeploymentConfig.watcher.pollIntervalSeconds` — contract default 15. The
 * strict check only applies when the watcher is actually enabled: a
 * deployment that never opted in must not be taken down by a stray malformed
 * value it was never going to use.
 */
function resolveWatcherPollIntervalSeconds(watcherEnabled: boolean): number {
  const raw = process.env.WATCHER_POLL_INTERVAL_SECONDS;
  if (raw === undefined || raw.trim().length === 0) return 15;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    if (!watcherEnabled) return 15;
    console.error(`server: WATCHER_POLL_INTERVAL_SECONDS must be an integer of at least 1 (got '${raw}')`);
    process.exit(1);
  }
  return value;
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
  const locks = createLocks(resolveAdmissionLimits());
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
  // S16.5 — the same forward-reference shape as `cloneStoreRef` above, for
  // the same reason: `Scheduler` (L2) depends on `Declarations` (L1)
  // already, so `Declarations` cannot import `Scheduler`'s own type without
  // a cycle. `orphan` only ever calls this after boot, well after
  // `schedulerRef` below is set.
  let schedulerRef: Pick<Scheduler, 'cancelForDeclaration'> | null = null;
  const declarations = createDeclarations({
    volumeRoot,
    clock: systemClock,
    remoteHostAllowlist,
    ceiling,
    registryEntry: (tool) => PRODUCTION_TOOL_DECLARATIONS.find((entry) => entry.name === tool) ?? null,
    cancelScheduledJobsForDeclaration: (declarationId, reason, tx) => {
      if (!schedulerRef) throw new Error('server: declarations orphan cascade accessed before composition finished');
      return schedulerRef.cancelForDeclaration(declarationId, reason, tx);
    },
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
  const journal = createJournal({ volumeRoot, clock: systemClock });

  // The five S6 read tools plus S7's three local mutating tools: git
  // operations dispatched through a module adapter and the dispatch
  // pipeline. `PRODUCTION_TOOL_DECLARATIONS` is plain data (no compiler
  // call), which is what keeps invariant B8 (the compiler absent from the
  // runtime image) intact here.
  const gitOperations = createGitOperations({ clock: systemClock, exec, locks, audit, journal, declarations, credentials, credentialEnv, cloneStore });
  const notifier = createNotifier({ volumeRoot, clock: systemClock, webhookUrl: resolveNotifierWebhook() });
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
  moduleAdapter.register('git.raw' as ModuleTargetName, toModuleHandler(gitOperations.raw));

  // S10 — the host surface behind the adapter. The credential goes through
  // the same three-step preparation the remote git operations use, so the
  // reference's own allowed-host constraint is checked before `gh` runs.
  // The seam between L2's credential preparation and the adapter that uses
  // the result, keyed by `operationId`. The same shape as `credentialEnv`
  // above: one map, handed to both sides, so the value passes between them
  // without appearing in either signature.
  const hostCredentialBindings = new Map<OperationId, CredentialBinding | null>();
  const hostAdapter = createGitHubAdapter({
    clock: systemClock,
    exec,
    // Reads what L2 already prepared for this call. The adapter never
    // resolves a credential itself: preparation happens before any network
    // contact, so a failure there is not a host failure, and `HostError` has
    // no variant that could carry an authorization denial honestly.
    credentialFor: (ctx) => hostCredentialBindings.get(ctx.operationId) ?? null,
    // The declaration's base, passed explicitly to `gh pr create`. Without it
    // the host picks its own default branch, which is the one branch the
    // declaration never authorised.
    baseBranchFor: async (ctx) => {
      const config = await gitOperations.loadRepositoryConfig(ctx);
      // `RepositoryConfig.baseBranch` is a plain `string` in the code and a
      // `BranchName` in the contract — the drift tracked in issue #38, not
      // this slice's to resolve. The cast is the drift, named.
      return config.ok ? (config.value.baseBranch as BranchName) : null;
    },
  });
  const hostOperations = createHostOperations({
    clock: systemClock,
    adapter: hostAdapter,
    journal,
    // Preparation lives here, one layer above the adapter, so an allowed-host
    // denial stays `authorization` rather than becoming a retryable-looking
    // `upstream` — the same layering the remote git operations already use.
    prepareCredential: async (ctx) => {
      const prepared = await prepareDeclarationCredential({ declarations, credentials, credentialEnv }, ctx);
      return prepared.ok ? ok(prepared.value.credential) : err(prepared.error);
    },
    credentialBindings: hostCredentialBindings,
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

  // S12 — the two composites, journaling every sub-step through the same
  // `Journal` S7's local mutations never needed to.
  const composites = createComposites({ clock: systemClock, exec, gitOperations, hostOperations, journal });
  moduleAdapter.register('composites.prepareBranch' as ModuleTargetName, toModuleHandler(composites.prepareBranch));
  moduleAdapter.register('composites.reconcileAfterMerge' as ModuleTargetName, toModuleHandler(composites.reconcileAfterMerge));

  // S12 — the http adapter, published-URL verification's one consumer. No
  // credential dependency (S12.7): constructed from `clock` alone.
  const httpAdapter = createHttpAdapter({ clock: systemClock });

  const contractCapabilitySet = new Set(PRODUCTION_TOOL_DECLARATIONS.flatMap((e) => e.capabilities)) as unknown as ContractCapabilitySet;

  // S13 — clients, grants, opaque operator-api tokens verified by stored
  // hash, and the revocation cascade. Replaces the shared-secret bearer
  // stand-in `http-server.ts` carried since S2: a script's credential is now
  // issued from the grants view (`/grants/tokens`), not a static env var.
  const authorization = createAuthorization({ volumeRoot, clock: systemClock, contractCapabilitySet, ceiling, declarations, audit });

  // S8 — the recovery catalogue, populated here from L2 and read by L1. A
  // duplicate registration is a wiring defect and fatal at composition time,
  // which is the only time it can happen.
  const recoveryCatalogue = createRecoveryCatalogue();
  for (const descriptor of [
    ...LOCAL_MUTATION_RECOVERY_DESCRIPTORS,
    ...REMOTE_OPERATION_RECOVERY_DESCRIPTORS,
    GIT_RAW_RECOVERY,
    PR_OPEN_RECOVERY,
    PR_ENABLE_AUTO_MERGE_RECOVERY,
    ...COMPOSITE_RECOVERY_DESCRIPTORS,
  ]) {
    const registered = recoveryCatalogue.register(descriptor);
    if (!registered.ok) {
      console.error(`server: ${registered.error.summary}`);
      process.exit(1);
      return;
    }
  }

  // S12 — the first descriptors that return a `resume` step need `dispatch`
  // wired into recovery. `dispatchPipeline` does not exist yet at this point
  // in composition (it needs the booted registry fingerprint), so this is
  // the same mutable-forward-reference pattern `cloneStoreRef` above already
  // uses to break the cycle: `dispatchRef` is set once `dispatchPipeline` is
  // constructed, well before boot's lazy recovery pass can ever call it.
  let dispatchRef: Dispatch | null = null;

  // S16 — the scheduler, constructed with `dispatch` injected through the
  // same forward reference `recovery.dispatch` below uses: `tick` only ever
  // fires after `dispatchPipeline` exists, well after this closure is set.
  const scheduler = createScheduler({
    volumeRoot,
    clock: systemClock,
    dispatch: (request) => {
      if (!dispatchRef) throw new Error('server: scheduler dispatch accessed before composition finished');
      return dispatchRef(request);
    },
    declarations,
    journal,
    authorization,
    registryEntry: (tool) => PRODUCTION_TOOL_DECLARATIONS.find((entry) => entry.name === tool) ?? null,
    contractCapabilitySet,
    ceiling,
  });
  // Closes the forward reference `declarations`'s `cancelScheduledJobsForDeclaration`
  // opened above — set well before `orphan` can ever be called (boot has not
  // even run yet at this point in composition).
  schedulerRef = scheduler;
  const schedulerOperations = createSchedulerOperations(scheduler, systemClock);
  moduleAdapter.register('scheduler.create' as ModuleTargetName, toModuleHandler(schedulerOperations.create));
  moduleAdapter.register('scheduler.list' as ModuleTargetName, toModuleHandler(schedulerOperations.list));
  moduleAdapter.register('scheduler.cancel' as ModuleTargetName, toModuleHandler(schedulerOperations.cancel));

  // The session a resume runs under. `operator`'s `ActorProfile` is the
  // widest of the four (`declarations/types.ts`'s `OPERATOR_PROFILE`), and
  // `contractCapabilitySet` grants every declaration-scoped capability a
  // resumed composite could need — `declarations.effectiveGrant` still
  // intersects this against the declaration's own grant and the deployment
  // ceiling, so this is a ceiling on what a resume *could* reach, not new
  // authority. The same "everything the registry declares" set the compiled
  // registry and the console operator session (`tool-routes.ts`'s
  // `sessionFor`) already use — not a second, independently-maintained
  // enumeration that could drift from it.
  const recoverySession: Session = {
    id: 'recovery' as SessionId,
    kind: 'operator',
    actorRef: { kind: 'recovery', subject: 'system' as Subject, clientId: null, grantId: null },
    repositoryBinding: null,
    grant: contractCapabilitySet as unknown as SessionGrant,
    writablePathPrefixes: [],
    frozenAtEpoch: 0 as GrantEpoch,
  };
  const recovery = {
    journal,
    catalogue: recoveryCatalogue,
    clock: systemClock,
    declarations,
    cloneStore,
    notifier,
    dispatch: (request: Parameters<Dispatch>[0]) => {
      if (!dispatchRef) throw new Error('server: recovery dispatch accessed before composition finished');
      return dispatchRef(request);
    },
    recoverySession,
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
    registeredHttpOperations: httpAdapter.declaredOperations(),
    revalidateFileWatchers: () => declarations.revalidateFileWatchers(),
    recovery,
    // S16 — boot steps 6 and 7's job half.
    scheduler,
    notifier,
    // S25 — the maintenance pass's retention owners, plus a real
    // structured-store-and-clones volume reading for `usageBefore`/`usageAfter`.
    // Nothing currently calls `lifecycle.runMaintenance` on a schedule: the
    // natural trigger (the 85% watermark) is S27, not this slice.
    journal,
    authorization,
    readVolumeUsage: async () => {
      const usage = await cloneStore.readVolumeUsage();
      return usage.ok ? usage.value : NO_VOLUME_USAGE;
    },
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
    httpAdapter,
    declarations,
    cloneStore,
    locks,
    audit,
    journal,
    exec,
    clock: systemClock,
    recoverDeclaration: (declarationId) => lifecycle.recoverDeclaration(declarationId),
  });
  // Closes the forward reference `recovery.dispatch` opened above — set well
  // before boot's lazy recovery pass can reach a `resume` verdict, since that
  // pass only ever runs from inside a call this same `dispatchPipeline`
  // received (`10-design.md` § Boot and recovery: recovery is lazy, not a
  // boot step).
  dispatchRef = dispatchPipeline.dispatch;

  // S16 — what actually drives `Scheduler.tick`. `Scheduler`'s own contract
  // interface has no start/stop (unlike `Watcher`'s), so this is the
  // composition root's job, the same reasoning and the same reentrancy-guard
  // shape `deliveryTimer` below already uses for `Notifier.deliverPending`:
  // a tick whose dispatched operation outlasts the interval must not let the
  // next firing start a second, overlapping tick against the same rows.
  // Tracked so shutdown can wait for it, same as `deliveryInFlight`.
  let schedulerTickInFlight: Promise<unknown> | null = null;
  const schedulerTimer = setInterval(() => {
    if (schedulerTickInFlight) return;
    schedulerTickInFlight = scheduler
      .tick(systemClock.now())
      .catch((error: unknown) => {
        console.error(`server: scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        schedulerTickInFlight = null;
      });
  }, resolveSchedulerIntervalSeconds() * 1000);
  // Unreferenced, so a pending timer never keeps the process alive on its own.
  schedulerTimer.unref();

  // S17 — the watcher. Both deployment switches default off (`not-permitted`
  // is the expected, ordinary shape of `start()`'s refusal on a deployment
  // that never opted in), so a refusal here is logged, not fatal — unlike
  // `lifecycle.boot()` above, nothing about serving MCP or console traffic
  // depends on the watcher running.
  const watcherEnabled = resolveWatcherEnabled();
  const watcher = createWatcher({
    volumeRoot,
    clock: systemClock,
    dispatch: dispatchPipeline.dispatch,
    declarations,
    cloneStore,
    audit,
    notifier,
    store,
    contractCapabilitySet,
    remoteOperationsPermitted: resolveRemoteOperationsPermitted(),
    watcherEnabled,
    pollIntervalSeconds: resolveWatcherPollIntervalSeconds(watcherEnabled),
  });
  const watcherStarted = await watcher.start();
  if (!watcherStarted.ok) {
    console.log(`server: watcher not started (${watcherStarted.error.summary})`);
  }

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
    authorization,
    // Both of these feed the operator's health view, and both fail closed on
    // an unreadable journal rather than rendering "nothing awaiting recovery"
    // and "no parked operations" — the two readings an operator would act on
    // by doing nothing.
    declarationsAwaitingRecovery: async () => {
      const unsettled = await journal.allUnsettled();
      if (!unsettled.ok) throw new Error(`the operation journal could not be read: ${unsettled.error.summary}`);
      return new Set(unsettled.value.map((entry) => entry.declarationId as string));
    },
    parkedOperations: async () => {
      const parked = await journal.parked();
      if (!parked.ok) throw new Error(`the operation journal could not be read: ${parked.error.summary}`);
      return parked.value;
    },
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
      const parkedRead = await journal.parked();
      if (!parkedRead.ok) return { ok: false, summary: parkedRead.error.summary };
      const parkedBefore = parkedRead.value;
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
    failedOutboxRows: async () => (await notifier.listFailed()).length,
    identity: operatorIdentity,
    sessionAbsoluteSeconds: SESSION_ABSOLUTE_SECONDS_DEFAULT,
    declarations,
    cloneStore,
    dispatchPipeline,
    contractCapabilitySet,
    origin: resolveOrigin(port),
    mcpState: createMcpRoutesState(),
  });

  // What actually drives delivery. Boot re-drives once, and recovery fires a
  // pass after settling a terminal state — but a notification enqueued during
  // ordinary operation had nothing to send it until the next restart, which
  // makes "unwatched" mean "unnoticed" for exactly as long as the process
  // stays up. This is the composition root's job rather than a member on
  // `Notifier`: the contract's interface has no start/stop, and a module that
  // owns its own timer cannot be driven deterministically by a test.
  // Tracked so shutdown can wait for it. `Notifier` serialises its own passes,
  // so this is not a concurrency guard — it is the handle that keeps a pass
  // from outliving the instance lease.
  let deliveryInFlight: Promise<unknown> | null = null;
  const deliveryTimer = setInterval(() => {
    if (deliveryInFlight) return;
    deliveryInFlight = notifier
      .deliverPending()
      .then((report) => {
        // Summarised, never one line per row. A deployment with no webhook
        // and a few hundred accumulated rows would otherwise print the same
        // sentence hundreds of times every interval, burying every other
        // diagnostic and filling the volume the design works to keep bounded.
        if (report.errors.length === 0) return;
        const distinct = new Map<string, number>();
        for (const error of report.errors) distinct.set(error.summary, (distinct.get(error.summary) ?? 0) + 1);
        const rendered = [...distinct.entries()].slice(0, 3).map(([summary, count]) => (count > 1 ? `${summary} (×${count})` : summary));
        const remainder = distinct.size > rendered.length ? `, and ${distinct.size - rendered.length} other kind(s)` : '';
        console.warn(
          `server: notifier delivered ${report.delivered}, failed ${report.failed}, still pending ${report.stillPending} — ${rendered.join('; ')}${remainder}`,
        );
      })
      .catch(() => {
        // `deliverPending` reports rather than throwing; this is belt and
        // braces so a future implementation cannot kill the timer.
      })
      .finally(() => {
        deliveryInFlight = null;
      });
  }, resolveNotifierIntervalSeconds() * 1000);
  // Unreferenced, so a pending timer never keeps the process alive on its own.
  deliveryTimer.unref();

  const shutdown = (signal: NodeJS.Signals): void => {
    ready = false;
    clearInterval(deliveryTimer);
    clearInterval(schedulerTimer);
    // `watcher.stop()` itself waits out any tick already in flight (a tick
    // does the same class of writes as a delivery pass — git push, PR open,
    // store/audit transactions), so it is awaited alongside `deliveryInFlight`
    // below rather than fired-and-forgotten.
    const watcherStopped = watcher.stop();
    server.close(() => {
      // A delivery pass holds its own connections to `store.sqlite`, so
      // releasing the lease while one is still running would let this
      // process keep writing after a replacement has taken the volume —
      // two writers, which is the single invariant the lease exists for.
      // Bounded because every attempt now carries a timeout. `schedulerTickInFlight`
      // joins the same wait: a tick mid-dispatch holds the identical class of
      // store/audit/journal connections.
      void Promise.resolve(deliveryInFlight)
        .catch(() => undefined)
        .then(() => Promise.resolve(schedulerTickInFlight).catch(() => undefined))
        .then(() => watcherStopped.catch(() => undefined))
        .then(() => lifecycle.shutdown('signal'))
        .then(() => process.exit(0));
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
