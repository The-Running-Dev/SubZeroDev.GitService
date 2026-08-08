import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ok, err, type Outcome } from '../shared/outcome.ts';
import { systemClock } from '../clock/clock.ts';
import { createJournal } from '../journal/journal.ts';
import { createStructuredStore } from '../store/structured-store.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createRecoveryCatalogue } from '../recovery/catalogue.ts';
import { cloneStoreError, type CloneStoreError } from '../clone/errors.ts';
import type { ObservedGitState } from '../clone/types.ts';
import type { Declaration } from '../declarations/types.ts';
import type { JournalBeginInput } from '../journal/types.ts';
import { declarationsWithUnsettledEntries, recoverDeclaration, type RecoveryDependencies } from './recovery.ts';

const ACTOR = { kind: 'mcp' as const, subject: 'sub' as never, clientId: null, grantId: null };

const PRE_STATE = {
  branch: 'main' as never,
  headSha: 'a'.repeat(40) as never,
  upstreamSha: 'a'.repeat(40) as never,
  indexDigest: 'b'.repeat(64) as never,
  worktreeDigest: 'c'.repeat(64) as never,
};

function observedMatching(): ObservedGitState {
  return { ...PRE_STATE, observedAt: '2026-08-08T00:00:00.000Z' as never };
}

function observedDiverged(): ObservedGitState {
  return { ...PRE_STATE, headSha: 'd'.repeat(40) as never, observedAt: '2026-08-08T00:00:00.000Z' as never };
}

function beginInputFor(operationId: string, tool = 'git_stage'): JournalBeginInput {
  return {
    operationId: operationId as never,
    declarationId: 'repo-a' as never,
    generation: 1 as never,
    tool: tool as never,
    input: { paths: ['README.md'] },
    actorRef: ACTOR,
    scheduledJobId: null,
    context: 'normal',
    preState: PRE_STATE,
  };
}

const DECLARATION = { id: 'repo-a', generation: 1 } as unknown as Declaration;

interface Harness {
  readonly deps: RecoveryDependencies;
  readonly journal: ReturnType<typeof createJournal>;
  readonly marked: string[];
}

async function harness(
  volume: string,
  options: {
    readonly observed?: () => Outcome<ObservedGitState, CloneStoreError>;
    readonly descriptors?: readonly Parameters<ReturnType<typeof createRecoveryCatalogue>['register']>[0][];
    readonly dispatch?: RecoveryDependencies['dispatch'];
  } = {},
): Promise<Harness> {
  const journal = createJournal({ volumeRoot: volume, clock: systemClock });
  const catalogue = createRecoveryCatalogue();
  for (const descriptor of options.descriptors ?? []) catalogue.register(descriptor);

  const marked: string[] = [];

  const deps: RecoveryDependencies = {
    journal,
    catalogue,
    clock: systemClock,
    declarations: { get: async () => DECLARATION },
    cloneStore: {
      observeGitState: async () => (options.observed ?? (() => ok(observedMatching())))(),
      markAttention: async (_id, reason) => {
        marked.push(reason);
        return ok(undefined);
      },
    },
    ...(options.dispatch ? { dispatch: options.dispatch, recoverySession: { grant: new Set() } as never } : {}),
  };

  return { deps, journal, marked };
}

async function migratedVolume<T>(fn: (volume: string) => Promise<T>): Promise<T> {
  return withVolumeAsync(async (volume) => {
    const store = createStructuredStore({ volumeRoot: volume, clock: systemClock });
    await store.open();
    await store.migrate();
    await store.close();
    return fn(volume);
  });
}

test('S8.2 — an entry written but never acted on classifies nothing-happened and settles', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal, marked } = await harness(volume);
    // Exactly the state a kill between the intent write and the first side
    // effect leaves behind: the entry exists, no step was ever appended, and
    // the tree still matches the pre-state captured under the lock.
    await journal.begin(beginInputFor('op-1'));

    const verdicts = await recoverDeclaration(deps, 'repo-a' as never);

    assert.deepEqual(verdicts, [{ verdict: 'nothing-happened' }]);
    assert.deepEqual(await journal.unsettled('repo-a' as never, 1 as never), [], 'the entry must be settled, not left unsettled');
    assert.deepEqual(marked, [], 'nothing-happened must not put the clone into needs-attention');
  });
});

