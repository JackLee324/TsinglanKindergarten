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
    return { status: 'ok', version: 'v2-stage2' }
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
