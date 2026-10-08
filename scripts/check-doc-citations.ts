import path from 'node:path';
import { findDanglingCitations, listSourceFiles, readDesignDocuments } from './doc-citations.ts';

/**
 * Fails the build if a source comment cites a `design/` section by `§` that
 * the cited document does not have (S66, `30-slices.md` § S66). The
 * comparison rules — what counts as a formatting variant or an anchor rather
 * than a missing section — live in `doc-citations.ts`.
 */

const root = path.resolve(import.meta.dirname, '..');
const report = findDanglingCitations(root, listSourceFiles(root), readDesignDocuments(root));

if (report.dangling.length > 0) {
  for (const d of report.dangling) {
    console.error(`check-doc-citations: ${d.file}:${d.line} ${d.document} § ${d.text.slice(0, 80)} — ${d.reason}`);
  }
  console.error(
    `check-doc-citations: ${report.dangling.length} of ${report.citations} citations name a section the document does not have.\n` +
      'Repoint each at the section that states the rule, or add the section to the document if the rule is missing from it.',
  );
  process.exit(1);
}

const { heading, variant, anchor } = report.byKind;
console.log(
  `check-doc-citations: OK — ${report.citations} citations resolve (${heading} headings, ${variant} formatting variants, ${anchor} anchors)`,
);
