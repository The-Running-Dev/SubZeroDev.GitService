import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './http-server.ts';
import type { GitSha, Sha256Hex } from '../shared/brands.ts';
import type { AuditChainState } from '../audit/types.ts';

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const TOKEN = 'test-operator-token';

const HEALTHY_CHAIN: AuditChainState = {
  verifiedThrough: 3,
  headHash: '2'.repeat(64) as Sha256Hex,
  mirroredHeadHash: '2'.repeat(64) as Sha256Hex,
  retainedAnchors: [],
  chainBreak: null,
};

interface ServerOptions {
  readonly ready?: boolean;
  readonly provisioningPending?: boolean;
  readonly auditChain?: AuditChainState;
}

async function withServer<T>(options: ServerOptions, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => options.ready ?? true,
    provisioningPending: () => options.provisioningPending ?? false,
    auditChain: async () => options.auditChain ?? HEALTHY_CHAIN,
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
  await withServer({ ready: true }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['commitSha', 'ready']);
    assert.equal(body.ready, true);
    assert.equal(body.commitSha, COMMIT_SHA);
  });
});

test('/healthz requires no credential', async () => {
  await withServer({ ready: false }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ready: boolean };
    assert.equal(body.ready, false);
  });
});

test('/version answers 401 without a credential', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/version`);
    assert.equal(response.status, 401);
  });
});

test('/version answers 401 with the wrong credential', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/version`, { headers: { Authorization: 'Bearer not-the-token' } });
    assert.equal(response.status, 401);
  });
});

test('/version returns the contract fingerprint with a valid credential', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/version`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { contractFingerprint: string };
    assert.equal(body.contractFingerprint, CONTRACT_FINGERPRINT);
  });
});

test('/health answers 401 without a credential', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 401);
  });
});

test('/health returns a healthy audit chain when there is no break', async () => {
  await withServer({ auditChain: HEALTHY_CHAIN }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { auditChain: AuditChainState };
    assert.equal(body.auditChain.chainBreak, null);
    assert.equal(body.auditChain.verifiedThrough, 3);
  });
});

test('S3.4 — the authenticated health report shows an AuditChainBreak', async () => {
  const broken: AuditChainState = {
    verifiedThrough: 2,
    headHash: '2'.repeat(64) as Sha256Hex,
    mirroredHeadHash: '3'.repeat(64) as Sha256Hex,
    retainedAnchors: [],
    chainBreak: { atSequence: 3, expectedHash: '2'.repeat(64) as Sha256Hex, foundHash: '9'.repeat(64) as Sha256Hex },
  };
  await withServer({ ready: true, auditChain: broken }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    // "boot still starts and serves": the surface answers 200 with ready
    // true and the break reported in the body, not a 5xx or a refusal.
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ready: boolean; auditChain: AuditChainState };
    assert.equal(body.ready, true);
    assert.equal(body.auditChain.chainBreak?.atSequence, 3);
    assert.equal(body.auditChain.chainBreak?.expectedHash, '2'.repeat(64));
    assert.equal(body.auditChain.chainBreak?.foundHash, '9'.repeat(64));
  });
});

test('a throwing handler answers 500 and leaves the process serving, rather than crashing it', async () => {
  // `createServer` takes a synchronous callback, so an async handler's
  // rejection has nowhere to go unless the call site catches it. Without that
  // catch this test kills the whole test run via an unhandled rejection —
  // which is also what it would do to the service in production, handing
  // anyone able to make a handler throw a way to stop it.
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: () => false,
    auditChain: async () => {
      throw new Error('file is not a database');
    },
    operatorApiToken: TOKEN,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 500, 'the throw becomes a 500, not a process exit');

    const after = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(after.status, 200, 'and the server is still serving afterwards');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('/health reports the placeholder fields honestly as empty/zero', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await response.json()) as {
      failedOutboxRows: number;
      failingCredentialRefs: unknown[];
      parkedOperations: number;
      volume: { totalBytes: number };
    };
    assert.equal(body.failedOutboxRows, 0);
    assert.deepEqual(body.failingCredentialRefs, []);
    assert.equal(body.parkedOperations, 0);
    assert.equal(body.volume.totalBytes, 0);
  });
});
