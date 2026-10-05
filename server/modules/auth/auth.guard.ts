import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
  Inject,
  createParamDecorator,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/database/database.module';
import type { Request } from 'express';

import { SessionService } from './session.service';
import { AuthService } from './auth.service';
import { AuthorizationService } from '../authz/authorization.service';
import { MfaService } from './mfa.service';
import { MFA_EXEMPT_KEY } from '../authz/permission.decorator';
import { teachersTable } from '@server/database/schema';
import type { AuthUser } from '@shared/api.interface';
import type { EffectivePermissions } from '@shared/rbac';

export const IS_PUBLIC_KEY = 'isPublic';

export const Public = (): ReturnType<typeof SetMetadata> =>
  SetMetadata(IS_PUBLIC_KEY, true);

export const CurrentTeacher = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.teacher as AuthUser;
  },
);

export const CurrentTeacherRoles = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser['roles'] => {
    const request = ctx.switchToHttp().getRequest();
    return (request.teacher?.roles as AuthUser['roles']) ?? [];
  },
);

/** 机器可读的拒绝码：调用方可以据此跳转到改密页，而不必匹配中文措辞。 */
export const PASSWORD_CHANGE_REQUIRED_CODE = 'PASSWORD_CHANGE_REQUIRED';
export const PASSWORD_CHANGE_REQUIRED_MESSAGE =
  '该账号使用的是临时密码，必须先在「修改密码」完成修改后才能使用其它功能。';

/**
 * 强制改密期间仍然放行的路径前缀。
 *
 * 这份白名单必须**刚好**够用：少一条会把用户锁死在改不了密码的状态；
 * 多一条就等于在临时密码状态下开了一个口子。所以它只包含
 * "读自己是谁 / 改密码 / 退出 / 两步验证登记" 这几件事。
 */
const PASSWORD_CHANGE_EXEMPT_PREFIXES = [
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/mfa/', // 登记/确认/恢复码：强制改密的人也需要先能绑定第二因素
  '/api/health',
];

function isPasswordChangeExempt(request: Request): boolean {
  const path = String(request.path ?? request.url ?? '');
  return PASSWORD_CHANGE_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export interface AuthRequest extends Request {
  teacher?: AuthUser;
  /**
   * Effective permissions for `teacher`, resolved once by AuthGuard and consumed
   * by PermissionGuard and services. Never trust a client-supplied version of this.
   */
  authz?: EffectivePermissions;
  cookies: Record<string, string>;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessionService: SessionService,
    private readonly authService: AuthService,
    private readonly authorization: AuthorizationService,
    private readonly mfaService: MfaService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const sessionId = request.cookies?.[this.sessionService.getCookieName()];

    if (!sessionId) {
      throw new UnauthorizedException('未登录');
    }

    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new UnauthorizedException('会话已过期，请重新登录');
    }
    const teacherId = session.teacherId;

    const teacherRows = await this.db
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

    if (teacherRows.length === 0) {
      throw new UnauthorizedException('账号不存在');
    }

    const row = teacherRows[0];

    // Deactivation takes effect on the very next request, not when the session
    // happens to expire. Status is also re-read on every request rather than
    // trusted from the cookie.
    if (row.status !== 'active') {
      await this.sessionService.destroySession(sessionId);
      throw new UnauthorizedException('账号已停用');
    }

    // INSTANT PERMISSION REVOCATION (RBAC.md §8).
    // migration 0003 bumps teachers.permissions_version on any role, status,
    // permission-override or scope change. A session carries the version it was
    // created under; a mismatch means the caller's authority changed since login,
    // so the session is destroyed and the user must authenticate again.
    const currentVersion = row.permissionsVersion ?? 1;
    if (session.permissionsVersion !== currentVersion) {
      this.logger.warn(
        `Session invalidated by permission change: teacher=${teacherId} ` +
          `sessionVersion=${session.permissionsVersion} currentVersion=${currentVersion}`,
      );
      await this.sessionService.destroySession(sessionId, 'permissions_changed');
      throw new UnauthorizedException('权限已变更，请重新登录');
    }

    const teacher: AuthUser = {
      id: row.id,
      wecomUserId: row.wecomUserId ?? undefined,
      username: row.username ?? '',
      name: row.name,
      nameEn: row.nameEn ?? undefined,
      roles: (row.roles ?? []) as AuthUser['roles'],
      status: row.status as 'active' | 'inactive',
      mustChangePassword: row.mustChangePassword,
    };

    // -------------------------------------------------------------------------
    // 强制改密（§13）—— 在**服务端**拦，而不是只在前端跳转
    // -------------------------------------------------------------------------
    //
    // `must_change_password` 一直被写进 AuthUser、也有接口会把它置为 true
    // （管理员重置密码时），但**没有任何地方据此拦截请求** —— 这一点在
    // scripts/provision-super-admin.mjs 里被明确记录过，那个脚本因此刻意不设置它，
    // 理由是"设了等于假装有强制改密"。那个判断是对的：只有前端跳转的强制改密，
    // 绕过前端直接调接口就失效了。
    //
    // 现在网关真的拦，flag 才成为一个有意义的承诺。放行的只有"改密本身所必需"的端点：
    // 否则用户会被彻底锁死 —— 连改密码的接口都进不去。
    if (row.mustChangePassword && !isPasswordChangeExempt(request)) {
      throw new ForbiddenException({
        code: PASSWORD_CHANGE_REQUIRED_CODE,
        message: PASSWORD_CHANGE_REQUIRED_MESSAGE,
      });
    }

    request.teacher = teacher;

    // Resolve the EFFECTIVE permission set once per request and attach it. Every
    // downstream authorization decision (PermissionGuard, services) reads this,
    // so there is exactly one computation and no chance of two code paths
    // disagreeing about what an account may do.
    request.authz = await this.authorization.getEffectivePermissions(teacherId);

    // ---------------------------------------------------------------------
    // MANDATORY MFA ENFORCEMENT (the second half of the requirement)
    // ---------------------------------------------------------------------
    // Refusing to let a super_admin DISABLE MFA is not enough on its own: an
    // account that was never enrolled would still be password-only. While a role
    // requires MFA and none is enrolled, every route except the enrolment flow
    // itself is refused, so the account cannot be used for anything else in the
    // meantime.
    //
    // Deny-by-default is deliberate: a NEW endpoint is restricted automatically,
    // whereas an allowlist of protected paths would silently leave it open.
    const mfaExempt = this.reflector.getAllAndOverride<boolean>(MFA_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!mfaExempt && this.mfaService.requiresMfa(teacher.roles as never)) {
      const mfaEnabled = await this.mfaService.isEnabled(teacherId);
      if (!mfaEnabled) {
        this.logger.warn(
          `Blocked request from an MFA-required account that has not enrolled: ` +
            `teacher=${teacherId} path=${request.method} ${request.url}`,
        );
        throw new ForbiddenException(
          '该账号角色强制要求 MFA，请先完成绑定后再使用系统',
        );
      }
    }

    // 续期会话最后访问时间
    void this.sessionService.touchSession(sessionId);

    return true;
  }
}
