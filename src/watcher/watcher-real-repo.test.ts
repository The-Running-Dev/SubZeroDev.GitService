/**
 * S52 — the watcher against a real repository: a scratch clone of a bare remote, the production
 * clone store, git operations, host operations and dispatch pipeline, and a constrained GitHub CLI
 * shim (`./testing/real-repo-fixture.ts`). Nothing here mocks the watcher's collaborators.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SYMLINKS_UNAVAILABLE,
  symlinkSkipReason,
  tryDirectorySymlink,
  withRealRepo,
  type FixturePlan,
  type RealRepo,
} from './testing/real-repo-fixture.ts';
import { readPendingPullRequests } from './pending-pull-requests.ts';

const processedName = (name: string) => name.replace(/^.*?-(?=[^-]+\.md$)/, '');

/** The `subject.kind` of every notification the outbox holds, oldest first. */
function pageKinds(repo: RealRepo): string[] {
  return repo.outbox().map((row) => String((row.payload.subject as { kind?: unknown } | undefined)?.kind));
}

function pagesOf(repo: RealRepo, kind: string) {
  return repo.outbox().filter((row) => (row.payload.subject as { kind?: unknown } | undefined)?.kind === kind);
}

async function auditOutcomes(repo: RealRepo, form = 'file-watcher') {
  return (await repo.auditRecords(form)) as readonly { file?: string; outcome: { kind: string; step?: string; result?: string; reason: string; pullRequest?: { number: number } } }[];
}

function planWithPath(writePath: string): (sourceFile: string, content: string) => FixturePlan {
  return (sourceFile, content) => ({
    branch: `watcher/${sourceFile.replace(/\.[^.]+$/, '')}-bad`,
    commitMessage: `watcher: ${sourceFile}`,
    pullRequest: { title: sourceFile, body: sourceFile },
    permittedPaths: [writePath],
    writes: [{ path: writePath, content }],
  });
}

// ---------------------------------------------------------------------------
// S52.1, S52.2 — the happy path, its order, and the absence of an outer lock
// ---------------------------------------------------------------------------

test('S52.1/S52.2: a dropped file becomes a pull request through the real clone, in order, with no outer lock', async () => {
  await withRealRepo({}, async (repo) => {
    await repo.materialise();
    repo.drop('note.md', 'hello from the inbox');

    const [report] = await repo.watcher.tick();
    assert.ok(report);
    assert.equal(report.skipped, null);
    assert.equal(report.claimed, 'note.md');
    assert.equal(report.outcome?.kind, 'succeeded');

    // S52.2 — the order, and that each dispatch is its own critical section: the
    // global mutation lock is free before and after every call the watcher makes.
    assert.deepEqual(
      repo.dispatchLog.map((entry) => entry.tool),
      ['watch_plan', 'prepare_branch', 'watch_apply', 'repo_status', 'git_stage', 'repo_status', 'git_commit', 'git_push', 'pr_open'],
    );
    for (const entry of repo.dispatchLog) {
      assert.equal(entry.ok, true, `${entry.tool} succeeded`);
      assert.equal(entry.heldBefore, null, `no lock held before ${entry.tool}`);
      assert.equal(entry.heldAfter, null, `no lock held after ${entry.tool}`);
    }
    // The mutating handlers each ran under their own, distinct operation's lock.
    const mutators = repo.handlerLog.filter((entry) => entry.holderOperationId !== null);
    assert.ok(mutators.length >= 4, 'git.stage, git.commit, git.push and the prepare composite ran under a lock');
    for (const entry of mutators) assert.equal(entry.holderOperationId, entry.operationId, `${entry.target} holds only its own lock`);
    assert.equal(new Set(mutators.map((entry) => entry.operationId)).size, mutators.length, 'no two mutating steps share a lock holder');

    // S52.1 — the effects are in real Git and in the host fixture.
    const pull = [...repo.gh.pullRequests.values()][0]!;
    assert.equal(repo.gitInRemote(['show', `${pull.branch}:content/note.md`]), 'hello from the inbox');
    assert.equal(repo.gitInRemote(['rev-parse', `refs/heads/${pull.branch}`]), pull.headSha);
    assert.deepEqual(repo.listDir('processed').map(processedName), ['note.md']);
    assert.deepEqual(repo.listDir('processing'), []);
    const pending = readPendingPullRequests(repo.volume, repo.declaration.id);
    assert.deepEqual(pending.entries.map((entry) => [entry.number, entry.branch, entry.headSha]), [[1, pull.branch, pull.headSha]]);
    assert.deepEqual((await auditOutcomes(repo)).map((record) => record.outcome.kind), ['succeeded']);
    assert.deepEqual(repo.outbox(), [], 'a clean delivery pages nobody');
  });
});

