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
const IP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const IP_RATE_LIMIT_MAX = 30;

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
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedTeachers();
    } catch (err) {
      this.logger.error(`Seed teachers failed: ${JSON.stringify(err)}`);
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

  private async seedTeachers(): Promise<void> {
    let created = 0;
    let skipped = 0;
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
        this.logger.error(
          `Failed to seed teacher ${seed.username}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.logger.log(`Seed teachers: created=${created}, skipped=${skipped}`);
  }

  async login(
    username: string,
    password: string,
    ipAddress: string,
    userAgent?: string,
  ): Promise<{ sessionId: string; teacher: AuthUser }> {
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

    return { sessionId, teacher };
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
