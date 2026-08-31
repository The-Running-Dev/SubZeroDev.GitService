import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { systemClock } from '../src/clock/clock.ts';
import { createAudit } from '../src/audit/audit.ts';
import { createStructuredStore } from '../src/store/structured-store.ts';
import { withVolumeAsync } from '../src/store/volume-fixture.ts';
import { createOperatorIdentity, TOTP_SEALING_KEY_FILENAME, writeProvisioningSecret, type OperatorIdentity } from '../src/operator-identity/operator-identity.ts';
import { base32Decode, currentTotpCode } from '../src/operator-identity/totp.ts';
import { createAuthorization } from '../src/authorization/authorization.ts';
import { createDeclarations, type Declarations } from '../src/declarations/declarations.ts';
import { createDispatchPipeline } from '../src/dispatch/dispatch-pipeline.ts';
import { createModuleAdapter } from '../src/module-adapter/module-adapter.ts';
import { fixtureTool, httpTarget } from '../src/contract/fixtures.ts';
import { success } from '../src/result/envelope.ts';
import { createStubCloneStore } from '../src/clone/testing/stub-clone-store.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from '../src/surfaces/http-server.ts';
import { createMcpRoutesState } from '../src/surfaces/mcp-routes.ts';
import { pkce, registerClient, exchangeCodeForTokens } from '../src/surfaces/testing/oauth-test-flow.ts';
import type { GitSha, RemoteHost, Sha256Hex } from '../src/shared/brands.ts';
import type { ContractCapabilitySet, DeploymentCeiling } from '../src/contract/capabilities.ts';
import type { HttpAdapter } from '../src/http/http-adapter.ts';
import { verifyDeployment } from './verify-deployment.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../src/composition-root/production-declarations.ts';
import type { JsonValue } from '../src/contract/json.ts';

/**
 * `scrubJson` is a required `DispatchPipelineDependencies` member (post-S36
 * reconciliation). These routes never carry a resolved secret, so an identity
 * scrub is correct here — stated, rather than inherited from an optional
 * dependency's silent fallback.
 */
const NO_SECRETS_TO_SCRUB = { scrubJson: (value: JsonValue): JsonValue => value };

/**
 * S22.2: each of the five classifications `verifyDeployment` can return is
 * produced here at least once, against a real running instance of the
 * service deliberately misconfigured to fail that specific way — over real
 * sockets, the same rigor `mcp-routes.test.ts` already holds this surface
 * to, never a mocked `fetch`.
 */

const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const PROVISIONING_SECRET = 'bootstrap-secret-value';
const SUBJECT = 'operator';
const PASSWORD = 'correct horse battery staple';
const GITHUB_ALLOWLIST = ['github.com'] as unknown as readonly RemoteHost[];
const CEILING = new Set(['repo.read', 'git.raw']) as unknown as ContractCapabilitySet;

const READ_TOOL = fixtureTool({ name: 'repo_status', capabilities: ['repo.read'], scopes: ['read'], executionClass: 'read', target: httpTarget('t.read') });

const STUB_HTTP_ADAPTER: Pick<HttpAdapter, 'invoke'> = {
  async invoke() {
    return success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 });
  },
};

interface ServerHandle {
  readonly baseUrl: string;
  readonly declarations: Declarations;
}

async function buildIdentity(volume: string): Promise<OperatorIdentity> {
  const credentialMount = `${volume}/_credential-mount`;
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { randomBytes } = await import('node:crypto');
  mkdirSync(credentialMount, { recursive: true });
  writeFileSync(`${credentialMount}/${TOTP_SEALING_KEY_FILENAME}`, randomBytes(32));

  const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();

  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  return createOperatorIdentity({ volumeRoot: volume, credentialMountRoot: credentialMount, clock: systemClock, audit });
}

