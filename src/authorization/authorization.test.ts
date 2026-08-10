import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createAudit } from '../audit/audit.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { ContractCapabilitySet, DeploymentCeiling } from '../contract/capabilities.ts';
import type { BearerToken, RemoteHost, Subject } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import { createDeclarations, type Declarations } from '../declarations/declarations.ts';
import type { Declaration } from '../declarations/types.ts';
import { createAuthorization } from './authorization.ts';

const GITHUB_ALLOWLIST = ['github.com'] as unknown as readonly RemoteHost[];

const ACTOR: ActorRef = { kind: 'operator', subject: 'ben' as Subject, clientId: null, grantId: null };

const FULL_CEILING = new Set([
  'repo.read',
  'git.local.write',
  'git.remote.write',
  'git.raw',
  'host.pr.read',
  'host.pr.write',
  'host.checks.read',
  'scheduler.manage',
  'declaration.manage',
  'auth.manage',
  'audit.read',
  'attention.resolve',
]) as unknown as ContractCapabilitySet;

async function migratedVolume<T>(fn: (volume: string) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();
    return fn(volume);
  });
}

function declarationsFor(volume: string, ceiling: ContractCapabilitySet = FULL_CEILING): Declarations {
  return createDeclarations({
    volumeRoot: volume,
    clock: systemClock,
    remoteHostAllowlist: GITHUB_ALLOWLIST,
    ceiling: ceiling as unknown as DeploymentCeiling,
    cloneAdoptionCheck: () => ({
      observedRemote: async () => ({ cloneExists: false }),
      isSafeToAdopt: async () => ({ safe: true }),
    }),
  });
}

function authFor(volume: string, contractCapabilitySet: ContractCapabilitySet = FULL_CEILING, declarations: Declarations = declarationsFor(volume, contractCapabilitySet)) {
  return createAuthorization({
    volumeRoot: volume,
    clock: systemClock,
    contractCapabilitySet,
    ceiling: contractCapabilitySet as unknown as DeploymentCeiling,
    declarations,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
  });
}

/** Every `identity-event` the audit chain holds, in order. */
async function auditedEvents(volume: string): Promise<readonly string[]> {
  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  const page = await audit.query({
    declarationId: null,
    tool: null,
    actorSubject: null,
    form: 'identity-event',
    from: null,
    to: null,
    limit: 100,
    cursor: null,
  });
  await audit.close();
  if (!page.ok) return [];
  return page.value.records.map((record) => (record as { event?: string }).event ?? '');
}

/** Every row this test suite could see, across every table this module writes to — used by S13.3. */
function everyStoredValue(volume: string): readonly string[] {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  const values: string[] = [];
  for (const table of ['oauth_client', '"grant"', 'token']) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) for (const value of Object.values(row)) if (typeof value === 'string') values.push(value);
  }
  db.close();
  return values;
}

test('S13.2 — an operator API token authenticates, and a token that was never issued does not', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read', 'write'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const verified = await auth.verifyOperatorApiToken(issued.value.value);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.value.kind, 'operator');
    assert.equal(verified.value.actorRef.subject, 'ben');

    const bogus = await auth.verifyOperatorApiToken('not-a-real-token-value' as BearerToken);
    assert.equal(bogus.ok, false);
    if (bogus.ok) return;
    assert.equal(bogus.error.code, 'token-unknown');
  });
});

test("S13.1 — a scoped token's session grant carries only its own scope's capabilities, intersected with the deployment ceiling", async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const verified = await auth.verifyOperatorApiToken(issued.value.value);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    const grant = verified.value.grant as unknown as ReadonlySet<string>;
    assert.equal(grant.has('repo.read'), true);
    assert.equal(grant.has('git.raw'), false, "a 'read'-only token must not carry 'raw' capability");
    assert.equal(grant.has('git.local.write'), false, "a 'read'-only token must not carry 'write' capability");
  });
});

test('S13.3 — the raw token value exists only in the returned IssuedToken; no stored row contains it', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const stored = everyStoredValue(volume);
    assert.equal(
      stored.some((value) => value === issued.value.value),
      false,
      'the raw bearer value must never appear in a stored row',
    );

    // The value returned once is still the one that authenticates — proves
    // the scan above was not merely failing to find a hash by coincidence.
    const verified = await auth.verifyOperatorApiToken(issued.value.value);
    assert.equal(verified.ok, true);
  });
});

