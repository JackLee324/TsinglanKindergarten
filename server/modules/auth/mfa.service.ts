import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';

import {
  teachersTable,
  teacherMfa,
  mfaRecoveryCodes,
  mfaChallenges,
} from '@server/database/schema';
import { SUPER_ADMIN_ROLE, type RoleCode } from '@shared/rbac';
import {
  buildOtpAuthUri,
  decryptSecret,
  encryptSecret,
  generateChallengeToken,
  generateRecoveryCode,
  generateTotpSecret,
  hashChallengeToken,
  hashRecoveryCode,
  isMfaEncryptionConfigured,
  verifyTotp,
} from '@server/common/crypto/mfa-crypto';

/** How long a half-finished login stays valid. Short: it is an active credential. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** TOTP brute-force bound for a caller who already knows the password. */
const CHALLENGE_MAX_ATTEMPTS = 5;
/** One step of clock skew each way (±30 s at the default period). */
const TOTP_WINDOW = 1;
const RECOVERY_CODE_COUNT = 10;
const ISSUER = '清澜山幼儿园课程资源平台';

export interface MfaStatus {
  /** A secret exists but the user has not yet proved possession. */
  pending: boolean;
  /** Fully enrolled and required at every login. */
  enabled: boolean;
  enabledAt?: string;
  lastUsedAt?: string;
  recoveryCodesRemaining: number;
  /** true when the account's roles make MFA mandatory (super_admin). */
  required: boolean;
}

