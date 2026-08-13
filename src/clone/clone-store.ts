import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import { sha256Hex, type BranchName, type ClonePath, type CloneUrl, type DeclarationId, type Generation, type GitSha, type IsoUtcTimestamp, type OperationId, type RegistryToolName, type Sha256Hex } from '../shared/brands.ts';
import { canonicalize } from '../shared/canonical-json.ts';
import type { ActorRef } from '../shared/actor.ts';
import type { Clock } from '../clock/clock.ts';
import type { Exec } from '../exec/exec.ts';
import type { Locks } from '../locks/locks.ts';
import type { LockHolder } from '../locks/types.ts';
import type { Finding } from '../shared/result-kind.ts';
import { type MaintenanceReason, type RetentionReport } from '../shared/retention.ts';
import { storeError, type StoreError } from '../store/errors.ts';
import { DISK_WATERMARKS_DEFAULT, NO_VOLUME_USAGE, type DiskWatermarks, type VolumeConsumer, type VolumeUsage } from '../store/volume-usage.ts';
import type { StoreTableName, StructuredStore } from '../store/structured-store.ts';
import type { Journal } from '../journal/journal.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import { cloneStoreError, type CloneStoreError } from './errors.ts';
import type { Clone, CloneHandle, CloneState, CorruptTreeOverride, EvictionBlocker, EvictionOutcome, ObservedGitState, SafeToEvictVerdict } from './types.ts';

