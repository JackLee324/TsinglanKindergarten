import { APP_FILTER } from '@nestjs/core';
import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { PlatformModule } from '@lark-apaas/fullstack-nestjs-core';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { CsrfCheckMiddleware } from './modules/auth/csrf-check.middleware';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { ViewModule } from './modules/view/view.module';
import { AuthModule } from './modules/auth/auth.module';
import { TeachersModule } from './modules/teachers/teachers.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { ReviewModule } from './modules/review/review.module';
import { AuditModule } from './modules/audit/audit.module';
import { CurriculumModule } from './modules/curriculum/curriculum.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // 平台 Module，提供平台能力
    PlatformModule.forRoot({ enableCsrf: false }),
    // ====== @route-section: business-modules START ======
    // Place all business modules here.Do NOT add fallback modules here.
    AuthModule,
    TeachersModule,
    ResourcesModule,
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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Request id first, for every route: it must be attached before anything can
    // fail, so the error filter and the logs can always correlate a request.
    // Applied to all routes rather than only /api/* so that an error while
    // rendering the SPA shell is traceable too.
    consumer.apply(RequestIdMiddleware).forRoutes('*');

    consumer.apply(CsrfCheckMiddleware).forRoutes(
      { path: 'api/*', method: RequestMethod.POST },
      { path: 'api/*', method: RequestMethod.PUT },
      { path: 'api/*', method: RequestMethod.PATCH },
      { path: 'api/*', method: RequestMethod.DELETE },
    );
  }
}
