import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createAudit, type Audit } from '../audit/audit.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { SessionId, Subject } from '../shared/brands.ts';
import { base32Decode, currentTotpCode } from './totp.ts';
import { startOidcIssuerFixture } from './testing/oidc-issuer-fixture.ts';
import {
  createOperatorIdentity,
  TOTP_SEALING_KEY_FILENAME,
  writeBreakGlassToken,
  writeProvisioningSecret,
  type OperatorIdentity,
  type OperatorIdentityDependencies,
} from './operator-identity.ts';

const SUBJECT = 'operator' as Subject;
const PASSWORD = 'correct horse battery staple';
const PROVISIONING_SECRET = 'bootstrap-secret-value';

interface Rig {
  readonly volume: string;
  readonly credentialMount: string;
  readonly audit: Audit;
  readonly identity: OperatorIdentity;
}

function setUpMount(credentialMount: string): void {
  mkdirSync(credentialMount, { recursive: true });
  writeFileSync(path.join(credentialMount, TOTP_SEALING_KEY_FILENAME), randomBytes(32));
}

async function rigIn(volume: string, overrides: Partial<OperatorIdentityDependencies> = {}): Promise<Rig> {
  const credentialMount = path.join(volume, '_credential-mount');
  setUpMount(credentialMount);

  // `OperatorIdentity` opens its own connection per call against tables this
  // slice does not own the creation of — the schema has to exist first, the
  // same way it would after boot's own migration step.
  const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();

  const audit = createAudit({ volumeRoot: volume, clock: systemClock });
  const identity = createOperatorIdentity({ volumeRoot: volume, credentialMountRoot: credentialMount, clock: systemClock, audit, ...overrides });
  return { volume, credentialMount, audit, identity };
}

async function identityEvents(rig: Rig): Promise<readonly string[]> {
  const page = await rig.audit.query({
    declarationId: null,
    tool: null,
    actorSubject: null,
    form: 'identity-event',
    from: null,
    to: null,
    limit: 50,
    cursor: null,
  });
  assert.equal(page.ok, true);
  if (!page.ok) return [];
  return page.value.records.map((r) => (r as unknown as { event: string }).event);
}

async function enrolled(rig: Rig): Promise<{ totpSecretBytes: Buffer; recoveryCodes: readonly string[] }> {
  writeProvisioningSecret(rig.volume, PROVISIONING_SECRET);
  const result = await rig.identity.enrol({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return { totpSecretBytes: base32Decode(result.value.totpSecret), recoveryCodes: result.value.recoveryCodes };
}

test('provisioningState is pending before enrolment and complete after', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    assert.equal(await rig.identity.provisioningState(), 'pending');
    await enrolled(rig);
    assert.equal(await rig.identity.provisioningState(), 'complete');
  });
});

test('S4.2 — enrolment with the wrong secret answers provisioning-secret-invalid and does not burn the file', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    writeProvisioningSecret(volume, PROVISIONING_SECRET);

    const wrong = await rig.identity.enrol({ provisioningSecret: 'not-the-secret', subject: SUBJECT, password: PASSWORD });
    assert.equal(wrong.ok, false);
    if (wrong.ok) return;
    assert.equal(wrong.error.code, 'provisioning-secret-invalid');
    assert.equal(await rig.identity.provisioningState(), 'pending', 'the wrong attempt did not provision anything');

    // The file must still be there and still correct — proven by a
    // subsequent enrolment with the right secret succeeding.
    const right = await rig.identity.enrol({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD });
    assert.equal(right.ok, true, 'the file was not burned by the wrong attempt');
  });
});

test('S4.2 — enrolment with the correct secret sets the password, enrols TOTP, returns exactly ten recovery codes once, and burns the file', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    writeProvisioningSecret(volume, PROVISIONING_SECRET);

    const result = await rig.identity.enrol({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.recoveryCodes.length, 10);
    assert.ok(result.value.totpSecret.length > 0);

    assert.equal(await rig.identity.provisioningState(), 'complete');

    const page = await rig.audit.query({
      declarationId: null,
      tool: null,
      actorSubject: null,
      form: 'identity-event',
      from: null,
      to: null,
      limit: 10,
      cursor: null,
    });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    assert.equal(page.value.records.length, 1);
    assert.equal((page.value.records[0] as unknown as { event: string }).event, 'enrolment');
  });
});

