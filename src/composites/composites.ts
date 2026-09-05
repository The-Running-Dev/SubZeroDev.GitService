import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BranchName, ClonePath, GitSha } from '../shared/brands.ts';
import type { CallContext, DomainOperation } from '../shared/call-context.ts';
import type { Clock } from '../clock/clock.ts';
import type { Exec } from '../exec/exec.ts';
import type { Journal } from '../journal/journal.ts';
import type { GitOperations } from '../git/git-operations.ts';
import type { HostOperations } from '../host/host-operations.ts';
import { success, precondition, infrastructure, type ToolResult } from '../result/envelope.ts';
import { diagnosticsFor } from '../shared/diagnostics.ts';
import { currentBranch as sharedCurrentBranch } from '../exec/primitives.ts';
import type { PrepareBranchData, PrepareBranchInput, ReconcileAfterMergeData, ReconcileAfterMergeInput } from './types.ts';

/**
 * `20-contract.md` § L2 — composites. Journal step names, exported so a test
 * can kill at each boundary in turn (S12.4) without guessing what this
 * module happens to call them.
 */
export const PREPARE_BRANCH_STEPS = {
  fetch: 'composites.prepareBranch.fetch',
  materialize: 'composites.prepareBranch.materialize',
  checkout: 'composites.prepareBranch.checkout',
} as const;

export const RECONCILE_AFTER_MERGE_STEPS = {
  confirmMerged: 'composites.reconcileAfterMerge.confirmMerged',
  fetch: 'composites.reconcileAfterMerge.fetch',
  advanceBase: 'composites.reconcileAfterMerge.advanceBase',
  deleteBranch: 'composites.reconcileAfterMerge.deleteBranch',
} as const;

export interface Composites {
  readonly prepareBranch: DomainOperation<PrepareBranchInput, PrepareBranchData>;
  readonly reconcileAfterMerge: DomainOperation<ReconcileAfterMergeInput, ReconcileAfterMergeData>;
}

export interface CompositesDependencies {
  readonly clock: Clock;
  /** Local (non-credentialed) git plumbing only — branch, checkout, rebase, ref reads. The one network step goes through `gitOperations.fetch`, which already carries credential preparation. */
  readonly exec: Pick<Exec, 'runGit'>;
  readonly gitOperations: Pick<GitOperations, 'fetch' | 'loadRepositoryConfig'>;
  readonly hostOperations: Pick<HostOperations, 'readPullRequest'>;
  readonly journal: Pick<Journal, 'appendStep'>;
}

const LOCAL_COMMAND_TIMEOUT_SECONDS = 30;