/**
 * MfaService — TOTP second factor and recovery codes.
 * ==================================================
 *
 * FLOW
 *   login(username, password)
 *     -> password verified
 *     -> if MFA enabled:  issue a short-lived challenge, return { mfaRequired: true, challengeToken }
 *        (NO session cookie is created at this point — a half-authenticated
 *         request must not be able to reach any API)
 *     -> POST /api/auth/mfa/verify  { challengeToken, code }
 *     -> challenge consumed, session created
 *
 * WHY THE CHALLENGE IS IN THE DATABASE
 *   Multi-instance deployments: a user who verifies their password on instance A
 *   and submits the TOTP to instance B would be rejected if the pending challenge
 *   lived in process memory. That produces an intermittent failure that is very
 *   hard to diagnose, and is exactly the class of bug the specification calls out
 *   for the in-memory rate limiter.
 *
 * SECURITY PROPERTIES
 *   * The TOTP secret is encrypted at rest (AES-256-GCM). A database dump does not
 *     allow code generation.
 *   * Only the SHA-256 of the challenge token is stored, like session ids.
 *   * Attempts are bounded per challenge, so knowing the password does not permit
 *     unlimited code guessing.
 *   * Recovery codes are stored hashed, single-use, and shown to the user ONCE.
 *   * Enrolment requires proving possession before MFA is switched on; merely
 *     generating a secret does not enable it (otherwise a failed enrolment could
 *     lock the user out).
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** Roles whose holders MUST use MFA. super_admin is the specification's requirement. */
  requiresMfa(roles: readonly RoleCode[]): boolean {
    return roles.includes(SUPER_ADMIN_ROLE);
  }

  /** Is the process able to perform MFA at all? Surfaced by the readiness probe. */
  isConfigured(): boolean {
    return isMfaEncryptionConfigured();
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  async getStatus(teacherId: string): Promise<MfaStatus> {
    const roles = await this.rolesOf(teacherId);
    const rows = await this.db
      .select()
      .from(teacherMfa)
      .where(eq(teacherMfa.teacherId, teacherId))
      .limit(1);

    const remaining = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mfaRecoveryCodes)
      .where(
        and(
          eq(mfaRecoveryCodes.teacherId, teacherId),
          isNull(mfaRecoveryCodes.usedAt),
        ),
      );

    const row = rows[0];
    return {
      pending: Boolean(row) && !row.confirmed,
      enabled: Boolean(row?.confirmed),
      enabledAt: row?.enabledAt ? new Date(row.enabledAt).toISOString() : undefined,
      lastUsedAt: row?.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : undefined,
      recoveryCodesRemaining: remaining[0]?.count ?? 0,
      required: this.requiresMfa(roles),
    };
  }

  private async rolesOf(teacherId: string): Promise<RoleCode[]> {
    const rows = await this.db
      .select({ roles: teachersTable.roles })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('账号不存在');
    return ((rows[0].roles ?? []) as RoleCode[]) ?? [];
  }

  /** True when this account has MFA fully enabled. */
  async isEnabled(teacherId: string): Promise<boolean> {
    const rows = await this.db
      .select({ confirmed: teacherMfa.confirmed })
      .from(teacherMfa)
      .where(eq(teacherMfa.teacherId, teacherId))
      .limit(1);
    return Boolean(rows[0]?.confirmed);
  }

  // ===========================================================================
  // Enrolment
  // ===========================================================================

  /**
   * Start enrolment: generate a secret and return the provisioning URI.
   *
   * The secret is stored ENCRYPTED and marked unconfirmed, so an abandoned
   * enrolment cannot lock the account out and is not treated as enabled.
   */
  async beginEnrollment(
    teacherId: string,
    accountName: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'MFA 未配置：缺少 MFA_ENCRYPTION_KEY，无法安全存储 TOTP 密钥',
      );
    }

    const existing = await this.db
      .select({ confirmed: teacherMfa.confirmed })
      .from(teacherMfa)
      .where(eq(teacherMfa.teacherId, teacherId))
      .limit(1);

    if (existing[0]?.confirmed) {
      throw new BadRequestException('该账号已启用 MFA，请先解除绑定再重新绑定');
    }

    const secret = generateTotpSecret();
    const encrypted = encryptSecret(secret);

    await this.db
      .insert(teacherMfa)
      .values({
        teacherId,
        secretEncrypted: encrypted,
        confirmed: false,
        enabledAt: null,
      })
      .onConflictDoUpdate({
        target: teacherMfa.teacherId,
        // Re-running enrolment replaces a pending secret but never touches a
        // confirmed one (guarded above).
        set: { secretEncrypted: encrypted, confirmed: false, enabledAt: null, updatedAt: new Date() },
      });

    // The plaintext secret is returned exactly once, to be rendered as a QR code.
    // It is never logged and never retrievable afterwards.
    return {
      secret,
      otpauthUri: buildOtpAuthUri({ secret, accountName, issuer: ISSUER }),
    };
  }

  /**
   * Finish enrolment by proving possession. Generates the recovery codes, which
   * are returned in plaintext ONCE and stored only as hashes.
   */
  async confirmEnrollment(
    teacherId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const rows = await this.db
      .select()
      .from(teacherMfa)
      .where(eq(teacherMfa.teacherId, teacherId))
      .limit(1);

    if (!rows[0]) throw new BadRequestException('尚未开始 MFA 绑定');
    if (rows[0].confirmed) throw new BadRequestException('MFA 已启用');

    const secret = decryptSecret(rows[0].secretEncrypted);
    const ok = verifyTotp(secret, code, {
      digits: rows[0].digits,
      periodSeconds: rows[0].periodSeconds,
      algorithm: rows[0].algorithm as 'SHA1' | 'SHA256' | 'SHA512',
      window: TOTP_WINDOW,
    });

    if (!ok) throw new BadRequestException('验证码不正确，请确认设备时间并重试');

    await this.db
      .update(teacherMfa)
      .set({ confirmed: true, enabledAt: new Date(), updatedAt: new Date() })
      .where(eq(teacherMfa.teacherId, teacherId));

    const recoveryCodes = await this.regenerateRecoveryCodes(teacherId);
    this.logger.log(`MFA enabled for teacher ${teacherId}`);
    return { recoveryCodes };
  }

  /** Replace all recovery codes. Previous codes stop working immediately. */
  async regenerateRecoveryCodes(teacherId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());

    await this.db.transaction(async (tx) => {
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.teacherId, teacherId));
      await tx.insert(mfaRecoveryCodes).values(
        codes.map((c) => ({ teacherId, codeHash: hashRecoveryCode(c) })),
      );
    });

    return codes;
  }

  /** Remove MFA entirely. The caller must enforce who is allowed to do this. */
  async disable(teacherId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.teacherId, teacherId));
      await tx.delete(teacherMfa).where(eq(teacherMfa.teacherId, teacherId));
      await tx.delete(mfaChallenges).where(eq(mfaChallenges.teacherId, teacherId));
    });
    this.logger.warn(`MFA disabled for teacher ${teacherId}`);
  }

  /** Guard used before disabling: a super_admin must not lose MFA. */
  async assertMayDisable(teacherId: string): Promise<void> {
    const roles = await this.rolesOf(teacherId);
    if (this.requiresMfa(roles)) {
      throw new ForbiddenException(
        '系统超级管理员必须保持 MFA 启用状态，无法解除绑定',
      );
    }
  }

  // ===========================================================================
  // Verification
  // ===========================================================================

  /**
   * Verify a TOTP code or a recovery code.
   * Returns which method succeeded so the caller can audit it precisely.
   */
  async verify(
    teacherId: string,
    code: string,
  ): Promise<{ ok: boolean; method: 'totp' | 'recovery' | 'none' }> {
    const rows = await this.db
      .select()
      .from(teacherMfa)
      .where(eq(teacherMfa.teacherId, teacherId))
      .limit(1);

    const row = rows[0];
    if (!row || !row.confirmed) return { ok: false, method: 'none' };

    const secret = decryptSecret(row.secretEncrypted);
    if (
      verifyTotp(secret, code, {
        digits: row.digits,
        periodSeconds: row.periodSeconds,
        algorithm: row.algorithm as 'SHA1' | 'SHA256' | 'SHA512',
        window: TOTP_WINDOW,
      })
    ) {
      await this.db
        .update(teacherMfa)
        .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(teacherMfa.teacherId, teacherId));
      return { ok: true, method: 'totp' };
    }

    // Recovery codes are longer and formatted differently, so a six-digit input
    // never reaches this path.
    const normalized = code.trim().toUpperCase();
    if (normalized.length > 8) {
      const hash = hashRecoveryCode(normalized);
      const consumed = await this.db
        .update(mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(mfaRecoveryCodes.teacherId, teacherId),
            eq(mfaRecoveryCodes.codeHash, hash),
            isNull(mfaRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: mfaRecoveryCodes.id });

      // Single-use: the UPDATE only matches when used_at IS NULL, so a replayed
      // code affects zero rows and is rejected.
      if (consumed.length > 0) return { ok: true, method: 'recovery' };
    }

    return { ok: false, method: 'none' };
  }

  // ===========================================================================
  // Login challenge
  // ===========================================================================

  /** Issue a short-lived challenge token after the password step succeeded. */
  async issueChallenge(
    teacherId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ challengeToken: string; expiresAt: string }> {
    const token = generateChallengeToken();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

    await this.db.insert(mfaChallenges).values({
      tokenHash: hashChallengeToken(token),
      teacherId,
      expiresAt,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    });

    // Opportunistic cleanup of expired rows, so the table does not grow forever
    // without needing a separate scheduled job.
    void this.db
      .delete(mfaChallenges)
      .where(lt(mfaChallenges.expiresAt, new Date()))
      .catch(() => undefined);

    return { challengeToken: token, expiresAt: expiresAt.toISOString() };
  }

  /** Resolve a challenge token to a teacher id, consuming it. */
  async consumeChallenge(token: string): Promise<string> {
    const hash = hashChallengeToken(token);
    const rows = await this.db
      .select()
      .from(mfaChallenges)
      .where(eq(mfaChallenges.tokenHash, hash))
      .limit(1);

    const row = rows[0];
    if (!row) throw new UnauthorizedException('验证请求无效或已过期，请重新登录');
    if (row.consumedAt) throw new UnauthorizedException('该验证请求已使用，请重新登录');
    if (new Date(row.expiresAt).getTime() < Date.now()) {
      throw new UnauthorizedException('验证已超时，请重新登录');
    }

    await this.db
      .update(mfaChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(mfaChallenges.id, row.id));

    return row.teacherId;
  }

  /**
   * Record a failed second-factor attempt and enforce the attempt bound.
   * Called when verification fails, so an attacker holding the password cannot
   * enumerate codes indefinitely.
   */
  async recordFailedAttempt(token: string): Promise<{ remaining: number }> {
    const hash = hashChallengeToken(token);
    const rows = await this.db
      .select({ id: mfaChallenges.id, attempts: mfaChallenges.attempts, max: mfaChallenges.maxAttempts })
      .from(mfaChallenges)
      .where(eq(mfaChallenges.tokenHash, hash))
      .limit(1);

    const row = rows[0];
    if (!row) return { remaining: 0 };

    const attempts = (row.attempts ?? 0) + 1;
    const exhausted = attempts >= (row.max ?? CHALLENGE_MAX_ATTEMPTS);

    await this.db
      .update(mfaChallenges)
      .set({
        attempts,
        // Consuming on exhaustion forces a fresh password login, which is the
        // behaviour a rate limit is supposed to produce.
        consumedAt: exhausted ? new Date() : null,
      })
      .where(eq(mfaChallenges.id, row.id));

    return { remaining: Math.max(0, (row.max ?? CHALLENGE_MAX_ATTEMPTS) - attempts) };
  }
}
