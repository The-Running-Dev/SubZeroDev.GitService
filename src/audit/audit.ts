import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sha256Hex, type IsoUtcTimestamp, type Sha256Hex } from '../shared/brands.ts';
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
  RetainedAnchor,
} from './types.ts';

export interface Audit {
  append(input: AuditAppendInput): Promise<AuditAppendOutcome>;
  query(filter: AuditQuery): Promise<Outcome<AuditPage, AuditError>>;
  verify(): Promise<AuditChainState>;
  chainState(): Promise<AuditChainState>;
  runRetention(): Promise<RetentionReport>;
  close(): Promise<void>;
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

/**
 * The mirror is **advisory**. The segment files are the trail; this row is a
 * fast read and a tamper cross-check, and the whole point of keeping the log
 * outside the structured store is that it survives that store's corruption.
 * So every read of it is best-effort: a store that cannot be opened, or whose
 * schema is not there yet, yields `null` and the caller re-derives from the
 * files instead.
 */
function readMirroredHead(db: DatabaseSync | null): ChainHeadRow | null {
  if (!db) return null;
  try {
    const rows = db.prepare('SELECT sequence, head_hash FROM audit_chain_head WHERE singleton = 1').all() as {
      sequence: number;
      head_hash: string;
    }[];
    const row = rows[0];
    if (!row) return null;
    return { sequence: row.sequence, headHash: row.head_hash as Sha256Hex };
  } catch {
    return null;
  }
}

/**
 * Derives the chain head from the segment files — the authoritative answer.
 *
 * This is not a fallback for when the mirror is missing; it is the source the
 * mirror mirrors. A mirror write can fail and be swallowed (the file append
 * already succeeded, so the record is durable and must not be discarded),
 * which leaves the row behind the files. Trusting it then would chain the
 * next record onto a predecessor two records back and reuse a sequence number
 * already on disk — producing a duplicate that hash-linkage alone does not
 * catch.
 *
 * Streams rather than slurps, so a 64 MiB segment costs constant memory.
 */
function deriveHeadFromFiles(volumeRoot: string): ChainHeadRow | null {
  const segments = listSegments(volumeRoot);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    let last: ChainHeadRow | null = null;
    for (const line of streamSegmentLines(segmentPath(volumeRoot, segments[i]!))) {
      try {
        const record = JSON.parse(line) as AuditRecord;
        if (typeof record.sequence === 'number' && typeof record.hash === 'string') {
          last = { sequence: record.sequence, headHash: record.hash };
        }
      } catch {
        // A torn final line is not the head; the last good record before it is.
      }
    }
    if (last) return last;
  }
  return null;
}

/**
 * Best-effort for the same reason as `readMirroredHead`: the anchors live in
 * the structured store, and a trail whose verification depended on that store
 * being readable would not survive its corruption.
 */
function readRetainedAnchors(db: DatabaseSync | null): readonly RetainedAnchor[] {
  if (!db) return [];
  try {
    const rows = db
      .prepare('SELECT segment, terminal_sequence, terminal_hash, retained_at FROM audit_retained_anchor ORDER BY segment')
      .all() as { segment: number; terminal_sequence: number; terminal_hash: string; retained_at: string }[];
    return rows.map((r) => ({
      segment: r.segment,
      terminalSequence: r.terminal_sequence,
      terminalHash: r.terminal_hash as Sha256Hex,
      retainedAt: r.retained_at as IsoUtcTimestamp,
    }));
  } catch {
    return [];
  }
}

function writeMirroredHead(db: DatabaseSync, sequence: number, headHash: Sha256Hex, updatedAt: string): void {
  db.prepare(
    `INSERT INTO audit_chain_head (singleton, sequence, head_hash, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET sequence = excluded.sequence, head_hash = excluded.head_hash, updated_at = excluded.updated_at`,
  ).run(sequence, headHash, updatedAt);
}