test('S4.2 — a second enrolment attempt answers already-provisioned', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    await enrolled(rig);

    // A fresh provisioning file — irrelevant now that a credential exists.
    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    const second = await rig.identity.enrol({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error.code, 'already-provisioned');
  });
});

test('two concurrent enrolments racing the same provisioning secret: exactly one wins, and the loser answers already-provisioned', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    writeProvisioningSecret(volume, PROVISIONING_SECRET);

    const [a, b] = await Promise.all([
      rig.identity.enrol({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
      rig.identity.enrol({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD }),
    ]);
    const results = [a, b];
    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one enrolment succeeds');
    const loser = results.find((r) => !r.ok);
    assert.ok(loser);
    if (!loser || loser.ok) return;
    assert.equal(loser.error.code, 'already-provisioned', 'the race loser gets the same answer a later caller would, not a bare store failure');
  });
});

test('S4.3 — login with a correct password and no TOTP code fails; TOTP is never optional', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    await enrolled(rig);

    const attempt = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: '' });
    assert.equal(attempt.ok, false);
    if (attempt.ok) return;
    assert.equal(attempt.error.code, 'totp-invalid');
  });
});

test('a correct password and a correct TOTP code log in', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    const { totpSecretBytes } = await enrolled(rig);

    const code = currentTotpCode(totpSecretBytes, Date.parse(systemClock.now()) / 1000);
    const result = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: code });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.subject, SUBJECT);
    assert.equal(result.value.revokedAt, null);
  });
});

test('a wrong password fails with credentials-invalid, regardless of TOTP', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    const { totpSecretBytes } = await enrolled(rig);
    const code = currentTotpCode(totpSecretBytes, Date.parse(systemClock.now()) / 1000);

    const result = await rig.identity.loginLocal({ subject: SUBJECT, password: 'wrong password entirely', totpCode: code });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'credentials-invalid');
  });
});

test('S4.4 — a recovery code authenticates once, the same code again answers recovery-code-used, and a successful use is audited and forces re-enrolment', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    const { recoveryCodes } = await enrolled(rig);
    const code = recoveryCodes[0]!;

    const first = await rig.identity.loginWithRecoveryCode(SUBJECT, PASSWORD, code);
    assert.equal(first.ok, true, 'the first use authenticates');

    const second = await rig.identity.loginWithRecoveryCode(SUBJECT, PASSWORD, code);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error.code, 'recovery-code-used');

    const page = await rig.audit.query({
      declarationId: null,
      tool: null,
      actorSubject: null,
      form: 'identity-event',
      from: null,
      to: null,
      limit: 10,
      cursor: null,
    });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const events = page.value.records.map((r) => (r as unknown as { event: string }).event);
    assert.deepEqual(events.sort(), ['enrolment', 'recovery-code-used']);
  });
});

test('an unknown recovery code answers recovery-code-invalid, distinct from recovery-code-used', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    await enrolled(rig);

    const result = await rig.identity.loginWithRecoveryCode(SUBJECT, PASSWORD, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'recovery-code-invalid');
  });
});

test('S4.5 — a break-glass token authenticates once, is audited, and does not work twice — with no TOTP device and no recovery codes left', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    const { recoveryCodes } = await enrolled(rig);

    // Burn every recovery code, so break-glass is proven to need none of them.
    for (const code of recoveryCodes) {
      const used = await rig.identity.loginWithRecoveryCode(SUBJECT, PASSWORD, code);
      assert.equal(used.ok, true);
    }

    writeBreakGlassToken(volume, 'break-glass-value');
    const first = await rig.identity.loginWithBreakGlass('break-glass-value');
    assert.equal(first.ok, true, 'authenticates with no TOTP code and no live recovery codes');

    const second = await rig.identity.loginWithBreakGlass('break-glass-value');
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.error.code, 'break-glass-invalid');

    const page = await rig.audit.query({
      declarationId: null,
      tool: null,
      actorSubject: null,
      form: 'identity-event',
      from: null,
      to: null,
      limit: 20,
      cursor: null,
    });
    assert.equal(page.ok, true);
    if (!page.ok) return;
    const events = page.value.records.map((r) => (r as unknown as { event: string }).event);
    assert.ok(events.includes('break-glass-used'));
  });
});

