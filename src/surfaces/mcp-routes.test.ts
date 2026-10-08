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
import { createDeclarations, type Declarations } from '../declarations/declarations.ts';
import { createDispatchPipeline } from '../dispatch/dispatch-pipeline.ts';
import { createModuleAdapter } from '../module-adapter/module-adapter.ts';
import { fixtureTool, httpTarget } from '../contract/fixtures.ts';
import { isError, success, type ResultKind, type ToolResult } from '../result/envelope.ts';
import { createStubCloneStore } from '../clone/testing/stub-clone-store.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './http-server.ts';
import { closeMcpStreams, createMcpRoutesState, MAX_STREAMS_PER_GRANT, type McpRoutesState } from './mcp-routes.ts';
import { pkce, registerClient, exchangeCodeForTokens } from './testing/oauth-test-flow.ts';
import type { GitSha, RemoteHost, Sha256Hex } from '../shared/brands.ts';
import type { ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';
import type { HttpAdapter } from '../http/http-adapter.ts';
import type { JsonValue } from '../contract/json.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProxyServer } from '../mcp-proxy/proxy.ts';

/**
 * `scrubJson` is a required `DispatchPipelineDependencies` member (post-S36
 * reconciliation). These routes never carry a resolved secret, so an identity
 * scrub is correct here — stated, rather than inherited from an optional
 * dependency's silent fallback.
 */
const NO_SECRETS_TO_SCRUB = { scrubJson: (value: JsonValue): JsonValue => value };

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const PROVISIONING_SECRET = 'bootstrap-secret-value';
const SUBJECT = 'operator';
const PASSWORD = 'correct horse battery staple';
const GITHUB_ALLOWLIST = ['github.com'] as unknown as readonly RemoteHost[];
const CEILING = new Set(['repo.read', 'git.raw']) as unknown as ContractCapabilitySet;

const READ_TOOL = fixtureTool({ name: 'repo_status', capabilities: ['repo.read'], scopes: ['read'], executionClass: 'read', target: httpTarget('t.read') });
const RAW_TOOL = fixtureTool({ name: 'git_raw', capabilities: ['git.raw'], scopes: ['raw'], executionClass: 'read', target: httpTarget('t.raw') });

/** What the stubbed tool answers with. A test sets it before a call; the default is a success. */
let stubbedResult: ToolResult<JsonValue> = success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 });

const STUB_HTTP_ADAPTER: Pick<HttpAdapter, 'invoke'> = {
  async invoke() {
    return stubbedResult;
  },
};