async function withServer<T>(volume: string, commitSha: GitSha, fn: (handle: ServerHandle) => Promise<T>): Promise<T> {
  const identity = await buildIdentity(volume);
  writeProvisioningSecret(volume, PROVISIONING_SECRET);

  const declarations = createDeclarations({
    volumeRoot: volume,
    clock: systemClock,
    remoteHostAllowlist: GITHUB_ALLOWLIST,
    ceiling: CEILING as unknown as DeploymentCeiling,
    cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
  });
  const authorization = createAuthorization({
    volumeRoot: volume,
    clock: systemClock,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as unknown as DeploymentCeiling,
    declarations,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
  });
  const dispatchPipeline = createDispatchPipeline({
    exec: NO_SECRETS_TO_SCRUB,
    registry: { fingerprint: 'a'.repeat(64) as never, compiledAt: systemClock.now(), entries: [READ_TOOL], contractCapabilitySet: CEILING as unknown as never },
    ceiling: CEILING as unknown as DeploymentCeiling,
    moduleAdapter: createModuleAdapter(),
    httpAdapter: STUB_HTTP_ADAPTER,
    declarations,
    cloneStore: createStubCloneStore(),
    locks: { pinActiveOperation: () => ({ release() {} }), acquireMutation: async () => ({ ok: true, value: { release() {} } }) } as never,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
    clock: systemClock,
  });

  const server = createSurfacesServer({
    commitSha,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: async () => (await identity.provisioningState()) === 'pending',
    auditChain: async () => ({ verifiedThrough: null, headHash: null, mirroredHeadHash: null, retainedAnchors: [], chainBreak: null }),
    authorization,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
    identity,
    sessionAbsoluteSeconds: 43_200,
    declarations,
    cloneStore: createStubCloneStore(),
    dispatchPipeline,
    contractCapabilitySet: CEILING,
    origin: 'http://localhost',
    mcpState: createMcpRoutesState(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${address.port}`, declarations });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function declareRepo(declarations: Declarations, id: string, capabilityGrant: readonly string[]): Promise<void> {
  const declared = await declarations.declare(
    {
      id: id as never,
      cloneUrl: `https://github.com/acme/${id}.git` as never,
      host: 'generic',
      credentialRef: 'unused' as never,
      capabilityGrant: capabilityGrant as never,
      writablePathPrefixes: [],
      pinned: false,
      fileWatcher: null,
      identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
    },
    { kind: 'operator', subject: 'ben' as never, clientId: null, grantId: null },
  );
  assert.equal(declared.ok, true, declared.ok ? '' : declared.error.summary);
}

function cookieValue(setCookieHeaders: string[], name: string): string | null {
  for (const header of setCookieHeaders) {
    if (header.startsWith(`${name}=`)) return header.split(';')[0]!.slice(name.length + 1);
  }
  return null;
}

async function operatorCookie(baseUrl: string): Promise<string> {
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
  const setCookies = loginResponse.headers.getSetCookie();
  const session = cookieValue(setCookies, 'szg_session');
  const csrf = cookieValue(setCookies, 'szg_csrf');
  return `szg_session=${session}; szg_csrf=${csrf}`;
}

const CLIENT_REDIRECT_URI = 'https://client.invalid/callback';

async function fullOAuthFlow(baseUrl: string, declarationId: string, scopes: readonly string[]): Promise<{ accessToken: string }> {
  const client = await registerClient(baseUrl);
  const { verifier, challenge } = pkce();
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', CLIENT_REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', `/mcp/${declarationId}`);
  authorizeUrl.searchParams.set('scope', scopes.join(' '));

  const cookie = await operatorCookie(baseUrl);
  const csrfToken = /szg_csrf=([^;]+)/.exec(cookie)?.[1];
  const getResponse = await fetch(authorizeUrl, { headers: { Cookie: cookie } });
  const html = await getResponse.text();
  assert.equal(getResponse.status, 200, html);
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(requestId, 'the approval form must carry a request_id');

  const approveResponse = await fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken!, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId!, action: 'approve' }),
  });
  assert.equal(approveResponse.status, 302);
  const location = new URL(approveResponse.headers.get('Location')!);
  const code = location.searchParams.get('code');
  assert.ok(code);

  const { status, body } = await exchangeCodeForTokens(baseUrl, client.client_id, code!, verifier);
  assert.equal(status, 200, body);
  const tokens = JSON.parse(body) as { access_token: string };
  return { accessToken: tokens.access_token };
}