test('S13.4 — verification runs through the constant-time comparison, and a near-miss hash fails exactly like a wholly wrong one', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    // One character flipped at the very end, and one flipped at the very
    // start — both must fail identically (`token-unknown`), which is what
    // the shared `timingSafeStringEqual` helper (`shared/timing-safe.ts`,
    // documented for exactly this call site) guarantees: it always hashes
    // both operands to a fixed 32-byte digest and compares those, so where
    // in the input two values first differ never reaches the comparison.
    const raw = issued.value.value as string;
    const flippedAtEnd = (raw.slice(0, -1) + (raw.at(-1) === '0' ? '1' : '0')) as BearerToken;
    const flippedAtStart = ((raw[0] === '0' ? '1' : '0') + raw.slice(1)) as BearerToken;

    const first = await auth.verifyOperatorApiToken(flippedAtEnd);
    const second = await auth.verifyOperatorApiToken(flippedAtStart);
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    if (first.ok || second.ok) return;
    assert.equal(first.error.code, 'token-unknown');
    assert.equal(second.error.code, 'token-unknown');
  });
});

test('S13.5 — a token survives a process restart and continues to authenticate', async () => {
  await migratedVolume(async (volume) => {
    const first = authFor(volume);
    const issued = await first.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    // A fresh `Authorization` instance stands in for the restart — nothing
    // about the module holds state outside the store it just wrote to.
    const second = authFor(volume);
    const verified = await second.verifyOperatorApiToken(issued.value.value);
    assert.equal(verified.ok, true);
  });
});

test("S13.6 — revoking a client kills its grants and their tokens without writing to those rows", async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const registered = await auth.registerClient({ redirectUris: ['https://example.invalid/callback' as never], clientName: 'test-client' });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;

    // No MCP grant-creation path exists yet (S14) — a grant naming this
    // client is written directly against the store, the way the real one
    // would land once S14 calls `establishMcpSession`. This exercises the
    // cascade `revokeClient` owns, independent of how the grant arrived.
    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const grantId = 'grant-1';
    db.prepare(
      `INSERT INTO "grant" (grant_id, kind, client_id, subject, resource, declaration_id, generation, scopes, created_at, last_used_at, revoked_at)
       VALUES (?, 'mcp', ?, 'ben', 'https://x.invalid/mcp/repo-a', 'repo-a', 1, '["read"]', ?, NULL, NULL)`,
    ).run(grantId, registered.value.clientId, systemClock.now());
    const tokenJti = 'token-1';
    db.prepare(
      `INSERT INTO token (jti, grant_id, kind, verifier_hash, issued_at, expires_at, revoked_at) VALUES (?, ?, 'access', 'deadbeef', ?, '2099-01-01T00:00:00.000Z', NULL)`,
    ).run(tokenJti, grantId, systemClock.now());
    db.close();

    assert.equal(await auth.grantIsLive(grantId as never), true, 'live before the client is revoked');

    const revoked = await auth.revokeClient(registered.value.clientId, ACTOR);
    assert.equal(revoked.ok, true);

    assert.equal(await auth.grantIsLive(grantId as never), false, 'dead after the client is revoked, via the cascade');

    const after = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const grantRow = after.prepare('SELECT revoked_at FROM "grant" WHERE grant_id = ?').get(grantId) as { revoked_at: string | null };
    const tokenRow = after.prepare('SELECT revoked_at FROM token WHERE jti = ?').get(tokenJti) as { revoked_at: string | null };
    after.close();
    assert.equal(grantRow.revoked_at, null, "the grant's own row is untouched — only the client's revoked_at moved");
    assert.equal(tokenRow.revoked_at, null, "the token's own row is untouched — grantIsLive walks upward at check time");
  });
});

