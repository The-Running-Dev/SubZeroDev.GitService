import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneUrlHost, credentialRef, declarationId, pathPrefix } from '../src/shared/brands.ts';
import { base32Decode, currentTotpCode } from '../src/operator-identity/totp.ts';
import { TOTP_SEALING_KEY_FILENAME } from '../src/operator-identity/operator-identity.ts';
import { ALLOWED_HOSTS_MANIFEST } from '../src/credentials/credentials.ts';

/**
 * One-command local deployment: `node scripts/deploy.ts` builds the image,
 * starts the container, enrols the first operator and declares every
 * repository named in `deploy.config.json`. Re-running it is safe — it
 * rebuilds, restarts, signs in with the saved operator, and declares or
 * amends only what changed.
 *
 * Everything an operator would otherwise derive by hand is derived here: the
 * remote host allowlist from the declared clone URLs, and the deployment
 * ceiling from the union of the declared capability grants, so the ceiling is
 * never wider than what some repository was actually given.
 *
 * Every file it writes is per-machine and gitignored: `deploy.config.json`
 * (created with defaults on first run), `credentials/` (the TOTP sealing key,
 * one token file per credential, and the manifest naming the hosts each
 * credential may reach), `.deploy/service.env` (the container's
 * environment) and `.deploy/operator.json`. The last one holds the operator's
 * password, TOTP secret and recovery codes — the price of a re-run that can
 * sign in unattended. Move them to a password manager if that trade is wrong
 * for the machine; the script then stops at sign-in rather than guessing.
 *
 * Never destructive: the sealing key is never overwritten (that would strand
 * every enrolled TOTP secret), a declaration missing from the config is left
 * alone rather than removed, and `down` keeps the data volume.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'git-service';
const DEFAULT_PORT = 8080;
const DEFAULT_SUBJECT = 'admin';
const DEFAULT_CAPABILITIES = ['repo.read'] as const;
const TOTP_ISSUER = 'SubZeroDev.Git';

/** Variables the script derives itself; setting one in `environment` would give the deployment two sources for it. */
const DERIVED_VARIABLES = new Set([
  'PORT',
  'PUBLIC_ORIGIN',
  'VOLUME_ROOT',
  'CREDENTIAL_MOUNT_ROOT',
  'GIT_COMMIT_SHA',
  'REMOTE_HOST_ALLOWLIST',
  'DEPLOYMENT_CEILING',
  'REMOTE_OPERATIONS_PERMITTED',
  'SZG_HOST_PORT',
]);
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TOP_LEVEL_KEYS = new Set(['port', 'publicOrigin', 'remoteOperations', 'operator', 'gitIdentity', 'environment', 'repositories']);
const REPOSITORY_KEYS = new Set(['id', 'cloneUrl', 'host', 'credential', 'tokenEnv', 'username', 'capabilities', 'writablePaths', 'gitIdentity']);

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface RepositoryConfig {
  readonly id: string;
  readonly host: 'github' | 'generic';
  readonly cloneUrl: string;
  readonly remoteHost: string;
  /** The credential reference: the file name under `credentials/`. */
  readonly credential: string;
  /** The environment variable the token is copied from, or `null` when the credential file is maintained by hand. */
  readonly tokenEnv: string | null;
  /** The username git presents with the token, or `null` for the service's default (`x-access-token`, which suits GitHub). */
  readonly username: string | null;
  readonly capabilities: readonly string[];
  readonly writablePaths: readonly string[];
  readonly gitIdentity: GitIdentity;
}

export interface DeployConfig {
  readonly port: number;
  readonly publicOrigin: string;
  readonly remoteOperations: boolean;
  readonly operator: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly repositories: readonly RepositoryConfig[];
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly findings: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string, findings: string[]): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    findings.push(`${field}: must be an array of strings`);
    return null;
  }
  return value as string[];
}

function parseIdentity(value: unknown, field: string, findings: string[]): GitIdentity | null {
  if (value === undefined) return null;
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.email !== 'string' || value.name === '' || value.email === '') {
    findings.push(`${field}: must be { "name": string, "email": string }, both non-empty`);
    return null;
  }
  return { name: value.name, email: value.email };
}

