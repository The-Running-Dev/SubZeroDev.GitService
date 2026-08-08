import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { DeclarationId, Generation, IsoUtcTimestamp, OperationId, RegistryToolName, ScheduledJobId } from '../shared/brands.ts';
import type { ActorRef, OperationContextKind } from '../shared/actor.ts';
import type { JsonValue } from '../contract/json.ts';
import type { Clock } from '../clock/clock.ts';
import type { ObservedGitState, PreState } from '../clone/types.ts';
import type { RecoveryClassification, RecoveryDescriptor } from '../recovery/types.ts';
import type { RetentionReport } from '../shared/retention.ts';
import { storeError } from '../store/errors.ts';
import { journalError, type JournalError } from './errors.ts';
import type { JournalBeginInput, JournalEntryState, JournalStep, NotificationRequest, OperationJournalEntry } from './types.ts';

export interface Journal {
  begin(input: JournalBeginInput): Promise<Outcome<OperationJournalEntry, JournalError>>;
  appendStep(operationId: OperationId, name: string): Promise<Outcome<void, JournalError>>;
  markApplied(operationId: OperationId): Promise<Outcome<void, JournalError>>;
  settle(operationId: OperationId, notify: NotificationRequest | null): Promise<Outcome<void, JournalError>>;
  park(operationId: OperationId, reason: string): Promise<Outcome<void, JournalError>>;

  classify(entry: OperationJournalEntry, observed: ObservedGitState, descriptor: RecoveryDescriptor | null): RecoveryClassification;

  unsettled(declarationId: DeclarationId, generation: Generation): Promise<readonly OperationJournalEntry[]>;
  allUnsettled(): Promise<readonly OperationJournalEntry[]>;
  findByScheduledJob(jobId: ScheduledJobId): Promise<OperationJournalEntry | null>;
  parked(): Promise<readonly OperationJournalEntry[]>;
  runRetention(): Promise<RetentionReport>;
}

export interface JournalDependencies {
  readonly volumeRoot: string;
  readonly clock: Clock;
}

interface JournalEntryRow {
  readonly operation_id: string;
  readonly declaration_id: string;
  readonly generation: number;
  readonly tool: string;
  readonly input: string;
  readonly actor_kind: string;
  readonly actor_subject: string;
  readonly actor_client: string | null;
  readonly actor_grant: string | null;
  readonly scheduled_job_id: string | null;
  readonly context: string;
  readonly pre_branch: string | null;
  readonly pre_head_sha: string | null;
  readonly pre_upstream_sha: string | null;
  readonly pre_index_digest: string;
  readonly pre_worktree_digest: string;
  readonly state: string;
  readonly attention_reason: string | null;
  readonly started_at: string;
  readonly updated_at: string;
}

interface JournalStepRow {
  readonly operation_id: string;
  readonly ordinal: number;
  readonly name: string;
  readonly state: string;
  readonly at: string;
}

