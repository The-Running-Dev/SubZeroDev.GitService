import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { DeclarationId, IsoUtcTimestamp, OperationId, RegistryToolName, ScheduledJobId, Sha256Hex, Subject } from '../shared/brands.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { CapabilityName, DeploymentCeiling } from '../contract/capabilities.ts';
import type { Clock } from '../clock/clock.ts';
import type { Clone, EvictionBlocker, EvictionOutcome } from '../clone/types.ts';
import type { CloneStoreError } from '../clone/errors.ts';
import type { AuditChainState } from '../audit/types.ts';
import type { Audit } from '../audit/audit.ts';
import type { StructuredStore } from '../store/structured-store.ts';
import { storeError, type StoreError } from '../store/errors.ts';
import { DISK_WATERMARKS_DEFAULT, NO_VOLUME_USAGE, type DiskWatermarks, type VolumeUsage } from '../store/volume-usage.ts';
import type { OperatorIdentity } from '../operator-identity/operator-identity.ts';
import type { HttpOperationName, ModuleTargetName } from '../shared/brands.ts';
import type { CompiledRegistry, ToolDeclaration } from '../contract/tool-declaration.ts';
import type { RecoveryClassification } from '../recovery/types.ts';
import type { Journal } from '../journal/journal.ts';
import type { MaintenanceSummary, NotificationRequest } from '../journal/types.ts';
import { type MaintenanceReason, type RetentionReport } from '../shared/retention.ts';
import type { Notifier } from '../notifier/notifier.ts';
import type { Authorization } from '../authorization/authorization.ts';
import type { DeclarationError } from '../declarations/errors.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import type { BootJobReport } from '../scheduler/types.ts';
import type { Watcher } from '../watcher/watcher.ts';
import { acquireLease, type InstanceLease, type LeaseGuard, type LockAcquirer } from './lease.ts';
import { verifyRegistryArtifact } from './registry-integrity.ts';
import { verifyConsoleArtifact } from './console-integrity.ts';
import { declarationsWithUnsettledEntries, recoverDeclaration as runRecoveryLadder, type RecoveryDependencies } from './recovery.ts';

export type BootError = ModuleErrorBase &
  (
    | { readonly code: 'lease-held'; readonly holder: InstanceLease }
    | { readonly code: 'lease-not-exclusive' }
    | { readonly code: 'fingerprint-mismatch'; readonly expected: Sha256Hex; readonly found: Sha256Hex }
    | { readonly code: 'registry-unreadable'; readonly reason: string }
    | { readonly code: 'console-manifest-mismatch'; readonly expected: Sha256Hex; readonly found: Sha256Hex }
    | { readonly code: 'console-unreadable'; readonly reason: string }
    | { readonly code: 'ceiling-outside-contract'; readonly capabilities: readonly CapabilityName[] }
    | { readonly code: 'executor-missing'; readonly tools: readonly RegistryToolName[] }
    | { readonly code: 'watcher-revalidation-failed'; readonly cause: DeclarationError }
    | { readonly code: 'store-failed'; readonly cause: StoreError }
  );

function bootError<T extends { readonly code: BootError['code'] }>(variant: T, summary: string): BootError {
  return { resultKind: 'infrastructure', retryable: false, summary, ...variant } as unknown as BootError;
}

/**
 * S2 delivers boot steps 1, 4 and 8, and carries step 2 forward from S1. S3
 * adds the audit trail: a lease takeover is now a real, verifiable record,
 * and `auditChain` is boot's own `verify()` result rather than a placeholder.
 * S4 makes `provisioningPending` a real read of the operator identity module
 * rather than the constant `false` it reported before an operator credential
 * had anywhere to live. S5 adds step 3's ceiling check and delivers step 8
 * for real: `clones` is `CloneStore.deriveAllStatesFromDisk()`'s result
 * rather than the always-empty placeholder it used to be. The remaining
 * `BootReport` members still belong to subsystems that do not exist yet, and
 * are reported at their empty values rather than invented:
 *
 *   recoveryPending     — recovery, S8
 *
 * S16 delivers `jobsResolved` (boot step 6, `Scheduler.resolveRunningAtBoot`)
 * and the job half of `revalidation` (boot step 7, `Scheduler.revalidatePending`).
 * `BootJobReport` itself is declared in `scheduler/types.ts`, alongside the
 * module that produces it, and imported here type-only — the same pattern
 * `RecoveryDependencies.dispatch` already uses for an L4 shape.
 */
export interface RevalidationReport {
  readonly jobsParked: readonly ScheduledJobId[];
  readonly entriesParked: readonly OperationId[];
}

