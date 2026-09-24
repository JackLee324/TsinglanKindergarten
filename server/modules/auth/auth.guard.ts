import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
  Inject,
  createParamDecorator,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import { SessionService } from './session.service';
import { AuthService } from './auth.service';
import { AuthorizationService } from '../authz/authorization.service';
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

    request.teacher = teacher;

    // Resolve the EFFECTIVE permission set once per request and attach it. Every
    // downstream authorization decision (PermissionGuard, services) reads this,
    // so there is exactly one computation and no chance of two code paths
    // disagreeing about what an account may do.
    request.authz = await this.authorization.getEffectivePermissions(teacherId);

    // 续期会话最后访问时间
    void this.sessionService.touchSession(sessionId);

    return true;
  }
}