export function createComposites(deps: CompositesDependencies): Composites {
  const { clock, exec, gitOperations, hostOperations, journal } = deps;

  async function git(cwd: ClonePath, args: readonly string[], signal: AbortSignal) {
    return exec.runGit({ argv: args, cwd, timeoutSeconds: LOCAL_COMMAND_TIMEOUT_SECONDS, credential: null, signal });
  }

  async function step(ctx: CallContext, name: string): Promise<ToolResult<never> | null> {
    const appended = await journal.appendStep(ctx.operationId, name);
    if (!appended.ok) {
      return infrastructure(`could not record the '${name}' journal step before acting: ${appended.error.summary}`);
    }
    return null;
  }

  async function currentBranch(cwd: ClonePath, signal: AbortSignal): Promise<BranchName | null> {
    return sharedCurrentBranch(exec, cwd, LOCAL_COMMAND_TIMEOUT_SECONDS, signal);
  }

  /** `rev-list` stdout as shas, or `fallback` when the call failed (or never ran). */
  function revListShas(result: Awaited<ReturnType<typeof git>> | null, fallback: readonly GitSha[]): readonly GitSha[] {
    return result !== null && result.ok ? (result.value.stdout.split('\n').filter((l) => l.length > 0) as GitSha[]) : fallback;
  }

  async function revParse(cwd: ClonePath, ref: string, signal: AbortSignal): Promise<GitSha | null> {
    const result = await git(cwd, ['rev-parse', '--verify', ref], signal);
    return result.ok ? (result.value.stdout.trim() as GitSha) : null;
  }

  async function refExists(cwd: ClonePath, ref: string, signal: AbortSignal): Promise<boolean> {
    const result = await git(cwd, ['show-ref', '--verify', '--quiet', ref], signal);
    return result.ok;
  }

  async function isAncestor(cwd: ClonePath, ancestor: GitSha, descendant: GitSha, signal: AbortSignal): Promise<boolean> {
    const result = await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], signal);
    return result.ok;
  }

  /** Working tree, index and untracked files must all be clean — protected-base invariant 5. */
  async function isWorkingTreeClean(cwd: ClonePath, signal: AbortSignal): Promise<boolean> {
    const result = await git(cwd, ['status', '--porcelain'], signal);
    return result.ok && result.value.stdout.trim().length === 0;
  }

  /**
   * A prior attempt killed mid-rebase leaves `.git/rebase-merge` or
   * `.git/rebase-apply` on disk. Aborting it is the self-heal every resume
   * (and every ordinary retry — the two are indistinguishable to this
   * function) needs before touching anything else: `git rebase --abort`
   * moves HEAD back to the feature branch tip it started from, which is
   * already a durable ref by the time any rebase runs (see `materialize`
   * below) — protected-base invariant 6, "conflicts stop safely without
   * losing the original commits", applies here as much as to a fresh
   * conflict.
   */
  async function abortStaleRebase(cwd: ClonePath, signal: AbortSignal): Promise<void> {
    const gitDirResult = await git(cwd, ['rev-parse', '--git-dir'], signal);
    if (!gitDirResult.ok) return;
    const gitDir = gitDirResult.value.stdout.trim();
    const gitDirAbs = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);
    if (existsSync(path.join(gitDirAbs, 'rebase-merge')) || existsSync(path.join(gitDirAbs, 'rebase-apply'))) {
      await git(cwd, ['rebase', '--abort'], signal);
    }
  }

  /**
   * Rebases `branch` onto `remoteBaseSha`. Invariant 6 — a conflict aborts
   * the rebase rather than leaving it in progress, and the original commits
   * stay reachable from `branch`'s own ref throughout (it was created, or
   * already existed, before this ever runs).
   */
  async function rebaseOntoRemoteBase(
    cwd: ClonePath,
    branch: BranchName,
    remoteBaseSha: GitSha,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: ToolResult<never> }> {
    const checkedOut = await currentBranch(cwd, signal);
    if (checkedOut !== branch) {
      const switched = await git(cwd, ['checkout', branch], signal);
      if (!switched.ok) return { ok: false, error: infrastructure(`could not check out '${branch}' to rebase it: ${switched.error.summary}`) };
    }
    const rebased = await git(cwd, ['rebase', remoteBaseSha], signal);
    if (rebased.ok) return { ok: true };

    await git(cwd, ['rebase', '--abort'], signal);
    const originalTip = await revParse(cwd, `refs/heads/${branch}`, signal);
    return {
      ok: false,
      error: precondition(
        `rebasing '${branch}' onto ${remoteBaseSha} conflicted; the rebase was aborted and every original commit remains reachable from '${branch}'${originalTip ? ` at ${originalTip}` : ''}`,
        [
          { path: 'branch', rule: 'rebase-conflict', message: branch },
          { path: 'baseSha', rule: 'rebase-conflict', message: remoteBaseSha },
        ],
      ),
    };
  }

  return {
    /**
     * `20-contract.md` § L2 — composites. `TODO-NEXT.md` §7.2's seven
     * invariants, §7.3's algorithm, generalised off blog-specific naming.
     */
    async prepareBranch(ctx, input: PrepareBranchInput): Promise<ToolResult<PrepareBranchData>> {
      const startedAtMs = Date.now();
      if (ctx.cloneRoot === null) return infrastructure('no clone materialised for this operation');
      const cwd = ctx.cloneRoot;
      const signal = ctx.signal;

      const configResult = await gitOperations.loadRepositoryConfig(ctx);
      if (!configResult.ok) return infrastructure(configResult.error.summary);
      const baseBranch = configResult.value.baseBranch as BranchName;

      // Self-heal ahead of the clean-tree check: an in-progress rebase from a
      // killed prior attempt reads as a dirty tree otherwise, which would
      // refuse a resume for the very condition the resume exists to repair.
      await abortStaleRebase(cwd, signal);

      // Invariant 5 — uncommitted changes are never carried implicitly.
      if (!(await isWorkingTreeClean(cwd, signal))) {
        return precondition('branch preparation refuses with a dirty working tree — commit, stash or discard first', [
          { path: 'workingTree', rule: 'must-be-clean', message: 'staged, unstaged or untracked changes present' },
        ]);
      }

      // Invariant 2 — fetch and evaluate ancestry before any content write.
      // The already-pushed-branch guard below reads remote-tracking refs, so
      // it runs after this, on freshly fetched state rather than whatever
      // this clone happened to have on disk before.
      const stepFetch = await step(ctx, PREPARE_BRANCH_STEPS.fetch);
      if (stepFetch) return stepFetch;
      const fetched = await gitOperations.fetch(ctx, {});
      if (!fetched.ok) return fetched as ToolResult<never>;

      // An already-pushed branch is never rewritten by this operation.
      if (await refExists(cwd, `refs/remotes/origin/${input.branch}`, signal)) {
        return precondition(`'${input.branch}' already exists on origin and will not be rewritten`, [
          { path: 'branch', rule: 'not-already-pushed', message: input.branch },
        ]);
      }

      const remoteBaseSha = await revParse(cwd, `refs/remotes/origin/${baseBranch}`, signal);
      if (remoteBaseSha === null) {
        return infrastructure(`fetched origin, but 'origin/${baseBranch}' does not resolve to a commit`);
      }
      const localBaseSha = await revParse(cwd, `refs/heads/${baseBranch}`, signal);

      const stepMaterialize = await step(ctx, PREPARE_BRANCH_STEPS.materialize);
      if (stepMaterialize) return stepMaterialize;

      let action: PrepareBranchData['action'];
      let preservedCommits: readonly GitSha[] = [];

      if (await refExists(cwd, `refs/heads/${input.branch}`, signal)) {
        // Case 4 (already exists, never pushed — checked above): reuse if it
        // is already based on the latest remote base; otherwise fold it into
        // the same rebase-forward path used for a fresh local-only-commits
        // branch below. A prior attempt's own output is exactly this shape.
        const existingSha = await revParse(cwd, `refs/heads/${input.branch}`, signal);
        if (existingSha !== null && (await isAncestor(cwd, remoteBaseSha, existingSha, signal))) {
          action = 'reused-existing';
        } else {
          // The original, pre-rebase commit shas — captured before the
          // rebase rewrites `input.branch`'s history onto `remoteBaseSha`,
          // since afterward these shas are no longer reachable from it.
          const preRebaseLog = existingSha !== null ? await git(cwd, ['rev-list', `${remoteBaseSha}..${existingSha}`], signal) : null;
          const rebased = await rebaseOntoRemoteBase(cwd, input.branch, remoteBaseSha, signal);
          if (!rebased.ok) return rebased.error;
          action = 'rebased-preserved-commits';
          preservedCommits = revListShas(preRebaseLog, existingSha !== null ? [existingSha] : []);
        }
      } else if (localBaseSha === remoteBaseSha) {
        const created = await git(cwd, ['branch', input.branch, remoteBaseSha], signal);
        if (!created.ok) return infrastructure(`could not create '${input.branch}' from 'origin/${baseBranch}': ${created.error.summary}`);
        action = 'created-from-remote-base';
      } else if (localBaseSha !== null && (await isAncestor(cwd, localBaseSha, remoteBaseSha, signal))) {
        // Invariant 4 — the base advances to the latest remote before the
        // branch is created from it, whether or not it is currently checked
        // out (invariant unconditional on checkout state — S12.2).
        const currentlyOnBase = (await currentBranch(cwd, signal)) === baseBranch;
        const advanced = currentlyOnBase
          ? await git(cwd, ['merge', '--ff-only', remoteBaseSha], signal)
          : await git(cwd, ['update-ref', `refs/heads/${baseBranch}`, remoteBaseSha], signal);
        if (!advanced.ok) {
          return precondition(`could not fast-forward '${baseBranch}' to 'origin/${baseBranch}': ${advanced.error.summary}`, [
            { path: 'baseBranch', rule: 'fast-forwardable', message: baseBranch },
          ]);
        }
        const created = await git(cwd, ['branch', input.branch, remoteBaseSha], signal);
        if (!created.ok) return infrastructure(`fast-forwarded '${baseBranch}', but could not create '${input.branch}': ${created.error.summary}`);
        action = 'fast-forwarded-then-created';
      } else {
        // Case 3, the stranded-commit incident itself: `baseBranch` carries
        // local-only commits `origin/<base>` does not have.
        const preservedTip = localBaseSha;
        if (preservedTip === null) {
          return infrastructure(`'${baseBranch}' has no resolvable local commit to preserve`);
        }
        // The feature branch is created at the current base tip **first**,
        // so the commits have a durable, non-base ref before anything else
        // moves — invariant 3. Only then does the base ref move.
        const createdAtTip = await git(cwd, ['branch', input.branch, preservedTip], signal);
        if (!createdAtTip.ok) {
          return infrastructure(`could not preserve '${baseBranch}'s local-only commits onto '${input.branch}': ${createdAtTip.error.summary}`);
        }
        const preservedLog = await git(cwd, ['rev-list', `${remoteBaseSha}..${preservedTip}`], signal);
        preservedCommits = revListShas(preservedLog, [preservedTip]);

        const currentlyOnBase = (await currentBranch(cwd, signal)) === baseBranch;
        if (currentlyOnBase) {
          // The base cannot move while checked out; check out the just-created
          // feature branch first so the base ref is free.
          const switched = await git(cwd, ['checkout', input.branch], signal);
          if (!switched.ok) return infrastructure(`could not check out '${input.branch}' ahead of moving '${baseBranch}': ${switched.error.summary}`);
        }
        const movedBase = await git(cwd, ['update-ref', `refs/heads/${baseBranch}`, remoteBaseSha], signal);
        if (!movedBase.ok) {
          return infrastructure(`preserved commits onto '${input.branch}', but could not advance '${baseBranch}': ${movedBase.error.summary}`);
        }

        const rebased = await rebaseOntoRemoteBase(cwd, input.branch, remoteBaseSha, signal);
        if (!rebased.ok) return rebased.error;
        action = 'rebased-preserved-commits';
      }

      const stepCheckout = await step(ctx, PREPARE_BRANCH_STEPS.checkout);
      if (stepCheckout) return stepCheckout;
      // A successful `rebaseOntoRemoteBase` returns with `input.branch`
      // checked out, so the rebase action needs no further checkout — and no
      // subprocess spawned to confirm what the rebase already guarantees.
      if (action !== 'rebased-preserved-commits' && (await currentBranch(cwd, signal)) !== input.branch) {
        const checkedOut = await git(cwd, ['checkout', input.branch], signal);
        if (!checkedOut.ok) return infrastructure(`prepared '${input.branch}' but could not check it out: ${checkedOut.error.summary}`);
      }

      const branchHeadSha = await revParse(cwd, `refs/heads/${input.branch}`, signal);
      if (branchHeadSha === null) {
        return infrastructure(`prepared '${input.branch}' but could not read its resulting sha`);
      }

      const data: PrepareBranchData = { branch: input.branch, baseBranch, branchHeadSha, baseSha: remoteBaseSha, preservedCommits, action };
      return success(`'${input.branch}' prepared (${action})`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },

    /**
     * `20-contract.md` § L2 — composites. `TODO-NEXT.md` §7.5's algorithm.
     */
    async reconcileAfterMerge(ctx, input: ReconcileAfterMergeInput): Promise<ToolResult<ReconcileAfterMergeData>> {
      const startedAtMs = Date.now();
      if (ctx.cloneRoot === null) return infrastructure('no clone materialised for this operation');
      const cwd = ctx.cloneRoot;
      const signal = ctx.signal;

      const configResult = await gitOperations.loadRepositoryConfig(ctx);
      if (!configResult.ok) return infrastructure(configResult.error.summary);
      const baseBranch = configResult.value.baseBranch as BranchName;

      const stepConfirm = await step(ctx, RECONCILE_AFTER_MERGE_STEPS.confirmMerged);
      if (stepConfirm) return stepConfirm;
      const statusResult = await hostOperations.readPullRequest(ctx, { number: input.pullRequestNumber });
      if (!statusResult.ok || !statusResult.data) return statusResult as ToolResult<never>;
      const status = statusResult.data.status;

      if (status.state !== 'merged' || status.mergeCommitSha === null) {
        return precondition(`pull request #${input.pullRequestNumber} is not merged`, [
          { path: 'pullRequestNumber', rule: 'must-be-merged', message: String(input.pullRequestNumber) },
        ]);
      }
      if (input.expectedHeadSha !== null && status.headSha !== input.expectedHeadSha) {
        return precondition(
          `pull request #${input.pullRequestNumber}'s head ${status.headSha} does not match the expected ${input.expectedHeadSha}`,
          [
            { path: 'expectedHeadSha', rule: 'must-match-head', message: input.expectedHeadSha },
            { path: 'headSha', rule: 'must-match-head', message: status.headSha },
          ],
        );
      }

      if (!(await isWorkingTreeClean(cwd, signal))) {
        return precondition('reconciliation refuses with a dirty working tree — commit, stash or discard first', [
          { path: 'workingTree', rule: 'must-be-clean', message: 'staged, unstaged or untracked changes present' },
        ]);
      }

      const stepFetch = await step(ctx, RECONCILE_AFTER_MERGE_STEPS.fetch);
      if (stepFetch) return stepFetch;
      const fetched = await gitOperations.fetch(ctx, {});
      if (!fetched.ok) return fetched as ToolResult<never>;

      const remoteBaseSha = await revParse(cwd, `refs/remotes/origin/${baseBranch}`, signal);
      if (remoteBaseSha === null) {
        return infrastructure(`fetched origin, but 'origin/${baseBranch}' does not resolve to a commit`);
      }
      if (!(await isAncestor(cwd, status.mergeCommitSha, remoteBaseSha, signal))) {
        return precondition(`merge commit ${status.mergeCommitSha} is not yet reachable from 'origin/${baseBranch}'`, [
          { path: 'mergeCommitSha', rule: 'must-be-reachable', message: status.mergeCommitSha },
        ]);
      }

      const stepAdvance = await step(ctx, RECONCILE_AFTER_MERGE_STEPS.advanceBase);
      if (stepAdvance) return stepAdvance;
      const onBase = (await currentBranch(cwd, signal)) === baseBranch;
      if (!onBase) {
        const switched = await git(cwd, ['checkout', baseBranch], signal);
        if (!switched.ok) return infrastructure(`could not check out '${baseBranch}': ${switched.error.summary}`);
      }
      const advanced = await git(cwd, ['merge', '--ff-only', remoteBaseSha], signal);
      if (!advanced.ok) {
        return precondition(`could not fast-forward '${baseBranch}' to ${remoteBaseSha}: ${advanced.error.summary}`, [
          { path: 'baseBranch', rule: 'fast-forwardable', message: baseBranch },
        ]);
      }
      const baseSha = await revParse(cwd, `refs/heads/${baseBranch}`, signal);
      if (baseSha === null) return infrastructure(`fast-forwarded '${baseBranch}' but could not read its resulting sha`);

      const stepDelete = await step(ctx, RECONCILE_AFTER_MERGE_STEPS.deleteBranch);
      if (stepDelete) return stepDelete;
      let deletedBranch: BranchName | null = null;
      if (status.ref.branch !== baseBranch && (await refExists(cwd, `refs/heads/${status.ref.branch}`, signal))) {
        // `-D`, not `-d`: the host, not `merge-base`, is the source of truth
        // that this branch merged — a squash merge rewrites ancestry, so a
        // safety-checked delete would refuse a branch GitHub has already
        // confirmed is fully represented in the merge.
        const deleted = await git(cwd, ['branch', '-D', status.ref.branch], signal);
        if (deleted.ok) deletedBranch = status.ref.branch;
      }

      const data: ReconcileAfterMergeData = { baseBranch, baseSha, mergeCommitSha: status.mergeCommitSha, deletedBranch };
      return success(`reconciled '${baseBranch}' onto merge commit ${status.mergeCommitSha}`, data, diagnosticsFor(ctx, startedAtMs, clock));
    },
  };
}
