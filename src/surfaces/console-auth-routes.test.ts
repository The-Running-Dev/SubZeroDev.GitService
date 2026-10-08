import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { systemClock } from '../clock/clock.ts';
import { createAudit } from '../audit/audit.ts';
import type { AuditRecord } from '../audit/types.ts';
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
import { createMcpRoutesState } from './mcp-routes.ts';
import type { GitSha, Sha256Hex } from '../shared/brands.ts';
import { createStubDeclarations } from '../declarations/testing/stub-declarations.ts';
import { createStubCloneStore } from '../clone/testing/stub-clone-store.ts';
import { createStubDispatchPipeline } from '../dispatch/testing/stub-dispatch-pipeline.ts';
import { createStubAuthorization } from '../authorization/testing/stub-authorization.ts';
import type { ContractCapabilitySet } from '../contract/capabilities.ts';

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

/**
 * Wraps a dependency so every method called on it is pushed to `calls` as
 * `label.method` before it runs — how the S54 route walk shows a refused
 * request reached nothing past the session check.
 */
function recording<T extends object>(target: T, label: string, calls: string[] | undefined): T {
  if (!calls) return target;
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(`${label}.${String(prop)}`);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

async function withServer<T>(
  volume: string,
  fn: (baseUrl: string, identity: OperatorIdentity) => Promise<T>,
  calls?: string[],
): Promise<T> {
  const identity = recording(await buildIdentity(volume), 'identity', calls);
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: async () => (await identity.provisioningState()) === 'pending',
    auditChain: async () => ({ verifiedThrough: null, headHash: null, mirroredHeadHash: null, retainedAnchors: [], chainBreak: null }),
    authorization: recording(createStubAuthorization(new Map([[OPERATOR_API_TOKEN, 'operator-api' as never]])), 'authorization', calls),
    audit: recording(createAudit({ volumeRoot: volume, clock: systemClock }), 'audit', calls),
    identity,
    sessionAbsoluteSeconds: 43_200,
    declarations: recording(createStubDeclarations(), 'declarations', calls),
    cloneStore: recording(createStubCloneStore(), 'cloneStore', calls),
    dispatchPipeline: recording(createStubDispatchPipeline(), 'dispatchPipeline', calls),
    contractCapabilitySet: new Set() as unknown as ContractCapabilitySet,
    ceiling: new Set() as never,
    origin: 'http://localhost',
    mcpState: createMcpRoutesState(),
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

// ---------------------------------------------------------------------------
// S54 — a recovery-code session is gated until TOTP is re-enrolled.
// ---------------------------------------------------------------------------

/** `20-contract.md` § The HTTP API route table: the four cookie routes the gate leaves open. */
const REENROL_GATE_OPEN = new Set(['POST /auth/totp-reenrol/begin', 'POST /auth/totp-reenrol/complete', 'POST /auth/logout', 'GET /auth/session']);

interface CookieRoute {
  readonly method: string;
  readonly template: string;
}

/**
 * Every route the contract's route tables mark as reachable by cookie —
 * `cookie`, `bearer or cookie`, and `/oauth/authorize`'s `POST` half — read
 * from the document rather than listed here, so a route the contract gains
 * later is walked without this test being edited.
 */
function cookieRoutesFromContract(): readonly CookieRoute[] {
  const contract = readFileSync(new URL('../../design/20-contract.md', import.meta.url), 'utf8');
  const start = contract.indexOf('#### The HTTP API route table');
  const end = contract.indexOf('\n### ', start);
  assert.ok(start !== -1 && end !== -1, 'the route table section is where this test expects it');
  const routes: CookieRoute[] = [];
  for (const line of contract.slice(start, end).split('\n')) {
    const row = /^\| `(\/[^`]+)` \| ([^|]+) \| ([^|]+) \|/.exec(line);
    if (!row) continue;
    const [, template, methodCell, credentialCell] = row as unknown as [string, string, string, string];
    const methods = [...methodCell.matchAll(/`([A-Z]+)`/g)].map((m) => m[1]!);
    for (const method of methods) {
      // A cell covering several methods names each one's credential after it: "`GET` none ...; `POST` ... cookie ...".
      const segment = methods.length > 1 ? (credentialCell.split(';').find((part) => part.includes(`\`${method}\``)) ?? '') : credentialCell;
      if (/\bcookie\b/.test(segment)) routes.push({ method, template });
    }
  }
  return routes;
}

