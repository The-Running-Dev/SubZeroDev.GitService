import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEY_LENGTH = 32;
const SALT_BYTES = 16;

/**
 * A password and a recovery code are both single hashed secrets in this
 * module's schema (`operator_credential.password_hash`,
 * `operator_recovery_code.code_hash`), so one scrypt-backed hash/verify pair
 * serves both rather than two near-identical implementations. No new
 * dependency: `node:crypto`'s `scrypt` is what the TOTP-sealing decision
 * already committed to using for secrets this module owns.
 */
export function hashSecret(secret: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(secret, salt, SCRYPT_KEY_LENGTH);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [algorithm, saltHex, hashHex] = parts;
  if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(secret, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
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
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10; // 80 bits, 16 base32 characters

/** Ten single-use recovery codes, grouped for readability: `XXXX-XXXX-XXXX-XXXX`. */
export function generateRecoveryCodes(): readonly string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES));
    codes.push(raw.match(/.{1,4}/g)!.join('-'));
  }
  return codes;
}

/** Strips formatting and normalises case before a code is hashed or compared. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return hashSecret(code);
}

export function verifyRecoveryCode(code: string, stored: string): boolean {
  return verifySecret(code, stored);
}
