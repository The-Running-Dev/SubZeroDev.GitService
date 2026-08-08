import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isoUtcTimestamp, repoRelativePath, type BranchName, type ClonePath, type CloneUrl, type GitSha, type IsoUtcTimestamp, type RepoRelativePath } from '../shared/brands.ts';
import { isJsonObject, type JsonValue } from '../contract/json.ts';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { CallContext, DomainOperation } from '../shared/call-context.ts';
import type { Clock } from '../clock/clock.ts';
import type { Exec } from '../exec/exec.ts';
import type { Locks } from '../locks/locks.ts';
import type { Audit } from '../audit/audit.ts';
import { success, validation, authorization, infrastructure, precondition, type ToolResult, type ReadStamp, type Diagnostics } from '../result/envelope.ts';
import { REPOSITORY_CONFIG_DEFAULTS, type RepositoryConfig } from '../declarations/types.ts';
import { gitOperationsError, type GitOperationsError } from './errors.ts';
import type {
  BranchSummary,
  BranchesData,
  BranchesInput,
  GitCommitData,
  GitCommitInput,
  GitDiffData,
  GitDiffInput,
  GitLogData,
  GitLogEntry,
  GitLogInput,
  GitStageData,
  GitStageInput,
  PathRejection,
  RepoHealthData,
  RepoHealthInput,
  RepoStatusData,
  RepoStatusEntry,
  RepoStatusInput,
  RestorePathsData,
  RestorePathsInput,
  StaleBranchSummary,
} from './types.ts';

const GIT_COMMAND_TIMEOUT_SECONDS = 30;
const DEFAULT_LOG_LIMIT = 200;
const STALE_BRANCH_DAYS = 30;
const FIELD_SEP = '\x1f';

/**
 * `.config/` is the write-protected directory `STRIPPED_FOR_UNATTENDED`
 * already reserves for exactly this kind of file (`declarations/types.ts`);
 * the filename itself is otherwise undetermined by the design (D3, U1's
 * scope) — an implementation choice, not a contract fact, recorded in
 * `90-decisions.md`.
 */
const CONFIG_RELATIVE_PATH = path.join('.config', 'subzerodev-git.json');

export interface GitOperationsDependencies {
  readonly clock: Clock;
  readonly exec: Pick<Exec, 'runGit'>;
  readonly locks: Pick<Locks, 'currentMutationHolder'>;
  /** Optional so every pre-S7 call site (read-only, never rejects a path) keeps compiling unchanged; a caller of `stage`/`restorePaths` that omits it simply gets no audit trail for a rejected path. */
  readonly audit?: Pick<Audit, 'append'>;
}

export interface GitOperations {
  readonly status: DomainOperation<RepoStatusInput, RepoStatusData>;
  readonly log: DomainOperation<GitLogInput, GitLogData>;
  readonly branches: DomainOperation<BranchesInput, BranchesData>;
  readonly health: DomainOperation<RepoHealthInput, RepoHealthData>;
  readonly diff: DomainOperation<GitDiffInput, GitDiffData>;
  readonly stage: DomainOperation<GitStageInput, GitStageData>;
  readonly commit: DomainOperation<GitCommitInput, GitCommitData>;
  readonly restorePaths: DomainOperation<RestorePathsInput, RestorePathsData>;
  loadRepositoryConfig(ctx: CallContext): Promise<Outcome<RepositoryConfig, GitOperationsError>>;
  validateWritePath(ctx: CallContext, rawPath: string): Outcome<RepoRelativePath, PathRejection>;
}

function readStampFor(ctx: CallContext, locks: Pick<Locks, 'currentMutationHolder'>): ReadStamp {
  const holder = locks.currentMutationHolder();
  return {
    // `Journal` (S7) has no "last settled operation for this declaration"
    // query in its contract signature — only `unsettled`/`allUnsettled`,
    // scoped the other way. An honest absence, not a stub: filling this in
    // needs either a contract amendment or a derived index, neither of
    // which is this slice's `Touches`.
    lastSettledOperationId: null,
    mutationInFlight: holder !== null && ctx.declarationId !== null && holder.declarationId === ctx.declarationId,
  };
}

