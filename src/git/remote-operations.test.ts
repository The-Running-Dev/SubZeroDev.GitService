import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { systemClock } from '../clock/clock.ts';
import { createExec, type ExecRequest } from '../exec/exec.ts';
import { createLocks } from '../locks/locks.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createCredentialResolver, type CredentialResolver } from '../credentials/credentials.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../composition-root/production-declarations.ts';
import type { CallContext } from '../shared/call-context.ts';
import type { ClonePath, CredentialRef, DeclarationId, EnvVarName, OperationId } from '../shared/brands.ts';
import type { Declaration } from '../declarations/types.ts';
import type { AuditAppendInput, AuditAppendOutcome } from '../audit/types.ts';
import { createGitOperations } from './git-operations.ts';

const REF = 'fixture-token' as CredentialRef;
const DECLARATION = 'repo-a' as DeclarationId;
const OTHER_DECLARATION = 'repo-b' as DeclarationId;
const SECRET = 'ghp-fixture-secret-0123456789';

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
}

function gitOut(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  });
  return result.stdout ?? '';
}

/** A real bare remote and a real clone of it — the same shape `git-operations.test.ts` uses. */
function realClone(): { readonly clonePath: string; readonly bareDir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'szg-remote-ops-'));
  const bareDir = path.join(dir, 'remote.git');
  const clonePath = path.join(dir, 'clone');
  git(['init', '--bare', '--initial-branch=main', bareDir], dir);

  const seedDir = path.join(dir, 'seed');
  mkdirSync(seedDir);
  git(['init', '--initial-branch=main', seedDir], dir);
  git(['remote', 'add', 'origin', bareDir], seedDir);
  writeFileSync(path.join(seedDir, 'README.md'), 'fixture\n', 'utf8');
  git(['add', 'README.md'], seedDir);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial'], seedDir);
  git(['push', 'origin', 'main'], seedDir);

  git(['clone', bareDir, clonePath], dir);
  git(['config', 'user.name', 'fixture'], clonePath);
  git(['config', 'user.email', 'fixture@example.com'], clonePath);

  return { clonePath, bareDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A remote that demands authentication and refuses it — a genuine 401 over a
 * genuine HTTP transport, so `git` really runs its credential helper, really
 * sends the resolved secret, and really reports an authentication failure.
 * The captured `Authorization` headers are what make "the secret reached the
 * remote, and never the argv" a checkable claim rather than an inspection of
 * our own code.
 */
async function rejectingRemote(): Promise<{
  readonly url: string;
  readonly authorizations: readonly (string | null)[];
  readonly close: () => Promise<void>;
}> {
  const authorizations: (string | null)[] = [];
  const server: Server = createServer((req, res) => {
    authorizations.push(req.headers.authorization ?? null);
    req.resume();
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"', 'Content-Length': '3' });
    res.end('no\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    authorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function fixtureDeclaration(id: DeclarationId, cloneUrl: string): Declaration {
  return {
    id,
    generation: 1 as Declaration['generation'],
    cloneUrl: cloneUrl as Declaration['cloneUrl'],
    host: 'generic',
    credentialRef: REF,
    capabilityGrant: new Set(['git.remote.write']) as unknown as Declaration['capabilityGrant'],
    writablePathPrefixes: [],
    pinned: false,
    contentDrop: null,
    identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
    state: 'active',
    grantEpoch: 0 as Declaration['grantEpoch'],
    createdAt: systemClock.now(),
    updatedAt: systemClock.now(),
  };
}

function contextFor(clonePath: string, declarationId: DeclarationId = DECLARATION): CallContext {
  return {
    operationId: 'op-1' as OperationId,
    declarationId,
    generation: 1 as never,
    cloneRoot: clonePath as ClonePath,
    actorRef: { kind: 'mcp', subject: 'sub' as never, clientId: null, grantId: null },
    capabilities: new Set() as never,
    writablePathPrefixes: [],
    context: 'normal',
    scheduledJobId: null,
    deadline: systemClock.now(),
    signal: new AbortController().signal,
  };
}

function secretsMount(secret: string, hosts: Readonly<Record<string, readonly string[]>> | null): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'szg-mount-'));
  writeFileSync(path.join(root, REF), secret, 'utf8');
  if (hosts !== null) writeFileSync(path.join(root, '_allowed-hosts.json'), JSON.stringify(hosts), 'utf8');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function migratedVolume(volumeRoot: string): Promise<void> {
  const store = createStructuredStore({ volumeRoot, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();
}

function recordingAudit(): { readonly append: (input: AuditAppendInput) => Promise<AuditAppendOutcome>; readonly records: AuditAppendInput[] } {
  const records: AuditAppendInput[] = [];
  return {
    records,
    async append(input: AuditAppendInput): Promise<AuditAppendOutcome> {
      records.push(input);
      return { appended: true, sequence: records.length };
    },
  };
}

/** Counts resolutions so "never retries with a different credential" is a count, not an impression. */
function countingResolver(inner: CredentialResolver): { readonly resolver: CredentialResolver; readonly resolutions: { ref: string; declarationId: string }[] } {
  const resolutions: { ref: string; declarationId: string }[] = [];
  return {
    resolutions,
    resolver: {
      ...inner,
      async resolveInto(ref, declarationId, env) {
        resolutions.push({ ref: ref as string, declarationId: declarationId as string });
        return inner.resolveInto(ref, declarationId, env);
      },
    },
  };
}

test('S9.8: git_push has no force option anywhere in its input schema', () => {
  const push = PRODUCTION_TOOL_DECLARATIONS.find((entry) => (entry.name as string) === 'git_push');
  assert.notEqual(push, undefined);
  const schema = JSON.parse(JSON.stringify(push!.inputSchema)) as { properties: Record<string, unknown>; additionalProperties?: boolean };

  assert.deepEqual(Object.keys(schema.properties), ['branch']);
  assert.equal(
    Object.keys(schema.properties).some((key) => /force|forc/i.test(key)),
    false,
  );
  // The absence has to be enforced, not merely undeclared: without this a
  // caller could pass `force: true` and the schema would accept it.
  assert.equal(schema.additionalProperties, false);
});

test('S9.2 + S9.4 + S9.6: a push the remote refuses reaches it with the resolved secret, keeps it out of every argv, result and audit record, and marks the reference for this declaration only', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const clone = realClone();
    const remote = await rejectingRemote();
    const mount = secretsMount(SECRET, { [REF]: ['127.0.0.1'] });
    try {
      git(['remote', 'set-url', 'origin', remote.url], clone.clonePath);

      const credentialEnv = new Map<EnvVarName, string>();
      // `onSpawn` reports the vector that actually becomes a process — see its
      // doc comment in `exec.ts` for why the child's own output cannot answer
      // this question.
      const argvSeen: (readonly string[])[] = [];
      const exec = createExec({ volumeRoot, credentialEnv, onSpawn: (_executable, argv) => argvSeen.push(argv) });
      const recordingExec = { runGit: (request: ExecRequest) => exec.runGit(request) };

      const resolver = createCredentialResolver({ credentialMountRoot: mount.root, volumeRoot, clock: systemClock });
      const counted = countingResolver(resolver);
      const audit = recordingAudit();
      const declaration = fixtureDeclaration(DECLARATION, remote.url);

      const operations = createGitOperations({
        clock: systemClock,
        exec: recordingExec,
        locks: createLocks(),
        audit,
        declarations: { get: async (id) => (id === DECLARATION ? declaration : fixtureDeclaration(OTHER_DECLARATION, remote.url)) },
        credentials: counted.resolver,
        credentialEnv,
      });

      const result = await operations.push(contextFor(clone.clonePath), { branch: null });

      // The remote really refused, and it refused a request that really
      // carried the secret — so the credential channel works end to end.
      assert.equal(result.kind, 'upstream');
      const delivered = remote.authorizations.filter((header): header is string => header !== null);
      assert.equal(delivered.length > 0, true);
      assert.equal(
        delivered.some((header) => Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8').includes(SECRET)),
        true,
      );

      // S9.2, the three places the criterion names.
      assert.equal(JSON.stringify(result).includes(SECRET), false);
      assert.equal(JSON.stringify(audit.records).includes(SECRET), false);
      assert.equal(
        argvSeen.some((argv) => argv.some((element) => element.includes(SECRET))),
        false,
      );
      assert.equal(argvSeen.length > 0, true);

      // S9.6 — one resolution for one operation. A retry with a second
      // credential would show up here as a second entry.
      assert.deepEqual(counted.resolutions, [{ ref: REF as string, declarationId: DECLARATION as string }]);

      // S9.4 — marked, and marked narrowly.
      const marks = await resolver.listFailing();
      assert.equal(marks.length, 1);
      assert.equal(marks[0]?.ref, REF);
      assert.equal(marks[0]?.declarationId, DECLARATION);
      assert.equal(JSON.stringify(marks).includes(SECRET), false);

      // The second declaration sharing the reference is untouched: it still
      // resolves, which is exactly what a reference-wide mark would break.
      const otherEnv = new Map<EnvVarName, string>();
      assert.equal((await resolver.resolveInto(REF, OTHER_DECLARATION, otherEnv)).ok, true);
    } finally {
      mount.cleanup();
      await remote.close();
      clone.cleanup();
    }
  });
});

test('S9.3: replacing the secret file changes what the next push sends, with no restart', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const clone = realClone();
    const remote = await rejectingRemote();
    const mount = secretsMount('first-secret-value', { [REF]: ['127.0.0.1'] });
    try {
      git(['remote', 'set-url', 'origin', remote.url], clone.clonePath);

      const credentialEnv = new Map<EnvVarName, string>();
      const exec = createExec({ volumeRoot, credentialEnv });
      const resolver = createCredentialResolver({ credentialMountRoot: mount.root, volumeRoot, clock: systemClock });
      const declaration = fixtureDeclaration(DECLARATION, remote.url);
      const operations = createGitOperations({
        clock: systemClock,
        exec,
        locks: createLocks(),
        declarations: { get: async () => declaration },
        credentials: resolver,
        credentialEnv,
      });

      await operations.push(contextFor(clone.clonePath), { branch: null });

      // The first attempt marked the reference. Rotating the secret is what
      // clears the mark *and* what the next attempt must send — both halves of
      // "no restart" in one step.
      writeFileSync(path.join(mount.root, REF), 'second-secret-value', 'utf8');
      await operations.push(contextFor(clone.clonePath), { branch: null });

      const sent = remote.authorizations
        .filter((header): header is string => header !== null)
        .map((header) => Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8'));
      assert.equal(
        sent.some((credential) => credential.includes('first-secret-value')),
        true,
      );
      assert.equal(
        sent.some((credential) => credential.includes('second-secret-value')),
        true,
      );
    } finally {
      mount.cleanup();
      await remote.close();
      clone.cleanup();
    }
  });
});

