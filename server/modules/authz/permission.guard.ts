import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../auth/auth.guard';
import {
  REQUIRED_PERMISSIONS_KEY,
  SUPER_ADMIN_ONLY_KEY,
} from './permission.decorator';
import { AuthorizationService } from './authorization.service';
import { SUPER_ADMIN_ROLE, type EffectivePermissions, type PermissionCode } from '@shared/rbac';

interface AuthorizedRequest extends Request {
  teacher?: { id: string; roles: string[] };
  authz?: EffectivePermissions;
}

/**
 * PermissionGuard — global route-level authorization enforcement.
 * ============================================================
 *
 * Reads `@RequirePermission(...)` / `@RequireSuperAdmin()` metadata and rejects
 * the request with 403 when the caller's EFFECTIVE permissions do not cover it.
 *
 * ORDERING MATTERS
 *   This guard depends on `AuthGuard` having already run, because AuthGuard is
 *   what establishes `request.teacher` and `request.authz`. Both are registered
 *   as APP_GUARD **in AuthModule, in that order**, so ordering is deterministic
 *   rather than dependent on module-resolution order. If this guard ever ran
 *   first on a protected route, `request.teacher` would be undefined and a naive
 *   implementation would silently ALLOW the request — so instead it fails closed
 *   with 500 rather than skipping the check.
 *
 * WHY A GUARD AND NOT CHECKS INSIDE CONTROLLERS
 *   The previous code had 37 scattered `roles.includes(...)` calls across 7 files,
 *   and several controllers (notably ResourcesController) had none at all. A
 *   declarative decorator makes the requirement visible at the route, and the
 *   guard makes forgetting it fail closed at review/type level rather than at
 *   runtime under attack.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<PermissionCode[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const superAdminOnly = this.reflector.getAllAndOverride<boolean>(
      SUPER_ADMIN_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Nothing declared => authentication alone is sufficient for this route.
    if ((!required || required.length === 0) && !superAdminOnly) return true;

    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    if (!request.teacher) {
      // Fail closed, loudly. Reaching here means AuthGuard did not run first,
      // which is a wiring bug — never treat it as "no restriction needed".
      this.logger.error(
        `PermissionGuard ran before AuthGuard on ${request.method} ${request.url}; ` +
          'refusing the request instead of skipping the permission check.',
      );
      throw new UnauthorizedException('未登录');
    }

    const authz = request.authz;
    if (!authz) {
      this.logger.error(
        `AuthGuard did not attach effective permissions for ${request.method} ${request.url}`,
      );
      throw new UnauthorizedException('会话状态异常，请重新登录');
    }

    if (superAdminOnly && !authz.roles.includes(SUPER_ADMIN_ROLE)) {
      this.logger.warn(
        `Super-admin-only route denied: teacher=${authz.teacherId} url=${request.url}`,
      );
      throw new ForbiddenException('该操作仅系统超级管理员可执行');
    }

    for (const permission of required ?? []) {
      this.authz.require(authz, permission);
    }

    return true;
  }
}
