import { test } from 'node:test';
import { read } from '../journal/testing/read.ts';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
import type { Notifier } from '../notifier/notifier.ts';
import type { RecoveryClassification } from '../recovery/types.ts';
import type { DeclarationId } from '../shared/brands.ts';
import { createRecoveryPasses, declarationsWithUnsettledEntries, recoverDeclaration, type RecoveryDependencies } from './recovery.ts';

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

/** Unwraps a recovery pass in a test whose subject is what it decided, not whether it could finish. */
function passVerdicts(result: Outcome<readonly RecoveryClassification[], { readonly summary: string }>): readonly RecoveryClassification[] {
  assert.equal(result.ok, true, result.ok ? '' : `the pass failed: ${result.error.summary}`);
  if (!result.ok) throw new Error('unreachable: the assertion above already failed');
  return result.value;
}

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
    /**
     * Overrides `Journal.classify` outright. `createJournal`'s real
     * implementation never returns a non-null `terminal` today — nothing
     * populates one yet — so this is the seam a test uses to exercise
     * recovery's own handling of a `completed` verdict that does carry one.
     */
    readonly classify?: RecoveryDependencies['journal']['classify'];
    readonly notifier?: Pick<Notifier, 'deliverPending'>;
  } = {},
): Promise<Harness> {
  const journal = createJournal({ volumeRoot: volume, clock: systemClock });
  const catalogue = createRecoveryCatalogue();
  for (const descriptor of options.descriptors ?? []) catalogue.register(descriptor);

  const marked: string[] = [];

  const deps: RecoveryDependencies = {
    journal: options.classify ? { ...journal, classify: options.classify } : journal,
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
    ...(options.notifier ? { notifier: options.notifier } : {}),
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

test('S11.7 — recovery settling a terminal state the caller never saw fires the notification, and delivery is fired without being awaited', async () => {
  await migratedVolume(async (volume) => {
    const terminal: RecoveryClassification = {
      verdict: 'completed',
      terminal: { kind: 'wait-timeout', waitedSeconds: 1800, tool: 'host_await_checks' as never },
    };
    let deliverCalls = 0;
    const { deps, journal } = await harness(volume, {
      // The real `Journal.classify` never produces a non-null `terminal`
      // today (nothing populates one) — this stubs just enough of it to
      // exercise recovery's own responsibility: building the notification
      // request from whatever verdict it is handed, and firing delivery
      // once `settle` has committed it.
      classify: () => terminal,
      notifier: {
        deliverPending: async () => {
          deliverCalls += 1;
          return { delivered: 0, failed: 0, stillPending: 1, errors: [] };
        },
      },
    });

    await journal.begin(beginInputFor('op-1'));
    const verdicts = passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));

    assert.deepEqual(verdicts, [terminal]);
    assert.equal(deliverCalls, 1, 'delivery was fired once the terminal-bearing settle committed');

    const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
    const rows = db.prepare('SELECT severity, status, payload FROM notification_outbox').all() as { severity: string; status: string; payload: string }[];
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.severity, 'attention');
    const payload = JSON.parse(rows[0]!.payload) as { subject: { kind: string } };
    assert.equal(payload.subject.kind, 'wait-timeout');
  });
});

test('S8.2 — an entry written but never acted on classifies nothing-happened and settles', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal, marked } = await harness(volume);
    // Exactly the state a kill between the intent write and the first side
    // effect leaves behind: the entry exists, no step was ever appended, and
    // the tree still matches the pre-state captured under the lock.
    await journal.begin(beginInputFor('op-1'));

    const verdicts = passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));

    assert.deepEqual(verdicts, [{ verdict: 'nothing-happened' }]);
    assert.deepEqual(read(await journal.unsettled('repo-a' as never, 1 as never)), [], 'the entry must be settled, not left unsettled');
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

    const verdicts = passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));

    assert.deepEqual(verdicts, [{ verdict: 'completed', terminal: null }]);
    assert.deepEqual(read(await journal.unsettled('repo-a' as never, 1 as never)), []);
    assert.deepEqual(marked, []);
  });
});

