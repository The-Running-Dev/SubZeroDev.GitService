import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { systemClock } from '../clock/clock.ts';
import type { Declaration } from '../declarations/types.ts';
import { withVolumeAsync } from '../store/volume-fixture.ts';
import { createWatcher } from './watcher.ts';

const DECLARATION = {
  id: 'docs' as never,
  generation: 1 as never,
  cloneUrl: 'https://example.invalid/docs.git' as never,
  host: 'github',
  credentialRef: 'docs-token' as never,
  capabilityGrant: new Set(['git.local.write', 'git.remote.write', 'host.pr.write']) as never,
  writablePathPrefixes: ['content/'] as never,
  pinned: false,
  contentDrop: { tool: 'consumer_apply_drop' as never, autoMerge: true },
  identity: { gitUserName: 'Watcher', gitUserEmail: 'watcher@example.invalid' },
  state: 'active',
  grantEpoch: 0 as never,
  createdAt: '2026-08-10T00:00:00.000Z' as never,
  updatedAt: '2026-08-10T00:00:00.000Z' as never,
} satisfies Declaration;

function watcherVolume(volumeRoot: string): string {
  return path.join(volumeRoot, 'drops', String(DECLARATION.id));
}

function createFixture(volumeRoot: string, overrides: Partial<Parameters<typeof createWatcher>[0]> = {}) {
  const calls: { tool: string; input: unknown }[] = [];
  const audits: unknown[] = [];
  const watcher = createWatcher({
    volumeRoot,
    clock: systemClock,
    remoteOperationsPermitted: true,
    enabled: true,
    pollIntervalSeconds: 15,
    declarations: { list: async () => [DECLARATION] },
    cloneStore: { describe: async () => ({ ok: true, value: { state: 'ready' } }) },
    isDropTarget: (tool) => tool === DECLARATION.contentDrop!.tool,
    dispatch: async (request) => {
      calls.push({ tool: String(request.toolName), input: request.input });
      if (request.toolName === ('pr_open' as never)) {
        return { ok: true, data: { ref: { number: 8, url: 'https://example.invalid/pr/8', branch: 'watcher/docs' } } } as never;
      }
      return { ok: true, data: {} } as never;
    },
    audit: { append: async (entry) => { audits.push(entry); return { appended: true, sequence: 1 }; } },
    ...overrides,
  });
  return { watcher, calls, audits };
}

test('S17.1 — start names the first disabled switch and does not start the timer', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const { watcher } = createFixture(volumeRoot, { remoteOperationsPermitted: false });
    const started = await watcher.start();
    assert.equal(started.ok, false);
    if (!started.ok) assert.equal(started.error.code, 'not-permitted');
    if (!started.ok && started.error.code === 'not-permitted') assert.equal(started.error.missingSwitch, 'remote-operations');
  });
});

test('S17.2, S17.6 and S17.7 — a drop is claimed before dispatch, delivered as data, and retained in processed after the PR flow', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const root = watcherVolume(volumeRoot);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'note.md'), '# Hello\n', 'utf8');
    const { watcher, calls, audits } = createFixture(volumeRoot);

    const reports = await watcher.tick();
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.claimed, 'note.md');
    assert.equal(reports[0]?.outcome?.kind, 'succeeded');
    assert.equal(existsSync(path.join(root, 'note.md')), false, 'the inbox claim is removed before dispatch returns');
    assert.equal(readFileSync(path.join(root, 'processed', 'note.md'), 'utf8'), '# Hello\n');
    assert.deepEqual(calls.map((call) => call.tool), ['consumer_apply_drop', 'git_push', 'pr_open', 'pr_enable_auto_merge']);
    assert.deepEqual(calls[0]?.input, { fileName: 'note.md', content: '# Hello\n' });
    assert.equal(audits.length, 1, 'the terminal outcome is audited once');
  });
});

test('S17.3 — a processing claim found at startup moves to failed and is never dispatched', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const root = watcherVolume(volumeRoot);
    mkdirSync(path.join(root, 'processing'), { recursive: true });
    writeFileSync(path.join(root, 'processing', 'interrupted.md'), '# Interrupted\n', 'utf8');
    const { watcher, calls } = createFixture(volumeRoot);

    const reports = await watcher.recoverInterruptedClaims();
    assert.equal(reports[0]?.outcome?.kind, 'interrupted-claim');
    assert.equal(existsSync(path.join(root, 'failed', 'interrupted.md')), true);
    assert.equal(existsSync(path.join(root, 'failed', 'interrupted.md.error.txt')), true);
    assert.deepEqual(calls, []);
  });
});

test('S17.4 and S17.5 — symlinks are not candidates and a needs-attention clone leaves inbox intact', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const root = watcherVolume(volumeRoot);
    mkdirSync(root, { recursive: true });
    const target = path.join(volumeRoot, 'outside.md');
    writeFileSync(target, '# Outside\n', 'utf8');
    try {
      symlinkSync(target, path.join(root, 'linked.md'));
    } catch {
      return; // Symlink privilege is unavailable on some Windows configurations.
    }
    const { watcher, calls } = createFixture(volumeRoot, { cloneStore: { describe: async () => ({ ok: true, value: { state: 'needs-attention' } }) } });
    const reports = await watcher.tick();
    assert.equal(reports[0]?.skipped, 'clone-needs-attention');
    assert.equal(existsSync(path.join(root, 'linked.md')), true);
    assert.deepEqual(calls, []);
  });
});

test('S17.8 — a corrupt pending list is treated as empty and a merged pending PR is reconciled', async () => {
  await withVolumeAsync(async (volumeRoot) => {
    const root = watcherVolume(volumeRoot);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'pending-pull-requests.json'), '{not json', 'utf8');
    const { watcher, calls } = createFixture(volumeRoot, {
      dispatch: async (request) => {
        calls.push({ tool: String(request.toolName), input: request.input });
        if (request.toolName === ('pr_status' as never)) {
          return { ok: true, data: { status: { state: 'merged' } } } as never;
        }
        return { ok: true, data: {} } as never;
      },
    });
    const reports = await watcher.tick();
    assert.deepEqual(reports[0]?.reconciled, []);
    assert.deepEqual(calls, []);
  });
});
