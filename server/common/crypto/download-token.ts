import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Expiring, caller-bound download tokens.
 * =======================================
 *
 * WHY THIS EXISTS
 * ---------------
 * `ResourcesService.getDownloadUrl()` used to answer with
 *
 *     /api/__platform__/storage/download?bucket=<bucket>&path=<path>
 *
 * which is (a) unauthenticated — anyone holding the string can fetch the file,
 * (b) non-expiring, and (c) a plain description of the object's location in the
 * bucket. A URL like that survives being pasted into a chat group, a browser
 * history, a proxy log or a support ticket, and it grants permanent access to a
 * private kindergarten curriculum file. Handing the *storage credentials*
 * (bucket + path) to the client is also wrong on its own: it discloses the
 * layout of the private bucket.
 *
 * The replacement is a capability that is bound to ONE resource AND ONE account
 * and dies quickly:
 *
 *     /api/files/download?token=<base64url(payload)>.<base64url(hmac-sha256)>
 *
 *   * bound to `resourceId` — a token for file A cannot be replayed for file B;
 *   * bound to `teacherId`  — a leaked URL is useless to any other account,
 *     because /api/files/download also requires an authenticated session whose
 *     teacher id must equal the token's;
 *   * `exp` makes the leak short-lived (default 300 s, hard maximum 3600 s);
 *   * `nonce` makes two tokens for the same resource+account different, so a
 *     token cannot be predicted or silently reused, and log correlation can tell
 *     two downloads apart.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is not encryption and not a session: the payload is readable by anyone
 * who holds the token (it is base64url, not a cipher). That is deliberate — the
 * payload contains no secret, only a resource id, a teacher id and an expiry,
 * and the HMAC is what makes it unforgeable. Do not put anything confidential in
 * `DownloadTokenPayload`.
 *
 * KEY HANDLING mirrors `mfa-crypto.ts` exactly: a dedicated environment variable
 * with an explicit "not configured" check, and a LOUD failure. There is no
 * hardcoded fallback and no silently generated key. A fallback key would be far
 * worse than refusing to serve: every deployment would share the same signing
 * secret (so tokens could be forged across tenants), and a per-process random
 * key would invalidate every issued link on restart while looking like it works.
 */

/** The environment variable holding the HMAC key. */
export const DOWNLOAD_TOKEN_SECRET_ENV = 'DOWNLOAD_TOKEN_SECRET';
/** Optional TTL override, in seconds. */
export const DOWNLOAD_TOKEN_TTL_ENV = 'DOWNLOAD_TOKEN_TTL_SECONDS';

/** Default validity of a download token: 5 minutes. */
export const DEFAULT_TTL_SECONDS = 300;
/**
 * Hard maximum. Clamped rather than rejected, so a misconfigured deployment
 * still gets a working (short) link instead of a broken download button — but it
 * can never mint a long-lived bearer URL.
 */
export const MAX_TTL_SECONDS = 3600;
/** Minimum HMAC key length. 32 bytes = 256 bits, matching the SHA-256 output size. */
export const MIN_SECRET_BYTES = 32;

export interface DownloadTokenPayload {
  /** resources.id the token authorises. */
  resourceId: string;
  /** teachers.id the token is bound to; the session must match. */
  teacherId: string;
  /** Unix seconds after which the token is refused. */
  exp: number;
  /** Random per-token value: makes tokens unique and correlatable in logs. */
  nonce: string;
}

export type DownloadTokenFailureReason = 'malformed' | 'bad_signature' | 'expired';

export type DownloadTokenVerification =
  | { ok: true; payload: DownloadTokenPayload }
  | { ok: false; reason: DownloadTokenFailureReason };

/**
 * Resolve the signing key.
 *
 * Fails CLOSED, exactly like `mfa-crypto.resolveKey()`: without a key the only
 * alternatives are a hardcoded secret (forgeable by anyone who reads the source)
 * or a per-process random key (every link breaks on restart). Both are worse
 * than refusing to issue a link, so this throws and the caller surfaces a 503.
 */