test('a wrong break-glass token is rejected and does not consume the real one', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    await enrolled(rig);
    writeBreakGlassToken(volume, 'the-real-token');

    const wrong = await rig.identity.loginWithBreakGlass('a-guess');
    assert.equal(wrong.ok, false);

    const right = await rig.identity.loginWithBreakGlass('the-real-token');
    assert.equal(right.ok, true, 'the real token still works after a wrong guess');
  });
});

test('two concurrent break-glass attempts with the correct token: exactly one succeeds', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    await enrolled(rig);
    writeBreakGlassToken(volume, 'the-real-token');

    const [a, b] = await Promise.all([
      rig.identity.loginWithBreakGlass('the-real-token'),
      rig.identity.loginWithBreakGlass('the-real-token'),
    ]);
    const successes = [a, b].filter((r) => r.ok).length;
    assert.equal(successes, 1, 'a single-use token grants exactly one session under concurrent use, never two');
  });
});

test('S4.6 — a session survives a process restart', async () => {
  await withVolumeAsync(async (volume) => {
    const rigA = await rigIn(volume);
    const { totpSecretBytes } = await enrolled(rigA);
    const code = currentTotpCode(totpSecretBytes, Date.parse(systemClock.now()) / 1000);
    const login = await rigA.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: code });
    assert.equal(login.ok, true);
    if (!login.ok) return;

    // A second, independent module instance against the same volume —
    // standing in for a restarted process.
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const rigB = createOperatorIdentity({
      volumeRoot: volume,
      credentialMountRoot: rigA.credentialMount,
      clock: systemClock,
      audit,
    });

    const touched = await rigB.touch(login.value.id);
    assert.equal(touched.ok, true, 'the session persisted across the restart');
  });
});

test('S4.6 — explicit logout invalidates the session server-side; the same session id is rejected afterwards', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    const { totpSecretBytes } = await enrolled(rig);
    const code = currentTotpCode(totpSecretBytes, Date.parse(systemClock.now()) / 1000);
    const login = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: code });
    assert.equal(login.ok, true);
    if (!login.ok) return;

    const loggedOut = await rig.identity.logout(login.value.id);
    assert.equal(loggedOut.ok, true);

    const touched = await rig.identity.touch(login.value.id);
    assert.equal(touched.ok, false);
    if (touched.ok) return;
    assert.equal(touched.error.code, 'session-revoked');
  });
});

test('listSessions reports every session, and revokeSession invalidates one by an explicit actor', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    const { totpSecretBytes } = await enrolled(rig);
    const code = currentTotpCode(totpSecretBytes, Date.parse(systemClock.now()) / 1000);

    const first = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: code });
    const second = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: code });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    const sessions = await rig.identity.listSessions();
    assert.equal(sessions.length, 2);

    const revoked = await rig.identity.revokeSession(first.value.id, {
      kind: 'operator',
      subject: SUBJECT,
      clientId: null,
      grantId: null,
    });
    assert.equal(revoked.ok, true);

    const touchedFirst = await rig.identity.touch(first.value.id);
    assert.equal(touchedFirst.ok, false);
    if (touchedFirst.ok) return;
    assert.equal(touchedFirst.error.code, 'session-revoked');

    const touchedSecond = await rig.identity.touch(second.value.id);
    assert.equal(touchedSecond.ok, true, 'revoking one session leaves the other live');
  });
});

test('touch against an unknown session id answers session-unknown', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    const result = await rig.identity.touch('00000000-0000-0000-0000-000000000000' as SessionId);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'session-unknown');
  });
});

test('a missing TOTP sealing key answers totp-key-unavailable rather than failing some other way', async () => {
  await withVolumeAsync(async (volume) => {
    const credentialMount = path.join(volume, '_credential-mount');
    mkdirSync(credentialMount, { recursive: true });
    // Deliberately no sealing key written.
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const identity = createOperatorIdentity({ volumeRoot: volume, credentialMountRoot: credentialMount, clock: systemClock, audit });

    writeProvisioningSecret(volume, PROVISIONING_SECRET);
    const result = await identity.enrol({ provisioningSecret: PROVISIONING_SECRET, subject: SUBJECT, password: PASSWORD });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'totp-key-unavailable');
  });
});

