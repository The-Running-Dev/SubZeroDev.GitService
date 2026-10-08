import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves every `design/` section a source file cites by `§` against that
 * document (S66, issue #301). A citation is matched by prefix — the cited text
 * must *begin with* a name the document gives — so nothing depends on guessing
 * where the section name ends and the surrounding prose resumes; that guess is
 * what made the manual sweep #301 records report twenty false misses.
 *
 * Three outcomes besides `missing`, so a formatting variant is never confused
 * with a section that does not exist:
 * - `heading`: the text begins with a heading as written, whitespace aside.
 * - `variant`: it does once case, dashes, backticks and a leading "the" are
 *   set aside, or it names a heading by its label (`L5` for `L5 — surfaces`),
 *   without its ordinal (`Boot and recovery` for `3. Boot and recovery — ...`)
 *   or without its parenthetical.
 * - `anchor`: it names something the document states that is not a heading —
 *   a sub-section id such as `U4` or `D18`, a declared `identifier`, a bold
 *   lead, or a quoted phrase.
 *
 * Two refinements make a matched heading insufficient on its own. An id
 * directly after it (`§ L2 — watcher, D18`) must appear in the document; this is
 * the #298 case, where the section existed and the `W08.3` it pointed into
 * never did. And a `›` path (`§ Error semantics › Authorization`) must name a
 * heading nested under the first, or an `identifier` inside it.
 */

export type CitationKind = 'heading' | 'variant' | 'anchor' | 'missing';

export interface Citation {
  readonly file: string;
  readonly line: number;
  /** The cited document's file name, e.g. `20-contract.md`. */
  readonly document: string;
  /** The source text from just after `§`, continued across comment lines. */
  readonly text: string;
}

export interface Resolution {
  readonly kind: CitationKind;
  /** Why a `missing` citation did not resolve. */
  readonly reason?: string;
}

export interface DanglingCitation extends Citation {
  readonly reason: string;
}

export interface CitationReport {
  readonly citations: number;
  readonly byKind: Readonly<Record<CitationKind, number>>;
  readonly dangling: readonly DanglingCitation[];
}

/** Planted dangling citations are this file's fixtures, so the tree-wide scan skips it. */
export const SKIPPED_FILES: readonly string[] = ['scripts/doc-citations.test.ts'];

const CITATION = /`?(\d{2}-[a-z][a-z-]*\.md)`?\s*§[ \t]*/g;
const COMMENT_LINE = /^\s*(?:\/\/+|\*(?!\/))\s?/;
const ID = /^[A-Z]{1,2}\d+(?:\.\d+)?(?![A-Za-z0-9]|\.\d)/;
/** A leading `identifier` — a type, table or field the document declares rather than titles. */
const IDENTIFIER = /^`([A-Za-z_][\w.]*)`/;
const CONTINUATION_CHARS = 160;
const CONTINUATION_LINES = 3;

/** Every `NN-name.md § ...` citation in one source file. */
export function extractCitations(file: string, source: string): Citation[] {
  const lines = source.split(/\r?\n/);
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const normalisedSource = lines.join('\n');
  const citations: Citation[] = [];
  for (const match of normalisedSource.matchAll(CITATION)) {
    const start = match.index;
    const end = start + match[0].length;
    const lineIndex = lineStarts.findLastIndex((s) => s <= start);
    const endLine = lineStarts.findLastIndex((s) => s <= end);
    let text = normalisedSource.slice(end, lineStarts[endLine]! + lines[endLine]!.length);
    for (let extra = 0; extra < CONTINUATION_LINES && text.length < CONTINUATION_CHARS; extra++) {
      const next = lines[endLine + 1 + extra];
      if (next === undefined || !COMMENT_LINE.test(next)) break;
      text += ' ' + next.replace(COMMENT_LINE, '');
    }
    citations.push({ file, line: lineIndex + 1, document: match[1]!, text: text.replace(/\s+/g, ' ').trim() });
  }
  return citations;
}

interface Heading {
  readonly level: number;
  readonly text: string;
  /** The heading's own line, 0-based. */
  readonly line: number;
  /** The line the next heading of the same or a higher level is on, or the line count. */
  readonly sectionEnd: number;
}

interface DocumentIndex {
  readonly text: string;
  readonly lines: readonly string[];
  readonly headings: readonly Heading[];
  readonly boldLeads: readonly string[];
  /** The whole document, compared `loose`ly; what a quoted phrase is looked up in. */
  readonly flatText: string;
  /** A `## Landed` section's text, or empty: the index of slices whose bodies were retired. */
  readonly landed: string;
}

const indexes = new Map<string, DocumentIndex>();

function indexDocument(markdown: string): DocumentIndex {
  const cached = indexes.get(markdown);
  if (cached !== undefined) return cached;
  const lines = markdown.split(/\r?\n/);
  const raw: { level: number; text: string; line: number }[] = [];
  const boldLeads: string[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) raw.push({ level: heading[1]!.length, text: heading[2]!, line: i });
    // A bold lead opens a paragraph, a list item or a table row's first cell.
    const bold = /^\s*(?:(?:[-*+]|\d+\.)\s+|\|\s*)?(?:~~)?\*\*(.+?)\*\*/.exec(line);
    if (bold) boldLeads.push(bold[1]!);
  });
  const headings = raw.map((h, i) => {
    const next = raw.slice(i + 1).find((later) => later.level <= h.level);
    return { level: h.level, text: h.text, line: h.line, sectionEnd: next?.line ?? lines.length };
  });
  const landed = headings.find((h) => h.level === 2 && h.text === 'Landed');
  const index = {
    text: markdown,
    lines,
    headings,
    boldLeads,
    flatText: loose(markdown),
    landed: landed === undefined ? '' : lines.slice(landed.line, landed.sectionEnd).join('\n'),
  };
  indexes.set(markdown, index);
  return index;
}