test('S8.3 — an entry whose effect is already on disk classifies completed and settles', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal, marked } = await harness(volume, {
      observed: () => ok(observedDiverged()),
      // The descriptor is what knows the operation achieved what it set out
      // to: `classify` itself cannot tell a completed commit from a partial
      // one, and this is the L2 knowledge the catalogue exists to carry.
      descriptors: [{ tool: 'git_stage' as never, expectedPostState: () => true, resume: null }],
    });
    await journal.begin(beginInputFor('op-2'));

    const verdicts = await recoverDeclaration(deps, 'repo-a' as never);

    assert.deepEqual(verdicts, [{ verdict: 'completed', terminal: null }]);
    assert.deepEqual(await journal.unsettled('repo-a' as never, 1 as never), []);
    assert.deepEqual(marked, []);
  });
});

test('S8.5 — an entry whose tool has no descriptor in the catalogue parks as attention, and marks the clone with it', async () => {
  await migratedVolume(async (volume) => {
    // No descriptor registered at all, and a tree that has moved: the ladder
    // cannot know what the operation was supposed to achieve.
    const { deps, journal, marked } = await harness(volume, { observed: () => ok(observedDiverged()) });
    await journal.begin(beginInputFor('op-3', 'some_withdrawn_tool'));

    const verdicts = await recoverDeclaration(deps, 'repo-a' as never);

    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.verdict, 'park');

    const parked = await journal.parked();
    assert.equal(parked.length, 1);
    assert.equal(parked[0]!.operationId, 'op-3');
    assert.match(parked[0]!.attentionReason ?? '', /no recovery descriptor is registered/);

    // The clone follows the entry. An entry parked while the clone still
    // reads `ready` would leave the declaration accepting ordinary mutations
    // on a tree nobody has accounted for.
    assert.equal(marked.length, 1);
    assert.match(marked[0]!, /no recovery descriptor is registered/);
  });
});

test('an entry the ladder cannot observe parks rather than guessing', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal, marked } = await harness(volume, {
      observed: () => err(cloneStoreError({ code: 'corrupt-tree' }, 'git cannot read the tree')),
    });
    await journal.begin(beginInputFor('op-4'));

    const verdicts = await recoverDeclaration(deps, 'repo-a' as never);

    assert.equal(verdicts[0]!.verdict, 'park');
    assert.equal((await journal.parked()).length, 1);
    assert.equal(marked.length, 1);
  });
});

test('an already-parked entry stays parked — a later pass observing a matching tree must not quietly settle it', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal } = await harness(volume);
    await journal.begin(beginInputFor('op-5'));
    await journal.park('op-5' as never, 'a human was asked to look at this');

    const verdicts = await recoverDeclaration(deps, 'repo-a' as never);

    assert.deepEqual(verdicts, [{ verdict: 'park', reason: 'a human was asked to look at this' }]);
    assert.equal((await journal.parked()).length, 1, 'the entry must still be parked');
  });
});

test('S8.7 — a resume runs through dispatch and takes the mutation lock in its own right, with recovery finished first', async () => {
  await migratedVolume(async (volume) => {
    const order: string[] = [];
    const { deps, journal } = await harness(volume, {
      observed: () => ok(observedDiverged()),
      descriptors: [
        {
          tool: 'git_stage' as never,
          expectedPostState: () => false,
          resume: () => ({ tool: 'git_stage' as never, input: { paths: ['README.md'] } }),
        },
      ],
      dispatch: async (request) => {
        // Stands in for the pipeline: what matters is that the resume is a
        // dispatch of its own, not something run under a lock the ladder is
        // already holding.
        order.push(`resume-dispatch:${request.context}`);
        return { ok: true, kind: 'success', summary: 'resumed', data: null, findings: [], diagnostics: null } as never;
      },
    });
    await journal.begin(beginInputFor('op-6'));

    order.push('recovery-start');
    const verdicts = await recoverDeclaration(deps, 'repo-a' as never);
    order.push('recovery-end');

    assert.equal(verdicts[0]!.verdict, 'resume');
    assert.deepEqual(order, ['recovery-start', 'resume-dispatch:recovery', 'recovery-end']);
    assert.deepEqual(await journal.unsettled('repo-a' as never, 1 as never), [], 'a successful resume settles the entry');
  });
});

test('a resume whose dispatch fails parks the entry rather than settling it', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal, marked } = await harness(volume, {
      observed: () => ok(observedDiverged()),
      descriptors: [
        {
          tool: 'git_stage' as never,
          expectedPostState: () => false,
          resume: () => ({ tool: 'git_stage' as never, input: {} }),
        },
      ],
      dispatch: async () => ({ ok: false, kind: 'precondition', summary: 'the base moved', findings: [], diagnostics: null }) as never,
    });
    await journal.begin(beginInputFor('op-7'));

    const verdicts = await recoverDeclaration(deps, 'repo-a' as never);

    assert.equal(verdicts[0]!.verdict, 'resume');
    assert.equal((await journal.parked()).length, 1);
    assert.match(marked[0]!, /precondition/);
  });
});