export interface BootReport {
  readonly lease: InstanceLease;
  readonly leaseSelfTestPassed: boolean;
  readonly registryFingerprint: Sha256Hex;
  readonly consoleFingerprint: Sha256Hex;
  readonly migrationsApplied: number;
  readonly provisioningPending: boolean;
  readonly auditChain: AuditChainState;
  readonly jobsResolved: BootJobReport;
  readonly revalidation: RevalidationReport;
  readonly clones: readonly Clone[];
  readonly recoveryPending: readonly DeclarationId[];
}

export type ShutdownReason = 'signal' | 'fatal' | 'operator';

export type { MaintenanceReason };

export interface MaintenanceReport {
  readonly reason: MaintenanceReason;
  readonly startedAt: IsoUtcTimestamp;
  readonly finishedAt: IsoUtcTimestamp;
  readonly perModule: readonly RetentionReport[];
  readonly evictions: readonly EvictionOutcome[];
  readonly usageBefore: VolumeUsage;
  readonly usageAfter: VolumeUsage;
}

export interface Lifecycle {
  boot(): Promise<Outcome<BootReport, BootError>>;
  /**
   * The lazy pass, called on first use and by the background sweep
   * (`20-contract.md` § L1 — lifecycle). Deliberately **not** called by
   * `boot`: readiness and the transports come up first, so a declaration
   * with unsettled entries serves reads while it waits to be recovered
   * rather than holding the whole service down.
   */
  recoverDeclaration(declarationId: DeclarationId): Promise<Outcome<readonly RecoveryClassification[], BootError>>;
  /**
   * S25 (`20-contract.md` § L1 — lifecycle, § Volume, retention and
   * maintenance). Drives every currently-wired owner's `runRetention` in a
   * fixed order, with no mutation lock held, ends with the structured
   * store's `incrementalVacuum`, and enqueues exactly one `info` maintenance
   * summary — never one notification per module or per row. S27 adds
   * eviction: once every owner above has run, if usage is still at or above
   * `watermarks.maintenanceAtPercent`, the least-recently-used materialised
   * clones are evicted (`10-design.md` § disk pressure: "evicts safe clones
   * only if that was not enough") until usage drops back below it or no more
   * candidates remain — never under the global mutation lock (rule 3), and
   * only through `CloneStore.evictIfSafe`, which takes the declaration's own
   * materialisation lock in its own right. S26 drives this on a schedule
   * from the composition root (`server.ts`'s `maintenanceTimer`, the same
   * pattern already used for `Scheduler.tick` and `Notifier.deliverPending`)
   * rather than from inside `Lifecycle` — this interface itself still has no
   * start/stop. S27 additionally drives it from `CloneStore.requestMaintenance`
   * when a post-mutation reading crosses `watermarks.maintenanceAtPercent`
   * (`server.ts`'s `onMaintenanceRequested` wiring).
   */
  runMaintenance(reason: MaintenanceReason): Promise<MaintenanceReport>;
  shutdown(reason: ShutdownReason): Promise<void>;
}