test('S25.3 — runRetention deletes an expired-or-revoked session past the window, and never touches a live one', async () => {
  await withVolumeAsync(async (volume) => {
    const credentialMount = path.join(volume, '_credential-mount');
    setUpMount(credentialMount);
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();
    const audit = createAudit({ volumeRoot: volume, clock: systemClock });
    const identity = createOperatorIdentity({ volumeRoot: volume, credentialMountRoot: credentialMount, clock: systemClock, audit, operatorSessionDays: 1 });

    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    db.prepare(
      `INSERT INTO operator_session (id, subject, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
       VALUES ('old-expired', ?, ?, ?, ?, ?, NULL)`,
    ).run(SUBJECT, old, old, old, old);
    db.prepare(
      `INSERT INTO operator_session (id, subject, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
       VALUES ('old-revoked', ?, ?, ?, ?, ?, ?)`,
    ).run(SUBJECT, old, old, future, future, old);
    db.prepare(
      `INSERT INTO operator_session (id, subject, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
       VALUES ('still-live', ?, ?, ?, ?, ?, NULL)`,
    ).run(SUBJECT, systemClock.now(), systemClock.now(), future, future);
    db.close();

    const report = await identity.runRetention();
    assert.equal(report.module, 'operator-identity');
    assert.equal(report.deletedRows, 2);

    const after = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const remaining = (after.prepare('SELECT id FROM operator_session').all() as { id: string }[]).map((r) => r.id);
    after.close();
    assert.deepEqual(remaining, ['still-live']);
  });
});

const OIDC_REDIRECT_URI = 'http://127.0.0.1:9/auth/login/oidc/callback';

/** Stands in for a browser landing on the fixture's `/authorize` page and clicking "Approve" as `subject` — a real HTTP round trip against the real fixture server, not a call directly into `oidc.ts`. */
async function driveOidcAuthorize(authorizeUrl: string, subject: string): Promise<{ code: string; state: string }> {
  const url = new URL(authorizeUrl);
  url.searchParams.set('sub', subject);
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 302, 'the fixture issuer redirects back with a code');
  const location = new URL(res.headers.get('location')!);
  return { code: location.searchParams.get('code')!, state: location.searchParams.get('state')! };
}

test('S31.2 — OIDC against a real issuer authenticates the operator and establishes the same kind of session a local login does', async () => {
  await withVolumeAsync(async (volume) => {
    const fixture = await startOidcIssuerFixture();
    try {
      const rig = await rigIn(volume, {
        oidcIssuer: fixture.issuerUrl,
        oidcClientId: fixture.clientId,
        oidcClientSecret: fixture.clientSecret,
        oidcSubjectAllowlist: [SUBJECT],
        oidcRedirectUri: OIDC_REDIRECT_URI,
      });
      await enrolled(rig);

      const begin = await rig.identity.beginOidc();
      assert.equal(begin.ok, true);
      if (!begin.ok) return;

      const { code, state } = await driveOidcAuthorize(begin.value.authorizeUrl, SUBJECT);
      assert.equal(state, begin.value.state, 'the state round-trips through the issuer unchanged');

      const session = await rig.identity.completeOidc(code, state);
      assert.equal(session.ok, true);
      if (!session.ok) return;
      assert.equal(session.value.subject, SUBJECT);
      assert.equal(session.value.totpReenrolRequired, false);

      // "the same persisted session a local login does" — same shape, same
      // lifetimes (`createSession`/`finishLogin` is the one funnel every
      // login path, OIDC included, goes through), and a real row
      // `listSessions` can see.
      assert.ok(Date.parse(session.value.idleExpiresAt) > Date.parse(session.value.createdAt));
      assert.ok(Date.parse(session.value.absoluteExpiresAt) > Date.parse(session.value.createdAt));

      const sessions = await rig.identity.listSessions();
      assert.ok(sessions.some((s) => s.id === session.value.id));
    } finally {
      await fixture.stop();
    }
  });
});

