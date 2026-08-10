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
import { createAuthorization, type Authorization } from '../authorization/authorization.ts';
import { createStoreFailingAuthorization } from '../authorization/testing/stub-authorization.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './http-server.ts';
import { createMcpRoutesState } from './mcp-routes.ts';
import type { GitSha, Sha256Hex } from '../shared/brands.ts';
import { createStubDeclarations } from '../declarations/testing/stub-declarations.ts';
import { createStubCloneStore } from '../clone/testing/stub-clone-store.ts';
import { createStubDispatchPipeline } from '../dispatch/testing/stub-dispatch-pipeline.ts';
import type { ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';

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

async function withServer<T>(volume: string, fn: (baseUrl: string) => Promise<T>, override?: Partial<Authorization>): Promise<T> {
  const identity = await buildIdentity(volume);
  writeProvisioningSecret(volume, PROVISIONING_SECRET);
  const real = createAuthorization({
    volumeRoot: volume,
    clock: systemClock,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as unknown as DeploymentCeiling,
    declarations: createStubDeclarations(),
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
  });
  // The override replaces only the members a test names, so login, issuance
  // and the session listing all keep working around the simulated failure.
  const authorization: Authorization = override ? { ...real, ...override } : real;
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
        operatorSessions: { ref: string; subject: string }[];
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

test('the grants view never publishes a session id — the cookie value it would hand over is the session itself', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const sessionCookie = auth.sessionCookieHeader.split(';')[0]!.slice('szg_session='.length);

      const list = await fetch(`${baseUrl}/grants`, { headers: { Cookie: auth.sessionCookieHeader } });
      const raw = await list.text();
      assert.equal(raw.includes(sessionCookie), false, 'the live session cookie value must not appear anywhere in the response body');

      const body = JSON.parse(raw) as { operatorSessions: { ref: string; id?: string }[] };
      assert.equal(body.operatorSessions[0]!.id, undefined, 'no id field at all, not merely a different value');
      assert.notEqual(body.operatorSessions[0]!.ref, sessionCookie);

      // The handle still has to work, or the leak was closed by removing the
      // feature. Revoking through it kills the very session doing the asking.
      const revoked = await fetch(`${baseUrl}/operator-sessions/${body.operatorSessions[0]!.ref}/revoke`, {
        method: 'POST',
        headers: { Origin: baseUrl, Cookie: auth.sessionCookieHeader, 'X-CSRF-Token': auth.csrfToken },
      });
      assert.equal(revoked.status, 200);

      const afterRevocation = await fetch(`${baseUrl}/grants`, { headers: { Cookie: auth.sessionCookieHeader } });
      assert.equal(afterRevocation.status, 401, 'the revoked session no longer authenticates');
    });
  });
});

test('an unknown session ref is a 404, not a 500 — a stale handle from an old listing is an ordinary miss', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const response = await fetch(`${baseUrl}/operator-sessions/${'0'.repeat(64)}/revoke`, {
        method: 'POST',
        headers: { Origin: baseUrl, Cookie: auth.sessionCookieHeader, 'X-CSRF-Token': auth.csrfToken },
      });
      assert.equal(response.status, 404);
    });
  });
});

test('revoking a grant that does not exist is a 404, and the code says which failure it was', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const response = await fetch(`${baseUrl}/grants/no-such-grant/revoke`, {
        method: 'POST',
        headers: { Origin: baseUrl, Cookie: auth.sessionCookieHeader, 'X-CSRF-Token': auth.csrfToken },
      });
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as { error: string }).error, 'token-unknown');
    });
  });
});

test("a token whose scopes do not reach a route is refused 403, not 401 — the credential is good, its scope is not", async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      // CEILING carries `git.raw` but the `schedule` scope expands to
      // `scheduler.manage`, which the ceiling drops — so this token verifies
      // successfully and carries an empty grant.
      const token = await issueToken(baseUrl, auth, ['schedule']);

      const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 403, 'authenticated, but the scope does not carry repo.read');
      assert.equal(((await response.json()) as { error: string }).error, 'forbidden');

      const readToken = await issueToken(baseUrl, auth, ['read']);
      const allowed = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${readToken}` } });
      assert.equal(allowed.status, 200, 'a read-scoped token still reaches the same route');
    });
  });
});

test('a revocation that could not reach the store is a 503, not a 404 — "already gone" is the one wrong answer here', async () => {
  await withVolumeAsync(async (volume) => {
    const storeFailing = createStoreFailingAuthorization();
    await withServer(
      volume,
      async (baseUrl) => {
        const auth = await enrolAndLogin(baseUrl);
        for (const path of ['/grants/some-grant/revoke', '/tokens/some-token/revoke', '/clients/some-client/revoke']) {
          const response = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { Origin: baseUrl, Cookie: auth.sessionCookieHeader, 'X-CSRF-Token': auth.csrfToken },
          });
          assert.equal(response.status, 503, `${path} must not report an unwritable store as a missing record`);
          assert.equal(((await response.json()) as { error: string }).error, 'store-failed');
        }
      },
      { revokeGrant: storeFailing.revokeGrant, revokeToken: storeFailing.revokeToken, revokeClient: storeFailing.revokeClient },
    );
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
