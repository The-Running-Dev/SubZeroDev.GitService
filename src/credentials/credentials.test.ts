import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import type { CredentialRef, DeclarationId, EnvVarName, RemoteHost, Subject } from '../shared/brands.ts';
import type { ActorRef } from '../shared/actor.ts';
import { createCredentialResolver, envVarNameFor } from './credentials.ts';

const REF = 'github-token' as CredentialRef;
const OTHER_REF = 'other-token' as CredentialRef;
const REPO_A = 'repo-a' as DeclarationId;
const REPO_B = 'repo-b' as DeclarationId;
const SECRET = 'ghp-fixture-secret-value';

/**
 * Every file is stamped five seconds into the past.
 *
 * A mark clears when the secret file is newer than `marked_at`, and both sides
 * are milliseconds — so a fixture that writes the file and marks it in the
 * same tick is asserting a coincidence rather than a property, and fails
 * whenever the machine is loaded enough to reorder them. Back-dating gives
 * every test an unambiguous "this secret predates the mark" baseline; the one
 * test that needs the opposite stamps its own file forward explicitly.
 */
function mount(files: Readonly<Record<string, string>>): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'szg-creds-'));
  mkdirSync(root, { recursive: true });
  const earlier = new Date(Date.now() - 5_000);
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    writeFileSync(file, contents, 'utf8');
    utimesSync(file, earlier, earlier);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The marks live on the data volume, so the schema has to exist before any of them can be written. */
async function migratedVolume(volumeRoot: string): Promise<void> {
  const store = createStructuredStore({ volumeRoot, clock: systemClock });
  const opened = await store.open();
  assert.equal(opened.ok, true);
  const migrated = await store.migrate();
  assert.equal(migrated.ok, true);
  await store.close();
}

test('S9.1: a reference naming a file in the mount resolves into the env, and returns only the variable name', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [REF]: `${SECRET}\n` });
    try {
      const resolver = createCredentialResolver({ credentialMountRoot: secrets.root, volumeRoot, clock: systemClock });
      const env = new Map<EnvVarName, string>();
      const resolved = await resolver.resolveInto(REF, REPO_A, env);

      assert.equal(resolved.ok, true);
      if (!resolved.ok) return;
      assert.equal(resolved.value.ref, REF);
      assert.equal(resolved.value.declarationId, REPO_A);
      assert.equal(resolved.value.variableName, envVarNameFor(REF));
      assert.equal(resolved.value.username, null);

      // The value reached the env and nothing else. The trailing newline the
      // file carried is gone — a token with one authenticates as a different
      // token.
      assert.equal(env.get(resolved.value.variableName), SECRET);
      assert.equal(JSON.stringify(resolved.value).includes(SECRET), false);
    } finally {
      secrets.cleanup();
    }
  });
});

test('the optional collision-free username file is returned, and malformed usernames are rejected', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [REF]: SECRET, [`_${REF}.username`]: 'deploy-token-user\n' });
    try {
      const resolver = createCredentialResolver({ credentialMountRoot: secrets.root, volumeRoot, clock: systemClock });
      const resolved = await resolver.resolveInto(REF, REPO_A, new Map());
      assert.equal(resolved.ok, true);
      if (resolved.ok) assert.equal(resolved.value.username, 'deploy-token-user');

      const rejected: string[] = ['', 'two\nlines', 'nul\0inside'];
      for (const username of rejected) {
        writeFileSync(path.join(secrets.root, `_${REF}.username`), username, 'utf8');
        const result = await resolver.resolveInto(REF, REPO_A, new Map());
        assert.equal(result.ok, false, JSON.stringify(username));
        if (!result.ok) assert.equal(result.error.code, 'reference-unreadable');
      }
      assert.equal(rejected.length, 3);
    } finally {
      secrets.cleanup();
    }
  });
});

test('S9.1: a reference naming a missing file returns reference-not-found, naming the reference and never a value', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [OTHER_REF]: SECRET });
    try {
      const resolver = createCredentialResolver({ credentialMountRoot: secrets.root, volumeRoot, clock: systemClock });
      const env = new Map<EnvVarName, string>();
      const resolved = await resolver.resolveInto(REF, REPO_A, env);

      assert.equal(resolved.ok, false);
      if (resolved.ok) return;
      assert.equal(resolved.error.code, 'reference-not-found');
      assert.equal(resolved.error.resultKind, 'precondition');
      // The criterion and the contract's error table both require *both*
      // names: the reference, and the declaration that wanted it. The variant
      // carries only `ref`, so the declaration reaches the operator through
      // the summary.
      assert.match(resolved.error.summary, new RegExp(REF));
      assert.match(resolved.error.summary, new RegExp(REPO_A));
      // The reference that *does* exist in the mount was never read, so no
      // value can have leaked through the failure path.
      assert.equal(JSON.stringify(resolved.error).includes(SECRET), false);
      assert.equal(env.size, 0);
    } finally {
      secrets.cleanup();
    }
  });
});