function resolveKey(): Buffer {
  const raw = process.env[DOWNLOAD_TOKEN_SECRET_ENV];
  if (!raw) {
    throw new Error(
      `${DOWNLOAD_TOKEN_SECRET_ENV} is not set. Download links cannot be signed without it. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  // Accept base64 (preferred) or hex, same as MFA_ENCRYPTION_KEY.
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length < MIN_SECRET_BYTES) {
    throw new Error(
      `${DOWNLOAD_TOKEN_SECRET_ENV} must decode to at least ${MIN_SECRET_BYTES} bytes (HMAC-SHA256); ` +
        `got ${key.length}. Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/**
 * Is download-token signing usable in this process at all?
 * Reported honestly (never guessed): callers must refuse to serve rather than
 * emit a URL they cannot sign.
 */
export function isDownloadTokenConfigured(): boolean {
  try {
    resolveKey();
    return true;
  } catch {
    return false;
  }
}

/** Human-readable reason the signing key is unusable, for logs and 503 bodies. */
export function downloadTokenConfigurationError(): string | null {
  try {
    resolveKey();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Effective TTL: env override, clamped to [1, MAX_TTL_SECONDS]. */
export function downloadTokenTtlSeconds(): number {
  const raw = process.env[DOWNLOAD_TOKEN_TTL_ENV];
  if (raw === undefined || raw === '') return DEFAULT_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Loud, not silent: a typo must not silently degrade to the default, because
    // the operator would believe their intended value took effect.
    throw new Error(
      `${DOWNLOAD_TOKEN_TTL_ENV} must be a positive number of seconds; got "${raw}"`,
    );
  }
  return Math.min(Math.floor(parsed), MAX_TTL_SECONDS);
}

function clampTtl(ttlSeconds: number | undefined): number {
  if (ttlSeconds === undefined) return downloadTokenTtlSeconds();
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`ttlSeconds must be a positive number; got ${String(ttlSeconds)}`);
  }
  return Math.min(Math.floor(ttlSeconds), MAX_TTL_SECONDS);
}

function signature(payloadB64: string, key: Buffer): string {
  return createHmac('sha256', key).update(payloadB64).digest('base64url');
}

function isPayload(value: unknown): value is DownloadTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.resourceId === 'string' &&
    p.resourceId.length > 0 &&
    typeof p.teacherId === 'string' &&
    p.teacherId.length > 0 &&
    typeof p.exp === 'number' &&
    Number.isFinite(p.exp) &&
    typeof p.nonce === 'string' &&
    p.nonce.length > 0
  );
}

/**
 * Mint a token. Returns `<base64url(payload)>.<base64url(hmac)>`.
 *
 * `now` is injectable so expiry logic is testable without sleeping.
 */
export function signDownloadToken(params: {
  resourceId: string;
  teacherId: string;
  ttlSeconds?: number;
  now?: number;
}): string {
  if (!params.resourceId) throw new Error('signDownloadToken: resourceId is required');
  if (!params.teacherId) throw new Error('signDownloadToken: teacherId is required');

  const key = resolveKey();
  const issuedAt = params.now ?? Math.floor(Date.now() / 1000);
  const payload: DownloadTokenPayload = {
    resourceId: params.resourceId,
    teacherId: params.teacherId,
    exp: issuedAt + clampTtl(params.ttlSeconds),
    nonce: randomBytes(16).toString('hex'),
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signature(body, key)}`;
}

/**
 * Verify a token.
 *
 * Order matters and is deliberate:
 *   1. shape check               -> `malformed`
 *   2. signature check           -> `bad_signature`
 *   3. payload parse + shape     -> `malformed`
 *   4. expiry check              -> `expired`
 *
 * The signature is checked BEFORE the payload is parsed or trusted, so a
 * tampered payload can never reach the expiry branch and be reported as merely
 * "expired" — an attacker who edits `exp` into the future gets `bad_signature`,
 * not a longer-lived link.
 */
export function verifyDownloadToken(
  token: string,
  options: { now?: number } = {},
): DownloadTokenVerification {
  // Throws (loudly) when the deployment has no key: that is an operator error,
  // not a client error, and must not be reported as a malformed token.
  const key = resolveKey();

  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };

  const [body, suppliedSignature] = parts;
  if (!body || !suppliedSignature) return { ok: false, reason: 'malformed' };
  // base64url alphabet only. Rejecting other characters keeps the signature
  // comparison in a single encoding and stops a `.` inside either half from
  // shifting the split.
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return { ok: false, reason: 'malformed' };
  if (!/^[A-Za-z0-9_-]+$/.test(suppliedSignature)) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(signature(body, key), 'utf8');
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  // timingSafeEqual THROWS on unequal lengths, so the length must be compared
  // first. Comparing lengths is not a meaningful timing leak here: the signature
  // length is public and fixed.
  if (expected.length !== supplied.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(expected, supplied)) return { ok: false, reason: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPayload(parsed)) return { ok: false, reason: 'malformed' };

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (parsed.exp <= now) return { ok: false, reason: 'expired' };

  return { ok: true, payload: parsed };
}
