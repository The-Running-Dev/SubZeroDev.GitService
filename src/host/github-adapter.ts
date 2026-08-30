import type { CallContext } from '../shared/call-context.ts';
import type { BranchName, ClonePath, CredentialRef, GitSha, HttpsUrl, IsoUtcTimestamp } from '../shared/brands.ts';
import type { HostKind } from '../contract/capabilities.ts';
import type { Clock } from '../clock/clock.ts';
import type { CredentialBinding, Exec, ExecResult } from '../exec/exec.ts';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import { hostError, type HostError } from './errors.ts';
import type {
  CheckStatus,
  CreatePullRequestInput,
  DeployStatus,
  HostComment,
  PullRequestRef,
  PullRequestState,
  PullRequestStatus,
  RequestBudget,
} from './types.ts';

/**
 * `20-contract.md` § L2 — host adapter. There is **no merge method and no
 * rebase method on this interface, and by design there never will be** — the
 * host's own auto-merge is the only merge path. The absence is the safety
 * property: a tool that does not exist cannot be talked into existing by text
 * embedded in a pull request comment.
 */
export interface HostAdapter {
  readonly kind: HostKind;
  createPullRequest(ctx: CallContext, input: CreatePullRequestInput): Promise<Outcome<PullRequestRef, HostError>>;
  readPullRequest(ctx: CallContext, number: number): Promise<Outcome<PullRequestStatus, HostError>>;
  listPullRequests(ctx: CallContext, state: PullRequestState | null): Promise<Outcome<readonly PullRequestStatus[], HostError>>;
  readPullRequestComments(ctx: CallContext, number: number): Promise<Outcome<readonly HostComment[], HostError>>;
  enableAutoMerge(ctx: CallContext, number: number): Promise<Outcome<void, HostError>>;
  readChecks(ctx: CallContext, ref: GitSha): Promise<Outcome<readonly CheckStatus[], HostError>>;
  readDeployStatus(ctx: CallContext, workflow: string, ref: GitSha): Promise<Outcome<DeployStatus, HostError>>;
  remainingBudget(ref: CredentialRef): RequestBudget;
}

/**
 * A read may retry a 5xx up to three times; a **mutation may not retry at
 * all**. The asymmetry is the point: a retried mutation is how one request to
 * open a pull request becomes two pull requests, and a 5xx does not say
 * whether the write landed.
 */
const READ_RETRY_LIMIT = 3;
const MUTATION_RETRY_LIMIT = 0;

const HOST_READ_TIMEOUT_SECONDS = 60;
const HOST_MUTATION_TIMEOUT_SECONDS = 120;

/** GitHub's authenticated hourly REST limit. A host fact, not a policy this service invents. */
const DEFAULT_REQUEST_BUDGET = 5000;
const BUDGET_WINDOW_SECONDS = 3600;

/** Backoff between 5xx retries. Jittered so a fleet of waits does not resynchronise on the same second. */
const RETRY_BASE_MS = 500;

/**
 * `enableAutoMerge`'s preflight: how many times to re-read a pull request
 * whose `mergeable` field is still `UNKNOWN`, and how long to wait between
 * reads. GitHub usually resolves it within one or two reads; this is a
 * bounded wait, not a promise it always resolves in time.
 */
const MERGEABILITY_POLL_ATTEMPTS = 4;
const MERGEABILITY_POLL_INTERVAL_MS = 1000;

/**
 * Well above what `pr_list`'s 65536-byte result limit admits (~200 entries at
 * the fields requested). Overshooting produces a loud `infrastructure`
 * refusal; gh's own default of 30 would truncate silently.
 */
const LIST_LIMIT = 300;

/** GitHub's REST maximum. Fewer pages to walk, and the same answer. */
const API_PAGE_SIZE = 100;

type CallKind = 'read' | 'mutation';