/**
 * Yields a segment's lines without holding the whole file in memory. Segments
 * are capped at `auditSegmentBytes` (64 MiB by default) and `verify` walks
 * every one of them, so slurping each in full made peak memory a function of
 * segment size rather than a constant.
 *
 * A well-formed file ends with a trailing newline, so the final chunk is
 * empty and is dropped. A mid-line truncation leaves a non-empty malformed
 * final chunk, which reaches the caller and is reported as a break rather
 * than silently discarded.
 */
function* streamSegmentLines(filePath: string): Generator<string> {
  const CHUNK = 1 << 16;
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    let carry = '';
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) break;
      carry += buffer.subarray(0, read).toString('utf8');
      let newlineAt = carry.indexOf('\n');
      while (newlineAt !== -1) {
        yield carry.slice(0, newlineAt);
        carry = carry.slice(newlineAt + 1);
        newlineAt = carry.indexOf('\n');
      }
    }
    if (carry.length > 0) yield carry;
  } finally {
    closeSync(fd);
  }
}

/**
 * Walks every record across every segment, in chain order, verifying as it
 * goes.
 *
 * `anchors` is what makes this survive retention. Once S17 prunes an early
 * segment, the first surviving record's `previousHash` is no longer `null`,
 * and a verifier that assumed a `null` genesis would report a chain break
 * that never happened. Invariant S2 guarantees a segment is only ever deleted
 * after its terminal hash is written as a `RetainedAnchor`, so the anchor for
 * the segment preceding the first surviving one is the hash this walk should
 * start from.
 */
function verifyFromDisk(
  volumeRoot: string,
  mirrored: ChainHeadRow | null,
  anchors: readonly RetainedAnchor[],
): AuditChainState {
  const segments = listSegments(volumeRoot);
  const firstSegment = segments[0];

  // If the earliest segment on disk is not segment 1, the ones before it were
  // pruned, and the anchor for the segment immediately before it carries the
  // hash and sequence this chain legitimately resumes from.
  const resumeAnchor =
    firstSegment !== undefined && firstSegment > 1
      ? (anchors.find((a) => a.segment === firstSegment - 1) ?? null)
      : null;

  let runningHash: Sha256Hex | null = resumeAnchor?.terminalHash ?? null;
  let runningSequence = resumeAnchor?.terminalSequence ?? 0;
  let chainBreak: AuditChainBreak | null = null;
  let sawAnyRecord = false;

  outer: for (const segment of segments) {
    for (const line of streamSegmentLines(segmentPath(volumeRoot, segment))) {
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

      // Invariant S1: sequence numbers are contiguous. Hash linkage alone does
      // not imply this — a record appended after a stale-mirror read chains
      // onto the correct predecessor hash while *reusing* a sequence number
      // already on disk, which reads as a healthy chain unless the numbering
      // is checked in its own right.
      if (parsed.sequence !== runningSequence + 1) {
        chainBreak = {
          atSequence: parsed.sequence,
          expectedHash: runningHash ?? NO_PREDECESSOR_SENTINEL,
          foundHash: claimedHash,
        };
        break outer;
      }

      runningHash = claimedHash;
      runningSequence = parsed.sequence;
      sawAnyRecord = true;
    }
  }

  // Every readable record verified, but the mirror claims more than the files
  // hold: the tail was truncated cleanly, leaving no partial line for the
  // parse-failure branch above to catch. Only meaningful when the mirror was
  // actually readable — an absent mirror proves nothing either way.
  if (chainBreak === null && mirrored !== null && runningSequence < mirrored.sequence) {
    chainBreak = { atSequence: mirrored.sequence, expectedHash: mirrored.headHash, foundHash: null };
  }

  return {
    verifiedThrough: runningSequence,
    headHash: sawAnyRecord || resumeAnchor !== null ? runningHash : null,
    mirroredHeadHash: mirrored?.headHash ?? null,
    retainedAnchors: anchors,
    chainBreak,
  };
}