/**
 * Validates `deploy.config.json`, collecting every finding rather than
 * stopping at the first. Identifiers are checked with the service's own
 * validators (`src/shared/brands.ts`), so a config this accepts is one the
 * service's declaration route accepts too. `fallbackIdentity` is the host's
 * `git config user.name`/`user.email`, used when the config names none.
 */
export function parseConfig(raw: unknown, fallbackIdentity: GitIdentity | null): Parsed<DeployConfig> {
  const findings: string[] = [];
  if (!isRecord(raw)) return { ok: false, findings: ['config: must be a JSON object'] };

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) findings.push(`${key}: unknown setting`);
  }

  const port = raw.port ?? DEFAULT_PORT;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) findings.push('port: must be an integer from 1 to 65535');

  const publicOrigin = raw.publicOrigin ?? `http://localhost:${String(port)}`;
  if (typeof publicOrigin !== 'string' || !/^https?:\/\/[^/\s]+$/.test(publicOrigin)) findings.push('publicOrigin: must be an origin such as https://git.example.com, with no path or trailing slash');

  const remoteOperations = raw.remoteOperations ?? false;
  if (typeof remoteOperations !== 'boolean') findings.push('remoteOperations: must be true or false');

  const operator = raw.operator ?? DEFAULT_SUBJECT;
  if (typeof operator !== 'string' || operator === '') findings.push('operator: must be a non-empty string');

  const identityDefault = parseIdentity(raw.gitIdentity, 'gitIdentity', findings) ?? fallbackIdentity;

  const environment: Record<string, string> = {};
  if (raw.environment !== undefined) {
    if (!isRecord(raw.environment)) {
      findings.push('environment: must be an object of string values');
    } else {
      for (const [key, value] of Object.entries(raw.environment)) {
        if (!ENV_NAME_PATTERN.test(key)) findings.push(`environment.${key}: must be an upper-case variable name`);
        else if (DERIVED_VARIABLES.has(key)) findings.push(`environment.${key}: set by this script; use the matching setting instead`);
        else if (typeof value !== 'string' || /[\r\n]/.test(value)) findings.push(`environment.${key}: must be a single-line string`);
        else environment[key] = value;
      }
    }
  }

  const repositories: RepositoryConfig[] = [];
  const rawRepositories = raw.repositories ?? [];
  if (!Array.isArray(rawRepositories)) {
    findings.push('repositories: must be an array');
  } else {
    const seen = new Set<string>();
    const usernames = new Map<string, string | null>();
    rawRepositories.forEach((entry: unknown, index: number) => {
      const at = `repositories[${String(index)}]`;
      if (!isRecord(entry)) {
        findings.push(`${at}: must be an object`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!REPOSITORY_KEYS.has(key)) findings.push(`${at}.${key}: unknown setting`);
      }
      const before = findings.length;

      const id = typeof entry.id === 'string' ? entry.id : '';
      const idResult = declarationId(id);
      if (!idResult.ok) findings.push(`${at}.id: must match ${idResult.error.rule}`);
      else if (seen.has(id)) findings.push(`${at}.id: "${id}" is declared twice`);
      seen.add(id);

      const cloneUrl = typeof entry.cloneUrl === 'string' ? entry.cloneUrl : '';
      const remoteHost = cloneUrlHost(cloneUrl);
      if (remoteHost === null) findings.push(`${at}.cloneUrl: must be https://host/path or user@host:path`);

      const host = entry.host ?? (remoteHost === 'github.com' ? 'github' : 'generic');
      if (host !== 'github' && host !== 'generic') findings.push(`${at}.host: must be "github" or "generic"`);

      const credential = entry.credential ?? id;
      const credentialResult = typeof credential === 'string' ? credentialRef(credential) : null;
      if (!credentialResult?.ok) findings.push(`${at}.credential: must match ${credentialResult?.error.rule ?? 'a string'}`);

      const tokenEnv = entry.tokenEnv ?? null;
      if (tokenEnv !== null && (typeof tokenEnv !== 'string' || !ENV_NAME_PATTERN.test(tokenEnv))) findings.push(`${at}.tokenEnv: must be an upper-case variable name`);

      const username = entry.username ?? null;
      if (username !== null && (typeof username !== 'string' || username === '' || /[\r\n]/.test(username))) findings.push(`${at}.username: must be a non-empty single-line string`);
      if (typeof credential === 'string' && (username === null || typeof username === 'string')) {
        if (usernames.has(credential) && usernames.get(credential) !== username) findings.push(`${at}.username: credential "${credential}" is shared with another repository that gives a different username`);
        usernames.set(credential, username);
      }

      const capabilities = stringList(entry.capabilities, `${at}.capabilities`, findings) ?? [...DEFAULT_CAPABILITIES];
      if (capabilities.length === 0) findings.push(`${at}.capabilities: must name at least one capability`);

      const writablePaths = stringList(entry.writablePaths, `${at}.writablePaths`, findings) ?? [];
      for (const prefix of writablePaths) {
        const result = pathPrefix(prefix);
        if (!result.ok) findings.push(`${at}.writablePaths: "${prefix}" must match ${result.error.rule}`);
      }

      const gitIdentity = parseIdentity(entry.gitIdentity, `${at}.gitIdentity`, findings) ?? identityDefault;
      if (gitIdentity === null) findings.push(`${at}.gitIdentity: none set here, in the top-level gitIdentity, or in git config user.name/user.email`);

      if (findings.length > before || remoteHost === null || gitIdentity === null) return;
      repositories.push({
        id,
        host: host as RepositoryConfig['host'],
        cloneUrl,
        remoteHost,
        credential: credential as string,
        tokenEnv: tokenEnv as string | null,
        username: username as string | null,
        capabilities: [...new Set(capabilities)].sort(),
        writablePaths: [...new Set(writablePaths)].sort(),
        gitIdentity,
      });
    });
  }

  if (findings.length > 0) return { ok: false, findings };
  return {
    ok: true,
    value: {
      port: port as number,
      publicOrigin: publicOrigin as string,
      remoteOperations: remoteOperations as boolean,
      operator: operator as string,
      environment,
      repositories,
    },
  };
}