test('S9.9: a fetch that fails mid-transfer leaves every remote-tracking ref exactly where it was', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const clone = realClone();
    const remote = await rejectingRemote();
    const mount = secretsMount(SECRET, { [REF]: ['127.0.0.1'] });
    try {
      const before = gitOut(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'], clone.clonePath);
      assert.match(before, /refs\/remotes\/origin\/main/);

      git(['remote', 'set-url', 'origin', remote.url], clone.clonePath);

      const credentialEnv = new Map<EnvVarName, string>();
      const exec = createExec({ volumeRoot, credentialEnv });
      const declaration = fixtureDeclaration(DECLARATION, remote.url);
      const operations = createGitOperations({
        clock: systemClock,
        exec,
        locks: createLocks(),
        declarations: { get: async () => declaration },
        credentials: createCredentialResolver({ credentialMountRoot: mount.root, volumeRoot, clock: systemClock }),
        credentialEnv,
      });

      const result = await operations.fetch(contextFor(clone.clonePath), {});
      assert.equal(result.kind, 'upstream');

      const after = gitOut(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'], clone.clonePath);
      assert.equal(after, before);
    } finally {
      mount.cleanup();
      await remote.close();
      clone.cleanup();
    }
  });
});

test('a push against a reachable remote succeeds, and sync_base fast-forwards the local base to it', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const clone = realClone();
    // A bare local path has no host, so the reference's host constraint has
    // nothing to check — the same shape every other clone-store test uses.
    const mount = secretsMount(SECRET, null);
    try {
      const credentialEnv = new Map<EnvVarName, string>();
      const exec = createExec({ volumeRoot, credentialEnv });
      const declaration = fixtureDeclaration(DECLARATION, clone.bareDir);
      const operations = createGitOperations({
        clock: systemClock,
        exec,
        locks: createLocks(),
        declarations: { get: async () => declaration },
        credentials: createCredentialResolver({ credentialMountRoot: mount.root, volumeRoot, clock: systemClock }),
        credentialEnv,
      });

      writeFileSync(path.join(clone.clonePath, 'NEW.md'), 'new\n', 'utf8');
      git(['add', 'NEW.md'], clone.clonePath);
      git(['commit', '-m', 'a change'], clone.clonePath);
      const localHead = gitOut(['rev-parse', 'HEAD'], clone.clonePath).trim();

      const pushed = await operations.push(contextFor(clone.clonePath), { branch: null });
      assert.equal(pushed.kind, 'success');
      if (pushed.ok && pushed.data) {
        assert.equal(pushed.data.branch, 'main');
        assert.equal(pushed.data.headSha, localHead);
        assert.equal(pushed.data.alreadyUpToDate, false);
      }
      // The remote really moved — read from the bare repository itself.
      assert.equal(gitOut(['rev-parse', 'main'], clone.bareDir).trim(), localHead);

      // Pushing the same branch again is a no-op the tool reports as such.
      const again = await operations.push(contextFor(clone.clonePath), { branch: null });
      assert.equal(again.ok && again.data?.alreadyUpToDate, true);

      const synced = await operations.syncBase(contextFor(clone.clonePath), {});
      assert.equal(synced.kind, 'success');
      if (synced.ok && synced.data) {
        assert.equal(synced.data.baseBranch, 'main');
        assert.equal(synced.data.upstreamSha, localHead);
        assert.equal(synced.data.fastForwarded, false);
      }
    } finally {
      mount.cleanup();
      clone.cleanup();
    }
  });
});