// ---------------------------------------------------------------------------
// S52.3 — real dirty trees, duplicate terminal names, interrupted claims, malicious links,
// merged reconciliation
// ---------------------------------------------------------------------------

test('S52.3: a real dirty tree, untracked or modified, holds the inbox; cleaning it releases the file', async () => {
  await withRealRepo({}, async (repo) => {
    await repo.materialise();
    repo.drop('note.md', 'x');

    writeFileSync(path.join(repo.cloneRoot(), 'stray.txt'), 'untracked', 'utf8');
    const [untracked] = await repo.watcher.tick();
    assert.equal(untracked?.skipped, 'clone-not-clean');
    assert.deepEqual(repo.listDir('.'), ['note.md'], 'the file stays in the inbox, unclaimed');
    rmSync(path.join(repo.cloneRoot(), 'stray.txt'));

    writeFileSync(path.join(repo.cloneRoot(), 'README.md'), 'edited by hand\n', 'utf8');
    const [modified] = await repo.watcher.tick();
    assert.equal(modified?.skipped, 'clone-not-clean');
    assert.deepEqual(repo.dispatchLog, [], 'nothing was dispatched against a dirty tree');
    assert.deepEqual(repo.gh.argvLog, [], 'and no host call was made');
    // The service's Git runs without the host's autocrlf, so restore the blob byte for byte.
    repo.gitInClone(['-c', 'core.autocrlf=false', 'checkout', '--', 'README.md']);

    const [released] = await repo.watcher.tick();
    assert.equal(released?.outcome?.kind, 'succeeded');
  });
});

test('S52.3: two files with the same name never overwrite each other in processed/ or failed/', async () => {
  await withRealRepo({}, async (repo) => {
    repo.clock.freeze('2026-10-08T09:00:00.000Z');
    for (let round = 0; round < 2; round += 1) {
      repo.drop('same.md', `round ${round}`);
      const [report] = await repo.watcher.tick();
      assert.equal(report?.outcome?.kind, 'succeeded');
    }
    assert.deepEqual(repo.listDir('processed'), ['2026-10-08T09-00-00-000Z-2-same.md', '2026-10-08T09-00-00-000Z-same.md']);
    assert.equal(readFileSync(path.join(repo.inboxRoot, 'processed', '2026-10-08T09-00-00-000Z-same.md'), 'utf8'), 'round 0');
    assert.equal(readFileSync(path.join(repo.inboxRoot, 'processed', '2026-10-08T09-00-00-000Z-2-same.md'), 'utf8'), 'round 1');

    for (let round = 0; round < 2; round += 1) {
      writeFileSync(path.join(repo.inboxRoot, 'bad.md'), Buffer.from([0xff, 0xfe, round]));
      const [report] = await repo.watcher.tick();
      assert.equal(report?.outcome?.kind, 'rejected');
    }
    assert.deepEqual(repo.listDir('failed').filter((name) => name.endsWith('bad.md')), ['2026-10-08T09-00-00-000Z-2-bad.md', '2026-10-08T09-00-00-000Z-bad.md']);
    assert.equal(repo.listDir('failed').filter((name) => name.endsWith('.error.txt')).length, 2, 'each failure keeps its own reason');
  });
});

test('S52.3: a file left in processing/ by an interrupted run is moved to failed/, never reprocessed', async () => {
  await withRealRepo({}, async (repo) => {
    await repo.materialise();
    mkdirSync(path.join(repo.inboxRoot, 'processing'), { recursive: true });
    writeFileSync(path.join(repo.inboxRoot, 'processing', 'half.md'), 'was mid-delivery', 'utf8');

    const reports = await repo.watcher.recoverInterruptedClaims();
    assert.deepEqual(reports.map((report) => [report.claimed, report.outcome?.kind]), [['half.md', 'interrupted-claim']]);
    assert.deepEqual(repo.listDir('processing'), []);
    assert.ok(repo.listDir('failed').some((name) => name.endsWith('half.md')));
    assert.deepEqual(repo.dispatchLog, [], 'recovery dispatches nothing');
    assert.deepEqual(repo.gh.argvLog, [], 'and opens no pull request');
    assert.deepEqual((await auditOutcomes(repo)).map((record) => record.outcome.kind), ['interrupted-claim']);
    assert.deepEqual(pageKinds(repo), ['file-watcher-failed']);
  });
});

