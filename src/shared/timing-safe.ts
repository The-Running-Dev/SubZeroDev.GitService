import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compares fixed-length digests rather than the raw strings, so a
 * length-mismatch early return (which `timingSafeEqual` itself requires,
 * since it rejects unequal-length buffers) never depends on the length of
 * the caller-presented secret — only on the length of a hash, which is
 * always 32 bytes. Shared by every bearer/secret comparison in the service
 * (the operator API token, the provisioning secret, the break-glass token,
 * the CSRF double-submit check) rather than reimplemented per call site.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