interface ServerHandle {
  readonly baseUrl: string;
  readonly declarations: Declarations;
  readonly mcpState: McpRoutesState;
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

async function withServer<T>(volume: string, fn: (handle: ServerHandle) => Promise<T>): Promise<T> {
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
    registry: { fingerprint: 'a'.repeat(64) as never, compiledAt: systemClock.now(), entries: [READ_TOOL, RAW_TOOL], contractCapabilitySet: CEILING as unknown as never },
    ceiling: CEILING as unknown as DeploymentCeiling,
    moduleAdapter: createModuleAdapter(),
    httpAdapter: STUB_HTTP_ADAPTER,
    declarations,
    cloneStore: createStubCloneStore(),
    locks: { pinActiveOperation: () => ({ release() {} }), acquireMutation: async () => ({ ok: true, value: { release() {} } }) } as never,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
    clock: systemClock,
  });

  const mcpState = createMcpRoutesState();
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
    declarations,
    cloneStore: createStubCloneStore(),
    dispatchPipeline,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as never,
    origin: 'http://localhost',
    mcpState,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn({ baseUrl: `http://127.0.0.1:${address.port}`, declarations, mcpState });
  } finally {
    closeMcpStreams(mcpState);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

/**
 * Drives the `/oauth/authorize` `GET` → operator-approval `POST` half of the
 * S14.7 flow and returns the resulting authorization code, or `null` plus
 * the response that refused it — every mechanical step a real client and
 * operator perform, over real HTTP, against the real routes.
 */
async function obtainAuthorizationCode(
  baseUrl: string,
  clientId: string,
  declarationId: string,
  scopes: readonly string[],
  redirectUri: string = CLIENT_REDIRECT_URI,
  operatorSession?: string,
): Promise<{ code: string | null; verifier: string; getStatus: number; getBody: string; approveStatus?: number }> {
  const { verifier, challenge } = pkce();
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('resource', `/mcp/${declarationId}`);
  authorizeUrl.searchParams.set('scope', scopes.join(' '));

  const cookie = operatorSession ?? (await operatorCookie(baseUrl));
  const csrfToken = /szg_csrf=([^;]+)/.exec(cookie)?.[1];
  assert.ok(csrfToken, 'operatorCookie must carry the double-submit CSRF cookie');
  const getResponse = await fetch(authorizeUrl, { headers: { Cookie: cookie } });
  const html = await getResponse.text();
  if (getResponse.status !== 200) {
    return { code: null, verifier, getStatus: getResponse.status, getBody: html };
  }
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(requestId, 'the approval form must carry a request_id');

  const approveResponse = await fetch(`${baseUrl}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie, Origin: baseUrl, 'X-CSRF-Token': csrfToken!, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId!, action: 'approve' }),
  });
  if (approveResponse.status !== 302) {
    return { code: null, verifier, getStatus: getResponse.status, getBody: html, approveStatus: approveResponse.status };
  }
  const location = new URL(approveResponse.headers.get('Location')!);
  return { code: location.searchParams.get('code'), verifier, getStatus: getResponse.status, getBody: html, approveStatus: approveResponse.status };
}

/**
 * Drives the full S14.7 flow — dynamic client registration, PKCE
 * authorization, the code-for-token exchange — and returns the tokens a
 * real MCP client would end up holding. Every mechanical step an actual
 * client performs, over real HTTP, against the real routes.
 */
async function fullOAuthFlow(baseUrl: string, declarationId: string, scopes: readonly string[], operatorSession?: string): Promise<{ accessToken: string; refreshToken: string }> {
  const client = await registerClient(baseUrl);
  const { code, verifier } = await obtainAuthorizationCode(baseUrl, client.client_id, declarationId, scopes, CLIENT_REDIRECT_URI, operatorSession);
  assert.ok(code, 'the redirect must carry an authorization code');
  const { status, body } = await exchangeCodeForTokens(baseUrl, client.client_id, code!, verifier);
  assert.equal(status, 200, body);
  const tokens = JSON.parse(body) as { access_token: string; refresh_token: string };
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

async function mcpInitialize(baseUrl: string, declarationId: string, accessToken: string): Promise<{ status: number; sessionId: string | null; wwwAuthenticate: string | null; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/mcp/${declarationId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  return {
    status: response.status,
    sessionId: response.headers.get('Mcp-Session-Id'),
    wwwAuthenticate: response.headers.get('WWW-Authenticate'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function mcpCall(baseUrl: string, declarationId: string, sessionId: string, method: string, params: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/mcp/${declarationId}`, {
    method: 'POST',
    headers: { 'Mcp-Session-Id': sessionId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function mcpNotify(baseUrl: string, declarationId: string, sessionId: string, method: string, params: unknown = {}): Promise<{ status: number; bodyText: string }> {
  const response = await fetch(`${baseUrl}/mcp/${declarationId}`, {
    method: 'POST',
    headers: { 'Mcp-Session-Id': sessionId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  });
  return { status: response.status, bodyText: await response.text() };
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

test('S14.1 — a bearer token whose grant is for a different resource is refused 401 with a WWW-Authenticate resource-metadata challenge, not an envelope', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-a', ['repo.read']);
      await declareRepo(declarations, 'repo-b', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-a', ['read']);

      const wrong = await mcpInitialize(baseUrl, 'repo-b', accessToken);
      assert.equal(wrong.status, 401);
      assert.ok(wrong.wwwAuthenticate, 'a 401 on the MCP transport must carry a WWW-Authenticate challenge');
      assert.match(wrong.wwwAuthenticate!, /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp\/repo-b"/);
      assert.equal('kind' in wrong.body, false, 'a 401 here is a transport-level challenge, never a ToolResult envelope');

      const right = await mcpInitialize(baseUrl, 'repo-a', accessToken);
      assert.equal(right.status, 200);
      assert.ok(right.sessionId);
    });
  });
});

test('S14.2 — a session bound to repository A calling with repository B\'s id in the path returns authorization, not a transport error', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-a2', ['repo.read']);
      await declareRepo(declarations, 'repo-b2', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-a2', ['read']);
      const init = await mcpInitialize(baseUrl, 'repo-a2', accessToken);
      assert.equal(init.status, 200);

      const crossed = await mcpCall(baseUrl, 'repo-b2', init.sessionId!, 'tools/list');
      assert.equal(crossed.status, 403);
      const result = (crossed.body.result as { content: { text: string }[] }).content[0]!.text;
      assert.equal((JSON.parse(result) as { kind: string }).kind, 'authorization');
    });
  });
});

