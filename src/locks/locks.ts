import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { DeclarationId } from '../shared/brands.ts';
import { lockError, type LockError } from './errors.ts';
import type { ActivePin, LockHandle, LockHolder } from './types.ts';

export interface Locks {
  acquireMutation(holder: LockHolder, waitMs: number, signal: AbortSignal): Promise<Outcome<LockHandle, LockError>>;
  acquireMaterialisation(declarationId: DeclarationId, holder: LockHolder, waitMs: number, signal: AbortSignal): Promise<Outcome<LockHandle, LockError>>;
  pinActiveOperation(declarationId: DeclarationId): ActivePin;
  activeOperationCount(declarationId: DeclarationId): number;
  currentMutationHolder(): LockHolder | null;
}

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
 */
function createMutex() {
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

export function createLocks(): Locks {
  const mutationMutex = createMutex();
  const materialisationMutexes = new Map<DeclarationId, ReturnType<typeof createMutex>>();
  const activeOperationCounts = new Map<DeclarationId, number>();

  function materialisationMutexFor(declarationId: DeclarationId): ReturnType<typeof createMutex> {
    const existing = materialisationMutexes.get(declarationId);
    if (existing) return existing;
    const created = createMutex();
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
  };
}
