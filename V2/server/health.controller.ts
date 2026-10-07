import { Controller, Get, Inject } from '@nestjs/common'
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

  /** 就绪检查：数据库真的能查。 */
  @Public()
  @Get('health/ready')
  async ready() {
    try {
      await this.sql`SELECT 1 AS ok`
      return { status: 'ready', database: 'ok' }
    } catch (error) {
      return { status: 'degraded', database: 'unreachable', detail: (error as Error).message }
    }
  }
}