test("S14.3 — tools/list omits a tool the declaration lacks a capability for, and a by-name call for it returns authorization and reaches no handler", async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-c', ['repo.read']); // no git.raw
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-c', ['read', 'raw']);
      const init = await mcpInitialize(baseUrl, 'repo-c', accessToken);
      assert.equal(init.status, 200);

      const list = await mcpCall(baseUrl, 'repo-c', init.sessionId!, 'tools/list');
      assert.equal(list.status, 200);
      const tools = (list.body.result as { tools: { name: string }[] }).tools.map((t) => t.name);
      assert.ok(tools.includes('repo_status'));
      assert.ok(!tools.includes('git_raw'), 'a tool requiring a capability the declaration lacks must be absent, not merely refused');

      const call = await mcpCall(baseUrl, 'repo-c', init.sessionId!, 'tools/call', { name: 'git_raw', arguments: {} });
      assert.equal(call.status, 403);
      const result = (call.body.result as { content: { text: string }[] }).content[0]!.text;
      assert.equal((JSON.parse(result) as { kind: string }).kind, 'authorization');
    });
  });
});

test('#177 — a JSON-RPC notification (no id), notably notifications/initialized, gets no response body and does not abort the session', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-notify', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-notify', ['read']);
      const init = await mcpInitialize(baseUrl, 'repo-notify', accessToken);
      assert.equal(init.status, 200);

      const notified = await mcpNotify(baseUrl, 'repo-notify', init.sessionId!, 'notifications/initialized');
      assert.equal(notified.status, 202, 'a notification must never be answered with a JSON-RPC error');
      assert.equal(notified.bodyText, '', 'a notification response carries no body');

      // The accept sits below the session checks: a notification is not a way
      // around them, and an id-less `initialize` mints no session.
      const unsessioned = await mcpNotify(baseUrl, 'repo-notify', 'not-a-session', 'notifications/initialized');
      assert.equal(unsessioned.status, 401, 'a notification on no live session is refused like any other method');
      const idlessInit = await mcpNotify(baseUrl, 'repo-notify', init.sessionId!, 'initialize');
      assert.equal(idlessInit.status, 202, 'an id-less initialize is accepted and dropped, not answered');
      assert.equal(idlessInit.bodyText, '');

      const list = await mcpCall(baseUrl, 'repo-notify', init.sessionId!, 'tools/list');
      assert.equal(list.status, 200, 'the session must still be usable after the notification');
      const tools = (list.body.result as { tools: { name: string }[] }).tools.map((t) => t.name);
      assert.ok(tools.includes('repo_status'));
    });
  });
});

