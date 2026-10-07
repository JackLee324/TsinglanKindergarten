import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { AuditService } from '../audit/audit.service'
import { SessionService } from '../auth/session.service'
import { hashPassword } from '../auth/password'
import type { AuthUser } from '../common/auth-user'
import { AppError } from '../common/http-error'
import {
  PERMISSIONS,
  PERMISSION_CODES,
  isPermissionCode,
  isUserRole,
  type PermissionCode,
} from '../../shared/permissions'
import type { PermissionGrantDto } from './users.dto'

interface UserListRow {
  id: string
  username: string
  name: string
  name_en: string | null
  role: string
  status: string
  created_at: Date
  updated_at: Date
}

/**
 * UsersService —— 账号与授权。
 *
 * 这里**没有角色→权限映射表**，也没有 deny/override。
 * 一个账号能做什么，就是 `user_permissions` 里那几行，不多不少。
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async list(): Promise<Record<string, unknown>[]> {
    const rows = await this.sql<UserListRow[]>`
      SELECT id, username, name, name_en, role, status, created_at, updated_at
      FROM users ORDER BY role, name
    `
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      name: r.name,
      nameEn: r.name_en,
      role: r.role,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }))
  }

  async getById(id: string): Promise<Record<string, unknown>> {
    const rows = await this.sql<UserListRow[]>`
      SELECT id, username, name, name_en, role, status, created_at, updated_at
      FROM users WHERE id = ${id}
    `
    if (rows.length === 0) throw AppError.notFound('账号不存在')
    const r = rows[0]
    return {
      id: r.id,
      username: r.username,
      name: r.name,
      nameEn: r.name_en,
      role: r.role,
      status: r.status,
      permissions: await this.getPermissions(r.id),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }
  }

  async getPermissions(
    userId: string,
  ): Promise<{ permission: PermissionCode; directoryId: string | null; label: string }[]> {
    const rows = await this.sql<{ permission: string; directory_id: string | null }[]>`
      SELECT permission, directory_id FROM user_permissions
      WHERE user_id = ${userId} ORDER BY permission
    `
    return rows
      .filter((r) => isPermissionCode(r.permission))
      .map((r) => ({
        permission: r.permission as PermissionCode,
        directoryId: r.directory_id,
        label: PERMISSIONS[r.permission as PermissionCode].label,
      }))
  }

  async create(actor: AuthUser, input: {
    name: string
    nameEn?: string | null
    username: string
    password: string
    role: string
    permissions?: PermissionGrantDto[]
  }): Promise<{ id: string }> {
    if (!isUserRole(input.role)) throw AppError.forbidden('未知的身份', 'VALIDATION_FAILED')

    const dup = await this.sql<{ id: string }[]>`
      SELECT id FROM users WHERE lower(username) = lower(${input.username})
    `
    if (dup.length > 0) {
      throw AppError.conflict(`用户名「${input.username}」已存在`, 'CONFLICT')
    }

    const grants = await this.normalizeGrants(input.permissions ?? [])

    const created = await this.sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO users (username, name, name_en, password_hash, role)
        VALUES (${input.username}, ${input.name}, ${input.nameEn ?? null},
                ${hashPassword(input.password)}, ${input.role})
        RETURNING id
      `
      const userId = inserted[0].id
      for (const g of grants) {
        await tx`
          INSERT INTO user_permissions (user_id, permission, directory_id, created_by)
          VALUES (${userId}, ${g.permission}, ${g.directoryId}, ${actor.id})
        `
      }
      return { id: userId }
    })

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'user.create',
      targetType: 'user',
      targetId: created.id,
      result: 'success',
      detail: { username: input.username, role: input.role, permissionCount: grants.length },
    })
    return created
  }

  async update(actor: AuthUser, id: string, input: {
    name?: string
    nameEn?: string | null
    role?: string
    active?: boolean
    password?: string
  }): Promise<{ revokedSessions: number }> {
    const existing = await this.sql<{ id: string; name: string; role: string; status: string }[]>`
      SELECT id, name, role, status FROM users WHERE id = ${id}
    `
    if (existing.length === 0) throw AppError.notFound('账号不存在')
    const before = existing[0]

    if (input.role !== undefined && !isUserRole(input.role)) {
      throw AppError.forbidden('未知的身份', 'VALIDATION_FAILED')
    }

    const sets: string[] = []
    const values: unknown[] = []
    // 用显式的列名拼装，**不做**动态 key 插值 —— 唯一允许拼进 SQL 的是这里的字面量。
    const push = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (input.name !== undefined) push('name', input.name)
    if (input.nameEn !== undefined) push('name_en', input.nameEn)
    if (input.role !== undefined) push('role', input.role)
    if (input.active !== undefined) push('status', input.active ? 'active' : 'inactive')
    if (input.password !== undefined) push('password_hash', hashPassword(input.password))

    let revoked = 0
    if (sets.length > 0) {
      values.push(id)
      await this.sql.unsafe(
        `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
        values as never[],
      )

      // 身份、状态、口令任一变化 → 撤销该账号全部会话（即时生效，不需要版本号）。
      const mustRevoke =
        input.role !== undefined || input.active !== undefined || input.password !== undefined
      if (mustRevoke) revoked = await this.sessions.revokeAllForUser(id)

      // 停用账号走单独的审计动作，便于按动作筛选。
      const action = input.active === false ? 'user.disable' : 'user.update'
      await this.audit.write({
        actorId: actor.id,
        actorName: actor.name,
        action,
        targetType: 'user',
        targetId: id,
        result: 'success',
        detail: {
          changed: Object.keys(input).filter((k) => k !== 'password'),
          passwordChanged: input.password !== undefined,
          revokedSessions: revoked,
          before: { role: before.role, status: before.status, name: before.name },
        },
      })
    }
    return { revokedSessions: revoked }
  }

  /**
   * 整份替换某个账号的授权。
   *
   * 三条校验（全部在这里，而不是散落在界面）：
   *   1. 权限码必须是权限目录里真实存在的（拒绝幽灵权限）；
   *   2. 目录必须存在（否则会出现一条永远不生效的授权）；
   *   3. 全平台权限（user.manage / audit.view）不得带目录范围。
   *
   * 保存成功后**撤销该账号全部会话** —— 这就是"权限改完立刻生效"。
   */
  async setPermissions(
    actor: AuthUser,
    userId: string,
    input: PermissionGrantDto[],
  ): Promise<{ grants: number; revokedSessions: number }> {
    const exists = await this.sql<{ id: string }[]>`SELECT id FROM users WHERE id = ${userId}`
    if (exists.length === 0) throw AppError.notFound('账号不存在')

    const grants = await this.normalizeGrants(input)

    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM user_permissions WHERE user_id = ${userId}`
      for (const g of grants) {
        await tx`
          INSERT INTO user_permissions (user_id, permission, directory_id, created_by)
          VALUES (${userId}, ${g.permission}, ${g.directoryId}, ${actor.id})
        `
      }
    })

    const revoked = await this.sessions.revokeAllForUser(userId)

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'user.permissions.update',
      targetType: 'user',
      targetId: userId,
      result: 'success',
      detail: {
        grants: grants.map((g) => ({ permission: g.permission, directoryId: g.directoryId })),
        revokedSessions: revoked,
      },
    })

    return { grants: grants.length, revokedSessions: revoked }
  }

  /** 校验并去重授权条目。返回可以直接写库的形状。 */
  private async normalizeGrants(
    input: PermissionGrantDto[],
  ): Promise<{ permission: PermissionCode; directoryId: string | null }[]> {
    const directoryIds = new Set<string>()
    const out: { permission: PermissionCode; directoryId: string | null }[] = []
    const seen = new Set<string>()

    for (const item of input) {
      if (!isPermissionCode(item.permission)) {
        throw AppError.forbidden(`未知的权限：${item.permission}`, 'VALIDATION_FAILED')
      }
      const directoryId = item.directoryId ?? null

      if (PERMISSIONS[item.permission].scope === 'global' && directoryId !== null) {
        throw AppError.forbidden(
          `「${PERMISSIONS[item.permission].label}」是全平台权限，不能限定目录范围`,
          'VALIDATION_FAILED',
        )
      }
      if (directoryId !== null) directoryIds.add(directoryId)

      const key = `${item.permission}::${directoryId ?? 'ALL'}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ permission: item.permission, directoryId })
    }

    if (directoryIds.size > 0) {
      const ids = [...directoryIds]
      const found = await this.sql<{ id: string }[]>`
        SELECT id FROM directories WHERE id = ANY(${ids}::uuid[])
      `
      if (found.length !== ids.length) {
        const known = new Set(found.map((r) => r.id))
        const missing = ids.filter((id) => !known.has(id))
        throw AppError.forbidden(`开放范围里有不存在的目录：${missing.join(', ')}`, 'VALIDATION_FAILED')
      }
    }

    return out
  }

  /** 供测试与启动自检：数据库里是否有未知权限码。 */
  async findUnknownPermissionRows(): Promise<{ user_id: string; permission: string }[]> {
    const rows = await this.sql<{ user_id: string; permission: string }[]>`
      SELECT user_id, permission FROM user_permissions
    `
    return rows.filter(
      (r) => !(PERMISSION_CODES as readonly string[]).includes(r.permission),
    )
  }
}