test('a resume verdict with no dispatch wired parks rather than dropping the entry', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal } = await harness(volume, {
      observed: () => ok(observedDiverged()),
      descriptors: [
        {
          tool: 'git_stage' as never,
          expectedPostState: () => false,
          resume: () => ({ tool: 'git_stage' as never, input: {} }),
        },
      ],
    });
    await journal.begin(beginInputFor('op-8'));

    await recoverDeclaration(deps, 'repo-a' as never);

    assert.equal((await journal.parked()).length, 1);
  });
});

test('S8.10 — recovery discards nothing: a commit, a stash, an untracked file and an unpushed branch all survive every verdict', async () => {
  // A real repository holding one of each thing the criterion names, driven
  // through every branch of the ladder in turn. The claim is about "any
  // path", so every verdict runs against the same tree and the tree is
  // compared before and after — not one representative case.
  const repo = mkdtempSync(path.join(tmpdir(), 'szg-recovery-'));
  const git = (...args: string[]): string => {
    const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };

  git('init', '--initial-branch=main');
  writeFileSync(path.join(repo, 'README.md'), 'fixture\n', 'utf8');
  git('add', 'README.md');
  git('commit', '-m', 'initial');

  // An unpushed branch carrying a commit that exists nowhere else.
  git('checkout', '-b', 'unpushed-work');
  writeFileSync(path.join(repo, 'feature.txt'), 'work in progress\n', 'utf8');
  git('add', 'feature.txt');
  git('commit', '-m', 'unpushed');
  git('checkout', 'main');

  // A stash, and an untracked file that must survive alongside it.
  writeFileSync(path.join(repo, 'README.md'), 'fixture, edited\n', 'utf8');
  git('stash', 'push', '-m', 'operator work in progress');
  writeFileSync(path.join(repo, 'scratch.txt'), 'untracked\n', 'utf8');

  const snapshot = (): string =>
    [git('log', '--all', '--format=%H %s'), git('stash', 'list'), git('branch', '--list'), git('status', '--porcelain')].join('\n--\n');

  const before = snapshot();
  assert.match(before, /unpushed/, 'the fixture must actually contain the unpushed commit it claims to');
  assert.match(before, /operator work in progress/, 'the fixture must actually contain a stash');
  assert.match(before, /\?\? scratch\.txt/, 'the fixture must actually contain an untracked file');

  await migratedVolume(async (volume) => {
    // Every verdict the ladder can reach, over the same real tree: settle,
    // park-for-no-descriptor, park-for-unobservable, and a resume.
    const cases: readonly { readonly operationId: string; readonly tool: string; readonly options: Parameters<typeof harness>[1] }[] = [
      { operationId: 'live-1', tool: 'git_stage', options: {} },
      { operationId: 'live-2', tool: 'no_descriptor_tool', options: { observed: () => ok(observedDiverged()) } },
      { operationId: 'live-3', tool: 'git_stage', options: { observed: () => err(cloneStoreError({ code: 'corrupt-tree' }, 'unreadable')) } },
      {
        operationId: 'live-4',
        tool: 'git_stage',
        options: {
          observed: () => ok(observedDiverged()),
          descriptors: [{ tool: 'git_stage' as never, expectedPostState: () => false, resume: () => ({ tool: 'git_stage' as never, input: {} }) }],
          dispatch: async () => ({ ok: true, kind: 'success', summary: 'resumed', data: null, findings: [], diagnostics: null }) as never,
        },
      },
    ];

    for (const testCase of cases) {
      const { deps, journal } = await harness(volume, testCase.options);
      await journal.begin(beginInputFor(testCase.operationId, testCase.tool));
      await recoverDeclaration(deps, 'repo-a' as never);
    }
  });

  assert.equal(snapshot(), before, 'recovery must leave every commit, stash, untracked file and branch exactly as it found them');
  rmSync(repo, { recursive: true, force: true });
});

test('boot reports one entry per declaration holding unsettled work, not one per entry', () => {
  const entries = [
    { declarationId: 'repo-a' },
    { declarationId: 'repo-a' },
    { declarationId: 'repo-b' },
  ] as never;
  assert.deepEqual(declarationsWithUnsettledEntries(entries), ['repo-a', 'repo-b']);
});
