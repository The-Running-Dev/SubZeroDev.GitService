import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from '../clock/clock.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { ClonePath, DeclarationId, GitSha, HttpsUrl, OperationId } from '../shared/brands.ts';
import { createHttpAdapter, VERIFY_PUBLISHED_URL_OPERATION } from './http-adapter.ts';

function context(signal = new AbortController().signal): CallContext {
  return {
    operationId: 'op-1' as OperationId,
    declarationId: 'repo-a' as DeclarationId,
    generation: 1 as never,
    cloneRoot: '/clones/repo-a' as ClonePath,
    actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
    capabilities: new Set() as never,
    writablePathPrefixes: [],
    context: 'normal',
    scheduledJobId: null,
    deadline: systemClock.now(),
    signal,
  };
}

const LIMITS = { timeoutSeconds: 5, maxResultBytes: 4096 };
const URL = 'https://example.test/' as HttpsUrl;
const EXPECTED = 'a'.repeat(40) as GitSha;

function fakeFetch(impl: (url: string) => Promise<Response> | Response): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => impl(String(input))) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('S12.6 — a 200 serving the expected commit succeeds, and the data carries no url without a confirmed deploy', async () => {
  const adapter = createHttpAdapter({ clock: systemClock, fetchImpl: fakeFetch(() => jsonResponse(200, { ready: true, commitSha: EXPECTED })) });
  const result = await adapter.invoke(VERIFY_PUBLISHED_URL_OPERATION, context(), { url: URL, expectedCommitSha: EXPECTED }, LIMITS);
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.kind, 'success');
  assert.deepEqual(result.data, { url: URL, commitSha: EXPECTED });
});

test('S12.6 — a 200 serving a different commit is precondition, naming both shas', async () => {
  const servedSha = 'b'.repeat(40);
  const adapter = createHttpAdapter({ clock: systemClock, fetchImpl: fakeFetch(() => jsonResponse(200, { ready: true, commitSha: servedSha })) });
  const result = await adapter.invoke(VERIFY_PUBLISHED_URL_OPERATION, context(), { url: URL, expectedCommitSha: EXPECTED }, LIMITS);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'precondition');
  assert.equal(result.data, undefined, 'no url in a success position without a confirmed deploy');
  const findings = result.findings ?? [];
  assert.ok(findings.some((f) => f.message === EXPECTED));
  assert.ok(findings.some((f) => f.message === servedSha));
});

test('S12.6 — a non-2xx status is upstream', async () => {
  const adapter = createHttpAdapter({ clock: systemClock, fetchImpl: fakeFetch(() => new Response('nope', { status: 503 })) });
  const result = await adapter.invoke(VERIFY_PUBLISHED_URL_OPERATION, context(), { url: URL, expectedCommitSha: EXPECTED }, LIMITS);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'upstream');
});

test('S12.6 — unreachable (a rejected fetch) is upstream', async () => {
  const adapter = createHttpAdapter({
    clock: systemClock,
    fetchImpl: fakeFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND example.test');
    }),
  });
  const result = await adapter.invoke(VERIFY_PUBLISHED_URL_OPERATION, context(), { url: URL, expectedCommitSha: EXPECTED }, LIMITS);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'upstream');
});

test('S12.6 — exceeding the declared timeout is a timeout envelope at the cap', async () => {
  const adapter = createHttpAdapter({
    clock: systemClock,
    fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof fetch,
  });
  const result = await adapter.invoke(VERIFY_PUBLISHED_URL_OPERATION, context(), { url: URL, expectedCommitSha: EXPECTED }, { timeoutSeconds: 1, maxResultBytes: 4096 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'timeout');
});

test('an unrecognised operation name is infrastructure, not a silent no-op', async () => {
  const adapter = createHttpAdapter({ clock: systemClock });
  const result = await adapter.invoke('not-a-real-operation' as never, context(), { url: URL, expectedCommitSha: EXPECTED }, LIMITS);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'infrastructure');
});

test('declaredOperations reports exactly the one operation this adapter serves', () => {
  const adapter = createHttpAdapter({ clock: systemClock });
  assert.deepEqual([...adapter.declaredOperations()], [VERIFY_PUBLISHED_URL_OPERATION]);
});

test('S12.7 — the http adapter carries no credential dependency, asserted by its own import graph', () => {
  const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'http-adapter.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const imports = [...source.matchAll(/^import\s+(?:type\s+)?.*?from\s+'([^']+)';/gm)].map((m) => m[1]!);
  const credentialShaped = imports.filter((spec) => /exec\/|credentials\//.test(spec));
  assert.deepEqual(credentialShaped, [], `http-adapter.ts imports from a credential-shaped module: ${credentialShaped.join(', ')}`);
});
