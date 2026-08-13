import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { ClientId, DeclarationId, Generation, GrantId, IsoUtcTimestamp, RegistryToolName, ScheduledJobId, SessionId, Subject } from '../shared/brands.ts';
import type { ActorKind } from '../shared/actor.ts';
import type { CallContext, DomainOperation } from '../shared/call-context.ts';
import type { Session } from '../shared/session.ts';
import type { Clock } from '../clock/clock.ts';
import type { Dispatch } from '../dispatch/dispatch-pipeline.ts';
import type { Declarations } from '../declarations/declarations.ts';
import { SCHEDULER_PROFILE } from '../declarations/types.ts';
import type { Journal } from '../journal/journal.ts';
import type { Authorization } from '../authorization/authorization.ts';
import { validateAgainstSchema } from '../contract/json-schema.ts';
import type { CapabilityName, CapabilitySet, ContractCapabilitySet, DeploymentCeiling, SessionGrant } from '../contract/capabilities.ts';
import type { CompiledRegistry, ToolDeclaration } from '../contract/tool-declaration.ts';
import type { JsonValue } from '../contract/json.ts';
import { success, validation, precondition, infrastructure, type ToolResult } from '../result/envelope.ts';
import { diagnosticsFor } from '../shared/diagnostics.ts';
import { storeError } from '../store/errors.ts';
import type { StoreTransaction } from '../store/structured-store.ts';
import { retentionCutoff, toRetentionReport, type RetentionReport } from '../shared/retention.ts';
import { schedulerError, type SchedulerError } from './errors.ts';
import type {
  BootJobReport,
  CreateJobInput,
  OnMissedPolicy,
  ScheduledJob,
  ScheduledJobCancelData,
  ScheduledJobCancelInput,
  ScheduledJobCreateData,
  ScheduledJobCreateInput,
  ScheduledJobListData,
  ScheduledJobListInput,
  ScheduledJobStatus,
  SkippedJob,
  TickReport,
} from './types.ts';

/** `20-contract.md` § L2 — scheduler. */
export interface Scheduler {
  create(input: CreateJobInput, ctx: CallContext): Promise<Outcome<ScheduledJob, SchedulerError>>;
  list(declarationId: DeclarationId | null, status: ScheduledJobStatus | null): Promise<readonly ScheduledJob[]>;
  cancel(id: ScheduledJobId, ctx: CallContext, reason: string): Promise<Outcome<ScheduledJob, SchedulerError>>;
  cancelForDeclaration(declarationId: DeclarationId, reason: string, tx: StoreTransaction): readonly ScheduledJobId[];
  tick(now: IsoUtcTimestamp): Promise<TickReport>;
  resolveRunningAtBoot(): Promise<BootJobReport>;
  revalidatePending(registry: CompiledRegistry): Promise<readonly ScheduledJobId[]>;
  runRetention(): Promise<RetentionReport>;
}

export interface SchedulerDependencies {
  readonly volumeRoot: string;
  readonly clock: Clock;
  /** Injected, never imported — `Scheduler` never imports the dispatch pipeline (`20-contract.md` § L2 — scheduler). */
  readonly dispatch: Dispatch;
  readonly declarations: Pick<Declarations, 'get' | 'effectiveGrant' | 'effectiveWritablePrefixes'>;
  /** `findByScheduledJob` alone — boot resolution reads the journal, it never writes it. */
  readonly journal: Pick<Journal, 'findByScheduledJob'>;
  /** Optional so a `Scheduler` built before `Authorization` existed still compiles. Without it, `tick` cannot tell a revoked creating grant from a live one and treats every grant as live — the safe direction only once no grant-issuing module exists to revoke one in the first place. */
  readonly authorization?: Pick<Authorization, 'grantIsLive'>;
  /** Plain runtime-registry lookup; the compiler remains absent from the runtime image — the same seam `Declarations.registryEntry` already uses. */
  readonly registryEntry: (tool: RegistryToolName) => ToolDeclaration | null;
  readonly contractCapabilitySet: ContractCapabilitySet;
  readonly ceiling: DeploymentCeiling;
  /** `RetentionWindows.terminalJobDays` (`20-contract.md` § Deployment configuration, default 30). Not sourced from a `DeploymentConfig` — none is wired yet — so this is a local, overridable default, the same pattern `journal.ts`'s `journalSettledDays` already uses. */
  readonly terminalJobDays?: number;
}