/** Advisory findings that do not stop a deploy but would surprise someone. */
export function configWarnings(config: DeployConfig): string[] {
  const warnings: string[] = [];
  const remoteCapabilities = new Set(['git.remote.write', 'host.pr.write']);
  for (const repo of config.repositories) {
    const remote = repo.capabilities.filter((c) => remoteCapabilities.has(c));
    if (remote.length > 0 && !config.remoteOperations) {
      warnings.push(`${repo.id}: grants ${remote.join(', ')} but remoteOperations is false, so push and pull-request operations will be refused`);
    }
    if (repo.host === 'generic' && repo.capabilities.some((c) => c.startsWith('host.'))) {
      warnings.push(`${repo.id}: host.* capabilities have no effect on a generic host`);
    }
  }
  return warnings;
}

/**
 * The container's environment and the compose file's interpolation values,
 * in one file (`docker-compose.yml` reads it as both `env_file` and
 * `--env-file`).
 */
export function serviceEnvironment(config: DeployConfig, commitSha: string): Record<string, string> {
  const hosts = [...new Set(config.repositories.map((r) => r.remoteHost))].sort();
  const ceiling = [...new Set(config.repositories.flatMap((r) => r.capabilities))].sort();
  return {
    SZG_HOST_PORT: String(config.port),
    GIT_COMMIT_SHA: commitSha,
    PUBLIC_ORIGIN: config.publicOrigin,
    REMOTE_HOST_ALLOWLIST: hosts.join(','),
    DEPLOYMENT_CEILING: ceiling.join(','),
    REMOTE_OPERATIONS_PERMITTED: String(config.remoteOperations),
    ...config.environment,
  };
}

