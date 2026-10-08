/**
 * S52 — a watcher against a real repository.
 *
 * Everything between the watcher and Git is the production composition: the real
 * clone store, git operations, host operations, composites, module adapter and
 * dispatch pipeline over a real scratch clone of a real bare remote. The one
 * seam that is not real is the GitHub CLI: `runGh` is an in-process fixture that
 * speaks exactly the argv and JSON `github-adapter.ts` reads and writes, and
 * holds pull-request state. Merging a pull request advances the bare remote's
 * `main` with real Git, so `reconcile_after_merge` fetches a real merge commit.
 *
 * Test-only: nothing outside `*.test.ts` imports this.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { systemClock, type Clock } from '../../clock/clock.ts';
import { createStructuredStore, type StructuredStore } from '../../store/structured-store.ts';
import { withVolumeAsync } from '../../store/volume-fixture.ts';
import { createExec, type Exec, type ExecRequest, type ExecResult } from '../../exec/exec.ts';
import { execError } from '../../exec/errors.ts';
import { createLocks, type Locks } from '../../locks/locks.ts';
import { createAudit, type Audit } from '../../audit/audit.ts';
import type { AuditRecord } from '../../audit/types.ts';
import { createJournal } from '../../journal/journal.ts';
import { createDeclarations, type Declarations } from '../../declarations/declarations.ts';
import { createCloneStore, type CloneStore } from '../../clone/clone-store.ts';
import { createBareGitRemote } from '../../clone/testing/git-fixture.ts';
import type { Declaration } from '../../declarations/types.ts';
import type { DeploymentCeiling, DeclarationScopedCapability } from '../../contract/capabilities.ts';
import { fixtureTool, moduleTarget } from '../../contract/fixtures.ts';
import type { CompiledRegistry, ToolDeclaration } from '../../contract/tool-declaration.ts';
import { createModuleAdapter, toModuleHandler, type ModuleHandler } from '../../module-adapter/module-adapter.ts';
import { createGitOperations } from '../../git/git-operations.ts';
import { createCredentialResolver } from '../../credentials/credentials.ts';
import { prepareDeclarationCredential } from '../../credentials/declaration-credential.ts';
import type { BranchName, EnvVarName, GitSha, OperationId } from '../../shared/brands.ts';
import { authorization, success, validation } from '../../result/envelope.ts';
import { err, ok, type Outcome } from '../../shared/outcome.ts';
import type { CredentialBinding } from '../../exec/exec.ts';
import { createGitHubAdapter } from '../../host/github-adapter.ts';
import { createHostOperations } from '../../host/host-operations.ts';
import { createComposites } from '../../composites/composites.ts';
import { createNotifier } from '../../notifier/notifier.ts';
import { createDispatchPipeline, type Dispatch, type ParkSink, type TerminalSink } from '../../dispatch/dispatch-pipeline.ts';
import { PRODUCTION_TOOL_DECLARATIONS } from '../../composition-root/production-declarations.ts';
import { createWatcher, type Watcher } from '../watcher.ts';

// ---------------------------------------------------------------------------
// Platform prerequisites (S52.4)
// ---------------------------------------------------------------------------

/**
 * Whether this host can create a symbolic link to a directory, and if not, why.
 * Windows refuses it to an unelevated process without Developer Mode; a test
 * that needs one is skipped with this reason rather than passing vacuously.
 */
export function symlinkSkipReason(): string | null {
  const probe = mkdtempSync(path.join(tmpdir(), 'szg-symlink-probe-'));
  try {
    mkdirSync(path.join(probe, 'target'));
    symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), 'dir');
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return `this host cannot create a directory symlink (${code}); needs an elevated process or Developer Mode on Windows`;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** The recorded reason for a skipped test, or `false` so `{ skip }` options read naturally. */
export const SYMLINKS_UNAVAILABLE: string | false = symlinkSkipReason() ?? false;

/**
 * Creates a directory symlink at `linkPath`, or returns the reason it could not.
 * The caller records that reason as its skip, so a skip is never silent.
 */