export interface LifecycleDependencies {
  readonly volumeRoot: string;
  readonly buildDir: string;
  /**
   * The built console bundle's directory (S18), verified the same way
   * `buildDir` is — a manifest plus a companion `.sha256` hash file written
   * atomically at build time. `console-integrity.ts` mirrors
   * `registry-integrity.ts` exactly.
   */
  readonly consoleDir: string;
  readonly clock: Clock;
  readonly store: StructuredStore;
  readonly audit: Audit;
  readonly operatorIdentity: OperatorIdentity;
  readonly ceiling: DeploymentCeiling;
  /** Step 8 re-derives clone state from disk. Optional so a `Lifecycle` used only up through S4's concerns need not supply one. */
  readonly deriveCloneStatesFromDisk?: () => Promise<readonly Clone[]>;
  /**
   * Invariant B5 (verified at boot: "every registry entry has exactly one
   * executor registered"). Both optional so a `Lifecycle` built before any
   * registry entry existed (S1–S5, always an empty declaration array) needs
   * no change. `registryEntries` is the production declaration set, not the
   * build artifact's re-parsed JSON — the artifact is already verified
   * byte-for-byte against its fingerprint (step 2) and this check only needs
   * to know which module targets a real executor claims.
   */
  readonly registryEntries?: readonly ToolDeclaration[];
  readonly registeredModuleTargets?: ReadonlySet<ModuleTargetName>;
  /** S12 — the same check as `registeredModuleTargets`, for the registry's http-targeted entries. Optional and independent of it: a `Lifecycle` built before the http adapter existed still compiles, and an http-targeted entry is simply not examined until this is supplied. */
  readonly registeredHttpOperations?: ReadonlySet<HttpOperationName>;
  /** Invariant B6 — active declarations must still name a valid plan/apply pair in the registry loaded by this boot. */
  readonly revalidateFileWatchers: () => Promise<Outcome<void, DeclarationError>>;
  readonly acquirer?: LockAcquirer;
  /** Fires alongside the durable `lease-takeover` audit record — operator-visible even if the trail itself cannot be written. */
  readonly onTakeover?: (previousHolder: InstanceLease, current: InstanceLease) => void;
  /**
   * Recovery (S8). Optional as a group, so a `Lifecycle` built before the
   * journal existed still compiles: without them `recoveryPending` is empty
   * and `recoverDeclaration` reports that recovery is not wired, rather than
   * silently claiming there was nothing to recover.
   */
  readonly recovery?: RecoveryDependencies;
  /**
   * S11 (`redriveUndelivered`); S25 (`runRetention`, `enqueue`) widens the
   * same optional dependency rather than adding a second one. Optional as a
   * whole so a `Lifecycle` built before the notifier existed still compiles:
   * without it, boot has nothing to re-drive and `runMaintenance` has
   * nowhere to enqueue its summary.
   */
  readonly notifier?: Pick<Notifier, 'redriveUndelivered' | 'runRetention' | 'enqueue'>;
  /**
   * S25. Optional so a `Lifecycle` built before the journal existed still
   * compiles: without it, `runMaintenance` simply has one fewer owner to
   * drive.
   */
  readonly journal?: Pick<Journal, 'runRetention'>;
  /**
   * S16 — boot steps 6 and 7's job half. S25 widens the same optional
   * dependency with `runRetention` rather than adding a second one. Optional
   * as a whole so a `Lifecycle` built before the scheduler existed still
   * compiles: without it, `jobsResolved` and `revalidation.jobsParked` report
   * their honest empty values rather than a fabricated clean sweep, and
   * `runMaintenance` simply has one fewer owner to drive.
   */
  readonly scheduler?: Pick<Scheduler, 'resolveRunningAtBoot' | 'revalidatePending' | 'runRetention'>;
  /** S25. Same reasoning as `journal` above. */
  readonly authorization?: Pick<Authorization, 'runRetention'>;
  /** S26 — watcher files are a separate filesystem owner from the store. */
  readonly watcher?: Pick<Watcher, 'runRetention'>;
  /**
   * S25. The clone store's own volume figures, folded into
   * `MaintenanceReport.usageBefore`/`usageAfter` alongside the structured
   * store's real per-table bytes. S27 makes this a real, disk-wide reading
   * (`CloneStore.readVolumeUsage`'s own `computeVolumeUsage`) rather than the
   * honest zero it was before that machinery existed.
   */
  readonly readVolumeUsage?: () => Promise<VolumeUsage>;
  /** `20-contract.md` § Deployment configuration. Defaults to 85 / 95 (`DISK_WATERMARKS_DEFAULT`). Only `maintenanceAtPercent` governs eviction here — `refuseAtPercent` is `CloneStore.ensure`'s own threshold. */
  readonly watermarks?: DiskWatermarks;
  /**
   * S27 — eviction's own entry point, injected the same way
   * `deriveCloneStatesFromDisk` already is: `Lifecycle` cannot import
   * `CloneStore` without the module cycle `server.ts`'s `cloneStoreRef`
   * forward reference already exists to break. Optional so a `Lifecycle`
   * built before S27 still compiles; without it, `evictions` stays empty
   * regardless of usage, the same honest-absence shape every other optional
   * owner here takes.
   */
  readonly evictIfSafe?: (declarationId: DeclarationId) => Promise<Outcome<EvictionOutcome, CloneStoreError>>;
}

const SYSTEM_ACTOR = { kind: 'recovery', subject: 'system' as Subject, clientId: null, grantId: null } as const;

const NO_JOBS: BootJobReport = {
  markedDone: [],
  markedNeedsAttention: [],
  returnedToPending: [],
  leftRunning: [],
};

