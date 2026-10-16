import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { systemClock } from '../src/clock/clock.ts';
import { createAudit } from '../src/audit/audit.ts';
import { createStructuredStore } from '../src/store/structured-store.ts';
import { withVolumeAsync } from '../src/store/volume-fixture.ts';
import { createOperatorIdentity, PROVISIONING_FILENAME, TOTP_SEALING_KEY_FILENAME, writeProvisioningSecret, type OperatorIdentity } from '../src/operator-identity/operator-identity.ts';
import { createAuthorization } from '../src/authorization/authorization.ts';
import { createDeclarations } from '../src/declarations/declarations.ts';
import { createDispatchPipeline } from '../src/dispatch/dispatch-pipeline.ts';
import { inertJournal } from '../src/journal/testing/inert-journal.ts';
import { createModuleAdapter } from '../src/module-adapter/module-adapter.ts';
import { fixtureTool, httpTarget } from '../src/contract/fixtures.ts';
import { success } from '../src/result/envelope.ts';
import { createStubCloneStore } from '../src/clone/testing/stub-clone-store.ts';
import { createSurfacesServer, NO_CONSOLE_FINGERPRINT } from '../src/surfaces/http-server.ts';
import { createMcpRoutesState } from '../src/surfaces/mcp-routes.ts';
import type { GitSha, RemoteHost, Sha256Hex } from '../src/shared/brands.ts';
import type { ContractCapabilitySet, DeploymentCeiling } from '../src/contract/capabilities.ts';
import type { HttpAdapter } from '../src/http/http-adapter.ts';
import type { JsonValue } from '../src/contract/json.ts';
import {
  allowedHostsManifest,
  configWarnings,
  DeployError,
  enrolOperator,
  formatEnvFile,
  parseArgs,
  parseConfig,
  serviceEnvironment,
  signIn,
  signOut,
  syncDeclarations,
  waitForReady,
  type DeployConfig,
  type GitIdentity,
  type OperatorRecord,
  type RepositoryConfig,
} from './deploy.ts';

const FALLBACK: GitIdentity = { name: 'Fallback Name', email: 'fallback@example.com' };

function accepted(raw: unknown, fallback: GitIdentity | null = FALLBACK): DeployConfig {
  const result = parseConfig(raw, fallback);
  assert.ok(result.ok, result.ok ? '' : result.findings.join('; '));
  return result.value;
}

function rejected(raw: unknown, fallback: GitIdentity | null = FALLBACK): readonly string[] {
  const result = parseConfig(raw, fallback);
  assert.ok(!result.ok, 'expected the config to be rejected');
  return result.findings;
}

// --- parseConfig: 6 accepted shapes ----------------------------------------

test('parseConfig accepts an empty config and fills every default', () => {
  const config = accepted({});
  assert.equal(config.port, 8080);
  assert.equal(config.publicOrigin, 'http://localhost:8080');
  assert.equal(config.remoteOperations, false);
  assert.equal(config.operator, 'admin');
  assert.deepEqual(config.repositories, []);
});

test('parseConfig derives a GitHub repository\'s host, credential, capabilities and identity', () => {
  const [repo] = accepted({ port: 9000, repositories: [{ id: 'my-app', cloneUrl: 'https://github.com/acme/my-app.git' }] }).repositories;
  assert.deepEqual(repo, {
    id: 'my-app',
    host: 'github',
    cloneUrl: 'https://github.com/acme/my-app.git',
    remoteHost: 'github.com',
    credential: 'my-app',
    tokenEnv: null,
    username: null,
    capabilities: ['repo.read'],
    writablePaths: [],
    gitIdentity: FALLBACK,
  });
});

test('parseConfig reads a scp-style URL on another host as generic', () => {
  const [repo] = accepted({ repositories: [{ id: 'infra', cloneUrl: 'git@gitlab.example.com:ops/infra.git' }] }).repositories;
  assert.equal(repo?.host, 'generic');
  assert.equal(repo?.remoteHost, 'gitlab.example.com');
});

