import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import { sha256Hex, type Sha256Hex } from '../shared/brands.ts';

/**
 * S18.11's boot check, mirroring `registry-integrity.ts`'s `verifyRegistryArtifact`
 * exactly: a built artifact plus a companion hash file written atomically at
 * build time (`scripts/build-console-manifest.ts`), read and compared here. A
 * byte-for-byte tamper of any built asset changes the recomputed digest and
 * is exactly as detectable this way as a swapped `registry.json`.
 */
export interface ConsoleManifestMismatch {
  readonly code: 'console-manifest-mismatch';
  readonly expected: Sha256Hex;
  readonly found: Sha256Hex;
}

export interface ConsoleUnreadable {
  readonly code: 'console-unreadable';
  readonly reason: string;
}

export type ConsoleIntegrityError = ConsoleManifestMismatch | ConsoleUnreadable;

export const CONSOLE_HASH_FILENAME = 'console.manifest.sha256';

async function listFilesRecursive(dir: string, base: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    // Mirrors `shared/retention.ts`'s `directoryBytes`: a symlink is skipped
    // rather than followed, so a build artifact that happens to contain one
    // can't make this digest silently absorb bytes from outside `dir`.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full, base)));
    } else if (entry.name !== CONSOLE_HASH_FILENAME) {
      files.push(path.relative(base, full));
    }
  }
  return files;
}

/**
 * Every built file's bytes, ordered by POSIX-normalised relative path so the
 * digest does not depend on directory traversal order or the host's path
 * separator — the same algorithm `scripts/build-console-manifest.ts` runs
 * after `vite build` to produce the companion hash file this reads back.
 */
export async function computeConsoleDigest(consoleDir: string): Promise<string> {
  const files = (await listFilesRecursive(consoleDir, consoleDir)).map((f) => f.split(path.sep).join('/')).sort();
  const hash = createHash('sha256');
  for (const relativePath of files) {
    hash.update(relativePath, 'utf8');
    hash.update('\0');
    hash.update(await readFile(path.join(consoleDir, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function verifyConsoleArtifact(consoleDir: string): Promise<Outcome<Sha256Hex, ConsoleIntegrityError>> {
  let expectedHashRaw: string;
  try {
    expectedHashRaw = await readFile(path.join(consoleDir, CONSOLE_HASH_FILENAME), 'utf8');
  } catch (cause) {
    return err({ code: 'console-unreadable', reason: cause instanceof Error ? cause.message : String(cause) });
  }

  const expectedResult = sha256Hex(expectedHashRaw.trim());
  if (!expectedResult.ok) {
    return err({ code: 'console-unreadable', reason: `${CONSOLE_HASH_FILENAME} does not contain a valid SHA-256 hex digest` });
  }
  const expected = expectedResult.value;

  let foundRaw: string;
  try {
    foundRaw = await computeConsoleDigest(consoleDir);
  } catch (cause) {
    return err({ code: 'console-unreadable', reason: cause instanceof Error ? cause.message : String(cause) });
  }
  const foundResult = sha256Hex(foundRaw);
  if (!foundResult.ok) throw new Error('unreachable: sha256 digest is always 64 hex chars');
  const found = foundResult.value;

  if (found !== expected) {
    return err({ code: 'console-manifest-mismatch', expected, found });
  }

  return ok(expected);
}
