import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import { sha256Hex, type BranchName, type ClonePath, type CloneUrl, type DeclarationId, type GitSha, type IsoUtcTimestamp, type Sha256Hex } from '../shared/brands.ts';
import { canonicalize } from '../shared/canonical-json.ts';
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

  /**
   * `null` means "no row" — a real, distinct answer from a failure to read
   * the store at all, which is `err(...)`. Callers must not conflate the two
   * (review finding #1): a store failure reported as "no row" would let
   * `describe()` claim `absent` for a repository that may well be cloned,
   * inviting a duplicate clone or an unsafe eviction decision made on
   * fabricated data.
   */
  function getRow(declarationId: DeclarationId): Outcome<CloneRow | null, StoreError> {
    return withDb(volumeRoot, (db) => {
      const rows = db.prepare('SELECT * FROM clone WHERE declaration_id = ?').all(declarationId) as unknown as CloneRow[];
      return rows[0] ?? null;
    });
  }

  function upsertRow(row: Omit<CloneRow, 'generation'> & { readonly generation: number }): Outcome<void, StoreError> {
    return withDb(volumeRoot, (db) => {
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

  function deleteRow(declarationId: DeclarationId): Outcome<void, StoreError> {
    return withDb(volumeRoot, (db) => {
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

  /** The store-failed path callers must not paper over — see `getRow`'s doc comment. */
  async function describeInternal(declarationId: DeclarationId): Promise<Outcome<Clone, CloneStoreError>> {
    const row = getRow(declarationId);
    if (!row.ok) return err(cloneStoreError({ code: 'store-failed', cause: row.error }, row.error.summary));
    return ok(row.value ? toClone(row.value) : await synthesizedAbsent(declarationId));
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

  /**
   * `null` is only a truthful answer when the caller already knows no clone
   * exists. For a directory that *does* exist, a failed `remote get-url`
   * must not be read as "no conflict" (review finding #3) — an unreadable
   * origin is exactly the case invariant "never repoint an existing
   * checkout" exists to guard, and silently adopting it would be repointing
   * blind. Every call site below only calls this after confirming the
   * directory is present, so a failure here is always treated as refusing,
   * never as "nothing to compare against".
   */
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

  /**
   * `20-contract.md` § Clone, U8's resolution (fixed by S7): `indexDigest`
   * covers `git ls-files --stage`'s entries (path, mode, blob id, stage
   * number) in that command's own order; `worktreeDigest` covers `git status
   * --porcelain=v1`'s lines (path, working-tree status column) in that
   * command's order. Neither command writes to the object database — in
   * particular this is never `git write-tree`, which a deliberately unmerged
   * index would fail. `canonicalize` is the same deep key-sorted JSON the
   * audit trail's record hash uses (U9); array order is preserved by it, so
   * the ordering above is the contract, not an implementation detail.
   */
  async function computePreStateDigests(clonePath: string, signal: AbortSignal): Promise<{ readonly indexDigest: Sha256Hex; readonly worktreeDigest: Sha256Hex } | null> {
    const lsFilesResult = await exec.runGit({ argv: ['ls-files', '--stage'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    const statusResult = await exec.runGit({ argv: ['status', '--porcelain=v1'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    if (!lsFilesResult.ok || !statusResult.ok) return null;

    // `git ls-files --stage` lines: `<mode> <blob> <stage>\t<path>`.
    const indexEntries = lsFilesResult.value.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const tabIndex = line.indexOf('\t');
        const meta = (tabIndex === -1 ? line : line.slice(0, tabIndex)).trim().split(/\s+/);
        const entryPath = tabIndex === -1 ? '' : line.slice(tabIndex + 1);
        return { path: entryPath, mode: meta[0] ?? '', blobId: meta[1] ?? '', stage: Number(meta[2] ?? '0') };
      });

    // `git status --porcelain=v1` lines: `XY <path>` (renames carry ` -> `,
    // irrelevant here since only the path and the worktree column matter).
    const worktreeEntries = statusResult.value.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const indexStatus = line[0] ?? ' ';
        const worktreeStatus = line[1] ?? ' ';
        const entryPath = line.slice(3);
        const status = indexStatus === '?' && worktreeStatus === '?' ? '?' : worktreeStatus;
        return { path: entryPath, workingTreeStatus: status };
      })
      .filter((entry) => entry.workingTreeStatus !== ' ');

    const indexDigestResult = sha256Hex(createHash('sha256').update(canonicalize(indexEntries), 'utf8').digest('hex'));
    const worktreeDigestResult = sha256Hex(createHash('sha256').update(canonicalize(worktreeEntries), 'utf8').digest('hex'));
    if (!indexDigestResult.ok || !worktreeDigestResult.ok) return null;
    return { indexDigest: indexDigestResult.value, worktreeDigest: worktreeDigestResult.value };
  }

  async function observeInternal(declarationId: DeclarationId, clonePath: string, signal: AbortSignal): Promise<ObservedGitState | null> {
    const branchResult = await exec.runGit({ argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    const headResult = await exec.runGit({ argv: ['rev-parse', 'HEAD'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    const upstreamResult = await exec.runGit({ argv: ['rev-parse', '@{u}'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });

    const branch = branchResult.ok && branchResult.value.stdout.trim() !== 'HEAD' ? (branchResult.value.stdout.trim() as BranchName) : null;
    const headSha = headResult.ok ? (headResult.value.stdout.trim() as GitSha) : null;
    const upstreamSha = upstreamResult.ok ? (upstreamResult.value.stdout.trim() as GitSha) : null;

    const digests = await computePreStateDigests(clonePath, signal);
    if (!digests) return null;

    return {
      branch,
      headSha,
      upstreamSha,
      indexDigest: digests.indexDigest,
      worktreeDigest: digests.worktreeDigest,
      observedAt: clock.now(),
    };
  }

  /**
   * Fails closed (review finding #2): every safety-relevant probe — `status`,
   * `stash list`, the unreachable-commits count against `origin/<base>` —
   * returns `'corrupt'` on its own failure rather than silently contributing
   * zero blockers. A command that cannot run is not evidence of safety, and
   * treating it as "nothing to report" is exactly what let `remove()`/
   * eviction delete a tree whose safety was never actually established.
   *
   * The upstream-ahead check (`@{u}`) is the one exception: a branch with no
   * configured upstream fails that command legitimately and constantly, and
   * there is nothing to be "ahead of" when there is no upstream to compare
   * against — the unpushed-work risk that check would catch is already
   * covered by the unreachable-commits check above it.
   */
  async function computeBlockers(declarationId: DeclarationId, clonePath: string, signal: AbortSignal): Promise<readonly EvictionBlocker[] | 'corrupt'> {
    if (!(await gitDirReadable(clonePath, signal))) return 'corrupt';

    const blockers: EvictionBlocker[] = [];
    const declaration = await declarations.get(declarationId);
    if (declaration?.pinned) blockers.push({ kind: 'pinned' });

    const statusResult = await exec.runGit({ argv: ['status', '--porcelain=v1'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    if (!statusResult.ok) return 'corrupt';
    if (statusResult.value.stdout.trim().length > 0) blockers.push({ kind: 'worktree-dirty' });

    const stashResult = await exec.runGit({ argv: ['stash', 'list'], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    if (!stashResult.ok) return 'corrupt';
    const stashCount = stashResult.value.stdout.split('\n').filter((l) => l.trim().length > 0).length;
    if (stashCount > 0) blockers.push({ kind: 'stash-present', count: stashCount });

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
    if (!unreachableResult.ok) return 'corrupt';
    const unreachableCount = Number(unreachableResult.value.stdout.trim());
    if (Number.isFinite(unreachableCount) && unreachableCount > 0) blockers.push({ kind: 'unreachable-commits', base: baseBranch, count: unreachableCount });

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
      if (!current.ok) {
        materialisationLock.release();
        return current;
      }

      if (current.value.state === 'ready') {
        // Reconcile a stale row (review finding #5): adoption bumps
        // `Declaration.generation`, and a clone materialised under a
        // previous era must not keep reporting that previous era's
        // generation once its declaration has moved on.
        if (current.value.generation !== declaration.generation) {
          const reconciled = upsertRow({
            declaration_id: declaration.id,
            generation: declaration.generation,
            state: 'ready',
            path: current.value.path,
            size_bytes: current.value.sizeBytes,
            last_operation_at: current.value.lastOperationAt,
            observed_remote: current.value.observedRemote,
            attention_reason: current.value.attentionReason,
          });
          if (!reconciled.ok) {
            materialisationLock.release();
            return err(cloneStoreError({ code: 'store-failed', cause: reconciled.error }, reconciled.error.summary));
          }
          const afterReconcile = await describeInternal(declaration.id);
          if (!afterReconcile.ok) {
            materialisationLock.release();
            return afterReconcile;
          }
          const pin = locks.pinActiveOperation(declaration.id);
          return ok({ clone: afterReconcile.value, materialisationLock, activePin: pin });
        }
        const pin = locks.pinActiveOperation(declaration.id);
        return ok({ clone: current.value, materialisationLock, activePin: pin });
      }

      const clonePath = clonePathFor(declaration.id);
      // `declaration.generation` — the caller's authoritative value — never
      // the possibly-stale row's, per review finding #5.
      const declarationRecord = { id: declaration.id, generation: declaration.generation, cloneUrl: declaration.cloneUrl };

      // Adoption: a directory already on disk (left by a previous era) — never re-clone over it.
      if (existsSync(clonePath)) {
        if (!(await gitDirReadable(clonePath, signal))) {
          materialisationLock.release();
          return err(cloneStoreError({ code: 'corrupt-tree' }, `'${clonePath}' exists but git cannot read it — use clone.remove with its override`));
        }
        const observed = await readObservedRemote(clonePath, signal);
        if (observed === null) {
          materialisationLock.release();
          return err(cloneStoreError({ code: 'corrupt-tree' }, `'${clonePath}' exists but its remote could not be verified — use clone.remove with its override`));
        }
        if (observed !== declarationRecord.cloneUrl) {
          materialisationLock.release();
          return err(cloneStoreError({ code: 'remote-mismatch', declared: declarationRecord.cloneUrl, observed }, `the existing clone's remote does not match the declared one`));
        }
        const bytes = directoryBytes(clonePath);
        const now = clock.now();
        const written = upsertRow({ declaration_id: declaration.id, generation: declarationRecord.generation, state: 'ready', path: clonePath, size_bytes: bytes, last_operation_at: now, observed_remote: observed, attention_reason: null });
        if (!written.ok) {
          materialisationLock.release();
          return err(cloneStoreError({ code: 'store-failed', cause: written.error }, written.error.summary));
        }
        const readyClone = await describeInternal(declaration.id);
        if (!readyClone.ok) {
          materialisationLock.release();
          return readyClone;
        }
        const pin = locks.pinActiveOperation(declaration.id);
        return ok({ clone: readyClone.value, materialisationLock, activePin: pin });
      }

      // Fresh clone.
      mkdirSync(clonesRoot, { recursive: true });
      const materialising = upsertRow({ declaration_id: declaration.id, generation: declarationRecord.generation, state: 'materialising', path: clonePath, size_bytes: 0, last_operation_at: null, observed_remote: null, attention_reason: null });
      if (!materialising.ok) {
        materialisationLock.release();
        return err(cloneStoreError({ code: 'store-failed', cause: materialising.error }, materialising.error.summary));
      }

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

      // `Declaration.identity` (`git_user_name`/`git_user_email`) has nowhere
      // else to land: a mutating tool commits with no author identity of its
      // own, and the neutral exec environment (`exec.ts`'s `neutralGitEnv`)
      // deliberately carries no global `user.name`/`user.email` for a real
      // commit to inherit. Configuring it once, here, at materialisation
      // time is what makes `git_commit` (S7) able to run at all — the
      // declaration record is the only place this identity is ever declared.
      await exec.runGit({ argv: ['config', 'user.name', declaration.identity.gitUserName], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
      await exec.runGit({ argv: ['config', 'user.email', declaration.identity.gitUserEmail], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });

      const bytes = directoryBytes(clonePath);
      const now = clock.now();
      const written = upsertRow({
        declaration_id: declaration.id,
        generation: declarationRecord.generation,
        state: 'ready',
        path: clonePath,
        size_bytes: bytes,
        last_operation_at: now,
        observed_remote: declarationRecord.cloneUrl,
        attention_reason: null,
      });
      if (!written.ok) {
        materialisationLock.release();
        return err(cloneStoreError({ code: 'store-failed', cause: written.error }, written.error.summary));
      }
      const readyClone = await describeInternal(declaration.id);
      if (!readyClone.ok) {
        materialisationLock.release();
        return readyClone;
      }
      const pin = locks.pinActiveOperation(declaration.id);
      return ok({ clone: readyClone.value, materialisationLock, activePin: pin });
    },

    async describe(declarationId): Promise<Outcome<Clone, CloneStoreError>> {
      return describeInternal(declarationId);
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
      if (!row.ok) return err(cloneStoreError({ code: 'store-failed', cause: row.error }, row.error.summary));
      if (!row.value || row.value.state === 'absent') {
        return err(cloneStoreError({ code: 'needs-attention', reason: 'no clone to observe' }, `'${declarationId}' has no clone to observe`));
      }
      const observed = await observeInternal(declarationId, row.value.path, new AbortController().signal);
      if (!observed) return err(cloneStoreError({ code: 'corrupt-tree' }, `could not observe git state for '${declarationId}'`));
      return ok(observed);
    },

    async isSafeToEvict(declarationId, _acrossAllGenerations): Promise<Outcome<SafeToEvictVerdict, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row.ok) return err(cloneStoreError({ code: 'store-failed', cause: row.error }, row.error.summary));
      if (!row.value || row.value.state === 'absent' || row.value.state === 'evicted') return ok({ safe: true });

      const blockers = await computeBlockers(declarationId, row.value.path, new AbortController().signal);
      if (blockers === 'corrupt') return err(cloneStoreError({ code: 'corrupt-tree' }, `'${declarationId}' cannot be evaluated — git cannot read the tree`));
      return blockers.length === 0 ? ok({ safe: true }) : ok({ safe: false, blockers });
    },

    async evictIfSafe(declarationId): Promise<Outcome<EvictionOutcome, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row.ok) return err(cloneStoreError({ code: 'store-failed', cause: row.error }, row.error.summary));
      if (!row.value || row.value.state === 'absent' || row.value.state === 'evicted') {
        return ok({ declarationId, evicted: false, freedBytes: 0, blockers: [] });
      }
      const blockers = await computeBlockers(declarationId, row.value.path, new AbortController().signal);
      if (blockers === 'corrupt' || blockers.length > 0) {
        return ok({ declarationId, evicted: false, freedBytes: 0, blockers: blockers === 'corrupt' ? [{ kind: 'corrupt-tree' }] : blockers });
      }
      const freedBytes = directoryBytes(row.value.path);
      removePartial(row.value.path);
      const updated = upsertRow({ ...row.value, state: 'evicted', size_bytes: 0, observed_remote: null });
      if (!updated.ok) return err(cloneStoreError({ code: 'store-failed', cause: updated.error }, updated.error.summary));
      return ok({ declarationId, evicted: true, freedBytes, blockers: [] });
    },

    async remove(declarationId, override, _actor): Promise<Outcome<void, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row.ok) return err(cloneStoreError({ code: 'store-failed', cause: row.error }, row.error.summary));

      // The stored row is a report, not a source of truth (boot step 8's own
      // rule, applied here too): a directory can exist without a row —
      // orphaned before `ensure()` ever wrote one, or left by a process that
      // died mid-materialisation — and `remove()` must still reach it rather
      // than reporting nothing to do.
      const clonePath = row.value?.path ?? clonePathFor(declarationId);
      if ((!row.value || row.value.state === 'absent' || row.value.state === 'evicted') && !existsSync(clonePath)) {
        const deleted = deleteRow(declarationId);
        if (!deleted.ok) return err(cloneStoreError({ code: 'store-failed', cause: deleted.error }, deleted.error.summary));
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
      const deleted = deleteRow(declarationId);
      if (!deleted.ok) return err(cloneStoreError({ code: 'store-failed', cause: deleted.error }, deleted.error.summary));
      return ok(undefined);
    },

    async markAttention(declarationId, reason): Promise<Outcome<void, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row.ok) return err(cloneStoreError({ code: 'store-failed', cause: row.error }, row.error.summary));
      if (!row.value) return err(cloneStoreError({ code: 'needs-attention', reason }, `no clone for '${declarationId}'`));
      const updated = upsertRow({ ...row.value, state: 'needs-attention', attention_reason: reason });
      if (!updated.ok) return err(cloneStoreError({ code: 'store-failed', cause: updated.error }, updated.error.summary));
      return ok(undefined);
    },

    async clearAttention(declarationId, _actor): Promise<Outcome<void, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row.ok) return err(cloneStoreError({ code: 'store-failed', cause: row.error }, row.error.summary));
      if (!row.value) return err(cloneStoreError({ code: 'needs-attention', reason: 'no such clone' }, `no clone for '${declarationId}'`));
      const updated = upsertRow({ ...row.value, state: 'ready', attention_reason: null });
      if (!updated.ok) return err(cloneStoreError({ code: 'store-failed', cause: updated.error }, updated.error.summary));
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