test('parseConfig accepts a per-credential username, shared by repositories that agree on it', () => {
  const config = accepted({
    repositories: [
      { id: 'a', cloneUrl: 'https://gitlab.example.com/o/a.git', credential: 'gitlab', username: 'oauth2' },
      { id: 'b', cloneUrl: 'https://gitlab.example.com/o/b.git', credential: 'gitlab', username: 'oauth2' },
    ],
  });
  assert.deepEqual(config.repositories.map((r) => r.username), ['oauth2', 'oauth2']);
});

test('parseConfig prefers a repository identity over the top-level one, and the top-level one over git config', () => {
  const config = accepted({
    gitIdentity: { name: 'Top', email: 'top@example.com' },
    repositories: [
      { id: 'a', cloneUrl: 'https://github.com/o/a.git' },
      { id: 'b', cloneUrl: 'https://github.com/o/b.git', gitIdentity: { name: 'Bot', email: 'bot@example.com' } },
    ],
  });
  assert.equal(config.repositories[0]?.gitIdentity.name, 'Top');
  assert.equal(config.repositories[1]?.gitIdentity.name, 'Bot');
});

test('parseConfig passes extra environment through and sorts capabilities and paths', () => {
  const config = accepted({
    environment: { NOTIFIER_WEBHOOK_URL: 'https://hooks.example.com/x' },
    repositories: [{ id: 'docs', cloneUrl: 'https://github.com/o/docs.git', capabilities: ['git.local.write', 'repo.read', 'repo.read'], writablePaths: ['src/', 'content/'], tokenEnv: 'DOCS_TOKEN', credential: 'docs-token' }],
  });
  assert.deepEqual(config.environment, { NOTIFIER_WEBHOOK_URL: 'https://hooks.example.com/x' });
  assert.deepEqual(config.repositories[0]?.capabilities, ['git.local.write', 'repo.read']);
  assert.deepEqual(config.repositories[0]?.writablePaths, ['content/', 'src/']);
  assert.equal(config.repositories[0]?.credential, 'docs-token');
  assert.equal(config.repositories[0]?.tokenEnv, 'DOCS_TOKEN');
});

// --- parseConfig: 16 rejected shapes ---------------------------------------

const repo = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: 'app', cloneUrl: 'https://github.com/o/app.git', ...extra });

const REJECTIONS: ReadonlyArray<readonly [string, unknown, RegExp, GitIdentity | null]> = [
  ['a non-object config', [], /must be a JSON object/, FALLBACK],
  ['an unknown top-level setting', { prot: 8080 }, /prot: unknown setting/, FALLBACK],
  ['a port out of range', { port: 70_000 }, /port:/, FALLBACK],
  ['a public origin with a path', { publicOrigin: 'https://git.example.com/' }, /publicOrigin:/, FALLBACK],
  ['a derived variable in environment', { environment: { PUBLIC_ORIGIN: 'x' } }, /set by this script/, FALLBACK],
  ['a lower-case environment name', { environment: { lower: 'x' } }, /upper-case variable name/, FALLBACK],
  ['a multi-line environment value', { environment: { EXTRA: 'a\nb' } }, /single-line/, FALLBACK],
  ['a malformed repository id', { repositories: [repo({ id: 'My_App' })] }, /\.id: must match/, FALLBACK],
  ['a repository id declared twice', { repositories: [repo({}), repo({})] }, /declared twice/, FALLBACK],
  ['an unsupported clone URL', { repositories: [repo({ cloneUrl: 'http://github.com/o/app.git' })] }, /cloneUrl:/, FALLBACK],
  ['an unknown repository setting', { repositories: [repo({ branch: 'main' })] }, /branch: unknown setting/, FALLBACK],
  ['an empty capability list', { repositories: [repo({ capabilities: [] })] }, /at least one capability/, FALLBACK],
  ['a writable path that escapes the repository', { repositories: [repo({ writablePaths: ['../etc/'] })] }, /writablePaths: "\.\.\/etc\/"/, FALLBACK],
  ['an empty username', { repositories: [repo({ username: '' })] }, /username: must be a non-empty/, FALLBACK],
  ['one credential given two usernames', { repositories: [repo({ credential: 'shared', username: 'a' }), repo({ id: 'other', credential: 'shared' })] }, /shared with another repository that gives a different username/, FALLBACK],
  ['no git identity anywhere', { repositories: [repo({})] }, /gitIdentity: none set/, null],
];

