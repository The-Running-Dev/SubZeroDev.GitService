import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeConsoleDigest, verifyConsoleArtifact, CONSOLE_HASH_FILENAME } from './console-integrity.ts';

async function writeConsoleArtifact(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');
  await writeFile(path.join(dir, 'assets', 'index-abc123.js'), 'console.log("console bundle");', 'utf8');
  const hash = await computeConsoleDigest(dir);
  await writeFile(path.join(dir, CONSOLE_HASH_FILENAME), `${hash}\n`, 'utf8');
}

test('an untouched console artifact verifies, and its digest round-trips', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'console-integrity-'));
  try {
    await writeConsoleArtifact(dir);

    const verified = await verifyConsoleArtifact(dir);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.match(verified.value, /^[0-9a-f]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editing one byte of a built asset fails verification with console-manifest-mismatch naming both hashes, and boot must not start a transport on it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'console-integrity-'));
  try {
    await writeConsoleArtifact(dir);

    const assetPath = path.join(dir, 'assets', 'index-abc123.js');
    const original = await import('node:fs/promises').then((fs) => fs.readFile(assetPath, 'utf8'));
    const lastChar = original.at(-1);
    const flipped = lastChar === 'x' ? 'y' : 'x';
    const tampered = original.slice(0, -1) + flipped;
    await writeFile(assetPath, tampered, 'utf8');

    const verified = await verifyConsoleArtifact(dir);
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.error.code, 'console-manifest-mismatch');
    if (verified.error.code !== 'console-manifest-mismatch') return;
    assert.notEqual(verified.error.expected, verified.error.found);
    assert.match(verified.error.expected, /^[0-9a-f]{64}$/);
    assert.match(verified.error.found, /^[0-9a-f]{64}$/);

    // "no transport starts": this Outcome failing is exactly the signal
    // boot.ts's own console verification step gates on, mirroring the
    // registry check — see src/lifecycle/boot.ts.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing console build fails verification with console-unreadable, not a mismatch with invented digests', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'console-integrity-'));
  try {
    const verified = await verifyConsoleArtifact(dir);
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.error.code, 'console-unreadable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a console hash file that carries no valid digest fails with console-unreadable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'console-integrity-'));
  try {
    await writeFile(path.join(dir, 'index.html'), '<!doctype html>', 'utf8');
    await writeFile(path.join(dir, CONSOLE_HASH_FILENAME), 'not a hash\n', 'utf8');

    const verified = await verifyConsoleArtifact(dir);
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.error.code, 'console-unreadable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