test('S8.5 — an entry whose tool has no descriptor in the catalogue parks as attention, and marks the clone with it', async () => {
  await migratedVolume(async (volume) => {
    // No descriptor registered at all, and a tree that has moved: the ladder
    // cannot know what the operation was supposed to achieve.
    const { deps, journal, marked } = await harness(volume, { observed: () => ok(observedDiverged()) });
    await journal.begin(beginInputFor('op-3', 'some_withdrawn_tool'));

    const verdicts = passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));

    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]!.verdict, 'park');

    const parked = read(await journal.parked());
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

    const verdicts = passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));

    assert.equal(verdicts[0]!.verdict, 'park');
    assert.equal((read(await journal.parked())).length, 1);
    assert.equal(marked.length, 1);
  });
});

test('an already-parked entry stays parked — a later pass observing a matching tree must not quietly settle it', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal } = await harness(volume);
    await journal.begin(beginInputFor('op-5'));
    await journal.park('op-5' as never, 'a human was asked to look at this');

    const verdicts = passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));

    assert.deepEqual(verdicts, [{ verdict: 'park', reason: 'a human was asked to look at this' }]);
    assert.equal((read(await journal.parked())).length, 1, 'the entry must still be parked');
  });
});

function outboxSubjects(volume: string): { severity: string; declarationId: string | null; kind: string }[] {
  const db = new DatabaseSync(path.join(volume, 'store.sqlite'));
  try {
    const rows = db.prepare('SELECT severity, declaration_id, payload FROM notification_outbox ORDER BY created_at ASC').all() as { severity: string; declaration_id: string | null; payload: string }[];
    return rows.map((row) => ({ severity: row.severity, declarationId: row.declaration_id, kind: (JSON.parse(row.payload) as { subject: { kind: string } }).subject.kind }));
  } finally {
    db.close();
  }
}

test('S41.4 — a park recovery decides leaves exactly one operation-parked row, and a second pass adds none', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal } = await harness(volume, { observed: () => ok(observedDiverged()) });
    await journal.begin(beginInputFor('op-6', 'some_withdrawn_tool'));

    await recoverDeclaration(deps, 'repo-a' as never);
    assert.deepEqual(outboxSubjects(volume), [{ severity: 'attention', declarationId: 'repo-a', kind: 'operation-parked' }]);

    await recoverDeclaration(deps, 'repo-a' as never);
    assert.equal(outboxSubjects(volume).length, 1, 'an entry already announced is not announced again');
  });
});

test('S41.4 — a park whose journal write fails leaves no operation-parked row', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal } = await harness(volume, { observed: () => ok(observedDiverged()) });
    await journal.begin(beginInputFor('op-7', 'some_withdrawn_tool'));
    const failing: RecoveryDependencies = {
      ...deps,
      journal: { ...deps.journal, park: async () => err({ resultKind: 'infrastructure', retryable: false, summary: 'disk gone', code: 'intent-write-failed' } as never) },
    };

    await recoverDeclaration(failing, 'repo-a' as never);

    assert.deepEqual(outboxSubjects(volume), []);
  });
});

test('S8.7 — a resume runs through dispatch and takes the mutation lock in its own right, with recovery finished first', async () => {
  await migratedVolume(async (volume) => {
    const order: string[] = [];
    // The resume achieves what it set out to: the descriptor reports the
    // post-state only once the dispatch has run, which is what S42.4's
    // re-classification requires before it will settle.
    let resumed = false;
    const { deps, journal } = await harness(volume, {
      observed: () => ok(observedDiverged()),
      descriptors: [
        {
          tool: 'git_stage' as never,
          expectedPostState: () => resumed,
          resume: () => ({ tool: 'git_stage' as never, input: { paths: ['README.md'] } }),
        },
      ],
      dispatch: async (request) => {
        // Stands in for the pipeline: what matters is that the resume is a
        // dispatch of its own, not something run under a lock the ladder is
        // already holding.
        order.push(`resume-dispatch:${request.context}`);
        resumed = true;
        return { ok: true, kind: 'success', summary: 'resumed', data: null, findings: [], diagnostics: null } as never;
      },
    });
    await journal.begin(beginInputFor('op-6'));

    order.push('recovery-start');
    const verdicts = passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));
    order.push('recovery-end');

    assert.equal(verdicts[0]!.verdict, 'resume');
    assert.deepEqual(order, ['recovery-start', 'resume-dispatch:recovery', 'recovery-end']);
    assert.deepEqual(read(await journal.unsettled('repo-a' as never, 1 as never)), [], 'a successful resume settles the entry');
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

    const verdicts = passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));

    assert.equal(verdicts[0]!.verdict, 'resume');
    assert.equal((read(await journal.parked())).length, 1);
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

    assert.equal((read(await journal.parked())).length, 1);
  });
});

