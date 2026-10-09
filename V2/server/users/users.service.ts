import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { AuditService } from '../audit/audit.service'
import { SessionService } from '../auth/session.service'
import { hashPassword } from '../auth/password'
import type { AuthUser } from '../common/auth-user'
import { AppError } from '../common/http-error'
import { AuthorizationService } from '../authz/authorization.service'
import {
  PERMISSIONS,
  PERMISSION_CODES,
  TEACHER_ROLE,
  isGrantable,
  isPermissionCode,
  isUserRole,
  type PermissionCode,
} from '../../shared/permissions'
import type { PermissionGrantDto } from './users.dto'
import { computeTotalPages, DEFAULT_PAGE_SIZE } from '../../shared/resource-query'

/** LIKE 通配符转义（与资源搜索同一套做法：`%` 与 `_` 在用户输入里只是普通字符）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * `users_username_key`（`lower(username)` 唯一索引）被违反时的错误码。
 *
 * 为什么要有它：服务层已经先查一次重名，但**并发下那句 SELECT 挡不住** ——
 * 两个请求可以同时查到"没有重名"。真正的保证是数据库那条唯一索引，
 * 所以这里必须把 23505 翻译成可读的 409，而不是漏成 500。
 */
const UNIQUE_VIOLATION = '23505'
function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const code = (error as { code?: string } | null)?.code
  if (code !== UNIQUE_VIOLATION) return false
  if (constraint === undefined) return true
  return String((error as { constraint_name?: string }).constraint_name ?? '').includes(constraint)
}