test('S14.4 / S14.5 — narrowing a live declaration reaches the session on its next call; widening does not, until re-established', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-d', ['repo.read']); // no git.raw from the start
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-d', ['read', 'raw']);
      const init = await mcpInitialize(baseUrl, 'repo-d', accessToken);
      assert.equal(init.status, 200);

      // Widen the declaration after the session was already established.
      const widened = await declarations.amend('repo-d' as never, { cloneUrl: null, credentialRef: null, capabilityGrant: ['repo.read', 'git.raw'], writablePathPrefixes: null, pinned: null, fileWatcher: undefined, identity: null }, { kind: 'operator', subject: 'ben' as never, clientId: null, grantId: null });
      assert.equal(widened.ok, true);

      const stillNarrow = await mcpCall(baseUrl, 'repo-d', init.sessionId!, 'tools/call', { name: 'git_raw', arguments: {} });
      assert.equal(stillNarrow.status, 403, 'S14.5: the frozen session never had git.raw to begin with, and widening the declaration must not hand it one');

      // Now narrow repo.read away too.
      const narrowed = await declarations.amend('repo-d' as never, { cloneUrl: null, credentialRef: null, capabilityGrant: [], writablePathPrefixes: null, pinned: null, fileWatcher: undefined, identity: null }, { kind: 'operator', subject: 'ben' as never, clientId: null, grantId: null });
      assert.equal(narrowed.ok, true);

      const nowRefused = await mcpCall(baseUrl, 'repo-d', init.sessionId!, 'tools/call', { name: 'repo_status', arguments: {} });
      assert.equal(nowRefused.status, 403, 'S14.4: a narrowing declaration reaches the live session on its next call');
    });
  });
});

test('S14.6 — revoking the grant outright closes the session, and the next call answers 401 with the challenge', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-e', ['repo.read']);
      const authorization = createAuthorization({
        volumeRoot: volume,
        clock: systemClock,
        contractCapabilitySet: CEILING,
        ceiling: CEILING as unknown as DeploymentCeiling,
        declarations,
        audit: createAudit({ volumeRoot: volume, clock: systemClock }),
      });
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-e', ['read']);
      const init = await mcpInitialize(baseUrl, 'repo-e', accessToken);
      assert.equal(init.status, 200);

      const grants = await authorization.listGrants('mcp');
      const grant = grants.find((g) => g.grant.declarationId === 'repo-e');
      assert.ok(grant);
      await authorization.revokeGrant(grant!.grant.grantId, { kind: 'operator', subject: 'ben' as never, clientId: null, grantId: null });

      const afterRevoke = await mcpCall(baseUrl, 'repo-e', init.sessionId!, 'tools/list');
      assert.equal(afterRevoke.status, 401);
      assert.ok(afterRevoke.status === 401);
    });
  });
});

test('S14.7 — dynamic client registration, PKCE, and a real refresh-token exchange all work end to end over HTTP', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-f', ['repo.read']);
      const { accessToken, refreshToken } = await fullOAuthFlow(baseUrl, 'repo-f', ['read']);
      assert.ok(accessToken);

      const init = await mcpInitialize(baseUrl, 'repo-f', accessToken);
      assert.equal(init.status, 200);

      const refreshResponse = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      assert.equal(refreshResponse.status, 200);
      const refreshed = (await refreshResponse.json()) as { access_token: string };
      assert.notEqual(refreshed.access_token, accessToken);

      const initWithNewToken = await mcpInitialize(baseUrl, 'repo-f', refreshed.access_token);
      assert.equal(initWithNewToken.status, 200);
    });
  });
});

test('S14 — /oauth/authorize refuses a redirect_uri the client never registered', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-redirect', ['repo.read']);
      const client = await registerClient(baseUrl, [CLIENT_REDIRECT_URI]);

      const attempt = await obtainAuthorizationCode(baseUrl, client.client_id, 'repo-redirect', ['read'], 'https://attacker.invalid/steal');
      assert.equal(attempt.getStatus, 400, attempt.getBody);
      assert.equal(attempt.code, null);
    });
  });
});