test('S22.1 — the companion check is not a registry tool: no production tool declaration names it', () => {
  const targets = PRODUCTION_TOOL_DECLARATIONS.map((d) => JSON.stringify(d.target));
  const names = PRODUCTION_TOOL_DECLARATIONS.map((d) => d.name);
  for (const target of targets) assert.doesNotMatch(target, /verify-?deployment/i);
  for (const name of names) assert.doesNotMatch(name, /verify-?deployment/i);
});

const COMMIT_A = '0'.repeat(40) as GitSha;
const COMMIT_B = '1'.repeat(40) as GitSha;

test('S22.2 verified — a real session against a matching commit sees the expected catalogue and calls it successfully', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, COMMIT_A, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-verified', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-verified', ['read']);

      const result = await verifyDeployment({
        baseUrl,
        declarationId: 'repo-verified',
        expectedCommitSha: COMMIT_A,
        bearerToken: accessToken,
      });
      assert.deepEqual(result, { kind: 'verified', commitSha: COMMIT_A });
    });
  });
});

test('S22.2 stale-runtime — /healthz stabilises on a commit that is not the one expected', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, COMMIT_A, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-stale', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-stale', ['read']);

      const result = await verifyDeployment({
        baseUrl,
        declarationId: 'repo-stale',
        expectedCommitSha: COMMIT_B,
        bearerToken: accessToken,
        pollIntervalMs: 5,
        stableReadCount: 2,
      });
      assert.deepEqual(result, { kind: 'stale-runtime', expectedCommit: COMMIT_B, observedCommit: COMMIT_A });
    });
  });
});

test('S22.2 verification-credential — initialize is rejected for a garbage bearer token', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, COMMIT_A, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-cred', ['repo.read']);

      const result = await verifyDeployment({
        baseUrl,
        declarationId: 'repo-cred',
        expectedCommitSha: COMMIT_A,
        bearerToken: 'not-a-real-token',
        pollIntervalMs: 5,
        stableReadCount: 2,
      });
      assert.equal(result.kind, 'verification-credential');
    });
  });
});

test('S22.2 unexpected-profile-or-catalog — the declaration lacks the capability the expected tool needs, so it is absent from tools/list', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, COMMIT_A, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-catalog', []); // no repo.read
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-catalog', ['read']);

      const result = await verifyDeployment({
        baseUrl,
        declarationId: 'repo-catalog',
        expectedCommitSha: COMMIT_A,
        bearerToken: accessToken,
        pollIntervalMs: 5,
        stableReadCount: 2,
      });
      assert.equal(result.kind, 'unexpected-profile-or-catalog');
      if (result.kind === 'unexpected-profile-or-catalog') {
        assert.match(result.detail, /repo_status/);
      }
    });
  });
});

test('S22.2 mixed-runtime — a real server answering /healthz with an alternating commit SHA never stabilises', async () => {
  let callCount = 0;
  const flaky = createHttpServer((req, res) => {
    if (req.url === '/healthz') {
      callCount += 1;
      const commitSha = callCount % 2 === 0 ? COMMIT_A : COMMIT_B;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true, commitSha }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve));
  const address = flaky.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await verifyDeployment({
      baseUrl,
      declarationId: 'irrelevant',
      expectedCommitSha: COMMIT_A,
      bearerToken: 'irrelevant',
      pollIntervalMs: 5,
      pollTimeoutMs: 100,
      stableReadCount: 3,
    });
    assert.equal(result.kind, 'mixed-runtime');
    if (result.kind === 'mixed-runtime') {
      assert.deepEqual(new Set(result.observedCommits), new Set([COMMIT_A, COMMIT_B]));
    }
  } finally {
    await new Promise<void>((resolve) => flaky.close(() => resolve()));
  }
});
