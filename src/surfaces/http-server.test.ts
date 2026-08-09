import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ObservedGitState } from '../clone/types.ts';
import type { OperationJournalEntry } from '../journal/types.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './http-server.ts';
import type { GitSha, Sha256Hex } from '../shared/brands.ts';
import type { AuditChainState } from '../audit/types.ts';
import { createStubOperatorIdentity } from '../operator-identity/testing/stub-operator-identity.ts';
import { createStubDeclarations } from '../declarations/testing/stub-declarations.ts';
import { createStubCloneStore } from '../clone/testing/stub-clone-store.ts';
import { createStubDispatchPipeline } from '../dispatch/testing/stub-dispatch-pipeline.ts';
import { createStubAuthorization, createStoreFailingAuthorization } from '../authorization/testing/stub-authorization.ts';
import type { Authorization } from '../authorization/authorization.ts';
import type { ContractCapabilitySet } from '../contract/capabilities.ts';

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const TOKEN = 'test-operator-token';
const AUTHORIZATION = createStubAuthorization(new Map([[TOKEN, 'operator-api' as never]]));

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
  readonly parked?: readonly OperationJournalEntry[];
  readonly observed?: ObservedGitState | null;
  readonly resolve?: (operationId: string) => Promise<{ readonly ok: boolean; readonly summary: string }>;
  readonly failedOutboxRows?: number;
  readonly authorization?: Authorization;
}

async function withServer<T>(options: ServerOptions, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => options.ready ?? true,
    provisioningPending: async () => options.provisioningPending ?? false,
    auditChain: async () => options.auditChain ?? HEALTHY_CHAIN,
    authorization: options.authorization ?? AUTHORIZATION,
    parkedOperations: async () => options.parked ?? [],
    observeGitState: async () => options.observed ?? null,
    ...(options.resolve ? { resolveParkedOperation: async (operationId: string) => options.resolve!(operationId) } : {}),
    ...(options.failedOutboxRows !== undefined ? { failedOutboxRows: async () => options.failedOutboxRows! } : {}),
    identity: createStubOperatorIdentity(),
    sessionAbsoluteSeconds: 43_200,
    declarations: createStubDeclarations(),
    cloneStore: createStubCloneStore(),
    dispatchPipeline: createStubDispatchPipeline(),
    contractCapabilitySet: new Set() as unknown as ContractCapabilitySet,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a store that cannot answer is a 503 on every bearer route, not a 401 — the token is not the thing that is wrong', async () => {
  const failing = createStoreFailingAuthorization();
  await withServer({ authorization: failing }, async (baseUrl) => {
    for (const path of ['/version', '/health', '/parked-operations']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(response.status, 503, `${path} must report the store failure, not deny the credential`);
      assert.equal(((await response.json()) as { error: string }).error, 'store-failed');
    }
  });

  // The distinction only means something if a genuinely bad credential still
  // answers 401 against the same server.
  await withServer({ authorization: failing }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 401, 'no credential at all is still an auth failure, not a store failure');
  });
});

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
    provisioningPending: async () => false,
    auditChain: async () => {
      throw new Error('file is not a database');
    },
    authorization: AUTHORIZATION,
    identity: createStubOperatorIdentity(),
    sessionAbsoluteSeconds: 43_200,
    declarations: createStubDeclarations(),
    cloneStore: createStubCloneStore(),
    dispatchPipeline: createStubDispatchPipeline(),
    contractCapabilitySet: new Set() as unknown as ContractCapabilitySet,
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

test('S11 — /health reports a real failed-outbox-row count when a notifier is wired', async () => {
  await withServer({ failedOutboxRows: 2 }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await response.json()) as { failedOutboxRows: number };
    assert.equal(body.failedOutboxRows, 2);
  });
});

const PARKED_ENTRY = {
  operationId: 'op-parked' as never,
  declarationId: 'repo-a' as never,
  generation: 1 as never,
  tool: 'git_commit' as never,
  input: {},
  actorRef: { kind: 'operator' as const, subject: 'operator' as never, clientId: null, grantId: null },
  scheduledJobId: null,
  context: 'normal' as const,
  preState: { branch: null, headSha: null, upstreamSha: null, indexDigest: 'b'.repeat(64) as never, worktreeDigest: 'c'.repeat(64) as never },
  steps: [],
  state: 'attention' as const,
  attentionReason: 'post-state does not match and no resume step is registered',
  startedAt: '2026-08-08T00:00:00.000Z' as never,
  updatedAt: '2026-08-08T00:00:01.000Z' as never,
};