test('S14 — POST /oauth/authorize without a matching CSRF token is refused, not approved', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-csrf', ['repo.read']);
      const client = await registerClient(baseUrl);
      const { challenge } = pkce();
      const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
      authorizeUrl.searchParams.set('client_id', client.client_id);
      authorizeUrl.searchParams.set('redirect_uri', CLIENT_REDIRECT_URI);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('resource', '/mcp/repo-csrf');
      authorizeUrl.searchParams.set('scope', 'read');

      const cookie = await operatorCookie(baseUrl);
      const getResponse = await fetch(authorizeUrl, { headers: { Cookie: cookie } });
      const html = await getResponse.text();
      assert.equal(getResponse.status, 200, html);
      const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
      assert.ok(requestId);

      // Same session cookie as a real operator, but no Origin header and no
      // X-CSRF-Token — exactly what a cross-origin forged form POST sends.
      const forged = await fetch(`${baseUrl}/oauth/authorize`, {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ request_id: requestId!, action: 'approve' }),
      });
      assert.equal(forged.status, 403);
    });
  });
});

test('S14 — token exchange for a declaration removed between authorize and exchange fails invalid_grant, not 200', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-vanish', ['repo.read']);
      const client = await registerClient(baseUrl);
      const { code, verifier } = await obtainAuthorizationCode(baseUrl, client.client_id, 'repo-vanish', ['read']);
      assert.ok(code, 'the redirect must carry an authorization code');

      const actor = { kind: 'operator', subject: 'ben' as never, clientId: null, grantId: null } as const;
      const orphaned = await declarations.orphan('repo-vanish' as never, actor);
      assert.equal(orphaned.ok, true, orphaned.ok ? '' : orphaned.error.summary);
      const removed = await declarations.remove('repo-vanish' as never, actor);
      assert.equal(removed.ok, true, removed.ok ? '' : removed.error.summary);

      const { status, body } = await exchangeCodeForTokens(baseUrl, client.client_id, code!, verifier);
      assert.equal(status, 400, body);
      const parsed = JSON.parse(body) as { error: string };
      assert.equal(parsed.error, 'invalid_grant');
    });
  });
});

test('S14.9 — the stdio proxy imports no store, lock, or clone module — the property is structural, not observed at runtime', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../mcp-proxy/proxy.ts', import.meta.url), 'utf8');
  for (const forbidden of ["from '../store/", "from '../locks/", "from '../clone/"]) {
    assert.ok(!source.includes(forbidden), `proxy.ts must not import ${forbidden} — it is a transport shim, not a participant in the volume`);
  }
});

test('S14.9 — running proxy.ts directly (as an MCP client config would) actually enters runProxy(), on this platform', async () => {
  // Regression for the naive `file://${argv[1].replace(...)}` comparison,
  // which never matched `import.meta.url`'s real form on Windows and made
  // `isMain` always false there — the process would exit 0 having done
  // nothing. Spawned as a real subprocess (not imported) because `isMain`
  // is evaluated at module load against `process.argv`, which only a real
  // process invocation exercises.
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const proxyPath = fileURLToPath(new URL('../mcp-proxy/proxy.ts', import.meta.url));
  const result = spawnSync(process.execPath, [proxyPath], {
    env: { ...process.env, SZG_ORIGIN: '', SZG_DECLARATION_ID: '', SZG_BEARER_TOKEN: '' },
    encoding: 'utf8',
  });
  // If `isMain` never fires, the process exits 0 with no output at all —
  // the failure mode this test exists to catch. If it fires, missing env
  // vars make `resolveProxyOptionsFromEnv` throw, which the top-level
  // `.catch` reports on stderr with exit code 1.
  assert.equal(result.status, 1, `expected proxy.ts to run its entry point and exit 1 on missing env, got status=${result.status}, stderr=${result.stderr}`);
  assert.match(result.stderr, /SZG_ORIGIN, SZG_DECLARATION_ID and SZG_BEARER_TOKEN must all be set/);
});

const EVERY_RESULT_KIND: readonly ResultKind[] = ['success', 'validation', 'precondition', 'conflict', 'authorization', 'upstream', 'timeout', 'infrastructure'];