function concretePath(template: string): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name === 'id' ? '1' : name === 'toolName' ? 'git.status' : `s54-${name.toLowerCase()}`));
}

async function enrolAndLoginWithRecoveryCode(baseUrl: string): Promise<{ sessionCookieHeader: string; csrfToken: string }> {
  const enrolResponse = await fetch(`${baseUrl}/auth/enrol`, {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: JSON.stringify({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
  });
  assert.equal(enrolResponse.status, 200);
  const { recoveryCodes } = (await enrolResponse.json()) as { recoveryCodes: string[] };

  const login = await fetch(`${baseUrl}/auth/login/recovery-code`, {
    method: 'POST',
    headers: { Origin: baseUrl },
    body: JSON.stringify({ subject: SUBJECT, password: PASSWORD, code: recoveryCodes[0] }),
  });
  assert.equal(login.status, 200);
  const setCookies = login.headers.getSetCookie();
  const session = cookieValue(setCookies, 'szg_session');
  const csrf = cookieValue(setCookies, 'szg_csrf');
  assert.ok(session && csrf);
  return { sessionCookieHeader: `szg_session=${session}; szg_csrf=${csrf}`, csrfToken: csrf };
}

async function requestRoute(baseUrl: string, route: CookieRoute, sessionCookieHeader: string, csrfToken: string): Promise<{ status: number; error: string | null }> {
  const response = await fetch(`${baseUrl}${concretePath(route.template)}`, {
    method: route.method,
    headers: { Cookie: sessionCookieHeader, Origin: baseUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    ...(route.method === 'GET' ? {} : { body: '{}' }),
    redirect: 'manual',
  });
  const text = await response.text();
  let error: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    error = typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    // Not every route answers JSON; only the gate's refusal needs to.
  }
  return { status: response.status, error };
}

async function reenrol(baseUrl: string, sessionCookieHeader: string, csrfToken: string): Promise<void> {
  const headers = { Cookie: sessionCookieHeader, Origin: baseUrl, 'X-CSRF-Token': csrfToken };
  const begin = await fetch(`${baseUrl}/auth/totp-reenrol/begin`, { method: 'POST', headers });
  assert.equal(begin.status, 200);
  const { totpSecret } = (await begin.json()) as { totpSecret: string };
  const totpCode = currentTotpCode(base32Decode(totpSecret), Date.parse(systemClock.now()) / 1000);
  const complete = await fetch(`${baseUrl}/auth/totp-reenrol/complete`, { method: 'POST', headers, body: JSON.stringify({ totpCode }) });
  assert.equal(complete.status, 200);
}

async function refusalRecords(volume: string): Promise<readonly AuditRecord[]> {
  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  try {
    const page = await audit.query({ declarationId: null, tool: null, actorSubject: null, form: 'totp-reenrol-refusal', from: null, to: null, limit: 1000, cursor: null });
    assert.ok(page.ok);
    return page.value.records;
  } finally {
    await audit.close();
  }
}

test('S54.1 — the contract names the four routes the re-enrolment gate leaves open among its cookie routes', () => {
  const routes = cookieRoutesFromContract().map((r) => `${r.method} ${r.template}`);
  for (const open of REENROL_GATE_OPEN) assert.ok(routes.includes(open), `${open} is a cookie route in the contract`);
  // 27 cookie-reachable routes: 4 the gate leaves open, 23 it refuses.
  assert.equal(routes.length, 27, routes.join('\n'));
});

test('S54.2 / S54.4 — a recovery-code session is refused on every cookie route outside the open four, with no side effect, audited once each', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    const calls: string[] = [];
    await withServer(
      volume,
      async (baseUrl) => {
        const { sessionCookieHeader, csrfToken } = await enrolAndLoginWithRecoveryCode(baseUrl);
        const gated = cookieRoutesFromContract().filter((r) => !REENROL_GATE_OPEN.has(`${r.method} ${r.template}`));
        assert.equal(gated.length, 23);

        calls.length = 0;
        for (const route of gated) {
          const answer = await requestRoute(baseUrl, route, sessionCookieHeader, csrfToken);
          assert.deepEqual(answer, { status: 403, error: 'totp-reenrol-required' }, `${route.method} ${route.template}`);
        }
        // Past the session check, nothing: no declaration, clone, dispatch, authorization or surface audit call.
        assert.deepEqual([...new Set(calls)].sort(), ['identity.refuseUntilReenrolled', 'identity.touch']);
        assert.equal(calls.filter((c) => c === 'identity.refuseUntilReenrolled').length, gated.length);

        const records = await refusalRecords(volume);
        assert.equal(records.length, gated.length, 'one record per refused request');
        assert.deepEqual(
          records.map((r) => (r as AuditRecord & { route: string }).route).sort(),
          gated.map((r) => `${r.method} ${concretePath(r.template)}`).sort(),
        );
        for (const record of records) {
          assert.deepEqual(record.actorRef, { kind: 'operator', subject: SUBJECT, clientId: null, grantId: null });
          assert.equal(record.declarationId, null);
          assert.equal(record.operationId, null);
        }
      },
      calls,
    );
  });
});

