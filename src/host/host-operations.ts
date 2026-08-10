import type { Clock } from '../clock/clock.ts';
import type { CallContext, DomainOperation } from '../shared/call-context.ts';
import type { GitSha, OperationId } from '../shared/brands.ts';
import type { Journal } from '../journal/journal.ts';
import type { CredentialBinding, Exec } from '../exec/exec.ts';
import { success, validation, authorization, precondition, timeout as timeoutResult, upstream, infrastructure, type ToolResult } from '../result/envelope.ts';
import { diagnosticsFor } from '../shared/diagnostics.ts';
import type { Outcome } from '../shared/outcome.ts';
import type { ModuleErrorBase } from '../shared/result-kind.ts';
import type { HostAdapter } from './github-adapter.ts';
import type { HostError } from './errors.ts';
import type {
  ChecksAwaitData,
  ChecksAwaitInput,
  ChecksStatusData,
  ChecksStatusInput,
  CreatePullRequestInput,
  PrCommentsData,
  PrCommentsInput,
  PrEnableAutoMergeData,
  PrEnableAutoMergeInput,
  PrListData,
  PrListInput,
  PrOpenData,
  PrStatusData,
  PrStatusInput,
} from './types.ts';

const POLL_INTERVAL_SECONDS_DEFAULT = 15;

export interface HostOperations {
  readonly createPullRequest: DomainOperation<CreatePullRequestInput, PrOpenData>;
  readonly readPullRequest: DomainOperation<PrStatusInput, PrStatusData>;
  readonly listPullRequests: DomainOperation<PrListInput, PrListData>;
  readonly readPullRequestComments: DomainOperation<PrCommentsInput, PrCommentsData>;
  readonly enableAutoMerge: DomainOperation<PrEnableAutoMergeInput, PrEnableAutoMergeData>;
  readonly readChecks: DomainOperation<ChecksStatusInput, ChecksStatusData>;
  readonly awaitChecks: DomainOperation<ChecksAwaitInput, ChecksAwaitData>;
}

export interface HostOperationsDependencies {
  readonly clock: Clock;
  readonly adapter: HostAdapter;
  /**
   * Required for the two mutating host tools. Every host mutation writes an
   * `applied` journal step **before** the network call — see `hostMutation`
   * below for why that ordering is the whole point.
   */
  readonly journal?: Pick<Journal, 'appendStep'>;
  /** Reads the clone's current head, for the two check tools' null `ref`. */
  readonly headShaFor: (ctx: CallContext) => Promise<GitSha | null>;
  /**
   * The three-step credential preparation — declaration, the reference's own
   * allowed-host check, resolution — run **here** rather than inside the
   * adapter, and mapped through `moduleErrorToToolResult` so the error keeps
   * its own kind. An allowed-host denial is `authorization`: a permanent
   * refusal that no retry will fix. Inside the adapter it could only have come
   * back as a `HostError`, whose every variant is either `upstream` or a
   * repository-state `precondition` — so the denial would have read as a
   * retryable dependency failure, and the git path (which does exactly this,
   * one layer up) and the host path would disagree about the same failure.
   */
  readonly prepareCredential?: (ctx: CallContext) => Promise<Outcome<CredentialBinding | null, ModuleErrorBase>>;
  /**
   * Where a prepared binding is left for the adapter to read, keyed by
   * `operationId` so concurrent calls never see each other's. The composition
   * root owns the map and hands the same one to both — the same seam
   * `credentialEnv` already is between `CredentialResolver` and `Exec`.
   */
  readonly credentialBindings?: Map<OperationId, CredentialBinding | null>;
  readonly exec?: Pick<Exec, 'runGit'>;
  readonly pollIntervalSeconds?: number;
  /** Injectable so a wait test does not spend real seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps any `ModuleErrorBase`-shaped error by its own `resultKind` — which is the whole point: an `authorization` denial stays `authorization`. */
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
    case 'timeout':
      return timeoutResult(error.summary, 0);
    default:
      return infrastructure(error.summary);
  }
}

/**
 * `20-contract.md` § Error semantics › Host adapter, one row at a time.
 *
 * The row that matters most is `rate-limited` → **`upstream`, never
 * `precondition`**: the design records that exact misclassification as a
 * defect it had. A rate limit is an unavailable dependency, not a repository
 * state, and telling an operator their repository is in a bad state when the
 * host is simply busy sends them to fix something that is not broken.
 */
