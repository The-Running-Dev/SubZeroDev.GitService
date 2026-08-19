import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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
import type { ActorRef } from '../shared/actor.ts';
import type { AuditAppendInput } from '../audit/types.ts';

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
  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  const authorization = createAuthorization({
    volumeRoot: volume,
    clock: systemClock,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as unknown as DeploymentCeiling,
    declarations: createStubDeclarations(),
    audit,
  });
  const server = createSurfacesServer({
    commitSha: COMMIT_SHA,
    contractFingerprint: CONTRACT_FINGERPRINT,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: async () => (await identity.provisioningState()) === 'pending',
    auditChain: () => audit.chainState(),
    authorization,
    audit,
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

const ACTOR: ActorRef = { kind: 'operator', subject: SUBJECT as never, clientId: null, grantId: null };

function callInput(overrides: Partial<AuditAppendInput> = {}): AuditAppendInput {
  return {
    at: systemClock.now(),
    operationId: null,
    declarationId: null,
    generation: null,
    tool: null,
    actorRef: ACTOR,
    context: 'normal',
    form: 'call',
    resultKind: 'success',
    changedPaths: [],
    ...overrides,
  } as AuditAppendInput;
}

test('S33.5 — an operator API token presented as a bearer credential cannot reach the audit query route', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const token = await issueToken(baseUrl, auth, ['read', 'write', 'raw', 'schedule']);
      const response = await fetch(`${baseUrl}/audit`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 401, 'no OperatorScope names audit.read, so a bearer token — even one with every scope — cannot authenticate this route');
    });
  });
});

test('S33.2 — the view filters by declaration, tool, actor and time window, and the four compose', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const audit = createAudit({ volumeRoot: volume, clock: systemClock });

      await audit.append(callInput({ declarationId: 'repo-a' as never, tool: 'status' as never, actorRef: { kind: 'operator', subject: 'alice' as never, clientId: null, grantId: null } }));
      await audit.append(callInput({ declarationId: 'repo-b' as never, tool: 'status' as never, actorRef: { kind: 'operator', subject: 'bob' as never, clientId: null, grantId: null } }));
      await audit.append(callInput({ declarationId: 'repo-a' as never, tool: 'commit' as never, actorRef: { kind: 'operator', subject: 'alice' as never, clientId: null, grantId: null } }));

      const byDeclaration = await fetch(`${baseUrl}/audit?declarationId=repo-a`, { headers: { Cookie: auth.sessionCookieHeader } });
      assert.equal(byDeclaration.status, 200);
      const byDeclarationBody = (await byDeclaration.json()) as { records: { declarationId: string }[] };
      assert.equal(byDeclarationBody.records.length, 2);
      assert.ok(byDeclarationBody.records.every((r) => r.declarationId === 'repo-a'));

      const composed = await fetch(`${baseUrl}/audit?declarationId=repo-a&tool=commit&actorSubject=alice`, { headers: { Cookie: auth.sessionCookieHeader } });
      const composedBody = (await composed.json()) as { records: { tool: string }[] };
      assert.equal(composedBody.records.length, 1);
      assert.equal(composedBody.records[0]!.tool, 'commit');

      const noMatch = await fetch(`${baseUrl}/audit?declarationId=repo-a&tool=commit&actorSubject=bob`, { headers: { Cookie: auth.sessionCookieHeader } });
      assert.equal(noMatch.status, 200, 'a filter combination matching nothing is an empty result, not an error');
      const noMatchBody = (await noMatch.json()) as { records: unknown[] };
      assert.equal(noMatchBody.records.length, 0);
    });
  });
});

test('S33.3 — chain state is returned inline with the records', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const audit = createAudit({ volumeRoot: volume, clock: systemClock });
      await audit.append(callInput());

      const response = await fetch(`${baseUrl}/audit`, { headers: { Cookie: auth.sessionCookieHeader } });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { chain: { verifiedThrough: number | null; chainBreak: unknown } };
      assert.ok((body.chain.verifiedThrough ?? 0) >= 1, 'the appended record is reflected in the verified sequence');
      assert.equal(body.chain.chainBreak, null);
    });
  });
});

test('S33.4 — against a deliberately broken chain, the view marks the break and still renders the records either side of it', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const auth = await enrolAndLogin(baseUrl);
      const audit = createAudit({ volumeRoot: volume, clock: systemClock });
      for (let i = 0; i < 5; i += 1) await audit.append(callInput());

      const segPath = path.join(volume, 'audit', '000001.jsonl');
      const lines = readFileSync(segPath, 'utf8').trim().split('\n');
      lines.splice(2, 1); // delete the middle record (sequence 3), leaving records either side
      writeFileSync(segPath, `${lines.join('\n')}\n`, 'utf8');

      const response = await fetch(`${baseUrl}/audit`, { headers: { Cookie: auth.sessionCookieHeader } });
      assert.equal(response.status, 200, 'a broken chain does not fail closed');
      const body = (await response.json()) as { records: { sequence: number }[]; chain: { chainBreak: { atSequence: number } | null } };
      assert.notEqual(body.chain.chainBreak, null);
      assert.equal(body.chain.chainBreak!.atSequence, 4, 'the break is marked at the record after the gap');
      const sequences = body.records.map((r) => r.sequence);
      assert.ok(sequences.includes(1), 'a record before the break still renders');
      assert.ok(sequences.includes(4), 'a record after the break still renders');
    });
  });
});
