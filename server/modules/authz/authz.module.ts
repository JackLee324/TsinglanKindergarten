import { Global, Module } from '@nestjs/common';

import { AuthorizationService } from './authorization.service';

/**
 * AuthzModule — the single authorization authority.
 *
 * Marked `@Global()` on purpose: authorization is a cross-cutting concern that
 * every feature module needs (teachers, resources, review, audit, dashboard …).
 * Making it global means a new module cannot accidentally be written without
 * access to the authorization service — which is exactly the mistake that left
 * several controllers unguarded before this change. Exporting it from AuthModule
 * and importing that everywhere would work too, but it re-creates the
 * "remember to wire it up" failure mode.
 *
 * It deliberately does NOT register PermissionGuard: AuthModule registers
 * AuthGuard **then** PermissionGuard as APP_GUARD in that order, so guard
 * evaluation order is deterministic rather than dependent on module resolution
 * order (see PermissionGuard's class comment).
 *
 * No dependency on AuthModule, so there is no circular import.
 */
@Global()
@Module({
  providers: [AuthorizationService],
  exports: [AuthorizationService],
})
export class AuthzModule {}
