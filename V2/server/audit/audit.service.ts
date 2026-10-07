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

  async query(options: {
    limit: number
    offset: number
    action?: string
    result?: string
    actorId?: string
  }): Promise<{ items: Record<string, unknown>[]; total: number }> {
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
      WHERE (${options.action ?? null}::text IS NULL OR action = ${options.action ?? null})
        AND (${options.result ?? null}::text IS NULL OR result = ${options.result ?? null})
        AND (${options.actorId ?? null}::uuid IS NULL OR actor_id = ${options.actorId ?? null}::uuid)
      ORDER BY created_at DESC, id DESC
      LIMIT ${options.limit} OFFSET ${options.offset}
    `
    const totalRows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE (${options.action ?? null}::text IS NULL OR action = ${options.action ?? null})
        AND (${options.result ?? null}::text IS NULL OR result = ${options.result ?? null})
        AND (${options.actorId ?? null}::uuid IS NULL OR actor_id = ${options.actorId ?? null}::uuid)
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
