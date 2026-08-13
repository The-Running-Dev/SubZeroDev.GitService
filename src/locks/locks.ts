import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { DeclarationId, SessionId } from '../shared/brands.ts';
import { lockError, type LockError } from './errors.ts';
import type { ActivePin, AdmissionLimits, LockHandle, LockHolder, WaitAdmission } from './types.ts';

export interface Locks {
  acquireMutation(holder: LockHolder, waitMs: number, signal: AbortSignal): Promise<Outcome<LockHandle, LockError>>;
  acquireMaterialisation(declarationId: DeclarationId, holder: LockHolder, waitMs: number, signal: AbortSignal): Promise<Outcome<LockHandle, LockError>>;
  pinActiveOperation(declarationId: DeclarationId): ActivePin;
  activeOperationCount(declarationId: DeclarationId): number;
  currentMutationHolder(): LockHolder | null;
  /**
   * Admission for a monitoring wait (S10). Takes **neither mutex** — a
   * monitoring wait holds no lock, which is the whole point of the execution
   * class — and never awaits: admission is refused outright rather than
   * queued, because a caller queueing for permission to wait is
   * indistinguishable from the wait itself.
   */
  admitLockFreeWait(sessionId: SessionId): Outcome<WaitAdmission, LockError>;
}

/**
 * Code defaults, not contract values: `20-contract.md` records both counters
 * as deployment-set and declines to fix them (U6). These bound a forgotten
 * configuration to something finite rather than standing in for a decision.
 */
const ADMISSION_DEFAULTS: AdmissionLimits = {
  mutationQueueDepth: 32,
  concurrentWaitsPerSession: 4,
  concurrentLockFreeOperations: 16,
};

interface Waiter {
  readonly holder: LockHolder;
  settled: boolean;
  settle: (outcome: Outcome<LockHandle, LockError>) => void;
}

/**
 * One mutex, FIFO by arrival (`10-design.md` § Concurrency and ordering:
 * "There is no priority and no fairness beyond arrival order"). Shared by the
 * global mutation lock and every per-declaration materialisation lock — the
 * two differ only in how many instances exist, not in behaviour.
 *
 * `maxQueueDepth` bounds the waiter array — the design's stated reason for
 * rejecting reject-on-contention (`10-design.md` § Boundaries: "Queue depth
 * exceeded → Immediate refusal → `conflict`"). A waiter beyond the bound is
 * refused outright rather than queued, never counting the one currently
 * holding the lock.
 */
function createMutex(maxQueueDepth: number) {
  let current: LockHolder | null = null;
  const queue: Waiter[] = [];

  function grantNext(): void {
    while (current === null) {
      const waiter = queue.shift();
      if (!waiter) return;
      if (waiter.settled) continue; // gave up (timeout or cancellation) while queued
      const holder = waiter.holder;
      current = holder;
      // `settle` (== `finish`) is what sets `waiter.settled`; it also resolves
      // the promise, so this must run after `current` is claimed above and
      // must be the only place `settled` flips for a waiter that is granted.
      waiter.settle(
        ok({
          holder,
          release: (): void => {
            if (current === holder) current = null;
            grantNext();
          },
        }),
      );
    }
  }

  function acquire(holder: LockHolder, waitMs: number, signal: AbortSignal): Promise<Outcome<LockHandle, LockError>> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(err(lockError({ code: 'cancelled' }, 'the wait was cancelled before it began')));
        return;
      }

      if (current !== null && queue.length >= maxQueueDepth) {
        resolve(err(lockError({ code: 'queue-full', depth: queue.length }, `the wait queue is already at its ${maxQueueDepth}-deep limit`)));
        return;
      }

      let timer: ReturnType<typeof setTimeout>;
      const finish = (outcome: Outcome<LockHandle, LockError>): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const idx = queue.indexOf(waiter);
        if (idx !== -1) queue.splice(idx, 1);
        resolve(outcome);
      };

      const waiter: Waiter = { holder, settled: false, settle: finish };

      const onAbort = (): void => {
        finish(err(lockError({ code: 'cancelled' }, 'the wait was cancelled')));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        finish(err(lockError({ code: 'acquire-timeout', holder: current }, `timed out waiting ${waitMs}ms for the lock`)));
      }, Math.max(0, waitMs));

      queue.push(waiter);
      grantNext();
    });
  }

  return { acquire, currentHolder: (): LockHolder | null => current };
}

export function createLocks(admission: AdmissionLimits = ADMISSION_DEFAULTS): Locks {
  const mutationMutex = createMutex(admission.mutationQueueDepth);
  const materialisationMutexes = new Map<DeclarationId, ReturnType<typeof createMutex>>();
  const activeOperationCounts = new Map<DeclarationId, number>();
  const waitsPerSession = new Map<SessionId, number>();
  let lockFreeInFlight = 0;

  function materialisationMutexFor(declarationId: DeclarationId): ReturnType<typeof createMutex> {
    const existing = materialisationMutexes.get(declarationId);
    if (existing) return existing;
    const created = createMutex(admission.mutationQueueDepth);
    materialisationMutexes.set(declarationId, created);
    return created;
  }

  return {
    acquireMutation(holder, waitMs, signal): Promise<Outcome<LockHandle, LockError>> {
      return mutationMutex.acquire(holder, waitMs, signal);
    },

    acquireMaterialisation(declarationId, holder, waitMs, signal): Promise<Outcome<LockHandle, LockError>> {
      return materialisationMutexFor(declarationId).acquire(holder, waitMs, signal);
    },

    pinActiveOperation(declarationId): ActivePin {
      activeOperationCounts.set(declarationId, (activeOperationCounts.get(declarationId) ?? 0) + 1);
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          const next = (activeOperationCounts.get(declarationId) ?? 1) - 1;
          if (next <= 0) activeOperationCounts.delete(declarationId);
          else activeOperationCounts.set(declarationId, next);
        },
      };
    },

    activeOperationCount(declarationId): number {
      return activeOperationCounts.get(declarationId) ?? 0;
    },

    currentMutationHolder(): LockHolder | null {
      return mutationMutex.currentHolder();
    },

    admitLockFreeWait(sessionId): Outcome<WaitAdmission, LockError> {
      // Process-wide first. The two limits protect different things — one
      // stops a single session monopolising the waits, the other stops the
      // process as a whole — and the refusal names which one fired so an
      // operator can tell "you are doing too much" from "the service is".
      if (lockFreeInFlight >= admission.concurrentLockFreeOperations) {
        return err(
          lockError(
            { code: 'admission-refused', limit: 'process-lock-free' },
            `this instance already has ${lockFreeInFlight} lock-free operations in flight, its limit`,
          ),
        );
      }
      const forSession = waitsPerSession.get(sessionId) ?? 0;
      if (forSession >= admission.concurrentWaitsPerSession) {
        return err(
          lockError(
            { code: 'admission-refused', limit: 'per-session-waits' },
            `this session already has ${forSession} monitoring waits in flight, its limit`,
          ),
        );
      }

      lockFreeInFlight += 1;
      waitsPerSession.set(sessionId, forSession + 1);

      let released = false;
      return ok({
        release(): void {
          if (released) return;
          released = true;
          lockFreeInFlight = Math.max(0, lockFreeInFlight - 1);
          const next = (waitsPerSession.get(sessionId) ?? 1) - 1;
          if (next <= 0) waitsPerSession.delete(sessionId);
          else waitsPerSession.set(sessionId, next);
        },
      });
    },
  };
}
