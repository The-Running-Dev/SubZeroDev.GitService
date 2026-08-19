import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROVISIONING_FILENAME, TOTP_SEALING_KEY_FILENAME } from '../src/operator-identity/operator-identity.ts';
import { systemClock } from '../src/clock/clock.ts';
import { createStructuredStore } from '../src/store/structured-store.ts';
import { createAudit } from '../src/audit/audit.ts';
import type { ActorRef } from '../src/shared/actor.ts';
import type { AuditAppendInput } from '../src/audit/types.ts';
import { E2E_CREDENTIAL_MOUNT_ROOT, E2E_PORT, E2E_PROVISIONING_SECRET, E2E_VOLUME_ROOT } from './constants.ts';

/**
 * S18.13's fixture instance: a fresh volume and credential mount, seeded
 * with a TOTP sealing key and a provisioning secret, then the real
 * `src/server.ts` started against them — the same server the deployed
 * container runs, not a mock. Playwright's `webServer` (`playwright.config.ts`)
 * runs this once per test run and waits for `/healthz` before the browser
 * tests start.
 */

const volumeRoot = E2E_VOLUME_ROOT;
const credentialMountRoot = E2E_CREDENTIAL_MOUNT_ROOT;

rmSync(volumeRoot, { recursive: true, force: true });
rmSync(credentialMountRoot, { recursive: true, force: true });
mkdirSync(volumeRoot, { recursive: true });
mkdirSync(credentialMountRoot, { recursive: true });

writeFileSync(path.join(credentialMountRoot, TOTP_SEALING_KEY_FILENAME), randomBytes(32));
writeFileSync(path.join(volumeRoot, PROVISIONING_FILENAME), `${E2E_PROVISIONING_SECRET}\n`, 'utf8');

/**
 * S33.6 needs a trail long enough that a segment has aged out behind an
 * anchor — S26's retention default (`auditDays: 90`) never rotates
 * naturally in a test run, and there is no live route or env var to shrink
 * it (`10-design.md`'s deployment configuration fixes the default; nothing
 * makes it test-configurable). So this seeds real rotated-and-retained
 * history directly, strictly before `src/server.ts`'s own `Audit` instance
 * is ever constructed below — the same volume, but no concurrent writer yet,
 * so there is no race with the live server's own in-memory chain head.
 */
async function seedAgedAuditHistory(): Promise<void> {
  const store = createStructuredStore({ volumeRoot, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();

  const seedActor: ActorRef = { kind: 'operator', subject: 'e2e-seed' as never, clientId: null, grantId: null };
  const seedInput: AuditAppendInput = {
    at: systemClock.now(),
    operationId: null,
    declarationId: null,
    generation: null,
    tool: null,
    actorRef: seedActor,
    context: 'normal',
    form: 'lease-takeover',
    previousHolder: { instanceId: 'e2e-seed-instance', bootId: 'e2e-seed-boot', hostName: 'e2e-seed-host', startedAt: systemClock.now() as never },
  };

  const seedAudit = createAudit({ volumeRoot, clock: systemClock, segmentBytes: 400 });
  for (let i = 0; i < 12; i += 1) await seedAudit.append(seedInput);

  const firstSegment = path.join(volumeRoot, 'audit', '000001.jsonl');
  const wellPast90Days = new Date('2000-01-01T00:00:00.000Z');
  utimesSync(firstSegment, wellPast90Days, wellPast90Days);
  await seedAudit.runRetention();
  await seedAudit.close();
}

await seedAgedAuditHistory();

process.env.VOLUME_ROOT = volumeRoot;
process.env.CREDENTIAL_MOUNT_ROOT = credentialMountRoot;
process.env.PORT = String(E2E_PORT);
// `console.spec.ts` declares one real repository through the real HTTP API
// to exercise S18.2's landing view — declaring validates the URL's host
// against this allowlist but performs no clone (S5: "clones itself on first
// use"), so this needs no outbound network access to succeed.
process.env.REMOTE_HOST_ALLOWLIST = 'github.com';

await import('../src/server.ts');
