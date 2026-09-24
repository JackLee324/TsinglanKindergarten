import {
  Injectable,
  Inject,
  Logger,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

import { SessionService } from './session.service';
import { MfaService } from './mfa.service';
import { teachersTable, auditLogs } from '@server/database/schema';
import type { AuthUser, AuditAction, RoleCode, ResetPasswordResponse } from '@shared/api.interface';

import { SEED_TEACHERS } from './seed-teachers';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 16;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
/**
 * Per-IP login rate limit.
 *
 * Configurable through the environment (the specification requires the thresholds
 * to be operable, not hard-coded). Defaults keep the previously-shipped behaviour.
 *
 * NOTE (known limitation, tracked in PRODUCTION_READINESS.md §D-12): this counter
 * lives in a per-process Map, so with more than one instance each replica enforces
 * its own budget and the effective limit is multiplied by the replica count. The
 * store is to be abstracted behind a replaceable RateLimitStore; until then this is
 * a brake, not a hard bound.
 *
 * The values are read once at module load; a change requires a restart.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const IP_RATE_LIMIT_WINDOW_MS = readPositiveInt('LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS', 60) * 1000;
const IP_RATE_LIMIT_MAX = readPositiveInt('LOGIN_IP_RATE_LIMIT_MAX', 30);

interface AuditLogInput {
  action: AuditAction;
  wecomUserId?: string;
  teacherId?: string;
  teacherName?: string;
  ipAddress?: string;
  userAgent?: string;
  detail?: string;
  success: boolean;
  errorMessage?: string;
  resourceId?: string;
  resourceTitle?: string;
  program?: string;
  subject?: string;
}

interface IpRateRecord {
  count: number;
  windowStart: number;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly ipRateMap = new Map<string, IpRateRecord>();

  constructor(
    private readonly sessionService: SessionService,
    private readonly mfaService: MfaService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async onModuleInit(): Promise<void> {
    // -------------------------------------------------------------------------
    // Seed failures MUST NOT be swallowed (project rule: never catch an error
    // and keep starting as if everything succeeded).
    // -------------------------------------------------------------------------
    // This used to be:
    //     try { await this.seedTeachers(); }
    //     catch (err) { this.logger.error(...) }
    // i.e. ANY seeding failure - including "every single insert failed" - was
    // logged and startup continued. Verified consequence on a database built
    // from the shipped `init.sql`: `teachers.wecom_user_id` was NOT NULL while
    // the seed never set it, so all 20 inserts raised 42703/23502, every one was
    // swallowed by the per-account catch below, and the process logged
    // "created=0, skipped=0" and reported itself healthy with ZERO usable
    // accounts. Operators saw a running platform and no way to log in.
    //
    // The policy now distinguishes three outcomes:
    //   * everything skipped  -> accounts already exist, nothing to do
    //   * partial failure     -> loud ERROR naming the accounts, but the system
    //                            is genuinely usable, so do not abort
    //   * TOTAL failure       -> nothing exists and nothing could be created;
    //                            throw so Nest aborts startup
    //                            (`abortOnError` is true outside development)
    // Rather than a silently healthy process with no accounts.
    let seedResult: {
      created: number;
      skipped: number;
      failed: number;
      failedUsernames: string[];
    };
    try {
      seedResult = await this.seedTeachers();
    } catch (err) {
      // Not even attemptable (e.g. the table is missing). Hard failure.
      this.logger.error(
        `Seed teachers failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    if (seedResult.failed > 0) {
      const detail = `${seedResult.failed} account(s) could not be seeded: ${seedResult.failedUsernames.join(', ')}`;
      if (seedResult.created === 0 && seedResult.skipped === 0) {
        // Total failure: no account exists and none could be created. Starting
        // anyway would present a login screen that cannot possibly succeed.
        throw new Error(
          `Teacher seeding failed completely (${detail}). Refusing to start with zero usable accounts. ` +
            'Check the database schema against the migrations (node scripts/migrate.mjs status) ' +
            'and re-run with the failures fixed.',
        );
      }
      this.logger.error(
        `Partial teacher seeding failure: ${detail}. The platform is usable, ` +
          'but those accounts will be missing until seeding succeeds.',
      );
    }

    setInterval(() => {
      void this.sessionService.cleanup();
    }, 60 * 60 * 1000);
  }

  private hashPassword(password: string, salt: string): string {
    const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('base64')}`;
  }

  hashPasswordWithRandomSalt(password: string): string {
    const salt = randomBytes(SALT_LEN).toString('base64');
    return this.hashPassword(password, salt);
  }

  private verifyPassword(password: string, hash: string): boolean {
    try {
      const parts = hash.split('$');
      if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
      const n = Number(parts[1]);
      const r = Number(parts[2]);
      const p = Number(parts[3]);
      const salt = parts[4];
      const stored = Buffer.from(parts[5], 'base64');
      const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: n, r, p });
      return timingSafeEqual(stored, derived);
    } catch {
      return false;
    }
  }

  private validatePasswordComplexity(password: string): string | null {
    if (password.length < 10) return '密码至少10位';
    if (!/[A-Z]/.test(password)) return '密码必须包含大写字母';
    if (!/[a-z]/.test(password)) return '密码必须包含小写字母';
    if (!/[0-9]/.test(password)) return '密码必须包含数字';
    return null;
  }

  private checkIpRateLimit(ip: string): boolean {
    const now = Date.now();
    const record = this.ipRateMap.get(ip);
    if (!record || now - record.windowStart > IP_RATE_LIMIT_WINDOW_MS) {
      this.ipRateMap.set(ip, { count: 1, windowStart: now });
      return true;
    }
    record.count += 1;
    if (record.count > IP_RATE_LIMIT_MAX) return false;
    return true;
  }

  generateTemporaryPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const buf = randomBytes(16);
    let result = '';
    for (let i = 0; i < 16; i += 1) {
      result += chars[buf[i] % chars.length];
    }
    return result;
  }

  static generateUsername(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12);
    const suffix = randomBytes(3).toString('hex').slice(0, 4);
    return base || `user_${suffix}`;
  }

  private rowToAuthUser(row: {
    id: string;
    wecomUserId: string | null;
    username: string | null;
    name: string;
    nameEn: string | null;
    roles: string[] | null;
    status: string;
    mustChangePassword: boolean;
  }): AuthUser {
    return {
      id: row.id,
      wecomUserId: row.wecomUserId ?? undefined,
      username: row.username ?? '',
      name: row.name,
      nameEn: row.nameEn ?? undefined,
      roles: (row.roles ?? []) as string[] as AuthUser['roles'],
      status: row.status as 'active' | 'inactive',
      mustChangePassword: row.mustChangePassword,
    };
  }

  private async seedTeachers(): Promise<{
    created: number;
    skipped: number;
    failed: number;
    failedUsernames: string[];
  }> {
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const failedUsernames: string[] = [];
    for (const seed of SEED_TEACHERS) {
      try {
        const existing = await this.db
          .select({ id: teachersTable.id, passwordHash: teachersTable.passwordHash })
          .from(teachersTable)
          .where(
            and(
              sql`lower(${teachersTable.username}) = ${seed.username.toLowerCase()}`,
              isNotNull(teachersTable.username),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          if (!existing[0].passwordHash) {
            await this.db
              .update(teachersTable)
              .set({ passwordHash: seed.passwordHash })
              .where(eq(teachersTable.id, existing[0].id));
            created += 1;
          } else {
            skipped += 1;
          }
          continue;
        }
        await this.db.insert(teachersTable).values({
          username: seed.username.toLowerCase(),
          passwordHash: seed.passwordHash,
          name: seed.name,
          nameEn: seed.nameEn,
          roles: seed.roles as unknown as string[],
          status: 'active',
        });
        created += 1;
      } catch (error: unknown) {
        // Counted, not discarded. The caller decides whether this is tolerable;
        // this function never decides that a failure did not happen.
        failed += 1;
        failedUsernames.push(seed.username);
        this.logger.error(
          `Failed to seed teacher ${seed.username}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.logger.log(
      `Seed teachers: created=${created}, skipped=${skipped}, failed=${failed}`,
    );
    return { created, skipped, failed, failedUsernames };
  }

  async login(
    username: string,
    password: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<
    | { mfaRequired: true; challengeToken: string; expiresAt: string }
    | { mfaRequired: false; sessionId: string; teacher: AuthUser }
  > {
    if (!this.checkIpRateLimit(ipAddress)) {
      throw new ForbiddenException('请求过于频繁，请稍后再试');
    }

    const normalized = username.trim().toLowerCase();
    const rows = await this.db
      .select({
        id: teachersTable.id,
        wecomUserId: teachersTable.wecomUserId,
        username: teachersTable.username,
        name: teachersTable.name,
        nameEn: teachersTable.nameEn,
        roles: teachersTable.roles,
        status: teachersTable.status,
        passwordHash: teachersTable.passwordHash,
        mustChangePassword: teachersTable.mustChangePassword,
        failedLoginAttempts: teachersTable.failedLoginAttempts,
        lockedUntil: teachersTable.lockedUntil,
        permissionsVersion: teachersTable.permissionsVersion,
      })
      .from(teachersTable)
      .where(sql`lower(${teachersTable.username}) = ${normalized}`)
      .limit(1);

    if (rows.length === 0) {
      await this.writeAuditLog({
        action: 'login_failed',
        ipAddress,
        userAgent,
        detail: `username not found: ${normalized}`,
        success: false,
        errorMessage: '用户名或密码错误',
      });
      throw new UnauthorizedException('用户名或密码错误');
    }

    const row = rows[0];
    const now = new Date();

    if (row.lockedUntil && row.lockedUntil > now) {
      await this.writeAuditLog({
        action: 'login_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'account locked',
        success: false,
        errorMessage: '账号已锁定，请稍后再试',
      });
      throw new ForbiddenException('账号已锁定，请稍后再试');
    }

    if (row.status !== 'active') {
      await this.writeAuditLog({
        action: 'login_denied',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'account inactive',
        success: false,
        errorMessage: '账号已停用',
      });
      throw new ForbiddenException('账号已停用');
    }

    if (!row.passwordHash) {
      await this.writeAuditLog({
        action: 'login_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'no password hash',
        success: false,
        errorMessage: '用户名或密码错误',
      });
      throw new UnauthorizedException('用户名或密码错误');
    }

    const valid = this.verifyPassword(password, row.passwordHash);
    if (!valid) {
      const newAttempts = (row.failedLoginAttempts ?? 0) + 1;
      const patch: Partial<typeof teachersTable.$inferInsert> = {
        failedLoginAttempts: newAttempts,
      };
      if (newAttempts >= MAX_FAILED_ATTEMPTS) {
        patch.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
      }
      await this.db.update(teachersTable).set(patch).where(eq(teachersTable.id, row.id));

      await this.writeAuditLog({
        action: 'login_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: `wrong password, attempts=${newAttempts}`,
        success: false,
        errorMessage:
          newAttempts >= MAX_FAILED_ATTEMPTS
            ? '密码错误次数过多，账号已锁定15分钟'
            : '用户名或密码错误',
      });
      throw new UnauthorizedException(
        newAttempts >= MAX_FAILED_ATTEMPTS
          ? '密码错误次数过多，账号已锁定15分钟'
          : '用户名或密码错误',
      );
    }

    await this.db
      .update(teachersTable)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      })
      .where(eq(teachersTable.id, row.id));

    const teacher = this.rowToAuthUser(row);

    // ---------------------------------------------------------------------
    // Second factor. The password is verified; if MFA is enabled the login is
    // NOT complete and NO session is created. Returning a session here would
    // make the second factor decorative, because a stolen password alone would
    // already yield a usable cookie.
    //
    // Availability note: if MFA is enabled but the process cannot decrypt the
    // secret (MFA_ENCRYPTION_KEY missing or rotated), we FAIL CLOSED and refuse
    // the login rather than silently downgrading a privileged account to
    // single-factor. The alternative — letting the user in — would be an
    // attacker-triggerable MFA bypass by simply causing a key misconfiguration.
    // ---------------------------------------------------------------------
    if (await this.mfaService.isEnabled(teacher.id)) {
      const { challengeToken, expiresAt } = await this.mfaService.issueChallenge(
        teacher.id,
        ipAddress,
        userAgent,
      );

      await this.writeAuditLog({
        action: 'mfa_challenge_issued',
        teacherId: teacher.id,
        teacherName: teacher.name,
        ipAddress,
        userAgent,
        success: true,
        detail: 'password verified; awaiting second factor',
      });

      this.logger.log(
        `Password verified for ${teacher.name} (${teacher.username}); MFA challenge issued`,
      );

      return { mfaRequired: true, challengeToken, expiresAt };
    }

    // Pin the account's current authorization version onto the session, so any
    // later role/permission/status change invalidates it (RBAC.md §8).
    const sessionId = await this.sessionService.createSession(
      teacher.id,
      ipAddress,
      userAgent,
      row.permissionsVersion ?? 1,
    );

    await this.writeAuditLog({
      action: 'login',
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress,
      userAgent,
      success: true,
    });

    this.logger.log(`Teacher logged in: ${teacher.name} (${teacher.username})`);

    return { mfaRequired: false, sessionId, teacher };
  }

  async changePassword(
    teacherId: string,
    currentPassword: string,
    newPassword: string,
    ipAddress: string,
    userAgent?: string,
    currentSessionId?: string,
  ): Promise<AuthUser> {
    const rows = await this.db
      .select({
        id: teachersTable.id,
        username: teachersTable.username,
        name: teachersTable.name,
        passwordHash: teachersTable.passwordHash,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (rows.length === 0) throw new NotFoundException('账号不存在');
    const row = rows[0];

    if (!row.passwordHash || !this.verifyPassword(currentPassword, row.passwordHash)) {
      await this.writeAuditLog({
        action: 'password_change_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'wrong current password',
        success: false,
        errorMessage: '当前密码错误',
      });
      throw new UnauthorizedException('当前密码错误');
    }

    const complexityError = this.validatePasswordComplexity(newPassword);
    if (complexityError) throw new BadRequestException(complexityError);

    if (this.verifyPassword(newPassword, row.passwordHash)) {
      throw new BadRequestException('新密码不能与当前密码相同');
    }

    const newHash = this.hashPasswordWithRandomSalt(newPassword);
    const updated = await this.db
      .update(teachersTable)
      .set({
        passwordHash: newHash,
        mustChangePassword: false,
        passwordUpdatedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(teachersTable.id, teacherId))
      .returning({
        id: teachersTable.id,
        wecomUserId: teachersTable.wecomUserId,
        username: teachersTable.username,
        name: teachersTable.name,
        nameEn: teachersTable.nameEn,
        roles: teachersTable.roles,
        status: teachersTable.status,
        mustChangePassword: teachersTable.mustChangePassword,
      });

    if (updated.length === 0) {
      await this.writeAuditLog({
        action: 'password_change_failed',
        teacherId: row.id,
        teacherName: row.name,
        ipAddress,
        userAgent,
        detail: 'update returned 0 rows',
        success: false,
        errorMessage: '密码修改失败，请稍后重试',
      });
      throw new BadRequestException('密码修改失败，请稍后重试');
    }

    await this.sessionService.revokeOtherSessions(teacherId, currentSessionId ?? null);

    await this.writeAuditLog({
      action: 'password_changed',
      teacherId: row.id,
      teacherName: row.name,
      ipAddress,
      userAgent,
      detail: 'self password change',
      success: true,
    });

    this.logger.log(`Password changed: ${row.username}`);
    return this.rowToAuthUser(updated[0]);
  }

  async resetPassword(
    operatorId: string,
    operatorName: string,
    teacherId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<ResetPasswordResponse> {
    const rows = await this.db
      .select({
        id: teachersTable.id,
        username: teachersTable.username,
        name: teachersTable.name,
        roles: teachersTable.roles,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (rows.length === 0) throw new NotFoundException('账号不存在');
    const row = rows[0];

    const tempPassword = this.generateTemporaryPassword();
    const hash = this.hashPasswordWithRandomSalt(tempPassword);

    const updated = await this.db
      .update(teachersTable)
      .set({
        passwordHash: hash,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
        passwordUpdatedAt: new Date(),
      })
      .where(eq(teachersTable.id, teacherId))
      .returning({ id: teachersTable.id });

    if (updated.length === 0) {
      throw new NotFoundException('账号不存在');
    }

    await this.sessionService.revokeOtherSessions(teacherId, null);

    await this.writeAuditLog({
      action: 'password_reset',
      teacherId: row.id,
      teacherName: row.name,
      ipAddress,
      userAgent,
      detail: `reset by ${operatorName} (${operatorId})`,
      success: true,
    });

    this.logger.log(`Password reset by admin for: ${row.username}`);

    return { temporaryPassword: tempPassword };
  }

  /**
   * Complete a login after a successful second-factor check.
   * Used by POST /api/auth/mfa/verify, which is @Public() because the caller has
   * no session yet — the challenge token is what authorises it.
   */
  async completeMfaLogin(
    teacherId: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<{ sessionId: string; teacher: AuthUser }> {
    const rows = await this.db
      .select({
        id: teachersTable.id,
        wecomUserId: teachersTable.wecomUserId,
        username: teachersTable.username,
        name: teachersTable.name,
        nameEn: teachersTable.nameEn,
        roles: teachersTable.roles,
        status: teachersTable.status,
        mustChangePassword: teachersTable.mustChangePassword,
        permissionsVersion: teachersTable.permissionsVersion,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (rows.length === 0) throw new UnauthorizedException('账号不存在');
    const row = rows[0];
    if (row.status !== 'active') throw new UnauthorizedException('账号已停用');

    const teacher = this.rowToAuthUser(row);
    const sessionId = await this.sessionService.createSession(
      teacher.id,
      ipAddress,
      userAgent,
      row.permissionsVersion ?? 1,
    );

    await this.writeAuditLog({
      action: 'mfa_success',
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress,
      userAgent,
      success: true,
    });
    await this.writeAuditLog({
      action: 'login',
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress,
      userAgent,
      success: true,
      detail: 'login completed after MFA',
    });

    this.logger.log(`Teacher logged in with MFA: ${teacher.name} (${teacher.username})`);
    return { sessionId, teacher };
  }

  /** Public wrapper so the MFA controller can write its own audit entries. */
  async auditMfa(
    action: 'mfa_failed' | 'mfa_enrolled' | 'mfa_enabled' | 'mfa_disabled'
      | 'mfa_reset' | 'mfa_recovery_used' | 'mfa_recovery_regenerated',
    input: { teacherId: string; teacherName?: string; ipAddress?: string; userAgent?: string; detail?: string },
  ): Promise<void> {
    await this.writeAuditLog({
      action,
      teacherId: input.teacherId,
      teacherName: input.teacherName,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      detail: input.detail,
      success: action !== 'mfa_failed',
    });
  }

  async logout(
    sessionId: string,
    teacher: AuthUser,
    ipAddress: string,
    userAgent?: string,
  ): Promise<void> {
    if (sessionId) {
      await this.sessionService.destroySession(sessionId);
    }
    await this.writeAuditLog({
      action: 'logout',
      teacherId: teacher.id,
      teacherName: teacher.name,
      ipAddress,
      userAgent,
      detail: 'User logged out',
      success: true,
    });
  }

  async getTeacherById(teacherId: string): Promise<AuthUser | null> {
    const rows = await this.db
      .select({
        id: teachersTable.id,
        wecomUserId: teachersTable.wecomUserId,
        username: teachersTable.username,
        name: teachersTable.name,
        nameEn: teachersTable.nameEn,
        roles: teachersTable.roles,
        status: teachersTable.status,
        mustChangePassword: teachersTable.mustChangePassword,
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.status !== 'active') return null;

    return this.rowToAuthUser(row);
  }

  async recordAuthFailure(
    sessionId: string | undefined,
    ipAddress: string,
    userAgent: string | undefined,
    action: 'session_expired' | 'login_denied',
    errorMessage: string,
  ): Promise<void> {
    await this.writeAuditLog({
      action,
      ipAddress,
      userAgent,
      detail: sessionId
        ? `session hash present but invalid/expired`
        : 'no session cookie present',
      success: false,
      errorMessage,
    });
  }

  getSessionCookieName(): string {
    return this.sessionService.getCookieName();
  }

  getCookieOptions(): ReturnType<SessionService['getCookieOptions']> {
    return this.sessionService.getCookieOptions();
  }

  getClearCookieOptions(): ReturnType<SessionService['getClearCookieOptions']> {
    return this.sessionService.getClearCookieOptions();
  }

  private async writeAuditLog(input: AuditLogInput): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        action: input.action,
        wecomUserId: input.wecomUserId,
        teacherId: input.teacherId,
        teacherName: input.teacherName,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        detail: input.detail,
        success: input.success,
        errorMessage: input.errorMessage,
        resourceId: input.resourceId,
        resourceTitle: input.resourceTitle,
        program: input.program,
        subject: input.subject,
      });
    } catch (error: unknown) {
      this.logger.error(
        `Failed to write audit log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
