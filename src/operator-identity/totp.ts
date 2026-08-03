import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/** RFC 4226/6238 defaults: 30 s step, 6 digits, HMAC-SHA1. */
const TIME_STEP_SECONDS = 30;
const DIGITS = 6;
/**
 * Tolerates up to one step of clock drift either side, which is the usual
 * RFC 6238 recommendation and is not a value the contract fixes — two
 * deployments choosing differently here does not break interoperability or
 * recovery classification the way U8/U9 would, so it is an implementation
 * default rather than a contract fact.
 */
const DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the encoding TOTP authenticator apps expect. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * The inverse of `base32Encode`, needed only by tests: an authenticator app
 * turns the displayed `EnrolmentResult.totpSecret` back into bytes to
 * generate codes, and a test stands in for that app rather than reaching
 * into the module's private secret.
 */
export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160 random bits — the RFC 4226 recommended TOTP secret length. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  const code = binCode % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

export function currentTotpCode(secret: Buffer, unixSeconds: number = Date.now() / 1000): string {
  return hotp(secret, Math.floor(unixSeconds / TIME_STEP_SECONDS));
}

/** Accepts a code from the current step or up to `DRIFT_STEPS` to either side. */
export function verifyTotpCode(secret: Buffer, code: string, unixSeconds: number = Date.now() / 1000): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(unixSeconds / TIME_STEP_SECONDS);
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    if (hotp(secret, counter + drift) === code) return true;
  }
  return false;
}

const SEAL_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * AES-256-GCM, per the 2026-08-04 decision recorded in `90-decisions.md`:
 * TOTP verification recomputes the HMAC on every login and needs the
 * secret's bytes back, so a one-way hash cannot stand in here the way it
 * does for a password. The key is supplied by the caller, read from the
 * credential mount rather than this module — sealing has no opinion on
 * where its key lives.
 */
export function sealTotpSecret(secret: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(SEAL_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function unsealTotpSecret(sealed: string, key: Buffer): Buffer | null {
  const parts = sealed.split('.');
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, ciphertextB64] = parts;
  try {
    const iv = Buffer.from(ivB64!, 'base64');
    const tag = Buffer.from(tagB64!, 'base64');
    const ciphertext = Buffer.from(ciphertextB64!, 'base64');
    const decipher = createDecipheriv(SEAL_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // A wrong key or a corrupted seal both fail GCM's tag check; neither is
    // distinguishable from here, and neither should be — both mean the
    // secret cannot be recovered.
    return null;
  }
}