test('S54.1 — a gated session still reads /auth/session, which reports totpReenrolRequired, and is not audited for it', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const { sessionCookieHeader } = await enrolAndLoginWithRecoveryCode(baseUrl);
      const response = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: sessionCookieHeader } });
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { totpReenrolRequired: boolean }).totpReenrolRequired, true);
      assert.equal((await refusalRecords(volume)).length, 0);
    });
  });
});

test('S54.1 — a gated session can still log out', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const { sessionCookieHeader, csrfToken } = await enrolAndLoginWithRecoveryCode(baseUrl);
      const logout = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Cookie: sessionCookieHeader, Origin: baseUrl, 'X-CSRF-Token': csrfToken },
      });
      assert.equal(logout.status, 200);
    });
  });
});

test('S54.1 — the gate is on the cookie session only: a bearer token still reads /health while re-enrolment is pending', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      await enrolAndLoginWithRecoveryCode(baseUrl);
      const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${OPERATOR_API_TOKEN}` } });
      assert.equal(response.status, 200);
    });
  });
});

test('S54.3 — after re-enrolment the same session reaches every cookie route again without signing in twice', async () => {
  await withVolumeAsync(async (volume) => {
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    await withServer(volume, async (baseUrl) => {
      const { sessionCookieHeader, csrfToken } = await enrolAndLoginWithRecoveryCode(baseUrl);
      await reenrol(baseUrl, sessionCookieHeader, csrfToken);

      const gated = cookieRoutesFromContract().filter((r) => !REENROL_GATE_OPEN.has(`${r.method} ${r.template}`));
      for (const route of gated) {
        const answer = await requestRoute(baseUrl, route, sessionCookieHeader, csrfToken);
        assert.notEqual(answer.error, 'totp-reenrol-required', `${route.method} ${route.template} is no longer gated`);
        assert.notEqual(answer.status, 401, `${route.method} ${route.template} still accepts the same session`);
      }
      const session = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: sessionCookieHeader } });
      assert.equal(((await session.json()) as { totpReenrolRequired: boolean }).totpReenrolRequired, false);
      assert.equal((await refusalRecords(volume)).length, 0);
    });
  });
});
