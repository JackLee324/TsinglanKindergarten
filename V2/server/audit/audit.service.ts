import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import type { AuditAction, AuditResult } from '../../shared/audit-actions'
import { AUDIT_FORBIDDEN_DETAIL_KEYS } from '../../shared/audit-actions'

export interface AuditEntry {
  readonly actorId: string | null
  readonly actorName: string
  readonly action: AuditAction | string
  readonly targetType: 'user' | 'directory' | 'resource' | 'file' | 'session' | 'system'
  readonly targetId: string | null
  readonly result: AuditResult
  readonly detail?: Record<string, unknown>
  readonly ip?: string | null
}

/**
 * AuditService —— 审计写入与查询
 * ============================================================================
 * 两条硬规则：
 *
 * 1. **写审计永远不能让业务失败。** 审计是旁路：如果它抛错就把业务回滚，
 *    一个日志表的问题会变成"用户上传不了文件"。失败只记 logger.error。
 *
 * 2. **detail 里绝不允许出现凭据。** 这里在写入前做一次**运行时**剔除
 *    （`AUDIT_FORBIDDEN_DETAIL_KEYS`），并有一条测试盯着它 ——
 *    静态约定挡不住"某人顺手把整个 request body 塞进 detail"。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit')

  constructor(@Inject(SQL) private readonly sql: Sql) {}

  async write(entry: AuditEntry): Promise<void> {
    try {
      const detail = sanitize(entry.detail ?? {}) as Record<string, unknown>
      await this.sql`
        INSERT INTO audit_logs
          (actor_id, actor_name, action, target_type, target_id, result, detail, ip)
        VALUES
          (${entry.actorId}, ${entry.actorName}, ${entry.action}, ${entry.targetType},
           ${entry.targetId}, ${entry.result}, ${this.sql.json(detail as never)}, ${entry.ip ?? null})
      `
    } catch (error) {
      // 绝不因为审计失败而让业务失败。
      this.logger.error(`写审计失败：${(error as Error).message}`)
    }
  }

  /**
   * 审计查询（业主 Stage 8 §14）。
   *
   * 支持的筛选就是"查问题时真的会用到的那几个"：
   *   · 动作（谁改过密码？谁停用过目录？）
   *   · 谁做的（这位管理员上任以来都做了什么？）
   *   · 对哪个对象（这条资源/这个目录都经历过什么？）
   *   · 结果（只看被拒的）
   *   · 时间区间
   *
   * 不做统计聚合 —— 业主明确说"不要先做复杂统计"。
   */
  async query(options: {
    limit: number
    offset: number
    action?: string
    result?: string
    actorId?: string
    targetType?: string
    targetId?: string
    from?: string
    to?: string
  }): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const filter = {
      action: options.action ?? null,
      result: options.result ?? null,
      actorId: options.actorId ?? null,
      targetType: options.targetType ?? null,
      targetId: options.targetId ?? null,
      // 时间按**字符串**传进 SQL 再转 timestamptz：客户端的 HTML datetime-local
      // 给的是本地时间，由数据库按同一个会话时区解释，避免前端自己算出偏差。
      from: options.from ?? null,
      to: options.to ?? null,
    }
    const rows = await this.sql<
      {
        id: string
        actor_id: string | null
        actor_name: string
        action: string
        target_type: string
        target_id: string | null
        result: string
        detail: Record<string, unknown>
        ip: string | null
        created_at: Date
      }[]
    >`
      SELECT id::text, actor_id, actor_name, action, target_type, target_id, result, detail, ip, created_at
      FROM audit_logs
      WHERE (${filter.action}::text IS NULL OR action = ${filter.action}::text)
        AND (${filter.result}::text IS NULL OR result = ${filter.result}::text)
        AND (${filter.actorId}::uuid IS NULL OR actor_id = ${filter.actorId}::uuid)
        AND (${filter.targetType}::text IS NULL OR target_type = ${filter.targetType}::text)
        AND (${filter.targetId}::text IS NULL OR target_id = ${filter.targetId}::text)
        AND (${filter.from}::text IS NULL OR created_at >= ${filter.from}::timestamptz)
        AND (${filter.to}::text IS NULL OR created_at <= ${filter.to}::timestamptz)
      ORDER BY created_at DESC, id DESC
      LIMIT ${options.limit} OFFSET ${options.offset}
    `
    // 总数必须用**同一套筛选条件** —— 否则分页会显示"共 500 条"，而筛出来的只有 3 条。
    const totalRows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE (${filter.action}::text IS NULL OR action = ${filter.action}::text)
        AND (${filter.result}::text IS NULL OR result = ${filter.result}::text)
        AND (${filter.actorId}::uuid IS NULL OR actor_id = ${filter.actorId}::uuid)
        AND (${filter.targetType}::text IS NULL OR target_type = ${filter.targetType}::text)
        AND (${filter.targetId}::text IS NULL OR target_id = ${filter.targetId}::text)
        AND (${filter.from}::text IS NULL OR created_at >= ${filter.from}::timestamptz)
        AND (${filter.to}::text IS NULL OR created_at <= ${filter.to}::timestamptz)
    `
    return {
      items: rows.map((r) => ({
        id: r.id,
        actorId: r.actor_id,
        actorName: r.actor_name,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        result: r.result,
        detail: r.detail,
        ip: r.ip,
        createdAt: r.created_at.toISOString(),
      })),
      total: totalRows[0].n,
    }
  }
}

/** 递归剔除禁止出现的 key。大小写不敏感，并覆盖嵌套对象与数组。 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]'
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (AUDIT_FORBIDDEN_DETAIL_KEYS.some((bad) => bad.toLowerCase() === k.toLowerCase())) {
        out[k] = '[已剔除]'
        continue
      }
      out[k] = sanitize(v, depth + 1)
    }
    return out
  }
  return value
}