const TERMINAL_JOB_DAYS_DEFAULT = 30;

interface ScheduledJobRow {
  readonly id: string;
  readonly declaration_id: string;
  readonly generation: number;
  readonly tool: string;
  readonly input: string;
  readonly not_before: string;
  readonly on_missed_mode: string;
  readonly on_missed_seconds: number | null;
  readonly frozen_grant: string;
  readonly status: string;
  readonly reason: string | null;
  readonly created_by_kind: string;
  readonly created_by_subject: string;
  readonly created_by_client: string | null;
  readonly created_by_grant: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function toOnMissed(row: ScheduledJobRow): OnMissedPolicy {
  return row.on_missed_mode === 'skip_if_older_than' ? { mode: 'skip_if_older_than', seconds: row.on_missed_seconds ?? 0 } : { mode: 'catch_up' };
}

function toJob(row: ScheduledJobRow): ScheduledJob {
  return {
    id: row.id as ScheduledJobId,
    declarationId: row.declaration_id as DeclarationId,
    generation: row.generation as Generation,
    tool: row.tool as RegistryToolName,
    input: JSON.parse(row.input) as JsonValue,
    notBefore: row.not_before as IsoUtcTimestamp,
    onMissed: toOnMissed(row),
    frozenGrant: new Set(JSON.parse(row.frozen_grant) as CapabilityName[]) as CapabilitySet,
    status: row.status as ScheduledJobStatus,
    reason: row.reason,
    createdBy: {
      kind: row.created_by_kind as ActorKind,
      subject: row.created_by_subject as Subject,
      clientId: row.created_by_client as ClientId | null,
      grantId: row.created_by_grant as GrantId | null,
    },
    createdAt: row.created_at as IsoUtcTimestamp,
    updatedAt: row.updated_at as IsoUtcTimestamp,
  };
}

function loadJob(db: DatabaseSync, id: ScheduledJobId): ScheduledJob | null {
  const row = db.prepare('SELECT * FROM scheduled_job WHERE id = ?').get(id) as ScheduledJobRow | undefined;
  return row ? toJob(row) : null;
}

/** Mirrors `declarations.ts`'s own classification: a `CHECK`/`UNIQUE`/`FOREIGN KEY`/`NOT NULL` failure is a `constraint-violated` precondition, not an opaque `io-failed` infrastructure fault. */
function classifyStoreFailure(message: string): SchedulerError {
  const isConstraint = /CHECK constraint|UNIQUE constraint|FOREIGN KEY|NOT NULL constraint/i.test(message);
  return schedulerError({ code: 'store-failed', cause: storeError(isConstraint ? { code: 'constraint-violated', constraint: message } : { code: 'io-failed' }, message) }, message);
}

function openDb(volumeRoot: string): Outcome<DatabaseSync, SchedulerError> {
  try {
    mkdirSync(volumeRoot, { recursive: true });
    const db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    db.exec('PRAGMA foreign_keys = ON;');
    return ok(db);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(classifyStoreFailure(`could not open the structured store: ${message}`));
  }
}

/** Mirrors `journal.ts`'s own `withDb`: one connection per call, and a thrown already-shaped `SchedulerError` (`cancel`'s `job-not-found`/`job-not-pending`) passes through rather than being re-wrapped as a store failure it never was. `tick`/`resolveRunningAtBoot`/`revalidatePending` open their own connection via `openDb` instead and hold it for their whole batch — a fresh connection per row was real, measured per-tick I/O (review finding). */
function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): Outcome<T, SchedulerError> {
  const opened = openDb(volumeRoot);
  if (!opened.ok) return opened;
  try {
    return ok(fn(opened.value));
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'resultKind' in cause && 'code' in cause) {
      return err(cause as SchedulerError);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(classifyStoreFailure(message));
  } finally {
    opened.value.close();
  }
}

