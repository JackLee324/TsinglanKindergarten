import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import type { PermissionCode } from '../../shared/permissions'
import { ADMIN_ROLE, PERMISSIONS, requiresOwnership } from '../../shared/permissions'
import { SQL } from '../db/database.module'
import type { AuthUser, AuthorizationDecision } from '../common/auth-user'

export interface PermissionGrantRow {
  readonly permission: string
  readonly directoryId: string | null
}

/**
 * AuthorizationService —— V2 **唯一**的授权判定实现
 * ============================================================================
 * 全仓库只有这里能回答"这个人能不能对这个目录做这件事"。任何 service 都不得
 * 自己写 `if (user.role === 'ADMIN')` 或自己查 user_permissions 表。
 *
 * 模型（业主最终确认，刻意保持极小）：
 *   身份：ADMIN | TEACHER
 *   授权：user_permissions(user_id, permission, directory_id)
 *        directory_id IS NULL → 全平台；否则 → 该节点**及其整棵子树**
 *
 * 这里**没有**、也永远不会有：
 *   deny / grant / override / role ceiling / permission version / 多套 scope。
 *
 * ── 两个判定入口，用途不同，不要混用 ──────────────────────────────────────
 *   can()                  对一个**确定的目录目标**判定（建资源、改这一条资源…）
 *   hasPermissionAnywhere() 用于**列表类**接口：允许调用，但数据必须由 service
 *                           按 accessibleDirectoryIds() 过滤后返回。
 *
 * 把"能不能调用"和"能看到哪些行"分开，是 V1 里最容易出错的一处 ——
 * V1 的资源列表只按科目过滤、不按状态过滤，于是省掉一个参数就等于把
 * 别人未发布的草稿也列了出来。V2 把过滤做成**显式的一步**，且有测试钉住。
 */
@Injectable()
export class AuthorizationService {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  /** 该用户持有的全部授权（用于 /auth/me 与权限面板）。 */
  async grantsOf(userId: string): Promise<PermissionGrantRow[]> {
    const rows = await this.sql<{ permission: string; directory_id: string | null }[]>`
      SELECT permission, directory_id FROM user_permissions WHERE user_id = ${userId}
    `
    return rows.map((r) => ({ permission: r.permission, directoryId: r.directory_id }))
  }

  /**
   * 对一个**确定的目录目标**判定权限。
   *
   * @param directoryId 目标目录；`null` 表示"这个操作不属于任何目录"
   *                    （例如 user.manage / audit.view 这类全平台权限）。
   */
  async can(
    user: AuthUser,
    permission: PermissionCode,
    directoryId: string | null,
  ): Promise<AuthorizationDecision> {
    // ───────────────────────────────────────────────────────────────────────
    // 全仓库**唯一**一处 ADMIN 绕过。
    // 它集中在这一个函数里，所以能被一条静态断言钉住
    // （tests/unit/admin-bypass-single-point.test.mjs 会扫描 server/ 下
    //   `ADMIN_ROLE` 的出现位置）。绕过照样写审计。
    // ───────────────────────────────────────────────────────────────────────
    if (user.role === ADMIN_ROLE) {
      return { allowed: true, reason: 'admin', permission, directoryId }
    }

    const grants = await this.sql<{ directory_id: string | null }[]>`
      SELECT directory_id FROM user_permissions
      WHERE user_id = ${user.id} AND permission = ${permission}
    `
    if (grants.length === 0) {
      return { allowed: false, reason: 'no-grant', permission, directoryId }
    }

    // 全平台授权：任何目录都通过（包括"不属于任何目录"的操作）。
    if (grants.some((g) => g.directory_id === null)) {
      return { allowed: true, reason: 'global-grant', permission, directoryId }
    }

    // 到这里 grants 全是带目录的；如果这个操作不属于任何目录，则不通过。
    if (directoryId === null) {
      return { allowed: false, reason: 'out-of-scope', permission, directoryId }
    }

    const ancestorIds = grants
      .map((g) => g.directory_id)
      .filter((id): id is string => typeof id === 'string')

    const hit = await this.sql<{ id: string }[]>`
      WITH RECURSIVE reach AS (
        SELECT id FROM directories WHERE id = ANY(${ancestorIds}::uuid[])
        UNION ALL
        SELECT d.id FROM directories d JOIN reach r ON d.parent_id = r.id
      )
      SELECT id FROM reach WHERE id = ${directoryId}
    `
    if (hit.length > 0) {
      return { allowed: true, reason: 'directory-grant', permission, directoryId }
    }
    return { allowed: false, reason: 'out-of-scope', permission, directoryId }
  }

  /**
   * 列表类接口用：只要在**任何**范围内持有该权限即可调用，
   * 具体能看到哪些行由 `accessibleDirectoryIds()` 决定。
   */
  async hasPermissionAnywhere(user: AuthUser, permission: PermissionCode): Promise<boolean> {
    if (user.role === ADMIN_ROLE) return true
    const rows = await this.sql<{ one: number }[]>`
      SELECT 1 AS one FROM user_permissions
      WHERE user_id = ${user.id} AND permission = ${permission} LIMIT 1
    `
    return rows.length > 0
  }

  /**
   * 该用户在这个权限下能触达的全部目录 id。
   *
   * 返回 `null` 表示"全部目录"（全平台授权或 ADMIN）——
   * 用一个可空值表达"无限集合"，调用方据此决定是否加 WHERE 条件。
   */
  async accessibleDirectoryIds(
    user: AuthUser,
    permission: PermissionCode,
  ): Promise<string[] | null> {
    if (user.role === ADMIN_ROLE) return null

    const grants = await this.sql<{ directory_id: string | null }[]>`
      SELECT directory_id FROM user_permissions
      WHERE user_id = ${user.id} AND permission = ${permission}
    `
    if (grants.length === 0) return []
    if (grants.some((g) => g.directory_id === null)) return null

    const roots = grants
      .map((g) => g.directory_id)
      .filter((id): id is string => typeof id === 'string')

    const rows = await this.sql<{ id: string }[]>`
      WITH RECURSIVE reach AS (
        SELECT id FROM directories WHERE id = ANY(${roots}::uuid[])
        UNION ALL
        SELECT d.id FROM directories d JOIN reach r ON d.parent_id = r.id
      )
      SELECT id FROM reach
    `
    return rows.map((r) => r.id)
  }

