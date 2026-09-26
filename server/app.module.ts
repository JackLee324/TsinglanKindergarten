import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { Module, NestModule, MiddlewareConsumer, RequestMethod, ValidationPipe } from '@nestjs/common';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { CsrfCheckMiddleware } from './modules/auth/csrf-check.middleware';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { DatabaseModule } from './database/database.module';
import { DatabaseRoleMiddleware } from './database/database-role.middleware';
import { ViewModule } from './modules/view/view.module';
import { AuthModule } from './modules/auth/auth.module';
import { TeachersModule } from './modules/teachers/teachers.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { FilesModule } from './modules/files/files.module';
import { ReviewModule } from './modules/review/review.module';
import { AuditModule } from './modules/audit/audit.module';
import { CurriculumModule } from './modules/curriculum/curriculum.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';

/**
 * The application module graph.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS NOT
 * ---------------------------------------
 * This file imported `PlatformModule` from `@lark-apaas/fullstack-nestjs-core`.
 * That one import pulled in, for every boot: a Kubernetes credential watcher, an
 * OpenTelemetry logger and trace pipeline, an MCP server, an HTTP forwarder, an
 * auth/authz SDK, a cache-service client, an HTML hot-update poller, a
 * platform-API view-context middleware (which performed an outbound HTTP request
 * on every page request), and — the load-bearing one — the `DRIZZLE_DATABASE`
 * provider plus the `SET LOCAL ROLE 'anon_'` SQL execution context.
 *
 * Each of those is now either deleted (nothing in this application used it) or
 * replaced by a file in this repository:
 *
 *   platform capability            | replacement
 *   -------------------------------|------------------------------------------
 *   DataPaasModule / DRIZZLE_DATABASE | server/database/database.module.ts
 *   SqlExecutionContextMiddleware  | server/database/database-role.middleware.ts
 *   CsrfTokenMiddleware +          | server/common/http/csrf-token.middleware.ts
 *     ViewContextMiddleware        |   (registered in main.ts)
 *   APP_PIPE ValidationPipe        | the APP_PIPE provider below
 *   APP_INTERCEPTOR TraceInterceptor | nothing — it logged every request AND
 *                                    response body, including the plaintext
 *                                    temporary password returned by
 *                                    POST /api/teachers and every login body.
 *                                    Removing it is the fix for a P0 finding in
 *                                    evidence/PLATFORM_DEPENDENCY_INVENTORY.md.
 *   ConfigModule/ObservableModule…  | nothing — no module in this application
 *                                    injects ConfigService, HttpService or
 *                                    CacheManager (verified by grep), so the
 *                                    platform's global exports had no consumers.
 *
 * TWO ENVIRONMENT VARIABLES NO LONGER NEEDED (both were platform-shaped):
 *   * `FORCE_AUTHN_INNERAPI_DOMAIN` — this file and `main.ts` used to invent
 *     `https://127.0.0.1:1` for it, because the platform's authn SDK refused to
 *     construct without a domain. Nothing reaches an inner API any more, so the
 *     variable is neither required nor read. See `main.ts` for the full note.
 *   * `SUDA_DATABASE_URL` is still ACCEPTED (the container entrypoint and
 *     `scripts/verify-e2e-deploy.sh` set it) but is no longer the only name that
 *     works; `server/database/database.module.ts` resolves the usual aliases.
 */

@Module({
  imports: [
    // The application's own database layer, global so the twelve services that
    // inject DRIZZLE_DATABASE keep working without touching their imports.
    DatabaseModule,
    // ====== @route-section: business-modules START ======
    // Place all business modules here.Do NOT add fallback modules here.
    AuthModule,
    TeachersModule,
    ResourcesModule,
    // FilesModule owns GET /api/files/download, which consumes the signed download
    // tokens minted by ResourcesService.getDownloadUrl(). It MUST be listed before
    // ViewModule, whose catch-all route would otherwise swallow the path.
    FilesModule,
    ReviewModule,
    AuditModule,
    CurriculumModule,
    DashboardModule,
    // HealthModule must be listed BEFORE ViewModule: ViewModule registers the
    // catch-all `@Get(['/', '*'])` route, and a catch-all placed earlier would
    // swallow /api/health and make the readiness probe silently return the SPA.
    HealthModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        // `whitelist: true` strips properties that no DTO decorator declares. The
        // platform's pipe did not do this, which is why the two options below are
        // kept alongside it rather than instead of it:
        //
        //   transform + enableImplicitConversion — the DTOs rely on the pipe to
        //   convert `?week=3` (always a string on the wire) into a number. Dropping
        //   either option turns every numeric query parameter into a validation
        //   failure, so they are part of the contract, not preferences.
        //
        // `whitelist` is the behavioural addition: an undeclared field in a request
        // body is dropped instead of flowing into `Object.assign`-style patch
        // builders. It is safe here only because every DTO in this application
        // declares every field its service reads — asserted by the HTTP suites,
        // which exercise the same payloads the UI sends.
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Request id first, for every route: it must be attached before anything can
    // fail, so the error filter and the logs can always correlate a request.
    // Applied to all routes rather than only /api/* so that an error while
    // rendering the SPA shell is traceable too.
    consumer.apply(RequestIdMiddleware).forRoutes('*');

    // Then the database role. This MUST wrap everything that can issue SQL, so it
    // is applied to all routes and placed before the guards/controllers that use
    // the injected connection: the AsyncLocalStorage value only reaches a query if
    // the query runs inside this `next()` call. See
    // server/database/request-database-role.ts for why the role matters.
    consumer.apply(DatabaseRoleMiddleware).forRoutes('*');

    consumer.apply(CsrfCheckMiddleware).forRoutes(
      { path: 'api/*', method: RequestMethod.POST },
      { path: 'api/*', method: RequestMethod.PUT },
      { path: 'api/*', method: RequestMethod.PATCH },
      { path: 'api/*', method: RequestMethod.DELETE },
    );
  }
}