/** Writes one row's status, swallowing a failure into a log line rather than aborting the whole batch — the same best-effort shape the old per-row `withDb` call already had, just against a connection the caller already holds open. */
function writeStatus(db: DatabaseSync, id: ScheduledJobId, status: ScheduledJobStatus, reason: string | null, now: IsoUtcTimestamp): void {
  try {
    db.prepare('UPDATE scheduled_job SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(status, reason, now, id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`scheduler: could not move job '${id}' to '${status}': ${message}`);
  }
}

/**
 * The claim that closes the race a bare `writeStatus(..., 'running', ...)`
 * left open: between `tick`'s due-job read and this write, a concurrent
 * `cancel()` (or a second, overlapping `tick`) may already have moved the
 * row off `pending`. `WHERE status = 'pending'` is the whole mechanism, the
 * same one `Notifier.claim` already uses for the identical shape of race —
 * a job this call does not win is never fired, and the cancellation (or the
 * other tick's claim) that beat it here stands.
 */
function claimForFiring(db: DatabaseSync, id: ScheduledJobId, now: IsoUtcTimestamp): boolean {
  try {
    const result = db.prepare("UPDATE scheduled_job SET status = 'running', reason = NULL, updated_at = ? WHERE id = ? AND status = 'pending'").run(now, id);
    return Number(result.changes) === 1;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`scheduler: could not claim job '${id}' for firing: ${message}`);
    return false;
  }
}

/**
 * `20-contract.md` § L2 — scheduler. The generalised hold-and-act mechanism:
 * one registry-named operation held until `notBefore`, re-checked at fire
 * time against the declaration's current grant, the deployment ceiling and
 * the creating grant — a job can lose capability between creation and firing
 * and never gain it (`10-design.md` § `ScheduledJob`).
 */