/** Whitespace collapsed; the comparison a `heading` match makes. */
function strict(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Case, dashes, backticks, emphasis and quote styles set aside; the comparison a `variant` match makes. */
function loose(text: string): string {
  return text
    .replace(/[`*_]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/(^|\s)(?:—|–|--?)(?=\s|$)/g, ' ')
    .replace(/[—–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The names a heading or bold lead answers to: itself, without its ordinal,
 * its label before the dash, itself without a parenthetical, and — for a bold
 * lead, which runs on as a sentence — its first clause (`Files on the volume`
 * for `Files on the volume, not rows.`).
 */
function names(text: string, firstClause: boolean): string[] {
  const out = new Set<string>();
  for (const base of [text, text.replace(/^\d+(?:\.\d+)*\.?\s+/, '')]) {
    out.add(base);
    const label = /^(.+?)\s+[—–]\s+/.exec(base);
    if (label) out.add(label[1]!);
    out.add(base.replace(/\s*\([^)]*\)/g, ''));
    const clause = firstClause ? /^(.+?)[,;:.]\s/.exec(base) : null;
    if (clause) out.add(clause[1]!);
  }
  return [...out].map((name) => name.replace(/[.:,;]+$/, '').trim()).filter((name) => name.length > 0);
}

/** The length of the prefix of `text` that `name` matches, ending at a word boundary, or 0. `S22` does not match `S22.1`. */
function prefixLength(text: string, name: string): number {
  if (name.length === 0 || !text.startsWith(name)) return 0;
  return /^(?:[A-Za-z0-9]|\.\d)/.test(text.slice(name.length, name.length + 2)) ? 0 : name.length;
}

/** The citation as a `loose` comparison sees it, with and without a leading "the". */
function looseForms(text: string): string[] {
  const form = loose(text);
  return form.startsWith('the ') ? [form, form.slice(4)] : [form];
}

interface HeadingMatch {
  readonly headings: readonly Heading[];
  readonly kind: 'heading' | 'variant';
  /** The citation text after the matched heading, in the form the match was made in. */
  readonly rest: string;
}

function matchHeading(text: string, candidates: readonly Heading[]): HeadingMatch | null {
  const matches: { length: number; kind: 'heading' | 'variant'; rest: string; heading: Heading }[] = [];
  const strictText = strict(text);
  for (const heading of candidates) {
    const exact = prefixLength(strictText, strict(heading.text));
    if (exact > 0) matches.push({ length: exact, kind: 'heading', rest: strictText.slice(exact), heading });
    for (const form of looseForms(text)) {
      for (const name of names(heading.text, false)) {
        const length = prefixLength(form, loose(name));
        if (length > 0) matches.push({ length, kind: 'variant', rest: form.slice(length), heading });
      }
    }
  }
  if (matches.length === 0) return null;
  // The longest match wins: it is the one that consumed the most of the citation. Among equals, exact over variant.
  const rank = (m: (typeof matches)[number]): number => m.length * 2 + (m.kind === 'heading' ? 1 : 0);
  const best = Math.max(...matches.map(rank));
  const winners = matches.filter((m) => rank(m) === best);
  return { headings: [...new Set(winners.map((m) => m.heading))], kind: winners[0]!.kind, rest: winners[0]!.rest };
}

/** Ids written directly after a matched heading: `, D18`, ` U4`, `, R11/R12`. */
function trailingIds(rest: string): string[] {
  // A `variant` match's rest is lowercased, so an id is read case-blind.
  let remaining = rest.replace(/^,?\s*/, '').toUpperCase();
  const ids: string[] = [];
  for (;;) {
    const id = ID.exec(remaining);
    if (!id) return ids;
    ids.push(id[0]);
    remaining = remaining.slice(id[0].length);
    if (!remaining.startsWith('/')) return ids;
    remaining = remaining.slice(1);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsId(text: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9.])${escapeRegExp(id)}(?![0-9]|\\.\\d)`).test(text);
}

/**
 * An id the document states. A criterion id (`S22.1`) of a slice in a
 * `## Landed` index also resolves: landing retires the slice's body to its
 * closed issue, by `30-slices.md`'s own rule, so its criteria are cited from
 * code but no longer written in the document.
 */
function idResolves(index: DocumentIndex, id: string): boolean {
  if (mentionsId(index.text, id)) return true;
  const parent = /^(.+)\.\d+$/.exec(id);
  return parent !== null && mentionsId(index.landed, parent[1]!);
}

function mentionsIdentifier(text: string, identifier: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(identifier)}(?![A-Za-z0-9_])`).test(text);
}

function sectionText(index: DocumentIndex, heading: Heading): string {
  return index.lines.slice(heading.line, heading.sectionEnd).join('\n');
}

function resolvePath(segment: string, parents: readonly Heading[], index: DocumentIndex, kind: 'heading' | 'variant'): Resolution {
  const identifier = IDENTIFIER.exec(segment);
  if (identifier !== null) {
    return parents.some((h) => mentionsIdentifier(sectionText(index, h), identifier[1]!))
      ? { kind: 'anchor' }
      : { kind: 'missing', reason: `\`${identifier[1]}\` does not appear in § ${parents[0]!.text}` };
  }
  const nested = index.headings.filter((h) => parents.some((p) => h.line > p.line && h.line < p.sectionEnd));
  const inner = matchHeading(segment, nested);
  if (inner === null) return { kind: 'missing', reason: `no heading under § ${parents[0]!.text} begins "${strict(segment).slice(0, 40)}"` };
  return { kind: kind === 'heading' && inner.kind === 'heading' ? 'heading' : 'variant' };
}

