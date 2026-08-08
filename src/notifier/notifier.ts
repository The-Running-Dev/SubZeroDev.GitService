import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock/clock.ts';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import type { HttpsUrl, IsoUtcTimestamp, OutboxRowId } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { JsonValue } from '../contract/json.ts';
import type { RetentionReport } from '../shared/retention.ts';
import type { NotificationRequest } from '../journal/types.ts';
import type { StoreTransaction } from '../store/structured-store.ts';
import { notifierError, type NotifierError } from './errors.ts';
import type { DeliveryReport, OutboxRow, OutboxRowStatus } from './types.ts';

export interface Notifier {
  enqueue(request: NotificationRequest, tx: StoreTransaction): void;
  deliverPending(): Promise<DeliveryReport>;
  redriveUndelivered(): Promise<DeliveryReport>;
  listFailed(): Promise<readonly OutboxRow[]>;
  clearFailed(id: OutboxRowId, actor: ActorRef): Promise<Outcome<void, NotifierError>>;
  runRetention(): Promise<RetentionReport>;
}

export interface NotifierDependencies {
  readonly volumeRoot: string;
  readonly clock: Clock;
  /** `DeploymentConfig.notifierWebhook` — `null` means no transport is configured. */
  readonly webhookUrl: HttpsUrl | null;
  /** Injected for tests. Defaults to a real `fetch` call. */
  readonly deliverFn?: (url: string, body: string) => Promise<{ readonly ok: boolean; readonly status: number }>;
  /** Injected for tests, so backoff does not really sleep. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
}

const MAX_ATTEMPTS_DEFAULT = 5;
const BACKOFF_CAP_MS = 30_000;

function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, BACKOFF_CAP_MS);
}

async function realDeliver(url: string, body: string): Promise<{ readonly ok: boolean; readonly status: number }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return { ok: res.ok, status: res.status };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OutboxRowDb {
  readonly id: string;
  readonly severity: string;
  readonly declaration_id: string | null;
  readonly payload: string;
  readonly status: string;
  readonly attempts: number;
  readonly last_attempt_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
}

function toRow(row: OutboxRowDb): OutboxRow {
  return {
    id: row.id as OutboxRowId,
    severity: row.severity as OutboxRow['severity'],
    declarationId: row.declaration_id as OutboxRow['declarationId'],
    payload: JSON.parse(row.payload) as JsonValue,
    status: row.status as OutboxRowStatus,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at as IsoUtcTimestamp | null,
    lastError: row.last_error,
    createdAt: row.created_at as IsoUtcTimestamp,
    deliveredAt: row.delivered_at as IsoUtcTimestamp | null,
  };
}

type DbOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): DbOutcome<T> {
  let db: DatabaseSync;
  try {
    mkdirSync(volumeRoot, { recursive: true });
    db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    db.exec('PRAGMA foreign_keys = ON;');
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  try {
    return { ok: true, value: fn(db) };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    db.close();
  }
}

/**
 * `20-contract.md` § L1 — notifier. One `store.sqlite` connection per call,
 * the same seam `journal.ts`, `credentials.ts` and `audit.ts` already use.
 *
 * One transport ships: an HTTP webhook. `webhookUrl: null` is a deployment
 * that has not configured one — rows accumulate `pending` rather than
 * throwing, and nothing here calls a caller synchronously either way
 * (`10-design.md` § Notifier: "Never blocks a caller").
 */
export function createNotifier(deps: NotifierDependencies): Notifier {
  const { volumeRoot, clock, webhookUrl } = deps;
  const deliverFn = deps.deliverFn ?? realDeliver;
  const sleepFn = deps.sleepFn ?? realSleep;
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;

  /**
   * One row, delivered with up to `maxAttempts` tries and an exponential
   * backoff between them — bounded within this single call, so "bounded,
   * with backoff" is a property of one delivery attempt rather than
   * something that only emerges from being invoked repeatedly by a
   * scheduler this slice does not build (S16).
   */
  async function tryDeliver(row: OutboxRowDb): Promise<{ readonly delivered: boolean; readonly attempts: number; readonly lastError: string | null }> {
    let attempts = row.attempts;
    let lastError: string | null = null;
    for (;;) {
      if (webhookUrl === null) {
        return { delivered: false, attempts, lastError: 'no webhook is configured' };
      }
      attempts += 1;
      try {
        const result = await deliverFn(webhookUrl as unknown as string, row.payload);
        if (result.ok) {
          return { delivered: true, attempts, lastError: null };
        }
        lastError = `webhook responded ${result.status}`;
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause);
      }
      if (attempts >= maxAttempts) {
        return { delivered: false, attempts, lastError };
      }
      await sleepFn(backoffMs(attempts));
    }
  }

