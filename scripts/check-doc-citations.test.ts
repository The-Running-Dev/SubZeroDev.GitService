import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDocCitations } from './check-doc-citations.ts';

const documents = {
  '10-design.md': '# Design\n\n## Boot and recovery\n',
  '20-contract.md': [
    '# Contract',
    '',
    '## Public signatures',
    '',
    '### L1 — exec',
    '',
    '### L2 — watcher',
    '',
    '**U2, resolved.** The scope vocabulary is fixed.',
    '',
    '| D5 | Retention has one owner. |',
  ].join('\n'),
} as const;

test('doc citations accept dash styles, heading paths and named non-heading anchors', () => {
  const contents = [
    '/** `20-contract.md` § L1 exec. */',
    '/** `20-contract.md` § Public signatures › L1 – exec. */',
    '/** `20-contract.md` § U2. */',
    '/** `20-contract.md` § D5/S25.5 — the slice suffix is not a contract anchor. */',
    '/** `10-design.md` § Boot and recovery. */',
  ].join('\n');

  assert.deepEqual(checkDocCitations([{ path: 'src/example.ts', contents }], documents), []);
});

test('doc citations reject a genuine dangling subsection even when its parent heading exists', () => {
  const contents = '/** `20-contract.md` § L2 — watcher, W08.3: nonexistent contract subsection. */';
  const findings = checkDocCitations([{ path: 'src/watcher.ts', contents }], documents);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.sourcePath, 'src/watcher.ts');
  assert.equal(findings[0]!.document, '20-contract.md');
  assert.match(findings[0]!.reason, /W08\.3 does not exist/);
});

test('doc citations reject a missing heading', () => {
  const contents = [
    '/** `10-design.md` § A section that was never written. */',
    '/** `20-contract.md` § This section does not exist. */',
  ].join('\n');
  const findings = checkDocCitations([{ path: 'src/example.ts', contents }], documents);

  assert.equal(findings.length, 2);
  assert.match(findings[0]!.reason, /no heading or named anchor/);
  assert.match(findings[1]!.reason, /no heading or named anchor/);
});
