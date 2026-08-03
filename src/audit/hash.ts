import { createHash } from 'node:crypto';
import type { Sha256Hex } from '../shared/brands.ts';
import { canonicalize } from '../shared/canonical-json.ts';
import type { AuditRecord } from './types.ts';

/**
 * `20-contract.md` § Audit, U9's resolution: `SHA256_hex(canonical(record))`,
 * `record` being the full flattened `AuditRecord` with only `hash` itself
 * omitted — `sequence` and `previousHash` included like every other field,
 * the same canonicalisation the compiler's registry fingerprint uses.
 */
export function computeAuditRecordHash(record: Omit<AuditRecord, 'hash'>): Sha256Hex {
  const canonical = canonicalize(record);
  return createHash('sha256').update(canonical, 'utf8').digest('hex') as Sha256Hex;
}