/**
 * The credential mount's allowed-host manifest (`src/credentials/credentials.ts`):
 * a credential reaches no host it is not listed for, independently of the
 * deployment's allowlist. Each configured credential is listed for exactly
 * the hosts of the repositories that use it; entries for credentials the
 * config does not name are kept as they were, so a hand-maintained one
 * survives a run.
 */
export function allowedHostsManifest(existing: unknown, repositories: readonly RepositoryConfig[]): Record<string, string[]> {
  const manifest: Record<string, string[]> = {};
  if (isRecord(existing)) {
    for (const [ref, hosts] of Object.entries(existing)) {
      if (Array.isArray(hosts)) manifest[ref] = hosts.filter((h): h is string => typeof h === 'string');
    }
  }
  const derived = new Map<string, Set<string>>();
  for (const repo of repositories) {
    const hosts = derived.get(repo.credential) ?? new Set<string>();
    hosts.add(repo.remoteHost);
    derived.set(repo.credential, hosts);
  }
  for (const [ref, hosts] of derived) manifest[ref] = [...hosts].sort();
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
}

export function formatEnvFile(env: Readonly<Record<string, string>>): string {
  const lines = ['# Written by scripts/deploy.ts on every run; edit deploy.config.json instead.'];
  for (const [key, value] of Object.entries(env)) lines.push(`${key}=${value}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The HTTP half: enrolment, sign-in and declarations, over the service's own
// console routes. Every state-changing route checks Origin against Host, and
// every cookie route also wants the CSRF cookie echoed as `x-csrf-token`.
// ---------------------------------------------------------------------------

export interface OperatorRecord {
  readonly subject: string;
  readonly password: string;
  readonly totpSecret: string;
  readonly recoveryCodes: readonly string[];
  readonly enrolledAt: string;
}

export interface ConsoleSession {
  readonly cookie: string;
  readonly csrf: string;
}

export type SyncAction = 'declared' | 'updated' | 'unchanged';

export interface SyncResult {
  readonly id: string;
  readonly action: SyncAction;
}

export class DeployError extends Error {}

async function readError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: unknown; findings?: unknown };
    const findings = Array.isArray(body.findings) ? `: ${body.findings.join('; ')}` : '';
    return `${String(body.error ?? response.status)}${findings}`;
  } catch {
    return `${String(response.status)} ${text.slice(0, 200)}`;
  }
}

function cookieValue(setCookies: readonly string[], name: string): string | null {
  for (const header of setCookies) {
    if (header.startsWith(`${name}=`)) return header.split(';')[0]!.slice(name.length + 1);
  }
  return null;
}

/**
 * Enrols the first operator. `writeProvisioningSecret` puts the one-time
 * secret where the service reads it (inside the container's volume, for a
 * real deploy); `removeProvisioningSecret` cleans it up when an operator
 * already existed and the secret was never consumed.
 */
export async function enrolOperator(options: {
  readonly baseUrl: string;
  readonly subject: string;
  readonly writeProvisioningSecret: (secret: string) => void | Promise<void>;
  readonly removeProvisioningSecret: () => void | Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}): Promise<OperatorRecord | 'already-provisioned'> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const provisioningSecret = randomBytes(32).toString('base64url');
  const password = randomBytes(24).toString('base64url');
  await options.writeProvisioningSecret(provisioningSecret);

  const response = await fetchImpl(`${options.baseUrl}/auth/enrol`, {
    method: 'POST',
    headers: { Origin: options.baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provisioningSecret, subject: options.subject, password }),
  });
  if (!response.ok) {
    const error = await readError(response);
    await options.removeProvisioningSecret();
    if (error === 'already-provisioned') return 'already-provisioned';
    throw new DeployError(`enrolment failed: ${error}`);
  }
  const body = (await response.json()) as { totpSecret: string; recoveryCodes: string[] };
  return {
    subject: options.subject,
    password,
    totpSecret: body.totpSecret,
    recoveryCodes: body.recoveryCodes,
    enrolledAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export async function signIn(baseUrl: string, operator: OperatorRecord, fetchImpl: typeof fetch = fetch): Promise<ConsoleSession> {
  const totpCode = currentTotpCode(base32Decode(operator.totpSecret));
  const response = await fetchImpl(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: operator.subject, password: operator.password, totpCode }),
  });
  if (!response.ok) {
    const error = await readError(response);
    const hint =
      error === 'credentials-invalid' ? ' (the saved password no longer matches; the operator was changed outside this script)' :
      error === 'totp-reenrol-required' ? ' (re-enrol TOTP in the console, then update .deploy/operator.json)' :
      '';
    throw new DeployError(`sign-in failed: ${error}${hint}`);
  }
  const setCookies = response.headers.getSetCookie();
  const session = cookieValue(setCookies, 'szg_session');
  const csrf = cookieValue(setCookies, 'szg_csrf');
  if (session === null || csrf === null) throw new DeployError('sign-in returned no session cookie');
  return { cookie: `szg_session=${session}; szg_csrf=${csrf}`, csrf };
}

export async function signOut(baseUrl: string, session: ConsoleSession, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`${baseUrl}/auth/logout`, { method: 'POST', headers: sessionHeaders(baseUrl, session) });
}

function sessionHeaders(baseUrl: string, session: ConsoleSession): Record<string, string> {
  return { Origin: baseUrl, Cookie: session.cookie, 'x-csrf-token': session.csrf, 'Content-Type': 'application/json' };
}

interface DeclaredRow {
  readonly declaration: {
    readonly id: string;
    readonly host: string;
    readonly cloneUrl: string;
    readonly credentialRef: string;
    readonly capabilityGrant: readonly string[];
    readonly writablePathPrefixes: readonly string[];
    readonly identity: { readonly gitUserName: string; readonly gitUserEmail: string };
  };
}

function declarationBody(repo: RepositoryConfig): Record<string, unknown> {
  return {
    cloneUrl: repo.cloneUrl,
    credentialRef: repo.credential,
    capabilityGrant: repo.capabilities,
    writablePathPrefixes: repo.writablePaths,
    identity: { gitUserName: repo.gitIdentity.name, gitUserEmail: repo.gitIdentity.email },
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

function matches(row: DeclaredRow['declaration'], repo: RepositoryConfig): boolean {
  return (
    row.cloneUrl === repo.cloneUrl &&
    row.credentialRef === repo.credential &&
    sameList(row.capabilityGrant, repo.capabilities) &&
    sameList(row.writablePathPrefixes, repo.writablePaths) &&
    row.identity.gitUserName === repo.gitIdentity.name &&
    row.identity.gitUserEmail === repo.gitIdentity.email
  );
}

/**
 * Declares each configured repository that does not exist yet and amends
 * each one whose settings differ. A repository declared on the service but
 * absent from the config is reported back, never removed: removal revokes
 * grants and orphans a clone, which is an operator's decision, not a sync's.
 */
export async function syncDeclarations(
  baseUrl: string,
  session: ConsoleSession,
  repositories: readonly RepositoryConfig[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly results: readonly SyncResult[]; readonly unmanaged: readonly string[] }> {
  const listResponse = await fetchImpl(`${baseUrl}/declarations`, { headers: sessionHeaders(baseUrl, session) });
  if (!listResponse.ok) throw new DeployError(`listing declarations failed: ${await readError(listResponse)}`);
  const existing = new Map(((await listResponse.json()) as DeclaredRow[]).map((row) => [row.declaration.id, row.declaration]));

  const results: SyncResult[] = [];
  for (const repo of repositories) {
    const current = existing.get(repo.id);
    if (current === undefined) {
      const response = await fetchImpl(`${baseUrl}/declarations`, {
        method: 'POST',
        headers: sessionHeaders(baseUrl, session),
        body: JSON.stringify({ id: repo.id, host: repo.host, ...declarationBody(repo) }),
      });
      if (!response.ok) throw new DeployError(`declaring ${repo.id} failed: ${await readError(response)}`);
      results.push({ id: repo.id, action: 'declared' });
      continue;
    }
    if (current.host !== repo.host) {
      throw new DeployError(`${repo.id} is declared with host "${current.host}" and the config says "${repo.host}"; a declaration's host cannot change — remove it in the console first`);
    }
    if (matches(current, repo)) {
      results.push({ id: repo.id, action: 'unchanged' });
      continue;
    }
    const response = await fetchImpl(`${baseUrl}/declarations/${repo.id}`, {
      method: 'PATCH',
      headers: sessionHeaders(baseUrl, session),
      body: JSON.stringify(declarationBody(repo)),
    });
    if (!response.ok) throw new DeployError(`updating ${repo.id} failed: ${await readError(response)}`);
    results.push({ id: repo.id, action: 'updated' });
  }

  const configured = new Set(repositories.map((r) => r.id));
  const unmanaged = [...existing.keys()].filter((id) => !configured.has(id)).sort();
  return { results, unmanaged };
}

