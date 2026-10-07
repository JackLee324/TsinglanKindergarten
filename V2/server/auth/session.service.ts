import { Inject, Injectable } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { loadConfig } from '../config'

/**
 * 会话。
 *
 * · cookie 里是 32 字节随机 token；数据库里只存它的 sha256。
 * · **变更密码、变更权限、停用账号、删账号**都会撤销该用户的全部会话，
 *   因此"权限改完立刻生效"不需要版本号（业主要求不要 permission version）。
 */
@Injectable()
export class SessionService {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  async create(userId: string, ip: string | null, userAgent: string | null): Promise<{
    token: string
    expiresAt: Date
  }> {
    const config = loadConfig()
    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000)
    await this.sql`
      INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at)
      VALUES (${userId}, ${tokenHash}, ${ip}, ${userAgent}, ${expiresAt})
    `
    return { token, expiresAt }
  }

  async revokeByToken(token: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex')
    await this.sql`
      UPDATE sessions SET revoked_at = now()
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    `
  }

  /**
   * 撤销某个用户的**全部**会话。权限/状态/密码变更后必须调用它 ——
   * 这是"即时生效"的唯一实现方式。
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.sql`
      UPDATE sessions SET revoked_at = now()
      WHERE user_id = ${userId} AND revoked_at IS NULL
      RETURNING id
    `
    return rows.length
  }

  async purgeExpired(): Promise<number> {
    const rows = await this.sql`
      DELETE FROM sessions WHERE expires_at < now() - interval '1 day' RETURNING id
    `
    return rows.length
  }
}