test('S9.3: replacing the secret file takes effect on the next resolution, with no restart', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [REF]: 'first-value' });
    try {
      const resolver = createCredentialResolver({ credentialMountRoot: secrets.root, volumeRoot, clock: systemClock });
      const first = new Map<EnvVarName, string>();
      await resolver.resolveInto(REF, REPO_A, first);
      assert.equal(first.get(envVarNameFor(REF)), 'first-value');

      writeFileSync(path.join(secrets.root, REF), 'second-value', 'utf8');

      // Same resolver instance — nothing is restarted, and nothing is cached.
      const second = new Map<EnvVarName, string>();
      await resolver.resolveInto(REF, REPO_A, second);
      assert.equal(second.get(envVarNameFor(REF)), 'second-value');
    } finally {
      secrets.cleanup();
    }
  });
});

test('S9.4: a mark is per declaration — a second declaration sharing the reference still resolves', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [REF]: SECRET });
    try {
      const resolver = createCredentialResolver({ credentialMountRoot: secrets.root, volumeRoot, clock: systemClock });
      await resolver.markFailing(REF, REPO_A, 'the remote refused this credential');

      const blocked = await resolver.resolveInto(REF, REPO_A, new Map());
      assert.equal(blocked.ok, false);
      if (!blocked.ok) {
        assert.equal(blocked.error.code, 'marked-failing');
        assert.equal(blocked.error.resultKind, 'upstream');
      }

      // The property a reference-wide mark breaks: one repository's
      // misconfiguration must not become an unrelated repository's outage.
      const other = new Map<EnvVarName, string>();
      const allowed = await resolver.resolveInto(REF, REPO_B, other);
      assert.equal(allowed.ok, true);
      assert.equal(other.get(envVarNameFor(REF)), SECRET);
    } finally {
      secrets.cleanup();
    }
  });
});

test('S9.5: the mark clears when the resolver observes a changed secret', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [REF]: 'stale-value' });
    try {
      const appended: unknown[] = [];
      const resolver = createCredentialResolver({
        credentialMountRoot: secrets.root,
        volumeRoot,
        clock: systemClock,
        audit: {
          append: async (input) => {
            appended.push(input);
            return { appended: true, sequence: appended.length };
          },
        },
      });
      await resolver.markFailing(REF, REPO_A, 'the remote refused this credential');
      assert.equal((await resolver.resolveInto(REF, REPO_A, new Map())).ok, false);

      // Rotation is a file write. Stamped explicitly rather than trusting the
      // clock's resolution: the mark was taken milliseconds ago, and a
      // filesystem with second-granularity timestamps would otherwise make
      // this assert a race rather than a property.
      writeFileSync(path.join(secrets.root, REF), 'rotated-value', 'utf8');
      const later = new Date(Date.now() + 5_000);
      utimesSync(path.join(secrets.root, REF), later, later);

      const env = new Map<EnvVarName, string>();
      const resolved = await resolver.resolveInto(REF, REPO_A, env);
      assert.equal(resolved.ok, true);
      assert.equal(env.get(envVarNameFor(REF)), 'rotated-value');
      // Cleared, not merely bypassed: the health view must stop listing it.
      assert.deepEqual(await resolver.listFailing(), []);
      // S34.2 — this clear was the resolver's own, not an operator's, and
      // `clearFailing`'s one internal caller passes `actor: null` for exactly
      // this reason: nothing to audit.
      assert.equal(appended.length, 0);
    } finally {
      secrets.cleanup();
    }
  });
});

test('S9.5: a rotation inside the mark\'s own millisecond keeps the mark, and one millisecond later clears it', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [REF]: 'stale-value' });
    try {
      const resolver = createCredentialResolver({ credentialMountRoot: secrets.root, volumeRoot, clock: systemClock });
      await resolver.markFailing(REF, REPO_A, 'the remote refused this credential');
      const markedAt = (await resolver.listFailing())[0]?.markedAt;
      assert.notEqual(markedAt, undefined);
      const markedMs = Date.parse(markedAt ?? '');

      // The comparison behind "the mark clears when the resolver observes a
      // changed secret" is a strictly-later whole millisecond, and the tie is
      // load-bearing in the direction that *keeps* the mark: the secret that was
      // just rejected can share the mark's own millisecond, so `>=` would make
      // every mark clear itself the instant it was taken. That direction is
      // invisible from outside the module, and issue #122 turned on it — the
      // boundary is pinned here so a later `>=` fails a test rather than
      // silently readmitting a credential already known to be failing.
      const secretPath = path.join(secrets.root, REF);
      writeFileSync(secretPath, 'rotated-value', 'utf8');
      const tie = new Date(markedMs);
      utimesSync(secretPath, tie, tie);

      const blocked = await resolver.resolveInto(REF, REPO_A, new Map());
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.error.code, 'marked-failing');
      assert.equal((await resolver.listFailing()).length, 1);

      // One millisecond is the whole difference, on identical bytes.
      const later = new Date(markedMs + 1);
      utimesSync(secretPath, later, later);

      const env = new Map<EnvVarName, string>();
      assert.equal((await resolver.resolveInto(REF, REPO_A, env)).ok, true);
      assert.equal(env.get(envVarNameFor(REF)), 'rotated-value');
      assert.deepEqual(await resolver.listFailing(), []);
    } finally {
      secrets.cleanup();
    }
  });
});

