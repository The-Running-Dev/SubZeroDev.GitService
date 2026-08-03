import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A throwaway volume root for a test.
 *
 * Removal is best-effort on purpose: Windows refuses to unlink a file while
 * any handle to it is open, and SQLite handles are not always released the
 * instant `close()` returns. A failed cleanup is not a failed assertion — the
 * OS reclaims the temp directory — so swallowing it here keeps the test
 * reporting the property it actually checks instead of a filesystem race.
 */
export function withVolume<T>(body: (volumeRoot: string) => T): T {
  const volumeRoot = mkdtempSync(path.join(tmpdir(), 'szg-test-'));
  try {
    return body(volumeRoot);
  } finally {
    discard(volumeRoot);
  }
}

export async function withVolumeAsync<T>(body: (volumeRoot: string) => Promise<T>): Promise<T> {
  const volumeRoot = mkdtempSync(path.join(tmpdir(), 'szg-test-'));
  try {
    return await body(volumeRoot);
  } finally {
    discard(volumeRoot);
  }
}

function discard(volumeRoot: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(volumeRoot, { recursive: true, force: true });
      return;
    } catch {
      // Retry once or twice, then leave it to the OS.
    }
  }
}
