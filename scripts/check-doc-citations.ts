import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DOCUMENT_NAMES = ['10-design.md', '20-contract.md'] as const;

type DocumentName = (typeof DOCUMENT_NAMES)[number];

export interface CitationSource {
  readonly path: string;
  readonly contents: string;
}

export interface CitationFinding {
  readonly sourcePath: string;
  readonly line: number;
  readonly document: DocumentName;
  readonly reference: string;
  readonly reason: string;
}

interface DocumentIndex {
  readonly aliases: readonly string[];
  readonly anchors: ReadonlySet<string>;
  readonly codeIdentifiers: ReadonlySet<string>;
  readonly normalisedContents: string;
  readonly normalisedLines: readonly string[];
}

const CITATION = /(?:design\/)?(10-design\.md|20-contract\.md)`?\s*§\s*/g;
const STRUCTURED_ANCHOR = /\b([DURW]\d+(?:\.\d+)?)\b/g;
const GENERIC_WORDS = new Set(['a', 'an', 'does', 'exist', 'is', 'not', 'section', 'that', 'the', 'this']);

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[`*_'"“”‘’]/g, '')
    .replace(/[—–-]+/g, ' ')
    .replace(/[›>\/]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasVariants(value: string): readonly string[] {
  const cleaned = cleanMarkdown(value);
  const variants = new Set<string>([normalise(cleaned)]);
  const withoutNumber = cleaned.replace(/^\d+\.\s*/, '');
  variants.add(normalise(withoutNumber));

  const dash = withoutNumber.indexOf(' — ');
  if (dash > 0) variants.add(normalise(withoutNumber.slice(0, dash)));

  const parenthetical = withoutNumber.indexOf(' (');
  if (parenthetical > 0) variants.add(normalise(withoutNumber.slice(0, parenthetical)));

  const layer = /^(L\d+)\b/.exec(withoutNumber)?.[1];
  if (layer) variants.add(normalise(layer));
  return [...variants].filter(Boolean);
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim();
}

function indexDocument(contents: string): DocumentIndex {
  const aliases = new Set<string>();
  const anchors = new Set<string>();
  const codeIdentifiers = new Set<string>();
  const parents: string[] = [];

  for (const line of contents.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const title = cleanMarkdown(heading[2]!);
      parents.length = level - 1;
      parents[level - 1] = title;

      for (const alias of aliasVariants(title)) aliases.add(alias);
      for (const match of title.matchAll(STRUCTURED_ANCHOR)) anchors.add(match[1]!.toUpperCase());
      for (let ancestor = level - 2; ancestor >= 0; ancestor -= 1) {
        const parent = parents[ancestor];
        if (parent) {
          for (const alias of aliasVariants(`${parent} ${title}`)) aliases.add(alias);
        }
      }
    }

    for (const match of line.matchAll(/\*\*([^*\n]+)\*\*/g)) {
      const bold = cleanMarkdown(match[1]!);
      const label = /^([DURW]\d+(?:\.\d+)?)\b/.exec(bold)?.[1];
      if (label) anchors.add(label.toUpperCase());
      for (const alias of aliasVariants(bold)) aliases.add(alias);
    }

    const tableAnchor = /^\|\s*([DURW]\d+(?:\.\d+)?)\s*\|/.exec(line)?.[1];
    if (tableAnchor) anchors.add(tableAnchor.toUpperCase());

    for (const match of line.matchAll(/`([A-Za-z_$][A-Za-z0-9_$.-]*)`/g)) {
      codeIdentifiers.add(match[1]!.toLowerCase());
    }
  }

  for (const match of contents.matchAll(/\b(?:type|interface|class|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    codeIdentifiers.add(match[1]!.toLowerCase());
  }

  return {
    aliases: [...aliases].filter(Boolean).sort((left, right) => right.length - left.length),
    anchors,
    codeIdentifiers,
    normalisedContents: normalise(contents),
    normalisedLines: contents.split(/\r?\n/).map(normalise),
  };
}

function referenceClause(afterMarker: string): string {
  const withoutCommentFurniture = afterMarker
    .replace(/\r?\n\s*(?:\/\/|\/\*|\*\/|\*)?\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const terminal = withoutCommentFurniture.search(/[:;)]|\.(?=\s+(?:[A-Z`*]|$))/);
  const clause = terminal >= 0 ? withoutCommentFurniture.slice(0, terminal) : withoutCommentFurniture;
  return clause.slice(0, 180).trim();
}

function lineAt(contents: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (contents.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function resolveReference(reference: string, document: DocumentName, index: DocumentIndex): string | null {
  const normalised = normalise(reference);
  const heading = index.aliases.find(
    (alias) =>
      normalised === alias ||
      normalised.startsWith(`${alias} `) ||
      (normalised.split(' ').length >= 2 && alias.startsWith(`${normalised} `)),
  );

  const identifiers = [...reference.matchAll(STRUCTURED_ANCHOR)].map((match) => match[1]!.toUpperCase());
  if (heading && document === '10-design.md') return null;

  const missingIdentifier = identifiers.find((identifier) => !index.anchors.has(identifier));
  if (missingIdentifier) return `anchor ${missingIdentifier} does not exist`;

  if (heading) return null;
  if (identifiers.length > 0) return null;

  const codeIdentifier = /^`([A-Za-z_$][A-Za-z0-9_$.-]*)`/.exec(reference)?.[1]?.toLowerCase();
  if (codeIdentifier && index.codeIdentifiers.has(codeIdentifier)) return null;

  const words = normalised.split(' ').filter((word) => word.length > 0);
  for (let length = Math.min(words.length, 8); length >= 2; length -= 1) {
    if (length === 2 && words.slice(0, 2).some((word) => word.length < 4 || GENERIC_WORDS.has(word))) continue;
    const prefix = words.slice(0, length).join(' ');
    if (index.normalisedContents.includes(prefix)) return null;
    if (index.normalisedLines.some((line) => words.slice(0, length).every((word) => line.includes(word)))) return null;
  }

  return 'no heading or named anchor matches the citation';
}

export function checkDocCitations(
  sources: readonly CitationSource[],
  documents: Readonly<Record<DocumentName, string>>,
): readonly CitationFinding[] {
  const indexes: Readonly<Record<DocumentName, DocumentIndex>> = {
    '10-design.md': indexDocument(documents['10-design.md']),
    '20-contract.md': indexDocument(documents['20-contract.md']),
  };
  const findings: CitationFinding[] = [];

  for (const source of sources) {
    for (const match of source.contents.matchAll(CITATION)) {
      const document = match[1] as DocumentName;
      const markerEnd = (match.index ?? 0) + match[0].length;
      const reference = referenceClause(source.contents.slice(markerEnd, markerEnd + 240));
      const reason = resolveReference(reference, document, indexes[document]);
      if (reason) {
        findings.push({
          sourcePath: source.path,
          line: lineAt(source.contents, match.index ?? 0),
          document,
          reference,
          reason,
        });
      }
    }
  }

  return findings;
}

function sourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files.sort();
}

function run(): void {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const srcRoot = path.join(repoRoot, 'src');
  const sources = sourceFiles(srcRoot).map((file) => ({
    path: path.relative(repoRoot, file).replaceAll(path.sep, '/'),
    contents: readFileSync(file, 'utf8'),
  }));
  const documents: Record<DocumentName, string> = {
    '10-design.md': readFileSync(path.join(repoRoot, 'design', '10-design.md'), 'utf8'),
    '20-contract.md': readFileSync(path.join(repoRoot, 'design', '20-contract.md'), 'utf8'),
  };

  const findings = checkDocCitations(sources, documents);
  if (findings.length > 0) {
    console.error(`check-doc-citations: ${findings.length} dangling citation(s)`);
    for (const finding of findings) {
      console.error(
        `${finding.sourcePath}:${finding.line}: ${finding.document} § ${finding.reference} — ${finding.reason}`,
      );
    }
    process.exit(1);
  }

  console.log(`check-doc-citations: OK — ${sources.length} source files checked`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run();
