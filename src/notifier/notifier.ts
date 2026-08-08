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
  readonly deliverFn?: (url: string, body: string, signal: AbortSignal) => Promise<{ readonly ok: boolean; readonly status: number }>;
  /** Injected for tests, so backoff does not really sleep. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  /**
   * How long a single delivery attempt may take before it is abandoned.
   * Without a bound, an endpoint that accepts the connection and then never
   * answers — a firewall that DROPs rather than refuses — hangs the pass
   * forever, and every caller waiting on it with it.
   */
  readonly deliveryTimeoutSeconds?: number;
}

const MAX_ATTEMPTS_DEFAULT = 5;
const BACKOFF_CAP_MS = 30_000;
const DELIVERY_TIMEOUT_SECONDS_DEFAULT = 10;

function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, BACKOFF_CAP_MS);
}

/**
 * One row's delivery outcome. `errors` carries **every** failure encountered,
 * not just the terminal one: a row that failed twice and succeeded on the
 * third attempt still tells an operator their webhook is flaky, and reporting
 * only the final state would throw that away.
 */
interface DeliveryAttempt {
  readonly delivered: boolean;
  /** The running total to persist — every try this row has ever had, across every pass. */
  readonly attempts: number;
  /** Tries in *this* call. What the `maxAttempts` bound is measured against. */
  readonly tries: number;
  readonly errors: readonly NotifierError[];
}

