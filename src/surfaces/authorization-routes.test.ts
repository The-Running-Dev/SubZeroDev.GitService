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
import type { GitSha, Sha256Hex } from '../shared/brands.ts';
import { createStubDeclarations } from '../declarations/testing/stub-declarations.ts';
import { createStubCloneStore } from '../clone/testing/stub-clone-store.ts';
import { createStubDispatchPipeline } from '../dispatch/testing/stub-dispatch-pipeline.ts';
import type { ContractCapabilitySet } from '../contract/capabilities.ts';

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const PROVISIONING_SECRET = 'bootstrap-secret-value';
const SUBJECT = 'operator';
const PASSWORD = 'correct horse battery staple';
const CEILING = new Set(['repo.read', 'git.raw']) as unknown as ContractCapabilitySet;

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
  const authorization = createAuthorization({ volumeRoot: volume, clock: systemClock, contractCapabilitySet: CEILING });
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: async () => (await identity.provisioningState()) === 'pending',
    auditChain: async () => ({ verifiedThrough: null, headHash: null, mirroredHeadHash: null, retainedAnchors: [], chainBreak: null }),
    authorization,
    identity,
    sessionAbsoluteSeconds: 43_200,
    declarations: createStubDeclarations(),
    cloneStore: createStubCloneStore(),
    dispatchPipeline: createStubDispatchPipeline(),
    contractCapabilitySet: CEILING,
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

async function enrolAndLogin(baseUrl: string): Promise<{ sessionCookieHeader: string; csrfToken: string }> {
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
  return { sessionCookieHeader: `szg_session=${session}; szg_csrf=${csrf}`, csrfToken: csrf! };
}

async function issueToken(baseUrl: string, auth: { sessionCookieHeader: string; csrfToken: string }, scopes: readonly string[]): Promise<string> {
  const response = await fetch(`${baseUrl}/grants/tokens`, {
    method: 'POST',
    headers: { Origin: baseUrl, Cookie: auth.sessionCookieHeader, 'X-CSRF-Token': auth.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scopes }),
  });
  const body = (await response.json()) as { value: string };
  assert.equal(response.status, 200);
  return body.value;
}

test('S13.2 — a bearer route rejects a cookie presented with no Authorization header', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const response = await fetch(`${baseUrl}/health`, { headers: { Cookie: auth.sessionCookieHeader } });
      assert.equal(response.status, 401, 'a console session cookie alone does not authenticate a bearer route');
    });
  });
});

test('S13.2 — a cookie route rejects a bearer token presented with no cookie', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const token = await issueToken(baseUrl, auth, ['read']);
      const response = await fetch(`${baseUrl}/grants`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 401, 'a bearer token alone does not authenticate a cookie route');
    });
  });
});

test('S13.2 — an operator API token issued from the grants view authenticates a bearer route', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const token = await issueToken(baseUrl, auth, ['read']);
      const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
    });
  });
});

test('S13.8 — the grants view lists an issued token and operator session, and revokes either', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      await issueToken(baseUrl, auth, ['read', 'write']);

      const list = await fetch(`${baseUrl}/grants`, { headers: { Cookie: auth.sessionCookieHeader } });
      assert.equal(list.status, 200);
      const body = (await list.json()) as {
        grants: { grant: { grantId: string; kind: string }; activeTokens: number }[];
        operatorSessions: { id: string; subject: string }[];
      };
      assert.equal(body.grants.length, 1);
      assert.equal(body.grants[0]!.grant.kind, 'operator-api');
      assert.equal(body.grants[0]!.activeTokens, 1);
      assert.equal(body.operatorSessions.length, 1, 'the console session that issued the token is itself listed');
      assert.equal(body.operatorSessions[0]!.subject, SUBJECT);

      const revoked = await fetch(`${baseUrl}/grants/${body.grants[0]!.grant.grantId}/revoke`, {
        method: 'POST',
        headers: { Origin: baseUrl, Cookie: auth.sessionCookieHeader, 'X-CSRF-Token': auth.csrfToken },
      });
      assert.equal(revoked.status, 200);

      const after = await fetch(`${baseUrl}/grants`, { headers: { Cookie: auth.sessionCookieHeader } });
      const afterBody = (await after.json()) as { grants: { grant: { revokedAt: string | null } }[] };
      assert.notEqual(afterBody.grants[0]!.grant.revokedAt, null);
    });
  });
});

test('/grants/tokens is a mutating cookie route: it needs the double-submit token too, not just the session', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const response = await fetch(`${baseUrl}/grants/tokens`, {
        method: 'POST',
        headers: { Origin: baseUrl, Cookie: auth.sessionCookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes: ['read'] }),
      });
      assert.equal(response.status, 403, 'missing the X-CSRF-Token header is rejected, matching every other mutating console route');
    });
  });
});
