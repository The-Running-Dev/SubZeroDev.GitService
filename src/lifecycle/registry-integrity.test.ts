import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compiler } from '../contract/compiler.ts';
import { fixtureTool } from '../contract/fixtures.ts';
import { verifyRegistryArtifact } from './registry-integrity.ts';

async function writeArtifact(dir: string, registry: unknown): Promise<void> {
  const json = JSON.stringify(registry, (_key, value) => (value instanceof Set ? [...value].sort() : value), 2);
  await writeFile(path.join(dir, 'registry.json'), json, 'utf8');
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  await writeFile(path.join(dir, 'registry.json.sha256'), `${hash}\n`, 'utf8');
}

test('an untouched artifact verifies, and its fingerprint round-trips', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'registry-integrity-'));
  try {
    const compiled = compiler.compile([fixtureTool({ name: 'git_status' })]);
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    await writeArtifact(dir, compiled.value.registry);

    const verified = await verifyRegistryArtifact(dir);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.value.contractFingerprint, compiled.value.fingerprint);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editing one byte of the emitted registry artifact fails verification with fingerprint-mismatch naming both hashes, and boot must not start a transport on it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'registry-integrity-'));
  try {
    const compiled = compiler.compile([fixtureTool({ name: 'git_status' })]);
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    await writeArtifact(dir, compiled.value.registry);

    const registryPath = path.join(dir, 'registry.json');
    const original = await import('node:fs/promises').then((fs) => fs.readFile(registryPath, 'utf8'));
    const lastChar = original.at(-1);
    const flipped = lastChar === 'x' ? 'y' : 'x';
    const tampered = original.slice(0, -1) + flipped;
    await writeFile(registryPath, tampered, 'utf8');

    const verified = await verifyRegistryArtifact(dir);
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.error.code, 'fingerprint-mismatch');
    if (verified.error.code !== 'fingerprint-mismatch') return;
    assert.notEqual(verified.error.expected, verified.error.found);
    assert.match(verified.error.expected, /^[0-9a-f]{64}$/);
    assert.match(verified.error.found, /^[0-9a-f]{64}$/);

    // "no transport starts": this Outcome failing is exactly the signal the
    // composition root gates the HTTP server's `listen()` call on — see
    // src/server.ts, which never constructs the server on this branch.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing artifact fails verification without throwing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'registry-integrity-'));
  try {
    const verified = await verifyRegistryArtifact(dir);
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.error.code, 'registry-unreadable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