function resolveIn(text: string, index: DocumentIndex): Resolution {
  const match = matchHeading(text, index.headings);
  if (match !== null) {
    for (const id of trailingIds(match.rest)) {
      if (!idResolves(index, id)) return { kind: 'missing', reason: `§ ${match.headings[0]!.text} exists, but \`${id}\` appears nowhere in the document` };
    }
    const segment = /^\s*›\s*(.+)$/.exec(match.rest);
    if (segment === null) return { kind: match.kind };
    // Re-read the segment from the strict text, so a `loose` match's lowercasing and stripped backticks do not reach it.
    const strictText = strict(text);
    return resolvePath(strictText.slice(strictText.indexOf('›') + 1).trim(), match.headings, index, match.kind);
  }

  // A quoted phrase, where `...` marks an elision: each fragment, in order.
  const quote = /^["“]([^"”]+)["”]?/.exec(text);
  if (quote !== null) {
    let from = 0;
    for (const fragment of quote[1]!.split(/\.\.\.|…/).map(loose).filter((f) => f.length > 0)) {
      const at = index.flatText.indexOf(fragment, from);
      if (at < 0) return { kind: 'missing', reason: `the quoted phrase "${fragment.slice(0, 40)}" does not appear in the document` };
      from = at + fragment.length;
    }
    return { kind: 'anchor' };
  }

  const identifier = IDENTIFIER.exec(text);
  if (identifier !== null) {
    return mentionsIdentifier(index.text, identifier[1]!)
      ? { kind: 'anchor' }
      : { kind: 'missing', reason: `\`${identifier[1]}\` does not appear in the document` };
  }

  const id = ID.exec(text);
  if (id !== null) {
    return idResolves(index, id[0]) ? { kind: 'anchor' } : { kind: 'missing', reason: `\`${id[0]}\` does not appear in the document` };
  }

  for (const form of looseForms(text)) {
    for (const lead of index.boldLeads) {
      if (names(lead, true).some((name) => prefixLength(form, loose(name)) > 0)) return { kind: 'anchor' };
    }
  }

  return { kind: 'missing', reason: 'no heading, id, identifier, bold lead or quoted phrase in the document matches' };
}