export async function waitForReady(
  baseUrl: string,
  expectedCommitSha: string,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${baseUrl}/healthz`);
      const body = (await response.json()) as { ready?: unknown; commitSha?: unknown };
      if (body.ready === true && body.commitSha === expectedCommitSha) return;
      last = `ready=${String(body.ready)} commitSha=${String(body.commitSha)}`;
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 1_000));
  }
  throw new DeployError(`the service did not become ready on ${expectedCommitSha.slice(0, 12)} (last /healthz: ${last})`);
}

// ---------------------------------------------------------------------------
// The host half: files, docker compose, and the command line.
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/deploy.ts [command] [--config <path>]

Commands:
  up       Build, start, enrol the first operator and declare repositories (default)
  down     Stop the service; the data volume is kept
  status   Show the container and its /healthz answer
  logs     Follow the service's logs

Settings live in deploy.config.json (created with defaults on first run).
See README.md for the format.`;

interface Paths {
  readonly config: string;
  readonly deployDir: string;
  readonly serviceEnv: string;
  readonly operator: string;
  readonly credentials: string;
}

function pathsFor(configPath: string): Paths {
  const deployDir = path.join(REPO_ROOT, '.deploy');
  return {
    config: configPath,
    deployDir,
    serviceEnv: path.join(deployDir, 'service.env'),
    operator: path.join(deployDir, 'operator.json'),
    credentials: path.join(REPO_ROOT, 'credentials'),
  };
}

function run(command: string, args: readonly string[], options: { readonly input?: string; readonly quiet?: boolean } = {}): { status: number; stdout: string } {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: options.input,
    stdio: options.quiet || options.input !== undefined ? 'pipe' : 'inherit',
  });
  if (result.error) throw new DeployError(`${command} could not be started: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

function compose(paths: Paths, args: readonly string[], options: { readonly input?: string; readonly quiet?: boolean } = {}): { status: number; stdout: string } {
  const envArgs = existsSync(paths.serviceEnv) ? ['--env-file', paths.serviceEnv] : [];
  return run('docker', ['compose', ...envArgs, ...args], options);
}

function gitValue(args: readonly string[]): string | null {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value === '' ? null : value;
}

function writePrivate(file: string, content: string | Buffer): void {
  writeFileSync(file, content, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no POSIX modes; the file inherits the folder's ACL.
  }
}

function loadConfig(paths: Paths): DeployConfig {
  if (!existsSync(paths.config)) {
    writeFileSync(paths.config, JSON.stringify({ port: DEFAULT_PORT, operator: DEFAULT_SUBJECT, remoteOperations: false, repositories: [] }, null, 2) + '\n');
    console.log(`Created ${path.relative(REPO_ROOT, paths.config)} with defaults and no repositories.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.config, 'utf8'));
  } catch (error) {
    throw new DeployError(`${paths.config} is not valid JSON: ${(error as Error).message}`);
  }
  const name = gitValue(['config', 'user.name']);
  const email = gitValue(['config', 'user.email']);
  const parsed = parseConfig(raw, name !== null && email !== null ? { name, email } : null);
  if (!parsed.ok) throw new DeployError(`${path.relative(REPO_ROOT, paths.config)} has ${String(parsed.findings.length)} problem(s):\n  ${parsed.findings.join('\n  ')}`);
  for (const warning of configWarnings(parsed.value)) console.warn(`warning: ${warning}`);
  return parsed.value;
}