export { DEFAULT_PAGE_SIZE }

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
    // 授权域的规则（"系统至少留一个管理员"、角色判断）都在 AuthorizationService 里，
    // 这里只负责调用 —— 本文件不再出现任何 ADMIN 字面量。
    private readonly authz: AuthorizationService,
  ) {}

  /**
   * 教师账号列表（业主 Stage 8 §2 / §28 / §29）。
   *
   * 三件事一次做对：
   *   · **服务端搜索 + 分页**：老师一多，一次读全部就会变成"打开页面卡一下，
   *     而且某天开始只显示前 N 条"。搜索覆盖姓名与用户名。
   *   · **最后登录时间**：从 `sessions` 里取该用户最早的会话？不是 —— 取**最新**一条
   *     会话的创建时间。不新增 `last_login_at` 列：会话表里已经有这个事实，
   *     再加一列就等于同一件事有两个真相，而且必然有一天对不上。
   *   · **权限摘要**：业主 §29 要求"查看 3 个目录 / 上传 1 个目录"这种可读的说法，
   *     而不是把内部权限码摆出来。这里按权限聚合目录数，标签来自共享定义。
   */
  async list(actor: AuthUser, options: {
    q?: string | null
    role?: string | null
    status?: string | null
    page: number
    pageSize: number
  }): Promise<{
    items: Record<string, unknown>[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }> {
    this.authz.assertSuperAdmin(actor)
    const pattern = options.q && options.q.trim() !== '' ? `%${escapeLike(options.q.trim())}%` : null
    const role = options.role ?? null
    const status = options.status ?? null

    const rows = await this.sql<
      (UserListRow & {
        last_login_at: Date | null
        permission_count: number
        directory_count: number
        total: number
      })[]
    >`
      WITH matched AS (
        SELECT u.*
        FROM users u
        WHERE (${pattern}::text IS NULL
               OR u.name ILIKE ${pattern} ESCAPE '\\'
               OR u.username ILIKE ${pattern} ESCAPE '\\')
          AND (${role}::text IS NULL OR u.role = ${role}::text)
          AND (${status}::text IS NULL OR u.status = ${status}::text)
      )
      SELECT m.id, m.username, m.name, m.name_en, m.role, m.status, m.created_at, m.updated_at,
             -- 最后登录：会话表里的事实（不新增一列，避免两个真相）
             (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = m.id) AS last_login_at,
             (SELECT count(*)::int FROM user_permissions p WHERE p.user_id = m.id) AS permission_count,
             (SELECT count(DISTINCT p.directory_id)::int
                FROM user_permissions p
               WHERE p.user_id = m.id AND p.directory_id IS NOT NULL) AS directory_count,
             (SELECT count(*)::int FROM matched) AS total
      FROM matched m
      ORDER BY m.role ASC, m.name ASC, m.id ASC
      LIMIT ${options.pageSize} OFFSET ${(options.page - 1) * options.pageSize}
    `

    const total = rows.length > 0 ? Number(rows[0].total) : await this.countUsers({ pattern, role, status })
    // 权限摘要（§29）：按权限码分组数目录，标签用共享定义里的中文。
    const summaries = await this.permissionSummaryOf(rows.map((r) => r.id))
    const items = rows.map((r) => ({
      id: r.id,
      username: r.username,
      name: r.name,
      nameEn: r.name_en,
      role: r.role,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      lastLoginAt: r.last_login_at?.toISOString() ?? null,
      permissionCount: r.permission_count,
      directoryCount: r.directory_count,
      permissionSummary: summaries.get(r.id) ?? [],
      // 展示用（列表上的「管理员」标签）。判定不在这里 ——
      // 角色比较收在 AuthorizationService，本文件不写 ADMIN 字面量。
      isAdmin: this.authz.isAdminRole(r.role),
    }))

    return {
      items,
      total,
      page: options.page,
      pageSize: options.pageSize,
      totalPages: computeTotalPages(total, options.pageSize),
    }
  }

  private async countUsers(filter: {
    pattern: string | null
    role: string | null
    status: string | null
  }): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users u
      WHERE (${filter.pattern}::text IS NULL
             OR u.name ILIKE ${filter.pattern} ESCAPE '\\'
             OR u.username ILIKE ${filter.pattern} ESCAPE '\\')
        AND (${filter.role}::text IS NULL OR u.role = ${filter.role}::text)
        AND (${filter.status}::text IS NULL OR u.status = ${filter.status}::text)
    `
    return rows[0]?.n ?? 0
  }

  /**
   * 按用户聚合"每个权限开放了几个目录"。
   *
   * 一次查完（而不是每人一次）：列表一页 20 个人，逐个查就是 20 次往返。
   * `directory_id IS NULL` 表示全平台 —— 那种情况在界面上说的是"全部目录"，
   * 这里用一个单独的计数表达，不混进目录计数里。
   */
  private async permissionSummaryOf(
    userIds: readonly string[],
  ): Promise<Map<string, { permission: string; label: string; directoryCount: number; global: boolean }[]>> {
    const out = new Map<
      string,
      { permission: string; label: string; directoryCount: number; global: boolean }[]
    >()
    if (userIds.length === 0) return out

    const rows = await this.sql<
      { user_id: string; permission: string; directory_count: number; global_count: number }[]
    >`
      SELECT p.user_id::text AS user_id, p.permission,
             count(DISTINCT p.directory_id)::int AS directory_count,
             count(*) FILTER (WHERE p.directory_id IS NULL)::int AS global_count
      FROM user_permissions p
      WHERE p.user_id = ANY(${userIds}::uuid[])
      GROUP BY p.user_id, p.permission
      ORDER BY p.permission
    `
    for (const row of rows) {
      const list = out.get(row.user_id) ?? []
      list.push({
        permission: row.permission,
        // 标签来自共享定义（界面不自己维护一份 permission → 中文 的映射）
        label: PERMISSIONS[row.permission as PermissionCode]?.label ?? row.permission,
        directoryCount: row.directory_count,
        global: row.global_count > 0,
      })
      out.set(row.user_id, list)
    }
    return out
  }

  async getById(actor: AuthUser, id: string): Promise<Record<string, unknown>> {
    this.authz.assertSuperAdmin(actor)
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
      permissions: await this.getPermissionsRaw(r.id),
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }
  }

  async getPermissions(
    actor: AuthUser,
    userId: string,
  ): Promise<{ permission: PermissionCode; directoryId: string | null; label: string }[]> {
    this.authz.assertSuperAdmin(actor)
    return this.getPermissionsRaw(userId)
  }

  /** 不做身份校验的读取（仅供本类内部：getById 已经先校验过一次）。 */
  private async getPermissionsRaw(
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
    active?: boolean
    permissions?: PermissionGrantDto[]
  }): Promise<{ id: string; username: string; active: boolean }> {
    // 门槛一：只有超级管理员能建账号（权限码之外的身份门槛，见 AuthorizationService）。
    this.authz.assertSuperAdmin(actor)
    if (!isUserRole(input.role)) throw AppError.forbidden('未知的身份', 'VALIDATION_FAILED')

    /*
      门槛二：**这个接口只创建教师账号**（业主 Stage 13 §5）。
      要新增管理员是一个需要被单独看见的动作，不应该混在"新增教师"里顺手完成；
      因此这里直接拒绝，而不是"悄悄降级成 TEACHER"——后者会让人以为建出了管理员。
      第一个管理员由 `scripts/bootstrap-admin.mjs` 用显式凭据创建；
      之后再要加管理员，用编辑接口改身份（同样只有超级管理员能做，且会写审计 + 撤销会话）。
    */
    if (input.role !== TEACHER_ROLE) {
      throw AppError.badRequest(
        '新增接口只能创建教师账号。要新增管理员，请先用本接口创建教师，再在编辑里调整身份（需要超级管理员）。',
        'ROLE_NOT_CREATABLE',
      )
    }

    const active = input.active ?? true

    const dup = await this.sql<{ id: string }[]>`
      SELECT id FROM users WHERE lower(username) = lower(${input.username})
    `
    if (dup.length > 0) {
      throw AppError.conflict(`用户名「${input.username}」已存在`, 'CONFLICT')
    }

    const grants = await this.normalizeGrants(input.permissions ?? [])

    const created = await this.sql.begin(async (tx) => {
      // `status` 与账号、初始授权**在同一个事务里**写入 —— 于是"创建时选了停用"
      // 不再需要"再发第二个请求去停用"（那一步会留下意外启用的账号）。
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO users (username, name, name_en, password_hash, role, status)
        VALUES (${input.username}, ${input.name}, ${input.nameEn ?? null},
                ${hashPassword(input.password)}, ${input.role},
                ${active ? 'active' : 'inactive'})
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
    }).catch((error: unknown) => {
      // 并发下两个人同时建同一个用户名：数据库唯一索引会先拦住一个，这里翻译成 409。
      if (isUniqueViolation(error)) {
        throw AppError.conflict(`用户名「${input.username}」已存在`, 'CONFLICT')
      }
      throw error
    })

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'user.create',
      targetType: 'user',
      targetId: created.id,
      result: 'success',
      detail: {
        username: input.username,
        role: input.role,
        active,
        permissionCount: grants.length,
      },
    })
    return { id: created.id, username: input.username, active }
  }

  async update(actor: AuthUser, id: string, input: {
    name?: string
    nameEn?: string | null
    username?: string
    role?: string
    active?: boolean
    password?: string
  }): Promise<{ revokedSessions: number }> {
    // 门槛：只有超级管理员能改账号（含改身份 —— 这是最容易变成提权的那条路）。
    this.authz.assertSuperAdmin(actor)
    const existing = await this.sql<
      { id: string; name: string; role: string; status: string; username: string }[]
    >`
      SELECT id, name, role, status, username FROM users WHERE id = ${id}
    `
    if (existing.length === 0) throw AppError.notFound('账号不存在')
    const before = existing[0]

    /*
      改用户名（业主 Stage 13 §5）。
      唯一性：先查一次给可读的 409；**真正的保证**是 lower(username) 唯一索引
      （并发下那句 SELECT 会同时通过，唯一索引不会）。审计单独记一条 `user.username_change`，
      并且与身份/状态/口令一样**撤销该账号全部会话**：用户名是登录凭据的一半，
      改名之后必须重新登录一次，避免"改完还在用旧会话"的混乱。
    */
    let nextUsername: string | null = null
    if (input.username !== undefined) {
      const trimmed = input.username.trim()
      if (trimmed === '') throw AppError.badRequest('用户名不能为空', 'VALIDATION_FAILED')
      if (trimmed !== before.username) {
        const dup = await this.sql<{ id: string }[]>`
          SELECT id FROM users WHERE lower(username) = lower(${trimmed}) AND id <> ${id}
        `
        if (dup.length > 0) throw AppError.conflict(`用户名「${trimmed}」已存在`, 'CONFLICT')
        nextUsername = trimmed
      }
    }

    if (input.role !== undefined && !isUserRole(input.role)) {
      throw AppError.forbidden('未知的身份', 'VALIDATION_FAILED')
    }

    /*
     * ── 两条护栏（业主 §7 / §18 / §27）────────────────────────────────────────
     *
     * 1. **不能把自己改成别的身份。** 自己降级是把自己锁在系统外最快的方式，
     *    而且通常是一次误操作。要做交接就让另一位管理员改你的身份。
     * 2. **不能把最后一个管理员停用或降级。** 否则系统里再没有人能管理账号与目录，
     *    而且没有任何界面能把权限加回来（唯一的路是直接改数据库）。
     *    宁可在这一步拒绝，也不要在出事之后靠人工救。
     */
    const isSelf = actor.id === id
    const roleChanging = input.role !== undefined && input.role !== before.role
    const deactivating = input.active === false

    if (isSelf && roleChanging) {
      throw AppError.badRequest(
        '不能修改自己的身份。需要交接时请让另一位管理员来改。',
        'SELF_ROLE_CHANGE',
      )
    }

    const losingAdmin =
      this.authz.isAdminRole(before.role) &&
      before.status === 'active' &&
      ((roleChanging && !this.authz.isAdminRole(input.role ?? '')) || deactivating)
    if (losingAdmin) {
      // 不变量本身在 AuthorizationService 里（那里也是"管理员"这个概念唯一的定义处）。
      await this.authz.assertSystemKeepsAnAdmin(id)
    }

    const sets: string[] = []
    const values: unknown[] = []
    // 用显式的列名拼装，**不做**动态 key 插值 —— 唯一允许拼进 SQL 的是这里的字面量。
    const push = (column: string, value: unknown) => {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }
    if (nextUsername !== null) push('username', nextUsername)
    if (input.name !== undefined) push('name', input.name)
    if (input.nameEn !== undefined) push('name_en', input.nameEn)
    if (input.role !== undefined) push('role', input.role)
    if (input.active !== undefined) push('status', input.active ? 'active' : 'inactive')
    if (input.password !== undefined) push('password_hash', hashPassword(input.password))

    let revoked = 0
    if (sets.length > 0) {
      values.push(id)
      try {
        await this.sql.unsafe(
          `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
          values as never[],
        )
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          throw AppError.conflict('该用户名已被占用', 'CONFLICT')
        }
        throw error
      }

      // 身份、状态、口令任一变化 → 撤销该账号全部会话（即时生效，不需要版本号）。
      const mustRevoke =
        nextUsername !== null ||
        input.role !== undefined ||
        input.active !== undefined ||
        input.password !== undefined
      if (mustRevoke) revoked = await this.sessions.revokeAllForUser(id)

      /*
       * 审计：**一个请求可能同时做了几件事，就分别记几条**。
       *
       * 为什么不是"一条记录 + changed 字段"：审计最常见的用法是**按动作筛选**
       * （"谁改过别人的密码？"）。如果改密码被记成 `user.update`，
       * 那个筛选就查不出来 —— 而口令变更恰恰是最需要能查的一件事。
       */
      const commonDetail = {
        changed: Object.keys(input).filter((k) => k !== 'password'),
        revokedSessions: revoked,
        before: { role: before.role, status: before.status, name: before.name },
      }
      const records: {
        action: 'user.update' | 'user.disable' | 'user.password_change' | 'user.username_change'
        detail: Record<string, unknown>
      }[] = []

      // 口令：只要这次请求设置了新口令就单独记一条。
      // **只记"改过"，绝不记口令本身**（数据库里存的是 hash，审计里连 hash 都不该出现）。
      if (input.password !== undefined) {
        records.push({
          action: 'user.password_change',
          detail: { ...commonDetail, passwordSet: true },
        })
      }
      if (nextUsername !== null) {
        records.push({
          action: 'user.username_change',
          detail: { ...commonDetail, before: { ...commonDetail.before, username: before.username }, username: nextUsername },
        })
      }
      if (input.active === false) {
        records.push({ action: 'user.disable', detail: commonDetail })
      }
      const otherChanges = Object.keys(input).filter(
        (k) =>
          k !== 'password' &&
          k !== 'username' &&
          !(k === 'active' && input.active === false),
      )
      if (otherChanges.length > 0 || records.length === 0) {
        records.push({ action: 'user.update', detail: commonDetail })
      }

      for (const record of records) {
        await this.audit.write({
          actorId: actor.id,
          actorName: actor.name,
          action: record.action,
          targetType: 'user',
          targetId: id,
          result: 'success',
          detail: record.detail,
        })
      }
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
    // 门槛：只有超级管理员能改任何人的权限（否则"给自己加权限"就是一条提权路）。
    this.authz.assertSuperAdmin(actor)
    const exists = await this.sql<{ id: string }[]>`SELECT id FROM users WHERE id = ${userId}`
    if (exists.length === 0) throw AppError.notFound('账号不存在')

    /*
      `user.manage` 是**身份自带**的能力（超级管理员本来就有），不是一个可以授予老师的权限。
      之前它可以被授予 —— 于是一个被误配了它的老师就能建管理员、改别人身份。
      现在账号管理的门槛是身份，所以这份授权既没有意义、又会给人"他获得了管理权"的错觉，
      甚至成为日后有人"顺手在守卫里再加一条 user.manage 就放行"的后门。
      所以：**直接拒绝**，并说清正确的做法。
    */
    const notGrantable = input.find(
      (item) => isPermissionCode(item.permission) && !isGrantable(item.permission),
    )
    if (notGrantable !== undefined) {
      throw AppError.badRequest(
        '「管理教师」是超级管理员身份自带的能力，不能单独授予账号。要新增管理员请调整该账号的身份。',
        'SUPERADMIN_IS_ROLE_DERIVED',
      )
    }

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
