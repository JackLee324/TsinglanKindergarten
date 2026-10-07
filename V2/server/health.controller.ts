import { Controller, Get, Inject } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from './db/database.module'
import { Public } from './common/decorators'

@Controller('api')
export class HealthController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Public()
  @Get('health')
  async health() {
    // `instanceId` 由测试夹具通过环境变量注入。
    // 它让测试能确认"回应我的是**我刚启动的那个进程**"，而不是端口上残留的旧进程 ——
    // 后者会让整套测试跑在旧代码上，既可能假绿也可能假红。
    return { status: 'ok', version: 'v2-stage2', instanceId: process.env.V2_INSTANCE_ID ?? null }
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