test('sync_base fast-forwards a base branch the remote has moved ahead of, and refuses one that has diverged', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const clone = realClone();
    const mount = secretsMount(SECRET, null);
    try {
      const credentialEnv = new Map<EnvVarName, string>();
      const exec = createExec({ volumeRoot, credentialEnv });
      const declaration = fixtureDeclaration(DECLARATION, clone.bareDir);
      const operations = createGitOperations({
        clock: systemClock,
        exec,
        locks: createLocks(),
        declarations: { get: async () => declaration },
        credentials: createCredentialResolver({ credentialMountRoot: mount.root, volumeRoot, clock: systemClock }),
        credentialEnv,
      });

      // Somebody else pushes to the remote, through a second working copy.
      const otherDir = mkdtempSync(path.join(tmpdir(), 'szg-other-'));
      git(['clone', clone.bareDir, 'work'], otherDir);
      const otherWork = path.join(otherDir, 'work');
      git(['config', 'user.name', 'other'], otherWork);
      git(['config', 'user.email', 'other@example.com'], otherWork);
      writeFileSync(path.join(otherWork, 'THEIRS.md'), 'theirs\n', 'utf8');
      git(['add', 'THEIRS.md'], otherWork);
      git(['commit', '-m', 'their change'], otherWork);
      git(['push', 'origin', 'main'], otherWork);
      const remoteHead = gitOut(['rev-parse', 'main'], clone.bareDir).trim();

      const synced = await operations.syncBase(contextFor(clone.clonePath), {});
      assert.equal(synced.kind, 'success');
      if (synced.ok && synced.data) {
        assert.equal(synced.data.fastForwarded, true);
        assert.equal(synced.data.upstreamSha, remoteHead);
      }
      assert.equal(gitOut(['rev-parse', 'main'], clone.clonePath).trim(), remoteHead);

      // Now diverge: a local commit on the base, and a different one upstream.
      writeFileSync(path.join(clone.clonePath, 'MINE.md'), 'mine\n', 'utf8');
      git(['add', 'MINE.md'], clone.clonePath);
      git(['commit', '-m', 'my change'], clone.clonePath);
      const localAfterDiverge = gitOut(['rev-parse', 'HEAD'], clone.clonePath).trim();

      writeFileSync(path.join(otherWork, 'THEIRS2.md'), 'theirs2\n', 'utf8');
      git(['add', 'THEIRS2.md'], otherWork);
      git(['commit', '-m', 'their second change'], otherWork);
      git(['push', 'origin', 'main'], otherWork);

      const refused = await operations.syncBase(contextFor(clone.clonePath), {});
      assert.equal(refused.kind, 'precondition');
      assert.match(refused.summary, /diverged/);
      // Refused means untouched: the local commit is still there. There is no
      // reset, rebase or force path out of a divergence on this interface.
      assert.equal(gitOut(['rev-parse', 'HEAD'], clone.clonePath).trim(), localAfterDiverge);

      rmSync(otherDir, { recursive: true, force: true });
    } finally {
      mount.cleanup();
      clone.cleanup();
    }
  });
});