async function realDeliver(url: string, body: string, signal: AbortSignal): Promise<{ readonly ok: boolean; readonly status: number }> {
  // The signal is passed to `fetch` as well as being raced in `tryDeliver`,
  // so an abandoned attempt actually closes its socket rather than leaving
  // the request in flight with nobody waiting on it.
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
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
  const deliveryTimeoutSeconds = deps.deliveryTimeoutSeconds ?? DELIVERY_TIMEOUT_SECONDS_DEFAULT;

  /**
   * Passes are serialised, and that is a correctness requirement rather than
   * tidiness. A row is selected while `pending` and keeps that status on disk
   * until the whole retry loop for it has finished, so a second pass starting
   * in that window selects the same row and POSTs it again. There are three
   * independent callers — boot's redrive, recovery, and the composition
   * root's timer — so overlap is the normal case, not a rare one.
   *
   * An in-process chain is sufficient precisely because the instance lease
   * (S2) guarantees exactly one process owns this volume. It would not be
   * sufficient without that, and if the lease invariant ever weakens this
   * needs to become a claim on the row itself.
   */
  let passChain: Promise<unknown> = Promise.resolve();
  function serialised(run: () => Promise<DeliveryReport>): Promise<DeliveryReport> {
    const next = passChain.then(run, run);
    passChain = next.catch(() => undefined);
    return next;
  }

  /**
   * One attempt, bounded. The timeout is enforced here rather than only
   * inside `realDeliver`, so it applies to any injected transport too — a
   * bound that only the default implementation honours is not a bound.
   */
  async function attemptDelivery(body: string): Promise<{ readonly ok: boolean; readonly status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deliveryTimeoutSeconds * 1000);
    // Never let the timeout itself hold the process open.
    timer.unref?.();
    try {
      return await Promise.race([
        deliverFn(webhookUrl as unknown as string, body, controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error(`the webhook did not respond within ${deliveryTimeoutSeconds}s`)), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One row, delivered with up to `maxAttempts` tries and an exponential
   * backoff between them — bounded within this single call, so "bounded,
   * with backoff" is a property of one delivery attempt rather than
   * something that only emerges from being invoked repeatedly by a
   * scheduler this slice does not build (S16).
   *
   * The bound is on `tries` — this call's own count — never on the persisted
   * total. Seeding the counter from `row.attempts` gave the right answer only
   * because three separate facts happened to hold together: `redriveUndelivered`
   * selects `pending` alone, `clearFailed` zeroes `attempts` on the way back to
   * `pending`, and this loop never returns un-exhausted without having
   * delivered — so no row reaching here can carry a non-zero count. Any one of
   * those changing would have silently turned the bound into a budget already
   * spent, giving the row a single try with no backoff. The total is still what
   * gets written back, since that is the figure that tells an operator how
   * flaky their webhook is.
   */
  async function tryDeliver(row: OutboxRowDb): Promise<DeliveryAttempt> {
    let tries = 0;
    const errors: NotifierError[] = [];

    for (;;) {
      tries += 1;
      const attempts = row.attempts + tries;
      try {
        const result = await attemptDelivery(row.payload);
        if (result.ok) {
          // Delivered — but any earlier failures still travel with it.
          return { delivered: true, attempts, tries, errors };
        }
        errors.push(notifierError({ code: 'delivery-failed', status: result.status, attempts }, `the webhook responded ${result.status} on attempt ${attempts}`));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        errors.push(notifierError({ code: 'delivery-failed', status: null, attempts }, `the webhook could not be reached on attempt ${attempts}: ${message}`));
      }

      if (tries >= maxAttempts) {
        // The bound is reached, so the row is about to become `failed`. That
        // is a different statement from the last attempt's failure, and the
        // contract gives it its own variant: never dropped, always surfaced.
        errors.push(
          notifierError(
            { code: 'retries-exhausted', rowId: row.id as OutboxRowId },
            `delivery of outbox row '${row.id}' was abandoned after ${attempts} attempt(s); the row is marked failed and kept`,
          ),
        );
        return { delivered: false, attempts, tries, errors };
      }
      await sleepFn(backoffMs(tries));
    }
  }

  /** Shared by `deliverPending` and `redriveUndelivered`: attempt every row in `statuses`, write back the outcome, and tally the report. */
  async function deliverRows(statuses: readonly OutboxRowStatus[]): Promise<DeliveryReport> {
    if (webhookUrl === null) {
      // Nothing was attempted, so nothing is written. Falling through would
      // stamp `last_attempt_at` on every row for an attempt that never
      // happened — and since no row can leave `pending` without a transport,
      // and nothing prunes `pending` rows, that rewrote the entire outbox on
      // every pass forever. No transport is one fact about the deployment,
      // reported once, not once per row.
      const counted = withDb(volumeRoot, (db) => {
        const placeholders = statuses.map(() => '?').join(',');
        return (db.prepare(`SELECT COUNT(*) AS n FROM notification_outbox WHERE status IN (${placeholders})`).get(...statuses) as { n: number } | undefined)?.n ?? 0;
      });
      return {
        delivered: 0,
        failed: 0,
        stillPending: counted.ok ? counted.value : 0,
        errors: [notifierError({ code: 'no-transport-configured' }, 'no notifier webhook is configured, so no row was attempted and every row stays pending')],
      };
    }

    const selected = withDb(volumeRoot, (db) => {
      const placeholders = statuses.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM notification_outbox WHERE status IN (${placeholders}) ORDER BY created_at ASC`).all(...statuses) as unknown as OutboxRowDb[];
    });
    if (!selected.ok) {
      return {
        delivered: 0,
        failed: 0,
        stillPending: 0,
        errors: [notifierError({ code: 'delivery-failed', status: null, attempts: 0 }, `the outbox could not be read, so no row was attempted: ${selected.reason}`)],
      };
    }

    let delivered = 0;
    let failed = 0;
    let stillPending = 0;
    const errors: NotifierError[] = [];

    for (const row of selected.value) {
      const outcome = await tryDeliver(row);
      const now = clock.now();
      errors.push(...outcome.errors);
      const lastError = outcome.errors.at(-1) ?? null;

      const nextStatus: OutboxRowStatus = outcome.delivered ? 'delivered' : outcome.tries >= maxAttempts ? 'failed' : 'pending';

      const written = outcome.delivered
        ? withDb(volumeRoot, (db) => {
            db.prepare(`UPDATE notification_outbox SET status = 'delivered', attempts = ?, last_attempt_at = ?, last_error = NULL, delivered_at = ? WHERE id = ?`).run(
              outcome.attempts,
              now,
              now,
              row.id,
            );
          })
        : withDb(volumeRoot, (db) => {
            db.prepare(`UPDATE notification_outbox SET status = ?, attempts = ?, last_attempt_at = ?, last_error = ? WHERE id = ?`).run(
              nextStatus,
              outcome.attempts,
              now,
              lastError?.summary ?? null,
              row.id,
            );
          });

      // The bookkeeping write is checked, not assumed. A delivery that
      // succeeded but could not be recorded leaves the row `pending` on disk,
      // so the next pass sends it again — counting it `delivered` here would
      // make the report claim a state the volume does not agree with, and
      // hide the duplicate an operator is about to receive. The row is
      // counted as what it actually still is.
      if (!written.ok) {
        stillPending += 1;
        errors.push(
          notifierError(
            { code: 'delivery-failed', status: null, attempts: outcome.attempts },
            `outbox row '${row.id}' reached '${nextStatus}' but the status could not be written back, so it stays pending and will be attempted again: ${written.reason}`,
          ),
        );
        continue;
      }

      if (outcome.delivered) delivered += 1;
      else if (nextStatus === 'failed') failed += 1;
      else stillPending += 1;
    }

    return { delivered, failed, stillPending, errors };
  }

  return {
    /**
     * Writes through `tx`, never around it. The row and whatever the caller
     * is committing land together or not at all — which is the entire reason
     * the contract puts a transaction in this signature.
     *
     * Opening a connection here instead would break in both directions, and
     * both were demonstrated before this was written: a row enqueued inside a
     * transaction that later rolled back **survived** it, and a row enqueued
     * after the caller's transaction had already written was refused as busy
     * and **lost silently** — this member returns `void`, so there is no
     * channel through which a caller could ever learn it. That is exactly the
     * failure the same-transaction rule exists to prevent.
     *
     * Synchronous, per the contract: an `await` between the caller's other
     * writes and this one would be a window in which the transaction is open
     * and this row is not yet in it.
     */
    enqueue(request: NotificationRequest, tx: StoreTransaction): void {
      tx.run(
        `INSERT INTO notification_outbox (id, severity, declaration_id, payload, status, attempts, last_attempt_at, last_error, created_at, delivered_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, NULL)`,
        randomUUID(),
        request.severity,
        request.declarationId,
        JSON.stringify({ subject: request.subject, summary: request.summary }),
        clock.now(),
      );
    },

    async deliverPending(): Promise<DeliveryReport> {
      return serialised(() => deliverRows(['pending']));
    },

    /**
     * Boot's call. `pending` only, deliberately.
     *
     * The durability argument behind boot re-driving is about rows caught
     * mid-flight when a process died — those are `pending`. A `failed` row
     * was not lost to a crash: it exhausted its retries and reached a
     * decision, and the contract's answer for it is "mark it failed and
     * surface it, never drop it" — which `listFailed` and the health view
     * already do. Surfacing is not resending.
     *
     * Including `failed` here meant every restart re-POSTed the entire
     * history: fix a webhook credential that expired a week ago, restart, and
     * the operator is paged with hundreds of stale terminal states — merge
     * conflicts long since resolved, timeouts for operations already settled.
     * `clearFailed` is the sanctioned way back for a row an operator judges
     * still worth sending, one at a time and by a human's decision.
     */
    async redriveUndelivered(): Promise<DeliveryReport> {
      return serialised(() => deliverRows(['pending']));
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
    async clearFailed(id: OutboxRowId, actor: ActorRef): Promise<Outcome<void, NotifierError>> {
      const found = withDb(volumeRoot, (db) => db.prepare(`SELECT id FROM notification_outbox WHERE id = ? AND status = 'failed'`).get(id as string));
      if (!found.ok || !found.value) {
        return err(notifierError({ code: 'row-not-found', rowId: id }, `no failed outbox row '${id}'`));
      }
      // Checked, not assumed — the same discipline `deliverRows` applies to
      // its own write-back a few lines up. Returning `ok` on a write that did
      // not land tells an operator the row is cleared while it is still
      // `failed` on disk, and this member has an error channel precisely so it
      // need not. It matters more here than for a delivery write-back: a
      // delivery that cannot be recorded is retried by the next pass, whereas
      // `clearFailed` is the *only* way back for a `failed` row now that
      // `redriveUndelivered` is `pending`-only, so a silently lost clear
      // strands the row until someone thinks to try again.
      const cleared = withDb(volumeRoot, (db) => {
        db.prepare(`UPDATE notification_outbox SET status = 'pending', attempts = 0, last_attempt_at = NULL, last_error = NULL WHERE id = ?`).run(id as string);
      });
      if (!cleared.ok) {
        return err(notifierError({ code: 'delivery-failed', status: null, attempts: 0 }, `outbox row '${id}' could not be cleared: ${cleared.reason}`));
      }
      // `actor` is recorded rather than discarded, because resetting a row
      // that had already reached a terminal decision is an operator judgement
      // and someone will later ask who made it.
      //
      // **This is a log line, not an audit record, and that is a shortfall
      // rather than a design.** A durable, hash-chained record needs an
      // `AuditRecordBody` form for it, and none of the seven existing forms
      // describes an operator clearing an outbox row — adding one is a
      // contract amendment. This member has no HTTP route and no production
      // caller yet, so the amendment belongs with whichever slice gives it
      // one, alongside the route's own authorization.
      console.info(`notifier: outbox row '${id}' cleared back to pending by ${actor.kind}:${actor.subject}`);
      return ok(undefined);
    },

    async runRetention(): Promise<RetentionReport> {
      // S17 owns retention (`outbox_retention`'s index exists for it). Nothing prunes yet.
      return { module: 'notifier', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },
  };
}