export function createLifecycle(deps: LifecycleDependencies): Lifecycle {
  let guard: LeaseGuard | null = null;

  const lifecycle: Lifecycle = {
    async boot(): Promise<Outcome<BootReport, BootError>> {
      // Step 1 — the instance lease, and the child-process self-test.
      const leaseResult = acquireLease({
        volumeRoot: deps.volumeRoot,
        clock: deps.clock,
        ...(deps.acquirer ? { acquirer: deps.acquirer } : {}),
      });
      if (!leaseResult.ok) {
        if (leaseResult.error.code === 'lease-held') {
          const holder = leaseResult.error.holder;
          return err(
            bootError(
              { code: 'lease-held', holder },
              `another instance holds the volume: instanceId ${holder.instanceId} on ${holder.hostName}, started ${holder.startedAt}`,
            ),
          );
        }
        return err(
          bootError(
            { code: 'lease-not-exclusive' },
            'the storage volume granted the same exclusive lock to a second process. ' +
              'This volume cannot be used safely — it must be a container-managed named volume, ' +
              'not a bind-mounted host path, whose advisory locking is unreliable across hosts.',
          ),
        );
      }
      guard = leaseResult.value.guard;

      // Step 2 — the registry fingerprint, delivered in S1.
      const registry = await verifyRegistryArtifact(deps.buildDir);
      if (!registry.ok) {
        guard.release();
        guard = null;
        if (registry.error.code === 'fingerprint-mismatch') {
          return err(
            bootError(
              { code: 'fingerprint-mismatch', expected: registry.error.expected, found: registry.error.found },
              `registry fingerprint mismatch: expected ${registry.error.expected}, found ${registry.error.found}`,
            ),
          );
        }
        // Distinct from a mismatch on purpose. A mismatch has two real digests
        // to report; an unreadable artifact has none, and forcing it into that
        // shape would mean fabricating two `Sha256Hex` values that never
        // existed — precisely what the brand is there to prevent.
        return err(
          bootError(
            { code: 'registry-unreadable', reason: registry.error.reason },
            `registry artifact unreadable: ${registry.error.reason}`,
          ),
        );
      }

      // Step 2b — the console asset manifest (S18, invariant B3's console
      // half). Same shape as the registry check just above: a mismatch
      // reports the two real digests, an unreadable artifact reports why
      // rather than fabricating one to compare.
      const consoleArtifact = await verifyConsoleArtifact(deps.consoleDir);
      if (!consoleArtifact.ok) {
        guard.release();
        guard = null;
        if (consoleArtifact.error.code === 'console-manifest-mismatch') {
          return err(
            bootError(
              { code: 'console-manifest-mismatch', expected: consoleArtifact.error.expected, found: consoleArtifact.error.found },
              `console manifest mismatch: expected ${consoleArtifact.error.expected}, found ${consoleArtifact.error.found}`,
            ),
          );
        }
        return err(
          bootError(
            { code: 'console-unreadable', reason: consoleArtifact.error.reason },
            `console artifact unreadable: ${consoleArtifact.error.reason}`,
          ),
        );
      }

      // Step 3 — the deployment ceiling must name only capabilities the
      // contract set actually has. Checked here, ahead of the store, because
      // a ceiling naming a capability nothing in the registry grants is a
      // deployment configuration error, not a runtime one.
      const outsideContract = [...deps.ceiling].filter((c) => !registry.value.contractCapabilitySet.has(c));
      if (outsideContract.length > 0) {
        guard.release();
        guard = null;
        return err(
          bootError(
            { code: 'ceiling-outside-contract', capabilities: outsideContract },
            `the deployment ceiling names ${outsideContract.length} capabilit(y/ies) absent from the contract set: ${outsideContract.join(', ')}`,
          ),
        );
      }

      // Invariant B5 — every registry entry with a module or http execution
      // target must have a registered executor. Checked here, alongside step
      // 3, for the same reason: a registry entry nothing can execute is a
      // deployment/build wiring defect, not a runtime one, and is cheapest
      // to catch before the store ever opens. Module and http targets are
      // checked against an empty set when their own registered-operations
      // dependency is omitted — not skipped — so a registry that gained an
      // http-targeted entry without also wiring `registeredHttpOperations`
      // (or the module equivalent) is still caught here rather than only at
      // first request. `registeredModuleTargets: undefined` and
      // `registeredHttpOperations: undefined` are distinguished from "empty"
      // only by both defaulting to empty: a `Lifecycle` built before either
      // target kind existed still compiles, and a registry with no entry of
      // that kind reports nothing missing regardless.
      if (deps.registryEntries) {
        const moduleTargets = deps.registeredModuleTargets ?? new Set<ModuleTargetName>();
        const httpOperations = deps.registeredHttpOperations ?? new Set<HttpOperationName>();
        const missingModule = deps.registryEntries.filter((entry) => entry.target.kind === 'module' && !moduleTargets.has(entry.target.target));
        const missingHttp = deps.registryEntries.filter((entry) => entry.target.kind === 'http' && !httpOperations.has(entry.target.operation));
        const missingExecutors = [...missingModule, ...missingHttp].map((entry) => entry.name);
        if (missingExecutors.length > 0) {
          guard.release();
          guard = null;
          return err(
            bootError(
              { code: 'executor-missing', tools: missingExecutors },
              `${missingExecutors.length} registry entr(y/ies) have no registered executor: ${missingExecutors.join(', ')}`,
            ),
          );
        }
      }

      // Step 4 — open the store, integrity-check it, take the pre-migration
      // copy, then run forward-only migrations. The copy is taken before
      // migrate on purpose: it is item 18's rollback target.
      //
      // Every failure from here on must close the store as well as release the
      // lease. A caller is entitled to treat a failed boot as "nothing was
      // acquired" and never call shutdown(); leaving the SQLite handle open
      // would hold a file descriptor on the volume for the life of the process.
      const opened = await deps.store.open();
      if (!opened.ok) {
        guard.release();
        guard = null;
        return err(bootError({ code: 'store-failed', cause: opened.error }, opened.error.summary));
      }

      const failAfterOpen = async (error: BootError): Promise<Outcome<BootReport, BootError>> => {
        await deps.store.close();
        if (guard) {
          guard.release();
          guard = null;
        }
        return err(error);
      };
      /** The store's own failures, which are every one of these but the B6 gate below. */
      const failAfterOpenWithStore = (cause: StoreError): Promise<Outcome<BootReport, BootError>> =>
        failAfterOpen(bootError({ code: 'store-failed', cause }, cause.summary));

      const integrity = await deps.store.integrityCheck();
      if (!integrity.ok) return failAfterOpenWithStore(integrity.error);

      const backup = await deps.store.backupBeforeMigration();
      if (!backup.ok) return failAfterOpenWithStore(backup.error);

      const migrated = await deps.store.migrate();
      if (!migrated.ok) return failAfterOpenWithStore(migrated.error);

      // The lease-takeover record can only be written now: audit_chain_head
      // is created by migration 0001, which has just run. Detected at step 1,
      // appended here — never fatal to boot, per invariant S3 (append never
      // throws) and S4 (a chain break is reported, never fatal).
      const takenOverFrom = leaseResult.value.takenOverFrom;
      if (takenOverFrom) {
        await deps.audit.append({
          at: deps.clock.now(),
          operationId: null,
          declarationId: null,
          generation: null,
          tool: null,
          actorRef: SYSTEM_ACTOR,
          context: 'recovery',
          form: 'lease-takeover',
          previousHolder: takenOverFrom,
        });
        if (deps.onTakeover) deps.onTakeover(takenOverFrom, leaseResult.value.lease);
      }

      const auditChain = await deps.audit.verify();
      const provisioningPending = (await deps.operatorIdentity.provisioningState()) === 'pending';

      // Step 6 — resolve every scheduled job left `running` by a killed
      // process, from the journal alone, before anything else touches the
      // scheduler (`10-design.md` § Boot and recovery, step 6). Ahead of the
      // watcher's own B6 revalidation below: both are re-validation against
      // the freshly loaded registry, and the scheduler's job classification
      // reads only the journal (no git or host I/O), so nothing here is
      // ordered behind it — it runs first only because it is named first.
      //
      // Step 7's job half — an image upgrade can rename, remove or
      // re-schema a tool a pending job still references; caught here rather
      // than at fire time. `registryEntries` is the production declaration
      // set this same boot already verified every executor exists for
      // (invariant B5 above), assembled into the `CompiledRegistry` shape
      // `revalidatePending` takes rather than re-deriving it from the build
      // artifact a second time. **Only run when `registryEntries` was
      // actually supplied** — defaulting a missing registry to an empty
      // array here would make `revalidatePending` see every tool as gone
      // and park every pending job `needs-attention` naming an "image
      // upgrade" that never happened (review finding). `registryEntries`
      // absent means "this `Lifecycle` was not given one", not "the
      // registry is empty" — those are different facts, and only the
      // second one is revalidation's to act on. Steps 6 and 7 run
      // concurrently: both re-validate against state loaded earlier in
      // this same boot (the journal; the registry), and neither depends on
      // the other's result.
      const compiledRegistryForRevalidation: CompiledRegistry | null = deps.registryEntries
        ? {
            fingerprint: registry.value.contractFingerprint,
            compiledAt: deps.clock.now(),
            entries: deps.registryEntries,
            contractCapabilitySet: registry.value.contractCapabilitySet,
          }
        : null;
      const [jobsResolved, jobsParked] = await Promise.all([
        deps.scheduler ? deps.scheduler.resolveRunningAtBoot() : Promise.resolve(NO_JOBS),
        deps.scheduler && compiledRegistryForRevalidation ? deps.scheduler.revalidatePending(compiledRegistryForRevalidation) : Promise.resolve([]),
      ]);

      // Invariant B6 — an image upgrade may remove or change a tool named by
      // an active declaration's file-watcher pair. The declarations store is
      // readable only after migration, and this check must finish before
      // clone derivation or readiness admits any work under the drifted
      // authority. Lifecycle owns the ordering; the composition root merely
      // injects the declaration-owned validation operation.
      const watcherRevalidation = await deps.revalidateFileWatchers();
      if (!watcherRevalidation.ok) {
        return failAfterOpen(
          bootError(
            { code: 'watcher-revalidation-failed', cause: watcherRevalidation.error },
            `file-watcher revalidation failed: ${watcherRevalidation.error.summary}`,
          ),
        );
      }

      // Recovery is *listed* here, never *run* here. Boot reports which
      // declarations hold unsettled entries so readiness and the transports
      // can come up knowing which ones are `recovery-pending`; the ladder
      // itself runs lazily, on first use (`recoverDeclaration`). A boot that
      // recovered inline would hold the whole service down behind one
      // repository's unfinished work, and — worse — would run resume steps
      // that touch a host before anything was ready to supervise them.
      //
      // A journal that cannot be read fails the boot rather than reporting an
      // empty `recoveryPending`: an unreadable store and a store holding no
      // unsettled work are indistinguishable in an empty list, and coming up
      // ready on the first while believing the second admits ordinary traffic
      // to repositories whose unfinished work was never classified.
      let recoveryPending: readonly DeclarationId[] = [];
      let entriesParked: readonly OperationId[] = [];
      if (deps.recovery) {
        const unsettled = await deps.recovery.journal.allUnsettled();
        if (!unsettled.ok) {
          return err(
            bootError(
              { code: 'store-failed', cause: storeError({ code: 'io-failed' }, unsettled.error.summary) },
              `the operation journal could not be read, so no declaration's recovery state is known: ${unsettled.error.summary}`,
            ),
          );
        }
        recoveryPending = declarationsWithUnsettledEntries(unsettled.value);

        // Step 7's journal half. "The same upgrade can remove the **recovery
        // descriptor** an unsettled entry depends on... an entry whose tool
        // has no descriptor in the new catalogue is parked as `attention`
        // here rather than falling into a lookup the recovery ladder has no
        // branch for" (`10-design.md` § Boot and recovery, step 7).
        //
        // The ladder's own no-descriptor branch still exists and is still
        // the backstop for an entry written between this sweep and the lazy
        // pass — the design says so. What this sweep buys is *when*: the
        // operator sees the consequence of an image upgrade next to the
        // fingerprint checks that caused it, rather than at 03:00 on first
        // use. Both are store reads, so it costs nothing against lazy
        // recovery.
        //
        // An entry already in `attention` is skipped: it is parked, its
        // reason is whatever parked it, and re-parking would overwrite that
        // with this one.
        const parked: OperationId[] = [];
        for (const entry of unsettled.value) {
          if (entry.state === 'attention') continue;
          if (deps.recovery.catalogue.lookup(entry.tool) !== null) continue;
          const reason = `no recovery descriptor is registered for '${entry.tool}' in the catalogue this image loaded — the tool was removed or renamed by an upgrade`;
          const parkResult = await deps.recovery.journal.park(entry.operationId, reason);
          if (!parkResult.ok) continue;
          await deps.recovery.cloneStore.markAttention(entry.declarationId, reason);
          parked.push(entry.operationId);
        }
        entriesParked = parked;
      }

      // Step 8 — re-derive clone state from disk. The stored value is a
      // report, not a source of truth (`10-design.md` § Boot and recovery).
      //
      // It runs *after* the step 7 sweep above, which is the design's own
      // numbering and, since that sweep began marking clones, now load-bearing
      // rather than incidental: derived first, `clones` would report `ready`
      // for a declaration the same boot had just put in `needs-attention`.
      const clones = deps.deriveCloneStatesFromDisk ? await deps.deriveCloneStatesFromDisk() : [];

      // "Boot re-drives every undelivered row" (`10-design.md` § control flow
      // #1, step 11) — a row left `pending` by the previous process is
      // exactly the notification that most needed to reach an operator, and a
      // restart is the natural checkpoint to try it again.
      //
      // **Fired, never awaited.** An earlier version awaited this, on the
      // reasoning that each attempt is bounded and so nothing here could hold
      // the service down. That was wrong twice over: the bound is per
      // attempt, not per pass, so at the default five attempts a single
      // unreachable row costs ~30 s of backoff and rows are processed
      // sequentially — twenty of them blocked boot for ten minutes, during
      // which `/healthz` does not answer and no transport listens, so an
      // orchestrator kills the container and the replacement does the same
      // thing again. This is the same rule recovery already follows for the
      // same reason (`recoverDeclaration` is deliberately not called here):
      // readiness and the transports come up first, and deferred work runs
      // behind them.
      if (deps.notifier) {
        void deps.notifier.redriveUndelivered().catch(() => {
          // `redriveUndelivered` reports rather than throwing; belt and
          // braces so a boot cannot fail on a notification.
        });
      }

      return ok({
        lease: leaseResult.value.lease,
        leaseSelfTestPassed: leaseResult.value.selfTestPassed,
        registryFingerprint: registry.value.contractFingerprint,
        consoleFingerprint: consoleArtifact.value,
        migrationsApplied: migrated.value,
        provisioningPending,
        auditChain,
        jobsResolved,
        revalidation: { jobsParked, entriesParked },
        clones,
        recoveryPending,
      });
    },

    async recoverDeclaration(declarationId: DeclarationId): Promise<Outcome<readonly RecoveryClassification[], BootError>> {
      if (!deps.recovery) {
        // A `Lifecycle` assembled without the recovery group cannot report
        // "nothing to recover" — it does not know. Saying so is the only
        // honest answer; the alternative reads as a clean bill of health.
        return err(bootError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, 'no journal is wired into this lifecycle') }, 'recovery is not wired into this lifecycle'));
      }
      return ok(await runRecoveryLadder(deps.recovery, declarationId));
    },

    /**
     * S25. Every owner runs in a fixed order, with no mutation lock taken
     * anywhere in this method — the pass never touches `Locks` at all. Each
     * owner's own `runRetention` never throws (`journal.ts`, `notifier.ts`,
     * `operator-identity.ts`, `authorization.ts`, `scheduler.ts` each catch
     * their own store failures into a `RetentionReport` with `skipped` naming
     * the failure), so one owner's failure never stops the rest from running.
     * S27 adds eviction after every owner above has finished — see the doc
     * comment further down, at the point it runs.
     */
    async runMaintenance(reason: MaintenanceReason): Promise<MaintenanceReport> {
      const startedAt = deps.clock.now();

      async function computeUsage(): Promise<VolumeUsage> {
        const byTable = await deps.store.usageByTable();
        const storeByTable = byTable.ok ? byTable.value : NO_VOLUME_USAGE.storeByTable;
        const storeBytes = Object.values(storeByTable).reduce((sum, bytes) => sum + bytes, 0);
        const base = deps.readVolumeUsage ? await deps.readVolumeUsage() : NO_VOLUME_USAGE;
        return { ...base, byConsumer: { ...base.byConsumer, 'structured-store': storeBytes }, storeByTable };
      }

      const usageBefore = await computeUsage();

      // Fixed order (journal, authorization, notifier, scheduler, audit,
      // watcher, then the mandatory operator-identity owner below): an array here, rather than
      // one `if` line per owner, keeps a future owner's retention window one
      // entry away instead of one more copy-pasted guard.
      const perModule: RetentionReport[] = [];
      const optionalOwners: readonly ({ runRetention(): Promise<RetentionReport> } | undefined)[] = [
        deps.journal,
        deps.authorization,
        deps.notifier,
        deps.scheduler,
        deps.audit,
        deps.watcher,
      ];
      for (const owner of optionalOwners) {
        if (owner) perModule.push(await owner.runRetention());
      }
      perModule.push(await deps.operatorIdentity.runRetention());

      // The store owns backup/snapshot retention as well as its table bytes.
      // Run it before the vacuum, then fold both byte figures into its one
      // report so the summary names each filesystem owner exactly once.
      const storeRetention = await deps.store.runRetention();

      // Ends in the vacuum, deliberately last: every owner above has already
      // deleted its rows, so this is the step that actually returns pages to
      // the filesystem (S25.6) rather than one more row-level pass.
      const vacuumed = await deps.store.incrementalVacuum();
      const vacuumBytes = vacuumed.ok ? vacuumed.value : 0;
      perModule.push({
        ...storeRetention,
        freedBytes: storeRetention.freedBytes + vacuumBytes,
        skipped: vacuumed.ok ? storeRetention.skipped : [...storeRetention.skipped, `incremental vacuum failed: ${vacuumed.error.summary}`],
      });

      const usageAfterRetention = await computeUsage();

      // S27.1: every retention owner above has already run, with no
      // mutation lock held anywhere in this method — the pass evicts only
      // once that is done, and only if usage is still at or above the
      // maintenance watermark (`10-design.md` § disk pressure: "evicts safe
      // clones only if that was not enough"). Least-recently-used first
      // (`clone_eviction_order`'s own key, a null `lastOperationAt` sorting
      // as oldest), stopping once usage recomputed locally from each
      // eviction's own `freedBytes` drops back below the watermark or no
      // more candidates remain. `evictIfSafe` takes the declaration's
      // materialisation lock in its own right and never runs against one
      // this method holds — it holds none.
      const watermarks = deps.watermarks ?? DISK_WATERMARKS_DEFAULT;
      const evictions: EvictionOutcome[] = [];
      if (deps.evictIfSafe && deps.deriveCloneStatesFromDisk && usageAfterRetention.usedPercent >= watermarks.maintenanceAtPercent) {
        const clones = await deps.deriveCloneStatesFromDisk();
        const candidates = [...clones].filter((c) => c.state === 'ready').sort((a, b) => (a.lastOperationAt ?? '').localeCompare(b.lastOperationAt ?? ''));
        let runningUsedBytes = usageAfterRetention.usedBytes;
        const totalBytes = usageAfterRetention.totalBytes;
        for (const candidate of candidates) {
          if (totalBytes <= 0 || (runningUsedBytes / totalBytes) * 100 < watermarks.maintenanceAtPercent) break;
          const outcome = await deps.evictIfSafe(candidate.declarationId);
          if (!outcome.ok) {
            // Surfaced rather than silently dropped: an attempt that errors
            // is exactly the state most worth an operator seeing, and
            // dropping it made a pass that tried and failed indistinguishable
            // from one that never found anything to evict.
            console.error(`lifecycle: eviction attempt for '${candidate.declarationId}' failed: ${outcome.error.summary}`);
            evictions.push({ declarationId: candidate.declarationId, evicted: false, freedBytes: 0, blockers: [] });
            continue;
          }
          evictions.push(outcome.value);
          if (outcome.value.evicted) runningUsedBytes = Math.max(0, runningUsedBytes - outcome.value.freedBytes);
        }
      }

      // Re-read only if eviction actually freed something — the ordinary
      // case (nothing evicted, or eviction never ran) reuses the reading
      // already taken, rather than a third disk-wide pass for no reason.
      const usageAfter = evictions.some((e) => e.evicted) ? await computeUsage() : usageAfterRetention;

      // One `info` summary for the whole pass, never one per module or per
      // row (`10-design.md` § Notification). Summed across every module's
      // own `freedBytes` plus every eviction's `freedBytes` (the vacuum's
      // bytes are already folded into the structured-store entry above)
      // rather than just `vacuumBytes`: before S26 every non-vacuum owner
      // reported `freedBytes: 0`, so the vacuum figure alone was the honest
      // total; now that audit/watcher/store/eviction report real bytes, the
      // vacuum figure alone would understate what the pass actually
      // returned to the volume.
      if (deps.notifier) {
        const totalDeleted = perModule.reduce((sum, report) => sum + report.deletedRows, 0);
        const evictedBytes = evictions.reduce((sum, e) => sum + (e.evicted ? e.freedBytes : 0), 0);
        const releasedBytes = perModule.reduce((sum, report) => sum + report.freedBytes, 0) + evictedBytes;
        const evictedDeclarations = evictions.filter((e) => e.evicted).map((e) => e.declarationId);
        const summary: MaintenanceSummary = { kind: 'maintenance-pass', releasedBytes, evictedDeclarations, prunedByModule: perModule };
        const request: NotificationRequest = {
          severity: 'info',
          declarationId: null,
          subject: summary,
          summary: `maintenance pass (${reason}) pruned ${totalDeleted} row(s) and released ${releasedBytes} byte(s) across ${perModule.length} module(s)`,
        };
        const enqueued = await deps.store.transaction(async (tx) => {
          deps.notifier?.enqueue(request, tx);
        });
        // A failed enqueue must not vanish without a trace: there is nowhere
        // else in `MaintenanceReport` to carry it, so it lands on the
        // notifier's own retention entry — the module that owns delivery of
        // this notification in the first place.
        if (!enqueued.ok) {
          const notifierIndex = perModule.findIndex((report) => report.module === 'notifier');
          const notifierReport = notifierIndex === -1 ? undefined : perModule[notifierIndex];
          if (notifierReport) {
            perModule[notifierIndex] = { ...notifierReport, skipped: [...notifierReport.skipped, `maintenance-pass summary not enqueued: ${enqueued.error.summary}`] };
          }
        }
      }

      return {
        reason,
        startedAt,
        finishedAt: deps.clock.now(),
        perModule,
        evictions,
        usageBefore,
        usageAfter,
      };
    },

    async shutdown(_reason: ShutdownReason): Promise<void> {
      // Audit before the store: both hold a handle on the same file, and the
      // module that opened one is the module that releases it.
      await deps.audit.close();
      await deps.store.close();
      if (guard) {
        guard.release();
        guard = null;
      }
    },
  };
  return lifecycle;
}