test('S52.3: a symbolic link dropped in the inbox is never claimed or followed', { skip: SYMLINKS_UNAVAILABLE }, async () => {
  await withRealRepo({}, async (repo) => {
    await repo.materialise();
    const secret = path.join(repo.volume, 'outside-secret.md');
    writeFileSync(secret, 'must never be read into a pull request', 'utf8');
    mkdirSync(repo.inboxRoot, { recursive: true });
    symlinkSync(secret, path.join(repo.inboxRoot, 'link.md'), 'file');

    const [report] = await repo.watcher.tick();
    assert.equal(report?.claimed, null);
    assert.deepEqual(repo.dispatchLog, []);
    assert.deepEqual(repo.listDir('processing'), []);
    assert.equal(readFileSync(secret, 'utf8'), 'must never be read into a pull request');
    assert.equal(repo.gh.pullRequests.size, 0);
  });
});

test('S52.3: a plan that points outside the declaration allowlist is refused, writes nothing, and is audited', async () => {
  for (const target of ['.git/hooks/pre-commit', '../escape.md', 'README.md']) {
    await withRealRepo({}, async (repo) => {
      await repo.materialise();
      repo.setPlanner(planWithPath(target));
      repo.drop('evil.md', 'payload');

      const [report] = await repo.watcher.tick();
      assert.equal(report?.outcome?.kind, 'rejected', target);
      assert.match(String((report?.outcome as { step?: string }).step), /^(plan|apply)$/, target);
      assert.deepEqual(repo.listDir('processing'), [], target);
      assert.ok(repo.listDir('failed').some((name) => name.endsWith('evil.md')), target);
      assert.equal(existsSync(path.join(repo.cloneRoot(), '.git', 'hooks', 'pre-commit')), false, target);
      assert.equal(existsSync(path.join(path.dirname(repo.cloneRoot()), 'escape.md')), false, target);
      assert.equal(repo.gitInClone(['status', '--porcelain=v1']), '', `${target}: the clone is untouched`);
      assert.equal(repo.gh.pullRequests.size, 0, target);
      assert.deepEqual(pageKinds(repo), ['file-watcher-failed'], target);
    });
  }
});

test('S52.3: a merged pull request reconciles the real clone onto the merge commit and drops the record', async () => {
  await withRealRepo({ autoMerge: true }, async (repo) => {
    await repo.materialise();
    repo.drop('note.md', 'ship it');
    const [opened] = await repo.watcher.tick();
    assert.equal(opened?.outcome?.kind, 'succeeded');
    const pull = repo.gh.pullRequests.get(1)!;
    assert.ok(repo.gh.argvLog.some((argv) => argv.join(' ').includes(`pr merge 1 --auto --squash --match-head-commit ${pull.headSha}`)), 'auto-merge is pinned to the pushed commit');

    repo.gh.merge(1);
    const [report] = await repo.watcher.tick();
    assert.deepEqual(report?.reconciled.map((entry) => entry.number), [1]);
    assert.deepEqual(report?.stillPending, []);
    assert.deepEqual(readPendingPullRequests(repo.volume, repo.declaration.id).entries, []);
    assert.equal(repo.gitInClone(['rev-parse', 'HEAD']), pull.headSha, 'the clone sits on the merge commit');
    assert.equal(repo.gitInClone(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(repo.gitInClone(['branch', '--list', pull.branch]), '', 'the local branch is gone');
    assert.equal(repo.gitInClone(['status', '--porcelain=v1']), '');
    assert.deepEqual((await auditOutcomes(repo)).map((record) => record.outcome.kind), ['succeeded', 'succeeded'], 'the delivery and the reconciliation each audit a terminal outcome');
    assert.deepEqual(repo.outbox(), []);
  });
});

test('S52.3: a merged pull request whose reconciliation fails on a dirty clone is told once and the record still leaves', async () => {
  await withRealRepo({ autoMerge: true }, async (repo) => {
    await repo.materialise();
    repo.drop('note.md', 'ship it');
    await repo.watcher.tick();
    repo.gh.merge(1);
    writeFileSync(path.join(repo.cloneRoot(), 'stray.txt'), 'blocks the fast-forward', 'utf8');

    const [report] = await repo.watcher.tick();
    assert.deepEqual(report?.reconciled.map((entry) => entry.number), [1]);
    assert.deepEqual(readPendingPullRequests(repo.volume, repo.declaration.id).entries, [], 'no retry loop');
    const failures = (await auditOutcomes(repo)).filter((record) => record.outcome.kind === 'rejected');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.outcome.step, 'reconcile_after_merge');
    const pages = pagesOf(repo, 'file-watcher-failed');
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.severity, 'attention');
    assert.match(String(pages[0]!.payload.summary), /note\.md/);
    assert.equal(existsSync(path.join(repo.cloneRoot(), 'stray.txt')), true, 'the stray file is still there: nothing was discarded');
  });
});