test('S8.9 — /parked-operations answers 401 without a credential', async () => {
  await withServer({ parked: [PARKED_ENTRY] }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/parked-operations`);
    assert.equal(response.status, 401);
  });
});

test('S8.9 — /parked-operations names the repository, the tool and the reason, so the exit does not need host access', async () => {
  await withServer({ parked: [PARKED_ENTRY] }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/parked-operations`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { operations: readonly Record<string, unknown>[] };
    assert.equal(body.operations.length, 1);
    assert.equal(body.operations[0]!.declarationId, 'repo-a');
    assert.equal(body.operations[0]!.tool, 'git_commit');
    assert.equal(body.operations[0]!.reason, 'post-state does not match and no resume step is registered');
    // The entry's input is deliberately absent: it is scrubbed before it is
    // journalled, but this view has no reason to carry it at all.
    assert.equal('input' in body.operations[0]!, false);
  });
});

test('S8 — /health counts parked operations for real, rather than reporting a constant zero', async () => {
  await withServer({ parked: [PARKED_ENTRY, { ...PARKED_ENTRY, operationId: 'op-parked-2' as never }] }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await response.json()) as { parkedOperations: number };
    assert.equal(body.parkedOperations, 2);
  });
});

test('S8.9 — the parked view carries preState, the observed current state and the diff between them', async () => {
  // `10-design.md` § operator-only views, item 6 names all three. Without the
  // diff an operator is comparing two 64-character digests by eye, which is
  // how a repair gets done against the wrong repository.
  const observed = {
    branch: 'main' as never,
    headSha: 'd'.repeat(40) as never,
    upstreamSha: null,
    indexDigest: 'b'.repeat(64) as never,
    worktreeDigest: 'e'.repeat(64) as never,
    observedAt: '2026-08-08T00:00:05.000Z' as never,
  };
  await withServer({ parked: [PARKED_ENTRY], observed }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/parked-operations`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await response.json()) as { operations: readonly Record<string, any>[] };
    const row = body.operations[0]!;

    assert.equal(row.preState.indexDigest, 'b'.repeat(64));
    assert.equal(row.observed.headSha, 'd'.repeat(40));
    // branch, headSha and worktreeDigest all moved against this entry's
    // pre-state; indexDigest did not, so it is absent from the diff. The
    // point of the assertion is that unchanged fields stay out of it — a
    // diff listing all five would be no better than the two raw states.
    assert.deepEqual(
      row.diff.map((d: { field: string }) => d.field).sort(),
      ['branch', 'headSha', 'worktreeDigest'],
    );
    assert.equal(
      row.diff.some((d: { field: string }) => d.field === 'indexDigest'),
      false,
      'an unchanged field must not appear in the diff',
    );
  });
});

test('the parked view renders an unobservable tree rather than failing — the case a parked entry most often sits on', async () => {
  await withServer({ parked: [PARKED_ENTRY], observed: null }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/parked-operations`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { operations: readonly Record<string, unknown>[] };
    assert.equal(body.operations[0]!.observed, null);
    assert.equal(body.operations[0]!.diff, null);
  });
});

test('S8.9 — resolving a parked operation needs a credential, and reports what it did', async () => {
  const resolved: string[] = [];
  await withServer(
    {
      parked: [PARKED_ENTRY],
      resolve: async (operationId) => {
        resolved.push(operationId);
        return { ok: true, summary: `operation ${operationId} settled and 'repo-a' returned to ready` };
      },
    },
    async (baseUrl) => {
      const unauthenticated = await fetch(`${baseUrl}/parked-operations/op-parked/resolve`, { method: 'POST' });
      assert.equal(unauthenticated.status, 401);
      assert.deepEqual(resolved, [], 'an unauthenticated call must not reach the resolution at all');

      const response = await fetch(`${baseUrl}/parked-operations/op-parked/resolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { resolved: boolean; summary: string };
      assert.equal(body.resolved, true);
      assert.match(body.summary, /returned to ready/);
      assert.deepEqual(resolved, ['op-parked']);
    },
  );
});

test('resolving an operation that is not parked answers 409 rather than reporting success', async () => {
  await withServer(
    { parked: [], resolve: async (operationId) => ({ ok: false, summary: `no parked operation '${operationId}'` }) },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/parked-operations/op-missing/resolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { summary: string };
      assert.match(body.summary, /no parked operation/);
    },
  );
});