test('S42.1 — a park whose journal write fails leaves the clone unmarked and returns infrastructure', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal, marked } = await harness(volume, { observed: () => ok(observedDiverged()) });
    await journal.begin(beginInputFor('op-p1', 'some_withdrawn_tool'));
    const failing: RecoveryDependencies = {
      ...deps,
      journal: { ...deps.journal, park: async () => err({ resultKind: 'infrastructure', retryable: false, summary: 'disk gone', code: 'intent-write-failed' } as never) },
    };

    const result = await recoverDeclaration(failing, 'repo-a' as never);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.resultKind, 'infrastructure');
    assert.deepEqual(marked, [], 'no attention mark without a parked entry behind it');
    assert.equal(read(await journal.unsettled('repo-a' as never, 1 as never)).length, 1, 'the entry is still unsettled, so the clone derives as recovery-pending');
    assert.equal(read(await journal.parked()).length, 0);
  });
});

test('S42.2 — an unreadable journal leaves the clone recovery-pending and returns infrastructure', async () => {
  await migratedVolume(async (volume) => {
    const { deps, marked } = await harness(volume);
    const unreadable: RecoveryDependencies = {
      ...deps,
      journal: { ...deps.journal, unsettled: async () => err({ resultKind: 'infrastructure', retryable: false, summary: 'store locked', code: 'read-failed' } as never) },
    };

    const result = await recoverDeclaration(unreadable, 'repo-a' as never);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.resultKind, 'infrastructure');
    assert.match(result.error.summary, /store locked/);
    assert.deepEqual(marked, [], 'an unknown journal is not a parked one');
  });
});

test('S42.3 — every clone recovery marks needs-attention has a parked entry that resolving accepts, and resolving releases the clone', async () => {
  // One case per way the ladder parks. The clone is a state machine of its
  // own here so the assertion is on the clone leaving `needs-attention`, not
  // on a mark having been recorded.
  const cases: { readonly name: string; readonly tool: string; readonly observed: () => Outcome<ObservedGitState, CloneStoreError> }[] = [
    { name: 'no descriptor', tool: 'some_withdrawn_tool', observed: () => ok(observedDiverged()) },
    { name: 'unobservable tree', tool: 'git_stage', observed: () => err(cloneStoreError({ code: 'corrupt-tree' }, 'git cannot read the tree')) },
  ];
  for (const scenario of cases) {
    await migratedVolume(async (volume) => {
      const { deps, journal } = await harness(volume, { observed: scenario.observed });
      let cloneState: 'ready' | 'needs-attention' = 'ready';
      const withClone: RecoveryDependencies = {
        ...deps,
        cloneStore: {
          ...deps.cloneStore,
          markAttention: async () => {
            cloneState = 'needs-attention';
            return ok(undefined);
          },
        },
      };
      await journal.begin(beginInputFor('op-r1', scenario.tool));

      passVerdicts(await recoverDeclaration(withClone, 'repo-a' as never));
      assert.equal(cloneState, 'needs-attention', `${scenario.name}: the pass marks the clone`);

      // What `resolveParkedOperation` does: locate the entry among the parked
      // ones, settle it, then release the clone once none remain.
      const parked = read(await journal.parked()).filter((entry) => entry.declarationId === ('repo-a' as never));
      assert.equal(parked.length, 1, `${scenario.name}: a marked clone has a parked entry behind it`);
      const settled = await journal.settle(parked[0]!.operationId, null);
      assert.equal(settled.ok, true, `${scenario.name}: resolving accepts the entry`);
      if (read(await journal.parked()).every((entry) => entry.declarationId !== ('repo-a' as never))) cloneState = 'ready';
      assert.equal(cloneState, 'ready', `${scenario.name}: the clone leaves needs-attention`);
    });
  }
});

