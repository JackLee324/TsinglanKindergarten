import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common'
import type { Response } from 'express'
import type { Sql } from 'postgres'
import { SQL } from './db/database.module'
import { Public, RequirePermission } from './common/decorators'
import { StorageService } from './storage/storage.service'

@Controller('api')
export class HealthController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @Get('health')
  async health() {
    // `instanceId` 由测试夹具通过环境变量注入。
    // 它让测试能确认"回应我的是**我刚启动的那个进程**"，而不是端口上残留的旧进程 ——
    // 后者会让整套测试跑在旧代码上，既可能假绿也可能假红。
    return { status: 'ok', version: 'v2-stage2', instanceId: process.env.V2_INSTANCE_ID ?? null }
  }

  /**
   * 存储健康状况（业主 §39）。
   *
   * 只需要"配好了没有、连得上没有"这两个事实，**不需要也不允许**看到
   * bucket / access key / secret / endpoint 里的凭据 ——
   * 所以这里返回的是 `StorageHealth`，它本身就不含这些字段
   * （缺配置时只报**变量名**）。
   *
   * 权限：`audit.view`。
   *
   * 为什么是它：路由的权限声明**只有三种形状**（`@Public` / `@AuthenticatedOnly` /
   * `@RequirePermission`），没有"仅管理员"这一种，而业主 §34 又明确
   * **不许新增权限**。`audit.view` 是现有 12 个权限码里"运维/管理可见性"的那一个，
   * 管理员本来就有（ADMIN 在 AuthorizationService 里统一绕过）。
   * 引入一个 `RequireRole` 就等于在统一授权之外开了第二条判定路径 —— 阶段 2/3 都因此被拦下过。
   */
  @RequirePermission('audit.view')
  @Get('health/storage')
  async storageHealth() {
    return this.storage.health()
  }

  /**
   * 就绪检查：数据库真的能查。
   *
   * ⚠️ 这里**必须**用 503 表达"不可接流量"，不能用 200 + body 说 degraded。
   * 原因很具体：负载均衡 / Render 健康检查 / K8s readinessProbe 这类探针
   * **只看状态码**，不会解析 body。之前这个分支返回 200 + `{status:'degraded'}`，
   * 于是数据库挂了、应用照样被判定"就绪"，流量被送进一个查不了库的实例。
   * 这是"运行就绪性"级别的缺陷，不是文案问题。
   *
   * 为什么用 `@Res({passthrough:true})` 而不是抛 `ServiceUnavailableException`：
   * 全局 `AppExceptionFilter` 会把 HttpException 的 body 重写成
   * `{statusCode, code, message}`，`database` 这类**探针要读的字段会被丢掉**。
   * 这里自己设状态码 + 返回结构化 body，既保住 503 语义，也保住字段可断言性。
   */
  @Public()
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    try {
      await this.sql`SELECT 1 AS ok`
      return { status: 'ready', database: 'ok' }
    } catch (error) {
      // 非生产环境才带 detail（可能含 SQL 片段/主机名）；生产只给状态，避免内部信息外泄。
      const detail =
        process.env.NODE_ENV === 'production' ? undefined : (error as Error).message
      res.status(HttpStatus.SERVICE_UNAVAILABLE)
      return { status: 'unavailable', database: 'unreachable', detail }
    }
  }
}