function prepareCredentials(paths: Paths, config: DeployConfig): void {
  mkdirSync(paths.credentials, { recursive: true });
  const sealingKey = path.join(paths.credentials, TOTP_SEALING_KEY_FILENAME);
  if (!existsSync(sealingKey)) {
    writePrivate(sealingKey, randomBytes(32));
    console.log(`Generated credentials/${TOTP_SEALING_KEY_FILENAME}.`);
  }
  const missing: string[] = [];
  for (const repo of config.repositories) {
    const file = path.join(paths.credentials, repo.credential);
    const token = repo.tokenEnv !== null ? process.env[repo.tokenEnv] : undefined;
    if (token !== undefined && token !== '') {
      writePrivate(file, token.trim());
    } else if (!existsSync(file)) {
      missing.push(repo.tokenEnv !== null ? `${repo.id}: set ${repo.tokenEnv}, or write the token to credentials/${repo.credential}` : `${repo.id}: write the token to credentials/${repo.credential}`);
    }
  }
  if (missing.length > 0) throw new DeployError(`no access token for:\n  ${missing.join('\n  ')}`);

  for (const repo of config.repositories) {
    if (repo.username !== null) writePrivate(path.join(paths.credentials, `_${repo.credential}.username`), `${repo.username}\n`);
  }
  const manifestPath = path.join(paths.credentials, ALLOWED_HOSTS_MANIFEST);
  let existing: unknown = null;
  if (existsSync(manifestPath)) {
    try {
      existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new DeployError(`credentials/${ALLOWED_HOSTS_MANIFEST} is not valid JSON; fix or delete it`);
    }
  }
  writePrivate(manifestPath, JSON.stringify(allowedHostsManifest(existing, config.repositories), null, 2) + '\n');
}