export function createScheduler(deps: SchedulerDependencies): Scheduler {
  const { volumeRoot, clock } = deps;
  const terminalJobDays = deps.terminalJobDays ?? TERMINAL_JOB_DAYS_DEFAULT;

  return {
    async create(input: CreateJobInput, ctx: CallContext): Promise<Outcome<ScheduledJob, SchedulerError>> {
      const entry = deps.registryEntry(input.tool);
      if (!entry) {
        return err(schedulerError({ code: 'tool-not-in-registry', tool: input.tool }, `tool '${input.tool}' does not exist in the compiled registry`));
      }
      if (!entry.annotations.schedulable) {
        return err(schedulerError({ code: 'tool-not-schedulable', tool: input.tool }, `tool '${input.tool}' is not annotated schedulable`));
      }
      const findings = validateAgainstSchema(entry.inputSchema, input.input);
      if (findings.length > 0) {
        return err(schedulerError({ code: 'input-invalid', findings }, `input for '${input.tool}' does not satisfy its own schema`));
      }

      const id = randomUUID() as ScheduledJobId;
      const now = clock.now();
      return withDb(volumeRoot, (db) => {
        db.prepare(
          `INSERT INTO scheduled_job (
            id, declaration_id, generation, tool, input, not_before,
            on_missed_mode, on_missed_seconds, frozen_grant, status, reason,
            created_by_kind, created_by_subject, created_by_client, created_by_grant,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.declarationId,
          ctx.generation,
          input.tool,
          JSON.stringify(input.input),
          input.notBefore,
          input.onMissed.mode,
          input.onMissed.mode === 'skip_if_older_than' ? input.onMissed.seconds : null,
          JSON.stringify([...(ctx.capabilities as unknown as ReadonlySet<CapabilityName>)]),
          ctx.actorRef.kind,
          ctx.actorRef.subject,
          ctx.actorRef.clientId,
          ctx.actorRef.grantId,
          now,
          now,
        );
        return loadJob(db, id)!;
      });
    },

    async list(declarationId: DeclarationId | null, status: ScheduledJobStatus | null): Promise<readonly ScheduledJob[]> {
      const result = withDb(volumeRoot, (db) => {
        const clauses: string[] = [];
        const params: (string | number | bigint | null)[] = [];
        if (declarationId !== null) {
          clauses.push('declaration_id = ?');
          params.push(declarationId as unknown as string);
        }
        if (status !== null) {
          clauses.push('status = ?');
          params.push(status);
        }
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = db.prepare(`SELECT * FROM scheduled_job ${where} ORDER BY not_before ASC`).all(...params) as unknown as ScheduledJobRow[];
        return rows.map(toJob);
      });
      return result.ok ? result.value : [];
    },

    /** A cancellation naming another declaration's job reports `job-not-found`, so this does not disclose that job's existence (`20-contract.md` § L2 — scheduler). */
    async cancel(id: ScheduledJobId, ctx: CallContext, reason: string): Promise<Outcome<ScheduledJob, SchedulerError>> {
      const now = clock.now();
      return withDb(volumeRoot, (db) => {
        const existing = loadJob(db, id);
        if (!existing || existing.declarationId !== ctx.declarationId) {
          throw schedulerError({ code: 'job-not-found', id }, `no scheduled job '${id}' for this declaration`);
        }
        if (existing.status !== 'pending') {
          throw schedulerError({ code: 'job-not-pending', id, status: existing.status }, `job '${id}' is '${existing.status}', not 'pending'`);
        }
        db.prepare("UPDATE scheduled_job SET status = 'cancelled', reason = ?, updated_at = ? WHERE id = ?").run(reason, now, id);
        return loadJob(db, id)!;
      });
    },

    /**
     * `20-contract.md`'s one `tx`-taking member — writes and reads back
     * through the caller's own transaction, the same shape
     * `Authorization.revokeGrantsForResource` and `Declarations.bumpGrantEpoch`
     * already use (issue #50). Wired into `Declarations.orphan` (S16.5).
     *
     * `UPDATE ... RETURNING id` captures exactly the rows this call touched
     * in the one statement — not a second `SELECT` matched on
     * `(declaration_id, reason, updated_at)`, which would also match rows an
     * *earlier* call with the same `reason` happened to cancel at the same
     * `updated_at` (two orphanings of the same declaration racing, or a
     * clock whose resolution collides), over-reporting which jobs this
     * particular invocation cancelled.
     */
    cancelForDeclaration(declarationId: DeclarationId, reason: string, tx: StoreTransaction): readonly ScheduledJobId[] {
      const now = clock.now();
      const rows = tx.all(
        "UPDATE scheduled_job SET status = 'cancelled', reason = ?, updated_at = ? WHERE declaration_id = ? AND status = 'pending' RETURNING id",
        reason,
        now,
        declarationId,
      ) as { id: string }[];
      return rows.map((row) => row.id as ScheduledJobId);
    },

    /**
     * Fires every job due at or before `now`. `fired` names every job this
     * tick actually dispatched (`10-design.md`), regardless of the eventual
     * `ToolResult` — a job moves to `running` before the dispatch call, the
     * same "before the network call" ordering `hostMutation` uses, so a
     * crash mid-dispatch leaves exactly the state boot step 6 resolves.
     * `skipped` carries every job that did not fire — an `onMissed` skip, a
     * tool no longer schedulable, or a fire-time capability shortfall (which
     * still persists the finer-grained `needs-attention` status on the row
     * itself; `TickReport` has no fourth bucket to carry that distinction).
     */
    async tick(now: IsoUtcTimestamp): Promise<TickReport> {
      const fired: ScheduledJobId[] = [];
      const skipped: SkippedJob[] = [];
      const cancelledList: SkippedJob[] = [];

      // One connection for the whole tick, not one per row: the due-job
      // read plus every status write below share it, instead of each
      // `setStatus` reopening the store (review finding — up to 2N+1
      // connections for N due jobs). `writeStatus`/`claimForFiring` are
      // themselves best-effort against this connection, matching the
      // per-row error handling the old per-call `withDb` had.
      const opened = openDb(volumeRoot);
      if (!opened.ok) return { fired, skipped, cancelled: cancelledList };
      const db = opened.value;
      try {
        let due: readonly ScheduledJob[];
        try {
          due = (db.prepare("SELECT * FROM scheduled_job WHERE status = 'pending' AND not_before <= ? ORDER BY not_before ASC").all(now) as unknown as ScheduledJobRow[]).map(toJob);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error(`scheduler: tick could not read due jobs: ${message}`);
          return { fired, skipped, cancelled: cancelledList };
        }

        for (const job of due) {
          if (job.onMissed.mode === 'skip_if_older_than') {
            const overdueMs = Date.parse(now) - Date.parse(job.notBefore as unknown as string);
            if (overdueMs > job.onMissed.seconds * 1000) {
              const reason = `missed its ${job.notBefore} window by ${Math.round(overdueMs / 1000)}s, exceeding the ${job.onMissed.seconds}s skip_if_older_than policy`;
              writeStatus(db, job.id, 'skipped', reason, now);
              skipped.push({ id: job.id, reason });
              continue;
            }
          }

          if (job.createdBy.grantId !== null && deps.authorization) {
            const live = await deps.authorization.grantIsLive(job.createdBy.grantId);
            if (!live) {
              const reason = `the creating grant '${job.createdBy.grantId}' was revoked before this job's due time`;
              writeStatus(db, job.id, 'cancelled', reason, now);
              cancelledList.push({ id: job.id, reason });
              continue;
            }
          }

          const declaration = await deps.declarations.get(job.declarationId);
          if (declaration === null) {
            const reason = `declaration '${job.declarationId}' no longer exists`;
            writeStatus(db, job.id, 'needs-attention', reason, now);
            skipped.push({ id: job.id, reason });
            continue;
          }

          const entry = deps.registryEntry(job.tool);
          if (!entry || !entry.annotations.schedulable) {
            const reason = `'${job.tool}' is no longer a schedulable registry tool`;
            writeStatus(db, job.id, 'needs-attention', reason, now);
            skipped.push({ id: job.id, reason });
            continue;
          }

          const recomputedGrant = deps.declarations.effectiveGrant(deps.contractCapabilitySet, deps.ceiling, declaration, job.frozenGrant as unknown as SessionGrant);
          const missing = entry.capabilities.filter((capability) => !recomputedGrant.has(capability));
          if (missing.length > 0) {
            const reason = `re-intersection at fire time lost: ${missing.join(', ')}`;
            writeStatus(db, job.id, 'needs-attention', reason, now);
            skipped.push({ id: job.id, reason });
            continue;
          }

          // The claim, not a bare write: between the SELECT above and here,
          // a concurrent `cancel()` (or a second, overlapping `tick`) may
          // already have moved this row off `pending`. Losing the claim
          // means someone else already decided this job's fate — it is
          // neither fired nor reported into `skipped`/`cancelled`, which
          // would double-report a job another actor already accounted for.
          if (!claimForFiring(db, job.id, now)) continue;
          fired.push(job.id);

          const session: Session = {
            id: randomUUID() as SessionId,
            kind: 'scheduler',
            actorRef: { kind: 'scheduler', subject: `scheduler:${job.id}` as Subject, clientId: null, grantId: null },
            repositoryBinding: job.declarationId,
            grant: recomputedGrant as unknown as SessionGrant,
            writablePathPrefixes: deps.declarations.effectiveWritablePrefixes(declaration, SCHEDULER_PROFILE),
            frozenAtEpoch: declaration.grantEpoch,
          };
          const result = await deps.dispatch({
            toolName: job.tool,
            input: job.input,
            session,
            declarationId: job.declarationId,
            scheduledJobId: job.id,
            context: 'normal',
            signal: new AbortController().signal,
          });
          if (result.ok) {
            writeStatus(db, job.id, 'done', null, clock.now());
          } else {
            writeStatus(db, job.id, 'needs-attention', `'${job.tool}' returned ${result.kind}: ${result.summary}`, clock.now());
          }
        }
      } finally {
        db.close();
      }

      return { fired, skipped, cancelled: cancelledList };
    },

    /**
     * Boot step 6. From the journal alone, no resume step and no git or host
     * I/O (S16.8). A `running` job is never simply fired again (S16.7):
     * `findByScheduledJob` returning `null` means the pipeline never reached
     * `journal.begin` before the crash; `settled` means recovery already
     * concluded it (or it settled before the crash reached the scheduler's
     * own follow-up write); `attention` means it parked; anything else
     * (`intended`/`applied`) is genuinely unknown until the lazy recovery
     * pass reaches this declaration, so the job stays `running`.
     */
    async resolveRunningAtBoot(): Promise<BootJobReport> {
      const markedDone: ScheduledJobId[] = [];
      const markedNeedsAttention: ScheduledJobId[] = [];
      const returnedToPending: ScheduledJobId[] = [];
      const leftRunning: ScheduledJobId[] = [];

      // One connection for the whole boot pass, not one per running job.
      const opened = openDb(volumeRoot);
      if (!opened.ok) return { markedDone, markedNeedsAttention, returnedToPending, leftRunning };
      const db = opened.value;
      try {
        let running: readonly ScheduledJobId[];
        try {
          running = (db.prepare("SELECT id FROM scheduled_job WHERE status = 'running'").all() as unknown as { id: string }[]).map((row) => row.id as ScheduledJobId);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error(`scheduler: resolveRunningAtBoot could not read running jobs: ${message}`);
          return { markedDone, markedNeedsAttention, returnedToPending, leftRunning };
        }

        const now = clock.now();
        for (const id of running) {
          const found = await deps.journal.findByScheduledJob(id);
          if (!found.ok) {
            // The journal could not be read — this job's outcome is unknown,
            // not "nothing happened". Leaving it `running` is the honest
            // answer, the same one a read failure gets everywhere else in
            // recovery.
            leftRunning.push(id);
            continue;
          }
          const entry = found.value;
          if (entry === null) {
            writeStatus(db, id, 'pending', null, now);
            returnedToPending.push(id);
          } else if (entry.state === 'settled') {
            writeStatus(db, id, 'done', null, now);
            markedDone.push(id);
          } else if (entry.state === 'attention') {
            writeStatus(db, id, 'needs-attention', entry.attentionReason ?? 'parked during recovery', now);
            markedNeedsAttention.push(id);
          } else {
            leftRunning.push(id);
          }
        }
      } finally {
        db.close();
      }

      return { markedDone, markedNeedsAttention, returnedToPending, leftRunning };
    },

    /**
     * Boot step 7's job half (S16.9). An image upgrade can rename or remove a
     * tool, strip its `schedulable` annotation, or change its input schema
     * while a job still references the old shape; caught here rather than at
     * fire time, weeks later, with the cause an upgrade nobody is still
     * thinking about.
     */
    async revalidatePending(registry: CompiledRegistry): Promise<readonly ScheduledJobId[]> {
      const parked: ScheduledJobId[] = [];

      // One connection for the whole revalidation pass, not one per pending job.
      const opened = openDb(volumeRoot);
      if (!opened.ok) return parked;
      const db = opened.value;
      try {
        let pending: readonly ScheduledJob[];
        try {
          pending = (db.prepare("SELECT * FROM scheduled_job WHERE status = 'pending'").all() as unknown as ScheduledJobRow[]).map(toJob);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error(`scheduler: revalidatePending could not read pending jobs: ${message}`);
          return parked;
        }

        const now = clock.now();
        for (const job of pending) {
          const entry = registry.entries.find((candidate) => candidate.name === job.tool);
          let reason: string | null = null;
          if (!entry) {
            reason = `'${job.tool}' no longer exists in the compiled registry, following an image upgrade`;
          } else if (!entry.annotations.schedulable) {
            reason = `'${job.tool}' is no longer annotated schedulable, following an image upgrade`;
          } else {
            const findings = validateAgainstSchema(entry.inputSchema, job.input);
            if (findings.length > 0) {
              reason = `the stored input for '${job.tool}' no longer satisfies its schema, following an image upgrade`;
            }
          }
          if (reason !== null) {
            writeStatus(db, job.id, 'needs-attention', reason, now);
            parked.push(job.id);
          }
        }
      } finally {
        db.close();
      }
      return parked;
    },

    /** `20-contract.md` § D5/S25.5 — a terminal job (`done`/`skipped`/`cancelled`) older than `terminalJobDays` is deleted; `needs-attention` is retained regardless of age, the same shape `journal.ts`'s `runRetention` already uses for `attention` entries. */
    async runRetention(): Promise<RetentionReport> {
      const cutoff = retentionCutoff(clock.now(), terminalJobDays);
      const result = withDb(volumeRoot, (db) => {
        const info = db
          .prepare(`DELETE FROM scheduled_job WHERE status IN ('done', 'skipped', 'cancelled') AND updated_at < ?`)
          .run(cutoff);
        return Number(info.changes);
      });
      return toRetentionReport('scheduler', result.ok ? result : { ok: false, summary: result.error.summary });
    },
  };
}