test('S46.7 — isError is true only for upstream, timeout and infrastructure, and a test covers every ResultKind', async () => {
  assert.deepEqual(
    EVERY_RESULT_KIND.filter((kind) => isError(kind)),
    ['upstream', 'timeout', 'infrastructure'],
    'the helper itself is the contract (invariant E2)',
  );
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-e2', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-e2', ['read']);
      const init = await mcpInitialize(baseUrl, 'repo-e2', accessToken);
      assert.equal(init.status, 200);
      try {
        for (const kind of EVERY_RESULT_KIND) {
          stubbedResult =
            kind === 'success'
              ? success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 })
              : { ok: false, kind, summary: `a ${kind} result` };
          const call = await mcpCall(baseUrl, 'repo-e2', init.sessionId!, 'tools/call', { name: 'repo_status', arguments: {} });
          const result = call.body.result as { isError: boolean; content: { text: string }[] };
          assert.equal((JSON.parse(result.content[0]!.text) as { kind: string }).kind, kind, `the stub delivered a '${kind}' result`);
          assert.equal(result.isError, isError(kind), `isError for '${kind}'`);
        }
      } finally {
        stubbedResult = success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 });
      }
    });
  });
});

test('S46.7 — the cross-repository refusal is an authorization result, so it is not an isError tool fault', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-a7', ['repo.read']);
      await declareRepo(declarations, 'repo-b7', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-a7', ['read']);
      const init = await mcpInitialize(baseUrl, 'repo-a7', accessToken);
      assert.equal(init.status, 200);

      const crossed = await mcpCall(baseUrl, 'repo-b7', init.sessionId!, 'tools/call', { name: 'repo_status', arguments: {} });
      assert.equal(crossed.status, 403);
      const result = crossed.body.result as { isError: boolean; content: { text: string }[] };
      assert.equal((JSON.parse(result.content[0]!.text) as { kind: string }).kind, 'authorization');
      assert.equal(result.isError, false);
    });
  });
});

// ---------------------------------------------------------------------------
// S55 — a connected agent hears when its tools change.
// ---------------------------------------------------------------------------

const OPERATOR_ACTOR = { kind: 'operator', subject: 'ben' as never, clientId: null, grantId: null } as const;

/** Resolves on the first `notifications/tools/list_changed` the client receives, or rejects after `ms`. */
function nextListChanged(client: Client, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no notifications/tools/list_changed within ${ms} ms`)), ms);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A real SDK client over the real route — the transport an agent actually uses, bearer and all. */
async function connectSdkClient(baseUrl: string, declarationId: string, accessToken: string): Promise<Client> {
  const client = new Client({ name: 's55-agent', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${declarationId}`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

test('S55.2 — a real SDK client hears notifications/tools/list_changed within 2 s of its grant narrowing, and its next list omits the removed tool', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-s55', ['repo.read', 'git.raw']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-s55', ['read', 'raw']);
      const client = await connectSdkClient(baseUrl, 'repo-s55', accessToken);
      try {
        assert.equal(client.getServerCapabilities()?.tools?.listChanged, true, 'initialize advertises tools.listChanged');
        const before = (await client.listTools()).tools.map((t) => t.name);
        assert.ok(before.includes('git_raw'));

        const heard = nextListChanged(client, 2000);
        const narrowed = await declarations.amend('repo-s55' as never, { cloneUrl: null, credentialRef: null, capabilityGrant: ['repo.read'], writablePathPrefixes: null, pinned: null, fileWatcher: undefined, identity: null }, OPERATOR_ACTOR);
        assert.equal(narrowed.ok, true);
        await heard;

        const after = (await client.listTools()).tools.map((t) => t.name);
        assert.ok(after.includes('repo_status'));
        assert.ok(!after.includes('git_raw'), 'the narrowed-away tool is gone from the next list');
      } finally {
        await client.close();
      }
    });
  });
});

interface OpenedStream {
  readonly status: number;
  readonly wwwAuthenticate: string | null;
  readonly body: string | null;
  readonly response: Response;
  readonly abort: AbortController;
}