for (const [label, raw, pattern, fallback] of REJECTIONS) {
  test(`parseConfig rejects ${label}`, () => {
    const findings = rejected(raw, fallback);
    assert.ok(findings.some((f) => pattern.test(f)), `no finding matched ${String(pattern)}: ${findings.join('; ')}`);
  });
}

test('parseConfig reports every finding at once rather than the first', () => {
  const findings = rejected({ port: 0, operator: '', repositories: [repo({ id: 'Bad', credential: 'bad', host: 'gitlab' })] });
  assert.equal(findings.length, 4, findings.join('; '));
});

// --- derived settings -------------------------------------------------------

test('serviceEnvironment derives the allowlist and ceiling from the repositories, no wider', () => {
  const config = accepted({
    port: 9090,
    publicOrigin: 'https://git.example.com',
    remoteOperations: true,
    environment: { EXTRA: 'value' },
    repositories: [
      { id: 'b', cloneUrl: 'git@gitlab.example.com:o/b.git', capabilities: ['repo.read', 'git.local.write'] },
      { id: 'a', cloneUrl: 'https://github.com/o/a.git', capabilities: ['repo.read', 'host.pr.read'] },
      { id: 'c', cloneUrl: 'https://github.com/o/c.git' },
    ],
  });
  assert.deepEqual(serviceEnvironment(config, 'f'.repeat(40)), {
    SZG_HOST_PORT: '9090',
    GIT_COMMIT_SHA: 'f'.repeat(40),
    PUBLIC_ORIGIN: 'https://git.example.com',
    REMOTE_HOST_ALLOWLIST: 'github.com,gitlab.example.com',
    DEPLOYMENT_CEILING: 'git.local.write,host.pr.read,repo.read',
    REMOTE_OPERATIONS_PERMITTED: 'true',
    EXTRA: 'value',
  });
});

test('allowedHostsManifest lists each configured credential for exactly the hosts of its repositories and keeps the rest', () => {
  const config = accepted({
    repositories: [
      { id: 'a', cloneUrl: 'https://github.com/o/a.git', credential: 'shared' },
      { id: 'b', cloneUrl: 'git@gitlab.example.com:o/b.git', credential: 'shared' },
      { id: 'c', cloneUrl: 'https://github.com/o/c.git' },
    ],
  });
  const existing = { shared: ['stale.example.com'], 'hand-kept': ['bitbucket.org'], broken: 'not-a-list' };
  assert.deepEqual(allowedHostsManifest(existing, config.repositories), {
    c: ['github.com'],
    'hand-kept': ['bitbucket.org'],
    shared: ['github.com', 'gitlab.example.com'],
  });
  assert.deepEqual(allowedHostsManifest(null, []), {});
});

test('formatEnvFile writes one KEY=value line per variable after a header', () => {
  assert.equal(formatEnvFile({ A: '1', B: 'x,y' }), '# Written by scripts/deploy.ts on every run; edit deploy.config.json instead.\nA=1\nB=x,y\n');
});

test('configWarnings flags remote capabilities without remote operations, and host.* on a generic host', () => {
  const warnings = configWarnings(accepted({
    repositories: [
      { id: 'a', cloneUrl: 'https://github.com/o/a.git', capabilities: ['repo.read', 'git.remote.write'] },
      { id: 'b', cloneUrl: 'git@gitlab.example.com:o/b.git', capabilities: ['host.pr.read'] },
    ],
  }));
  assert.equal(warnings.length, 2, warnings.join('; '));
  assert.match(warnings[0] ?? '', /a: grants git\.remote\.write but remoteOperations is false/);
  assert.match(warnings[1] ?? '', /b: host\.\* capabilities have no effect/);
  assert.deepEqual(configWarnings(accepted({ remoteOperations: true, repositories: [{ id: 'a', cloneUrl: 'https://github.com/o/a.git', capabilities: ['git.remote.write'] }] })), []);
});