/** `20-contract.md` § L2 — scheduler. The tool-facing wrapper: `SchedulerOperations` supplies the declaration id from `CallContext`, never from public input, so a caller cannot create, list or cancel a job for another declaration. */
export interface SchedulerOperations {
  readonly create: DomainOperation<ScheduledJobCreateInput, ScheduledJobCreateData>;
  readonly list: DomainOperation<ScheduledJobListInput, ScheduledJobListData>;
  readonly cancel: DomainOperation<ScheduledJobCancelInput, ScheduledJobCancelData>;
}

/** Maps every `SchedulerError` by its own `resultKind` — `grant-revoked`/`grant-insufficient` are unreachable here (`tick`'s own internal outcomes), so the default `infrastructure` branch only ever carries `store-failed`. */
function schedulerErrorToToolResult(error: SchedulerError): ToolResult<never> {
  switch (error.resultKind) {
    case 'validation':
      return validation(error.summary, 'findings' in error ? error.findings : []);
    case 'precondition':
      return precondition(error.summary, []);
    default:
      return infrastructure(error.summary);
  }
}

export function createSchedulerOperations(scheduler: Pick<Scheduler, 'create' | 'list' | 'cancel'>, clock: Clock): SchedulerOperations {
  return {
    async create(ctx, input): Promise<ToolResult<ScheduledJobCreateData>> {
      const startedAtMs = Date.parse(clock.now());
      if (ctx.declarationId === null) return infrastructure(`'scheduled_job_create' requires a declaration in context`);
      const created = await scheduler.create({ declarationId: ctx.declarationId, tool: input.tool, input: input.input, notBefore: input.notBefore, onMissed: input.onMissed }, ctx);
      if (!created.ok) return schedulerErrorToToolResult(created.error);
      return success(`created scheduled job '${created.value.id}'`, { job: created.value }, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async list(ctx, input): Promise<ToolResult<ScheduledJobListData>> {
      const startedAtMs = Date.parse(clock.now());
      const jobs = await scheduler.list(ctx.declarationId, input.status);
      return success(`${jobs.length} scheduled job(s)`, { jobs }, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async cancel(ctx, input): Promise<ToolResult<ScheduledJobCancelData>> {
      const startedAtMs = Date.parse(clock.now());
      const cancelled = await scheduler.cancel(input.id, ctx, input.reason);
      if (!cancelled.ok) return schedulerErrorToToolResult(cancelled.error);
      return success(`cancelled scheduled job '${cancelled.value.id}'`, { job: cancelled.value }, diagnosticsFor(ctx, startedAtMs, clock));
    },
  };
}
