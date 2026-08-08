import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { DeclarationId, OperationId, RegistryToolName, ScheduledJobId, Sha256Hex, Subject } from '../shared/brands.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { CapabilityName, DeploymentCeiling } from '../contract/capabilities.ts';
import type { Clock } from '../clock/clock.ts';
import type { Clone } from '../clone/types.ts';
import type { AuditChainState } from '../audit/types.ts';
import type { Audit } from '../audit/audit.ts';
import type { StructuredStore } from '../store/structured-store.ts';
import { storeError, type StoreError } from '../store/errors.ts';
import type { OperatorIdentity } from '../operator-identity/operator-identity.ts';
import type { ModuleTargetName } from '../shared/brands.ts';
import type { ToolDeclaration } from '../contract/tool-declaration.ts';
import type { RecoveryClassification } from '../recovery/types.ts';
import type { Notifier } from '../notifier/notifier.ts';
import { acquireLease, type InstanceLease, type LeaseGuard, type LockAcquirer } from './lease.ts';
import { verifyRegistryArtifact } from './registry-integrity.ts';
import { declarationsWithUnsettledEntries, recoverDeclaration as runRecoveryLadder, type RecoveryDependencies } from './recovery.ts';

export type BootError = ModuleErrorBase &
  (
    | { readonly code: 'lease-held'; readonly holder: InstanceLease }
    | { readonly code: 'lease-not-exclusive' }
    | { readonly code: 'fingerprint-mismatch'; readonly expected: Sha256Hex; readonly found: Sha256Hex }
    | { readonly code: 'registry-unreadable'; readonly reason: string }
    | { readonly code: 'console-manifest-mismatch'; readonly expected: Sha256Hex; readonly found: Sha256Hex }
    | { readonly code: 'ceiling-outside-contract'; readonly capabilities: readonly CapabilityName[] }
    | { readonly code: 'executor-missing'; readonly tools: readonly RegistryToolName[] }
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
 *   jobsResolved        — the scheduler, S16
 *   revalidation        — needs both of the above
 *   recoveryPending     — recovery, S8
 */
export interface BootJobReport {
  readonly markedDone: readonly ScheduledJobId[];
  readonly markedNeedsAttention: readonly ScheduledJobId[];
  readonly returnedToPending: readonly ScheduledJobId[];
  readonly leftRunning: readonly ScheduledJobId[];
}

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
  shutdown(reason: ShutdownReason): Promise<void>;
}

export interface LifecycleDependencies {
  readonly volumeRoot: string;
  readonly buildDir: string;
  readonly clock: Clock;
  readonly store: StructuredStore;
  readonly audit: Audit;
  readonly operatorIdentity: OperatorIdentity;
  readonly consoleFingerprint: Sha256Hex;
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
   * S11. Optional so a `Lifecycle` built before the notifier existed still
   * compiles: without it, boot simply has nothing to re-drive.
   */
  readonly notifier?: Pick<Notifier, 'redriveUndelivered'>;
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

  return {
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

      // Invariant B5 — every registry entry with a module execution target
      // must have a registered executor. Checked here, alongside step 3,
      // for the same reason: a registry entry nothing can execute is a
      // deployment/build wiring defect, not a runtime one, and is cheapest
      // to catch before the store ever opens. Only entries are skippable
      // when neither optional dependency is supplied (S1–S5's empty
      // registries); an http-targeted entry has no adapter to check against
      // yet and is not examined here.
      if (deps.registryEntries && deps.registeredModuleTargets) {
        const missingExecutors = deps.registryEntries
          .filter((entry) => entry.target.kind === 'module' && !deps.registeredModuleTargets!.has(entry.target.target))
          .map((entry) => entry.name);
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

      const failAfterOpen = async (cause: StoreError): Promise<Outcome<BootReport, BootError>> => {
        await deps.store.close();
        if (guard) {
          guard.release();
          guard = null;
        }
        return err(bootError({ code: 'store-failed', cause }, cause.summary));
      };

      const integrity = await deps.store.integrityCheck();
      if (!integrity.ok) return failAfterOpen(integrity.error);

      const backup = await deps.store.backupBeforeMigration();
      if (!backup.ok) return failAfterOpen(backup.error);

      const migrated = await deps.store.migrate();
      if (!migrated.ok) return failAfterOpen(migrated.error);

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

      // Step 8 — re-derive clone state from disk. The stored value is a
      // report, not a source of truth (`10-design.md` § Boot and recovery).
      const clones = deps.deriveCloneStatesFromDisk ? await deps.deriveCloneStatesFromDisk() : [];

      // Recovery is *listed* here, never *run* here. Boot reports which
      // declarations hold unsettled entries so readiness and the transports
      // can come up knowing which ones are `recovery-pending`; the ladder
      // itself runs lazily, on first use (`recoverDeclaration`). A boot that
      // recovered inline would hold the whole service down behind one
      // repository's unfinished work, and — worse — would run resume steps
      // that touch a host before anything was ready to supervise them.
      const recoveryPending = deps.recovery ? declarationsWithUnsettledEntries(await deps.recovery.journal.allUnsettled()) : [];

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
        consoleFingerprint: deps.consoleFingerprint,
        migrationsApplied: migrated.value,
        provisioningPending,
        auditChain,
        jobsResolved: NO_JOBS,
        revalidation: { jobsParked: [], entriesParked: [] },
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
}
