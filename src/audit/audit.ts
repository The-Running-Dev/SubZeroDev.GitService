import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sha256Hex, type Sha256Hex } from '../shared/brands.ts';
import type { Outcome } from '../shared/outcome.ts';
import { ok, err } from '../shared/outcome.ts';
import type { Clock } from '../clock/clock.ts';
import type { RetentionReport } from '../shared/retention.ts';
import { computeAuditRecordHash } from './hash.ts';
import type { AuditError } from './errors.ts';
import type {
  AuditAppendInput,
  AuditAppendOutcome,
  AuditChainBreak,
  AuditChainState,
  AuditPage,
  AuditQuery,
  AuditRecord,
} from './types.ts';

export interface Audit {
  append(input: AuditAppendInput): Promise<AuditAppendOutcome>;
  query(filter: AuditQuery): Promise<Outcome<AuditPage, AuditError>>;
  verify(): Promise<AuditChainState>;
  chainState(): Promise<AuditChainState>;
  runRetention(): Promise<RetentionReport>;
}

/** The contract's stated default (`20-contract.md` § Deployment configuration). */
export const AUDIT_SEGMENT_BYTES_DEFAULT = 67_108_864;

export interface AuditOptions {
  readonly volumeRoot: string;
  readonly clock: Clock;
  readonly segmentBytes?: number;
}

const SEGMENT_DIGITS = 6;
const AUDIT_DIR = 'audit';

function segmentPath(volumeRoot: string, segment: number): string {
  return path.join(volumeRoot, AUDIT_DIR, `${String(segment).padStart(SEGMENT_DIGITS, '0')}.jsonl`);
}

function segmentNumberFromFilename(name: string): number | null {
  const match = /^(\d{6})\.jsonl$/.exec(name);
  return match ? Number(match[1]) : null;
}