test('S13.7 — revocation is never a delete: after revoking a client, a grant and a token, all three rows remain', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const registered = await auth.registerClient({ redirectUris: ['https://example.invalid/callback' as never], clientName: 'test-client' });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;
    const clientRevoked = await auth.revokeClient(registered.value.clientId, ACTOR);
    assert.equal(clientRevoked.ok, true);

    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const grants = await auth.listGrants('operator-api');
    const grantId = grants[0]!.grant.grantId;
    const grantRevoked = await auth.revokeGrant(grantId, ACTOR);
    assert.equal(grantRevoked.ok, true);
    const tokenRevoked = await auth.revokeToken(issued.value.jti, ACTOR);
    assert.equal(tokenRevoked.ok, true);

    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const client = db.prepare('SELECT * FROM oauth_client WHERE client_id = ?').get(registered.value.clientId);
    const grant = db.prepare('SELECT * FROM "grant" WHERE grant_id = ?').get(grantId);
    const token = db.prepare('SELECT * FROM token WHERE jti = ?').get(issued.value.jti);
    db.close();
    assert.notEqual(client, undefined, "the client row remains after revocation — it can still answer 'what did that client have'");
    assert.notEqual(grant, undefined, 'the grant row remains after revocation');
    assert.notEqual(token, undefined, 'the token row remains after revocation');

    // Revoking twice is idempotent, not an error — the second call finds an
    // already-revoked row rather than a missing one.
    const revokedAgain = await auth.revokeClient(registered.value.clientId, ACTOR);
    assert.equal(revokedAgain.ok, true);
  });
});

test('S13.8 — the grants view lists clients, grants and tokens, with counts, and revokes any of them', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issuedA = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issuedA.ok, true);
    if (!issuedA.ok) return;

    const beforeList = await auth.listGrants('operator-api');
    assert.equal(beforeList.length, 1);
    assert.equal(beforeList[0]!.grant.kind, 'operator-api');
    assert.equal(beforeList[0]!.client, null, 'operator-api grants carry no client');
    assert.equal(beforeList[0]!.activeTokens, 1);

    const revoked = await auth.revokeToken(issuedA.value.jti, ACTOR);
    assert.equal(revoked.ok, true);

    const afterList = await auth.listGrants('operator-api');
    assert.equal(afterList[0]!.activeTokens, 0, 'a revoked token no longer counts as active');

    const verified = await auth.verifyOperatorApiToken(issuedA.value.value);
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.error.code, 'token-revoked');
  });
});

test('no operator-api token reaches an instance-level capability, whatever scopes it is issued with', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    // Every scope at once — the widest token this interface can issue.
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read', 'write', 'raw', 'schedule'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const verified = await auth.verifyOperatorApiToken(issued.value.value);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    const grant = verified.value.grant as unknown as ReadonlySet<string>;

    // `20-contract.md` § Scopes: "no `OperatorScope` value names them, and no
    // operator-api token can exercise them". The ceiling here is FULL_CEILING,
    // so nothing but the scope map itself is keeping them out.
    for (const consoleOnly of ['declaration.manage', 'auth.manage', 'audit.read', 'attention.resolve']) {
      assert.equal(grant.has(consoleOnly), false, `'${consoleOnly}' is console-only and must never appear in an operator-api grant`);
    }
    assert.equal(grant.has('repo.read'), true, 'the declaration-scoped capabilities still arrive');
    assert.equal(grant.has('git.raw'), true);
    assert.equal(grant.has('scheduler.manage'), true);
  });
});

test('issuing and revoking a credential each leave an audit line naming the operator who did it', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const grants = await auth.listGrants('operator-api');
    await auth.revokeToken(issued.value.jti, ACTOR);
    await auth.revokeGrant(grants[0]!.grant.grantId, ACTOR);

    assert.deepEqual(await auditedEvents(volume), ['token-issued', 'token-revoked', 'grant-revoked']);
  });
});

test('a failed revocation writes no audit line — the chain records what happened, not what was attempted', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const revoked = await auth.revokeGrant('no-such-grant' as never, ACTOR);
    assert.equal(revoked.ok, false);
    assert.deepEqual(await auditedEvents(volume), []);
  });
});

test('activeTokens counts only tokens that would actually authenticate — an expired one does not', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    assert.equal((await auth.listGrants('operator-api'))[0]!.activeTokens, 1);

    // Backdate the expiry rather than wait a year. The verification path
    // rejects this token from here on, so a view still calling it active
    // would be reporting a credential that cannot be used.
    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    db.prepare('UPDATE token SET expires_at = ? WHERE jti = ?').run('2000-01-01T00:00:00.000Z', issued.value.jti);
    db.close();

    const verified = await auth.verifyOperatorApiToken(issued.value.value);
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.error.code, 'token-expired');
    assert.equal((await auth.listGrants('operator-api'))[0]!.activeTokens, 0, 'an expired token is not an active one');
  });
});