test('a credential reference not permitted to reach the remote refuses with authorization, before any network call', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    await migratedVolume(volumeRoot);
    const clone = realClone();
    const mount = secretsMount(SECRET, { [REF]: ['github.com'] });
    try {
      const credentialEnv = new Map<EnvVarName, string>();
      const exec = createExec({ volumeRoot, credentialEnv });
      const argvSeen: (readonly string[])[] = [];
      const recordingExec = {
        runGit: (request: ExecRequest) => {
          argvSeen.push(request.argv);
          return exec.runGit(request);
        },
      };
      const declaration = fixtureDeclaration(DECLARATION, 'https://example.invalid/owner/repo.git');
      const operations = createGitOperations({
        clock: systemClock,
        exec: recordingExec,
        locks: createLocks(),
        declarations: { get: async () => declaration },
        credentials: createCredentialResolver({ credentialMountRoot: mount.root, volumeRoot, clock: systemClock }),
        credentialEnv,
      });

      const result = await operations.fetch(contextFor(clone.clonePath), {});
      assert.equal(result.kind, 'authorization');
      assert.match(result.summary, /example\.invalid/);
      assert.equal(
        argvSeen.some((argv) => argv[0] === 'fetch'),
        false,
      );
    } finally {
      mount.cleanup();
      clone.cleanup();
    }
  });
});