test('S42.4 — a resume that dispatches successfully but leaves the operation incomplete is parked, not settled', async () => {
  await migratedVolume(async (volume) => {
    const { deps, journal, marked } = await harness(volume, {
      observed: () => ok(observedDiverged()),
      descriptors: [
        {
          tool: 'git_stage' as never,
          // The post-state never holds, so re-classifying after the resume
          // still yields `resume`, not `completed`.
          expectedPostState: () => false,
          resume: () => ({ tool: 'git_stage' as never, input: { paths: ['README.md'] } }),
        },
      ],
      dispatch: async () => ({ ok: true, kind: 'success', summary: 'resumed', data: null, findings: [], diagnostics: null }) as never,
    });
    await journal.begin(beginInputFor('op-i1'));

    passVerdicts(await recoverDeclaration(deps, 'repo-a' as never));

    const parked = read(await journal.parked());
    assert.equal(parked.length, 1, 'the entry is parked');
    assert.match(parked[0]!.attentionReason ?? '', /resume step/);
    assert.equal(marked.length, 1, 'the clone follows the entry');
  });
});

test('S42.5/S42.6 — the sweep recovers each pending declaration once, one at a time, and first use wins a race', async () => {
  const runs: string[] = [];
  let concurrent = 0;
  let peak = 0;
  const gates = new Map<string, () => void>();
  const passes = createRecoveryPasses(async (declarationId: DeclarationId) => {
    runs.push(declarationId);
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    if (declarationId === ('repo-b' as never)) await new Promise<void>((resolve) => gates.set('repo-b', resolve));
    concurrent -= 1;
    return ok([] as readonly RecoveryClassification[]);
  });

  // The sweep is held on repo-b, so repo-a and repo-c have not been reached yet.
  const swept = passes.sweep(['repo-b', 'repo-a', 'repo-c'] as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, ['repo-b']);

  // First use of repo-c arrives ahead of the sweep.
  const firstUse = await passes.recover('repo-c' as never);
  assert.equal(firstUse.ok, true);
  assert.deepEqual(runs, ['repo-b', 'repo-c']);

  gates.get('repo-b')!();
  const results = await swept;

  assert.deepEqual([...runs].sort(), ['repo-a', 'repo-b', 'repo-c'], 'every declaration recovered exactly once');
  assert.equal(results.find((r) => r.declarationId === ('repo-c' as never))?.skipped, true, 'the sweep skipped the declaration first use had already taken');
  assert.equal(results.filter((r) => !r.skipped).length, 2);
  assert.equal(peak, 2, 'only the first-use pass overlapped the held sweep pass; the sweep itself never ran two at once');

  const again = await passes.recover('repo-a' as never);
  assert.equal(again.ok, true);
  assert.equal(runs.filter((id) => id === 'repo-a').length, 1, 'a later first use does not repeat a pass that already succeeded');
});

test('S42.5 — a pass that failed is retried by the next caller rather than remembered as done', async () => {
  let attempts = 0;
  const passes = createRecoveryPasses(async () => {
    attempts += 1;
    return attempts === 1
      ? err({ resultKind: 'infrastructure', retryable: false, summary: 'disk gone' } as never)
      : ok([] as readonly RecoveryClassification[]);
  });

  const swept = await passes.sweep(['repo-a'] as never);
  assert.equal(swept[0]!.outcome?.ok, false);
  const retried = await passes.recover('repo-a' as never);
  assert.equal(retried.ok, true);
  assert.equal(attempts, 2);
});

test('boot reports one entry per declaration holding unsettled work, not one per entry', () => {
  const entries = [
    { declarationId: 'repo-a' },
    { declarationId: 'repo-a' },
    { declarationId: 'repo-b' },
  ] as never;
  assert.deepEqual(declarationsWithUnsettledEntries(entries), ['repo-a', 'repo-b']);
});