test('revoking a grant zeroes its active token count, so the view can confirm the revocation took', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const grantId = (await auth.listGrants('operator-api'))[0]!.grant.grantId;
    assert.equal(await auth.revokeGrant(grantId, ACTOR).then((r) => r.ok), true);

    const after = await auth.listGrants('operator-api');
    assert.equal(after[0]!.activeTokens, 0, "the token's own row is untouched, but nothing under a revoked grant is active");
  });
});

test('grantIsLive answers false for a grant that never existed, rather than throwing', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    assert.equal(await auth.grantIsLive('no-such-grant' as never), false);
  });
});

test('registerClient rejects an empty redirect-URI list and a non-https one, both counted', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const empty = await auth.registerClient({ redirectUris: [], clientName: 'x' });
    assert.equal(empty.ok, false);
    if (empty.ok) return;
    assert.equal(empty.error.code, 'registration-invalid');

    const insecure = await auth.registerClient({ redirectUris: ['http://example.invalid/callback' as never], clientName: 'x' });
    assert.equal(insecure.ok, false);
    if (insecure.ok) return;
    assert.equal(insecure.error.code, 'registration-invalid');
    if (insecure.error.code !== 'registration-invalid') return;
    assert.equal(insecure.error.findings.length, 1);
  });
});

test('getClient returns the registered client by id, and null for an unknown or made-up id', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const registered = await auth.registerClient({ redirectUris: ['https://example.invalid/callback' as never], clientName: 'x' });
    assert.equal(registered.ok, true);
    if (!registered.ok) return;

    const found = await auth.getClient(registered.value.clientId);
    assert.ok(found);
    assert.equal(found?.clientId, registered.value.clientId);
    assert.deepEqual(found?.redirectUris, registered.value.redirectUris);

    const missing = await auth.getClient('no-such-client' as never);
    assert.equal(missing, null);
  });
});

async function declaredRepo(declarations: Declarations, id: string, capabilityGrant: readonly string[], host: 'generic' | 'github' = 'generic'): Promise<Declaration> {
  const declared = await declarations.declare(
    {
      id: id as never,
      cloneUrl: `https://github.com/acme/${id}.git` as never,
      host,
      credentialRef: 'unused' as never,
      capabilityGrant: capabilityGrant as never,
      writablePathPrefixes: [],
      pinned: false,
      contentDrop: null,
      identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
    },
    ACTOR,
  );
  assert.equal(declared.ok, true, declared.ok ? '' : declared.error.summary);
  if (!declared.ok) throw new Error('unreachable: asserted ok above');
  return declared.value;
}

/** `grant.client_id` is a real foreign key onto `oauth_client` — `issueMcpGrant` needs a client that actually went through `registerClient`, not a literal string. */
async function registeredClient(auth: ReturnType<typeof authFor>): Promise<{ readonly clientId: never; readonly subject: never }> {
  const registered = await auth.registerClient({ redirectUris: ['https://client.invalid/callback' as never], clientName: 'test client' });
  assert.equal(registered.ok, true, registered.ok ? '' : registered.error.summary);
  if (!registered.ok) throw new Error('unreachable: asserted ok above');
  return { clientId: registered.value.clientId as never, subject: registered.value.clientId as never };
}

test('S14.7 (module half) — issueMcpGrant mints a durable grant, and its refresh token survives a simulated process restart', async () => {
  await migratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const repo = await declaredRepo(declarations, 'repo-mcp', ['repo.read', 'git.raw']);

    const auth = authFor(volume, FULL_CEILING, declarations);
    const client = await registeredClient(auth);
    const issued = await auth.issueMcpGrant(
      { clientId: client.clientId, subject: client.subject, resource: `/mcp/${repo.id}` as never, declarationId: repo.id, generation: repo.generation, scopes: ['read', 'raw'] },
      ACTOR,
    );
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    assert.equal(issued.value.grant.kind, 'mcp');

    // A fresh module instance against the same volume — the same standard
    // this repo already applies to S13.5 ("a token survives a process
    // restart"), just for the refresh token half of S14.7.
    const restarted = authFor(volume, FULL_CEILING, declarations);
    const refreshed = await restarted.refresh(issued.value.refresh.value);
    assert.equal(refreshed.ok, true, refreshed.ok ? '' : refreshed.error.summary);
    if (!refreshed.ok) return;
    assert.notEqual(refreshed.value.access.value, issued.value.access.value, 'refresh rotates, it does not replay the same access token');

    // The original refresh token is now single-use and spent.
    const replay = await restarted.refresh(issued.value.refresh.value);
    assert.equal(replay.ok, false);
  });
});

