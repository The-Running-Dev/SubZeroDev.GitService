import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkCitations, extractCitations, findDanglingCitations, listSourceFiles, readDesignDocuments, resolveCitation } from './doc-citations.ts';

/**
 * S66 (`30-slices.md` § S66, issue #301): every `design/` section a source
 * comment cites by `§` exists in that document, and the build fails on the pull
 * request that introduces one that does not. The fixtures below are planted
 * dangling citations, which is why the tree-wide scan skips this one file.
 */

const CONTRACT = [
  '# Contract',
  '## Public signatures',
  '### L1 — exec',
  '### L2 — watcher',
  'The state directories are guarded — **D18**.',
  '### L5 — surfaces',
  '#### The HTTP API route table (resolves U4, S18.1/S18.14)',
  '### `Declaration` — a managed repository',
  '## Error semantics',
  '### Authorization',
  '**Canonical serialisation (resolves U9).** `hash` is a digest of the',
  'record, and "a tamper is never a',
  'skip" is the rule.',
  '## Invariants',
  '| D18 | No watcher code path reads a state directory |',
  '## Unresolved',
  '**U4 — The HTTP API route table, resolved 2026-08-19 by S18.**',
].join('\n');

const DOCUMENTS = new Map([['20-contract.md', CONTRACT]]);

function resolve(text: string) {
  return resolveCitation({ file: 'fixture.ts', line: 1, document: '20-contract.md', text }, DOCUMENTS);
}

test('S66.2 — a section the document does not have is missing, including an id the cited section never states', () => {
  for (const text of [
    'L2 — watcher, W08.3: the claim is released',
    'L6 — nothing here',
    'Watcher bootstrap',
    'control flow step 2',
    'disk pressure: "at 95 %"',
    '"a phrase the document never says"',
    'Error semantics › Scheduler',
  ]) {
    assert.equal(resolve(text).kind, 'missing', text);
  }
});

test('S66.2 — a citation of a design document that does not exist is missing', () => {
  const result = resolveCitation({ file: 'fixture.ts', line: 1, document: '25-nothing.md', text: 'L1 — exec' }, DOCUMENTS);
  assert.equal(result.kind, 'missing');
});

test('S66.3 — formatting variants of a real heading resolve rather than reading as missing', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['L1 — exec', 'heading'],
    ['L2 — watcher. Every tick', 'heading'],
    ['L1 exec', 'variant'],
    ['L1 - exec', 'variant'],
    ['L1 – exec', 'variant'],
    ['l1 — Exec', 'variant'],
    ['L5, the surfaces layer', 'variant'],
    ['Declaration: the id', 'variant'],
    ['The HTTP API route table: the four cookie routes', 'variant'],
    ['Error semantics › Authorization', 'heading'],
    ['L2 — watcher, D18: this directory', 'heading'],
  ];
  for (const [text, kind] of cases) assert.equal(resolve(text).kind, kind, text);
});

test('S66.3 — an anchor that is not a heading resolves as an anchor: a sub-section id, a bold lead, a quoted phrase', () => {
  for (const text of ['U4: the full HTTP route table', 'D18, the latch', 'Canonical serialisation: the digest', '"a tamper is never a skip"']) {
    assert.equal(resolve(text).kind, 'anchor', text);
  }
});

test('S66.3 — a criterion of a landed slice resolves, because landing retires its body; an unlanded one does not', () => {
  const slices = new Map([
    ['30-slices.md', ['# Slices', '## Outstanding', '## S30 — open', '- S30.1 it works', '## Landed', '| **S22** | Verifiable | [#36] |'].join('\n')],
  ]);
  const at = (text: string) => resolveCitation({ file: 'fixture.ts', line: 1, document: '30-slices.md', text }, slices).kind;
  assert.equal(at('S22.1'), 'anchor');
  assert.equal(at('S30.1'), 'anchor');
  assert.equal(at('S30.2'), 'missing');
  assert.equal(at('S23.1'), 'missing');
});

test('S66.3 — a citation broken across comment lines is read as one citation', () => {
  const source = [
    '/**',
    ' * The rule (`20-contract.md` §',
    ' * L1 — exec) and its twin (`20-contract.md` § L2 —',
    ' * watcher, W08.3).',
    ' */',
    '// `10-design.md` § Boot and',
    '// recovery: lazy.',
  ].join('\n');
  const citations = extractCitations('fixture.ts', source);
  assert.deepEqual(
    citations.map((c) => [c.line, c.document, c.text.slice(0, 20)]),
    [
      [2, '20-contract.md', 'L1 — exec) and its t'],
      [3, '20-contract.md', 'L2 — watcher, W08.3)'],
      [6, '10-design.md', 'Boot and recovery: l'],
    ],
  );
  assert.equal(resolveCitation(citations[0]!, DOCUMENTS).kind, 'heading');
  assert.equal(resolveCitation(citations[1]!, DOCUMENTS).kind, 'missing');
});

test('S66.2 — the report names the file and line of each dangling citation, and nothing else', () => {
  const sources = new Map([
    ['src/a.ts', '// `20-contract.md` § L1 — exec\n// `20-contract.md` § L2 — watcher, W08.3\n'],
    ['src/b.ts', 'const x = 1;\n\n/** `20-contract.md` § L6 — nothing */\n'],
  ]);
  const report = checkCitations(sources, DOCUMENTS);
  assert.equal(report.citations, 3);
  assert.deepEqual(
    report.dangling.map((d) => `${d.file}:${d.line}`),
    ['src/a.ts:2', 'src/b.ts:3'],
  );
});

test('S66.1 — every citation in the tree resolves against the committed design documents', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = listSourceFiles(root);
  assert.ok(files.includes('src/server.ts') && files.includes('scripts/doc-citations.ts'), 'the walk reaches src/ and scripts/');
  assert.ok(!files.some((f) => f.split('/').includes('node_modules')), 'the walk skips node_modules');
  const report = findDanglingCitations(root, files, readDesignDocuments(root));
  assert.ok(report.citations > 200, `expected the tree's ${report.citations} citations to be found`);
  assert.deepEqual(
    report.dangling.map((d) => `${d.file}:${d.line} ${d.document} § ${d.text.slice(0, 60)}`),
    [],
  );
});