  /** Shared by `deliverPending` and `redriveUndelivered`: attempt every row in `statuses`, write back the outcome, and tally the report. */
  async function deliverRows(statuses: readonly OutboxRowStatus[]): Promise<DeliveryReport> {
    const selected = withDb(volumeRoot, (db) => {
      const placeholders = statuses.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM notification_outbox WHERE status IN (${placeholders}) ORDER BY created_at ASC`).all(...statuses) as unknown as OutboxRowDb[];
    });
    if (!selected.ok) {
      return { delivered: 0, failed: 0, stillPending: 0 };
    }

    let delivered = 0;
    let failed = 0;
    let stillPending = 0;

    for (const row of selected.value) {
      const outcome = await tryDeliver(row);
      const now = clock.now();
      if (outcome.delivered) {
        delivered += 1;
        withDb(volumeRoot, (db) => {
          db.prepare(`UPDATE notification_outbox SET status = 'delivered', attempts = ?, last_attempt_at = ?, last_error = NULL, delivered_at = ? WHERE id = ?`).run(
            outcome.attempts,
            now,
            now,
            row.id,
          );
        });
        continue;
      }
      const nextStatus: OutboxRowStatus = outcome.attempts >= maxAttempts ? 'failed' : 'pending';
      if (nextStatus === 'failed') failed += 1;
      else stillPending += 1;
      withDb(volumeRoot, (db) => {
        db.prepare(`UPDATE notification_outbox SET status = ?, attempts = ?, last_attempt_at = ?, last_error = ? WHERE id = ?`).run(
          nextStatus,
          outcome.attempts,
          now,
          outcome.lastError,
          row.id,
        );
      });
    }

    return { delivered, failed, stillPending };
  }

  return {
    enqueue(request: NotificationRequest, _tx: StoreTransaction): void {
      // `_tx` is the opaque `StoreTransaction` the contract requires this
      // signature to accept. Every module in this codebase that touches
      // `store.sqlite` opens its own connection rather than sharing the
      // structured store's (`journal.ts`, `credentials.ts`, `audit.ts`), so
      // there is no ambient transaction to join here either — this call is
      // its own atomic insert, exactly as `Journal.settle`'s own outbox
      // write already is.
      const now = clock.now();
      withDb(volumeRoot, (db) => {
        db.prepare(
          `INSERT INTO notification_outbox (id, severity, declaration_id, payload, status, attempts, last_attempt_at, last_error, created_at, delivered_at)
           VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL)`,
        ).run(randomUUID(), request.severity, request.declarationId, JSON.stringify({ subject: request.subject, summary: request.summary }), now);
      });
    },

    async deliverPending(): Promise<DeliveryReport> {
      return deliverRows(['pending']);
    },

    /**
     * Boot's call. Re-attempts every row that never reached `delivered` —
     * `pending` and `failed` alike, because a restart is exactly the durable
     * checkpoint `10-design.md` names as the reason no row is ever dropped:
     * "the one terminal state that most needed to reach you is the one that
     * never does" applies equally to a row this instance had already given
     * up on before the restart.
     */
    async redriveUndelivered(): Promise<DeliveryReport> {
      return deliverRows(['pending', 'failed']);
    },

    async listFailed(): Promise<readonly OutboxRow[]> {
      const rows = withDb(volumeRoot, (db) => db.prepare(`SELECT * FROM notification_outbox WHERE status = 'failed' ORDER BY created_at ASC`).all() as unknown as OutboxRowDb[]);
      return rows.ok ? rows.value.map(toRow) : [];
    },

    /**
     * Never a delete — `notification_outbox` rows are never removed outside
     * retention (S17). Clearing resets a `failed` row back to `pending` with
     * its attempt count zeroed, which is what gives it the "try again" an
     * operator clearing it from the health view is asking for.
     */
    async clearFailed(id: OutboxRowId, _actor: ActorRef): Promise<Outcome<void, NotifierError>> {
      const found = withDb(volumeRoot, (db) => db.prepare(`SELECT id FROM notification_outbox WHERE id = ? AND status = 'failed'`).get(id as string));
      if (!found.ok || !found.value) {
        return err(notifierError({ code: 'row-not-found', rowId: id }, `no failed outbox row '${id}'`));
      }
      withDb(volumeRoot, (db) => {
        db.prepare(`UPDATE notification_outbox SET status = 'pending', attempts = 0, last_attempt_at = NULL, last_error = NULL WHERE id = ?`).run(id as string);
      });
      return ok(undefined);
    },

    async runRetention(): Promise<RetentionReport> {
      // S17 owns retention (`outbox_retention`'s index exists for it). Nothing prunes yet.
      return { module: 'notifier', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },
  };
}