export type { MaintenanceReason };

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
  /** `20-contract.md` § Deployment configuration. Defaults to 85 / 95 (`DISK_WATERMARKS_DEFAULT`). */
  readonly watermarks?: DiskWatermarks;
  /**
   * `requestMaintenance` never awaits (`20-contract.md` § L1 — clone store):
   * it is called on the post-mutation path, where eviction must not run. The
   * actual pass is `Lifecycle.runMaintenance`, which `CloneStore` cannot
   * import without a cycle (`Lifecycle` already depends on `CloneStore` for
   * `deriveCloneStatesFromDisk`/`readVolumeUsage`/eviction) — so the
   * composition root wires this the same way it breaks every other such
   * cycle here (`server.ts`'s `cloneStoreRef` forward reference). Optional so
   * every pre-S27 test keeps compiling; without it, a watermark crossing is
   * simply not observed by anything.
   */
  readonly onMaintenanceRequested?: (reason: MaintenanceReason) => void;
  /**
   * S27.4's `open-journal-entry` blocker. Optional so every pre-S27 test
   * keeps compiling; without it, an open journal entry is honestly not
   * checked rather than silently treated as absent — the same "optional
   * dependency, honest absence" shape `Lifecycle`'s own optional owners use.
   */
  readonly journal?: Pick<Journal, 'unsettled'>;
  /**
   * Real disk statistics by default (`node:fs`'s `statfsSync`). Injectable
   * so a test can force a watermark crossing deterministically rather than
   * filling an actual disk — the same "swap the real thing for a test double
   * at the dependency boundary" shape `exec`/`clock`/`locks` already take.
   * `bfree` (blocks free, including those reserved for the filesystem's own
   * superuser reservation) is what `usedBytes` is computed from — `bavail`
   * (blocks available to this process) undercounts free space by that
   * reservation and would overstate `usedPercent` against what `df` reports
   * on the same volume.
   */
  readonly readDiskStats?: (volumeRoot: string) => { readonly blocks: number; readonly bsize: number; readonly bfree: number; readonly bavail: number };
  /**
   * The structured store's own per-table byte breakdown, folded into
   * `storeByTable`/`byConsumer['structured-store']` here the same way
   * `Lifecycle.runMaintenance` already overlays it onto its own usage
   * reading. Without this, `disk-full`'s findings (S27.2) would report every
   * one of the sixteen tables at a fabricated zero — `computeVolumeUsage`
   * only otherwise has the real figure for `clones`. Optional so every
   * pre-S27 test keeps compiling.
   */
  readonly store?: Pick<StructuredStore, 'usageByTable'>;
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
  const watermarks = deps.watermarks ?? DISK_WATERMARKS_DEFAULT;
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

  /**
   * `totalBytes`/`usedBytes`/`usedPercent` are real, read from the volume's
   * own filesystem statistics — the watermark machinery is meaningless
   * against a fabricated percentage. `clones` is real (summed from the
   * `clone` table). `structured-store`/`storeByTable` are real when
   * `deps.store` is wired (folded in from `StructuredStore.usageByTable`,
   * the same figure `Lifecycle.runMaintenance` overlays onto its own
   * reading) and honest zeros otherwise. `audit-log`, `backups-and-snapshots`
   * and `watcher-files` stay honest zeros — outside this slice's `Touches`
   * list, same reasoning as `store/volume-usage.ts`'s own doc comment.
   */
  const readDiskStats = deps.readDiskStats ?? statfsSync;

  async function computeVolumeUsage(): Promise<VolumeUsage> {
    const rowsResult = withDb(volumeRoot, (db) => db.prepare('SELECT size_bytes FROM clone').all() as unknown as { size_bytes: number }[]);
    const clonesBytes = rowsResult.ok ? rowsResult.value.reduce((sum, r) => sum + r.size_bytes, 0) : 0;

    let totalBytes = 0;
    let usedBytes = 0;
    try {
      const stats = readDiskStats(volumeRoot);
      totalBytes = stats.blocks * stats.bsize;
      // `bfree`, not `bavail`: `bavail` excludes the filesystem's own
      // superuser reservation, which this process does not consume — using
      // it would count that reservation as "used" and overstate `usedPercent`
      // against what `df` reports on the same volume.
      const freeBytes = stats.bfree * stats.bsize;
      usedBytes = Math.max(0, totalBytes - freeBytes);
    } catch {
      // The volume's filesystem stats are unreadable on this platform/mount —
      // honest zeros, the same direction `withDb`'s own failures take, rather
      // than fabricating a percentage nothing has measured.
    }

    let storeByTable = NO_VOLUME_USAGE.storeByTable;
    let structuredStoreBytes = 0;
    if (deps.store) {
      const byTable = await deps.store.usageByTable();
      if (byTable.ok) {
        storeByTable = byTable.value;
        structuredStoreBytes = Object.values(byTable.value).reduce((sum, bytes) => sum + bytes, 0);
      }
    }

    return {
      totalBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
      byConsumer: { ...NO_VOLUME_USAGE.byConsumer, clones: clonesBytes, 'structured-store': structuredStoreBytes },
      storeByTable,
    };
  }

  /**
   * S27.2's "the declarations blocking eviction": every currently
   * materialised declaration (`ready` or `needs-attention`), with whatever
   * `computeBlockers` finds for it. Only ever called on the rare refuse path
   * — one `git status`/`stash list`/`rev-list` round trip per declaration is
   * an acceptable cost at the 95 % watermark, not on the ordinary path.
   */
  async function evictionBlockersAcrossDeclarations(): Promise<ReadonlyMap<DeclarationId, readonly EvictionBlocker[]>> {
    const rowsResult = withDb(volumeRoot, (db) =>
      db.prepare(`SELECT declaration_id, generation, path FROM clone WHERE state IN ('ready', 'needs-attention')`).all() as unknown as { declaration_id: string; generation: number; path: string }[],
    );
    const result = new Map<DeclarationId, readonly EvictionBlocker[]>();
    if (!rowsResult.ok) return result;
    for (const row of rowsResult.value) {
      const declarationId = row.declaration_id as DeclarationId;
      const blockers = await computeBlockers(declarationId, row.generation as Generation, row.path, new AbortController().signal);
      result.set(declarationId, blockers === 'corrupt' ? [{ kind: 'corrupt-tree' }] : blockers);
    }
    return result;
  }

  /**
   * S27.2's findings: all five volume consumers, the structured-store
   * breakdown by all sixteen tables, and every declaration whose blockers
   * prevented release — flattened into `Finding`s so `moduleErrorToToolResult`
   * (`dispatch-pipeline.ts`) can carry them generically, the same path
   * `authorization()`'s missing-capability findings already take.
   */
  function diskFullFindings(usage: VolumeUsage, blockersByDeclaration: ReadonlyMap<DeclarationId, readonly EvictionBlocker[]>): readonly Finding[] {
    const findings: Finding[] = [];
    for (const consumer of Object.keys(usage.byConsumer) as VolumeConsumer[]) {
      findings.push({ path: 'volume.byConsumer', rule: consumer, message: `${usage.byConsumer[consumer]} bytes` });
    }
    for (const table of Object.keys(usage.storeByTable) as StoreTableName[]) {
      findings.push({ path: 'volume.storeByTable', rule: table, message: `${usage.storeByTable[table]} bytes` });
    }
    for (const [declarationId, blockers] of blockersByDeclaration) {
      if (blockers.length === 0) continue;
      findings.push({ path: 'volume.evictionBlocked', rule: declarationId as string, message: blockers.map((b) => b.kind).join(', ') });
    }
    return findings;
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
   * `Declaration.identity` (`git_user_name`/`git_user_email`) has nowhere
   * else to land: a mutating tool commits with no author identity of its
   * own, and the neutral exec environment (`exec.ts`'s `neutralGitEnv`)
   * deliberately carries no global `user.name`/`user.email` for a real
   * commit to inherit. Configuring it on every path that returns a *newly*
   * `ready` clone — a fresh clone or an adoption — is what makes `git_commit`
   * (S7) able to run at all; both command outcomes are checked, so a failed
   * write reports `store-failed` rather than silently marking the clone
   * ready with no identity configured. **Not** run on the already-`ready`
   * fast path (unchanged generation, no adoption): that path is also the
   * one every read call takes, so re-running two `git config` calls on it
   * would tax every read for a write-only concern. A clone materialised
   * before this fix shipped, or whose declaration's identity changed after
   * materialisation, is not re-configured until its clone is next adopted or
   * re-cloned — a known, narrower gap than "every `ensure()` call", recorded
   * rather than silently left unstated.
   */
  async function configureIdentity(clonePath: string, declaration: Declaration, signal: AbortSignal): Promise<Outcome<void, CloneStoreError>> {
    const nameResult = await exec.runGit({ argv: ['config', 'user.name', declaration.identity.gitUserName], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    if (!nameResult.ok) {
      return err(cloneStoreError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, nameResult.error.summary) }, `could not configure user.name for '${declaration.id}': ${nameResult.error.summary}`));
    }
    const emailResult = await exec.runGit({ argv: ['config', 'user.email', declaration.identity.gitUserEmail], cwd: clonePath as ClonePath, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
    if (!emailResult.ok) {
      return err(cloneStoreError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, emailResult.error.summary) }, `could not configure user.email for '${declaration.id}': ${emailResult.error.summary}`));
    }
    return ok(undefined);
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
  async function computeBlockers(declarationId: DeclarationId, generation: Generation, clonePath: string, signal: AbortSignal): Promise<readonly EvictionBlocker[] | 'corrupt'> {
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

    // S27.4's `open-journal-entry` blocker: an entry not yet `settled` for
    // this declaration's current era. Optional dependency — an honest
    // absence when no journal is wired, per `CloneStoreDependencies.journal`'s
    // doc comment, never a silent "nothing open". A failed read fails closed
    // like every other probe above (this function's own doc comment): a
    // journal read that could not run is not evidence the entry is settled.
    if (deps.journal) {
      const unsettled = await deps.journal.unsettled(declarationId, generation);
      if (!unsettled.ok) return 'corrupt';
      for (const entry of unsettled.value) blockers.push({ kind: 'open-journal-entry', operationId: entry.operationId });
    }

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

      // `needs-attention` is materialised, not absent: the directory is on
      // disk and readable, and a parked declaration still serves reads and a
      // repair session (S8). It is grouped with `ready` here so `ensure` hands
      // the existing clone back rather than falling through to the adoption
      // branch below, which would rewrite the row as `ready` with a null
      // `attention_reason` — silently unparking a declaration a human was
      // asked to look at, on the next read that happened to arrive.
      if (current.value.state === 'ready' || current.value.state === 'needs-attention') {
        // Reconcile a stale row (review finding #5): adoption bumps
        // `Declaration.generation`, and a clone materialised under a
        // previous era must not keep reporting that previous era's
        // generation once its declaration has moved on.
        if (current.value.generation !== declaration.generation) {
          const reconciled = upsertRow({
            declaration_id: declaration.id,
            generation: declaration.generation,
            // The generation moved; the attention state did not. Only the era
            // is being reconciled here.
            state: current.value.state,
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
        const identitySet = await configureIdentity(clonePath, declaration, signal);
        if (!identitySet.ok) {
          materialisationLock.release();
          return identitySet;
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

      // S27.2: the refuse watermark. Checked only here — a fresh clone is
      // the one case in `ensure()` that actually consumes new volume space;
      // adoption and the already-`ready`/`needs-attention` fast paths above
      // need none. `10-design.md` § disk pressure: "at 95 % operations
      // needing space are refused", not evicted inline — this refuses
      // outright rather than attempting an eviction under the materialisation
      // lock this call already holds, which invariant C4/rule 3 forbid.
      let usageBeforeClone: VolumeUsage;
      try {
        usageBeforeClone = await computeVolumeUsage();
      } catch (cause) {
        // `computeVolumeUsage` reads through `withDb`, whose `mkdirSync` and
        // `db.close()` are not themselves guarded — a throw here must not
        // leak the materialisation lock this call is still holding.
        materialisationLock.release();
        const message = cause instanceof Error ? cause.message : String(cause);
        return err(cloneStoreError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, message) }, message));
      }
      if (usageBeforeClone.usedPercent >= watermarks.refuseAtPercent) {
        materialisationLock.release();
        const blockersByDeclaration = await evictionBlockersAcrossDeclarations();
        const flatBlockers = [...blockersByDeclaration.values()].flat();
        return err(
          cloneStoreError(
            { code: 'disk-full', usage: usageBeforeClone, evictionBlockers: flatBlockers },
            `the volume is at ${usageBeforeClone.usedPercent.toFixed(1)}% — refusing to materialise a new clone for '${declaration.id}'`,
            diskFullFindings(usageBeforeClone, blockersByDeclaration),
          ),
        );
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

      const identitySet = await configureIdentity(clonePath, declaration, signal);
      if (!identitySet.ok) {
        removePartial(clonePath);
        upsertRow({ declaration_id: declaration.id, generation: declarationRecord.generation, state: 'absent', path: clonePath, size_bytes: 0, last_operation_at: null, observed_remote: null, attention_reason: null });
        materialisationLock.release();
        return identitySet;
      }

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
          // `evicted` is left alone, the same as `needs-attention` further
          // down: a missing directory is what eviction itself produces, and
          // downgrading it to `absent` here would erase the distinction
          // `EvictionOutcome`/the maintenance summary rely on between
          // "released under disk pressure" and "never materialised" — this
          // routine runs mid-service now (S27's maintenance pass), not only
          // at boot, so a row this same pass just evicted is routinely seen
          // here.
          if (row.state !== 'absent' && row.state !== 'evicted') {
            upsertRow({ ...row, state: 'absent', size_bytes: 0, observed_remote: null, attention_reason: null });
          }
          const missingState = row.state === 'evicted' ? 'evicted' : 'absent';
          derived.push({ ...toClone(row), state: missingState, sizeBytes: 0, observedRemote: null, attentionReason: null });
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

      const blockers = await computeBlockers(declarationId, row.value.generation as Generation, row.value.path, new AbortController().signal);
      if (blockers === 'corrupt') return err(cloneStoreError({ code: 'corrupt-tree' }, `'${declarationId}' cannot be evaluated — git cannot read the tree`));
      return blockers.length === 0 ? ok({ safe: true }) : ok({ safe: false, blockers });
    },

    /**
     * S27.3: refuses while `activeOperationCount` is non-zero (`10-design.md`
     * § the lock protocol, rule 4 — "the counter is checked on the eviction
     * side precisely because the read side cannot afford to block"), and
     * takes the declaration's materialisation lock for the rest of the
     * check (rule 3 — "the pass runs with no mutation lock held and takes
     * materialisation locks in its own right"). The lock wait is zero: an
     * evicting pass that finds the lock held skips the declaration and moves
     * on, the same "skip, do not block" shape the counter check already
     * takes, rather than stalling the whole maintenance pass behind one busy
     * declaration.
     */
    async evictIfSafe(declarationId): Promise<Outcome<EvictionOutcome, CloneStoreError>> {
      const row = getRow(declarationId);
      if (!row.ok) return err(cloneStoreError({ code: 'store-failed', cause: row.error }, row.error.summary));
      if (!row.value || row.value.state === 'absent' || row.value.state === 'evicted') {
        return ok({ declarationId, evicted: false, freedBytes: 0, blockers: [] });
      }

      const activeCount = locks.activeOperationCount(declarationId);
      if (activeCount > 0) {
        return ok({ declarationId, evicted: false, freedBytes: 0, blockers: [{ kind: 'active-operations', count: activeCount }] });
      }

      const holder: LockHolder = { operationId: randomUUID() as OperationId, declarationId, tool: 'lifecycle.evict' as RegistryToolName, heldSince: clock.now() };
      const lockResult = await locks.acquireMaterialisation(declarationId, holder, 0, new AbortController().signal);
      if (!lockResult.ok) {
        // Held by a concurrent `ensure()` — something is actively
        // materialising or mutating this declaration right now, even though
        // the counter above may not yet reflect it (`ensure()` pins only
        // once materialisation completes). Re-read the counter rather than
        // reporting a fixed number: it may since have been pinned, and a
        // floor of 1 reflects the one thing this branch does know for
        // certain — the lock is held by someone.
        const recount = Math.max(1, locks.activeOperationCount(declarationId));
        return ok({ declarationId, evicted: false, freedBytes: 0, blockers: [{ kind: 'active-operations', count: recount }] });
      }
      try {
        const blockers = await computeBlockers(declarationId, row.value.generation as Generation, row.value.path, new AbortController().signal);
        if (blockers === 'corrupt' || blockers.length > 0) {
          return ok({ declarationId, evicted: false, freedBytes: 0, blockers: blockers === 'corrupt' ? [{ kind: 'corrupt-tree' }] : blockers });
        }
        const freedBytes = directoryBytes(row.value.path);
        removePartial(row.value.path);
        const updated = upsertRow({ ...row.value, state: 'evicted', size_bytes: 0, observed_remote: null });
        if (!updated.ok) return err(cloneStoreError({ code: 'store-failed', cause: updated.error }, updated.error.summary));
        return ok({ declarationId, evicted: true, freedBytes, blockers: [] });
      } finally {
        lockResult.value.release();
      }
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
        // A directory without a row (orphaned before `ensure()` ever wrote
        // one) has no stored generation to read — falls back to the
        // declaration's current one, or 1 if even that is gone.
        const generation = (row.value?.generation ?? (await declarations.get(declarationId))?.generation ?? 1) as Generation;
        const blockers = await computeBlockers(declarationId, generation, clonePath, signal);
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
      try {
        return ok(await computeVolumeUsage());
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return err(cloneStoreError({ code: 'store-failed', cause: storeError({ code: 'io-failed' }, message) }, message));
      }
    },

    requestMaintenance(reason): void {
      // Fire-and-forget (`20-contract.md` § L1 — clone store: "never awaits,
      // because it is called on the post-mutation path, where eviction must
      // not run"). `onMaintenanceRequested` is how the composition root
      // wires this to `Lifecycle.runMaintenance` without a module cycle —
      // see `CloneStoreDependencies.onMaintenanceRequested`'s doc comment.
      deps.onMaintenanceRequested?.(reason);
    },

    async runRetention(): Promise<RetentionReport> {
      // Clone rows have no age-based retention window — a clone is removed
      // only by eviction (disk-pressure driven) or by an operator's
      // `clone.remove`, both distinct from this age-based mechanism. An
      // honest no-op, not a stub: there is nothing this module's own
      // `runRetention` will ever prune.
      return { module: 'clone-store', deletedRows: 0, freedBytes: 0, skipped: [] };
    },
  };
}