/** A raw `GET` on the route, as the SDK client sends it; a `200` is left open for the caller. */
async function openStream(baseUrl: string, declarationId: string, headers: Record<string, string>): Promise<OpenedStream> {
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/mcp/${declarationId}`, { method: 'GET', headers: { Accept: 'text/event-stream', ...headers }, signal: abort.signal });
  const body = response.status === 200 ? null : await response.text();
  return { status: response.status, wwwAuthenticate: response.headers.get('WWW-Authenticate'), body, response, abort };
}

/** Resolves when the server ends the stream, or rejects after `ms`. */
async function streamEnds(stream: OpenedStream, ms: number): Promise<void> {
  const reader = stream.response.body!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the stream was still open after ${ms} ms`)), ms);
  });
  try {
    await Promise.race([
      (async () => {
        while (!(await reader.read()).done) {
          // Drain until the server ends it.
        }
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('S55.3 — a GET without the bearer, without a live session, or under another grant is refused 401 and opens nothing; one not asking for an event stream is 405', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations, mcpState }) => {
      await declareRepo(declarations, 'repo-s55a', ['repo.read']);
      // Two clients the operator approved separately: two grants on the one resource.
      const operator = await operatorCookie(baseUrl);
      const own = await fullOAuthFlow(baseUrl, 'repo-s55a', ['read'], operator);
      const other = await fullOAuthFlow(baseUrl, 'repo-s55a', ['read'], operator);
      const init = await mcpInitialize(baseUrl, 'repo-s55a', own.accessToken);
      assert.equal(init.status, 200);
      const sessionId = init.sessionId!;

      const refusals: Array<[string, Record<string, string>]> = [
        ['no bearer', { 'Mcp-Session-Id': sessionId }],
        ['no session id', { Authorization: `Bearer ${own.accessToken}` }],
        ['an unknown session id', { Authorization: `Bearer ${own.accessToken}`, 'Mcp-Session-Id': 'not-a-session' }],
        ["another grant's bearer", { Authorization: `Bearer ${other.accessToken}`, 'Mcp-Session-Id': sessionId }],
        ['a garbage bearer', { Authorization: 'Bearer not-a-token', 'Mcp-Session-Id': sessionId }],
      ];
      for (const [label, headers] of refusals) {
        const stream = await openStream(baseUrl, 'repo-s55a', headers);
        assert.equal(stream.status, 401, label);
        assert.match(stream.wwwAuthenticate ?? '', /resource_metadata=/, `${label} carries the challenge`);
        assert.equal(mcpState.streams.size, 0, `${label} opened nothing`);
      }

      const plain = await fetch(`${baseUrl}/mcp/repo-s55a`, { method: 'GET', headers: { Authorization: `Bearer ${own.accessToken}`, 'Mcp-Session-Id': sessionId } });
      assert.equal(plain.status, 405);
      assert.equal(mcpState.streams.size, 0);

      // The refusals cost the session nothing: the owner's own stream opens.
      const ok = await openStream(baseUrl, 'repo-s55a', { Authorization: `Bearer ${own.accessToken}`, 'Mcp-Session-Id': sessionId });
      assert.equal(ok.status, 200);
      assert.equal(ok.response.headers.get('Content-Type'), 'text/event-stream');
      assert.equal(mcpState.streams.size, 1);
      ok.abort.abort();
    });
  });
});

