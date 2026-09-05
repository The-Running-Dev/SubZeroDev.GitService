import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  branchName,
  isoUtcTimestamp,
  repoRelativePath,
  type BranchName,
  type ClonePath,
  type CloneUrl,
  type CredentialRef,
  type DeclarationId,
  type GitSha,
  type IsoUtcTimestamp,
  type OperationId,
  type RepoRelativePath,
} from '../shared/brands.ts';
import { isJsonObject, type JsonValue } from '../contract/json.ts';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import type { CallContext, DomainOperation } from '../shared/call-context.ts';
import type { Clock } from '../clock/clock.ts';
import type { CredentialBinding, Exec, MutableEnv } from '../exec/exec.ts';
import type { ExecError } from '../exec/errors.ts';
import type { Locks } from '../locks/locks.ts';
import type { Audit } from '../audit/audit.ts';
import type { Journal } from '../journal/journal.ts';
import type { Declarations } from '../declarations/declarations.ts';
import type { CloneStore } from '../clone/clone-store.ts';
import type { CredentialResolver } from '../credentials/credentials.ts';
import { prepareDeclarationCredential } from '../credentials/declaration-credential.ts';
import { success, validation, authorization, infrastructure, precondition, upstream, timeout as timeoutResult, conflict, type ToolResult, type ReadStamp } from '../result/envelope.ts';
import { diagnosticsFor } from '../shared/diagnostics.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';
import { REPOSITORY_CONFIG_DEFAULTS, type RepositoryConfig } from '../declarations/types.ts';
import { gitOperationsError, type GitOperationsError } from './errors.ts';
import { currentBranch as sharedCurrentBranch } from './primitives.ts';
import type {
  BranchSummary,
  BranchesData,
  BranchesInput,
  GitCommitData,
  GitCommitInput,
  GitDiffData,
  GitDiffInput,
  GitFetchData,
  GitFetchInput,
  GitLogData,
  GitLogEntry,
  GitLogInput,
  GitPushData,
  GitPushInput,
  GitRawData,
  GitRawInput,
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
  SyncBaseData,
  SyncBaseInput,
} from './types.ts';

const GIT_COMMAND_TIMEOUT_SECONDS = 30;
/** Matches the three remote tools' registry `timeoutSeconds` — these cross a network, the local ones do not. */
const GIT_REMOTE_COMMAND_TIMEOUT_SECONDS = 300;
const GIT_RAW_COMMAND_TIMEOUT_SECONDS = 60;
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
  readonly exec: Pick<Exec, 'runGit'> & Partial<Pick<Exec, 'scrub'>>;
  readonly locks: Pick<Locks, 'currentMutationHolder'>;
  /** Optional so every pre-S7 call site (read-only, never rejects a path) keeps compiling unchanged; a caller of `stage`/`restorePaths` that omits it simply gets no audit trail for a rejected path. */
  readonly audit?: Pick<Audit, 'append'>;
  /**
   * Required by operations that may mutate outside the local clone. Those
   * operations fail closed when the writer is absent. `markApplied`/`settle`/
   * `park` are `git.raw`'s alone: its argv is caller-authored, so only the
   * handler that observed the post-state can tell an ordinary completion
   * apart from one dispatch cannot safely settle on its own — the same
   * reason it writes its own audit trail rather than relying on dispatch's
   * generic line.
   */
  readonly journal?: Pick<Journal, 'appendStep' | 'markApplied' | 'settle' | 'park'>;
  /**
   * S9's three remote operations only. `CallContext` carries no credential
   * reference and no clone URL — both are `Declaration` fields — so reaching a
   * remote needs the record itself. Optional for the same reason `audit` is:
   * every local operation runs without it, and a remote one that has no
   * resolver refuses rather than reaching a remote unauthenticated.
   */
  readonly declarations?: Pick<Declarations, 'get'>;
  /** `git.raw` only, alongside `journal` above — marks the clone for attention when it parks its own journal entry. */
  readonly cloneStore?: Pick<CloneStore, 'markAttention'>;
  readonly credentials?: CredentialResolver;
  /**
   * The same `MutableEnv` the `Exec` above was built with. `resolveInto`
   * writes the secret here and `Exec` reads it back by variable name; nothing
   * in between ever holds the value.
   */
  readonly credentialEnv?: MutableEnv;
  /** Test seam only; production omits it and therefore uses the frozen 60-second hatch budget. */
  readonly rawTimeoutSeconds?: number;
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
  readonly push: DomainOperation<GitPushInput, GitPushData>;
  readonly fetch: DomainOperation<GitFetchInput, GitFetchData>;
  readonly syncBase: DomainOperation<SyncBaseInput, SyncBaseData>;
  readonly raw: DomainOperation<GitRawInput, GitRawData>;
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

function toToolResultError(error: GitOperationsError): ToolResult<never> {
  if (error.resultKind === 'precondition') return precondition(error.summary, 'findings' in error ? error.findings : []);
  return infrastructure(error.summary);
}

