/**
 * TOTP and AES-256-GCM sealing, using `node:crypto` only — no new dependency.
 *
 * TOTP algorithm: RFC 6238 (HOTP + time step).
 * Sealing: AES-256-GCM, 12-byte random IV prepended, no AAD.
 * The key must be exactly 32 bytes; the caller is responsible for that
 * invariant — `readSealingKey` returns an error when the file is absent or
 * the wrong length.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ─── TOTP sealing (AES-256-GCM) ─────────────────────────────────────────────

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function sealTotp(secret: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function unsealTotp(sealed: string, key: Buffer): Buffer | null {
  try {
    const buf = Buffer.from(sealed, 'base64');
    if (buf.length < IV_BYTES + TAG_BYTES) return null;
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    return null;
  }
}

/** Read the 32-byte TOTP sealing key from the credential mount. */
export function readSealingKey(keyPath: string): Buffer | null {
  try {
    const buf = readFileSync(keyPath);
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

// ─── TOTP (RFC 6238 / RFC 4226) ─────────────────────────────────────────────

const TOTP_STEP = 30;
const TOTP_WINDOW = 1; // accept one step before and after current

/**
 * Generate a random 20-byte TOTP secret and return both the raw bytes and
 * the base32-encoded string for display.
 */
export function generateTotpSecret(): { raw: Buffer; base32: string } {
  const raw = randomBytes(20);
  return { raw, base32: base32Encode(raw) };
}

/** Compute HOTP(secret, counter) — 6-digit code. */
function hotp(secret: Buffer, counter: bigint): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[19]! & 0x0f;
  const code =
    (((mac[offset]! & 0x7f) << 24) |
      ((mac[offset + 1]!) << 16) |
      ((mac[offset + 2]!) << 8) |
      mac[offset + 3]!) %
    1_000_000;
  return code.toString().padStart(6, '0');
}

/** Verify a 6-digit TOTP code within the allowed window. */
export function verifyTotp(secret: Buffer, code: string, nowMs: number): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const step = BigInt(Math.floor(nowMs / 1000 / TOTP_STEP));
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    if (hotp(secret, step + BigInt(i)) === code) return true;
  }
  return false;
}

// ─── Base32 (RFC 4648, no padding required by authenticator apps) ────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return output;
}
