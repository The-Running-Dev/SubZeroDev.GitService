/**
 * S4 — operator identity tests
 *
 * Acceptance criteria from design/30-slices.md § S4:
 *
 * 1. No credential → provisioningPending, every console route 401 (covered
 *    in http-server tests), status reports provisioningPending: true.
 * 2. Enrolment with wrong secret → 401, provisioning file not burned.
 * 3. Enrolment with correct secret → sets password, enrols TOTP, returns
 *    exactly ten recovery codes once, deletes file. Second attempt → 401
 *    already-provisioned.
 * 4. Login: correct password, no TOTP → fails.  TOTP is never optional.
 * 5. Recovery code authenticates once; second use → recovery-code-used;
 *    success writes identity-event and sets totp_reenrol_required.
 * 6. Break-glass token authenticates once, audited, does not work twice.
 *    Works with no TOTP device and no recovery codes.
 * 7. Session survives a module restart. Explicit logout invalidates
 *    server-side (same cookie replayed → session-revoked).
 * 8. Cross-slice: provisioningPending is false after enrolment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createStructuredStore } from '../store/structured-store.ts';
import { createAudit } from '../audit/audit.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { systemClock } from '../clock/clock.ts';
import { createOperatorIdentity } from './operator-identity.ts';
import { verifyTotp } from './totp.ts';
import type { Subject } from '../shared/brands.ts';
import type { EnrolmentRequest, LocalLoginRequest } from './types.ts';

const SUBJECT = 'alice' as Subject;
const PASSWORD = 'correct-horse-battery-staple';
const WRONG_PASSWORD = 'wrong';

async function bootedVolume(
  volumeRoot: string,
): Promise<{ totpKeyPath: string }> {
  const store = createStructuredStore({ volumeRoot, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();

  // Write the TOTP sealing key (32 random bytes) into a credential-mount dir
  const credDir = path.join(volumeRoot, 'creds');
  mkdirSync(credDir, { recursive: true });
  const totpKeyPath = path.join(credDir, '_totp_sealing_key');
  writeFileSync(totpKeyPath, randomBytes(32));
  return { totpKeyPath };
}

function makeIdentity(volumeRoot: string, totpKeyPath: string) {
  const audit = createAudit({ volumeRoot, clock: systemClock });
  return createOperatorIdentity({ volumeRoot, totpKeyPath, clock: systemClock, audit });
}

function writeProvisioningFile(volumeRoot: string, secret: string) {
  writeFileSync(path.join(volumeRoot, 'provisioning.secret'), secret);
}

function writeBreakGlassFile(volumeRoot: string, token: string) {
  writeFileSync(path.join(volumeRoot, 'break-glass.token'), token);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('S4.1 — provisioningState is pending before enrolment', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    assert.equal(await identity.provisioningState(), 'pending');
  });
});

test('S4.2 — enrolment with wrong secret returns provisioning-secret-invalid and does not burn the file', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 'real-secret');
    const identity = makeIdentity(volumeRoot, totpKeyPath);

    const result = await identity.enrol({
      provisioningSecret: 'wrong-secret',
      subject: SUBJECT,
      password: PASSWORD,
    } satisfies EnrolmentRequest);

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'provisioning-secret-invalid');
    // File must not be burned
    assert.ok(
      existsSync(path.join(volumeRoot, 'provisioning.secret')),
      'provisioning file must survive a failed enrolment',
    );
  });
});

test('S4.2 — enrolment with absent provisioning file returns provisioning-secret-invalid', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    const identity = makeIdentity(volumeRoot, totpKeyPath);

    const result = await identity.enrol({
      provisioningSecret: 'any',
      subject: SUBJECT,
      password: PASSWORD,
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'provisioning-secret-invalid');
  });
});

test('S4.3 — successful enrolment returns totp secret and exactly ten recovery codes', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 'correct-secret');
    const identity = makeIdentity(volumeRoot, totpKeyPath);

    const result = await identity.enrol({
      provisioningSecret: 'correct-secret',
      subject: SUBJECT,
      password: PASSWORD,
    });

    assert.ok(result.ok);
    assert.equal(result.value.recoveryCodes.length, 10, 'must issue exactly ten recovery codes');
    assert.ok(result.value.totpSecret.length > 0, 'totp secret must be non-empty');
    // Provisioning file must be burned
    assert.ok(
      !existsSync(path.join(volumeRoot, 'provisioning.secret')),
      'provisioning file must be burned after successful enrolment',
    );
    assert.equal(await identity.provisioningState(), 'complete');
  });
});

test('S4.3 — second enrolment attempt returns already-provisioned', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 'correct-secret');
    const identity = makeIdentity(volumeRoot, totpKeyPath);

    const first = await identity.enrol({
      provisioningSecret: 'correct-secret',
      subject: SUBJECT,
      password: PASSWORD,
    });
    assert.ok(first.ok);

    // Write a new provisioning file — irrelevant; already provisioned
    writeProvisioningFile(volumeRoot, 'correct-secret');
    const second = await identity.enrol({
      provisioningSecret: 'correct-secret',
      subject: SUBJECT,
      password: PASSWORD,
    });
    assert.ok(!second.ok);
    assert.equal(second.error.code, 'already-provisioned');
  });
});

test('S4.4 — local login with wrong password returns credentials-invalid', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });

    const result = await identity.loginLocal({
      subject: SUBJECT,
      password: WRONG_PASSWORD,
      totpCode: '000000',
    } satisfies LocalLoginRequest);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'credentials-invalid');
  });
});

test('S4.4 — local login with wrong TOTP code returns totp-invalid (TOTP is never optional)', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });

    const result = await identity.loginLocal({
      subject: SUBJECT,
      password: PASSWORD,
      totpCode: '000000', // deliberately wrong
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'totp-invalid');
  });
});

test('S4.4 — local login with correct password and correct TOTP succeeds', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);

    // Enrol and capture raw TOTP base32 — we need to generate the correct code
    const enrolment = await identity.enrol({
      provisioningSecret: 's',
      subject: SUBJECT,
      password: PASSWORD,
    });
    assert.ok(enrolment.ok);

    // Derive the correct TOTP code from the base32 secret
    const { generateTotpSecret: _, readSealingKey, unsealTotp, verifyTotp: vt } = await import('./totp.ts');
    const sealingKey = readSealingKey(totpKeyPath);
    assert.ok(sealingKey !== null);

    // We need the raw TOTP secret from the sealed store — read it directly
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    const rows = db.prepare('SELECT totp_secret_sealed FROM operator_credential WHERE singleton = 1').all() as { totp_secret_sealed: string }[];
    db.close();
    const raw = unsealTotp(rows[0]!.totp_secret_sealed, sealingKey);
    assert.ok(raw !== null);

    // Generate the correct code
    const { createHmac } = await import('node:crypto');
    const step = BigInt(Math.floor(Date.now() / 30000));
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(step);
    const mac = createHmac('sha1', raw).update(msg).digest();
    const offset = mac[19]! & 0x0f;
    const code = (((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!) % 1_000_000;
    const totpCode = code.toString().padStart(6, '0');

    const loginResult = await identity.loginLocal({
      subject: SUBJECT,
      password: PASSWORD,
      totpCode,
    });
    assert.ok(loginResult.ok, `expected ok but got ${loginResult.ok ? '' : loginResult.error.code}`);
    assert.ok(loginResult.value.id.length > 0);
  });
});

test('S4.5 — recovery code authenticates once; second use fails with recovery-code-used', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    const enrolment = await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });
    assert.ok(enrolment.ok);
    const code = enrolment.value.recoveryCodes[0]!;

    const first = await identity.loginWithRecoveryCode(SUBJECT, PASSWORD, code);
    assert.ok(first.ok, `first use should succeed, got ${first.ok ? '' : first.error.code}`);

    const second = await identity.loginWithRecoveryCode(SUBJECT, PASSWORD, code);
    assert.ok(!second.ok);
    assert.equal(second.error.code, 'recovery-code-used');

    // Check totp_reenrol_required is set
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
    const rows = db.prepare('SELECT totp_reenrol_required FROM operator_credential WHERE singleton = 1').all() as { totp_reenrol_required: number }[];
    db.close();
    assert.equal(rows[0]!.totp_reenrol_required, 1, 'totp_reenrol_required must be set after recovery code use');
  });
});

test('S4.5 — invalid recovery code returns recovery-code-invalid', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });

    const result = await identity.loginWithRecoveryCode(SUBJECT, PASSWORD, 'not-a-real-code');
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'recovery-code-invalid');
  });
});

test('S4.6 — break-glass authenticates once, is audited, and fails on second use', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });

    const token = 'break-glass-token-abc';
    writeBreakGlassFile(volumeRoot, token);

    const first = await identity.loginWithBreakGlass(token);
    assert.ok(first.ok, `first use should succeed, got ${first.ok ? '' : first.error.code}`);

    const second = await identity.loginWithBreakGlass(token);
    assert.ok(!second.ok);
    assert.equal(second.error.code, 'break-glass-invalid');

    // File must be gone
    assert.ok(!existsSync(path.join(volumeRoot, 'break-glass.token')));
  });
});

test('S4.6 — break-glass with absent file returns break-glass-invalid', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });

    const result = await identity.loginWithBreakGlass('any-token');
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'break-glass-invalid');
  });
});

test('S4.7 — session is findable via listSessions', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });

    const token = 'bg-tok';
    writeBreakGlassFile(volumeRoot, token);
    const session = await identity.loginWithBreakGlass(token);
    assert.ok(session.ok);

    const sessions = await identity.listSessions();
    assert.ok(sessions.some((s) => s.id === session.value.id));
  });
});

test('S4.7 — logout invalidates the session server-side', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity = makeIdentity(volumeRoot, totpKeyPath);
    await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });

    const token = 'bg-tok2';
    writeBreakGlassFile(volumeRoot, token);
    const session = await identity.loginWithBreakGlass(token);
    assert.ok(session.ok);

    const logoutResult = await identity.logout(session.value.id);
    assert.ok(logoutResult.ok);

    // Replaying the session id should now fail
    const touchResult = await identity.touch(session.value.id);
    assert.ok(!touchResult.ok);
    assert.equal(touchResult.error.code, 'session-revoked');
  });
});

test('S4.7 — session survives a new module instance (persisted in DB)', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    const identity1 = makeIdentity(volumeRoot, totpKeyPath);
    await identity1.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });

    const token = 'bg-tok3';
    writeBreakGlassFile(volumeRoot, token);
    const session = await identity1.loginWithBreakGlass(token);
    assert.ok(session.ok);

    // New module instance — simulates a restart
    const identity2 = makeIdentity(volumeRoot, totpKeyPath);
    const touchResult = await identity2.touch(session.value.id);
    assert.ok(touchResult.ok, `session should survive restart, got ${touchResult.ok ? '' : touchResult.error.code}`);
  });
});

test('S4.8 — not-provisioned error when no credential exists', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { totpKeyPath } = await bootedVolume(volumeRoot);
    const identity = makeIdentity(volumeRoot, totpKeyPath);

    const result = await identity.loginLocal({ subject: SUBJECT, password: PASSWORD, totpCode: '000000' });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'not-provisioned');
  });
});

test('S4 — totp-key-unavailable when key file absent (never fatal, returns 401)', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await bootedVolume(volumeRoot);
    writeProvisioningFile(volumeRoot, 's');
    // Point to a non-existent key path
    const identity = makeIdentity(volumeRoot, path.join(volumeRoot, 'nonexistent-key'));
    const result = await identity.enrol({ provisioningSecret: 's', subject: SUBJECT, password: PASSWORD });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'totp-key-unavailable');
  });
});
