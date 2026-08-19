import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { systemClock } from '../clock/clock.ts';
import { createAudit } from '../audit/audit.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createOperatorIdentity, TOTP_SEALING_KEY_FILENAME, writeProvisioningSecret, type OperatorIdentity } from '../operator-identity/operator-identity.ts';
import { base32Decode, currentTotpCode } from '../operator-identity/totp.ts';
import { createAuthorization } from '../authorization/authorization.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './http-server.ts';
import { createMcpRoutesState } from './mcp-routes.ts';
import type { GitSha, Sha256Hex } from '../shared/brands.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import { createStubCloneStore } from '../clone/testing/stub-clone-store.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import { createStubDispatchPipeline } from '../dispatch/testing/stub-dispatch-pipeline.ts';
import { ok } from '../shared/outcome.ts';
import type { ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const PROVISIONING_SECRET = 'bootstrap-secret-value';
const SUBJECT = 'operator';
const PASSWORD = 'correct horse battery staple';
const CEILING = new Set(['repo.read']) as unknown as ContractCapabilitySet;

const FIXTURE_DECLARATION = {
  id: 'watch-1',
  generation: 1,
  cloneUrl: 'https://example.invalid/watch-1.git',
  host: 'github',
  credentialRef: 'unused',
  capabilityGrant: [],
  writablePathPrefixes: [],
  pinned: false,
  fileWatcher: null,
  identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
  state: 'active',
  grantEpoch: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as Declaration;

function declarationsWithOneRow(): Declarations {
  return {
    async get(id) {
      return id === FIXTURE_DECLARATION.id ? FIXTURE_DECLARATION : null;
    },
    async getGeneration(id, generation) {
      return id === FIXTURE_DECLARATION.id && generation === FIXTURE_DECLARATION.generation ? FIXTURE_DECLARATION : null;
    },
    async list() {
      return [FIXTURE_DECLARATION];
    },
    async declare() {
      throw new Error('stub: declare not exercised');
    },
    async amend() {
      throw new Error('stub: amend not exercised');
    },
    async orphan() {
      throw new Error('stub: orphan not exercised');
    },
    async remove() {
      throw new Error('stub: remove not exercised');
    },
    effectiveGrant() {
      return new Set() as unknown as ReturnType<Declarations['effectiveGrant']>;
    },
    effectiveWritablePrefixes(declaration) {
      return declaration.writablePathPrefixes;
    },
    bumpGrantEpoch() {
      return ok(0) as unknown as ReturnType<Declarations['bumpGrantEpoch']>;
    },
    remoteHostAllowlist() {
      return [];
    },
    async revalidateFileWatchers() {
      return ok(undefined);
    },
  };
}

/** `describe` reports a `ready`, dirty clone; `observeGitState` reports a live branch. */
function readyDirtyCloneStore(): CloneStore {
  const stub = createStubCloneStore();
  return {
    ...stub,
    async describe(declarationId) {
      return ok({
        declarationId,
        generation: 1 as never,
        state: 'dirty',
        path: '/tmp/fixture' as never,
        sizeBytes: 0,
        lastOperationAt: '2026-01-01T00:00:00.000Z' as never,
        observedRemote: null,
        attentionReason: null,
      });
    },
    async observeGitState(declarationId) {
      return ok({
        branch: 'feature/landing-view' as never,
        headSha: 'a'.repeat(40) as never,
        upstreamSha: 'a'.repeat(40) as never,
        indexDigest: '0'.repeat(64) as never,
        worktreeDigest: '1'.repeat(64) as never,
        observedAt: '2026-01-01T00:00:00.000Z' as never,
        declarationId,
      } as never);
    },
  };
}

async function buildIdentity(volume: string): Promise<OperatorIdentity> {
  const credentialMount = path.join(volume, '_credential-mount');
  mkdirSync(credentialMount, { recursive: true });
  writeFileSync(path.join(credentialMount, TOTP_SEALING_KEY_FILENAME), randomBytes(32));

  const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();

  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  return createOperatorIdentity({ volumeRoot: volume, credentialMountRoot: credentialMount, clock: systemClock, audit });
}

async function withServer<T>(volume: string, cloneStore: CloneStore, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const identity = await buildIdentity(volume);
  writeProvisioningSecret(volume, PROVISIONING_SECRET);
  const authorization = createAuthorization({
    volumeRoot: volume,
    clock: systemClock,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as unknown as DeploymentCeiling,
    declarations: declarationsWithOneRow(),
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
  });
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: async () => (await identity.provisioningState()) === 'pending',
    auditChain: async () => ({ verifiedThrough: null, headHash: null, mirroredHeadHash: null, retainedAnchors: [], chainBreak: null }),
    authorization,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
    identity,
    sessionAbsoluteSeconds: 43_200,
    declarations: declarationsWithOneRow(),
    cloneStore,
    dispatchPipeline: createStubDispatchPipeline(),
    contractCapabilitySet: CEILING,
    origin: 'http://localhost',
    mcpState: createMcpRoutesState(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function cookieValue(setCookieHeaders: string[], name: string): string | null {
  for (const header of setCookieHeaders) {
    if (header.startsWith(`${name}=`)) return header.split(';')[0]!.slice(name.length + 1);
  }
  return null;
}

async function enrolAndLogin(baseUrl: string): Promise<string> {
  const enrolResponse = await fetch(`${baseUrl}/auth/enrol`, {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: JSON.stringify({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
  });
  assert.equal(enrolResponse.status, 200);
  const enrolBody = (await enrolResponse.json()) as { totpSecret: string };
  const code = currentTotpCode(base32Decode(enrolBody.totpSecret), Date.parse(systemClock.now()) / 1000);

  const loginResponse = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: JSON.stringify({ subject: SUBJECT, password: PASSWORD, totpCode: code }),
  });
  assert.equal(loginResponse.status, 200);
  const setCookies = loginResponse.headers.getSetCookie ? loginResponse.headers.getSetCookie() : [];
  const sessionCookie = cookieValue(setCookies, 'szg_session');
  const csrfCookie = cookieValue(setCookies, 'szg_csrf');
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);
  return `szg_session=${sessionCookie}; szg_csrf=${csrfCookie}`;
}

test('S18.2 — GET /declarations reports clone state, current branch, dirty flag and last operation', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, readyDirtyCloneStore(), async (baseUrl) => {
      const cookie = await enrolAndLogin(baseUrl);
      const res = await fetch(`${baseUrl}/declarations`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const rows = (await res.json()) as readonly { readonly declaration: { readonly id: string }; readonly clone: { readonly state: string; readonly lastOperationAt: string | null } | null; readonly branch: string | null; readonly dirty: boolean }[];
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.declaration.id, 'watch-1');
      assert.equal(row.clone?.state, 'dirty');
      assert.equal(row.clone?.lastOperationAt, '2026-01-01T00:00:00.000Z');
      assert.equal(row.branch, 'feature/landing-view');
      assert.equal(row.dirty, true);
    });
  });
});

test("S18.2 — a declaration that has never been cloned is listed with its state rather than omitted, and carries no live branch", async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, createStubCloneStore(), async (baseUrl) => {
      const cookie = await enrolAndLogin(baseUrl);
      const res = await fetch(`${baseUrl}/declarations`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const rows = (await res.json()) as readonly { readonly declaration: { readonly id: string }; readonly clone: { readonly state: string } | null; readonly branch: string | null; readonly dirty: boolean }[];
      assert.equal(rows.length, 1, 'listed, not omitted');
      assert.equal(rows[0]!.clone?.state, 'absent');
      assert.equal(rows[0]!.branch, null);
      assert.equal(rows[0]!.dirty, false);
    });
  });
});
