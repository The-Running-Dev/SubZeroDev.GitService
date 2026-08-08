import type { DeclarationId } from '../shared/brands.ts';
import type { Session } from '../shared/session.ts';
import type { Clock } from '../clock/clock.ts';
import type { Journal } from '../journal/journal.ts';
import type { OperationJournalEntry } from '../journal/types.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { RecoveryCatalogue } from '../recovery/catalogue.ts';
import type { RecoveryClassification } from '../recovery/types.ts';
import type { Dispatch } from '../dispatch/dispatch-pipeline.ts';
import type { Notifier } from '../notifier/notifier.ts';

export interface RecoveryDependencies {
  readonly journal: Pick<Journal, 'unsettled' | 'allUnsettled' | 'classify' | 'settle' | 'park'>;
  readonly cloneStore: Pick<CloneStore, 'observeGitState' | 'markAttention'>;
  readonly declarations: Pick<Declarations, 'get'>;
  readonly catalogue: Pick<RecoveryCatalogue, 'lookup'>;
  readonly clock: Clock;
  /**
   * S11. Optional so a `RecoveryDependencies` assembled before the notifier
   * existed still compiles. Delivery is fired, never awaited, after a settle
   * that actually enqueued a row — `10-design.md` § Notifier: "never blocks
   * a caller", and this caller is recovery itself, not the operation whose
   * terminal state is being reported.
   */
  readonly notifier?: Pick<Notifier, 'deliverPending'>;
  /**
   * Injected per invariant B2 — the lifecycle module receives `Dispatch`
   * rather than importing the pipeline. Only the `resume` verdict needs it,
   * and no descriptor registered today returns one: the three S7 local
   * mutations all set `resume: null`, because a local mutation's whole effect
   * is visible in local pre-state, so it classifies `completed` or `park` and
   * never `resume`. The first real resume arrives with S12's composites.
   */
  readonly dispatch?: Dispatch;
  /** The session a resume step runs under. Supplied by the composition root alongside `dispatch`. */
  readonly recoverySession?: Session;
}

/**
 * The recovery ladder. `10-design.md` § Boot and recovery: boot classifies
 * every unsettled entry, resumes what it can, and parks what it cannot.
 *
 * **This function discards nothing.** It runs no `reset`, `clean`, `checkout
 * --force`, `stash drop` or branch delete, and it has no code path that
 * could: its only writes are journal state transitions, a clone-store
 * attention mark, and — for a `resume` verdict — a dispatch of the step the
 * descriptor itself names. A tree it cannot account for is parked for a
 * human, which is the honest outcome and the one the design chose over any
 * form of automatic rollback.
 */
