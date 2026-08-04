import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import { sha256Hex, type BranchName, type ClonePath, type CloneUrl, type DeclarationId, type GitSha, type IsoUtcTimestamp } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { Clock } from '../clock/clock.ts';
import type { Exec } from '../exec/exec.ts';
import type { Locks } from '../locks/locks.ts';
import type { LockHolder } from '../locks/types.ts';
import type { RetentionReport } from '../shared/retention.ts';
import { storeError, type StoreError } from '../store/errors.ts';
import { NO_VOLUME_USAGE, type VolumeUsage } from '../store/volume-usage.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import { cloneStoreError, type CloneStoreError } from './errors.ts';
import type { Clone, CloneHandle, CloneState, CorruptTreeOverride, EvictionBlocker, EvictionOutcome, ObservedGitState, SafeToEvictVerdict } from './types.ts';

export type MaintenanceReason = 'watermark' | 'scheduled' | 'manual';

export interface CloneStore {
  ensure(declaration: Declaration, holder: LockHolder, signal: AbortSignal): Promise<Outcome<CloneHandle, CloneStoreError>>;
  describe(declarationId: DeclarationId): Promise<Outcome<Clone, CloneStoreError>>;
  deriveAllStatesFromDisk(): Promise<readonly Clone[]>;
  observeGitState(declarationId: DeclarationId): Promise<Outcome<ObservedGitState, CloneStoreError>>;
  isSafeToEvict(declarationId: DeclarationId, acrossAllGenerations: boolean): Promise<Outcome<SafeToEvictVerdict, CloneStoreError>>;
  evictIfSafe(declarationId: DeclarationId): Promise<Outcome<EvictionOutcome, CloneStoreError>>;
  remove(declarationId: DeclarationId, override: CorruptTreeOverride, actor: ActorRef): Promise<Outcome<void, CloneStoreError>>;
  markAttention(declarationId: DeclarationId, reason: string): Promise<Outcome<void, CloneStoreError>>;
  clearAttention(declarationId: DeclarationId, actor: ActorRef): Promise<Outcome<void, CloneStoreError>>;
  readVolumeUsage(): Promise<Outcome<VolumeUsage, CloneStoreError>>;
  requestMaintenance(reason: MaintenanceReason): void;
  runRetention(): Promise<RetentionReport>;
}

export interface CloneStoreDependencies {
  readonly volumeRoot: string;
  readonly clock: Clock;
  readonly exec: Exec;
  readonly locks: Locks;
  readonly declarations: Pick<Declarations, 'get'>;
  readonly cloneSeconds?: number;
  readonly materialisationLockAcquireMs?: number;
}

const CLONE_SECONDS_DEFAULT = 300;
const MATERIALISATION_LOCK_ACQUIRE_MS_DEFAULT = 30_000;
const GIT_COMMAND_TIMEOUT_SECONDS = 30;

interface CloneRow {
  readonly declaration_id: string;
  readonly generation: number;
  readonly state: string;
  readonly path: string;
  readonly size_bytes: number;
  readonly last_operation_at: string | null;
  readonly observed_remote: string | null;
  readonly attention_reason: string | null;
}

function toClone(row: CloneRow): Clone {
  return {
    declarationId: row.declaration_id as DeclarationId,
    generation: row.generation as Clone['generation'],
    state: row.state as CloneState,
    path: row.path as ClonePath,
    sizeBytes: row.size_bytes,
    lastOperationAt: row.last_operation_at as IsoUtcTimestamp | null,
    observedRemote: row.observed_remote as CloneUrl | null,
    attentionReason: row.attention_reason,
  };
}

function withDb<T>(volumeRoot: string, fn: (db: DatabaseSync) => T): Outcome<T, StoreError> {
  mkdirSync(volumeRoot, { recursive: true });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    db.exec('PRAGMA foreign_keys = ON;');
  } catch {
    return err(storeError({ code: 'io-failed' }, 'could not open the structured store'));
  }
  try {
    return ok(fn(db));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return err(storeError({ code: 'io-failed' }, message));
  } finally {
    db.close();
  }
}

function directoryBytes(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let stat;
    try {
      stat = statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(current);
      } catch {
        entries = [];
      }
      for (const entry of entries) stack.push(path.join(current, entry));
    } else {
      total += stat.size;
    }
  }
  return total;
}

