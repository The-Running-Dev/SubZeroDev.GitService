import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gitSha, type BranchName, type DeclarationId } from '../shared/brands.ts';
import type { PendingPullRequest, PendingPullRequestList } from './types.ts';

const EMPTY_LIST: PendingPullRequestList = { entries: [] };

/** A structurally valid array element that is not itself a well-formed `PendingPullRequest` — e.g. `{}` — must not reach `pr_status` as `{ number: undefined }`; the "missing or unparseable list is treated as empty" guarantee is applied per entry, not just to the file as a whole. */
function isWellFormedEntry(value: unknown): value is PendingPullRequest {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.declarationId === 'string' &&
    typeof record.number === 'number' &&
    Number.isFinite(record.number) &&
    typeof record.branch === 'string' &&
    typeof record.openedAt === 'string' &&
    typeof record.sourceFile === 'string' &&
    // D20: a record without the pushed head cannot be reconciled against it.
    typeof record.headSha === 'string' &&
    gitSha(record.headSha).ok
  );
}

/**
 * `20-contract.md` § Files on the volume: "Pending pull-request list, one per
 * declaration". Kept as its own file per declaration under a directory
 * `declaration.remove`'s watcher-directory-emptiness check (`declarations.ts`)
 * never inspects — the list is service bookkeeping, not a copy of anything a
 * producer handed over, so an empty list must never block removal the way a
 * leftover watched file does.
 */
export function pendingPullRequestsPath(volumeRoot: string, declarationId: DeclarationId): string {
  return path.join(volumeRoot, 'watcher-pending-pull-requests', `${declarationId as string}.json`);
}

/** What the operator is told about an entry that failed validation: whatever of the number and branch could still be read. */
export interface DiscardedPendingEntry {
  readonly pullRequestNumber: number | null;
  readonly branch: BranchName | null;
}

export interface PendingPullRequestRead {
  readonly entries: readonly PendingPullRequest[];
  readonly discarded: readonly DiscardedPendingEntry[];
}

function describeDiscarded(value: unknown): DiscardedPendingEntry {
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    pullRequestNumber: typeof record.number === 'number' && Number.isFinite(record.number) ? record.number : null,
    branch: typeof record.branch === 'string' ? (record.branch as BranchName) : null,
  };
}

/**
 * `20-contract.md` D20: an entry that fails validation is returned in
 * `discarded` so the watcher can page it once, rather than dropped silently.
 * A missing or unparseable list is still empty and never thrown.
 */
export function readPendingPullRequestsWithDiscards(volumeRoot: string, declarationId: DeclarationId): PendingPullRequestRead {
  const full = pendingPullRequestsPath(volumeRoot, declarationId);
  if (!existsSync(full)) return { entries: [], discarded: [] };
  try {
    const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<PendingPullRequestList> | null;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [], discarded: [] };
    const entries: PendingPullRequest[] = [];
    const discarded: DiscardedPendingEntry[] = [];
    for (const candidate of parsed.entries as unknown[]) {
      if (isWellFormedEntry(candidate)) entries.push(candidate);
      else discarded.push(describeDiscarded(candidate));
    }
    return { entries, discarded };
  } catch {
    return { entries: [], discarded: [] };
  }
}

/** `20-contract.md` § Files on the volume: "A missing or unparseable pending pull-request list is treated as empty and never thrown — a bad read must not crash a tick." */
export function readPendingPullRequests(volumeRoot: string, declarationId: DeclarationId): PendingPullRequestList {
  const { entries } = readPendingPullRequestsWithDiscards(volumeRoot, declarationId);
  return entries.length === 0 ? EMPTY_LIST : { entries };
}

/** `20-contract.md` § Files on the volume: "written temp-then-rename". */
export function writePendingPullRequests(volumeRoot: string, declarationId: DeclarationId, list: PendingPullRequestList): void {
  const full = pendingPullRequestsPath(volumeRoot, declarationId);
  // `20-contract.md` § L2 — watcher, D18: this directory is the genuinely
  // separate protected runtime state root (on the named volume, never the
  // untrusted per-declaration bind mount), so it gets restrictive permissions.
  mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  const tmpPath = `${full}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(list), 'utf8');
  renameSync(tmpPath, full);
}
