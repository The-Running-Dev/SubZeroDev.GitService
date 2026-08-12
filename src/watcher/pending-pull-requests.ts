import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DeclarationId } from '../shared/brands.ts';
import type { PendingPullRequestList } from './types.ts';

const EMPTY_LIST: PendingPullRequestList = { entries: [] };

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

/** `20-contract.md` § Files on the volume: "A missing or unparseable pending pull-request list is treated as empty and never thrown — a bad read must not crash a tick." */
export function readPendingPullRequests(volumeRoot: string, declarationId: DeclarationId): PendingPullRequestList {
  const full = pendingPullRequestsPath(volumeRoot, declarationId);
  if (!existsSync(full)) return EMPTY_LIST;
  try {
    const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<PendingPullRequestList> | null;
    if (!parsed || !Array.isArray(parsed.entries)) return EMPTY_LIST;
    return { entries: parsed.entries };
  } catch {
    return EMPTY_LIST;
  }
}

/** `20-contract.md` § Files on the volume: "written temp-then-rename". */
export function writePendingPullRequests(volumeRoot: string, declarationId: DeclarationId, list: PendingPullRequestList): void {
  const full = pendingPullRequestsPath(volumeRoot, declarationId);
  mkdirSync(path.dirname(full), { recursive: true });
  const tmpPath = `${full}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(list), 'utf8');
  renameSync(tmpPath, full);
}