  /** 目标目录是否在祖先的子树内（含自身）。删目录、移动目录时用。 */
  async isInSubtree(ancestorId: string, nodeId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      WITH RECURSIVE reach AS (
        SELECT id FROM directories WHERE id = ${ancestorId}
        UNION ALL
        SELECT d.id FROM directories d JOIN reach r ON d.parent_id = r.id
      )
      SELECT id FROM reach WHERE id = ${nodeId}
    `
    return rows.length > 0
  }

  /**
   * 判定"能不能对这个**具体资源**做这件事" —— 目录范围与所有权**一次问完**。
   *
   * WHY 必须收口到这里：所有权（`uploader_id === 我`）和目录范围是同一件事的
   * 两个条件，任何 service 自己写 `row.uploader_id !== actor.id` 就等于
   * 在统一授权之外又开了一条判定路径 —— 而它不会被授权测试覆盖，
   * 也不会出现在"谁被拒了"的审计里。V1 正是这么长出了三套判定。
   *
   * @param options.requireOwner 默认由权限码决定（`*_own` 类）；
   *        提交/撤回这类"只能动自己的东西"的动作用它显式声明。
   */
  async canActOnResource(
    user: AuthUser,
    permission: PermissionCode,
    resource: { readonly id?: string; readonly directoryId: string; readonly uploaderId: string | null },
    options: { requireOwner?: boolean } = {},
  ): Promise<AuthorizationDecision> {
    // 唯一的 ADMIN 绕过点仍然只有下面 can() 里那一处 —— 这里不重复它。
    const scopeDecision = await this.can(user, permission, resource.directoryId)
    if (!scopeDecision.allowed) return scopeDecision

    const requireOwner = options.requireOwner ?? requiresOwnership(permission)
    if (requireOwner && resource.uploaderId !== user.id && scopeDecision.reason !== 'admin') {
      return { allowed: false, reason: 'not-owner', permission, directoryId: resource.directoryId }
    }
    return scopeDecision
  }

  /**
   * 回收站的可见范围：管理员看全部，教师只看自己的。
   *
   * 返回 `null` 表示"不加 uploader 过滤"。调用方不得自己判断角色 ——
   * 那会变成散落各处的第二套规则。
   */
  async recycleBinUploaderFilter(user: AuthUser): Promise<string | null> {
    return this.isAdmin(user) ? null : user.id
  }

  /**
   * 界面的能力开关（阶段 4 的前端据此决定按钮显隐）。
   *
   * 同样收口在这里：路由/组件**不得**自己写 `role === 'ADMIN' || ...`。
   */
  async capabilitiesFor(user: AuthUser): Promise<{
    role: string
    permissions: string[]
    canManageDirectories: boolean
    canManageUsers: boolean
    canReview: boolean
    canPublish: boolean
    canViewAudit: boolean
    canUpload: boolean
  }> {
    const grants = await this.grantsOf(user.id)
    const codes = new Set(grants.map((g) => g.permission))
    const admin = this.isAdmin(user)
    return {
      role: user.role,
      permissions: [...codes],
      canManageDirectories: admin || codes.has('directory.manage'),
      canManageUsers: admin || codes.has('user.manage'),
      canReview: admin || codes.has('resource.review'),
      canPublish: admin || codes.has('resource.publish'),
      canViewAudit: admin || codes.has('audit.view'),
      canUpload: admin || codes.has('resource.create'),
    }
  }

  /**
   * 目标不存在时的判定（例如资源已被永久删除，或必填的目标字段没给）。
   *
   * 放行条件：只有在**某个范围内确实持有该权限**的用户才被放过去，
   * 由 service 返回一个诚实的 404 / 400。
   * 这样"东西不存在"不会被说成"你没有权限"（后者会把人引向权限排查），
   * 同时随机 id 也探测不出服务端行为。
   *
   * 它是 public 的，但**只有守卫**会调用它 —— 守卫自己不得返回 `allowed: true`。
   */
  async decisionForMissingTarget(
    user: AuthUser,
    permission: PermissionCode,
  ): Promise<AuthorizationDecision> {
    const anywhere = await this.hasPermissionAnywhere(user, permission)
    if (anywhere) {
      return { allowed: true, reason: 'target-missing', permission, directoryId: null }
    }
    return { allowed: false, reason: 'no-grant', permission, directoryId: null }
  }

  /**
   * 该权限是否是"仅限自己拥有的资源"。**只用于解释与测试**，
   * 判定一律走 canActOnResource()。
   */
  isOwnOnly(permission: PermissionCode): boolean {
    return requiresOwnership(permission)
  }

  /**
   * 是否平台管理员。
   *
   * 它是 public 的，但**只允许 AuthorizationService 自己使用** ——
   * 静态测试保证 `ADMIN_ROLE` 在 server/ 下只出现在这个文件里，
   * 因此没有第二个地方能重新实现"管理员放行"。
   */
  isAdmin(user: AuthUser): boolean {
    return user.role === ADMIN_ROLE
  }

  /** 权限的生效范围类型（directory | global）。 */
  scopeOf(permission: PermissionCode): 'directory' | 'global' {
    return PERMISSIONS[permission].scope
  }
}
