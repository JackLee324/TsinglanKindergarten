import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionCode, EffectivePermissions } from '@shared/rbac';

/**
 * Route metadata keys read by PermissionGuard.
 * Kept in their own module so controllers never import the guard itself.
 */
export const REQUIRED_PERMISSIONS_KEY = 'authz:requiredPermissions';
export const SUPER_ADMIN_ONLY_KEY = 'authz:superAdminOnly';

/**
 * Declare the permission(s) required to reach a route.
 *
 *   @RequirePermission('account.create')
 *   @Post() create(@Body() dto: CreateTeacherDto) { ... }
 *
 * All listed permissions are required (AND). Use it on every endpoint that is
 * not explicitly public — an endpoint WITHOUT this decorator is reachable by any
 * authenticated account, which is almost never what you want for an admin area.
 *
 * The guard is the enforcement point; the database triggers from migration 0003
 * are the backstop for the most dangerous operations.
 */
export const RequirePermission = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Restrict a route to system super administrators specifically.
 *
 * This is stricter than `@RequirePermission('system.manage')`: it asserts the
 * ACCOUNT holds the super_admin role, which matters for operations that manage
 * super admins themselves (where permissions alone are not the right test).
 */
export const RequireSuperAdmin = () => SetMetadata(SUPER_ADMIN_ONLY_KEY, true);

/**
 * Inject the caller's EFFECTIVE permissions (resolved once per request by
 * AuthGuard) into a controller method.
 *
 * Use this when a handler needs to branch on capability — e.g. to include
 * "can I approve this row" in a list response — instead of re-deriving roles and
 * re-implementing the permission rules locally.
 *
 *   @Get('review/pending')
 *   @RequirePermission('review.view')
 *   pending(@CurrentAuthz() authz: EffectivePermissions) { ... }
 *
 * It is a CONVENIENCE, never a security boundary: the guard has already decided
 * whether the handler may run at all. Reading `authz` must not be used as a
 * substitute for `@RequirePermission` on the route.
 */
export const CurrentAuthz = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): EffectivePermissions => {
    const request = ctx.switchToHttp().getRequest();
    return request.authz as EffectivePermissions;
  },
);

/**
 * Marks a route as reachable by an account that is required to use MFA but has
 * not enrolled yet.
 *
 * WHY THIS IS NEEDED
 *   "super_admin must use MFA" is only half-enforced by refusing to disable it.
 *   The other half is that an un-enrolled super_admin must NOT be able to use the
 *   rest of the system while password-only — otherwise the requirement is
 *   satisfied in name only, and a stolen password still yields full access.
 *
 *   The routes that must stay reachable in that state are the ones needed to
 *   COMPLETE enrolment and to leave: /auth/me, /auth/mfa/*, /auth/logout and the
 *   health endpoints. Everything else returns 403 with an actionable message.
 *
 *   This is a decorator rather than a path allowlist so the exemption is visible
 *   at the route it applies to, and so a new endpoint is denied by default.
 */
export const MFA_EXEMPT_KEY = 'authz:mfaExempt';
export const MfaExempt = () => SetMetadata(MFA_EXEMPT_KEY, true);