export function hostErrorToToolResult(error: HostError): ToolResult<never> {
  switch (error.code) {
    case 'rate-limited':
      return upstream(error.summary, error.retryAfterSeconds);
    case 'unreachable':
    case 'server-error':
    case 'auth-rejected':
      return upstream(error.summary, null);
    case 'merge-conflict':
      return precondition(error.summary, [
        { path: 'branch', rule: 'merge-conflict', message: error.pullRequest.branch as string },
        { path: 'headSha', rule: 'merge-conflict', message: error.headSha as string },
        { path: 'baseSha', rule: 'merge-conflict', message: error.baseSha as string },
      ]);
    case 'required-check-failed':
      // Both fields, because `TerminalState.required-check-failed` needs both:
      // a check name with no pull request tells an operator that something
      // failed but not where to go and look.
      return precondition(error.summary, [
        { path: 'check', rule: 'required-check-failed', message: error.check },
        { path: 'pullRequest', rule: 'required-check-failed', message: String(error.pullRequest.number) },
      ]);
    case 'not-found':
      return precondition(error.summary, [{ path: 'resource', rule: 'not-found', message: error.resource }]);
    case 'timed-out':
      return timeoutResult(error.summary, error.limitSeconds);
    default:
      return infrastructure((error as HostError).summary);
  }
}