test('S9.5: the mark clears by hand, and listFailing is what the health view reads', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [REF]: SECRET });
    try {
      const appended: unknown[] = [];
      const resolver = createCredentialResolver({
        credentialMountRoot: secrets.root,
        volumeRoot,
        clock: systemClock,
        audit: {
          append: async (input) => {
            appended.push(input);
            return { appended: true, sequence: appended.length };
          },
        },
      });
      await resolver.markFailing(REF, REPO_A, 'refused');
      await resolver.markFailing(OTHER_REF, REPO_B, 'also refused');

      const listed = await resolver.listFailing();
      assert.equal(listed.length, 2);
      assert.equal(
        listed.every((mark) => !JSON.stringify(mark).includes(SECRET)),
        true,
      );

      const actor: ActorRef = { kind: 'operator', subject: 'test-operator' as Subject, clientId: null, grantId: null };
      await resolver.clearFailing(REF, REPO_A, actor);
      const after = await resolver.listFailing();
      assert.equal(after.length, 1);
      assert.equal(after[0]?.ref, OTHER_REF);
      assert.equal(after[0]?.declarationId, REPO_B);

      // S34.2 — clearing by hand is audited, against the operator who did it.
      assert.equal(appended.length, 1);
      assert.deepEqual(appended[0], {
        at: (appended[0] as { at: string }).at,
        operationId: null,
        declarationId: REPO_A,
        generation: null,
        tool: null,
        actorRef: actor,
        context: 'normal',
        form: 'identity-event',
        event: 'failing-credential-cleared',
      });

      // Cleared by hand means the next operation may try again — the mark
      // was already gone, so this succeeds without a second clear.
      assert.equal((await resolver.resolveInto(REF, REPO_A, new Map())).ok, true);
      assert.equal(appended.length, 1, 'no second clear happened, so no second audit record');
    } finally {
      secrets.cleanup();
    }
  });
});

test('a mark store that cannot be read fails closed: resolution refuses rather than reporting the reference healthy', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({ [REF]: SECRET });
    try {
      const resolver = createCredentialResolver({ credentialMountRoot: secrets.root, volumeRoot, clock: systemClock });
      await resolver.markFailing(REF, REPO_A, 'the remote refused this credential');

      // A store SQLite cannot open at all. "No marks" and "no answer" must not
      // be the same verdict — collapsing them hands out a credential the
      // service has already been told is failing.
      writeFileSync(path.join(volumeRoot, 'store.sqlite'), 'this is not a database', 'utf8');

      const resolved = await resolver.resolveInto(REF, REPO_A, new Map());
      assert.equal(resolved.ok, false);
      if (resolved.ok) return;
      assert.equal(resolved.error.resultKind, 'infrastructure');
      assert.match(resolved.error.summary, /not known whether/);
      assert.equal(resolved.error.summary.includes(SECRET), false);
    } finally {
      secrets.cleanup();
    }
  });
});

test('the allowed-host constraint is per reference, and a reference absent from the manifest permits nothing', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const secrets = mount({
      [REF]: SECRET,
      [OTHER_REF]: SECRET,
      '_allowed-hosts.json': JSON.stringify({ [REF]: ['GitHub.com'] }),
    });
    try {
      const resolver = createCredentialResolver({ credentialMountRoot: secrets.root, volumeRoot, clock: systemClock });

      const named = await resolver.allowedHosts(REF);
      assert.equal(named.ok, true);
      if (named.ok) assert.deepEqual(named.value, ['github.com' as RemoteHost]);

      // A guard that defaults open is not a guard.
      const absent = await resolver.allowedHosts(OTHER_REF);
      assert.equal(absent.ok, true);
      if (absent.ok) assert.deepEqual(absent.value, []);
    } finally {
      secrets.cleanup();
    }
  });
});
