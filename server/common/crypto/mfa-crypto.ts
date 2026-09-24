import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

/**
 * TOTP (RFC 6238) and secret-at-rest protection for MFA.
 * =====================================================
 *
 * Implemented on node:crypto rather than pulling a dependency: the algorithm is
 * short, fully specified, and a supply-chain addition is a poor trade for ~80
 * lines of standard code.
 *
 * TWO CRYPTOGRAPHIC RESPONSIBILITIES, deliberately kept apart:
 *
 *   1. TOTP — proving the user possesses the shared secret.
 *   2. Encryption of that secret at rest — making a database dump useless to an
 *      attacker who wants to generate valid codes.
 *
 * If (2) is skipped, (1) is worthless: the whole point of a second factor is that
 * the secret lives somewhere the attacker does not have. A plaintext `secret`
 * column in a leaked backup is a complete MFA bypass.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---------------------------------------------------------------------------
// base32 (RFC 4648, no padding) — the encoding authenticator apps expect
// ---------------------------------------------------------------------------

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
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, matching the RFC 4226 recommendation for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  algorithm?: TotpAlgorithm;
  /** Unix seconds; injectable so expiry/window logic is testable. */
  now?: number;
}

function hotp(secret: Buffer, counter: number, digits: number, algorithm: TotpAlgorithm): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter. Written as two 32-bit halves because JS bitwise
  // operators are 32-bit; using them on the low word alone would overflow.
  const high = Math.floor(counter / 2 ** 32);
  const low = counter >>> 0;
  buf.writeUInt32BE(high, 0);
  buf.writeUInt32BE(low, 4);

  const hmac = createHmac(algorithm.toLowerCase().replace('sha', 'sha'), secret);
  hmac.update(buf);
  const digest = hmac.digest();

  // Dynamic truncation (RFC 4226 §5.3)
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code for the current time step (used by tests and by tooling). */
export function generateTotp(secretBase32: string, options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const period = options.periodSeconds ?? 30;
  const algorithm = options.algorithm ?? 'SHA1';
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return hotp(base32Decode(secretBase32), Math.floor(now / period), digits, algorithm);
}

/**
 * Verify a submitted code.
 *
 * `window` allows ±N time steps to tolerate clock skew between the server and the
 * user's phone. One step (±30 s) is the common setting; larger windows multiply
 * the number of codes an attacker may replay, so it is deliberately kept small.
 */
export function verifyTotp(
  secretBase32: string,
  submitted: string,
  options: TotpOptions & { window?: number } = {},
): boolean {
  const digits = options.digits ?? 6;
  const period = options.periodSeconds ?? 30;
  const algorithm = options.algorithm ?? 'SHA1';
  const window = options.window ?? 1;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const candidate = submitted.replace(/\s+/g, '');
  if (!/^\d+$/.test(candidate) || candidate.length !== digits) return false;

  const counter = Math.floor(now / period);
  const secret = base32Decode(secretBase32);

  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secret, counter + offset, digits, algorithm);
    // Constant-time comparison: a length-dependent early return would leak which
    // prefix of the code was correct.
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * otpauth:// URI for provisioning. The client renders this as a QR code.
 *
 * `secret` is the plaintext base32 — this value is shown to the user ONCE during
 * enrolment and must never be logged.
 */
export function buildOtpAuthUri(params: {
  secret: string;
  accountName: string;
  issuer: string;
  digits?: number;
  periodSeconds?: number;
  algorithm?: TotpAlgorithm;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: params.algorithm ?? 'SHA1',
    digits: String(params.digits ?? 6),
    period: String(params.periodSeconds ?? 30),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Secret encryption at rest (AES-256-GCM)
// ---------------------------------------------------------------------------

const ENCRYPTION_VERSION = 'v1';
const KEY_ENV = 'MFA_ENCRYPTION_KEY';

/**
 * Resolve the encryption key.
 *
 * Fails CLOSED: without a key, enrolment must not proceed, because the only
 * alternatives are storing the secret in plaintext or generating a key that
 * changes on restart (which would silently invalidate every user's MFA). Both are
 * worse than refusing.
 */
function resolveKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `${KEY_ENV} is not set. MFA cannot encrypt TOTP secrets without it. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  // Accept base64 (preferred) or hex, and require 32 bytes for AES-256.
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `${KEY_ENV} must decode to exactly 32 bytes (AES-256); got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  return key;
}

/** Is MFA usable in this process at all? Reported by the readiness/health check. */
export function isMfaEncryptionConfigured(): boolean {
  try {
    resolveKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypt a TOTP secret. Returns "v1:<iv-b64>:<tag-b64>:<ciphertext-b64>". */
export function encryptSecret(plaintext: string): string {
  const key = resolveKey();
  const iv = randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Decrypt a stored secret. Throws if the ciphertext was tampered with. */
export function decryptSecret(stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) {
    throw new Error('unrecognised MFA secret format');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = resolveKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  // GCM authentication fails here if the row was modified, which is the point of
  // using an AEAD mode rather than plain CBC.
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Human-transcribable alphabet: no 0/O/1/I/L to avoid support calls. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A single recovery code, e.g. "K7QM-3XPT-9RWD-2HFB". */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  }
  return out;
}

/** Hash for storage and lookup. Codes are high-entropy, so a plain hash suffices. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/** Hash a challenge token for storage — same reasoning as session ids. */
export function hashChallengeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateChallengeToken(): string {
  return randomBytes(32).toString('hex');
}