/** Maps any `ModuleErrorBase`-shaped error into the envelope by its own `resultKind` — the four `CredentialError` variants each carry theirs. */
function moduleErrorToToolResult(error: ModuleErrorBase): ToolResult<never> {
  switch (error.resultKind) {
    case 'validation':
      return validation(error.summary, []);
    case 'precondition':
      return precondition(error.summary, []);
    case 'authorization':
      return authorization(error.summary, []);
    case 'upstream':
      return upstream(error.summary, null);
    default:
      return infrastructure(error.summary);
  }
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
  const rawTimeoutSeconds = deps.rawTimeoutSeconds ?? GIT_RAW_COMMAND_TIMEOUT_SECONDS;
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

  /**
   * A remote git call, carrying the resolved credential by variable name.
   * Separate from `git` above only in the timeout and the binding — the
   * secret itself never passes through here, and `Exec` is what puts it into
   * the child's environment.
   */
  async function remoteGit(cwd: ClonePath, args: readonly string[], signal: AbortSignal, credential: CredentialBinding | null) {
    return exec.runGit({ argv: args, cwd, timeoutSeconds: GIT_REMOTE_COMMAND_TIMEOUT_SECONDS, credential, signal });
  }

  function normaliseRemote(raw: string): string | null {
    const possibleScp = raw.match(/^(?:([^@\s]+)@)?([^:/\s]+):(.+)$/);
    // A refspec such as `main:main` has the same punctuation as an scp-style
    // remote. Treat the form as remote-shaped only when it has the host signal
    // scp remotes conventionally carry; the actual remote operand position is
    // checked separately below, so an opaque remote name still fails closed.
    const scp = possibleScp && (possibleScp[1] !== undefined || possibleScp[2]!.includes('.')) ? possibleScp : null;
    const candidate = scp ? `ssh://${scp[1] ? `${scp[1]}@` : ''}${scp[2]}/${scp[3]}` : raw;
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:', 'ssh:', 'git:', 'file:'].includes(parsed.protocol.toLowerCase())) return null;
      const pathName = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
      return `${parsed.protocol.toLowerCase()}//${parsed.username ? `${parsed.username}@` : ''}${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathName}`;
    } catch {
      return null;
    }
  }

  function remoteCarriesPassword(raw: string): boolean {
    try {
      return new URL(raw).password.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Git's remote-helper syntax is `<transport>::<address>`, and `ext::` runs
   * the address as a command outright. None of it parses as a URL, so
   * `normaliseRemote` returns null for it and the operand rules below would
   * wave it through as "not remote-shaped".
   */
  const REMOTE_HELPER = /^[a-z][a-z0-9+.-]*::/i;

  /**
   * The options whose value is a repository. A remote reaches the network
   * through these as well as through a bare operand — `git archive
   * --remote=<repo>` is a transfer, and `archive` is not one of the
   * subcommands the network rule below looks at.
   */
  const REMOTE_VALUED_OPTIONS = new Set(['--remote', '--reference', '--reference-if-able', '--upload-pack', '--receive-pack']);

  /** The subcommands whose grammar is `[remote] [refspec-or-pattern...]` — only the first bare positional is ever a remote; `20-contract.md`'s hatch rules validate that one position precisely below, against `declared`. */
  const NETWORK_SUBCOMMANDS = new Set(['push', 'fetch', 'pull', 'ls-remote', 'clone']);

  /**
   * Every position a caller could put a repository in: the bare operands,
   * plus the values of the options that take one, in either `--opt=value` or
   * `--opt value` form.
   *
   * For a `NETWORK_SUBCOMMANDS` entry, only the *first* bare positional is
   * included — every later one is a refspec or ref pattern, not a remote, and
   * git's own `src:dst` refspec syntax can make one look SCP-shaped (e.g.
   * `release.1.0:release.1.0`) without naming a remote at all.
   */
  function remoteCandidates(operands: readonly string[], subcommand: string): readonly string[] {
    const values: string[] = [];
    const onlyFirstBarePositional = NETWORK_SUBCOMMANDS.has(subcommand);
    let sawBarePositional = false;
    for (let index = 0; index < operands.length; index += 1) {
      const arg = operands[index]!;
      if (!arg.startsWith('-')) {
        if (!onlyFirstBarePositional || !sawBarePositional) values.push(arg);
        sawBarePositional = true;
        continue;
      }
      const equals = arg.indexOf('=');
      if (equals > 0 && REMOTE_VALUED_OPTIONS.has(arg.slice(0, equals))) {
        values.push(arg.slice(equals + 1));
        continue;
      }
      if (REMOTE_VALUED_OPTIONS.has(arg) && operands[index + 1] !== undefined) {
        values.push(operands[index + 1]!);
        index += 1;
      }
    }
    return values;
  }

  function optionValues(operands: readonly string[], option: string): readonly string[] {
    const values: string[] = [];
    for (let index = 0; index < operands.length; index += 1) {
      const arg = operands[index]!;
      if (arg.startsWith(`${option}=`)) values.push(arg.slice(option.length + 1));
      else if (arg === option && operands[index + 1] !== undefined) {
        values.push(operands[index + 1]!);
        index += 1;
      }
    }
    return values;
  }

  function rawArgvRejection(argv: readonly string[], cloneUrl: CloneUrl): string | null {
    if (argv.length === 0 || argv[0]?.trim() === '') return 'argv must name a git subcommand';
    if (argv[0]!.startsWith('-')) return `global option '${argv[0]}' cannot precede the fixed git subcommand`;
    const forbiddenOption = argv.slice(1).find((arg) =>
      arg.startsWith('--upload-pack') || arg.startsWith('--receive-pack') || arg.startsWith('--extcmd') ||
      arg.startsWith('--tool=') || arg === '--tool' || arg.startsWith('--open-files-in-pager') ||
      arg.startsWith('--exec=') || arg === '--exec' || arg === '-x',
    );
    if (forbiddenOption) return `option '${forbiddenOption}' selects configuration, an executable, or a different repository`;

    const subcommand = argv[0]!.toLowerCase();
    const operands = argv.slice(1);
    if (subcommand === 'remote' && ['add', 'set-url'].includes((operands.find((arg) => !arg.startsWith('-')) ?? '').toLowerCase())) {
      return `'git remote ${operands[0] ?? ''}' persists a caller-supplied remote`;
    }
    const firstPositional = operands.find((arg) => !arg.startsWith('-'))?.toLowerCase() ?? '';
    if (subcommand === 'submodule' && ['add', 'set-url'].includes(firstPositional)) {
      return `'git submodule ${firstPositional}' persists a caller-supplied remote`;
    }
    if ((subcommand === 'submodule' && firstPositional === 'foreach') || (subcommand === 'bisect' && firstPositional === 'run')) {
      return `'git ${subcommand} ${firstPositional}' selects an executable`;
    }
    if (subcommand === 'filter-branch' && operands.some((arg) => /^(--setup|--env-filter|--tree-filter|--index-filter|--parent-filter|--msg-filter|--commit-filter|--tag-name-filter)(=|$)/.test(arg))) {
      return "'git filter-branch' filter arguments select executable shell text";
    }
    if (subcommand === 'config') {
      // `--file`/`--blob` redirect the read *or* the write at an arbitrary
      // path, so they escape this clone in both directions — a write lands in
      // another declaration's `.git/config`, and a read dumps whatever file is
      // named. Refused before the read/write split below, which only decides
      // *what* is being asked of the config, not *whose* config it is.
      if (operands.some((arg) => arg === '--file' || arg === '-f' || arg.startsWith('--file=') || arg === '--blob' || arg.startsWith('--blob='))) {
        return "'git config --file'/'--blob' reads or writes configuration outside this clone";
      }
      if (operands.some((arg) => ['--global', '--system', '--edit', '-e'].includes(arg))) {
        return "this 'git config' form edits configuration outside this clone's own config or launches an editor";
      }
      // **Every config write is refused, not an enumerated subset.** Git's
      // configuration selects executables (`core.sshCommand`, `alias.*`,
      // `filter.*.process`), credential helpers (`credential.helper` *and*
      // the URL-scoped `credential.<url>.helper`), remotes (`remote.*`,
      // `url.*.insteadOf`) and transports (`http.proxy`, `protocol.ext.allow`)
      // across a key surface that grows with every git release. A blocklist
      // has to enumerate that surface correctly forever; this rule does not,
      // and reading configuration — which is what a caller diagnosing a
      // repository actually needs — stays available.
      const writeFlags = ['--add', '--replace-all', '--unset', '--unset-all', '--remove-section', '--rename-section', '--set-all'];
      // `--get`/`--get-all`/`--get-regexp`/`--get-urlmatch` are reads that
      // legitimately take a second positional — a value pattern or URL to
      // filter by — so a bare `positional.length >= 2` misreads them as the
      // two-positional write form `git config <name> <value>`.
      const readFlagsTakingValuePattern = ['--get', '--get-all', '--get-regexp', '--get-urlmatch'];
      const positional = operands.filter((arg) => !arg.startsWith('-'));
      const isRead = operands.some((arg) => readFlagsTakingValuePattern.includes(arg));
      if (operands.some((arg) => writeFlags.includes(arg)) || (positional.length >= 2 && !isRead)) {
        return "'git config' writes are refused through the hatch: configuration selects executables, credential helpers, remotes and transports, so the hatch reads configuration but never persists it";
      }
    }
    if (subcommand === 'clone' && operands.some((arg) => arg === '-c' || arg === '--config' || arg.startsWith('--config='))) {
      return "'git clone --config' injects repository configuration";
    }

    if (operands.some((arg) => arg === '--template' || arg.startsWith('--template='))) {
      return "'--template' selects a template directory, which can carry hooks";
    }

    const declared = normaliseRemote(cloneUrl as unknown as string);
    // Scanned over every position a repository can occupy, not only the bare
    // operands: `git archive --remote=<repo>` reaches a transport through an
    // option, and `archive` is not one of the subcommands the network rule
    // below inspects.
    for (const operand of remoteCandidates(operands, subcommand)) {
      if (REMOTE_HELPER.test(operand)) {
        return `remote operand '${operand}' uses git's remote-helper transport syntax, which selects a helper program`;
      }
      if (remoteCarriesPassword(operand)) return `remote operand '${operand}' carries a caller-supplied password`;
      if (/^https?:\/\/[^/\s]*@/i.test(operand)) return `remote operand '${operand}' carries caller-supplied credentials`;
      if (operand === (cloneUrl as unknown as string)) continue;
      const remote = normaliseRemote(operand);
      if (remote !== null && remote !== declared) return `remote operand '${operand}' does not match this declaration's cloneUrl`;
    }
    // `archive --remote=<name>` is outside the network-subcommand list below,
    // and an opaque name does not parse as a URL. It still names a repository,
    // so it is admitted only for the one configured alias or URL.
    for (const operand of optionValues(operands, '--remote')) {
      if (operand === 'origin' || operand === (cloneUrl as unknown as string)) continue;
      const remote = normaliseRemote(operand);
      if (remote === null || remote !== declared) return `remote operand '${operand}' is neither origin nor this declaration's cloneUrl`;
    }
    if (NETWORK_SUBCOMMANDS.has(subcommand)) {
      const optionsWithValues = new Set([
        '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--jobs', '-j', '--server-option',
        '--negotiation-tip', '--filter', '--refmap', '--submodule-prefix', '--origin', '-o', '--branch', '-b',
        '--upload-pack', '-u', '--config', '-c', '--reference', '--reference-if-able', '--separate-git-dir',
      ]);
      let firstOperand: string | undefined;
      for (let index = 0; index < operands.length; index += 1) {
        const operand = operands[index]!;
        if (optionsWithValues.has(operand)) { index += 1; continue; }
        if (operand.startsWith('-')) continue;
        firstOperand = operand;
        break;
      }
      if (firstOperand && firstOperand !== 'origin') {
        if (firstOperand === (cloneUrl as unknown as string)) return null;
        const remote = normaliseRemote(firstOperand);
        if (remote === null || remote !== declared) return `remote operand '${firstOperand}' is neither origin nor this declaration's cloneUrl`;
      }
    }
    return null;
  }

  async function rawStatus(cwd: ClonePath, signal: AbortSignal) {
    const observed = await git(cwd, ['status', '--porcelain=v1', '-z'], signal);
    if (!observed.ok) return observed;
    const result = new Map<string, string>();
    const tokens = observed.value.stdout.split('\0').filter(Boolean);
    for (let index = 0; index < tokens.length; index += 1) {
      const entry = tokens[index]!;
      const status = entry.slice(0, 2);
      const pathName = entry.slice(3).trim();
      if (pathName) result.set(pathName, status);
      // A rename or copy (`XY` starting with `R`/`C`) carries a second
      // NUL-terminated token for the pre-image path, with no "XY " prefix of
      // its own — consumed here as a bare path rather than left for the next
      // iteration, which would wrongly strip its first 3 characters as if
      // they were a status prefix.
      if ((status[0] === 'R' || status[0] === 'C') && index + 1 < tokens.length) {
        index += 1;
        const otherPath = tokens[index]!;
        if (otherPath) result.set(otherPath, status);
      }
    }
    return ok(result as ReadonlyMap<string, string>);
  }

  function changedRawPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly RepoRelativePath[] {
    const all = new Set([...before.keys(), ...after.keys()]);
    return [...all].filter((pathName) => before.get(pathName) !== after.get(pathName)).sort() as RepoRelativePath[];
  }

  /**
   * Git says "Authentication failed" (or a 401/403 through its transport) for a
   * credential the remote refused, and something else entirely for a host it
   * could not reach. The distinction decides whether a reference gets marked
   * failing, so it is made on the text git actually emits rather than on the
   * exit code, which is 128 for both.
   */
  function looksLikeAuthRejection(stderr: string): boolean {
    return /authentication failed|invalid username or password|403 forbidden|401 unauthorized|permission to .* denied|could not read Username/i.test(stderr);
  }

  function execStderr(error: { readonly code: string; readonly summary: string }): string {
    return 'stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string' ? (error as { stderr: string }).stderr : error.summary;
  }

  /**
   * The three-step preparation every remote operation performs before it may
   * touch a network lives in `prepareDeclarationCredential` — S10's host
   * adapter needs the identical sequence, and the reference's own allowed-host
   * check is not a rule that may exist in two places. This wrapper only maps
   * its `ModuleErrorBase` into this module's envelope.
   */
  async function prepareRemote(ctx: CallContext): Promise<Outcome<{ readonly credential: CredentialBinding | null; readonly ref: CredentialRef | null }, ToolResult<never>>> {
    const prepared = await prepareDeclarationCredential(deps, ctx);
    if (!prepared.ok) return err(moduleErrorToToolResult(prepared.error));
    return ok(prepared.value);
  }

  async function appendExternalStep(ctx: CallContext, name: string): Promise<ToolResult<never> | null> {
    if (!deps.journal) return infrastructure(`'${ctx.operationId}' cannot start '${name}' because the journal step writer is unavailable`);
    const appended = await deps.journal.appendStep(ctx.operationId, name);
    return appended.ok ? null : infrastructure(`'${name}' refused before acting because its recovery step could not be written: ${appended.error.summary}`);
  }

  /**
   * `git.raw` completes its own journal entry — settled ordinarily, or
   * parked when the post-state genuinely cannot be accounted for — rather
   * than leaving it to dispatch's generic completion (`dispatch-pipeline.ts`
   * skips that path for this one tool). Only the handler that observed the
   * post-state can tell an ordinary completion apart from one dispatch
   * cannot safely settle on its own; the same reasoning that already has
   * this handler write its own audit trail instead of the generic line.
   */
  async function finishRawJournal(operationId: OperationId, declarationId: DeclarationId | null, unknownPostState: boolean, reason: string): Promise<void> {
    if (!deps.journal) return;
    if (unknownPostState) {
      await deps.journal.park(operationId, reason);
      if (declarationId !== null) await deps.cloneStore?.markAttention(declarationId, reason);
      return;
    }
    await deps.journal.markApplied(operationId);
    await deps.journal.settle(operationId, null);
  }

  /** Records the rejection against this declaration only — never reference-wide. See `credential_failure_mark`'s composite key. */
  async function markRejected(ctx: CallContext, ref: CredentialRef | null, stderr: string): Promise<void> {
    if (ref === null || !deps.credentials || ctx.declarationId === null) return;
    await deps.credentials.markFailing(ref, ctx.declarationId, `the remote refused this credential: ${stderr.trim().slice(0, 200)}`);
  }

  /**
   * Every remote git failure across `push`/`fetch`/`syncBase` goes through
   * one classifier: `20-contract.md`'s `ExecError` table maps a `timed-out`
   * child to `timeout`, and dispatch parks a `timeout`-kind mutation's
   * journal entry — a transfer that timed out leaves the tree in a state the
   * caller cannot account for, the same reasoning `git.raw`'s own timeout
   * handling already applies. An authentication rejection marks the
   * credential failing for this declaration; everything else is `upstream`.
   */
  async function classifyRemoteFailure(
    ctx: CallContext,
    ref: CredentialRef | null,
    error: ExecError,
    describe: (summary: string) => string,
  ): Promise<ToolResult<never>> {
    if (error.code === 'timed-out') {
      return timeoutResult(describe(error.summary), error.limitSeconds);
    }
    const stderr = execStderr(error);
    if (looksLikeAuthRejection(stderr)) {
      await markRejected(ctx, ref, stderr);
      return upstream(`the remote refused the credential for '${ctx.declarationId}'; the reference is marked failing for this declaration only`, null);
    }
    return upstream(describe(error.summary), null);
  }

  /** `refs/remotes/origin/*` and their values, which is what a fetch is observed to have changed. */
  async function remoteTrackingRefs(cwd: ClonePath, signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    const result = await git(cwd, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin/'], signal);
    const refs = new Map<string, string>();
    if (!result.ok) return refs;
    for (const line of result.value.stdout.split('\n')) {
      const [name, sha] = line.trim().split(' ');
      if (name && sha) refs.set(name, sha);
    }
    return refs;
  }

  async function currentBranch(cwd: ClonePath, signal: AbortSignal): Promise<BranchName | null> {
    return sharedCurrentBranch(exec, cwd, GIT_COMMAND_TIMEOUT_SECONDS, signal);
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
    let baseBranch = REPOSITORY_CONFIG_DEFAULTS.baseBranch;
    if (typeof parsed.baseBranch === 'string') {
      const validated = branchName(parsed.baseBranch);
      // A string that is not a valid ref name is refused outright rather
      // than falling back to the default: `baseBranch` reaches `git fetch`
      // as a bare positional (`syncBase`), and a value beginning with `-`
      // would be read by git as an option rather than a ref (issue #149).
      // Silently substituting the default would hide that from whoever
      // wrote the config, the same way `config-unparseable` already refuses
      // rather than guessing for malformed JSON or a non-object shape.
      if (!validated.ok) {
        return err(
          gitOperationsError(
            { code: 'config-unparseable', findings: [{ path: `${CONFIG_RELATIVE_PATH}#baseBranch`, rule: validated.error.rule, message: validated.error.received }] },
            `'${CONFIG_RELATIVE_PATH}' names a baseBranch git will not accept as a ref name`,
          ),
        );
      }
      baseBranch = validated.value;
    }
    const config: RepositoryConfig = {
      baseBranch,
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
      const baseBranch = configResult.value.baseBranch;
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
      const baseBranch = configResult.value.baseBranch;
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
      const baseBranch = configResult.value.baseBranch;
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
      const data: GitDiffData = {
        diff: diffText,
        checkClean: checkResult.ok,
        checkOutput: checkResult.ok ? checkResult.value.stdout : checkResult.error.code === 'nonzero-exit' ? checkResult.error.stdout : '',
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

      // Protected-base invariant 1 (`TODO-NEXT.md` §7.2, carried by
      // `00-brief.md`'s "general git-workflow safety, not blog-specific" —
      // S12 amends this operation even though it sits outside S12's own
      // `Touches` line, because nothing else in the design owns it and
      // S12.1 requires demonstrating all seven invariants refused, not six).
      // A commit that lands on base is exactly the incident branch
      // preparation exists to prevent from the other direction; refusing it
      // here closes the door branch preparation cannot close on its own.
      const configForBaseCheck = await loadRepositoryConfig(ctx);
      if (!configForBaseCheck.ok) return toToolResultError(configForBaseCheck.error);
      const checkedOutBeforeCommit = await currentBranch(cwd, signal);
      if (checkedOutBeforeCommit !== null && checkedOutBeforeCommit === configForBaseCheck.value.baseBranch) {
        return precondition(`refusing to commit on '${checkedOutBeforeCommit}', the configured base branch — prepare a branch first`, [
          { path: 'branch', rule: 'not-base-branch', message: checkedOutBeforeCommit },
        ]);
      }

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
      // `git commit` never switches or detaches the checked-out branch, so the
      // branch observed before the commit is still correct afterward — no
      // need to spawn a second `rev-parse --abbrev-ref HEAD`.
      const branch = checkedOutBeforeCommit;
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

    async push(ctx, input: GitPushInput): Promise<ToolResult<GitPushData>> {
      const startedAtMs = Date.now();
      if (ctx.cloneRoot === null) return infrastructure('no clone materialised for this operation');
      const cwd = ctx.cloneRoot;
      const signal = ctx.signal;

      const branch = input.branch ?? (await currentBranch(cwd, signal));
      if (branch === null) {
        return precondition('nothing to push: the clone is on a detached HEAD and no branch was named', [
          { path: 'branch', rule: 'resolvable', message: 'detached HEAD and no branch given' },
        ]);
      }

      // `show-ref --verify`, not `rev-parse`. `rev-parse` resolves any
      // revision expression — a tag, a raw sha, `main~1` — so an input that is
      // not a local branch would pass and then fail inside the push as a
      // misleading upstream error. Prefixing `refs/heads/` is not enough on
      // its own either: `rev-parse --verify refs/heads/main~1` still applies
      // the `~1`. `show-ref --verify` requires an exact ref and honours no
      // revision syntax at all, so what is checked here is precisely the ref
      // the refspec below pushes.
      const headResult = await git(cwd, ['show-ref', '--verify', `refs/heads/${branch}`], signal);
      if (!headResult.ok) {
        return precondition(`'${branch}' is not a local branch in this clone`, [{ path: 'branch', rule: 'must-be-local-branch', message: branch }]);
      }
      const headSha = (headResult.value.stdout.trim().split(/\s+/)[0] ?? '') as GitSha;

      const prepared = await prepareRemote(ctx);
      if (!prepared.ok) return prepared.error;

      const stepFailure = await appendExternalStep(ctx, 'git.push.remote');
      if (stepFailure) return stepFailure;

      // `--porcelain` so "everything up to date" is a parseable line rather
      // than prose, and no `--force` — there is none in `GitPushInput` and
      // none here.
      const pushResult = await remoteGit(cwd, ['push', '--porcelain', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], signal, prepared.value.credential);
      if (!pushResult.ok) {
        return await classifyRemoteFailure(ctx, prepared.value.ref, pushResult.error, (summary) => `push of '${branch}' failed: ${summary}`);
      }

      // `--porcelain` prefixes each ref line with a status character: `=` for
      // a ref that was already up to date, `*` for a new one, a space for a
      // fast-forward. Reading the character beats matching git's prose, which
      // is localisable and has changed between versions.
      const data: GitPushData = {
        branch,
        headSha,
        alreadyUpToDate: pushResult.value.stdout.split('\n').some((line) => line.startsWith('=\t')),
      };
      return success(`pushed '${branch}'`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async fetch(ctx, _input: GitFetchInput): Promise<ToolResult<GitFetchData>> {
      const startedAtMs = Date.now();
      const configResult = await loadRepositoryConfig(ctx);
      if (!configResult.ok) return toToolResultError(configResult.error);
      const cwd = ctx.cloneRoot as ClonePath;
      const signal = ctx.signal;
      const baseBranch = configResult.value.baseBranch;

      const before = await remoteTrackingRefs(cwd, signal);

      const prepared = await prepareRemote(ctx);
      if (!prepared.ok) return prepared.error;

      const fetchResult = await remoteGit(cwd, ['fetch', 'origin'], signal, prepared.value.credential);
      if (!fetchResult.ok) {
        // Git applies a fetch's ref updates only once the transfer completes,
        // so a transfer that fails part-way leaves every remote-tracking ref
        // where it was. Nothing is undone here because nothing was done —
        // except on a timeout, where the transfer's own outcome (not just the
        // refs this function reads) is genuinely unknown, hence `timeout`.
        return await classifyRemoteFailure(ctx, prepared.value.ref, fetchResult.error, (summary) => `fetch failed: ${summary}`);
      }

      const after = await remoteTrackingRefs(cwd, signal);
      const updatedRefs = [...after.entries()].filter(([name, sha]) => before.get(name) !== sha).map(([name]) => name as BranchName);
      const upstreamSha = after.get(`origin/${baseBranch}`) ?? null;

      const data: GitFetchData = { baseBranch, upstreamSha: upstreamSha as GitSha | null, updatedRefs };
      return success(`fetched origin; ${updatedRefs.length} ref(s) updated`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async syncBase(ctx, _input: SyncBaseInput): Promise<ToolResult<SyncBaseData>> {
      const startedAtMs = Date.now();
      const configResult = await loadRepositoryConfig(ctx);
      if (!configResult.ok) return toToolResultError(configResult.error);
      const cwd = ctx.cloneRoot as ClonePath;
      const signal = ctx.signal;
      const baseBranch = configResult.value.baseBranch;

      const prepared = await prepareRemote(ctx);
      if (!prepared.ok) return prepared.error;

      const fetchResult = await remoteGit(cwd, ['fetch', 'origin', baseBranch], signal, prepared.value.credential);
      if (!fetchResult.ok) {
        return await classifyRemoteFailure(ctx, prepared.value.ref, fetchResult.error, (summary) => `could not fetch '${baseBranch}': ${summary}`);
      }

      const upstreamResult = await git(cwd, ['rev-parse', 'FETCH_HEAD'], signal);
      if (!upstreamResult.ok) {
        return upstream(`fetched '${baseBranch}' but could not read what was fetched: ${upstreamResult.error.summary}`, null);
      }
      const upstreamSha = upstreamResult.value.stdout.trim() as GitSha;

      const localResult = await git(cwd, ['rev-parse', '--verify', `refs/heads/${baseBranch}`], signal);
      const localSha = localResult.ok ? (localResult.value.stdout.trim() as GitSha) : null;

      if (localSha === upstreamSha) {
        const data: SyncBaseData = { baseBranch, headSha: upstreamSha, upstreamSha, fastForwarded: false };
        return success(`'${baseBranch}' is already current`, data, diagnosticsFor(ctx, startedAtMs, clock));
      }

      // Refuse rather than rewrite. A local base carrying commits the remote
      // does not is the incident the protected-base rule came out of, and
      // there is no reset, rebase or force path out of it on this interface —
      // the operator resolves it.
      if (localSha !== null) {
        const ancestry = await git(cwd, ['merge-base', '--is-ancestor', localSha, upstreamSha], signal);
        if (!ancestry.ok) {
          return precondition(
            `'${baseBranch}' has diverged from origin and will not be rewritten: local ${localSha} is not an ancestor of ${upstreamSha}`,
            [{ path: 'baseBranch', rule: 'fast-forwardable', message: baseBranch }],
          );
        }
      }

      const current = await currentBranch(cwd, signal);
      const advance =
        current === baseBranch
          ? // The checked-out branch cannot be moved by a ref update; a
            // fast-forward-only merge is the same movement, refusing in the
            // same case.
            await git(cwd, ['merge', '--ff-only', 'FETCH_HEAD'], signal)
          : await git(cwd, ['update-ref', `refs/heads/${baseBranch}`, upstreamSha], signal);
      if (!advance.ok) {
        return precondition(`could not fast-forward '${baseBranch}': ${advance.error.summary}`, [
          { path: 'baseBranch', rule: 'fast-forwardable', message: baseBranch },
        ]);
      }

      const data: SyncBaseData = { baseBranch, headSha: upstreamSha, upstreamSha, fastForwarded: true };
      return success(`fast-forwarded '${baseBranch}' to ${upstreamSha}`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    async raw(ctx, input: GitRawInput): Promise<ToolResult<GitRawData>> {
      const startedAtMs = Date.now();
      if (ctx.cloneRoot === null || ctx.declarationId === null) {
        const summary = 'no clone or declaration materialised for this operation';
        await finishRawJournal(ctx.operationId, ctx.declarationId, false, summary);
        return infrastructure(summary);
      }
      if (!deps.declarations) {
        const summary = 'declaration lookup is unavailable for git.raw';
        await finishRawJournal(ctx.operationId, ctx.declarationId, false, summary);
        return infrastructure(summary);
      }
      const declaration = await deps.declarations.get(ctx.declarationId);
      if (!declaration) {
        const summary = `declaration '${ctx.declarationId}' disappeared before git.raw ran`;
        await finishRawJournal(ctx.operationId, ctx.declarationId, false, summary);
        return infrastructure(summary);
      }

      // **The intent line is written before the argv is judged, not after.**
      // A refused vector is the single most attributable thing the hatch ever
      // sees — an attempt at one of the six operations the default path exists
      // to withhold — and writing the pair only for vectors that pass left
      // exactly that attempt invisible, while the registry entry promises
      // "every use is separately audited". Both records still carry the
      // scrubbed argv and the actor, so a refusal is attributable to the same
      // standard as an execution.
      const scrub = deps.exec.scrub ?? ((value: string) => value);
      const intent = await audit.append({
        at: clock.now(), operationId: ctx.operationId, declarationId: ctx.declarationId, generation: ctx.generation,
        tool: 'git_raw' as never, actorRef: ctx.actorRef, context: 'hatch', form: 'hatch-intent', argv: input.argv.map(scrub),
      });
      if (!intent.appended) {
        const summary = `git.raw refused to start because its intent audit line could not be written (${intent.reason})`;
        await finishRawJournal(ctx.operationId, ctx.declarationId, false, summary);
        return infrastructure(summary);
      }

      const rejection = rawArgvRejection(input.argv, declaration.cloneUrl);
      if (rejection) {
        const refused = validation(rejection, [{ path: 'argv', rule: 'argv-rejected', message: rejection }]);
        await audit.append({
          at: clock.now(), operationId: ctx.operationId, declarationId: ctx.declarationId, generation: ctx.generation,
          tool: 'git_raw' as never, actorRef: ctx.actorRef, context: 'hatch', form: 'hatch-outcome', resultKind: refused.kind, changedPaths: [],
        });
        await finishRawJournal(ctx.operationId, ctx.declarationId, false, rejection);
        return refused;
      }

      const cwd = ctx.cloneRoot;
      let result: ToolResult<GitRawData>;
      let changedPaths: readonly RepoRelativePath[] | null = [];
      const before = await rawStatus(cwd, ctx.signal);
      if (!before.ok) {
        result = infrastructure(`git.raw refused before acting because its initial status could not be observed: ${before.error.summary}`);
      } else {
        const prepared = await prepareRemote(ctx);
        if (!prepared.ok) {
          result = prepared.error;
        } else {
          const stepFailure = await appendExternalStep(ctx, 'git.raw.child');
          if (stepFailure) {
            result = stepFailure;
          } else {
            const executed = await exec.runGit({ argv: input.argv, cwd, timeoutSeconds: rawTimeoutSeconds, credential: prepared.value.credential, signal: ctx.signal });
            const after = await rawStatus(cwd, new AbortController().signal);
            changedPaths = after.ok ? changedRawPaths(before.value, after.value) : null;
            const withPostStateNote = (summary: string): string =>
              after.ok ? summary : `${summary}; post-state observation also failed: ${after.error.summary}`;

            if (!after.ok && executed.ok) {
              result = infrastructure(`git ${input.argv[0]} completed, but its post-state could not be observed: ${after.error.summary}`);
            } else if (executed.ok) {
              result = success(
                `git ${input.argv[0]} completed`,
                {
                  exitCode: executed.value.exitCode,
                  stdout: executed.value.stdout,
                  stderr: executed.value.stderr,
                  durationMs: executed.value.durationMs,
                  changedPaths: changedPaths!,
                },
                diagnosticsFor(ctx, startedAtMs, clock),
              );
            } else if (executed.error.code === 'timed-out') {
              result = timeoutResult(withPostStateNote(executed.error.summary), executed.error.limitSeconds);
            } else if (executed.error.code === 'cancelled') {
              result = conflict(withPostStateNote(executed.error.summary), null);
            } else if (executed.error.code === 'nonzero-exit') {
              const childSummary = `${executed.error.summary}: ${executed.error.stderr || executed.error.stdout}`;
              result = infrastructure(withPostStateNote(childSummary));
            } else {
              result = infrastructure(withPostStateNote(executed.error.summary));
            }
          }
        }
      }

      await audit.append({
        at: clock.now(), operationId: ctx.operationId, declarationId: ctx.declarationId, generation: ctx.generation,
        tool: 'git_raw' as never, actorRef: ctx.actorRef, context: 'hatch', form: 'hatch-outcome', resultKind: result.kind, changedPaths,
      });
      // Parked on a timeout regardless of whether the post-state observation
      // itself succeeded — a timed-out child leaves what it did mid-operation
      // unaccounted for even when the tree looks unchanged — and parked
      // whenever `changedPaths` is `null`, meaning the post-state observation
      // failed outright, whatever the child's own outcome was.
      const mustPark = result.kind === 'timeout' || changedPaths === null;
      await finishRawJournal(ctx.operationId, ctx.declarationId, mustPark, result.summary);
      return result;
    },

    loadRepositoryConfig,
    validateWritePath,
  };
}