export function createAudit(options: AuditOptions): Audit {
  const { volumeRoot, clock } = options;
  const segmentBytes = options.segmentBytes ?? AUDIT_SEGMENT_BYTES_DEFAULT;
  const dbPath = path.join(volumeRoot, 'store.sqlite');

  let db: DatabaseSync | null = null;
  let dbUnavailable = false;

  /**
   * Returns `null` rather than throwing when the structured store cannot be
   * opened. The audit log deliberately lives outside that store so it can
   * outlive its corruption; making the trail's own operation conditional on
   * opening it would defeat the arrangement entirely.
   */
  function chainHeadDb(): DatabaseSync | null {
    if (db) return db;
    if (dbUnavailable) return null;
    try {
      db = new DatabaseSync(dbPath);
      return db;
    } catch {
      dbUnavailable = true;
      return null;
    }
  }

  let head: ChainHeadRow | null | undefined; // undefined = not yet hydrated
  let currentSegment = 0;
  let currentSegmentBytes = 0;
  let initialized = false;

  function ensureInitialized(): void {
    if (initialized) return;
    mkdirSync(path.join(volumeRoot, AUDIT_DIR), { recursive: true });
    // The files are authoritative. The mirror is a fast path; when it is
    // missing or unreadable the head is re-derived from the segments, so a
    // corrupt store slows the first append rather than stopping the trail.
    // The files decide, always. Chaining onto the mirror would mean chaining
    // onto a record we cannot see: if the mirror is behind (a swallowed write)
    // the next append reuses a sequence already on disk, and if it is ahead
    // (a truncated tail) it names a predecessor that no longer exists. The
    // mirror's remaining job is telling `verify` about that truncation, which
    // it does there — not here.
    head = deriveHeadFromFiles(volumeRoot);
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
        const mirror = chainHeadDb();
        if (mirror) writeMirroredHead(mirror, record.sequence, record.hash, clock.now());
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

  function safeChainState(): AuditChainState {
    try {
      ensureInitialized();
      const mirror = chainHeadDb();
      return verifyFromDisk(volumeRoot, readMirroredHead(mirror), readRetainedAnchors(mirror));
    } catch (cause) {
      // Nothing readable at all — not even the segment directory. Report it as
      // a break at the head rather than throwing, so the health view says the
      // trail is unverifiable instead of the process falling over.
      return {
        verifiedThrough: null,
        headHash: null,
        mirroredHeadHash: null,
        retainedAnchors: [],
        chainBreak: {
          atSequence: 0,
          expectedHash: NO_PREDECESSOR_SENTINEL,
          foundHash: null,
        },
      };
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

    // Neither of these may throw: the contract types both as returning an
    // `AuditChainState` with no error type, and the design requires a broken
    // or unreadable trail to be *reported*, never fatal — refusing to serve
    // on a corrupt trail would hand anyone able to corrupt it a way to stop
    // the service. Every store read below is already best-effort; this guard
    // covers an unreadable segment file too.
    async verify(): Promise<AuditChainState> {
      return safeChainState();
    },

    // Nothing in the contract distinguishes chainState()'s freshness or cost
    // from verify()'s. Re-deriving from disk here — rather than serving a
    // cached value that could go stale between a corruption and the next
    // scheduled verify() — is what guarantees the health report in S3's
    // acceptance criteria always reflects a real break the moment it exists.
    async chainState(): Promise<AuditChainState> {
      return safeChainState();
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

        return ok({ records: page, nextCursor, chain: safeChainState() });
      } catch {
        return err({ resultKind: 'infrastructure', retryable: false, summary: 'audit query failed', code: 'query-failed' });
      }
    },

    async runRetention(): Promise<RetentionReport> {
      // S17 owns retention and the anchors it writes. Nothing prunes yet.
      return { module: 'audit', deletedRows: 0, freedBytes: 0, skipped: ['retention lands in S17'] };
    },

    async close(): Promise<void> {
      // The segment files hold no handle — every append opens, writes and
      // closes. Only the mirror connection outlives a call, so it is the only
      // thing to release. Re-openable afterwards: `chainHeadDb()` is lazy, and
      // `dbUnavailable` is deliberately not set here, since a deliberate close
      // is not evidence the store is broken.
      if (db) {
        db.close();
        db = null;
      }
      initialized = false;
    },
  };
}