export interface GitHubAdapterDependencies {
  readonly clock: Clock;
  readonly exec: Pick<Exec, 'runGh'>;
  /**
   * Reads the binding **already prepared for this call** — it does not resolve
   * one, and it cannot fail.
   *
   * Preparation lives one layer up, in `host-operations.ts`, because it is not
   * a host failure: the declaration lookup, the reference's own allowed-host
   * check and the resolution all happen before any network contact, and
   * `HostError` has no variant that could honestly carry an authorization
   * denial. Reporting one as `unreachable` would make a permanent refusal look
   * like a retryable dependency failure. L2 maps it through `ToolResult`
   * instead, preserving the kind, exactly as the remote git operations do.
   *
   * Null for a declaration with no `credentialRef` — a public repository read
   * is a legitimate configuration, not a refusal.
   */
  readonly credentialFor?: (ctx: CallContext) => CredentialBinding | null;
  /**
   * The declaration's `RepositoryConfig.baseBranch`. **Required for
   * `createPullRequest`**: without it, `gh pr create` falls back to the host's
   * own default branch, which is precisely the branch the declaration never
   * authorised. Omitting `--base` is not a neutral default — it is the wrong
   * base chosen silently.
   */
  readonly baseBranchFor?: (ctx: CallContext) => Promise<BranchName | null>;
  /** Injectable so tests do not spend real seconds on backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly requestBudget?: number;
}

interface BudgetState {
  remaining: number;
  windowStartedMs: number;
  resetsAt: IsoUtcTimestamp | null;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stderrOf(error: { readonly summary: string }): string {
  return 'stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string'
    ? (error as { stderr: string }).stderr
    : error.summary;
}

function statusIn(text: string): number | null {
  const match = /HTTP (\d{3})/i.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * A rate limit is recognised before anything else, because GitHub reports it
 * as a 403 — and a 403 read as an authentication rejection would mark a
 * perfectly good credential failing and take the declaration out of service
 * for a condition that clears by itself.
 */
function looksRateLimited(text: string): boolean {
  return /rate limit|secondary rate|HTTP 429|abuse detection/i.test(text);
}

function looksUnreachable(text: string): boolean {
  return /could not resolve host|connection refused|network is unreachable|no such host|EAI_AGAIN|dial tcp|i\/o timeout|TLS handshake/i.test(text);
}

function looksAuthRejected(text: string): boolean {
  return /HTTP 401|HTTP 403|bad credentials|requires authentication|must be authenticated/i.test(text);
}

function looksNotFound(text: string): boolean {
  return /HTTP 404|not found|no pull requests found/i.test(text);
}

/** GitHub reports the wait as `Retry-After` seconds, or as an absolute reset epoch. Either is accepted; 60 s is the floor when it says neither. */
function retryAfterSecondsIn(text: string, nowMs: number): number {
  const explicit = /retry[- ]after:?\s*(\d+)/i.exec(text);
  if (explicit) return Math.max(1, Number(explicit[1]));
  const reset = /x-ratelimit-reset:?\s*(\d+)/i.exec(text);
  if (reset) {
    const seconds = Math.ceil((Number(reset[1]) * 1000 - nowMs) / 1000);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return 60;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, name: string): string | null {
  const value = record[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const PR_VIEW_FIELDS = 'number,url,headRefName,headRefOid,baseRefOid,state,mergeCommit,mergeable,autoMergeRequest';

function pullRequestStatusFrom(record: Record<string, unknown>): PullRequestStatus | null {
  const number = typeof record.number === 'number' ? record.number : null;
  const url = stringField(record, 'url');
  const branch = stringField(record, 'headRefName');
  const headSha = stringField(record, 'headRefOid');
  const baseSha = stringField(record, 'baseRefOid');
  if (number === null || url === null || branch === null || headSha === null || baseSha === null) return null;

  const rawState = (stringField(record, 'state') ?? 'OPEN').toUpperCase();
  const state: PullRequestState = rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : 'open';

  const mergeCommit = asRecord(record.mergeCommit);
  const rawMergeable = stringField(record, 'mergeable');

  return {
    ref: { number, url: url as HttpsUrl, branch: branch as BranchName },
    state,
    headSha: headSha as GitSha,
    baseSha: baseSha as GitSha,
    mergeCommitSha: mergeCommit ? ((stringField(mergeCommit, 'oid') ?? null) as GitSha | null) : null,
    // `gh` reports MERGEABLE / CONFLICTING / UNKNOWN. `UNKNOWN` means the host
    // has not finished computing it, which is not the same as "cannot merge"
    // and must not be reported as `false`.
    mergeable: rawMergeable === null || rawMergeable === 'UNKNOWN' ? null : rawMergeable === 'MERGEABLE',
    autoMergeEnabled: asRecord(record.autoMergeRequest) !== null,
  };
}

function checkStatusFrom(record: Record<string, unknown>): CheckStatus | null {
  const name = stringField(record, 'name');
  if (name === null) return null;
  const status = (stringField(record, 'status') ?? '').toLowerCase();
  const raw = (stringField(record, 'conclusion') ?? '').toLowerCase();
  const detailsUrl = stringField(record, 'details_url') ?? stringField(record, 'detailsUrl');

  // A run that has not completed carries no conclusion at all. Reporting that
  // as `failure` would make a pending check terminal.
  const conclusion: CheckStatus['conclusion'] =
    status !== 'completed'
      ? 'pending'
      : raw === 'success' || raw === 'failure' || raw === 'cancelled' || raw === 'skipped'
        ? raw
        : raw === 'timed_out' || raw === 'action_required' || raw === 'stale' || raw === 'startup_failure'
          ? 'failure'
          : raw === 'neutral'
            ? 'skipped'
            : 'pending';

  return { name, conclusion, detailsUrl: detailsUrl === null ? null : (detailsUrl as HttpsUrl) };
}

export function createGitHubAdapter(deps: GitHubAdapterDependencies): HostAdapter {
  const sleep = deps.sleep ?? realSleep;
  const budgetSize = deps.requestBudget ?? DEFAULT_REQUEST_BUDGET;
  const budgets = new Map<CredentialRef, BudgetState>();

  function budgetFor(ref: CredentialRef): BudgetState {
    const nowMs = Date.parse(deps.clock.now());
    const existing = budgets.get(ref);
    if (existing && nowMs - existing.windowStartedMs < BUDGET_WINDOW_SECONDS * 1000) return existing;
    const fresh: BudgetState = { remaining: budgetSize, windowStartedMs: nowMs, resetsAt: null };
    budgets.set(ref, fresh);
    return fresh;
  }

  function chargeBudget(credential: CredentialBinding | null): void {
    if (credential === null) return;
    const state = budgetFor(credential.ref);
    state.remaining = Math.max(0, state.remaining - 1);
  }

  /** Seconds until the window resets when the budget is spent, or null when there is budget left. */
  function budgetExhausted(credential: CredentialBinding | null): number | null {
    if (credential === null) return null;
    const state = budgetFor(credential.ref);
    if (state.remaining > 0) return null;
    const nowMs = Date.parse(deps.clock.now());
    const resetsAtMs = state.resetsAt !== null ? Date.parse(state.resetsAt) : state.windowStartedMs + BUDGET_WINDOW_SECONDS * 1000;
    return Math.max(1, Math.ceil((resetsAtMs - nowMs) / 1000));
  }

  function exhaustBudget(credential: CredentialBinding | null, retryAfterSeconds: number): void {
    if (credential === null) return;
    const state = budgetFor(credential.ref);
    state.remaining = 0;
    state.resetsAt = new Date(Date.parse(deps.clock.now()) + retryAfterSeconds * 1000).toISOString() as IsoUtcTimestamp;
  }

  function credentialFor(ctx: CallContext): CredentialBinding | null {
    return deps.credentialFor ? deps.credentialFor(ctx) : null;
  }

  /**
   * One `gh` invocation, with the retry policy the contract fixes: a 5xx is
   * retried up to three times for a read and **never** for a mutation, and
   * nothing else is retried at all. `attempts` is carried out on the
   * `server-error` variant so the count is assertable rather than described.
   */
  async function gh(
    ctx: CallContext,
    kind: CallKind,
    argv: readonly string[],
  ): Promise<Outcome<ExecResult, HostError>> {
    if (ctx.cloneRoot === null) {
      return err(hostError({ code: 'not-found', resource: 'clone' }, 'no clone is materialised for this declaration, so no host repository can be inferred'));
    }
    const cwd = ctx.cloneRoot as ClonePath;

    const credential = credentialFor(ctx);

    const retryLimit = kind === 'read' ? READ_RETRY_LIMIT : MUTATION_RETRY_LIMIT;
    const timeoutSeconds = kind === 'read' ? HOST_READ_TIMEOUT_SECONDS : HOST_MUTATION_TIMEOUT_SECONDS;
    let attempts = 0;

    for (;;) {
      // The contract's `rate-limited` row reads "the per-credential budget
      // tripped, **or** the host said so" — so an exhausted budget raises the
      // same error the host would, before the request is made rather than
      // after it is refused. A budget that is counted but never consulted
      // bounds nothing.
      const exhausted = budgetExhausted(credential);
      if (exhausted !== null) {
        return err(
          hostError(
            { code: 'rate-limited', retryAfterSeconds: exhausted },
            `the per-credential request budget for this window is exhausted; retry after ${exhausted}s`,
          ),
        );
      }

      attempts += 1;
      chargeBudget(credential);

      const result = await deps.exec.runGh({
        argv,
        cwd,
        timeoutSeconds,
        credential: credential,
        signal: ctx.signal,
      });

      if (result.ok) return ok(result.value);

      if (result.error.code === 'timed-out') {
        return err(hostError({ code: 'timed-out', limitSeconds: timeoutSeconds }, `the host call exceeded its ${timeoutSeconds}s cap`));
      }
      if (result.error.code === 'cancelled') {
        return err(hostError({ code: 'unreachable' }, 'the host call was cancelled'));
      }

      const text = stderrOf(result.error);
      const nowMs = Date.parse(deps.clock.now());

      if (looksRateLimited(text)) {
        const retryAfterSeconds = retryAfterSecondsIn(text, nowMs);
        exhaustBudget(credential, retryAfterSeconds);
        return err(
          hostError(
            { code: 'rate-limited', retryAfterSeconds },
            `the host rate-limited this request; retry after ${retryAfterSeconds}s`,
          ),
        );
      }
      if (looksUnreachable(text)) {
        return err(hostError({ code: 'unreachable' }, `the host could not be reached: ${text.trim().slice(0, 200)}`));
      }
      if (looksAuthRejected(text)) {
        const bound = credential;
        if (bound === null) {
          return err(hostError({ code: 'unreachable' }, 'the host requires authentication and this declaration carries no credential reference'));
        }
        return err(
          hostError(
            { code: 'auth-rejected', ref: bound.ref, declarationId: bound.declarationId },
            `the host refused credential reference '${bound.ref}' for declaration '${bound.declarationId}'`,
          ),
        );
      }

      const status = statusIn(text);
      if (status !== null && status >= 500) {
        if (attempts <= retryLimit) {
          await sleep(RETRY_BASE_MS * attempts + Math.floor(Math.random() * RETRY_BASE_MS));
          continue;
        }
        return err(
          hostError(
            { code: 'server-error', status, attempts },
            `the host returned ${status} after ${attempts} attempt(s)`,
          ),
        );
      }
      if (looksNotFound(text)) {
        return err(hostError({ code: 'not-found', resource: argv.join(' ') }, `the host has no such resource: ${text.trim().slice(0, 200)}`));
      }

      return err(hostError({ code: 'unreachable' }, `the host call failed: ${text.trim().slice(0, 200)}`));
    }
  }

  async function readPullRequest(ctx: CallContext, number: number): Promise<Outcome<PullRequestStatus, HostError>> {
    const result = await gh(ctx, 'read', ['pr', 'view', String(number), '--json', PR_VIEW_FIELDS]);
    if (!result.ok) return err(result.error);
    const record = asRecord(parseJson(result.value.stdout));
    const status = record === null ? null : pullRequestStatusFrom(record);
    if (status === null) {
      return err(hostError({ code: 'not-found', resource: `pull request ${number}` }, `the host returned no readable pull request ${number}`));
    }
    return ok(status);
  }

  return {
    kind: 'github',

    async createPullRequest(ctx, input): Promise<Outcome<PullRequestRef, HostError>> {
      // The base is the declaration's, and it is passed **explicitly**.
      // `CreatePullRequestInput` carries no base so that no caller can name
      // one; that guarantee is only worth anything if the declaration's base
      // is then actually applied. Leaving `--base` off would hand the choice
      // to the host's default branch instead, which is a branch the
      // declaration never authorised — the same failure the input's omission
      // was meant to prevent, arriving through the other door.
      const base = deps.baseBranchFor ? await deps.baseBranchFor(ctx) : null;
      if (base === null) {
        return err(
          hostError(
            { code: 'not-found', resource: 'base branch' },
            "this declaration's base branch could not be resolved, and a pull request will not be opened against the host's default instead",
          ),
        );
      }

      const argv = ['pr', 'create', '--title', input.title, '--body', input.body, '--base', base as string];
      if (input.headBranch !== null) argv.push('--head', input.headBranch as string);
      if (input.draft) argv.push('--draft');

      const created = await gh(ctx, 'mutation', argv);
      if (!created.ok) return err(created.error);

      // `gh pr create` prints the new pull request's URL and nothing else.
      const url = created.value.stdout.trim().split('\n').pop()?.trim() ?? '';
      const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? NaN);
      if (!Number.isFinite(number)) {
        return err(hostError({ code: 'not-found', resource: 'created pull request' }, 'the host accepted the pull request but returned no readable URL'));
      }

      const status = await readPullRequest(ctx, number);
      if (!status.ok) return err(status.error);
      return ok(status.value.ref);
    },

    readPullRequest,

    async listPullRequests(ctx, state): Promise<Outcome<readonly PullRequestStatus[], HostError>> {
      // `--state` is always passed. `gh pr list` defaults to open-only, so
      // omitting it for the null case would turn "no state filter" into
      // "open pull requests", silently dropping every closed and merged one.
      //
      // `--limit` is well above what `maxResultBytes` admits, deliberately:
      // gh's own default of 30 truncates silently, whereas overshooting the
      // size limit fails loudly as `infrastructure`. A wrong answer nobody
      // can detect is worse than a refusal.
      const argv = ['pr', 'list', '--json', PR_VIEW_FIELDS, '--limit', String(LIST_LIMIT), '--state', state ?? 'all'];
      const result = await gh(ctx, 'read', argv);
      if (!result.ok) return err(result.error);
      const parsed = parseJson(result.value.stdout);
      if (!Array.isArray(parsed)) return ok([]);
      const statuses: PullRequestStatus[] = [];
      for (const item of parsed) {
        const record = asRecord(item);
        const status = record === null ? null : pullRequestStatusFrom(record);
        if (status !== null) statuses.push(status);
      }
      return ok(statuses);
    },

    async readPullRequestComments(ctx, number): Promise<Outcome<readonly HostComment[], HostError>> {
      const result = await gh(ctx, 'read', ['pr', 'view', String(number), '--json', 'comments']);
      if (!result.ok) return err(result.error);
      const record = asRecord(parseJson(result.value.stdout));
      const raw = record?.comments;
      if (!Array.isArray(raw)) return ok([]);

      const comments: HostComment[] = [];
      for (const item of raw) {
        const entry = asRecord(item);
        if (entry === null) continue;
        const author = asRecord(entry.author);
        const createdAt = stringField(entry, 'createdAt');
        comments.push({
          author: (author ? stringField(author, 'login') : null) ?? 'unknown',
          // Carried verbatim as data. Never parsed, never interpreted, and the
          // tool that returns it is annotated `untrustedOutput`.
          body: typeof entry.body === 'string' ? entry.body : '',
          createdAt: (createdAt ?? deps.clock.now()) as IsoUtcTimestamp,
        });
      }
      return ok(comments);
    },

    async enableAutoMerge(ctx, number): Promise<Outcome<void, HostError>> {
      // GitHub's `--auto` merge API always exits 0, even against a pull
      // request that can never merge — it leaves auto-merge queued forever
      // instead of reporting the conflict, so the command's own failure below
      // can never see one. A direct read forces the host to compute
      // mergeability, but that can still read `UNKNOWN` for a few seconds
      // right after a push, so this polls a bounded number of times rather
      // than trusting one read that may still be in flight. Decision:
      // design/90-decisions.md, 2026-08-30.
      for (let attempt = 1; attempt <= MERGEABILITY_POLL_ATTEMPTS; attempt++) {
        const preflight = await readPullRequest(ctx, number);
        if (!preflight.ok) break;
        if (preflight.value.mergeable === false) {
          return err(
            hostError(
              { code: 'merge-conflict', pullRequest: preflight.value.ref, headSha: preflight.value.headSha, baseSha: preflight.value.baseSha },
              `pull request #${number} on branch '${preflight.value.ref.branch}' cannot merge: head ${preflight.value.headSha} conflicts with base ${preflight.value.baseSha}`,
            ),
          );
        }
        if (preflight.value.mergeable === true) break;
        if (attempt < MERGEABILITY_POLL_ATTEMPTS) await sleep(MERGEABILITY_POLL_INTERVAL_MS);
      }

      const result = await gh(ctx, 'mutation', ['pr', 'merge', String(number), '--auto', '--squash']);
      if (result.ok) return ok(undefined);

      // A pull request the host will not merge is terminal, and the operator
      // needs both heads to see why. That costs a read the failure path did
      // not otherwise need, which is the right trade for the one error an
      // operator has to act on by hand. There is no rebase tool to offer
      // instead, and by design there never will be.
      if (result.error.code === 'not-found' || /not mergeable|merge conflict|conflicts? with the base|cannot be merged/i.test(result.error.summary)) {
        const status = await readPullRequest(ctx, number);
        if (status.ok && status.value.mergeable === false) {
          return err(
            hostError(
              { code: 'merge-conflict', pullRequest: status.value.ref, headSha: status.value.headSha, baseSha: status.value.baseSha },
              `pull request #${number} on branch '${status.value.ref.branch}' cannot merge: head ${status.value.headSha} conflicts with base ${status.value.baseSha}`,
            ),
          );
        }
      }
      return err(result.error);
    },

    /**
     * Every page, not just the first. GitHub returns 30 check runs by
     * default, and a partial list is worse here than an error: `checks_await`
     * decides it is finished when nothing is pending, so an omitted pending
     * check would report a commit as concluded while it is still building.
     */
    async readChecks(ctx, ref): Promise<Outcome<readonly CheckStatus[], HostError>> {
      const result = await gh(ctx, 'read', [
        'api',
        '--paginate',
        '--slurp',
        `repos/{owner}/{repo}/commits/${ref as string}/check-runs?per_page=${API_PAGE_SIZE}`,
      ]);
      if (!result.ok) return err(result.error);

      // `--slurp` wraps the pages in an array. Accept a bare object too, so a
      // gh build without `--slurp` degrades to the first page rather than to
      // an empty list that would read as "no checks at all".
      const parsed = parseJson(result.value.stdout);
      const pages = Array.isArray(parsed) ? parsed : [parsed];

      const checks: CheckStatus[] = [];
      for (const page of pages) {
        const record = asRecord(page);
        const raw = record?.check_runs;
        if (!Array.isArray(raw)) continue;
        for (const item of raw) {
          const entry = asRecord(item);
          const check = entry === null ? null : checkStatusFrom(entry);
          if (check !== null) checks.push(check);
        }
      }
      return ok(checks);
    },

    /**
     * Implemented because the interface fixes it, and reachable from no
     * surface: S10 registers no tool over it. Deploy monitoring and
     * published-URL verification are S12's, and S10's `Out of scope` line
     * says so.
     */
    async readDeployStatus(ctx, workflow, ref): Promise<Outcome<DeployStatus, HostError>> {
      const result = await gh(ctx, 'read', ['api', `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?head_sha=${ref as string}&per_page=1`]);
      if (!result.ok) return err(result.error);
      const record = asRecord(parseJson(result.value.stdout));
      const runs = record?.workflow_runs;
      const first = Array.isArray(runs) ? asRecord(runs[0]) : null;
      if (first === null) {
        return err(hostError({ code: 'not-found', resource: `workflow ${workflow} at ${ref as string}` }, `no run of workflow '${workflow}' exists for ${ref as string}`));
      }
      const status = (stringField(first, 'status') ?? '').toLowerCase();
      const raw = (stringField(first, 'conclusion') ?? '').toLowerCase();
      const conclusion: DeployStatus['conclusion'] =
        status !== 'completed' ? 'pending' : raw === 'success' || raw === 'failure' || raw === 'cancelled' ? raw : 'failure';
      return ok({
        workflow,
        commitSha: ref,
        conclusion,
        detailsUrl: (stringField(first, 'html_url') ?? null) as HttpsUrl | null,
      });
    },

    remainingBudget(ref): RequestBudget {
      const state = budgetFor(ref);
      return { remaining: state.remaining, resetsAt: state.resetsAt };
    },
  };
}