// ---------------------------------------------------------------------------
// S52.4 — a platform prerequisite that cannot be met is detected and skipped with a reason
// ---------------------------------------------------------------------------

test('S52.4: a symlink the host refuses is reported with its reason, so a test can skip on it', () => {
  const refused = tryDirectorySymlink(path.join('nowhere', 'target'), path.join('nowhere', 'missing-parent', 'link'));
  assert.match(refused ?? '', /^symlink creation refused \(\w+\)$/);

  const hostReason = symlinkSkipReason();
  if (hostReason === null) assert.equal(SYMLINKS_UNAVAILABLE, false, 'this host can create symlinks, so no symlink test is skipped');
  else assert.equal(SYMLINKS_UNAVAILABLE, hostReason, `symlink tests skip with: ${hostReason}`);
});

// ---------------------------------------------------------------------------
// S52.5 — every corrected outcome from S49 to S51, with audit and outbox evidence
// ---------------------------------------------------------------------------

test('S52.5/S49: a pull request whose head was moved after the push is never treated as the watcher\'s commit', async () => {
  await withRealRepo({ autoMerge: true }, async (repo) => {
    await repo.materialise();
    repo.drop('note.md', 'ship it');
    await repo.watcher.tick();
    const pushed = repo.gh.pullRequests.get(1)!.headSha;
    const moved = repo.gh.moveHead(1);
    assert.notEqual(moved, pushed);
    repo.gh.merge(1);

    const [report] = await repo.watcher.tick();
    assert.deepEqual(report?.reconciled.map((entry) => entry.number), [1]);
    assert.notEqual(repo.gitInClone(['rev-parse', 'HEAD']), moved, 'the clone did not fast-forward onto the foreign commit');
    const failures = (await auditOutcomes(repo)).filter((record) => record.outcome.kind === 'rejected');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.outcome.step, 'reconcile_after_merge');
    assert.match(failures[0]!.outcome.reason, /head/i);
    const pages = pagesOf(repo, 'file-watcher-failed');
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.severity, 'attention');
    assert.deepEqual(readPendingPullRequests(repo.volume, repo.declaration.id).entries, []);
  });
});