test('parseArgs defaults to up and rejects an unknown argument', () => {
  assert.equal(parseArgs([]).command, 'up');
  assert.equal(parseArgs(['status']).command, 'status');
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['down', '--config', 'other.json']).configPath, path.resolve('other.json'));
  assert.throws(() => parseArgs(['--prune']), DeployError);
  assert.throws(() => parseArgs(['--config']), DeployError);
});

// --- the HTTP half, against a real running instance -------------------------

const CEILING = new Set(['repo.read', 'git.raw']) as unknown as ContractCapabilitySet;
const COMMIT = 'c'.repeat(40) as GitSha;
const NO_SECRETS_TO_SCRUB = { scrubJson: (value: JsonValue): JsonValue => value };
const STUB_HTTP_ADAPTER: Pick<HttpAdapter, 'invoke'> = {
  async invoke() {
    return success('ok', {}, { operationId: null, declarationId: null, generation: null, durationMs: 0 });
  },
};

async function buildIdentity(volume: string): Promise<OperatorIdentity> {
  const credentialMount = `${volume}/_credential-mount`;
  mkdirSync(credentialMount, { recursive: true });
  writeFileSync(`${credentialMount}/${TOTP_SEALING_KEY_FILENAME}`, randomBytes(32));
  const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
  await store.open();
  await store.migrate();
  await store.close();
  return createOperatorIdentity({ volumeRoot: volume, credentialMountRoot: credentialMount, clock: systemClock, audit: createAudit({ volumeRoot: volume, clock: systemClock }) });
}

async function withServer<T>(volume: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const identity = await buildIdentity(volume);
  const declarations = createDeclarations({
    volumeRoot: volume,
    clock: systemClock,
    remoteHostAllowlist: ['github.com'] as unknown as readonly RemoteHost[],
    ceiling: CEILING as unknown as DeploymentCeiling,
    cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
  });
  const authorization = createAuthorization({
    volumeRoot: volume,
    clock: systemClock,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as unknown as DeploymentCeiling,
    declarations,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
  });
  const readTool = fixtureTool({ name: 'repo_status', capabilities: ['repo.read'], scopes: ['read'], executionClass: 'read', target: httpTarget('t.read') });
  const dispatchPipeline = createDispatchPipeline({
    journal: inertJournal(),
    exec: NO_SECRETS_TO_SCRUB,
    registry: { fingerprint: 'a'.repeat(64) as never, compiledAt: systemClock.now(), entries: [readTool], contractCapabilitySet: CEILING as unknown as never },
    ceiling: CEILING as unknown as DeploymentCeiling,
    moduleAdapter: createModuleAdapter(),
    httpAdapter: STUB_HTTP_ADAPTER,
    declarations,
    cloneStore: createStubCloneStore(),
    locks: { pinActiveOperation: () => ({ release() {} }), acquireMutation: async () => ({ ok: true, value: { release() {} } }) } as never,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
    clock: systemClock,
  });
  const server = createSurfacesServer({
    commitSha: COMMIT,
    contractFingerprint: '1'.repeat(64) as Sha256Hex,
    consoleFingerprint: NO_CONSOLE_FINGERPRINT,
    ready: () => true,
    provisioningPending: async () => (await identity.provisioningState()) === 'pending',
    auditChain: async () => ({ verifiedThrough: null, headHash: null, mirroredHeadHash: null, retainedAnchors: [], chainBreak: null }),
    authorization,
    audit: createAudit({ volumeRoot: volume, clock: systemClock }),
    identity,
    sessionAbsoluteSeconds: 43_200,
    declarations,
    cloneStore: createStubCloneStore(),
    dispatchPipeline,
    contractCapabilitySet: CEILING,
    ceiling: CEILING as never,
    origin: 'http://localhost',
    mcpState: createMcpRoutesState(),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function enrol(volume: string, baseUrl: string): ReturnType<typeof enrolOperator> {
  return enrolOperator({
    baseUrl,
    subject: 'admin',
    writeProvisioningSecret: (secret) => writeProvisioningSecret(volume, secret),
    removeProvisioningSecret: () => rmSync(path.join(volume, PROVISIONING_FILENAME), { force: true }),
  });
}

function repository(extra: Partial<RepositoryConfig> = {}): RepositoryConfig {
  return {
    id: 'my-app',
    host: 'github',
    cloneUrl: 'https://github.com/acme/my-app.git',
    remoteHost: 'github.com',
    credential: 'my-app',
    tokenEnv: null,
    username: null,
    capabilities: ['repo.read'],
    writablePaths: [],
    gitIdentity: { name: 'Deploy Bot', email: 'bot@example.com' },
    ...extra,
  };
}

test('waitForReady returns once /healthz reports ready on the expected commit, and times out on another', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      await waitForReady(baseUrl, COMMIT, { timeoutMs: 2_000, intervalMs: 50 });
      await assert.rejects(waitForReady(baseUrl, 'd'.repeat(40), { timeoutMs: 200, intervalMs: 50 }), /did not become ready on dddddddddddd/);
    });
  });
});

