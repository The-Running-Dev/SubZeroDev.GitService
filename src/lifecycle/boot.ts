import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { DeclarationId, OperationId, RegistryToolName, ScheduledJobId, Sha256Hex, Subject } from '../shared/brands.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { CapabilityName } from '../contract/capabilities.ts';
import type { Clock } from '../clock/clock.ts';
import type { Clone } from '../clone/types.ts';
import type { AuditChainState } from '../audit/types.ts';
import type { Audit } from '../audit/audit.ts';
import type { StructuredStore } from '../store/structured-store.ts';
import type { StoreError } from '../store/errors.ts';
import { acquireLease, type InstanceLease, type LeaseGuard, type LockAcquirer } from './lease.ts';
import { verifyRegistryArtifact } from './registry-integrity.ts';

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
 * The remaining `BootReport` members still belong to subsystems that do not
 * exist yet, and are reported at their empty values rather than invented:
 *
 *   provisioningPending — operator identity, S4
 *   jobsResolved        — the scheduler, S16
 *   revalidation        — needs both of the above
 *   recoveryPending     — recovery, S8
 *   clones              — step 8 re-derives from disk; S5 owns clone
 *                         directories, so with none declared this is empty,
 *                         which is the correct answer rather than a stub
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
  shutdown(reason: ShutdownReason): Promise<void>;
}

export interface LifecycleDependencies {
  readonly volumeRoot: string;
  readonly buildDir: string;
  readonly clock: Clock;
  readonly store: StructuredStore;
  readonly audit: Audit;
  readonly consoleFingerprint: Sha256Hex;
  readonly acquirer?: LockAcquirer;
  /** Fires alongside the durable `lease-takeover` audit record — operator-visible even if the trail itself cannot be written. */
  readonly onTakeover?: (previousHolder: InstanceLease, current: InstanceLease) => void;
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

      // Step 8 — re-derive clone state from disk. S5 owns clone directories;
      // with none declared, the derived set is genuinely empty.
      return ok({
        lease: leaseResult.value.lease,
        leaseSelfTestPassed: leaseResult.value.selfTestPassed,
        registryFingerprint: registry.value.contractFingerprint,
        consoleFingerprint: deps.consoleFingerprint,
        migrationsApplied: migrated.value,
        provisioningPending: false,
        auditChain,
        jobsResolved: NO_JOBS,
        revalidation: { jobsParked: [], entriesParked: [] },
        clones: [],
        recoveryPending: [],
      });
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