function readOperator(paths: Paths): OperatorRecord | null {
  if (!existsSync(paths.operator)) return null;
  return JSON.parse(readFileSync(paths.operator, 'utf8')) as OperatorRecord;
}

function printEnrolment(config: DeployConfig, operator: OperatorRecord, paths: Paths): void {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${operator.subject}`);
  console.log(`
First operator enrolled. These are shown once here and saved to ${path.relative(REPO_ROOT, paths.operator)}:
  Console:      ${config.publicOrigin}
  Username:     ${operator.subject}
  Password:     ${operator.password}
  TOTP secret:  ${operator.totpSecret}
  TOTP URI:     otpauth://totp/${label}?secret=${operator.totpSecret}&issuer=${encodeURIComponent(TOTP_ISSUER)}
  Add the TOTP secret to an authenticator app to sign in to the console.
  The ten recovery codes are in the same file.`);
}

function printSummary(config: DeployConfig, results: readonly SyncResult[], unmanaged: readonly string[]): void {
  console.log(`\nSubZeroDev.Git is running at ${config.publicOrigin}`);
  for (const result of results) console.log(`  ${result.id}: ${result.action}`);
  for (const id of unmanaged) console.log(`  ${id}: declared on the service but not in the config; left as is`);
  if (config.repositories.length === 0) {
    console.log('  No repositories configured yet. Add them to deploy.config.json and run this again.');
    return;
  }
  console.log('\nConnect an MCP client to a repository, for example with Claude Code:');
  for (const repo of config.repositories) console.log(`  claude mcp add --transport http ${repo.id} ${config.publicOrigin}/mcp/${repo.id}`);
  console.log('The client opens an approval page on first connect; approve it while signed in to the console.');
}

async function up(paths: Paths): Promise<void> {
  if (run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true }).status !== 0) {
    throw new DeployError('Docker is not running, or the docker CLI is not on PATH.');
  }
  const config = loadConfig(paths);
  const commitSha = gitValue(['rev-parse', 'HEAD']);
  if (commitSha === null) throw new DeployError('git rev-parse HEAD failed; the image must be labelled with the commit it was built from.');
  if (gitValue(['status', '--porcelain']) !== null) console.warn(`warning: the working tree has uncommitted changes; the image is labelled ${commitSha.slice(0, 12)} but includes them`);

  prepareCredentials(paths, config);
  mkdirSync(paths.deployDir, { recursive: true });
  writePrivate(paths.serviceEnv, formatEnvFile(serviceEnvironment(config, commitSha)));

  console.log('Building and starting the container (the first build takes a few minutes)...');
  if (compose(paths, ['up', '--detach', '--build']).status !== 0) throw new DeployError('docker compose up failed; see the output above.');

  const baseUrl = `http://127.0.0.1:${String(config.port)}`;
  try {
    await waitForReady(baseUrl, commitSha);
  } catch (error) {
    compose(paths, ['logs', '--tail', '40', SERVICE]);
    throw error;
  }

  let operator = readOperator(paths);
  if (operator === null) {
    const secretPath = '/data/provisioning.secret';
    const enrolled = await enrolOperator({
      baseUrl,
      subject: config.operator,
      writeProvisioningSecret: (secret) => {
        if (compose(paths, ['exec', '-T', SERVICE, 'sh', '-c', `umask 077 && cat > ${secretPath}`], { input: secret }).status !== 0) {
          throw new DeployError('could not write the provisioning secret into the container');
        }
      },
      removeProvisioningSecret: () => {
        compose(paths, ['exec', '-T', SERVICE, 'rm', '-f', secretPath], { quiet: true });
      },
    });
    if (enrolled === 'already-provisioned') {
      console.log(`\nThe service is running at ${config.publicOrigin}, but an operator already exists and ${path.relative(REPO_ROOT, paths.operator)} is missing.`);
      if (config.repositories.length > 0) {
        throw new DeployError('cannot declare repositories without the operator\'s sign-in; restore .deploy/operator.json, or declare them in the console');
      }
      return;
    }
    operator = enrolled;
    writePrivate(paths.operator, JSON.stringify(operator, null, 2) + '\n');
    printEnrolment(config, operator, paths);
  }

  const session = await signIn(baseUrl, operator);
  try {
    const { results, unmanaged } = await syncDeclarations(baseUrl, session, config.repositories);
    printSummary(config, results, unmanaged);
  } finally {
    await signOut(baseUrl, session).catch(() => undefined);
  }
}