/** Resolves one citation against `documents`, keyed by file name (`20-contract.md`). */
export function resolveCitation(citation: Citation, documents: ReadonlyMap<string, string>): Resolution {
  const markdown = documents.get(citation.document);
  if (markdown === undefined) return { kind: 'missing', reason: `design/${citation.document} does not exist` };
  if (citation.text.length === 0) return { kind: 'missing', reason: 'nothing follows §' };
  return resolveIn(citation.text, indexDocument(markdown));
}

/** Resolves every citation in `sources` (file name to contents). */
export function checkCitations(sources: ReadonlyMap<string, string>, documents: ReadonlyMap<string, string>): CitationReport {
  const byKind: Record<CitationKind, number> = { heading: 0, variant: 0, anchor: 0, missing: 0 };
  const dangling: DanglingCitation[] = [];
  let citations = 0;
  for (const [file, source] of sources) {
    for (const citation of extractCitations(file, source)) {
      citations++;
      const resolution = resolveCitation(citation, documents);
      byKind[resolution.kind]++;
      if (resolution.kind === 'missing') dangling.push({ ...citation, reason: resolution.reason ?? 'unresolved' });
    }
  }
  return { citations, byKind, dangling };
}

/** Every `design/*.md`, keyed by file name. */
export function readDesignDocuments(root: string): Map<string, string> {
  const dir = path.join(root, 'design');
  return new Map(
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]),
  );
}

/**
 * The output directories `.gitignore` names, as root-relative paths: matching
 * by bare name would also skip a source directory that shares one.
 * `node_modules` is skipped at any depth.
 */
const UNSCANNED_PATHS = new Set(['build', 'volume', 'console/dist', 'test-results']);

/**
 * Every `.ts`/`.tsx` file under `root`, as `/`-separated paths relative to it.
 * A filesystem walk rather than `git ls-files`, because the Dockerfile's
 * `builder` stage runs `npm run build` with neither git nor `.git`.
 */
export function listSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && !UNSCANNED_PATHS.has(child)) walk(child);
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(child);
      }
    }
  };
  walk('');
  return found.sort();
}

/** Reads `files` (`/`-separated paths relative to `root`) and checks every citation in them. */
export function findDanglingCitations(root: string, files: readonly string[], documents: ReadonlyMap<string, string>): CitationReport {
  const sources = new Map<string, string>();
  for (const file of files) {
    if (SKIPPED_FILES.includes(file)) continue;
    sources.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
  }
  return checkCitations(sources, documents);
}