test('enrol, sign in, declare; a re-run leaves it unchanged; a changed grant is amended; extra declarations are left alone', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const operator = await enrol(volume, baseUrl);
      assert.notEqual(operator, 'already-provisioned');
      const record = operator as OperatorRecord;
      assert.equal(record.subject, 'admin');
      assert.match(record.totpSecret, /^[A-Z2-7]+=*$/);
      assert.ok(record.recoveryCodes.length > 0);
      assert.equal(existsSync(path.join(volume, PROVISIONING_FILENAME)), false, 'a consumed provisioning secret is deleted by the service');

      const session = await signIn(baseUrl, record);
      const first = await syncDeclarations(baseUrl, session, [repository(), repository({ id: 'other', cloneUrl: 'https://github.com/acme/other.git', credential: 'other' })]);
      assert.deepEqual(first.results, [{ id: 'my-app', action: 'declared' }, { id: 'other', action: 'declared' }]);
      assert.deepEqual(first.unmanaged, []);

      const second = await syncDeclarations(baseUrl, session, [repository()]);
      assert.deepEqual(second.results, [{ id: 'my-app', action: 'unchanged' }]);
      assert.deepEqual(second.unmanaged, ['other']);

      const third = await syncDeclarations(baseUrl, session, [repository({ capabilities: ['git.raw', 'repo.read'], gitIdentity: { name: 'Renamed', email: 'bot@example.com' } })]);
      assert.deepEqual(third.results, [{ id: 'my-app', action: 'updated' }]);
      const fourth = await syncDeclarations(baseUrl, session, [repository({ capabilities: ['git.raw', 'repo.read'], gitIdentity: { name: 'Renamed', email: 'bot@example.com' } })]);
      assert.deepEqual(fourth.results, [{ id: 'my-app', action: 'unchanged' }], 'the amendment took effect on the service');

      await assert.rejects(syncDeclarations(baseUrl, session, [repository({ host: 'generic' })]), /host cannot change/);
      await assert.rejects(syncDeclarations(baseUrl, session, [repository({ id: 'too-wide', capabilities: ['git.remote.write'] })]), /declaring too-wide failed/);

      await signOut(baseUrl, session);
      await assert.rejects(syncDeclarations(baseUrl, session, [repository()]), /listing declarations failed/, 'a signed-out session is refused');
    });
  });
});

test('a second enrolment reports already-provisioned and removes the unconsumed secret', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      assert.notEqual(await enrol(volume, baseUrl), 'already-provisioned');
      assert.equal(await enrol(volume, baseUrl), 'already-provisioned');
      assert.equal(existsSync(path.join(volume, PROVISIONING_FILENAME)), false);
    });
  });
});

test('sign-in with a stale saved password fails with the reason', async () => {
  await withVolumeAsync(async (volume) => {
    await withServer(volume, async (baseUrl) => {
      const record = (await enrol(volume, baseUrl)) as OperatorRecord;
      await assert.rejects(signIn(baseUrl, { ...record, password: 'not-the-password' }), /sign-in failed: credentials-invalid \(the saved password no longer matches/);
    });
  });
});
