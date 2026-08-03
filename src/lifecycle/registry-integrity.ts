import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Outcome } from '../shared/outcome.ts';
import { sha256Hex, type Sha256Hex } from '../shared/brands.ts';

/**
 * Boot steps 2 and 3 (`10-design.md` § Boot and recovery): "Load the
 * generated registry, verify its fingerprint... A mismatch is fatal."
 *
 * This mirrors `BootError`'s `fingerprint-mismatch` case exactly (same field
 * names) but is scoped to what this slice actually checks — a raw-byte
 * integrity hash of the emitted artifact against a companion hash file
 * written at build time — rather than the full `BootError` union, most of
 * whose variants (`lease-held`, `store-failed`, ...) belong to modules S1
 * does not touch. It is not the compiler's own semantic fingerprint
 * algorithm recomputed at runtime: invariant B8 keeps the compiler out of
 * the runtime image entirely, so boot cannot re-run it. A byte-for-byte
 * tamper of the artifact is exactly as detectable this way, and the
 * artifact's own `fingerprint` field (the compiler's semantic hash over
 * `entries`) travels through unmodified for `VersionReport` to report.
 */
export interface RegistryFingerprintMismatch {
  readonly code: 'fingerprint-mismatch';
  readonly expected: Sha256Hex;
  readonly found: Sha256Hex;
}

export interface RegistryUnreadable {
  readonly code: 'registry-unreadable';
  readonly reason: string;
}

export type RegistryIntegrityError = RegistryFingerprintMismatch | RegistryUnreadable;

export interface VerifiedRegistry {
  readonly contractFingerprint: Sha256Hex;
}

export async function verifyRegistryArtifact(buildDir: string): Promise<Outcome<VerifiedRegistry, RegistryIntegrityError>> {
  let raw: string;
  let expectedHashRaw: string;
  try {
    raw = await readFile(path.join(buildDir, 'registry.json'), 'utf8');
    expectedHashRaw = await readFile(path.join(buildDir, 'registry.json.sha256'), 'utf8');
  } catch (cause) {
    return err({ code: 'registry-unreadable', reason: cause instanceof Error ? cause.message : String(cause) });
  }

  const expectedResult = sha256Hex(expectedHashRaw.trim());
  if (!expectedResult.ok) {
    return err({ code: 'registry-unreadable', reason: 'registry.json.sha256 does not contain a valid SHA-256 hex digest' });
  }
  const expected = expectedResult.value;
  const found = createHash('sha256').update(raw, 'utf8').digest('hex') as Sha256Hex;

  if (found !== expected) {
    return err({ code: 'fingerprint-mismatch', expected, found });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err({ code: 'registry-unreadable', reason: 'registry.json is not valid JSON' });
  }

  const fingerprintField = (parsed as { readonly fingerprint?: unknown }).fingerprint;
  const fingerprintResult = typeof fingerprintField === 'string' ? sha256Hex(fingerprintField) : null;
  if (!fingerprintResult || !fingerprintResult.ok) {
    return err({ code: 'registry-unreadable', reason: 'registry.json has no valid fingerprint field' });
  }

  return ok({ contractFingerprint: fingerprintResult.value });
}