test('S31.2 — a federated subject not on the allowlist is refused, and the refusal is audited', async () => {
  await withVolumeAsync(async (volume) => {
    const fixture = await startOidcIssuerFixture();
    try {
      const rig = await rigIn(volume, {
        oidcIssuer: fixture.issuerUrl,
        oidcClientId: fixture.clientId,
        oidcClientSecret: fixture.clientSecret,
        oidcSubjectAllowlist: ['someone-else' as Subject],
        oidcRedirectUri: OIDC_REDIRECT_URI,
      });
      await enrolled(rig);

      const begin = await rig.identity.beginOidc();
      assert.equal(begin.ok, true);
      if (!begin.ok) return;
      const { code, state } = await driveOidcAuthorize(begin.value.authorizeUrl, SUBJECT);

      const result = await rig.identity.completeOidc(code, state);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, 'subject-not-allowlisted');

      const events = await identityEvents(rig);
      assert.ok(events.includes('oidc-subject-rejected'), 'the refusal is audited');
    } finally {
      await fixture.stop();
    }
  });
});

test('S31.3 — with the issuer genuinely unreachable, local password plus TOTP still authenticates', async () => {
  await withVolumeAsync(async (volume) => {
    const fixture = await startOidcIssuerFixture();
    const deadIssuerUrl = fixture.issuerUrl;
    await fixture.stop(); // the port is now closed — a real, not configured, unreachability.

    const rig = await rigIn(volume, {
      oidcIssuer: deadIssuerUrl,
      oidcClientId: 'whatever',
      oidcClientSecret: null,
      oidcSubjectAllowlist: [SUBJECT],
      oidcRedirectUri: OIDC_REDIRECT_URI,
    });
    const { totpSecretBytes } = await enrolled(rig);

    const begin = await rig.identity.beginOidc();
    assert.equal(begin.ok, false);
    if (begin.ok) return;
    assert.equal(begin.error.code, 'oidc-unavailable');
    if (begin.error.code === 'oidc-unavailable') assert.equal(begin.error.reason, 'discovery');

    const local = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: currentTotpCode(totpSecretBytes) });
    assert.equal(local.ok, true, 'the local path stands alone — a broken issuer does not take it down too');
  });
});

test('S31.4 — TOTP re-enrolment: the old secret keeps working until a correct code against the new one commits it, clears the flag, and is audited', async () => {
  await withVolumeAsync(async (volume) => {
    const rig = await rigIn(volume);
    const { totpSecretBytes: oldSecret, recoveryCodes } = await enrolled(rig);

    // A recovery-code login is what forces re-enrolment (S4.4) — S31.4
    // extends that lockout with a real way out.
    const recovered = await rig.identity.loginWithRecoveryCode(SUBJECT, PASSWORD, recoveryCodes[0]!);
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.value.totpReenrolRequired, true, 'the session itself reports the lockout');

    const begin = await rig.identity.beginTotpReenrol(recovered.value.id);
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const newSecret = base32Decode(begin.value.totpSecret);

    // The old secret still authenticates — nothing commits until a correct
    // code against the new one is proven.
    const stillOld = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: currentTotpCode(oldSecret) });
    assert.equal(stillOld.ok, true, 'the old secret is not revoked merely by starting re-enrolment');

    const wrongCode = await rig.identity.completeTotpReenrol(recovered.value.id, '000000');
    assert.equal(wrongCode.ok, false);
    if (!wrongCode.ok) assert.equal(wrongCode.error.code, 'totp-invalid');

    const completed = await rig.identity.completeTotpReenrol(recovered.value.id, currentTotpCode(newSecret));
    assert.equal(completed.ok, true);

    const oldNowFails = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: currentTotpCode(oldSecret) });
    assert.equal(oldNowFails.ok, false, 'the old secret stops authenticating once the new one is committed');
    if (!oldNowFails.ok) assert.equal(oldNowFails.error.code, 'totp-invalid');

    const newWorks = await rig.identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: currentTotpCode(newSecret) });
    assert.equal(newWorks.ok, true);
    assert.equal(newWorks.value.totpReenrolRequired, false, 'the flag clears');

    const events = await identityEvents(rig);
    assert.ok(events.includes('totp-reenrolled'));
  });
});