test('S55.4 — revoking the grant ends every stream under it within 2 s, and a reconnect with the same session is refused 401', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations, mcpState }) => {
      await declareRepo(declarations, 'repo-s55b', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-s55b', ['read']);
      const first = await mcpInitialize(baseUrl, 'repo-s55b', accessToken);
      const second = await mcpInitialize(baseUrl, 'repo-s55b', accessToken);
      const streams = [
        await openStream(baseUrl, 'repo-s55b', { Authorization: `Bearer ${accessToken}`, 'Mcp-Session-Id': first.sessionId! }),
        await openStream(baseUrl, 'repo-s55b', { Authorization: `Bearer ${accessToken}`, 'Mcp-Session-Id': second.sessionId! }),
      ];
      assert.deepEqual(streams.map((st) => st.status), [200, 200]);
      assert.equal(mcpState.streams.size, 2);

      // Revoked through a separate instance over the same store, as the console does — no in-process event reaches the route.
      const authorization = createAuthorization({
        volumeRoot: volume,
        clock: systemClock,
        contractCapabilitySet: CEILING,
        ceiling: CEILING as unknown as DeploymentCeiling,
        declarations,
        audit: createAudit({ volumeRoot: volume, clock: systemClock }),
      });
      const grant = (await authorization.listGrants('mcp')).find((g) => g.grant.declarationId === 'repo-s55b');
      assert.ok(grant);
      await authorization.revokeGrant(grant!.grant.grantId, OPERATOR_ACTOR);

      await Promise.all(streams.map((st) => streamEnds(st, 2000)));
      assert.equal(mcpState.streams.size, 0);

      const reconnect = await openStream(baseUrl, 'repo-s55b', { Authorization: `Bearer ${accessToken}`, 'Mcp-Session-Id': first.sessionId! });
      assert.equal(reconnect.status, 401);
      assert.equal(mcpState.streams.size, 0);
    });
  });
});

test('S55.6 — past MAX_STREAMS_PER_GRANT open streams the next is refused 429 too_many_streams, and none of the open ones is evicted', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations, mcpState }) => {
      await declareRepo(declarations, 'repo-s55c', ['repo.read']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-s55c', ['read']);
      const init = await mcpInitialize(baseUrl, 'repo-s55c', accessToken);
      const headers = { Authorization: `Bearer ${accessToken}`, 'Mcp-Session-Id': init.sessionId! };

      const open: OpenedStream[] = [];
      for (let i = 0; i < MAX_STREAMS_PER_GRANT; i++) open.push(await openStream(baseUrl, 'repo-s55c', headers));
      assert.ok(open.every((st) => st.status === 200));

      const over = await openStream(baseUrl, 'repo-s55c', headers);
      assert.equal(over.status, 429);
      assert.deepEqual(JSON.parse(over.body!), { error: 'too_many_streams' });
      assert.equal(mcpState.streams.get(init.sessionId!)?.size, MAX_STREAMS_PER_GRANT, 'every open stream is still open');

      // A closed stream frees its slot.
      open[0]!.abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const again = await openStream(baseUrl, 'repo-s55c', headers);
      assert.equal(again.status, 200);
      for (const st of [...open.slice(1), again]) st.abort.abort();
    });
  });
});

test('S55.5 — the stdio proxy forwards notifications/tools/list_changed from the remote route to its local client', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async ({ baseUrl, declarations }) => {
      await declareRepo(declarations, 'repo-s55d', ['repo.read', 'git.raw']);
      const { accessToken } = await fullOAuthFlow(baseUrl, 'repo-s55d', ['read', 'raw']);
      // The remote half is a real SDK client on the real route, as `runProxy` builds it; only stdio is swapped for an in-memory pair.
      const remote = await connectSdkClient(baseUrl, 'repo-s55d', accessToken);
      const { server } = createProxyServer({ origin: baseUrl, declarationId: 'repo-s55d', bearerToken: accessToken }, remote);
      const [localSide, proxySide] = InMemoryTransport.createLinkedPair();
      const local = new Client({ name: 's55-local-agent', version: '1' });
      try {
        await server.connect(proxySide);
        await local.connect(localSide);
        assert.equal(local.getServerCapabilities()?.tools?.listChanged, true, 'the proxy advertises tools.listChanged to its local client');
        assert.ok((await local.listTools()).tools.some((t) => t.name === 'git_raw'));

        const heard = nextListChanged(local, 2000);
        const narrowed = await declarations.amend('repo-s55d' as never, { cloneUrl: null, credentialRef: null, capabilityGrant: ['repo.read'], writablePathPrefixes: null, pinned: null, fileWatcher: undefined, identity: null }, OPERATOR_ACTOR);
        assert.equal(narrowed.ok, true);
        await heard;
        assert.ok(!(await local.listTools()).tools.some((t) => t.name === 'git_raw'));
      } finally {
        await local.close();
        await server.close();
        await remote.close();
      }
    });
  });
});
