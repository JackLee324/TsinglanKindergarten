import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import express from 'express'
import cookieParser from 'cookie-parser'
import { DatabaseModule } from './db/database.module'
import { AuditModule } from './audit/audit.module'
import { AuthorizationModule } from './authz/authorization.module'
import { StorageModule } from './storage/storage.module'
import { AuthModule } from './auth/auth.module'
import { UsersModule } from './users/users.module'
import { DirectoriesModule } from './directories/directories.module'
import { ResourcesModule } from './resources/resources.module'
import { ReviewsModule } from './reviews/reviews.module'
import { HealthController } from './health.controller'
import { AuthzGuard } from './common/authz.guard'
import { AppExceptionFilter } from './common/exception-filter'

/**
 * V2 应用装配。
 *
 * 全局注册两样东西，顺序很重要：
 *   · `AuthzGuard`   —— 认证 + 授权 + CSRF（fail closed）
 *   · `AppExceptionFilter` —— 统一 `{statusCode, code, message}`
 *
 * 模块清单刻意短：与 V1 的 14 个模块 / 66 个接口相比，V2 只有
 * auth / users / directories / resources(+files) / reviews / audit / storage。
 */
@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    AuthorizationModule,
    StorageModule,
    AuthModule,
    UsersModule,
    DirectoriesModule,
    ResourcesModule,
    ReviewsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthzGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 上传端点收**原始字节**：签名 URL 的 PUT 直接写对象，
    // 不经过 JSON body 解析（这与 S3 的行为一致）。
    consumer
      .apply(express.raw({ type: '*/*', limit: '50mb' }))
      .forRoutes('api/storage/local')
    consumer.apply(cookieParser()).forRoutes('*')
  }
}