test('S52.5/S50.3: a refused auto-merge leaves the file in processed/ and tells the operator about the open pull request', async () => {
  await withRealRepo({ autoMerge: true }, async (repo) => {
    repo.gh.failWhen(/^pr merge/, 'Head branch was modified. Review and try the merge again.');
    repo.drop('note.md', 'ship it');

    const [report] = await repo.watcher.tick();
    assert.equal(report?.outcome?.kind, 'succeeded');
    assert.deepEqual(repo.listDir('processed').map(processedName), ['note.md']);
    assert.deepEqual(repo.listDir('failed'), []);
    const records = await auditOutcomes(repo);
    assert.deepEqual(records.map((record) => record.outcome.kind), ['succeeded', 'rejected']);
    assert.equal(records[1]!.outcome.step, 'pr_enable_auto_merge');
    assert.match(records[1]!.outcome.reason, /pull request #1/);
    const pages = pagesOf(repo, 'file-watcher-failed');
    assert.equal(pages.length, 1);
    assert.equal(pages[0]!.severity, 'attention');
    assert.equal(repo.gh.pullRequests.get(1)!.state, 'OPEN');
    assert.equal(readPendingPullRequests(repo.volume, repo.declaration.id).entries.length, 1, 'the open pull request is still followed');
  });
});

test('S52.5/S50.2: an exception escaping a tick is audited every time and paged once', async () => {
  await withRealRepo({}, async (repo) => {
    // The inbox root itself is a plain file: every read beneath it throws ENOTDIR, outside any one file's work.
    mkdirSync(path.dirname(repo.inboxRoot), { recursive: true });
    writeFileSync(repo.inboxRoot, 'not a directory', 'utf8');

    const [first] = await repo.watcher.tick();
    assert.equal(first?.skipped, 'tick-failed');
    const [second] = await repo.watcher.tick();
    assert.equal(second?.skipped, 'tick-failed');

    const failures = await repo.auditRecords('watcher-tick-failed');
    assert.equal(failures.length, 2, 'every failure is audited');
    const pages = pagesOf(repo, 'watcher-tick-failed');
    assert.equal(pages.length, 1, 'the latch pages once');
    assert.equal(pages[0]!.severity, 'attention');

    rmSync(repo.inboxRoot);
    const [recovered] = await repo.watcher.tick();
    assert.equal(recovered?.skipped, null);
  });
});

test('S52.5/S51.1: the first tick against a never-cloned declaration clones it and opens the pull request', async () => {
  await withRealRepo({}, async (repo) => {
    repo.drop('note.md', 'first use');
    const [report] = await repo.watcher.tick();
    assert.equal(report?.skipped, null);
    assert.equal(report?.outcome?.kind, 'succeeded');
    assert.equal(repo.gh.pullRequests.size, 1);
    assert.deepEqual(repo.dispatchLog.map((entry) => entry.tool).slice(0, 2), ['watch_plan', 'prepare_branch']);
  });
});

test('S52.5/S51.2: a dirty clone is clone-not-clean, and only a parked clone is clone-needs-attention', async () => {
  await withRealRepo({}, async (repo) => {
    await repo.materialise();
    repo.drop('note.md', 'x');
    writeFileSync(path.join(repo.cloneRoot(), 'stray.txt'), 'dirty', 'utf8');
    assert.equal((await repo.watcher.tick())[0]?.skipped, 'clone-not-clean');
    rmSync(path.join(repo.cloneRoot(), 'stray.txt'));

    await repo.cloneStore.markAttention(repo.declaration.id, 'parked by a test');
    assert.equal((await repo.watcher.tick())[0]?.skipped, 'clone-needs-attention');
    assert.deepEqual(repo.dispatchLog, []);
    assert.deepEqual(repo.listDir('.'), ['note.md']);
  });
});

test('S52.5/S51.3: a clone that cannot be made is told with its failure, and the file stays in the inbox', async () => {
  await withRealRepo({}, async (repo) => {
    rmSync(repo.remote, { recursive: true, force: true });
    repo.drop('note.md', 'x');

    const [report] = await repo.watcher.tick();
    assert.notEqual(report?.skipped, 'clone-needs-attention');
    assert.equal(report?.outcome?.kind, 'rejected');
    assert.equal((report?.outcome as { step?: string }).step, 'clone');
    assert.deepEqual(repo.listDir('.'), ['note.md']);
    assert.deepEqual(repo.listDir('processing'), []);
    const records = await auditOutcomes(repo);
    assert.deepEqual(records.map((record) => [record.file, record.outcome.step]), [['note.md', 'clone']]);
    assert.deepEqual(pageKinds(repo), ['file-watcher-failed']);
  });
});

// ---------------------------------------------------------------------------
// S52.6 — D18's refusal at each state directory, for a plain file and for a symlink
// ---------------------------------------------------------------------------

type Site = 'processing' | 'processed' | 'failed';
type Plant = 'file' | 'symlink';

/** Replaces `<inbox>/<site>` with a plain file or a symlink to a real directory elsewhere. Returns a skip reason, or null. */
function plant(repo: RealRepo, site: Site, kind: Plant): string | null {
  const at = path.join(repo.inboxRoot, site);
  mkdirSync(repo.inboxRoot, { recursive: true });
  rmSync(at, { recursive: true, force: true });
  if (kind === 'file') {
    writeFileSync(at, 'not a directory', 'utf8');
    return null;
  }
  const elsewhere = path.join(repo.volume, `elsewhere-${site}`);
  mkdirSync(elsewhere, { recursive: true });
  return tryDirectorySymlink(elsewhere, at);
}

for (const kind of ['file', 'symlink'] as const) {
  const skip = kind === 'symlink' ? SYMLINKS_UNAVAILABLE : false;

  test(`S52.6: ${kind} at processing/ refuses the claim, pages once, and the start still succeeds`, { skip }, async (t) => {
    await withRealRepo({}, async (repo) => {
      await repo.materialise();
      const reason = plant(repo, 'processing', kind);
      if (reason !== null) return t.skip(reason);
      repo.drop('note.md', 'x');

      const [first] = await repo.watcher.tick();
      assert.equal(first?.skipped, 'state-directory-tampered');
      const [second] = await repo.watcher.tick();
      assert.equal(second?.skipped, 'state-directory-tampered');
      assert.deepEqual(repo.dispatchLog, []);
      assert.equal(repo.gh.pullRequests.size, 0);
      assert.deepEqual(repo.listDir('.').filter((name) => name === 'note.md'), ['note.md'], 'the file stays in the inbox');
      assert.equal(pagesOf(repo, 'watcher-state-directory-tampered').length, 1, 'one page across both ticks');

      const started = await repo.watcher.start();
      assert.equal(started.ok, true, 'start survives a tampered processing/');
      await repo.watcher.stop();
      assert.equal(pagesOf(repo, 'watcher-state-directory-tampered').length, 1, 'recovery does not page again for the same tamper');
    });
  });

  test(`S52.6: ${kind} at processed/ refuses the move after a real pr_open, and the pull request stays pending`, { skip }, async (t) => {
    await withRealRepo({}, async (repo) => {
      await repo.materialise();
      let skipReason: string | null = null;
      repo.afterNext('pr_open', () => {
        skipReason = plant(repo, 'processed', kind);
      });
      repo.drop('note.md', 'x');

      const [report] = await repo.watcher.tick();
      if (skipReason !== null) return t.skip(skipReason);
      assert.equal(report?.outcome?.kind, 'succeeded', 'the tick returns normally');
      assert.equal(repo.gh.pullRequests.size, 1);
      assert.deepEqual(repo.listDir('processing'), ['note.md'], 'the file stays where it was claimed');
      assert.deepEqual(readPendingPullRequests(repo.volume, repo.declaration.id).entries.map((entry) => entry.number), [1], 'D19: the pull request is still followed');

      const records = await auditOutcomes(repo);
      assert.deepEqual(records.map((record) => record.outcome.kind), ['succeeded'], 'the protocol\'s own outcome is what the audit keeps');
      const pages = pagesOf(repo, 'file-watcher-failed');
      assert.equal(pages.length, 1);
      assert.equal(pages[0]!.severity, 'attention');
      assert.match(String(pages[0]!.payload.summary), /processed/);

      // The next tick refuses at the gate, and the pull request is not lost to it.
      const [next] = await repo.watcher.tick();
      assert.equal(next?.skipped, 'state-directory-tampered');
      assert.deepEqual(next?.stillPending.map((entry) => entry.number), [1]);
      assert.equal(pagesOf(repo, 'watcher-state-directory-tampered').length, 1);

      // Retention declines to walk it.
      const retention = await repo.watcher.runRetention();
      assert.equal(retention.skipped.length, 1);
      assert.match(retention.skipped[0]!, /processed/);
    });
  });

  test(`S52.6: ${kind} at failed/ refuses the move after a real failure, and recovery cannot move a stuck file either`, { skip }, async (t) => {
    await withRealRepo({}, async (repo) => {
      await repo.materialise();
      repo.setPlanner(planWithPath('.git/hooks/pre-commit'));
      let skipReason: string | null = null;
      repo.afterNext('watch_apply', () => {
        skipReason = plant(repo, 'failed', kind);
      });
      repo.drop('evil.md', 'x');

      const [report] = await repo.watcher.tick();
      if (skipReason !== null) return t.skip(skipReason);
      assert.equal(report?.outcome?.kind, 'rejected');
      assert.deepEqual(repo.listDir('processing'), ['evil.md'], 'the file stays where it was claimed');
      assert.equal(repo.gh.pullRequests.size, 0);
      const pages = pagesOf(repo, 'file-watcher-failed');
      assert.equal(pages.length, 1);
      assert.match(String(pages[0]!.payload.summary), /failed/);

      // Recovery meets the same refusal: an interrupted-claim audit, plus a page.
      const recovered = await repo.watcher.recoverInterruptedClaims();
      assert.deepEqual(recovered.map((entry) => entry.outcome?.kind), ['interrupted-claim']);
      assert.deepEqual(repo.listDir('processing'), ['evil.md'], 'still not moved');
      const interrupted = (await auditOutcomes(repo)).filter((record) => record.outcome.kind === 'interrupted-claim');
      assert.equal(interrupted.length, 1);
      assert.equal(pagesOf(repo, 'file-watcher-failed').length, 2);
    });
  });
}