test('S14.1 — establishMcpSession refuses a token whose grant is for a different resource, naming the expected one', async () => {
  await migratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const repoA = await declaredRepo(declarations, 'repo-a-aud', ['repo.read']);
    const repoB = await declaredRepo(declarations, 'repo-b-aud', ['repo.read']);
    const auth = authFor(volume, FULL_CEILING, declarations);
    const client = await registeredClient(auth);

    const issued = await auth.issueMcpGrant(
      { clientId: client.clientId, subject: client.subject, resource: `/mcp/${repoA.id}` as never, declarationId: repoA.id, generation: repoA.generation, scopes: ['read'] },
      ACTOR,
    );
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const wrongAudience = await auth.establishMcpSession(issued.value.access.value, `/mcp/${repoB.id}` as never);
    assert.equal(wrongAudience.ok, false);
    if (wrongAudience.ok) return;
    assert.equal(wrongAudience.error.code, 'audience-mismatch');
    if (wrongAudience.error.code !== 'audience-mismatch') return;
    assert.equal(wrongAudience.error.expected, `/mcp/${repoA.id}`);

    const rightAudience = await auth.establishMcpSession(issued.value.access.value, `/mcp/${repoA.id}` as never);
    assert.equal(rightAudience.ok, true);
  });
});

test('S14.8 — no scope, however wide, ever expands an MCP session grant to an instance-scoped capability', async () => {
  await migratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const repo = await declaredRepo(declarations, 'repo-instance-scope', ['repo.read', 'git.local.write', 'git.remote.write', 'git.raw', 'host.pr.read', 'host.pr.write', 'host.checks.read', 'scheduler.manage'], 'github');
    const auth = authFor(volume, FULL_CEILING, declarations);
    const client = await registeredClient(auth);

    const issued = await auth.issueMcpGrant(
      { clientId: client.clientId, subject: client.subject, resource: `/mcp/${repo.id}` as never, declarationId: repo.id, generation: repo.generation, scopes: ['read', 'write', 'raw', 'schedule'] },
      ACTOR,
    );
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const session = await auth.establishMcpSession(issued.value.access.value, `/mcp/${repo.id}` as never);
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const grant = session.value.grant as unknown as ReadonlySet<string>;
    for (const consoleOnly of ['declaration.manage', 'auth.manage', 'audit.read', 'attention.resolve']) {
      assert.equal(grant.has(consoleOnly), false, `'${consoleOnly}' must never reach an MCP session, whatever scopes it was issued with`);
    }
    assert.equal(grant.has('git.raw'), true, 'the declaration-scoped capabilities still arrive');
  });
});

test('recomputeSessionGrant only ever narrows a live MCP session, never widens it — both directions asserted', async () => {
  await migratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const repo = await declaredRepo(declarations, 'repo-epoch', ['repo.read']);
    const auth = authFor(volume, FULL_CEILING, declarations);
    const client = await registeredClient(auth);

    const issued = await auth.issueMcpGrant(
      { clientId: client.clientId, subject: client.subject, resource: `/mcp/${repo.id}` as never, declarationId: repo.id, generation: repo.generation, scopes: ['read', 'raw'] },
      ACTOR,
    );
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const established = await auth.establishMcpSession(issued.value.access.value, `/mcp/${repo.id}` as never);
    assert.equal(established.ok, true);
    if (!established.ok) return;
    const originalGrant = established.value.grant as unknown as ReadonlySet<string>;
    assert.equal(originalGrant.has('git.raw'), false, 'the declaration never carried git.raw, so the session never could either');

    // Narrow: repo.read is removed from the declaration.
    const narrowed = await declarations.amend(repo.id, { cloneUrl: null, credentialRef: null, capabilityGrant: [], writablePathPrefixes: null, pinned: null, contentDrop: undefined, identity: null }, ACTOR);
    assert.equal(narrowed.ok, true);
    if (!narrowed.ok) return;
    const afterNarrow = auth.recomputeSessionGrant(established.value, narrowed.value);
    assert.equal(afterNarrow.ok, true);
    if (!afterNarrow.ok) return;
    assert.equal((afterNarrow.value.grant as unknown as ReadonlySet<string>).has('repo.read'), false, 'S14.4: narrowing the declaration reaches the live session');

    // Widen: repo.read *and* git.raw are both granted back.
    const widened = await declarations.amend(repo.id, { cloneUrl: null, credentialRef: null, capabilityGrant: ['repo.read', 'git.raw'], writablePathPrefixes: null, pinned: null, contentDrop: undefined, identity: null }, ACTOR);
    assert.equal(widened.ok, true);
    if (!widened.ok) return;
    const afterWiden = auth.recomputeSessionGrant(established.value, widened.value);
    assert.equal(afterWiden.ok, true);
    if (!afterWiden.ok) return;
    assert.equal((afterWiden.value.grant as unknown as ReadonlySet<string>).has('git.raw'), false, 'S14.5: widening the declaration does not reach the frozen session — recomputed against the *original* session.grant, which never had git.raw');
    assert.equal(afterWiden.value.frozenAtEpoch, widened.value.grantEpoch, 'the frozen epoch still advances to the current one, even though the grant itself stayed narrow');
  });
});

