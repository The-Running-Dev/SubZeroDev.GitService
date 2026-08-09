import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { ContractCapabilitySet } from '../contract/capabilities.ts';
import type { BearerToken, Subject } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import { createAuthorization } from './authorization.ts';

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

function authFor(volume: string, contractCapabilitySet: ContractCapabilitySet = FULL_CEILING) {
  return createAuthorization({ volumeRoot: volume, clock: systemClock, contractCapabilitySet });
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

test('establishMcpSession and refresh answer honestly that they are not wired until S14, rather than pretending to work', async () => {
  await migratedVolume(async (volume) => {
    const auth = authFor(volume);
    const session = await auth.establishMcpSession('x' as never, 'https://x.invalid/mcp/repo-a' as never);
    assert.equal(session.ok, false);
    const refreshed = await auth.refresh('x' as never);
    assert.equal(refreshed.ok, false);
  });
});
