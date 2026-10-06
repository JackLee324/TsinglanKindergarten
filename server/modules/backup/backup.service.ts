import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/database/database.module';
import { rawPostgresClient } from '@server/database/rbac-write-context';

/**
 * BackupService — 逻辑导出（**不是** pg_dump）。
 * =============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * 生产库跑在平台内网，本机既连不到它、也没有 `pg_dump` 客户端
 * （嵌入式 PostgreSQL 只带 initdb / pg_ctl / postgres）。结果是：
 * **一个有真实数据的生产系统没有任何可恢复的备份。**
 *
 * 这个服务把"导出"搬到**能连到数据库的那一侧**——也就是应用自己。
 * 应用本来就能读这些表；这里只是把它们按可恢复的行格式一次性吐出来。
 *
 * 它**不是** pg_dump 的替代品，能力和边界都要说清楚：
 *   覆盖：public schema 下每一张普通表的**行数据**
 *   不覆盖：roles/授权、RLS 策略定义、索引、触发器、序列状态、表空间、WAL/PITR
 * 真正的灾难恢复仍然需要 pg_dump + pg_dumpall --roles-only，
 * 见 DISASTER_RECOVERY.md §3。本服务是**在拿到那条路之前**的兜底。
 *
 * OUTPUT FORMAT
 * -------------
 * NDJSON，与 `scripts/backup-rehearse.mjs` 的产物**同一格式**：
 *   {"kind":"header",...}
 *   {"kind":"table","table":…,"columns":[…],"rowCount":n}
 *   {"kind":"row","table":…,"row":{…}}
 *   {"kind":"footer","counts":{…},"checksums":{…}}
 * 于是本机那份**已经修好并验证过**的导入/校验机制可以直接消费它 ——
 * "导出成功"和"能恢复"是两件事，只有后者算数。
 *
 * SENSITIVITY（必须说清楚）
 * ------------------------
 * 导出里含 `sessions.session_hash`（是**哈希**，不是原始令牌）与
 * `teacher_mfa.*` 的**加密**密钥材料。它不含任何明文口令或明文 TOTP 密钥，
 * 但仍应视为敏感数据：落盘要 0600，不得进 Git、不得进日志。
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 应用运行在哪个库上 —— 只用于给备份产物做标注，不含连接串。 */
  /**
   * 导出必须跑在**裸 client**（不经过按请求的 `SET LOCAL ROLE 'anon_'` 前导）上。
   *
   * 为什么：`anon_` 在若干表上**没有 SELECT 策略** —— 例如 `sessions`。
   * 走请求默认路径时 `SELECT * FROM "sessions"` 会被 RLS 挡掉，drizzle 抛
   * "Failed query"，接口 500。实测就是这样炸的（本地与生产都复现）。
   *
   * 裸 client 上的语句是本应用里**唯一**不会被自动加上 `anon_` 前导的一类，
   * 于是它们以连接用户（表属主）身份执行；`force RLS = false` 时属主不受 RLS 约束。
   * 到期清理调度器一直就是这么跑的，所以它删得掉回收站的行 —— 同一套机制。
   *
   * 安全性不因此降低：这条路径只能由 `@RequireSuperAdmin()` 的路由进入，
   * 而 super_admin 本来就能读到全部业务数据。
   */
  private async withExportClient<T>(fn: (tx: { unsafe: (q: string) => Promise<unknown> }) => Promise<T>): Promise<T> {
    const client = rawPostgresClient(this.db);
    return client.begin(async (tx) => fn(tx as { unsafe: (q: string) => Promise<unknown> }));
  }

  private async databaseName(): Promise<string> {
    const rows = await this.withExportClient(
      async (tx) => (await tx.unsafe('SELECT current_database() AS name')) as unknown[],
    );
    return (rows[0] as { name?: string } | undefined)?.name ?? 'unknown';
  }

  private async tableNames(): Promise<string[]> {
    const rows = await this.withExportClient(
      async (tx) =>
        (await tx.unsafe(`
          SELECT c.relname AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          ORDER BY c.relname
        `)) as unknown[],
    );
    return rows.map((r) => (r as { name: string }).name);
  }

  /**
   * 全量逻辑导出。
   *
   * 逐表读、逐行写，**不把整个库拼成一个大字符串**：生产库现在只有几 MB，
   * 但"现在还小"不是设计依据 —— 一个 OOM 的备份接口会在最需要它的时候失败。
   */
  async exportLogicalDump(): Promise<{
    ndjson: string;
    tables: number;
    rows: number;
    database: string;
  }> {
    const database = await this.databaseName();
    const tables = await this.tableNames();
    const parts: string[] = [];
    const counts: Record<string, number> = {};
    let total = 0;

    parts.push(
      JSON.stringify({
        kind: 'header',
        tool: 'POST /api/admin/data-export',
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        sourceDatabase: database,
        note:
          '逻辑行导出，与 scripts/backup-rehearse.mjs 同格式。**不是** pg_dump 归档：' +
          '不含 roles/授权、RLS 策略定义、索引、触发器、序列状态、WAL/PITR。' +
          '含 sessions.session_hash（哈希，非原始令牌）与 teacher_mfa 的加密材料 —— 视为敏感数据。',
      }),
    );

    for (const table of tables) {
      // 表名来自**数据库自己的** pg_class（不是调用方输入），但标识符仍然要加引号 +
      // 白名单校验：拼 SQL 的地方一律假设输入是脏的。
      if (!/^[A-Za-z0-9_]+$/.test(table)) {
        throw new Error(`refusing to export table with unexpected name: ${table}`);
      }
      const list = await this.withExportClient(
        async (tx) => (await tx.unsafe(`SELECT * FROM "${table}"`)) as Array<Record<string, unknown>>,
      );
      counts[table] = list.length;
      total += list.length;
      parts.push(
        JSON.stringify({
          kind: 'table',
          table,
          columns: list.length > 0 ? Object.keys(list[0]) : [],
          rowCount: list.length,
        }),
      );
      for (const row of list) {
        parts.push(JSON.stringify({ kind: 'row', table, row }));
      }
    }

    parts.push(JSON.stringify({ kind: 'footer', counts }));

    this.logger.warn(
      `logical data export: ${tables.length} table(s), ${total} row(s) from ${database}`,
    );
    return { ndjson: parts.join('\n') + '\n', tables: tables.length, rows: total, database };
  }
}