test('S14.6 (module half) — revoking a grant makes establishMcpSession refuse it, naming grant-revoked', async () => {
  await migratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const repo = await declaredRepo(declarations, 'repo-revoke', ['repo.read']);
    const auth = authFor(volume, FULL_CEILING, declarations);
    const client = await registeredClient(auth);

    const issued = await auth.issueMcpGrant(
      { clientId: client.clientId, subject: client.subject, resource: `/mcp/${repo.id}` as never, declarationId: repo.id, generation: repo.generation, scopes: ['read'] },
      ACTOR,
    );
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    await auth.revokeGrant(issued.value.grant.grantId, ACTOR);
    const refused = await auth.establishMcpSession(issued.value.access.value, `/mcp/${repo.id}` as never);
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, 'grant-revoked');

    assert.equal(await auth.grantIsLive(issued.value.grant.grantId), false);
  });
});

test('revokeGrantsForResource revokes every grant for a declaration and generation, and reports which', async () => {
  await migratedVolume(async (volume) => {
    const declarations = declarationsFor(volume);
    const repo = await declaredRepo(declarations, 'repo-cascade', ['repo.read']);
    const auth = authFor(volume, FULL_CEILING, declarations);
    const clientA = await registeredClient(auth);
    const clientB = await registeredClient(auth);
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();

    const issuedA = await auth.issueMcpGrant({ clientId: clientA.clientId, subject: clientA.subject, resource: `/mcp/${repo.id}` as never, declarationId: repo.id, generation: repo.generation, scopes: ['read'] }, ACTOR);
    const issuedB = await auth.issueMcpGrant({ clientId: clientB.clientId, subject: clientB.subject, resource: `/mcp/${repo.id}` as never, declarationId: repo.id, generation: repo.generation, scopes: ['read'] }, ACTOR);
    assert.equal(issuedA.ok, true);
    assert.equal(issuedB.ok, true);
    if (!issuedA.ok || !issuedB.ok) return;

    const revoked = await store.transaction(async (tx) => auth.revokeGrantsForResource(repo.id, repo.generation, tx));
    assert.equal(revoked.ok, true);
    if (!revoked.ok) return;
    assert.equal(revoked.value.length, 2);
    assert.ok(revoked.value.includes(issuedA.value.grant.grantId));
    assert.ok(revoked.value.includes(issuedB.value.grant.grantId));
    assert.equal(await auth.grantIsLive(issuedA.value.grant.grantId), false);
    assert.equal(await auth.grantIsLive(issuedB.value.grant.grantId), false);

    await store.close();
  });
});

test('revokeBearerToken resolves the presented value to its token and revokes it, and is idempotent on an unknown value', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const issued = await auth.issueOperatorApiToken('ben' as Subject, ['read'], ACTOR);
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const revoked = await auth.revokeBearerToken(issued.value.value, ACTOR);
    assert.equal(revoked.ok, true);
    const verified = await auth.verifyOperatorApiToken(issued.value.value);
    assert.equal(verified.ok, false);
    if (verified.ok) return;
    assert.equal(verified.error.code, 'token-revoked');

    // An unknown value is not an error — RFC 7009's own idempotence rule.
    const unknown = await auth.revokeBearerToken('never-issued' as never, ACTOR);
    assert.equal(unknown.ok, true);
  });
});
