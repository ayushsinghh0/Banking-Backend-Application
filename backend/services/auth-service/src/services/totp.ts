import crypto from 'crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30-second steps, 6 digits) — compatible with Google Authenticator,
 * Microsoft Authenticator, 1Password, Authy, etc.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
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

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit secret, as recommended by RFC 4226 */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

export function totpAt(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

/**
 * Returns the matching time step (allowing ±1 step of clock drift), or null.
 * Comparison is constant-time. The caller must reject steps <= the last accepted one (replay).
 */
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  let matched: number | null = null;
  for (const candidate of [step - 1, step, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secretBase32, candidate)), Buffer.from(code))) {
      matched = candidate;
    }
  }
  return matched;
}

export function otpauthUri(secretBase32: string, accountEmail: string, issuer = 'BankSphere'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/**
 * AES-256-GCM envelope for TOTP secrets at rest. Key: MFA_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 * Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>; the user id is bound as AAD so a
 * ciphertext copied onto another user's row won't decrypt.
 */
function encryptionKey(): Buffer {
  const hex = process.env.MFA_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('MFA_ENCRYPTION_KEY must be 64 hex characters (32 random bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function assertMfaEncryptionConfigured(): void {
  encryptionKey();
}

export function encryptSecret(plaintext: string, userId: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(envelope: string, userId: string): string {
  const [version, iv, tag, ct] = envelope.split('.');
  if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported MFA secret envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
