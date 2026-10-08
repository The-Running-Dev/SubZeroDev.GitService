import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { createStubDeclarations } from '../declarations/testing/stub-declarations.ts';
import { createStubCloneStore } from '../clone/testing/stub-clone-store.ts';
import { createStubDispatchPipeline } from '../dispatch/testing/stub-dispatch-pipeline.ts';
import type { ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';

/**
 * S64 (`30-slices.md` § S64): one helper owns JSON response writing and
 * request-body parsing for every HTTP surface, and every route keeps the
 * body-size limit it had — passed explicitly, so consolidating the parser
 * cannot quietly move a route onto someone else's default.
 *
 * Each boundary test sends a body of exactly the route's limit, which must
 * reach the route's own handling, and one byte more, which must be refused
 * the way that route refuses an unreadable body. The at-limit body is built
 * to fail later for a different, recognisable reason, so "not refused for
 * size" is distinguishable from "refused".
 */

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const PROVISIONING_SECRET = 'bootstrap-secret-value';
const SUBJECT = 'operator';
const PASSWORD = 'correct horse battery staple';
const CEILING = new Set(['repo.read', 'git.raw']) as unknown as ContractCapabilitySet;

const KIB_16 = 16_384;
const KIB_64 = 65_536;
const MIB_1 = 1_048_576;

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

async function withServer<T>(volume: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const identity = await buildIdentity(volume);
  writeProvisioningSecret(volume, PROVISIONING_SECRET);
  const authorization = createAuthorization({
    volumeRoot: volume,
    clock: systemClock,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as unknown as DeploymentCeiling,
    declarations: createStubDeclarations(),
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
    declarations: createStubDeclarations(),
    cloneStore: createStubCloneStore(),
    dispatchPipeline: createStubDispatchPipeline(),
    contractCapabilitySet: CEILING,
    ceiling: CEILING as never,
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

async function enrolAndLogin(baseUrl: string): Promise<Record<string, string>> {
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
  return { Origin: baseUrl, Cookie: `szg_session=${session}; szg_csrf=${csrf}`, 'X-CSRF-Token': csrf! };
}

/** A JSON object of exactly `bytes` bytes: `fields` plus an ASCII `pad` string. */
function jsonOfSize(fields: Record<string, unknown>, bytes: number): string {
  const bare = JSON.stringify({ ...fields, pad: '' });
  const body = JSON.stringify({ ...fields, pad: 'x'.repeat(bytes - bare.length) });
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

/** A form body of exactly `bytes` bytes: `fields` plus an ASCII `pad` value. */
function formOfSize(fields: Record<string, string>, bytes: number): string {
  const bare = new URLSearchParams({ ...fields, pad: '' }).toString();
  const body = new URLSearchParams({ ...fields, pad: 'x'.repeat(bytes - bare.length) }).toString();
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

async function post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; error: unknown }> {
  const response = await fetch(url, { method: 'POST', headers, body });
  const parsed = (await response.json()) as { error?: unknown };
  return { status: response.status, error: parsed.error };
}

test('S64.1 no file under src/surfaces/ defines its own sendJson or readJsonBody', () => {
  const surfaces = import.meta.dirname;
  const offenders: string[] = [];
  for (const entry of readdirSync(surfaces, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry === 'http-json.ts') continue;
    const source = readFileSync(path.join(surfaces, entry), 'utf8');
    for (const name of ['sendJson', 'readJsonBody']) {
      if (new RegExp(`function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*=`).test(source)) offenders.push(`${entry}: ${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('S64.2 16 KiB — POST /auth/login takes a body at the limit and refuses one byte over', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const headers = { Origin: baseUrl };
      const fields = { subject: SUBJECT, password: 'wrong', totpCode: '000000' };
      const atLimit = await post(`${baseUrl}/auth/login`, headers, jsonOfSize(fields, KIB_16));
      assert.equal(atLimit.status, 401, 'a body at the limit reaches credential checking');
      const over = await post(`${baseUrl}/auth/login`, headers, jsonOfSize(fields, KIB_16 + 1));
      assert.deepEqual(over, { status: 400, error: 'bad-request' });
    });
  });
});

test('S64.2 16 KiB — POST /oauth/token takes a form body at the limit and refuses one byte over', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      const fields = { grant_type: 'no-such-grant' };
      const atLimit = await post(`${baseUrl}/oauth/token`, headers, formOfSize(fields, KIB_16));
      assert.deepEqual(atLimit, { status: 400, error: 'unsupported_grant_type' });
      const over = await post(`${baseUrl}/oauth/token`, headers, formOfSize(fields, KIB_16 + 1));
      assert.deepEqual(over, { status: 400, error: 'invalid_request' });
    });
  });
});

test('S64.2 64 KiB — POST /grants/tokens takes a body at the limit and refuses one byte over', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const headers = await enrolAndLogin(baseUrl);
      const fields = { scopes: ['read'] };
      const atLimit = await post(`${baseUrl}/grants/tokens`, headers, jsonOfSize(fields, KIB_64));
      assert.equal(atLimit.status, 200, 'a body at the limit issues the token');
      const over = await post(`${baseUrl}/grants/tokens`, headers, jsonOfSize(fields, KIB_64 + 1));
      assert.deepEqual(over, { status: 400, error: 'bad-request' });
    });
  });
});

test('S64.2 64 KiB — POST /declarations takes a body at the limit and refuses one byte over', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const headers = await enrolAndLogin(baseUrl);
      const atLimit = await post(`${baseUrl}/declarations`, headers, jsonOfSize({}, KIB_64));
      assert.deepEqual(atLimit, { status: 400, error: 'validation' }, 'a body at the limit reaches declaration validation');
      const over = await post(`${baseUrl}/declarations`, headers, jsonOfSize({}, KIB_64 + 1));
      assert.deepEqual(over, { status: 400, error: 'bad-request' });
    });
  });
});

test('S64.2 64 KiB — POST /oauth/register takes a body at the limit and refuses one byte over', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json' };
      const atLimit = await post(`${baseUrl}/oauth/register`, headers, jsonOfSize({}, KIB_64));
      assert.deepEqual(atLimit, { status: 400, error: 'invalid_redirect_uri' }, 'a body at the limit reaches metadata validation');
      const over = await post(`${baseUrl}/oauth/register`, headers, jsonOfSize({}, KIB_64 + 1));
      assert.deepEqual(over, { status: 400, error: 'invalid_client_metadata' });
    });
  });
});

test('S64.2 1 MiB — POST /declarations/:id/tools/:toolName takes a body at the limit and refuses one byte over', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const headers = await enrolAndLogin(baseUrl);
      const url = `${baseUrl}/declarations/repo-limit/tools/some-tool`;
      const atLimit = await fetch(url, { method: 'POST', headers, body: jsonOfSize({}, MIB_1) });
      const atLimitBody = (await atLimit.json()) as { kind?: string };
      assert.equal(atLimitBody.kind, 'infrastructure', 'a body at the limit reaches dispatch');
      const over = await post(url, headers, jsonOfSize({}, MIB_1 + 1));
      assert.deepEqual(over, { status: 400, error: 'bad-request' });
    });
  });
});
