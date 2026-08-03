import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './http-server.ts';
import type { GitSha, Sha256Hex } from '../shared/brands.ts';

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const TOKEN = 'test-operator-token';

async function withServer<T>(ready: boolean, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => ready,
    operatorApiToken: TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('/healthz returns 200 with exactly ready and commitSha, and no other key', async () => {
  await withServer(true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['commitSha', 'ready']);
    assert.equal(body.ready, true);
    assert.equal(body.commitSha, COMMIT_SHA);
  });
});

test('/healthz requires no credential', async () => {
  await withServer(false, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ready: boolean };
    assert.equal(body.ready, false);
  });
});

test('/version answers 401 without a credential', async () => {
  await withServer(true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/version`);
    assert.equal(response.status, 401);
  });
});

test('/version answers 401 with the wrong credential', async () => {
  await withServer(true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/version`, { headers: { Authorization: 'Bearer not-the-token' } });
    assert.equal(response.status, 401);
  });
});

test('/version returns the contract fingerprint with a valid credential', async () => {
  await withServer(true, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/version`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { contractFingerprint: string };
    assert.equal(body.contractFingerprint, CONTRACT_FINGERPRINT);
  });
});