function diagnosticsFor(ctx: CallContext, startedAtMs: number, clock: Clock): Diagnostics {
  return {
    operationId: ctx.operationId,
    declarationId: ctx.declarationId,
    generation: ctx.generation,
    durationMs: Math.max(0, Date.parse(clock.now()) - startedAtMs),
  };
}

function toToolResultError(error: GitOperationsError): ToolResult<never> {
  if (error.resultKind === 'precondition') return precondition(error.summary, 'findings' in error ? error.findings : []);
  return infrastructure(error.summary);
}

function gitToIso(raw: string): IsoUtcTimestamp | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  const parsed = isoUtcTimestamp(new Date(ms).toISOString());
  return parsed.ok ? parsed.value : null;
}

function daysSince(iso: IsoUtcTimestamp | null, clock: Clock): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor((Date.parse(clock.now()) - ms) / (24 * 60 * 60 * 1000));
}

export function createGitOperations(deps: GitOperationsDependencies): GitOperations {
  const { clock, exec, locks } = deps;
  const audit: Pick<Audit, 'append'> = deps.audit ?? { append: async () => ({ appended: true, sequence: 0 }) };

  /**
   * `20-contract.md` § L2 — git operations: `malformed` for anything
   * `repoRelativePath` itself rejects (`-A`, `--all`, `.`, a `..` segment, a
   * `;`) — the exact predicate the brand validator's own doc comment names
   * this call site against. `outside-allowlist` for a well-formed path not
   * under any of `ctx.writablePathPrefixes`, which is already the
   * declaration's grant intersected with the actor profile's strip list
   * (`Declarations.effectiveWritablePrefixes`, computed by the dispatch
   * pipeline before this ever runs) — so a prefix stripped for an
   * unattended actor is simply absent from that list by the time it
   * reaches here, indistinguishable at this layer from one never granted.
   * `stripped-by-profile` is therefore not reachable from this call site;
   * it stays in `PathRejection` for whatever surface has both lists to
   * compare.
   */
  /**
   * A `PathPrefix` ending in `/` is a directory — matched by `startsWith`.
   * One that does not is a single named file (`PathPrefix`'s own doc
   * comment: "a `RepoRelativePath` ending in `/`, or a `RepoRelativePath`
   * naming one file") — matched by exact equality only, so a declared
   * `README.md` cannot also authorize `README.md.bak` the way a bare
   * `startsWith` would.
   */
  function pathMatchesPrefix(candidate: string, prefix: string): boolean {
    return prefix.endsWith('/') ? candidate.startsWith(prefix) : candidate === prefix;
  }

  function validateWritePath(ctx: CallContext, rawPath: string): Outcome<RepoRelativePath, PathRejection> {
    const parsed = repoRelativePath(rawPath);
    if (!parsed.ok) return err({ kind: 'malformed', rule: parsed.error.rule });
    const candidate = parsed.value;
    const allowed = ctx.writablePathPrefixes.some((prefix) => pathMatchesPrefix(candidate, prefix as unknown as string));
    if (!allowed) return err({ kind: 'outside-allowlist', prefixes: ctx.writablePathPrefixes });
    return ok(candidate);
  }

  async function auditPathRejection(ctx: CallContext, rejectedPath: RepoRelativePath): Promise<void> {
    await audit.append({
      at: clock.now(),
      operationId: ctx.operationId,
      declarationId: ctx.declarationId,
      generation: ctx.generation,
      tool: null,
      actorRef: ctx.actorRef,
      context: ctx.context,
      form: 'authorization-rejection',
      missing: [],
      rejectedPath,
    });
  }

  /** Validates every path before any side effect runs — the first rejection wins and nothing is attempted. */
  async function validateWritePaths(ctx: CallContext, rawPaths: readonly string[]): Promise<Outcome<readonly RepoRelativePath[], ToolResult<never>>> {
    const validated: RepoRelativePath[] = [];
    for (const rawPath of rawPaths) {
      const result = validateWritePath(ctx, rawPath);
      if (!result.ok) {
        if (result.error.kind === 'malformed') {
          return err(validation(`'${rawPath}' is not a valid repository-relative path`, [{ path: 'paths', rule: result.error.rule, message: rawPath }]));
        }
        await auditPathRejection(ctx, rawPath as RepoRelativePath);
        return err(authorization(`'${rawPath}' is outside this declaration's writable path prefixes`, []));
      }
      validated.push(result.value);
    }
    return ok(validated);
  }

  async function git(cwd: ClonePath, args: readonly string[], signal: AbortSignal) {
    return exec.runGit({ argv: args, cwd, timeoutSeconds: GIT_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
  }

  async function currentBranch(cwd: ClonePath, signal: AbortSignal): Promise<BranchName | null> {
    const result = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], signal);
    if (!result.ok) return null;
    const name = result.value.stdout.trim();
    return name.length > 0 && name !== 'HEAD' ? (name as BranchName) : null;
  }

  async function aheadBehind(cwd: ClonePath, base: string, ref: string, signal: AbortSignal): Promise<{ readonly ahead: number; readonly behind: number }> {
    const result = await git(cwd, ['rev-list', '--left-right', '--count', `${base}...${ref}`], signal);
    if (!result.ok) return { ahead: 0, behind: 0 };
    const parts = result.value.stdout.trim().split(/\s+/);
    const behind = Number(parts[0]);
    const ahead = Number(parts[1]);
    return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
  }

  async function localBranchNames(cwd: ClonePath, signal: AbortSignal): Promise<readonly BranchName[]> {
    const result = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], signal);
    if (!result.ok) return [];
    return result.value.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s as BranchName);
  }

  async function branchSummaries(cwd: ClonePath, baseRef: string, current: BranchName | null, signal: AbortSignal): Promise<readonly BranchSummary[]> {
    const names = await localBranchNames(cwd, signal);
    const summaries: BranchSummary[] = [];
    for (const name of names) {
      const { ahead, behind } = await aheadBehind(cwd, baseRef, name, signal);
      const lastCommit = await git(cwd, ['log', '-1', '--format=%cI', name], signal);
      const lastCommitAt = lastCommit.ok ? gitToIso(lastCommit.value.stdout) : null;
      summaries.push({ name, current: name === current, ahead, behind, lastCommitAt });
    }
    return summaries;
  }

  async function loadRepositoryConfig(ctx: CallContext): Promise<Outcome<RepositoryConfig, GitOperationsError>> {
    if (ctx.cloneRoot === null) {
      return err(gitOperationsError({ code: 'no-clone' }, 'no clone materialised for this operation'));
    }
    const configPath = path.join(ctx.cloneRoot, CONFIG_RELATIVE_PATH);
    if (!existsSync(configPath)) {
      return ok(REPOSITORY_CONFIG_DEFAULTS);
    }
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch {
      return err(gitOperationsError({ code: 'config-unreadable' }, `could not read '${CONFIG_RELATIVE_PATH}'`));
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw) as JsonValue;
    } catch {
      return err(
        gitOperationsError(
          { code: 'config-unparseable', findings: [{ path: CONFIG_RELATIVE_PATH, rule: 'valid-json', message: 'not valid JSON' }] },
          `'${CONFIG_RELATIVE_PATH}' is not valid JSON`,
        ),
      );
    }
    if (!isJsonObject(parsed)) {
      return err(
        gitOperationsError(
          { code: 'config-unparseable', findings: [{ path: CONFIG_RELATIVE_PATH, rule: 'must-be-object', message: 'must be a JSON object' }] },
          `'${CONFIG_RELATIVE_PATH}' must be a JSON object`,
        ),
      );
    }
    const config: RepositoryConfig = {
      baseBranch: typeof parsed.baseBranch === 'string' ? (parsed.baseBranch as BranchName) : REPOSITORY_CONFIG_DEFAULTS.baseBranch,
      requiredChecks: Array.isArray(parsed.requiredChecks) ? (parsed.requiredChecks as string[]) : REPOSITORY_CONFIG_DEFAULTS.requiredChecks,
      deployWorkflow: typeof parsed.deployWorkflow === 'string' ? parsed.deployWorkflow : REPOSITORY_CONFIG_DEFAULTS.deployWorkflow,
      branchPrefixes: Array.isArray(parsed.branchPrefixes) ? (parsed.branchPrefixes as string[]) : REPOSITORY_CONFIG_DEFAULTS.branchPrefixes,
    };
    return ok(config);
  }

  return {
    async status(ctx, _input: RepoStatusInput): Promise<ToolResult<RepoStatusData>> {
      const startedAtMs = Date.now();
      const configResult = await loadRepositoryConfig(ctx);
      if (!configResult.ok) return toToolResultError(configResult.error);
      const cwd = ctx.cloneRoot as ClonePath;
      const signal = ctx.signal;
      const baseBranch = configResult.value.baseBranch as BranchName;
      const baseRef = `origin/${baseBranch}`;

      const branch = await currentBranch(cwd, signal);
      const statusResult = await git(cwd, ['status', '--porcelain=v1'], signal);
      const lines = statusResult.ok ? statusResult.value.stdout.split('\n').filter((l) => l.length > 0) : [];
      const changedPaths: RepoStatusEntry[] = lines.map((line) => {
        const codes = line.slice(0, 2);
        const filePath = line.slice(3).trim() as RepoRelativePath;
        const staged = codes[0] !== ' ' && codes[0] !== '?';
        return { path: filePath, staged };
      });

      const { ahead, behind } = await aheadBehind(cwd, baseRef, 'HEAD', signal);
      const remoteResult = await git(cwd, ['remote', 'get-url', 'origin'], signal);

      const data: RepoStatusData = {
        branch: branch ?? baseBranch,
        baseBranch,
        dirty: changedPaths.length > 0,
        parkedOffBase: branch !== null && branch !== baseBranch,
        ahead,
        behind,
        changedPaths,
        observedRemote: remoteResult.ok ? (remoteResult.value.stdout.trim() as CloneUrl) : null,
        readStamp: readStampFor(ctx, locks),
      };
      return success('repository status', data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async log(ctx, input: GitLogInput): Promise<ToolResult<GitLogData>> {
      const startedAtMs = Date.now();
      const configResult = await loadRepositoryConfig(ctx);
      if (!configResult.ok) return toToolResultError(configResult.error);
      const cwd = ctx.cloneRoot as ClonePath;
      const signal = ctx.signal;
      const ref = input.ref ?? (`origin/${configResult.value.baseBranch}` as BranchName);

      const result = await git(
        cwd,
        ['log', ref, '-n', String(DEFAULT_LOG_LIMIT), '-z', `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s`],
        signal,
      );
      if (!result.ok) {
        return precondition(`could not read log for '${ref}'`, [{ path: 'ref', rule: 'must-resolve', message: ref }]);
      }
      const commits: GitLogEntry[] = result.value.stdout
        .split('\0')
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const [sha, authorName, authorEmail, authorDate, subject] = entry.split(FIELD_SEP);
          return {
            sha: sha as GitSha,
            authorName: authorName ?? '',
            authorEmail: authorEmail ?? '',
            authorDate: gitToIso(authorDate ?? '') ?? clock.now(),
            subject: subject ?? '',
          };
        });

      const data: GitLogData = { ref, commits, readStamp: readStampFor(ctx, locks) };
      return success(`${commits.length} commit(s) on '${ref}'`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async branches(ctx, _input: BranchesInput): Promise<ToolResult<BranchesData>> {
      const startedAtMs = Date.now();
      const configResult = await loadRepositoryConfig(ctx);
      if (!configResult.ok) return toToolResultError(configResult.error);
      const cwd = ctx.cloneRoot as ClonePath;
      const signal = ctx.signal;
      const baseBranch = configResult.value.baseBranch as BranchName;
      const baseRef = `origin/${baseBranch}`;
      const current = await currentBranch(cwd, signal);
      const branches = await branchSummaries(cwd, baseRef, current, signal);

      const data: BranchesData = { baseBranch, branches, readStamp: readStampFor(ctx, locks) };
      return success(`${branches.length} local branch(es)`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async health(ctx, _input: RepoHealthInput): Promise<ToolResult<RepoHealthData>> {
      const startedAtMs = Date.now();
      const configResult = await loadRepositoryConfig(ctx);
      if (!configResult.ok) return toToolResultError(configResult.error);
      const cwd = ctx.cloneRoot as ClonePath;
      const signal = ctx.signal;
      const baseBranch = configResult.value.baseBranch as BranchName;
      const baseRef = `origin/${baseBranch}`;

      const branch = await currentBranch(cwd, signal);
      const statusResult = await git(cwd, ['status', '--porcelain=v1'], signal);
      const dirty = statusResult.ok && statusResult.value.stdout.trim().length > 0;
      const { ahead, behind } = await aheadBehind(cwd, baseRef, 'HEAD', signal);

      const commitsResult = await git(cwd, ['rev-list', '--count', '--since=7.days', baseRef], signal);
      const commitsLast7Days = commitsResult.ok ? Number(commitsResult.value.stdout.trim()) || 0 : 0;
      const lastCommitResult = await git(cwd, ['log', '-1', '--format=%cI', baseRef], signal);
      const daysSinceLastCommit = daysSince(lastCommitResult.ok ? gitToIso(lastCommitResult.value.stdout) : null, clock);

      const allBranches = await branchSummaries(cwd, baseRef, branch, signal);
      const stale = allBranches.filter((b) => {
        const age = daysSince(b.lastCommitAt, clock);
        return age !== null && age > STALE_BRANCH_DAYS;
      });
      const staleBranches: StaleBranchSummary = { count: stale.length, names: stale.map((b) => b.name) };

      const data: RepoHealthData = {
        branch: branch ?? baseBranch,
        baseBranch,
        dirty,
        parkedOffBase: branch !== null && branch !== baseBranch,
        ahead,
        behind,
        commitsLast7Days,
        daysSinceLastCommit,
        staleBranches,
        readStamp: readStampFor(ctx, locks),
      };
      return success(`on '${data.branch}'${dirty ? ' (dirty)' : ''}`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async diff(ctx, input: GitDiffInput): Promise<ToolResult<GitDiffData>> {
      const startedAtMs = Date.now();
      if (ctx.cloneRoot === null) return infrastructure('no clone materialised for this operation');
      const cwd = ctx.cloneRoot;
      const signal = ctx.signal;
      const pathArgs = input.paths && input.paths.length > 0 ? ['--', ...input.paths] : [];
      const stagedArgs = input.staged ? ['--cached'] : [];

      const diffResult = await git(cwd, ['diff', ...stagedArgs, ...pathArgs], signal);
      const checkResult = await git(cwd, ['diff', '--check', ...stagedArgs, ...pathArgs], signal);

      const diffText = diffResult.ok ? diffResult.value.stdout : '';
      // `git diff --check` legitimately exits non-zero when it finds an issue,
      // and its findings are on stdout — but `Exec`'s `nonzero-exit` variant
      // (`exec/errors.ts`) carries only `stderr`, not `stdout`, so that
      // output is unrecoverable here. A real gap in `Exec`'s error shape for
      // any command whose nonzero exit is informational rather than a
      // failure; flagged for whoever owns `Exec` next rather than fixed here
      // (out of this slice's `Touches`).
      const data: GitDiffData = {
        diff: diffText,
        checkClean: checkResult.ok,
        checkOutput: checkResult.ok ? checkResult.value.stdout : '',
        readStamp: readStampFor(ctx, locks),
      };
      return success(diffText.trim() === '' ? 'no changes' : `${diffText.split('\n').length} diff line(s)`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async stage(ctx, input: GitStageInput): Promise<ToolResult<GitStageData>> {
      const startedAtMs = Date.now();
      if (ctx.cloneRoot === null) return infrastructure('no clone materialised for this operation');
      const cwd = ctx.cloneRoot;
      const signal = ctx.signal;

      const validated = await validateWritePaths(ctx, input.paths);
      if (!validated.ok) return validated.error;

      const addResult = await git(cwd, ['add', '--', ...validated.value], signal);
      if (!addResult.ok) {
        return precondition(`could not stage ${validated.value.length} path(s)`, [{ path: 'paths', rule: 'stageable', message: addResult.error.summary }]);
      }

      const data: GitStageData = { staged: validated.value };
      return success(`staged ${validated.value.length} path(s)`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async commit(ctx, input: GitCommitInput): Promise<ToolResult<GitCommitData>> {
      const startedAtMs = Date.now();
      if (ctx.cloneRoot === null) return infrastructure('no clone materialised for this operation');
      const cwd = ctx.cloneRoot;
      const signal = ctx.signal;

      const commitResult = await git(cwd, ['commit', '-m', input.message], signal);
      if (!commitResult.ok) {
        return precondition('commit failed — is anything staged?', [{ path: 'message', rule: 'stagedChangesExist', message: commitResult.error.summary }]);
      }

      // The commit itself already happened — a real side effect the caller
      // must be told about, one way or another. A failure to describe it
      // (a cancelled signal, a killed subprocess) must not be reported as
      // `success` with a fabricated empty sha and a synthetic `HEAD` branch,
      // since that would satisfy this tool's permissive output schema while
      // handing the caller data none of it actually observed.
      const shaResult = await git(cwd, ['rev-parse', 'HEAD'], signal);
      if (!shaResult.ok) {
        return infrastructure(`committed, but could not read the resulting sha: ${shaResult.error.summary}`);
      }
      const branch = await currentBranch(cwd, signal);
      if (branch === null) {
        return infrastructure(`committed ${shaResult.value.stdout.trim()}, but could not determine the current branch`);
      }
      const changedResult = await git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], signal);
      if (!changedResult.ok) {
        return infrastructure(`committed ${shaResult.value.stdout.trim()}, but could not read its changed paths: ${changedResult.error.summary}`);
      }

      const data: GitCommitData = {
        sha: shaResult.value.stdout.trim() as GitSha,
        branch,
        changedPaths: changedResult.value.stdout.split('\n').filter((l) => l.length > 0) as RepoRelativePath[],
      };
      return success(`committed ${data.sha}`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async restorePaths(ctx, input: RestorePathsInput): Promise<ToolResult<RestorePathsData>> {
      const startedAtMs = Date.now();
      if (ctx.cloneRoot === null) return infrastructure('no clone materialised for this operation');
      const cwd = ctx.cloneRoot;
      const signal = ctx.signal;

      const validated = await validateWritePaths(ctx, input.paths);
      if (!validated.ok) return validated.error;

      const restoreResult = await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...validated.value], signal);
      if (!restoreResult.ok) {
        return precondition(`could not restore ${validated.value.length} path(s)`, [{ path: 'paths', rule: 'restorable', message: restoreResult.error.summary }]);
      }

      const data: RestorePathsData = { restored: validated.value };
      return success(`restored ${validated.value.length} path(s)`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    loadRepositoryConfig,
    validateWritePath,
  };
}