function listSegments(volumeRoot: string): number[] {
  const dir = path.join(volumeRoot, AUDIT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(segmentNumberFromFilename)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

/**
 * Represents "no predecessor" as a real `Sha256Hex` for `AuditChainBreak.expectedHash`,
 * which the contract types non-nullable. Only reachable if the genesis record's own
 * `previousHash` was itself corrupted to non-null — every other break has a real
 * predecessor hash to expect. Same construction as `NO_CONSOLE_FINGERPRINT`: the
 * SHA-256 of the empty string, a well-known sentinel rather than a fabricated value.
 */
const NO_PREDECESSOR_SENTINEL: Sha256Hex = (() => {
  const result = sha256Hex(createHash('sha256').update('').digest('hex'));
  if (!result.ok) throw new Error('unreachable: sha256 of empty string is always 64 hex chars');
  return result.value;
})();

interface ChainHeadRow {
  readonly sequence: number;
  readonly headHash: Sha256Hex;
}

function readMirroredHead(db: DatabaseSync): ChainHeadRow | null {
  const rows = db.prepare('SELECT sequence, head_hash FROM audit_chain_head WHERE singleton = 1').all() as {
    sequence: number;
    head_hash: string;
  }[];
  const row = rows[0];
  if (!row) return null;
  return { sequence: row.sequence, headHash: row.head_hash as Sha256Hex };
}

function writeMirroredHead(db: DatabaseSync, sequence: number, headHash: Sha256Hex, updatedAt: string): void {
  db.prepare(
    `INSERT INTO audit_chain_head (singleton, sequence, head_hash, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET sequence = excluded.sequence, head_hash = excluded.head_hash, updated_at = excluded.updated_at`,
  ).run(sequence, headHash, updatedAt);
}

/** Reads every record across every segment, in chain order, verifying as it goes. */
function verifyFromDisk(volumeRoot: string, mirrored: ChainHeadRow | null): AuditChainState {
  const segments = listSegments(volumeRoot);
  let runningHash: Sha256Hex | null = null;
  let runningSequence = 0;
  let chainBreak: AuditChainBreak | null = null;

  outer: for (const segment of segments) {
    const raw = readFileSync(segmentPath(volumeRoot, segment), 'utf8');
    const lines = raw.split('\n');
    // A well-formed file ends with a trailing newline, producing one empty
    // trailing element; drop only that. A mid-line truncation leaves a
    // non-empty malformed final element, which is handled as a break below,
    // not silently dropped.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    for (const line of lines) {
      let parsed: AuditRecord;
      try {
        parsed = JSON.parse(line) as AuditRecord;
      } catch {
        chainBreak = {
          atSequence: runningSequence + 1,
          expectedHash: runningHash ?? NO_PREDECESSOR_SENTINEL,
          foundHash: null,
        };
        break outer;
      }

      const { hash: claimedHash, ...withoutHash } = parsed;
      const computedHash = computeAuditRecordHash(withoutHash);

      if (claimedHash !== computedHash) {
        chainBreak = { atSequence: parsed.sequence, expectedHash: computedHash, foundHash: claimedHash };
        break outer;
      }
      if (parsed.previousHash !== runningHash) {
        chainBreak = {
          atSequence: parsed.sequence,
          expectedHash: runningHash ?? NO_PREDECESSOR_SENTINEL,
          foundHash: parsed.previousHash,
        };
        break outer;
      }

      runningHash = claimedHash;
      runningSequence = parsed.sequence;
    }
  }

  // Every readable record verified, but the store's mirror claims more than
  // the files hold: the tail was truncated cleanly (no partial line to catch
  // the parse-failure branch above).
  if (chainBreak === null && mirrored !== null && runningSequence < mirrored.sequence) {
    chainBreak = { atSequence: mirrored.sequence, expectedHash: mirrored.headHash, foundHash: null };
  }

  return {
    verifiedThrough: runningSequence,
    headHash: runningSequence === 0 ? null : runningHash,
    mirroredHeadHash: mirrored?.headHash ?? null,
    retainedAnchors: [],
    chainBreak,
  };
}

export function createAudit(options: AuditOptions): Audit {
  const { volumeRoot, clock } = options;
  const segmentBytes = options.segmentBytes ?? AUDIT_SEGMENT_BYTES_DEFAULT;
  const dbPath = path.join(volumeRoot, 'store.sqlite');

  let db: DatabaseSync | null = null;
  function chainHeadDb(): DatabaseSync {
    if (!db) db = new DatabaseSync(dbPath);
    return db;
  }

  let head: ChainHeadRow | null | undefined; // undefined = not yet hydrated
  let currentSegment = 0;
  let currentSegmentBytes = 0;
  let initialized = false;

  function ensureInitialized(): void {
    if (initialized) return;
    mkdirSync(path.join(volumeRoot, AUDIT_DIR), { recursive: true });
    head = readMirroredHead(chainHeadDb());
    const segments = listSegments(volumeRoot);
    currentSegment = segments.length > 0 ? Math.max(...segments) : 1;
    const currentPath = segmentPath(volumeRoot, currentSegment);
    currentSegmentBytes = existsSync(currentPath) ? statSync(currentPath).size : 0;
    initialized = true;
  }

  // The single-writer queue: every append chains onto this promise, so two
  // concurrent callers can never read-modify-write the same sequence number.
  let queue: Promise<AuditAppendOutcome> = Promise.resolve({ appended: true, sequence: 0 });

  function classifyWriteFailure(cause: unknown): 'volume-full' | 'write-failed' {
    const code = (cause as { code?: string } | null)?.code;
    return code === 'ENOSPC' ? 'volume-full' : 'write-failed';
  }

  async function doAppend(input: AuditAppendInput): Promise<AuditAppendOutcome> {
    try {
      ensureInitialized();

      const nextSequence = (head?.sequence ?? 0) + 1;
      const previousHash = head?.headHash ?? null;
      const withoutHash: Omit<AuditRecord, 'hash'> = { ...input, sequence: nextSequence, previousHash } as Omit<
        AuditRecord,
        'hash'
      >;
      const hash = computeAuditRecordHash(withoutHash);
      const record = { ...withoutHash, hash } as AuditRecord;

      const line = `${JSON.stringify(record)}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');

      if (currentSegmentBytes > 0 && currentSegmentBytes + lineBytes > segmentBytes) {
        currentSegment += 1;
        currentSegmentBytes = 0;
      }
      const target = segmentPath(volumeRoot, currentSegment);

      try {
        mkdirSync(path.dirname(target), { recursive: true });
        await appendFile(target, line, 'utf8');
      } catch (cause) {
        return { appended: false, reason: classifyWriteFailure(cause) };
      }

      currentSegmentBytes += lineBytes;

      try {
        writeMirroredHead(chainHeadDb(), record.sequence, record.hash, clock.now());
      } catch {
        // The file write — the durable record — already succeeded. The store
        // row is a mirror the design describes for fast reads; a failure to
        // update it does not undo the append, and the next successful append
        // (or a verify()) re-derives the truth from the files.
      }

      head = { sequence: record.sequence, headHash: record.hash };
      return { appended: true, sequence: record.sequence };
    } catch (cause) {
      return { appended: false, reason: classifyWriteFailure(cause) };
    }
  }

  return {
    append(input: AuditAppendInput): Promise<AuditAppendOutcome> {
      const result = queue.then(() => doAppend(input));
      // Detach from the queue's own rejection path: doAppend never rejects,
      // but chain onto a settled promise regardless so one caller's await
      // can never be starved by another's.
      queue = result;
      return result;
    },

    async verify(): Promise<AuditChainState> {
      ensureInitialized();
      const mirrored = readMirroredHead(chainHeadDb());
      return verifyFromDisk(volumeRoot, mirrored);
    },

    // Nothing in the contract distinguishes chainState()'s freshness or cost
    // from verify()'s. Re-deriving from disk here — rather than serving a
    // cached value that could go stale between a corruption and the next
    // scheduled verify() — is what guarantees the health report in S3's
    // acceptance criteria always reflects a real break the moment it exists.
    async chainState(): Promise<AuditChainState> {
      ensureInitialized();
      const mirrored = readMirroredHead(chainHeadDb());
      return verifyFromDisk(volumeRoot, mirrored);
    },

    async query(filter: AuditQuery): Promise<Outcome<AuditPage, AuditError>> {
      try {
        ensureInitialized();
        const segments = listSegments(volumeRoot);
        const cursorSequence = filter.cursor === null ? 0 : Number(filter.cursor);
        const matches: AuditRecord[] = [];

        for (const segment of segments) {
          const raw = readFileSync(segmentPath(volumeRoot, segment), 'utf8');
          const lines = raw.split('\n').filter((l) => l.length > 0);
          for (const line of lines) {
            let record: AuditRecord;
            try {
              record = JSON.parse(line) as AuditRecord;
            } catch {
              return err({ resultKind: 'infrastructure', retryable: false, summary: `segment ${segment} is unreadable`, code: 'segment-unreadable', segment });
            }
            if (record.sequence <= cursorSequence) continue;
            if (filter.declarationId !== null && record.declarationId !== filter.declarationId) continue;
            if (filter.tool !== null && record.tool !== filter.tool) continue;
            if (filter.actorSubject !== null && record.actorRef.subject !== filter.actorSubject) continue;
            if (filter.form !== null && record.form !== filter.form) continue;
            if (filter.from !== null && record.at < filter.from) continue;
            if (filter.to !== null && record.at > filter.to) continue;
            matches.push(record);
          }
        }

        matches.sort((a, b) => a.sequence - b.sequence);
        const page = matches.slice(0, filter.limit);
        const nextCursor = page.length === filter.limit && page.length > 0 ? String(page[page.length - 1]!.sequence) : null;

        const mirrored = readMirroredHead(chainHeadDb());
        const chain = verifyFromDisk(volumeRoot, mirrored);

        return ok({ records: page, nextCursor, chain });
      } catch {
        return err({ resultKind: 'infrastructure', retryable: false, summary: 'audit query failed', code: 'query-failed' });
      }
    },

    async runRetention(): Promise<RetentionReport> {
      // S17 owns retention and the anchors it writes. Nothing prunes yet.
      return { module: 'audit', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },
  };
}
