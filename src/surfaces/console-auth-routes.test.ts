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
import {
  createOperatorIdentity,
  TOTP_SEALING_KEY_FILENAME,
  writeProvisioningSecret,
  type OperatorIdentity,
} from '../operator-identity/operator-identity.ts';
import { base32Decode, currentTotpCode } from '../operator-identity/totp.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from './http-server.ts';
import type { GitSha, Sha256Hex } from '../shared/brands.ts';

const COMMIT_SHA = '0'.repeat(40) as GitSha;
const CONTRACT_FINGERPRINT = '1'.repeat(64) as Sha256Hex;
const OPERATOR_API_TOKEN = 'test-operator-token';
const PROVISIONING_SECRET = 'bootstrap-secret-value';
const SUBJECT = 'operator';
const PASSWORD = 'correct horse battery staple';

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

async function withServer<T>(volume: string, fn: (baseUrl: string, identity: OperatorIdentity) => Promise<T>): Promise<T> {
  const identity = await buildIdentity(volume);
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: async () => (await identity.provisioningState()) === 'pending',
    auditChain: async () => ({ verifiedThrough: null, headHash: null, mirroredHeadHash: null, retainedAnchors: [], chainBreak: null }),
    operatorApiToken: OPERATOR_API_TOKEN,
    identity,
    sessionAbsoluteSeconds: 43_200,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`, identity);
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

async function enrolAndLogin(baseUrl: string): Promise<{ cookies: string[]; sessionCookieHeader: string; csrfToken: string }> {
  const enrolResponse = await fetch(`${baseUrl}/auth/enrol`, {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: JSON.stringify({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
  });
  assert.equal(enrolResponse.status, 200);
  const enrolBody = (await enrolResponse.json()) as { totpSecret: string; recoveryCodes: string[] };

  const totpBytes = base32Decode(enrolBody.totpSecret);
  const code = currentTotpCode(totpBytes, Date.parse(systemClock.now()) / 1000);

  const loginResponse = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: JSON.stringify({ subject: SUBJECT, password: PASSWORD, totpCode: code }),
  });
  assert.equal(loginResponse.status, 200);
  const setCookies = loginResponse.headers.getSetCookie();
  const session = cookieValue(setCookies, 'szg_session');
  const csrf = cookieValue(setCookies, 'szg_csrf');
  assert.ok(session, 'a session cookie was set');
  assert.ok(csrf, 'a csrf cookie was set');
  return { cookies: setCookies, sessionCookieHeader: `szg_session=${session}; szg_csrf=${csrf}`, csrfToken: csrf! };
}

test('S4.1 — before any operator credential exists, /health (bearer-authenticated) reports provisioningPending true', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${OPERATOR_API_TOKEN}` } });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { provisioningPending: boolean };
      assert.equal(body.provisioningPending, true);
    });
  });
});

test('S4.1 — console routes answer 401 with no session', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const whoami = await fetch(`${baseUrl}/auth/session`);
      assert.equal(whoami.status, 401);

      const logout = await fetch(`${baseUrl}/auth/logout`, { method: 'POST' });
      assert.equal(logout.status, 401);
    });
  });
});

test('a malformed Cookie header answers 401 rather than crashing the route with a 500', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      // `%` is not a valid percent-escape; decodeURIComponent throws on it.
      const response = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: 'szg_session=%' } });
      assert.equal(response.status, 401);
    });
  });
});

test('S4.2 — enrolment with the wrong secret answers 401; with the right secret it succeeds once', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const wrong = await fetch(`${baseUrl}/auth/enrol`, {
        method: 'POST',
        headers: { Origin: baseUrl },
        body: JSON.stringify({ provisioningSecret: 'nope', subject: SUBJECT, password: PASSWORD }),
      });
      assert.equal(wrong.status, 401);

      const right = await fetch(`${baseUrl}/auth/enrol`, {
        method: 'POST',
        headers: { Origin: baseUrl },
        body: JSON.stringify({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
      });
      assert.equal(right.status, 200);
      const body = (await right.json()) as { recoveryCodes: string[] };
      assert.equal(body.recoveryCodes.length, 10);

      const again = await fetch(`${baseUrl}/auth/enrol`, {
        method: 'POST',
        headers: { Origin: baseUrl },
        body: JSON.stringify({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
      });
      assert.equal(again.status, 401);
      const againBody = (await again.json()) as { error: string };
      assert.equal(againBody.error, 'already-provisioned');
    });
  });
});

test('a cross-origin POST to /auth/enrol is rejected before it ever reaches operator identity', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/enrol`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
        body: JSON.stringify({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
      });
      assert.equal(response.status, 403);
    });
  });
});

test('a cross-origin POST to /auth/login is rejected, even with the correct password and TOTP code', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const enrolResponse = await fetch(`${baseUrl}/auth/enrol`, {
        method: 'POST',
        headers: { Origin: baseUrl },
        body: JSON.stringify({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
      });
      const { totpSecret } = (await enrolResponse.json()) as { totpSecret: string };
      const code = currentTotpCode(base32Decode(totpSecret), Date.parse(systemClock.now()) / 1000);

      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
        body: JSON.stringify({ subject: SUBJECT, password: PASSWORD, totpCode: code }),
      });
      assert.equal(response.status, 403);
    });
  });
});

test('a same-origin POST to /auth/enrol with no Origin header at all is rejected (fail-closed, not fail-open)', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/enrol`, {
        method: 'POST',
        body: JSON.stringify({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
      });
      assert.equal(response.status, 403);
    });
  });
});

test('S4.8 — the session cookie carries HttpOnly, Secure, SameSite=Lax and no Domain (host-scoped)', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const { cookies } = await enrolAndLogin(baseUrl);
      const sessionCookie = cookies.find((c) => c.startsWith('szg_session='))!;
      assert.match(sessionCookie, /HttpOnly/);
      assert.match(sessionCookie, /Secure/);
      assert.match(sessionCookie, /SameSite=Lax/);
      assert.doesNotMatch(sessionCookie, /Domain=/i, 'no Domain attribute — host-scoped, no subdomain sharing');
    });
  });
});

test('S4.7 — a mutating console route without the double-submit token is rejected', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const { sessionCookieHeader } = await enrolAndLogin(baseUrl);

      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookieHeader,
          Origin: baseUrl,
          // No X-CSRF-Token header at all.
        },
      });
      assert.equal(response.status, 403);
    });
  });
});

test('S4.7 — a mutating console route with a mismatched Origin is rejected, even with the correct double-submit token', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const { sessionCookieHeader, csrfToken } = await enrolAndLogin(baseUrl);

      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookieHeader,
          Origin: 'https://attacker.example',
          'X-CSRF-Token': csrfToken,
        },
      });
      assert.equal(response.status, 403);
    });
  });
});

test('S4.6 / S4.7 — a well-formed logout (matching Origin and double-submit token) succeeds, and the cookie is dead afterwards', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const { sessionCookieHeader, csrfToken } = await enrolAndLogin(baseUrl);

      const logout = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Cookie: sessionCookieHeader, Origin: baseUrl, 'X-CSRF-Token': csrfToken },
      });
      assert.equal(logout.status, 200);

      const replay = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: sessionCookieHeader } });
      assert.equal(replay.status, 401, 'the same cookie replayed after logout is rejected — invalidation is server-side');
    });
  });
});
