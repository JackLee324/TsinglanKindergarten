import {
  CanActivate,
  ExecutionContext,
  Injectable,
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
import { teachersTable } from '@server/database/schema';
import type { AuthUser } from '@shared/api.interface';

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
  cookies: Record<string, string>;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessionService: SessionService,
    private readonly authService: AuthService,
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

    const teacherId = await this.sessionService.getSession(sessionId);
    if (!teacherId) {
      throw new UnauthorizedException('会话已过期，请重新登录');
    }

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
      })
      .from(teachersTable)
      .where(eq(teachersTable.id, teacherId))
      .limit(1);

    if (teacherRows.length === 0) {
      throw new UnauthorizedException('账号不存在');
    }

    const row = teacherRows[0];

    if (row.status !== 'active') {
      throw new UnauthorizedException('账号已停用');
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

    // 续期会话最后访问时间
    void this.sessionService.touchSession(sessionId);

    return true;
  }
}
