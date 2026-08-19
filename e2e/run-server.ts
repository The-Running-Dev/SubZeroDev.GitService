import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { PROVISIONING_FILENAME, TOTP_SEALING_KEY_FILENAME } from '../src/operator-identity/operator-identity.ts';
import { systemClock } from '../src/clock/clock.ts';
import { createStructuredStore } from '../src/store/structured-store.ts';
import { createAudit } from '../src/audit/audit.ts';
import { createJournal } from '../src/journal/journal.ts';
import { createBareGitRemote } from '../src/clone/testing/git-fixture.ts';
import type { ActorRef } from '../src/shared/actor.ts';
import type { AuditAppendInput } from '../src/audit/types.ts';
import {
  E2E_CREDENTIAL_MOUNT_ROOT,
  E2E_FAILING_CREDENTIAL_DECLARATION,
  E2E_FAILING_CREDENTIAL_REF,
  E2E_PARKED_OBSERVABLE_DECLARATION,
  E2E_PARKED_UNOBSERVABLE_DECLARATION,
  E2E_PORT,
  E2E_PROVISIONING_SECRET,
  E2E_VOLUME_ROOT,
} from './constants.ts';

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

/**
 * S34's health-view fixtures: a failed notification-outbox row and a
 * failing-credential mark. Neither module exposes a way to *reach* a
 * terminal `failed`/marked state without either a real webhook that
 * genuinely exhausts its retries or a real credential rejection — both
 * slower and less deterministic than the row this seeds directly, matching
 * `seedAgedAuditHistory`'s own reasoning for writing state ahead of the
 * server rather than driving the module through it.
 */
function seedNotifierAndCredentialFixtures(): void {
  mkdirSync(volumeRoot, { recursive: true });
  const db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
  try {
    const now = systemClock.now();
    db.prepare(
      `INSERT INTO notification_outbox (id, severity, declaration_id, payload, status, attempts, last_attempt_at, last_error, created_at, delivered_at)
       VALUES (?, 'attention', NULL, '{}', 'failed', 5, ?, 'e2e-seed: the webhook never responded', ?, NULL)`,
    ).run(randomUUID(), now, now);

    db.prepare(
      `INSERT INTO credential_failure_mark (credential_ref, declaration_id, reason, marked_at) VALUES (?, ?, ?, ?)`,
    ).run(E2E_FAILING_CREDENTIAL_REF, E2E_FAILING_CREDENTIAL_DECLARATION, 'e2e-seed: the remote refused this credential', now);
  } finally {
    db.close();
  }
}

seedNotifierAndCredentialFixtures();

/**
 * S34.4/S34.5/S34.6's two parked-operations fixtures, seeded through the
 * real `Journal` module directly against the volume the server is about to
 * open — the same reasoning `seedAgedAuditHistory` gives for writing real
 * state ahead of the server rather than orchestrating it through a running
 * instance the browser test cannot reach into.
 *
 * `E2E_PARKED_UNOBSERVABLE_DECLARATION` (`e2e-repo`) is never cloned — the
 * test declares it through the real HTTP API later, but S5 means declaring
 * alone clones nothing, so its tree stays unobservable for S34.5.
 *
 * `E2E_PARKED_OBSERVABLE_DECLARATION` (`e2e-repo-parked`) gets a real local
 * clone written directly onto the on-disk path `CloneStore` expects
 * (`clonePathFor`: `<volumeRoot>/clones/<declarationId>`), with a matching
 * `clone` table row, so the server's own `CloneStore.observeGitState` finds
 * a genuine git working tree when the running server is asked to observe
 * it — S8's "derive from disk" design means it needs no `ensure()` call to
 * have made it, only the row and the directory. Its journal entry's
 * `preState` is deliberately wrong on every compared field, so S34.4's
 * five-field diff has something real to show.
 */
async function seedParkedOperationsFixtures(): Promise<void> {
  const clonesRoot = path.join(volumeRoot, 'clones');
  const clonePath = path.join(clonesRoot, E2E_PARKED_OBSERVABLE_DECLARATION);
  mkdirSync(clonesRoot, { recursive: true });
  const bareRemote = createBareGitRemote();
  const cloned = spawnSync('git', ['clone', bareRemote as unknown as string, clonePath], { encoding: 'utf8' });
  if (cloned.status !== 0) throw new Error(`e2e seed: git clone failed: ${cloned.stderr}`);

  const db = new DatabaseSync(path.join(volumeRoot, 'store.sqlite'));
  try {
    const now = systemClock.now();
    db.prepare(
      `INSERT INTO clone (declaration_id, generation, state, path, size_bytes, last_operation_at, observed_remote, attention_reason)
       VALUES (?, 1, 'ready', ?, 0, ?, ?, NULL)`,
    ).run(E2E_PARKED_OBSERVABLE_DECLARATION, clonePath, now, bareRemote as unknown as string);
  } finally {
    db.close();
  }

  const seedActor: ActorRef = { kind: 'operator', subject: 'e2e-seed' as never, clientId: null, grantId: null };
  const seedJournal = createJournal({ volumeRoot, clock: systemClock });

  async function seedOneParkedEntry(declarationId: string, operationId: string): Promise<void> {
    const begun = await seedJournal.begin({
      operationId: operationId as never,
      declarationId: declarationId as never,
      generation: 1 as never,
      tool: 'git.commit' as never,
      input: {},
      actorRef: seedActor,
      scheduledJobId: null,
      context: 'normal',
      preState: {
        branch: 'e2e-seed-wrong-branch' as never,
        headSha: '0'.repeat(40) as never,
        upstreamSha: '1'.repeat(40) as never,
        indexDigest: '2'.repeat(64) as never,
        worktreeDigest: '3'.repeat(64) as never,
      },
    });
    if (!begun.ok) throw new Error(`e2e seed: journal.begin failed: ${begun.error.summary}`);
    const parked = await seedJournal.park(operationId as never, 'e2e-seed: a parked operation for the console view to render');
    if (!parked.ok) throw new Error(`e2e seed: journal.park failed: ${parked.error.summary}`);
  }

  await Promise.all([
    seedOneParkedEntry(E2E_PARKED_UNOBSERVABLE_DECLARATION, 'e2e-seed-parked-unobservable'),
    seedOneParkedEntry(E2E_PARKED_OBSERVABLE_DECLARATION, 'e2e-seed-parked-observable'),
  ]);
}

await seedParkedOperationsFixtures();

process.env.VOLUME_ROOT = volumeRoot;
process.env.CREDENTIAL_MOUNT_ROOT = credentialMountRoot;
process.env.PORT = String(E2E_PORT);
// `console.spec.ts` declares one real repository through the real HTTP API
// to exercise S18.2's landing view — declaring validates the URL's host
// against this allowlist but performs no clone (S5: "clones itself on first
// use"), so this needs no outbound network access to succeed.
process.env.REMOTE_HOST_ALLOWLIST = 'github.com';

await import('../src/server.ts');
