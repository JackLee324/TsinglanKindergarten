import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { AuthGuard } from './auth.guard';
import { AuthzModule } from '../authz/authz.module';
import { PermissionGuard } from '../authz/permission.guard';

@Module({
  imports: [AuthzModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    // ORDER IS SIGNIFICANT. NestJS evaluates global guards in provider
    // registration order, so AuthGuard (authentication: establishes
    // request.teacher + request.authz) always runs before PermissionGuard
    // (authorization: enforces @RequirePermission). Registering them in
    // separate modules would make the order depend on module resolution, which
    // PermissionGuard would have to defend against at runtime.
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
  ],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