export async function recoverDeclaration(deps: RecoveryDependencies, declarationId: DeclarationId): Promise<readonly RecoveryClassification[]> {
  const declaration = await deps.declarations.get(declarationId);
  if (declaration === null) return [];

  const entries = await deps.journal.unsettled(declarationId, declaration.generation);
  const verdicts: RecoveryClassification[] = [];

  for (const entry of entries) {
    // An entry already parked by a previous pass stays parked. Re-classifying
    // it would let a pass that happens to observe a matching tree quietly
    // settle something a human was asked to look at.
    if (entry.state === 'attention') {
      const reason = entry.attentionReason ?? 'already parked';
      // Re-mark the clone rather than only reporting the verdict. `park()`
      // writes the journal first and the clone second, so a process killed
      // between those two writes restarts with an `attention` entry and a
      // `ready` clone — and the dispatch gate reads the clone, so ordinary
      // mutations would be admitted against a tree a human was asked to look
      // at. `markAttention` is idempotent, so reasserting it costs nothing on
      // the ordinary path and closes that window on the one that matters.
      const marked = await deps.cloneStore.markAttention(declarationId, reason);
      verdicts.push(
        marked.ok
          ? { verdict: 'park', reason }
          : { verdict: 'park', reason: `${reason} (the clone could not be re-marked: ${marked.error.summary})` },
      );
      continue;
    }

    const observed = await deps.cloneStore.observeGitState(declarationId);
    if (!observed.ok) {
      // The observation is the input `classify` cannot do without, so a
      // failure to observe is not a classification — it is the one case where
      // the ladder cannot reach a verdict at all, and parking is the only
      // safe answer.
      const reason = `git state could not be observed during recovery: ${observed.error.summary}`;
      await park(deps, entry, declarationId, reason);
      verdicts.push({ verdict: 'park', reason });
      continue;
    }

    const descriptor = deps.catalogue.lookup(entry.tool);
    const verdict = deps.journal.classify(entry, observed.value, descriptor);
    verdicts.push(verdict);

    switch (verdict.verdict) {
      case 'nothing-happened':
      case 'completed': {
        // Both settle. `completed` may carry a `TerminalState` the operator
        // should hear about; the request is passed to `settle`, which
        // commits the outbox row in the same transaction as the state
        // change (`10-design.md` § control flow #1, step 11: "the caller's
        // connection died with the process, so suppressing it here would
        // recreate the failure one level up").
        const notify =
          verdict.verdict === 'completed' && verdict.terminal
            ? { severity: 'attention' as const, declarationId, subject: verdict.terminal, summary: `'${entry.tool}' reached a terminal state during recovery` }
            : null;
        const settled = await deps.journal.settle(entry.operationId, notify);
        // Fired, not awaited: delivery is a separate concern from recovery
        // finishing, and a slow or unreachable webhook must not hold up the
        // ladder working through the rest of the unsettled entries.
        if (settled.ok && notify && deps.notifier) {
          void deps.notifier.deliverPending().catch(() => {
            // `deliverPending` never throws by construction; this is belt
            // and braces against a future implementation that does.
          });
        }
        break;
      }

      case 'resume': {
        if (!deps.dispatch || !deps.recoverySession) {
          const reason = `'${entry.tool}' asks to resume, but no dispatch is wired into recovery`;
          await park(deps, entry, declarationId, reason);
          break;
        }
        // The resume goes through the pipeline and takes the global mutation
        // lock in its own right (`20-contract.md` § L1 — lifecycle). It is
        // not run under a lock this function holds, because this function
        // holds none — which is what lets the triggering call acquire cleanly
        // once recovery has finished.
        const result = await deps.dispatch({
          toolName: verdict.step.tool,
          input: verdict.step.input,
          session: deps.recoverySession,
          declarationId,
          scheduledJobId: entry.scheduledJobId,
          context: 'recovery',
          signal: new AbortController().signal,
        });
        if (result.ok) {
          await deps.journal.settle(entry.operationId, null);
        } else {
          await park(deps, entry, declarationId, `the resume step for '${entry.tool}' returned ${result.kind}: ${result.summary}`);
        }
        break;
      }

      case 'park':
        await park(deps, entry, declarationId, verdict.reason);
        break;
    }
  }

  return verdicts;
}

async function park(deps: RecoveryDependencies, entry: OperationJournalEntry, declarationId: DeclarationId, reason: string): Promise<void> {
  await deps.journal.park(entry.operationId, reason);
  // The clone is marked too, not only the entry: the dispatch gate reads
  // clone state, and an entry parked without the clone following it would
  // leave the declaration accepting ordinary mutations on a tree nobody has
  // accounted for.
  //
  // These two writes are not atomic and cannot be — they are different
  // stores. A crash between them is recovered on the next pass, which
  // re-marks the clone from the still-parked entry (see the `attention`
  // branch above). The journal is written first deliberately: an entry
  // parked with an unmarked clone is repairable, whereas a marked clone with
  // no parked entry would be a declaration nothing can ever unpark.
  await deps.cloneStore.markAttention(declarationId, reason);
}

/** The declarations boot reports as `recovery-pending` — those holding at least one unsettled entry. */
export function declarationsWithUnsettledEntries(entries: readonly OperationJournalEntry[]): readonly DeclarationId[] {
  return [...new Set(entries.map((entry) => entry.declarationId))];
}
