import { Global, Module } from '@nestjs/common'
import postgres from 'postgres'
import { loadConfig } from '../config'

export const SQL = 'SQL_CLIENT'

/**
 * 数据库连接。
 *
 * WHY 直接用 postgres.js + 手写 SQL（而不是再加一层 ORM 的 schema 定义）：
 * 迁移文件（database/migrations/*.sql）已经是 schema 的**唯一**权威。
 * 再维护一份 TypeScript 的 schema 定义就等于给同一件事写两遍 ——
 * 两份一旦分叉，就是 V1 那种"多套真相"的老问题。
 * 手写 SQL 也让"这条查询到底做了什么"在代码里一眼可读。
 */
@Global()
@Module({
  providers: [
    {
      provide: SQL,
      useFactory: () => {
        const config = loadConfig()
        return postgres(config.databaseUrl, {
          max: Number(process.env.V2_DB_POOL_MAX ?? 10),
          onnotice: () => {},
        })
      },
    },
  ],
  exports: [SQL],
})
export class DatabaseModule {}
