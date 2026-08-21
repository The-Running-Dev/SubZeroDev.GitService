import { compareToolParity } from '../src/contract/tool-parity.ts';
import { captureBaseImageToolParity, fixturePath, readCommittedFixture } from './generate-tool-parity-fixture.ts';

/**
 * S36.6: runs unattended alongside the build's other gates. Recaptures the
 * base image's own tool metadata per profile and compares it against the
 * committed fixture at `fixtures/tool-parity/base-image.json` — any tool a
 * profile lost, or whose required capabilities or accepted input changed
 * without `scripts/generate-tool-parity-fixture.ts` being re-run to record
 * it, fails the build. An addition alone never fails it (S36.4) — a derived
 * image, and a base image gaining a tool on purpose, are both legitimate.
 */

const current = captureBaseImageToolParity();
const baseline = readCommittedFixture();
const comparison = compareToolParity(baseline, current);

for (const snapshot of current) {
  console.log(`check-tool-parity: profile '${snapshot.profile}' — ${snapshot.tools.length} tool(s) visible`);
}

const byKind = { removed: 0, added: 0, 'capabilities-changed': 0, 'input-changed': 0 };
for (const difference of comparison.differences) {
  byKind[difference.kind] += 1;
  console.log(`check-tool-parity: ${difference.kind}: ${difference.detail}`);
}
console.log(
  `check-tool-parity: removed: ${byKind.removed}, capabilities-changed: ${byKind['capabilities-changed']}, input-changed: ${byKind['input-changed']}, added: ${byKind.added}`,
);

if (comparison.failed) {
  console.error(
    `check-tool-parity: ${comparison.differences.filter((d) => d.kind !== 'added').length} loss(es) of capability against ${fixturePath()}.\n` +
      'If this loss is intentional, run `node scripts/generate-tool-parity-fixture.ts` and commit the regenerated fixture.',
  );
  process.exit(1);
}

console.log('check-tool-parity: OK — no capability lost against the committed base-image fixture');