async function status(paths: Paths): Promise<void> {
  compose(paths, ['ps']);
  const config = loadConfig(paths);
  try {
    const response = await fetch(`http://127.0.0.1:${String(config.port)}/healthz`);
    console.log(`/healthz: ${await response.text()}`);
  } catch (error) {
    console.log(`/healthz: unreachable (${(error as Error).message})`);
  }
}

export function parseArgs(argv: readonly string[]): { readonly command: 'up' | 'down' | 'status' | 'logs' | 'help'; readonly configPath: string } {
  let command: 'up' | 'down' | 'status' | 'logs' | 'help' = 'up';
  let configPath = path.join(REPO_ROOT, 'deploy.config.json');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined) throw new DeployError('--config needs a path');
      configPath = path.resolve(value);
    } else if (arg === '--help' || arg === '-h' || arg === 'help') {
      command = 'help';
    } else if (arg === 'up' || arg === 'down' || arg === 'status' || arg === 'logs') {
      command = arg;
    } else {
      throw new DeployError(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return { command, configPath };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const { command, configPath } = parseArgs(process.argv.slice(2));
    const paths = pathsFor(configPath);
    if (command === 'help') console.log(USAGE);
    else if (command === 'up') await up(paths);
    else if (command === 'status') await status(paths);
    else if (command === 'down') process.exitCode = compose(paths, ['down']).status;
    else process.exitCode = compose(paths, ['logs', '--follow', '--tail', '100', SERVICE]).status;
  } catch (error) {
    console.error(error instanceof DeployError ? `error: ${error.message}` : error);
    process.exitCode = 1;
  }
}