export function createHostOperations(deps: HostOperationsDependencies): HostOperations {
  const { clock, adapter } = deps;
  const sleep = deps.sleep ?? realSleep;
  const pollIntervalSeconds = deps.pollIntervalSeconds ?? POLL_INTERVAL_SECONDS_DEFAULT;

  /**
   * A host mutation's effect lands on the host, where local pre-state cannot
   * see it. `classify()` distinguishes "never ran" from "ran and crashed"
   * using pre-state for a local mutation — and that signal is blind here,
   * because opening a pull request changes nothing in the clone.
   *
   * The journal step is what closes that. Written **before** the network call,
   * it means a process killed between the step and the call leaves an entry
   * with a step and an unchanged tree, which `classify` refuses to call
   * `nothing-happened` and the descriptor parks. Written after, the same kill
   * would leave no step and an unchanged tree — indistinguishable from a call
   * that never happened, and a retry would open a second pull request.
   *
   * Parking is the correct outcome and not a shortfall: the service cannot
   * tell from here whether the pull request exists, and an operator looking at
   * the host can.
   */
  async function hostMutation<TData>(ctx: CallContext, step: string, call: () => Promise<ToolResult<TData>>): Promise<ToolResult<TData>> {
    if (!deps.journal) {
      return infrastructure(`host mutation '${step}' has no journal configured, and will not reach a host without one`);
    }
    const appended = await deps.journal.appendStep(ctx.operationId, step);
    if (!appended.ok) {
      // The step could not be written, so the crash window would be
      // unrecoverable. Refuse before the network call rather than accept an
      // effect nothing can classify.
      return infrastructure(`could not record the '${step}' journal step before the host call: ${appended.error.summary}`);
    }
    return call();
  }

  async function resolveRef(ctx: CallContext, requested: GitSha | null): Promise<GitSha | null> {
    return requested ?? (await deps.headShaFor(ctx));
  }

  /**
   * Prepares the credential, leaves it where the adapter will find it, runs
   * the call, and clears it again — cleared in a `finally`, so a thrown error
   * cannot leave a resolved binding sitting in a process-lifetime map.
   *
   * A preparation failure never reaches the adapter at all. It is mapped here,
   * where `authorization` survives as `authorization`.
   */
  async function withCredential<TData>(ctx: CallContext, call: () => Promise<ToolResult<TData>>): Promise<ToolResult<TData>> {
    if (!deps.prepareCredential || !deps.credentialBindings) return call();

    const prepared = await deps.prepareCredential(ctx);
    if (!prepared.ok) return moduleErrorToToolResult(prepared.error);

    deps.credentialBindings.set(ctx.operationId, prepared.value);
    try {
      return await call();
    } finally {
      deps.credentialBindings.delete(ctx.operationId);
    }
  }

  return {
    async createPullRequest(ctx, input): Promise<ToolResult<PrOpenData>> {
      const startedAtMs = Date.parse(clock.now());
      return withCredential(ctx, () => hostMutation(ctx, 'host.createPullRequest', async () => {
        const created = await adapter.createPullRequest(ctx, input);
        if (!created.ok) return hostErrorToToolResult(created.error);
        return success(`opened pull request #${created.value.number}`, { ref: created.value }, diagnosticsFor(ctx, startedAtMs, clock));
      }));
    },

    async readPullRequest(ctx, input): Promise<ToolResult<PrStatusData>> {
      const startedAtMs = Date.parse(clock.now());
      return withCredential(ctx, async () => {
        const status = await adapter.readPullRequest(ctx, input.number);
        if (!status.ok) return hostErrorToToolResult(status.error);
        return success(`pull request #${input.number} is ${status.value.state}`, { status: status.value }, diagnosticsFor(ctx, startedAtMs, clock));
      });
    },

    async listPullRequests(ctx, input): Promise<ToolResult<PrListData>> {
      const startedAtMs = Date.parse(clock.now());
      return withCredential(ctx, async () => {
        const listed = await adapter.listPullRequests(ctx, input.state);
        if (!listed.ok) return hostErrorToToolResult(listed.error);
        return success(`${listed.value.length} pull request(s)`, { pullRequests: listed.value }, diagnosticsFor(ctx, startedAtMs, clock));
      });
    },

    async readPullRequestComments(ctx, input): Promise<ToolResult<PrCommentsData>> {
      const startedAtMs = Date.parse(clock.now());
      return withCredential(ctx, async () => {
        const comments = await adapter.readPullRequestComments(ctx, input.number);
        if (!comments.ok) return hostErrorToToolResult(comments.error);
        // Bodies are carried through verbatim as data. Nothing here reads them,
        // and the registry entry is annotated `untrustedOutput` so no consumer
        // mistakes them for instructions.
        return success(
          `${comments.value.length} comment(s) on pull request #${input.number}`,
          { comments: comments.value },
          diagnosticsFor(ctx, startedAtMs, clock),
        );
      });
    },

    async enableAutoMerge(ctx, input): Promise<ToolResult<PrEnableAutoMergeData>> {
      const startedAtMs = Date.parse(clock.now());
      return withCredential(ctx, () => hostMutation(ctx, 'host.enableAutoMerge', async () => {
        const enabled = await adapter.enableAutoMerge(ctx, input.number);
        if (!enabled.ok) return hostErrorToToolResult(enabled.error);
        return success(
          `auto-merge enabled on pull request #${input.number}`,
          { number: input.number, autoMergeEnabled: true },
          diagnosticsFor(ctx, startedAtMs, clock),
        );
      }));
    },

    async readChecks(ctx, input): Promise<ToolResult<ChecksStatusData>> {
      const startedAtMs = Date.parse(clock.now());
      const ref = await resolveRef(ctx, input.ref);
      if (ref === null) return precondition('no commit to read checks for: the clone has no resolvable head', []);
      return withCredential(ctx, async () => {
        const checks = await adapter.readChecks(ctx, ref);
        if (!checks.ok) return hostErrorToToolResult(checks.error);
        return success(`${checks.value.length} check(s) at ${ref}`, { ref, checks: checks.value }, diagnosticsFor(ctx, startedAtMs, clock));
      });
    },

    /**
     * The registry's only `monitoring-wait`. It holds no lock — the dispatch
     * pipeline releases the materialisation lock before this runs and never
     * takes the mutation lock — so a thirty-minute wait on one repository
     * delays nothing on any other.
     *
     * `input.timeoutSeconds` arrives already clamped to the cap by the
     * pipeline (invariant C6), so this treats it as authoritative rather than
     * re-deriving it. Clamping in two places is how the two drift apart.
     */
    async awaitChecks(ctx, input): Promise<ToolResult<ChecksAwaitData>> {
      const startedAtMs = Date.parse(clock.now());
      const ref = await resolveRef(ctx, input.ref);
      if (ref === null) return precondition('no commit to wait on: the clone has no resolvable head', []);

      const deadlineMs = startedAtMs + Math.max(0, input.timeoutSeconds) * 1000;
      let lastChecks: readonly ChecksAwaitData['checks'][number][] = [];

      return withCredential(ctx, async () => {
      for (;;) {
        const checks = await adapter.readChecks(ctx, ref);
        if (!checks.ok) {
          // A rate limit backs off and keeps waiting rather than failing the
          // wait — the contract's own note that "monitoring waits back off
          // with jitter". Everything else is terminal for the wait.
          //
          // The backoff is clamped to what is left of the deadline. A
          // retry-after of an hour against a wait with a second left would
          // otherwise sleep for the hour and only then notice the cap, which
          // is the bounded-wait guarantee broken by the one path that looks
          // like it is honouring it.
          if (checks.error.code === 'rate-limited') {
            const remainingMs = deadlineMs - Date.parse(clock.now());
            const backoffMs = checks.error.retryAfterSeconds * 1000 + Math.floor(Math.random() * 1000);
            if (remainingMs > 0 && backoffMs < remainingMs) {
              await sleep(backoffMs);
              continue;
            }
            return timeoutResult(
              `checks at ${ref} were still rate-limited when the ${input.timeoutSeconds}s wait ran out`,
              input.timeoutSeconds,
            );
          }
          return hostErrorToToolResult(checks.error);
        }
        lastChecks = checks.value;

        const pending = lastChecks.filter((check) => check.conclusion === 'pending');
        if (pending.length === 0) {
          const waitedSeconds = Math.round((Date.parse(clock.now()) - startedAtMs) / 1000);
          return success(
            `every check at ${ref} concluded after ${waitedSeconds}s`,
            { ref, checks: lastChecks, concluded: true, waitedSeconds },
            diagnosticsFor(ctx, startedAtMs, clock),
          );
        }

        if (ctx.signal.aborted) {
          return timeoutResult(`the wait on ${ref} was cancelled`, input.timeoutSeconds);
        }
        if (Date.parse(clock.now()) + pollIntervalSeconds * 1000 >= deadlineMs) {
          return timeoutResult(
            `checks at ${ref} had not concluded within ${input.timeoutSeconds}s (${pending.length} still pending)`,
            input.timeoutSeconds,
          );
        }
        await sleep(pollIntervalSeconds * 1000);
      }
      });
    },
  };
}