export function createCloneStore(deps: CloneStoreDependencies): CloneStore {
  const { volumeRoot, clock, exec, locks, declarations } = deps;
  const cloneSeconds = deps.cloneSeconds ?? CLONE_SECONDS_DEFAULT;
  const materialisationLockAcquireMs = deps.materialisationLockAcquireMs ?? MATERIALISATION_LOCK_ACQUIRE_MS_DEFAULT;
  const clonesRoot = path.join(volumeRoot, 'clones');

  function clonePathFor(declarationId: DeclarationId): ClonePath {
    return path.join(clonesRoot, declarationId) as ClonePath;
  }

  function getRow(declarationId: DeclarationId): CloneRow | null {
    const result = withDb(volumeRoot, (db) => {
      const rows = db.prepare('SELECT * FROM clone WHERE declaration_id = ?').all(declarationId) as unknown as CloneRow[];
      return rows[0] ?? null;
    });
    return result.ok ? result.value : null;
  }

  function upsertRow(row: Omit<CloneRow, 'generation'> & { readonly generation: number }): void {
    withDb(volumeRoot, (db) => {
      db.prepare(
        `INSERT INTO clone (declaration_id, generation, state, path, size_bytes, last_operation_at, observed_remote, attention_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(declaration_id) DO UPDATE SET
           generation = excluded.generation, state = excluded.state, path = excluded.path,
           size_bytes = excluded.size_bytes, last_operation_at = excluded.last_operation_at,
           observed_remote = excluded.observed_remote, attention_reason = excluded.attention_reason`,
      ).run(row.declaration_id, row.generation, row.state, row.path, row.size_bytes, row.last_operation_at, row.observed_remote, row.attention_reason);
    });
  }

  function deleteRow(declarationId: DeclarationId): void {
    withDb(volumeRoot, (db) => {
      db.prepare('DELETE FROM clone WHERE declaration_id = ?').run(declarationId);
    });
  }

  async function synthesizedAbsent(declarationId: DeclarationId): Promise<Clone> {
    const declaration = await declarations.get(declarationId);
    return {
      declarationId,
      generation: (declaration?.generation ?? 1) as Clone['generation'],
      state: 'absent',
      path: clonePathFor(declarationId),
      sizeBytes: 0,
      lastOperationAt: null,
      observedRemote: null,
      attentionReason: null,
    };
  }

  async function describeInternal(declarationId: DeclarationId): Promise<Clone> {
    const row = getRow(declarationId);
    return row ? toClone(row) : synthesizedAbsent(declarationId);
  }

  function removePartial(clonePath: string): void {
    try {
      rmSync(clonePath, { recursive: true, force: true });
    } catch {
      // Best-effort; a leftover partial directory is a disk-usage problem for
      // the maintenance pass, not a reason to fail the caller a second time.
    }
  }

  async function gitDirReadable(clonePath: string, signal: AbortSignal): Promise<boolean> {
    const result = await exec.runGit({
      argv: ['rev-parse', '--git-dir'],
      cwd: clonePath as ClonePath,
      timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS,
      credential: null,
      signal,
    });
    return result.ok;
  }

  async function readObservedRemote(clonePath: string, signal: AbortSignal): Promise<CloneUrl | null> {
    const result = await exec.runGit({
      argv: ['remote', 'get-url', 'origin'],
      cwd: clonePath as ClonePath,
      timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS,
      credential: null,
      signal,
    });
    return result.ok ? (result.value.stdout.trim() as CloneUrl) : null;
  }

  /** `PreState`/`ObservedGitState`'s digest inputs are U8, gated to S7 (`20-contract.md` § Unresolved) — this is a working implementation, not the canonical answer S7 will fix in the contract. */
  async function observeInternal(declarationId: DeclarationId, clonePath: string, signal: AbortSignal): Promise<ObservedGitState | null> {
    const branchResult = await exec.runGit({ argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    const headResult = await exec.runGit({ argv: ['rev-parse', 'HEAD'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    const upstreamResult = await exec.runGit({ argv: ['rev-parse', '@{u}'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    const statusResult = await exec.runGit({ argv: ['status', '--porcelain=v1'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });

    const branch = branchResult.ok && branchResult.value.stdout.trim() !== 'HEAD' ? (branchResult.value.stdout.trim() as BranchName) : null;
    const headSha = headResult.ok ? (headResult.value.stdout.trim() as GitSha) : null;
    const upstreamSha = upstreamResult.ok ? (upstreamResult.value.stdout.trim() as GitSha) : null;

    const indexPath = path.join(clonePath, '.git', 'index');
    let indexBytes: Buffer;
    try {
      indexBytes = existsSync(indexPath) ? readFileSync(indexPath) : Buffer.alloc(0);
    } catch {
      return null;
    }
    const indexDigestResult = sha256Hex(createHash('sha256').update(indexBytes).digest('hex'));
    const worktreeDigestResult = sha256Hex(createHash('sha256').update(statusResult.ok ? statusResult.value.stdout : '').digest('hex'));
    if (!indexDigestResult.ok || !worktreeDigestResult.ok) return null;

    return {
      branch,
      headSha,
      upstreamSha,
      indexDigest: indexDigestResult.value,
      worktreeDigest: worktreeDigestResult.value,
      observedAt: clock.now(),
    };
  }

  async function computeBlockers(declarationId: DeclarationId, clonePath: string, signal: AbortSignal): Promise<readonly EvictionBlocker[] | 'corrupt'> {
    if (!(await gitDirReadable(clonePath, signal))) return 'corrupt';

    const blockers: EvictionBlocker[] = [];
    const declaration = await declarations.get(declarationId);
    if (declaration?.pinned) blockers.push({ kind: 'pinned' });

    const statusResult = await exec.runGit({ argv: ['status', '--porcelain=v1'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    if (statusResult.ok && statusResult.value.stdout.trim().length > 0) blockers.push({ kind: 'worktree-dirty' });

    const stashResult = await exec.runGit({ argv: ['stash', 'list'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    if (stashResult.ok) {
      const count = stashResult.value.stdout.split('\n').filter((l) => l.trim().length > 0).length;
      if (count > 0) blockers.push({ kind: 'stash-present', count });
    }

    const baseBranch = ('main' as BranchName); // `RepositoryConfig` loading is `GitOperations`' (S6+); default until then.
    const branchResult = await exec.runGit({ argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    const branch = branchResult.ok ? (branchResult.value.stdout.trim() as BranchName) : null;

    const unreachableResult = await exec.runGit({
      argv: ['rev-list', '--count', `origin/${baseBranch}..HEAD`],
      cwd: clonePath as ClonePath,
      timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS,
      credential: null,
      signal,
    });
    if (unreachableResult.ok) {
      const count = Number(unreachableResult.value.stdout.trim());
      if (Number.isFinite(count) && count > 0) blockers.push({ kind: 'unreachable-commits', base: baseBranch, count });
    }

    const upstreamAheadResult = await exec.runGit({
      argv: ['rev-list', '--count', '@{u}..HEAD'],
      cwd: clonePath as ClonePath,
      timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS,
      credential: null,
      signal,
    });
    if (upstreamAheadResult.ok && branch) {
      const ahead = Number(upstreamAheadResult.value.stdout.trim());
      if (Number.isFinite(ahead) && ahead > 0) blockers.push({ kind: 'branch-ahead-of-upstream', branch, ahead });
    }

    if (locks.activeOperationCount(declarationId) > 0) {
      blockers.push({ kind: 'active-operations', count: locks.activeOperationCount(declarationId) });
    }

    // `open-journal-entry`: the journal does not exist until S7, so this
    // blocker can never fire yet — an honest absence, not a stub.

    return blockers;
  }

  return {
    async ensure(declaration, holder, signal): Promise<Outcome<CloneHandle, CloneStoreError>> {
      const lockResult = await locks.acquireMaterialisation(declaration.id, holder, materialisationLockAcquireMs, signal);
      if (!lockResult.ok) {
        return err(cloneStoreError({ code: 'store-failed', cause: storeError({ code: 'busy', attempts: 1 }, lockResult.error.summary) }, lockResult.error.summary));
      }
      const materialisationLock = lockResult.value;

      const current = await describeInternal(declaration.id);
      if (current.state === 'ready') {
        const pin = locks.pinActiveOperation(declaration.id);
        return ok({ clone: current, materialisationLock, activePin: pin });
      }

      const clonePath = clonePathFor(declaration.id);
      const declarationRecord = { id: declaration.id, generation: current.generation, cloneUrl: declaration.cloneUrl };

      // Adoption: a directory already on disk (left by a previous era) — never re-clone over it.
      if (existsSync(clonePath)) {
        if (!(await gitDirReadable(clonePath, signal))) {
          materialisationLock.release();
          return err(cloneStoreError({ code: 'corrupt-tree' }, `'${clonePath}' exists but git cannot read it — use clone.remove with its override`));
        }
        const observed = await readObservedRemote(clonePath, signal);
        if (observed !== null && observed !== declarationRecord.cloneUrl) {
          materialisationLock.release();
          return err(cloneStoreError({ code: 'remote-mismatch', declared: declarationRecord.cloneUrl, observed }, `the existing clone's remote does not match the declared one`));
        }
        const bytes = directoryBytes(clonePath);
        const now = clock.now();
        upsertRow({ declaration_id: declaration.id, generation: declarationRecord.generation, state: 'ready', path: clonePath, size_bytes: bytes, last_operation_at: now, observed_remote: observed, attention_reason: null });
        const readyClone = await describeInternal(declaration.id);
        const pin = locks.pinActiveOperation(declaration.id);
        return ok({ clone: readyClone, materialisationLock, activePin: pin });
      }

      // Fresh clone.
      mkdirSync(clonesRoot, { recursive: true });
      upsertRow({ declaration_id: declaration.id, generation: declarationRecord.generation, state: 'materialising', path: clonePath, size_bytes: 0, last_operation_at: null, observed_remote: null, attention_reason: null });

      const cloneResult = await exec.runGit({
        argv: ['clone', '--', declaration.cloneUrl, clonePath],
        cwd: clonesRoot as ClonePath,
        timeoutSeconds: cloneSeconds,
        credential: null,
        signal,
      });

      if (!cloneResult.ok) {
        removePartial(clonePath);
        upsertRow({ declaration_id: declaration.id, generation: declarationRecord.generation, state: 'absent', path: clonePath, size_bytes: 0, last_operation_at: null, observed_remote: null, attention_reason: null });
        materialisationLock.release();
        if (cloneResult.error.code === 'timed-out') {
          return err(cloneStoreError({ code: 'clone-timeout', limitSeconds: cloneSeconds }, `clone of '${declaration.id}' exceeded its ${cloneSeconds}s cap`));
        }
        return err(cloneStoreError({ code: 'clone-failed', cause: cloneResult.error }, `clone of '${declaration.id}' failed: ${cloneResult.error.summary}`));
      }

      const bytes = directoryBytes(clonePath);
      const now = clock.now();
      upsertRow({
        declaration_id: declaration.id,
        generation: declarationRecord.generation,
        state: 'ready',
        path: clonePath,
        size_bytes: bytes,
        last_operation_at: now,
        observed_remote: declarationRecord.cloneUrl,
        attention_reason: null,
      });
      const readyClone = await describeInternal(declaration.id);
      const pin = locks.pinActiveOperation(declaration.id);
      return ok({ clone: readyClone, materialisationLock, activePin: pin });
    },

    async describe(declarationId): Promise<Outcome<Clone, CloneStoreError>> {
      return ok(await describeInternal(declarationId));
    },

    async deriveAllStatesFromDisk(): Promise<readonly Clone[]> {
      const rowsResult = withDb(volumeRoot, (db) => db.prepare('SELECT * FROM clone').all() as unknown as CloneRow[]);
      if (!rowsResult.ok) return [];

      const derived: Clone[] = [];
      for (const row of rowsResult.value) {
        const clonePath = row.path;
        if (!existsSync(clonePath)) {
          if (row.state !== 'absent') {
            upsertRow({ ...row, state: 'absent', size_bytes: 0, observed_remote: null, attention_reason: null });
          }
          derived.push({ ...toClone(row), state: 'absent', sizeBytes: 0, observedRemote: null, attentionReason: null });
          continue;
        }
        const readable = await gitDirReadable(clonePath, new AbortController().signal);
        if (!readable) {
          upsertRow({ ...row, state: 'needs-attention', attention_reason: 'git could not read this tree at boot' });
          derived.push({ ...toClone(row), state: 'needs-attention', attentionReason: 'git could not read this tree at boot' });
          continue;
        }
        // The stored value is a report, not a source of truth (`10-design.md`
        // § boot step 8) — re-derive rather than trust `row.state`, but leave
        // an operator-set `needs-attention` alone: a readable tree does not
        // mean the parked reason (e.g. an unresolved journal entry, S7/S8) no
        // longer applies.
        const nextState: CloneState = row.state === 'needs-attention' ? 'needs-attention' : 'ready';
        const bytes = directoryBytes(clonePath);
        upsertRow({ ...row, state: nextState, size_bytes: bytes });
        derived.push({ ...toClone(row), state: nextState, sizeBytes: bytes });
      }
      return derived;
    },

    async observeGitState(declarationId): Promise<Outcome<ObservedGitState, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row || row.state === 'absent') {
        return err(cloneStoreError({ code: 'needs-attention', reason: 'no clone to observe' }, `'${declarationId}' has no clone to observe`));
      }
      const observed = await observeInternal(declarationId, row.path, new AbortController().signal);
      if (!observed) return err(cloneStoreError({ code: 'corrupt-tree' }, `could not observe git state for '${declarationId}'`));
      return ok(observed);
    },

    async isSafeToEvict(declarationId, _acrossAllGenerations): Promise<Outcome<SafeToEvictVerdict, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row || row.state === 'absent' || row.state === 'evicted') return ok({ safe: true });

      const blockers = await computeBlockers(declarationId, row.path, new AbortController().signal);
      if (blockers === 'corrupt') return err(cloneStoreError({ code: 'corrupt-tree' }, `'${declarationId}' cannot be evaluated — git cannot read the tree`));
      return blockers.length === 0 ? ok({ safe: true }) : ok({ safe: false, blockers });
    },

    async evictIfSafe(declarationId): Promise<Outcome<EvictionOutcome, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row || row.state === 'absent' || row.state === 'evicted') {
        return ok({ declarationId, evicted: false, freedBytes: 0, blockers: [] });
      }
      const blockers = await computeBlockers(declarationId, row.path, new AbortController().signal);
      if (blockers === 'corrupt' || blockers.length > 0) {
        return ok({ declarationId, evicted: false, freedBytes: 0, blockers: blockers === 'corrupt' ? [{ kind: 'corrupt-tree' }] : blockers });
      }
      const freedBytes = directoryBytes(row.path);
      removePartial(row.path);
      upsertRow({ ...row, state: 'evicted', size_bytes: 0, observed_remote: null });
      return ok({ declarationId, evicted: true, freedBytes, blockers: [] });
    },

    async remove(declarationId, override, _actor): Promise<Outcome<void, CloneStoreError>> {
      const row = getRow(declarationId);
      // The stored row is a report, not a source of truth (boot step 8's own
      // rule, applied here too): a directory can exist without a row —
      // orphaned before `ensure()` ever wrote one, or left by a process that
      // died mid-materialisation — and `remove()` must still reach it rather
      // than reporting nothing to do.
      const clonePath = row?.path ?? clonePathFor(declarationId);
      if ((!row || row.state === 'absent' || row.state === 'evicted') && !existsSync(clonePath)) {
        deleteRow(declarationId);
        return ok(undefined);
      }

      const signal = new AbortController().signal;
      const readable = await gitDirReadable(clonePath, signal);
      if (!readable) {
        if (!override.permitCorruptTree) {
          return err(cloneStoreError({ code: 'corrupt-tree' }, `'${declarationId}' is unreadable — pass permitCorruptTree to clone.remove to proceed`));
        }
        // Corrupt: the safe-to-remove predicate cannot be computed, and the
        // override exists exactly for this case (`20-contract.md` § Clone
        // store: "permits only a tree git cannot read").
      } else {
        const blockers = await computeBlockers(declarationId, clonePath, signal);
        if (blockers === 'corrupt' || blockers.length > 0) {
          return err(cloneStoreError({ code: 'not-safe-to-remove', blockers: blockers === 'corrupt' ? [{ kind: 'corrupt-tree' }] : blockers }, `'${declarationId}' is not safe to remove`));
        }
      }

      removePartial(clonePath);
      deleteRow(declarationId);
      return ok(undefined);
    },

    async markAttention(declarationId, reason): Promise<Outcome<void, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row) return err(cloneStoreError({ code: 'needs-attention', reason }, `no clone for '${declarationId}'`));
      upsertRow({ ...row, state: 'needs-attention', attention_reason: reason });
      return ok(undefined);
    },

    async clearAttention(declarationId, _actor): Promise<Outcome<void, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row) return err(cloneStoreError({ code: 'needs-attention', reason: 'no such clone' }, `no clone for '${declarationId}'`));
      upsertRow({ ...row, state: 'ready', attention_reason: null });
      return ok(undefined);
    },

    async readVolumeUsage(): Promise<Outcome<VolumeUsage, CloneStoreError>> {
      // Full disk accounting (total/used percent, the other four consumers)
      // is S17's watermark machinery. The clones figure is real; the rest are
      // honest zeros until that machinery exists.
      const rowsResult = withDb(volumeRoot, (db) => db.prepare('SELECT size_bytes FROM clone').all() as unknown as { size_bytes: number }[]);
      const clonesBytes = rowsResult.ok ? rowsResult.value.reduce((sum, r) => sum + r.size_bytes, 0) : 0;
      return ok({ ...NO_VOLUME_USAGE, byConsumer: { ...NO_VOLUME_USAGE.byConsumer, clones: clonesBytes } });
    },

    requestMaintenance(_reason): void {
      // S17 owns the maintenance pass this requests. Recorded as a no-op
      // rather than queued, since nothing consumes the request yet.
    },

    async runRetention(): Promise<RetentionReport> {
      return { module: 'clone-store', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },
  };
}