export function tryDirectorySymlink(target: string, linkPath: string): string | null {
  try {
    symlinkSync(target, linkPath, 'dir');
    return null;
  } catch (error) {
    return `symlink creation refused (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`;
  }
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export interface TestClock extends Clock {
  /** Pins `now()` to one instant, so two terminal moves land on the same name prefix. */
  freeze(at?: string): void;
  thaw(): void;
}

function createTestClock(): TestClock {
  let frozen: ReturnType<Clock['now']> | null = null;
  return {
    now: () => frozen ?? systemClock.now(),
    monotonicMs: () => systemClock.monotonicMs(),
    freeze(at) {
      frozen = (at ?? new Date().toISOString()) as ReturnType<Clock['now']>;
    },
    thaw() {
      frozen = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The GitHub CLI shim
// ---------------------------------------------------------------------------

export interface FixturePullRequest {
  readonly number: number;
  readonly branch: string;
  headSha: string;
  readonly baseSha: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergeCommit: string | null;
  autoMerge: boolean;
}

export interface GhFixture {
  /** Every `gh` argv the production code ran, in order. */
  readonly argvLog: string[][];
  readonly pullRequests: Map<number, FixturePullRequest>;
  /** The next call whose argv (space-joined) matches fails with this stderr, `times` times. */
  failWhen(pattern: RegExp, stderr: string, times?: number): void;
  /** Merges on the "host": advances the bare remote's `main` to the PR head and marks the PR merged. */
  merge(number: number): void;
  close(number: number): void;
  /** Someone else pushes to the pull request's branch after the watcher did: a real commit on the remote, and the host's head moves with it. */
  moveHead(number: number): string;
  run(request: ExecRequest): Promise<Outcome<ExecResult, ReturnType<typeof execError>>>;
}

function git(cwd: string, argv: readonly string[]): string {
  const result = spawnSync('git', [...argv], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function createGhFixture(remote: string): GhFixture {
  const argvLog: string[][] = [];
  const pullRequests = new Map<number, FixturePullRequest>();
  const failures: { pattern: RegExp; stderr: string; remaining: number }[] = [];
  let nextNumber = 1;

  const view = (pr: FixturePullRequest) => ({
    number: pr.number,
    url: `https://github.com/fixture/repo/pull/${pr.number}`,
    headRefName: pr.branch,
    headRefOid: pr.headSha,
    baseRefOid: pr.baseSha,
    state: pr.state,
    mergeCommit: pr.mergeCommit === null ? null : { oid: pr.mergeCommit },
    mergeable: 'MERGEABLE',
    autoMergeRequest: pr.autoMerge ? { enabledAt: 'fixture' } : null,
  });

  const done = (stdout: string): Outcome<ExecResult, ReturnType<typeof execError>> =>
    ok({ exitCode: 0, stdout, stderr: '', durationMs: 0, timedOut: false });
  const fail = (stderr: string): Outcome<ExecResult, ReturnType<typeof execError>> =>
    err(execError({ code: 'nonzero-exit', exitCode: 1, stdout: '', stderr }, `gh exited 1: ${stderr}`));
  const valueOf = (argv: readonly string[], flag: string): string | null => {
    const at = argv.indexOf(flag);
    return at >= 0 && at + 1 < argv.length ? argv[at + 1]! : null;
  };

  return {
    argvLog,
    pullRequests,
    failWhen(pattern, stderr, times = 1) {
      failures.push({ pattern, stderr, remaining: times });
    },
    merge(number) {
      const pr = pullRequests.get(number);
      if (!pr) throw new Error(`no fixture pull request ${number}`);
      git(remote, ['update-ref', 'refs/heads/main', pr.headSha]);
      pr.state = 'MERGED';
      pr.mergeCommit = pr.headSha;
    },
    moveHead(number) {
      const pr = pullRequests.get(number);
      if (!pr) throw new Error(`no fixture pull request ${number}`);
      const tree = git(remote, ['rev-parse', `${pr.headSha}^{tree}`]);
      const moved = git(remote, ['-c', 'user.name=other', '-c', 'user.email=other@example.com', 'commit-tree', tree, '-p', pr.headSha, '-m', 'someone else pushed']);
      git(remote, ['update-ref', `refs/heads/${pr.branch}`, moved]);
      pr.headSha = moved;
      return moved;
    },
    close(number) {
      const pr = pullRequests.get(number);
      if (!pr) throw new Error(`no fixture pull request ${number}`);
      pr.state = 'CLOSED';
    },
    async run(request) {
      const argv = [...request.argv];
      argvLog.push(argv);
      const joined = argv.join(' ');
      const injected = failures.find((f) => f.remaining > 0 && f.pattern.test(joined));
      if (injected) {
        injected.remaining -= 1;
        return fail(injected.stderr);
      }

      if (argv[0] === 'pr' && argv[1] === 'create') {
        const head = valueOf(argv, '--head');
        if (head === null) return fail('fixture: --head is required');
        const headSha = git(remote, ['rev-parse', `refs/heads/${head}`]);
        const baseSha = git(remote, ['rev-parse', 'refs/heads/main']);
        const pr: FixturePullRequest = { number: nextNumber, branch: head, headSha, baseSha, state: 'OPEN', mergeCommit: null, autoMerge: false };
        nextNumber += 1;
        pullRequests.set(pr.number, pr);
        return done(`https://github.com/fixture/repo/pull/${pr.number}\n`);
      }
      if (argv[0] === 'pr' && argv[1] === 'view') {
        const pr = pullRequests.get(Number(argv[2]));
        if (!pr) return fail('GraphQL: Could not resolve to a PullRequest (HTTP 404) not found');
        if (valueOf(argv, '--json') === 'comments') return done(JSON.stringify({ comments: [] }));
        return done(JSON.stringify(view(pr)));
      }
      if (argv[0] === 'pr' && argv[1] === 'list') {
        const wanted = valueOf(argv, '--state') ?? 'all';
        const rows = [...pullRequests.values()].filter((pr) => wanted === 'all' || pr.state.toLowerCase() === wanted);
        return done(JSON.stringify(rows.map(view)));
      }
      if (argv[0] === 'pr' && argv[1] === 'merge') {
        const pr = pullRequests.get(Number(argv[2]));
        if (!pr) return fail('not found');
        const expected = valueOf(argv, '--match-head-commit');
        if (expected !== null && expected !== pr.headSha) return fail('Head branch was modified. Review and try the merge again.');
        pr.autoMerge = true;
        return done('');
      }
      return fail(`fixture: unsupported gh invocation: ${joined}`);
    },
  };
}

// ---------------------------------------------------------------------------
// The plan and apply tools (the declaration-selected pair)
// ---------------------------------------------------------------------------

const PLAN_TOOL = 'watch_plan';
const APPLY_TOOL = 'watch_apply';

export interface FixturePlan {
  readonly branch: string;
  readonly commitMessage: string;
  readonly pullRequest: { readonly title: string; readonly body: string };
  readonly permittedPaths: readonly string[];
  readonly writes: readonly { readonly path: string; readonly content: string }[];
}

/** The default plan: one file under `content/` named after the dropped file. */
function defaultPlan(sourceFile: string, content: string, serial: number): FixturePlan {
  const target = `content/${sourceFile}`;
  return {
    branch: `watcher/${sourceFile.replace(/\.[^.]+$/, '')}-${serial}`,
    commitMessage: `watcher: ${sourceFile}`,
    pullRequest: { title: `watcher: ${sourceFile}`, body: `Delivered from ${sourceFile}.` },
    permittedPaths: [target],
    writes: [{ path: target, content }],
  };
}

const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    commitMessage: { type: 'string' },
    pullRequest: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
    permittedPaths: { type: 'array', items: { type: 'string' } },
    plan: { type: 'object', properties: { writes: { type: 'array' } }, required: ['writes'] },
  },
  required: ['branch', 'commitMessage', 'pullRequest', 'permittedPaths', 'plan'],
} as never;

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export interface DispatchRecord {
  readonly tool: string;
  /** The global mutation holder when the watcher handed the call to dispatch, and when it came back. */
  readonly heldBefore: string | null;
  readonly heldAfter: string | null;
  readonly ok: boolean;
}

export interface HandlerRecord {
  readonly target: string;
  /** The operation holding the global mutation lock when the handler started, or null. */
  readonly holderOperationId: string | null;
  readonly operationId: string;
}

export interface OutboxRow {
  readonly id: string;
  readonly severity: string;
  readonly declarationId: string | null;
  readonly status: string;
  readonly payload: Record<string, unknown>;
}

export interface RealRepo {
  readonly volume: string;
  readonly remote: string;
  readonly declaration: Declaration;
  readonly clock: TestClock;
  readonly gh: GhFixture;
  readonly locks: Locks;
  readonly audit: Audit;
  readonly store: StructuredStore;
  readonly cloneStore: CloneStore;
  readonly declarations: Declarations;
  readonly watcher: Watcher;
  readonly dispatchLog: DispatchRecord[];
  readonly handlerLog: HandlerRecord[];
  readonly inboxRoot: string;
  /** Runs once, synchronously, right after the next dispatch of `tool` returns: a fault injected between two steps of one tick. */
  afterNext(tool: string, action: () => void): void;
  /** Writes a file into the inbox. */
  drop(name: string, content: string): string;
  /** The clone's working tree, once materialised. */
  cloneRoot(): string;
  /** Runs real Git in the clone. */
  gitInClone(argv: readonly string[]): string;
  /** Runs real Git against the bare remote. */
  gitInRemote(argv: readonly string[]): string;
  /** Materialises the clone ahead of a tick, so a test can dirty it. */
  materialise(): Promise<void>;
  auditRecords(form: string): Promise<readonly AuditRecord[]>;
  outbox(): OutboxRow[];
  pendingRecordPath(): string;
  /** Replaces the planner for the next files dropped. */
  setPlanner(planner: (sourceFile: string, content: string) => FixturePlan): void;
  listDir(relative: string): string[];
}

export interface RealRepoOptions {
  readonly autoMerge?: boolean;
}

const GRANT: readonly DeclarationScopedCapability[] = ['repo.read', 'git.local.write', 'git.remote.write', 'host.pr.write', 'host.pr.read'] as unknown as readonly DeclarationScopedCapability[];

const TOOL_NAMES = new Set([
  'repo_status',
  'git_stage',
  'git_commit',
  'git_push',
  'pr_open',
  'pr_status',
  'pr_enable_auto_merge',
  'prepare_branch',
  'reconcile_after_merge',
]);

export async function withRealRepo<T>(options: RealRepoOptions, fn: (repo: RealRepo) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const clock = createTestClock();
    const store = createStructuredStore({ volumeRoot: volume, clock });
    await store.open();
    await store.migrate();

    const mountRoot = mkdtempSync(path.join(tmpdir(), 'szg-real-repo-mount-'));
    writeFileSync(path.join(mountRoot, 'unused'), 'fixture-secret-value', 'utf8');
    const remote = createBareGitRemote();
    const gh = createGhFixture(remote);

    try {
      const credentialEnv = new Map<EnvVarName, string>();
      const realExec = createExec({ volumeRoot: volume, credentialEnv });
      const exec: Exec = { ...realExec, runGh: (request) => gh.run(request) as ReturnType<Exec['runGh']> };
      const locks = createLocks();
      const audit = createAudit({ volumeRoot: volume, clock });
      const journal = createJournal({ volumeRoot: volume, clock });
      const credentials = createCredentialResolver({ credentialMountRoot: mountRoot, volumeRoot: volume, clock, audit });

      const ceiling = new Set(GRANT) as unknown as DeploymentCeiling;
      const declaration: Declaration = {
        id: 'repo-a' as Declaration['id'],
        generation: 1 as Declaration['generation'],
        cloneUrl: remote as Declaration['cloneUrl'],
        host: 'generic',
        credentialRef: null as unknown as Declaration['credentialRef'],
        capabilityGrant: new Set(GRANT) as unknown as Declaration['capabilityGrant'],
        writablePathPrefixes: ['content/'] as unknown as Declaration['writablePathPrefixes'],
        pinned: false,
        fileWatcher: { planTool: PLAN_TOOL as never, applyTool: APPLY_TOOL as never, autoMerge: options.autoMerge ?? false },
        identity: { gitUserName: 'fixture', gitUserEmail: 'fixture@example.com' },
        state: 'active',
        grantEpoch: 0 as Declaration['grantEpoch'],
        createdAt: clock.now(),
        updatedAt: clock.now(),
      };
      const real = createDeclarations({
        volumeRoot: volume,
        clock,
        remoteHostAllowlist: [],
        ceiling,
        cloneAdoptionCheck: () => ({ observedRemote: async () => ({ cloneExists: false }), isSafeToAdopt: async () => ({ safe: true }) }),
      });
      const declarations: Declarations = {
        ...real,
        async get(id) {
          return id === declaration.id ? declaration : null;
        },
        async list(filter) {
          const matches = (filter.state === null || declaration.state === filter.state) && (filter.hasFileWatcher === null || (declaration.fileWatcher !== null) === filter.hasFileWatcher);
          return matches ? [declaration] : [];
        },
      };

      const cloneStore = createCloneStore({ volumeRoot: volume, clock, exec, locks, declarations, credentials, credentialEnv, journal, store, audit });
      const parkSink: ParkSink = new Map();
      const terminalSink: TerminalSink = new Map();
      const gitOperations = createGitOperations({ clock, exec, locks, audit, journal, declarations, credentials, credentialEnv, cloneStore, parkSink });
      const notifier = createNotifier({ volumeRoot: volume, clock, webhookUrl: null, audit });

      const handlerLog: HandlerRecord[] = [];
      const moduleAdapter = createModuleAdapter();
      const register = (target: string, handler: ModuleHandler): void => {
        moduleAdapter.register(target as never, async (ctx, input) => {
          handlerLog.push({ target, holderOperationId: (locks.currentMutationHolder()?.operationId as string | undefined) ?? null, operationId: ctx.operationId as string });
          return handler(ctx, input);
        });
      };
      register('git.status', toModuleHandler(gitOperations.status));
      register('git.stage', toModuleHandler(gitOperations.stage));
      register('git.commit', toModuleHandler(gitOperations.commit));
      register('git.push', toModuleHandler(gitOperations.push));
      register('git.fetch', toModuleHandler(gitOperations.fetch));
      register('git.syncBase', toModuleHandler(gitOperations.syncBase));

      const hostCredentialBindings = new Map<OperationId, CredentialBinding | null>();
      const hostAdapter = createGitHubAdapter({
        clock,
        exec,
        credentialFor: (ctx) => hostCredentialBindings.get(ctx.operationId) ?? null,
        baseBranchFor: async (ctx) => {
          const config = await gitOperations.loadRepositoryConfig(ctx);
          return config.ok ? (config.value.baseBranch as BranchName) : null;
        },
        sleep: async () => {},
      });
      const hostOperations = createHostOperations({
        clock,
        adapter: hostAdapter,
        journal,
        prepareCredential: async (ctx) => {
          const prepared = await prepareDeclarationCredential({ declarations, credentials, credentialEnv }, ctx);
          return prepared.ok ? ok(prepared.value.credential) : err(prepared.error);
        },
        credentialBindings: hostCredentialBindings,
        credentials,
        terminalSink,
        parkSink,
        headShaFor: async (ctx) => {
          if (ctx.cloneRoot === null) return null;
          const head = await exec.runGit({ argv: ['rev-parse', 'HEAD'], cwd: ctx.cloneRoot, timeoutSeconds: 30, credential: null, signal: ctx.signal });
          if (!head.ok) return null;
          const sha = head.value.stdout.trim();
          return sha.length > 0 ? (sha as GitSha) : null;
        },
        requiredChecksFor: async (ctx) => {
          const config = await gitOperations.loadRepositoryConfig(ctx);
          return config.ok ? config.value.requiredChecks : null;
        },
      });
      register('host.createPullRequest', toModuleHandler(hostOperations.createPullRequest));
      register('host.readPullRequest', toModuleHandler(hostOperations.readPullRequest));
      register('host.listPullRequests', toModuleHandler(hostOperations.listPullRequests));
      register('host.readPullRequestComments', toModuleHandler(hostOperations.readPullRequestComments));
      register('host.enableAutoMerge', toModuleHandler(hostOperations.enableAutoMerge));
      register('host.readChecks', toModuleHandler(hostOperations.readChecks));
      register('host.awaitChecks', toModuleHandler(hostOperations.awaitChecks));

      const composites = createComposites({ clock, exec, gitOperations, hostOperations, journal, parkSink });
      register('composites.prepareBranch', toModuleHandler(composites.prepareBranch));
      register('composites.reconcileAfterMerge', toModuleHandler(composites.reconcileAfterMerge));

      // The declaration-selected pair. The plan reads nothing from Git; the
      // apply writes inside the clone only after `validateWritePath` allows it.
      let serial = 0;
      let planner: (sourceFile: string, content: string) => FixturePlan = (sourceFile, content) => {
        serial += 1;
        return defaultPlan(sourceFile, content, serial);
      };
      register('watch.plan', async (ctx, rawInput) => {
        const input = rawInput as { sourceFile: string; content: string };
        const plan = planner(input.sourceFile, input.content);
        return success(
          'planned',
          { branch: plan.branch, commitMessage: plan.commitMessage, pullRequest: plan.pullRequest, permittedPaths: [...plan.permittedPaths].sort(), plan: { writes: plan.writes } },
          { operationId: ctx.operationId, declarationId: ctx.declarationId, generation: ctx.generation, durationMs: 0 },
        );
      });
      register('watch.apply', async (ctx, rawInput) => {
        const input = rawInput as { permittedPaths: string[]; plan: { writes: { path: string; content: string }[] } };
        for (const write of input.plan.writes) {
          const allowed = gitOperations.validateWritePath(ctx, write.path);
          if (!allowed.ok) {
            return allowed.error.kind === 'malformed' ? validation('malformed watcher path', []) : authorization('watcher path outside declaration allowlist', []);
          }
          if (!input.permittedPaths.includes(allowed.value)) return authorization('watcher path outside its plan', []);
        }
        for (const write of input.plan.writes) {
          const target = path.join(ctx.cloneRoot!, write.path);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, write.content, 'utf8');
        }
        const changedPaths = input.plan.writes.map((write) => write.path).sort();
        return success('applied', { changedPaths }, { operationId: ctx.operationId, declarationId: ctx.declarationId, generation: ctx.generation, durationMs: 0 });
      });

      const planEntry = fixtureTool({
        name: PLAN_TOOL,
        target: moduleTarget('watch.plan'),
        scopes: ['write'],
        capabilities: [],
        executionClass: 'read',
        annotations: { schedulable: false, fileWatcher: 'plan', untrustedOutput: true },
        inputSchema: { type: 'object', properties: { sourceFile: { type: 'string' }, content: { type: 'string' } }, required: ['sourceFile', 'content'] } as never,
        outputSchema: PLAN_OUTPUT_SCHEMA,
      });
      const applyEntry = fixtureTool({
        name: APPLY_TOOL,
        target: moduleTarget('watch.apply'),
        scopes: ['write'],
        capabilities: ['git.local.write'],
        executionClass: 'mutating',
        annotations: { schedulable: false, fileWatcher: 'apply', untrustedOutput: true },
        inputSchema: { type: 'object', properties: { permittedPaths: { type: 'array', items: { type: 'string' } }, plan: { type: 'object' } }, required: ['permittedPaths', 'plan'] } as never,
        outputSchema: { type: 'object', properties: { changedPaths: { type: 'array', items: { type: 'string' } } }, required: ['changedPaths'] } as never,
      });
      const entries: readonly ToolDeclaration[] = [...PRODUCTION_TOOL_DECLARATIONS.filter((entry) => TOOL_NAMES.has(entry.name as string)), planEntry, applyEntry];
      const contractCapabilitySet = new Set(entries.flatMap((entry) => entry.capabilities)) as unknown as CompiledRegistry['contractCapabilitySet'];
      const registry: CompiledRegistry = { fingerprint: 'a'.repeat(64) as never, compiledAt: clock.now(), entries, contractCapabilitySet };

      const pipeline = createDispatchPipeline({
        registry,
        ceiling,
        moduleAdapter,
        declarations,
        cloneStore,
        locks,
        audit,
        journal,
        exec,
        clock,
        terminalSink,
        parkSink,
        notifier,
        store,
      });

      const dispatchLog: DispatchRecord[] = [];
      const afterHooks = new Map<string, () => void>();
      const dispatch: Dispatch = async (request) => {
        const heldBefore = (locks.currentMutationHolder()?.operationId as string | undefined) ?? null;
        const result = await pipeline.dispatch(request);
        const heldAfter = (locks.currentMutationHolder()?.operationId as string | undefined) ?? null;
        dispatchLog.push({ tool: request.toolName as string, heldBefore, heldAfter, ok: result.ok });
        const hook = afterHooks.get(request.toolName as string);
        if (hook) {
          afterHooks.delete(request.toolName as string);
          hook();
        }
        return result;
      };

      const watcher = createWatcher({
        volumeRoot: volume,
        clock,
        dispatch,
        declarations,
        cloneStore,
        audit,
        notifier,
        store,
        contractCapabilitySet,
        remoteOperationsPermitted: true,
        watcherEnabled: true,
      });

      const inboxRoot = path.join(volume, 'watcher-inboxes', declaration.id as string);
      const cloneRootPath = (): string => {
        // `describe` is async; the clone path is deterministic enough to ask Git.
        throw new Error('replaced below');
      };
      void cloneRootPath;

      let resolvedCloneRoot: string | null = null;
      const repo: RealRepo = {
        volume,
        remote,
        declaration,
        clock,
        gh,
        locks,
        audit,
        store,
        cloneStore,
        declarations,
        watcher,
        dispatchLog,
        handlerLog,
        inboxRoot,
        afterNext(tool, action) {
          afterHooks.set(tool, action);
        },
        drop(name, content) {
          mkdirSync(inboxRoot, { recursive: true });
          const target = path.join(inboxRoot, name);
          writeFileSync(target, content, 'utf8');
          return target;
        },
        cloneRoot() {
          if (resolvedCloneRoot === null) throw new Error('clone not materialised yet; call materialise() or tick first');
          return resolvedCloneRoot;
        },
        gitInClone(argv) {
          return git(repo.cloneRoot(), argv);
        },
        gitInRemote(argv) {
          return git(remote, argv);
        },
        async materialise() {
          const holder = { operationId: 'setup' as never, declarationId: declaration.id, tool: 'setup' as never, heldSince: clock.now() };
          const ensured = await cloneStore.ensure(declaration, holder, new AbortController().signal);
          if (!ensured.ok) throw new Error(`clone did not materialise: ${ensured.error.summary}`);
          resolvedCloneRoot = ensured.value.clone.path as string;
          ensured.value.materialisationLock.release();
          ensured.value.activePin.release();
        },
        async auditRecords(form) {
          const page = await audit.query({ declarationId: null, tool: null, actorSubject: null, form: form as never, from: null, to: null, cursor: null, limit: 500 });
          if (!page.ok) throw new Error(`audit query failed: ${page.error.summary}`);
          return page.value.records;
        },
        outbox() {
          const db = new DatabaseSync(path.join(volume, 'store.sqlite'), { readOnly: true });
          try {
            const rows = db.prepare('SELECT id, severity, declaration_id, status, payload FROM notification_outbox ORDER BY created_at ASC, id ASC').all() as {
              id: string;
              severity: string;
              declaration_id: string | null;
              status: string;
              payload: string;
            }[];
            return rows.map((row) => ({ id: row.id, severity: row.severity, declarationId: row.declaration_id, status: row.status, payload: JSON.parse(row.payload) as Record<string, unknown> }));
          } finally {
            db.close();
          }
        },
        pendingRecordPath() {
          return path.join(volume, 'watcher-pending-pull-requests', `${declaration.id as string}.json`);
        },
        setPlanner(next) {
          planner = next;
        },
        listDir(relative) {
          const dir = path.join(inboxRoot, relative);
          return existsSync(dir) ? readdirSync(dir).sort() : [];
        },
      };

      return await fn(repo);
    } finally {
      rmSync(mountRoot, { recursive: true, force: true });
      await store.close();
      rmSync(path.dirname(remote), { recursive: true, force: true });
    }
  });
}