function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): Outcome<T, JournalError> {
  let db: DatabaseSync;
  try {
    // `mkdirSync` belongs inside this guard, not before it: a missing or
    // unwritable volume parent throws here too, and this call runs after
    // the mutating pipeline has already acquired both locks — it must
    // return the promised `Outcome` error, not reject and leak them.
    mkdirSync(volumeRoot, { recursive: true });
    db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(journalError({ code: 'intent-write-failed', cause: storeError({ code: 'io-failed' }, message) }, `could not open the structured store: ${message}`));
  }
  try {
    return ok(fn(db));
  } catch (cause) {
    // `appendStep`/`markApplied`/`settle`/`park` throw an already-shaped
    // `JournalError` (`entry-not-found`, `invalid-transition`) to unwind out
    // of the callback; pass it through rather than re-wrapping it as a write
    // failure it never was.
    if (cause !== null && typeof cause === 'object' && 'resultKind' in cause && 'code' in cause) {
      return err(cause as JournalError);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(journalError({ code: 'intent-write-failed', cause: storeError({ code: 'io-failed' }, message) }, message));
  } finally {
    db.close();
  }
}

function toStep(row: JournalStepRow): JournalStep {
  return { name: row.name, state: row.state as JournalStep['state'], at: row.at as IsoUtcTimestamp };
}

function toEntry(row: JournalEntryRow, steps: readonly JournalStep[]): OperationJournalEntry {
  const actorRef: ActorRef = {
    kind: row.actor_kind as ActorRef['kind'],
    subject: row.actor_subject as ActorRef['subject'],
    clientId: row.actor_client as ActorRef['clientId'],
    grantId: row.actor_grant as ActorRef['grantId'],
  };
  const preState: PreState = {
    branch: row.pre_branch as PreState['branch'],
    headSha: row.pre_head_sha as PreState['headSha'],
    upstreamSha: row.pre_upstream_sha as PreState['upstreamSha'],
    indexDigest: row.pre_index_digest as PreState['indexDigest'],
    worktreeDigest: row.pre_worktree_digest as PreState['worktreeDigest'],
  };
  return {
    operationId: row.operation_id as OperationId,
    declarationId: row.declaration_id as DeclarationId,
    generation: row.generation as Generation,
    tool: row.tool as RegistryToolName,
    input: JSON.parse(row.input) as JsonValue,
    actorRef,
    scheduledJobId: row.scheduled_job_id as ScheduledJobId | null,
    context: row.context as OperationContextKind,
    preState,
    steps,
    state: row.state as JournalEntryState,
    attentionReason: row.attention_reason,
    startedAt: row.started_at as IsoUtcTimestamp,
    updatedAt: row.updated_at as IsoUtcTimestamp,
  };
}

function loadSteps(db: DatabaseSync, operationId: OperationId): readonly JournalStep[] {
  const rows = db.prepare('SELECT * FROM journal_step WHERE operation_id = ? ORDER BY ordinal ASC').all(operationId) as unknown as JournalStepRow[];
  return rows.map(toStep);
}

function loadEntry(db: DatabaseSync, operationId: OperationId): OperationJournalEntry | null {
  const rows = db.prepare('SELECT * FROM journal_entry WHERE operation_id = ?').all(operationId) as unknown as JournalEntryRow[];
  const row = rows[0];
  if (!row) return null;
  return toEntry(row, loadSteps(db, operationId));
}

function rowsToEntries(db: DatabaseSync, rows: readonly JournalEntryRow[]): readonly OperationJournalEntry[] {
  return rows.map((row) => toEntry(row, loadSteps(db, row.operation_id as OperationId)));
}

/**
 * `20-contract.md` § L1 — journal. One `store.sqlite` connection per call,
 * opened and closed around it — the same seam `clone-store.ts` and
 * `audit.ts` already use, which is what makes "force the journal write to
 * fail" a real, exercisable test rather than a mocked branch: pointing
 * `volumeRoot` at a location the process cannot write to makes every call
 * here fail with `intent-write-failed`, exactly as a real disk fault would.
 */
export function createJournal(deps: JournalDependencies): Journal {
  const { volumeRoot, clock } = deps;

  return {
    async begin(input: JournalBeginInput): Promise<Outcome<OperationJournalEntry, JournalError>> {
      const now = clock.now();
      const result = withDb(volumeRoot, (db) => {
        db.prepare(
          `INSERT INTO journal_entry (
            operation_id, declaration_id, generation, tool, input,
            actor_kind, actor_subject, actor_client, actor_grant,
            scheduled_job_id, context,
            pre_branch, pre_head_sha, pre_upstream_sha, pre_index_digest, pre_worktree_digest,
            state, attention_reason, started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intended', NULL, ?, ?)`,
        ).run(
          input.operationId,
          input.declarationId,
          input.generation,
          input.tool,
          JSON.stringify(input.input),
          input.actorRef.kind,
          input.actorRef.subject,
          input.actorRef.clientId,
          input.actorRef.grantId,
          input.scheduledJobId,
          input.context,
          input.preState.branch,
          input.preState.headSha,
          input.preState.upstreamSha,
          input.preState.indexDigest,
          input.preState.worktreeDigest,
          now,
          now,
        );
        return loadEntry(db, input.operationId)!;
      });
      return result;
    },

    async appendStep(operationId: OperationId, name: string): Promise<Outcome<void, JournalError>> {
      const now = clock.now();
      return withDb(volumeRoot, (db) => {
        const existing = loadEntry(db, operationId);
        if (!existing) throw journalError({ code: 'entry-not-found', operationId }, `no journal entry '${operationId}'`);
        const ordinal = existing.steps.length;
        db.prepare('INSERT INTO journal_step (operation_id, ordinal, name, state, at) VALUES (?, ?, ?, ?, ?)').run(operationId, ordinal, name, 'applied', now);
        db.prepare('UPDATE journal_entry SET updated_at = ? WHERE operation_id = ?').run(now, operationId);
      });
    },

    async markApplied(operationId: OperationId): Promise<Outcome<void, JournalError>> {
      const now = clock.now();
      return withDb(volumeRoot, (db) => {
        const existing = loadEntry(db, operationId);
        if (!existing) throw journalError({ code: 'entry-not-found', operationId }, `no journal entry '${operationId}'`);
        // `20-contract.md` § Error semantics › Journal: `invalid-transition`
        // is raised for `settled` to anything, **or `attention` to
        // `applied`** — a parked entry moving back to `applied` on its own
        // would silently clear the state a human or a repair session put it
        // in, without going through `clearAttention`/resolution at all.
        if (existing.state === 'settled' || existing.state === 'attention') {
          throw journalError({ code: 'invalid-transition', from: existing.state, to: 'applied' }, `cannot move a '${existing.state}' entry to 'applied'`);
        }
        db.prepare(`UPDATE journal_entry SET state = 'applied', updated_at = ? WHERE operation_id = ?`).run(now, operationId);
      });
    },

    async settle(operationId: OperationId, notify: NotificationRequest | null): Promise<Outcome<void, JournalError>> {
      const now = clock.now();
      return withDb(volumeRoot, (db) => {
        const existing = loadEntry(db, operationId);
        if (!existing) throw journalError({ code: 'entry-not-found', operationId }, `no journal entry '${operationId}'`);
        if (existing.state === 'settled') {
          throw journalError({ code: 'invalid-transition', from: existing.state, to: 'settled' }, `entry '${operationId}' is already settled`);
        }
        db.exec('BEGIN;');
        try {
          db.prepare(`UPDATE journal_entry SET state = 'settled', updated_at = ? WHERE operation_id = ?`).run(now, operationId);
          // The outbox row commits in the same transaction as the settle
          // (`10-design.md` § control flow #1, step 11) so no crash window
          // exists in which the entry reads `settled` and the row does not.
          // No notifier delivers it until S11 — the row simply accumulates
          // `pending`, which the contract already names as a valid state.
          if (notify) {
            db.prepare(
              `INSERT INTO notification_outbox (id, severity, declaration_id, payload, status, attempts, last_attempt_at, last_error, created_at, delivered_at)
               VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL)`,
            ).run(randomUUID(), notify.severity, notify.declarationId, JSON.stringify({ subject: notify.subject, summary: notify.summary }), now);
          }
          db.exec('COMMIT;');
        } catch (cause) {
          try {
            db.exec('ROLLBACK;');
          } catch {
            // Nothing more to do if the rollback itself fails; the outer
            // catch in `withDb` reports the original failure either way.
          }
          throw cause;
        }
      });
    },

    async park(operationId: OperationId, reason: string): Promise<Outcome<void, JournalError>> {
      const now = clock.now();
      return withDb(volumeRoot, (db) => {
        const existing = loadEntry(db, operationId);
        if (!existing) throw journalError({ code: 'entry-not-found', operationId }, `no journal entry '${operationId}'`);
        if (existing.state === 'settled') {
          throw journalError({ code: 'invalid-transition', from: existing.state, to: 'attention' }, `cannot park a settled entry`);
        }
        db.prepare(`UPDATE journal_entry SET state = 'attention', attention_reason = ?, updated_at = ? WHERE operation_id = ?`).run(reason, now, operationId);
      });
    },

    /**
     * Pure and total, per the contract: no I/O, and an entry it cannot place
     * classifies `park` rather than throwing — including when `descriptor`
     * is `null`. The recovery ladder that *acts* on this verdict (resuming,
     * parking with a reason, settling) is S8's; this is the classification
     * rule itself, which the contract fixes independently of who calls it.
     */
    classify(entry: OperationJournalEntry, observed: ObservedGitState, descriptor: RecoveryDescriptor | null): RecoveryClassification {
      // `nothing-happened` needs *both* halves: no step ever reached
      // `applied` (composites/remote effects), **and** the freshly observed
      // state still matches what `preState` captured. A local mutation with
      // no steps of its own (S7 records none — see the dispatch pipeline's
      // own note) can still have run its side effect and crashed before
      // `markApplied`; steps-length alone would misclassify that as nothing
      // happened and lose the recovery candidate silently.
      const stateUnchanged =
        entry.preState.branch === observed.branch &&
        entry.preState.headSha === observed.headSha &&
        entry.preState.upstreamSha === observed.upstreamSha &&
        entry.preState.indexDigest === observed.indexDigest &&
        entry.preState.worktreeDigest === observed.worktreeDigest;

      if (entry.steps.length === 0 && stateUnchanged) {
        return { verdict: 'nothing-happened' };
      }
      if (!descriptor) {
        return { verdict: 'park', reason: `no recovery descriptor is registered for '${entry.tool}'` };
      }
      if (descriptor.expectedPostState(entry, observed)) {
        return { verdict: 'completed', terminal: null };
      }
      if (descriptor.resume) {
        return { verdict: 'resume', step: descriptor.resume(entry) };
      }
      return { verdict: 'park', reason: `post-state does not match '${entry.tool}'s expectation and it registers no resume step` };
    },

    async unsettled(declarationId: DeclarationId, generation: Generation): Promise<readonly OperationJournalEntry[]> {
      const result = withDb(volumeRoot, (db) => {
        const rows = db
          .prepare(`SELECT * FROM journal_entry WHERE declaration_id = ? AND generation = ? AND state <> 'settled' ORDER BY started_at ASC`)
          .all(declarationId, generation) as unknown as JournalEntryRow[];
        return rowsToEntries(db, rows);
      });
      return result.ok ? result.value : [];
    },

    async allUnsettled(): Promise<readonly OperationJournalEntry[]> {
      const result = withDb(volumeRoot, (db) => {
        const rows = db.prepare(`SELECT * FROM journal_entry WHERE state <> 'settled' ORDER BY started_at ASC`).all() as unknown as JournalEntryRow[];
        return rowsToEntries(db, rows);
      });
      return result.ok ? result.value : [];
    },

    async findByScheduledJob(jobId: ScheduledJobId): Promise<OperationJournalEntry | null> {
      const result = withDb(volumeRoot, (db) => {
        const rows = db.prepare('SELECT * FROM journal_entry WHERE scheduled_job_id = ?').all(jobId) as unknown as JournalEntryRow[];
        const row = rows[0];
        return row ? toEntry(row, loadSteps(db, row.operation_id as OperationId)) : null;
      });
      return result.ok ? result.value : null;
    },

    async parked(): Promise<readonly OperationJournalEntry[]> {
      const result = withDb(volumeRoot, (db) => {
        const rows = db.prepare(`SELECT * FROM journal_entry WHERE state = 'attention' ORDER BY started_at ASC`).all() as unknown as JournalEntryRow[];
        return rowsToEntries(db, rows);
      });
      return result.ok ? result.value : [];
    },

    async runRetention(): Promise<RetentionReport> {
      // S17 owns retention (`journal_retention`'s index exists for it). Nothing prunes yet.
      return { module: 'journal', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },
  };
}
