import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import type { PermissionCode } from '../../shared/permissions'
import {
  DELETABLE_STATUSES,
  EDITABLE_STATUSES,
  RESOURCE_STATUSES,
  type ResourceStatus,
} from '../../shared/resource-status'
import { ADMIN_ROLE, PERMISSIONS, requiresOwnership } from '../../shared/permissions'
import { SQL } from '../db/database.module'
import { AppError } from '../common/http-error'
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
   * @param options.forbidSelf 审核类动作用它：**不能审核自己上传的资源**。
   *        这是业主 Stage 7 §8 / §26 明确要求的防自审。
   *        注意它与 `requireOwner` 是**相反方向**的两条约束：
   *        requireOwner = 只能动自己的；forbidSelf = 不能动自己的。
   */
  async canActOnResource(
    user: AuthUser,
    permission: PermissionCode,
    resource: { readonly id?: string; readonly directoryId: string; readonly uploaderId: string | null },
    options: { requireOwner?: boolean; forbidSelf?: boolean } = {},
  ): Promise<AuthorizationDecision> {
    // 唯一的 ADMIN 绕过点仍然只有下面 can() 里那一处 —— 这里不重复它。
    const scopeDecision = await this.can(user, permission, resource.directoryId)
    if (!scopeDecision.allowed) return scopeDecision

    const requireOwner = options.requireOwner ?? requiresOwnership(permission)
    if (requireOwner && resource.uploaderId !== user.id && scopeDecision.reason !== 'admin') {
      return { allowed: false, reason: 'not-owner', permission, directoryId: resource.directoryId }
    }

    // 防自审：**普通教师不能审自己上传的**；管理员（= 本项目里的超级管理员）可以。
    //
    // 规则变更记录（业主 Stage 13 §3，2026-10-09）：
    //   原先这里对**所有**角色一视同仁（注释还写着"管理员也不例外"，依据 Stage 7 §8 / §26）。
    //   业主复核后明确：超级管理员必须能审核并发布自己上传的待审资源 —— 否则单管理员站点
    //   里会出现"资源永远卡在待审"的死角，且那条规则并不增加任何安全性（管理员本来就有
    //   全平台权限，绕过点仍是 can() 里唯一那一处）。
    //
    // 实现上只用 `scopeDecision.reason === 'admin'` 这个**已有**的信号，
    // 不在这里再写一次角色比较 —— `'ADMIN'` 这个字面量在全仓库只允许出现在本文件，
    // 而"管理员能做什么"的判定入口仍然只有 can()。
    if (
      options.forbidSelf === true &&
      resource.uploaderId !== null &&
      resource.uploaderId === user.id &&
      scopeDecision.reason !== 'admin'
    ) {
      return { allowed: false, reason: 'self-review', permission, directoryId: resource.directoryId }
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
   * 一条**具体资源**对某人是否可见。
   *
   * WHY 必须有这个函数（阶段 6 的真实教训）：
   *
   * 阶段 5 把可见性规则（已发布 ∪ 自己上传的；审核岗多看已提交的；管理员看全部）
   * 实现成了 `resourceVisibility()` 返回的**状态集合**，由列表查询翻译成 SQL。
   * 但**单条读取**（资源详情、文件列表、文件下载/预览、审核历史）走的是另一条路：
   * 它们只做"目标目录的 `resource.view` 判定"，**没有比对状态**。
   *
   * 后果是真的：一位老师只要知道（或者猜到）同事那条**草稿**的 id，
   * 就能列出它的文件、拿到签名地址、把文件下载走 —— 而列表里根本看不到这条资源。
   * 这是集成测试跑出来的（file 套件"别人的草稿资源：连文件列表都够不到"）。
   *
   * 所以判定收口在这里，并且**复用同一份策略**：
   *   · `resourceVisibility(user).othersStatuses` 决定"别人上传的哪些状态我能看"；
   *   · `uploader_id === 我` 决定"自己的东西永远看得到"。
   * 列表用同一份策略翻译成 SQL，单条用它直接比较 —— 一处规则，两种消费方式。
   */
  async canViewResource(
    user: AuthUser,
    resource: { readonly status: string; readonly uploaderId: string | null },
  ): Promise<AuthorizationDecision> {
    const permission: PermissionCode = 'resource.view'
    if (this.isAdmin(user)) {
      return { allowed: true, reason: 'admin', permission, directoryId: null }
    }
    if (resource.uploaderId !== null && resource.uploaderId === user.id) {
      return { allowed: true, reason: 'global-grant', permission, directoryId: null }
    }
    const { othersStatuses } = await this.resourceVisibility(user)
    if (othersStatuses.includes(resource.status as ResourceStatus)) {
      return { allowed: true, reason: 'directory-grant', permission, directoryId: null }
    }
    // 「状态不可见」与「目录不可见」要分开：前者是"别人的草稿"，
    // 后者是"你没这个目录的权限"，界面提示与排查方向完全不同。
    return { allowed: false, reason: 'status-hidden', permission, directoryId: null }
  }

  /**
   * 一条**具体资源**上，这个人能做哪些动作。
   *
   * 界面据此决定按钮显隐（阶段 7：详情页要按权限显示 编辑 / 提交 / 通过并发布 /
   * 退回 / 撤回）。三条纪律：
   *
   *   1. **它不是安全边界。** 每个动作的接口都会用同一个判定再拒一次 ——
   *      能力位只是"不要把必然失败的按钮摆出来"。
   *   2. **判定不在这里重写。** 全部转发到 `canActOnResource()`，
   *      而这个仓库里只有那一处判定所有权 / 目录 / 自审。
   *   3. **拒绝时带上原因。** 尤其 `self-review`：老师看到"你没有权限"会去找管理员要权限，
   *      而要到了也没用（系统就是不允许自审）。界面需要能解释清楚。
   */
  async resourceCapabilities(
    user: AuthUser,
    resource: { readonly id: string; readonly status: string; readonly directoryId: string; readonly uploaderId: string | null },
  ): Promise<{
    readonly canEdit: boolean
    readonly canSubmit: boolean
    readonly canApprove: boolean
    readonly canReject: boolean
    readonly canRecall: boolean
    readonly canDelete: boolean
    /** 审核动作被拒时的原因（`self-review` 等），供界面解释。 */
    readonly reviewDeniedReason: string | null
  }> {
    const status = resource.status
    const target = { id: resource.id, directoryId: resource.directoryId, uploaderId: resource.uploaderId }

    // 每个动作都问**同一个**入口；`editable` 由状态机决定（状态在这里只做前置过滤，
    // 真正的合法性仍由事务里的条件更新保证）。
    const edit = await this.canActOnResource(user, 'resource.update.own', target)
    const submit = await this.canActOnResource(user, 'resource.submit', target, { requireOwner: true })
    const approve = await this.canActOnResource(user, 'resource.publish', target, { forbidSelf: true })
    const reject = await this.canActOnResource(user, 'resource.review', target, { forbidSelf: true })
    const recall = await this.canActOnResource(user, 'resource.submit', target, { requireOwner: true })
    const remove = await this.canActOnResource(user, 'resource.delete.own', target)

    const reviewDenied = approve.allowed ? reject : approve

    return {
      // 编辑：可编辑状态 + 有权改。REJECTED / RECALLED 都在可编辑状态里
      // （编辑动作本身会把它们变回 DRAFT，见状态机的 REJECTED→DRAFT / RECALLED→DRAFT）。
      canEdit: edit.allowed && EDITABLE_STATUSES.includes(status as ResourceStatus),
      // 提交审核：只有草稿能提交。REJECTED / RECALLED 必须先编辑（回 DRAFT）——
      // 状态机里已经没有 REJECTED→PENDING_REVIEW 这条转换了。
      canSubmit: submit.allowed && status === 'DRAFT',
      // 「通过并发布」是**一步**（业主 §14），所以这两个能力都只在待审核时有意义。
      canApprove: approve.allowed && status === 'PENDING_REVIEW',
      canReject: reject.allowed && status === 'PENDING_REVIEW',
      canRecall: recall.allowed && status === 'PUBLISHED',
      canDelete: remove.allowed && DELETABLE_STATUSES.includes(status as ResourceStatus),
      reviewDeniedReason:
        status === 'PENDING_REVIEW' && !approve.allowed ? reviewDenied.reason : null,
    }
  }

  /**
   * 界面的能力开关（阶段 4 的前端据此决定按钮显隐）。
   *
   * 同样收口在这里：路由/组件**不得**自己写 `role === 'ADMIN' || ...`。
   */
  async capabilitiesFor(user: AuthUser): Promise<{
    role: string
    /** 这个账号是不是管理员（**展示用**：界面上的「管理员」标签）。 */
    isAdmin: boolean
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
      isAdmin: admin,
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
   * 资源的**可见性策略**：我会看到「别人上传的哪些状态」。
   *
   * 规则（STAGE 5 §4，并按审核岗的实际需要细化）：
   *
   * | 观察者的身份 | 能看到别人上传的哪些状态 |
   * |---|---|
   * | 普通教师（有 `resource.view`） | 只有 `PUBLISHED` |
   * | 审核 / 发布岗（有 `resource.review` 或 `resource.publish`） | `PUBLISHED`、`PENDING_REVIEW`、`REJECTED`、`RECALLED` |
   * | 管理员 | 全部（含别人的 `DRAFT`） |
   *
   * 任何身份都**永远**能看到自己上传的全部状态（含自己的草稿）。
   *
   * ⚠️ 两条来之不易的边界，改动前请先读：
   *
   * 1. `DRAFT` 对**非本人一律不可见**，包括审核岗。
   *    草稿是"还没交出去的东西"，审核岗能看到它就等于老师没有私人工作区。
   *    审核台要的是 `PENDING_REVIEW`，不是草稿。
   * 2. 审核岗**必须**看得到别人提交的待审资源。
   *    第一版把可见性写成 `isAdmin(user)` 一个布尔量，于是
   *    `GET /api/reviews/pending` 对非管理员的审核员返回空 ——
   *    审核台"什么都看不到"，而接口本身还是 200。
   *    这是全量跑测试时才暴露的（review 套件第 61 组）。
   *    修法在**策略**里，不在控制器里加开关 ——
   *    在控制器里开一个"这次不看可见性"的旁路，就又是一条绕开统一授权的判定路径。
   *
   * WHY 由这里给出而不是在 ResourcesService 里写 `role === 'ADMIN'`：
   * 那等于在统一授权之外又开一条判定路径，而静态守卫会（也应当）把它判红 ——
   * 阶段 3 我已经因为同类问题被拦下过一次。
   * ResourceService 拿到的是一个**策略值**，它只负责把这个值翻译成 SQL 条件。
   */
  async resourceVisibility(user: AuthUser): Promise<{
    readonly othersStatuses: readonly ResourceStatus[]
    readonly ownerId: string
  }> {
    if (this.isAdmin(user)) {
      return { othersStatuses: RESOURCE_STATUSES, ownerId: user.id }
    }
    // 审核 / 发布岗：除了别人的草稿，其余都看得到（否则审核台是空的）。
    const reviewer = await this.hasPermissionAnywhere(user, 'resource.review')
    const publisher = reviewer ? false : await this.hasPermissionAnywhere(user, 'resource.publish')
    if (reviewer || publisher) {
      return {
        othersStatuses: RESOURCE_STATUSES.filter((status) => status !== 'DRAFT'),
        ownerId: user.id,
      }
    }
    return { othersStatuses: ['PUBLISHED'], ownerId: user.id }
  }

  /**
   * 这个目录上还挂着多少条授权。
   *
   * 用于**删除保护**：`user_permissions.directory_id` 是 ON DELETE CASCADE，
   * 不检查就删目录会静默抹掉别人对该目录的授权（实测：删完授权行 2 → 1，界面无提示）。
   *
   * WHY 放在这里而不是放在目录服务里：`user_permissions` 的读取只允许有**一个**地方
   * （由 tests/unit/single-permission-truth.test.mjs 静态保证）。它虽然不是"判定某人能否做某事"，
   * 但仍然是授权域的数据 —— 让目录服务去读授权表，就等于开了第二个入口，
   * 而下一次有人想"顺手查一下他有没有权限"时会照着这个先例写。
   */
  async countGrantsOnDirectory(directoryId: string): Promise<number> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM user_permissions WHERE directory_id = ${directoryId}
    `
    return rows[0]?.n ?? 0
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
   * 这个角色是不是管理员。
   *
   * ⚠️ **只用于"展示"与"不变量"**（列表上那个「管理员」标签、系统至少要留一个
   * 管理员的检查）。**任何"能不能做某件事"的判定都必须走 `can()`** —— 那才是
   * 唯一的放行入口。它存在的另一个目的，是让 `role === 'ADMIN'` 这个比较
   * 继续只出现在本文件里（静态测试会扫全仓库）。
   */
  isAdminRole(role: string): boolean {
    return role === ADMIN_ROLE
  }

  /**
   * 系统必须**至少留一个能用的管理员**。
   *
   * 这条不变量放在这里而不是账号服务里，理由和别的判定一样：
   * "管理员"这个概念的定义只在本文件（`ADMIN_ROLE` 的绕过也在这里），
   * 换一个地方再写一遍 `role === 'ADMIN'`，就等于开了第二个解释权。
   *
   * 一旦没有管理员，界面上再也加不回来（唯一的路是直接改数据库），
   * 所以停用 / 降级最后一个管理员的请求必须在这里被拒。
   */
  async assertSystemKeepsAnAdmin(excludingUserId: string): Promise<void> {
    const rows = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM users
      WHERE role = ${ADMIN_ROLE} AND status = 'active' AND id <> ${excludingUserId}
    `
    if ((rows[0]?.n ?? 0) === 0) {
      throw AppError.badRequest('系统至少需要一名管理员。', 'LAST_ADMIN')
    }
  }

  /**
   * 是否平台管理员（= 本项目里的**超级管理员**）。
   *
   * 它是 public 的，但**只允许 AuthorizationService 自己使用** ——
   * 静态测试保证 `ADMIN_ROLE` 在 server/ 下只出现在这个文件里，
   * 因此没有第二个地方能重新实现"管理员放行"。
   */
  isAdmin(user: AuthUser): boolean {
    return user.role === ADMIN_ROLE
  }

  /**
   * 这个账号是不是**超级管理员**（业主 Stage 13 §4 的用词）。
   *
   * 设计边界（必须写清楚，否则后人会在这里悄悄加第三种身份）：
   *   本项目**只有 ADMIN 与 TEACHER 两种业务身份**，`ADMIN` 在语义上就是超级管理员。
   *   没有单独的 "super_admin" / "管理员 vs 普通管理员" 之分 —— 业主明确要求
   *   **不要为了修一个越权问题就新增第三种角色**。
   *   于是"只有超级管理员能管账号"这条规则，在代码里就是"只有 ADMIN 能管账号"。
   *
   * 为什么这个方法必须存在（而不是让各 service 自己写角色判断）：
   *   · 角色字面量只允许出现在本文件（`tests/unit/route-declarations.test.mjs` 会扫全仓库）；
   *   · 账号管理如果只靠 `user.manage` 这个**可授予**的权限来保护，
   *     那么一个被误配了 `user.manage` 的老师就能建管理员、改别人身份（越权）。
   *     所以账号管理的门槛是**身份**，而且这个判定只有一处。
   */
  isSuperAdmin(user: AuthUser): boolean {
    return this.isAdmin(user)
  }

  /**
   * 账号管理（列表/创建/编辑/停用/改口令/改权限）的**服务端硬门槛**。
   *
   * 与 `can()` 的关系：`can()` 回答"能不能做这个权限码对应的事"，
   * 而"管理账号"这件事**不允许**由权限码授予 —— 它是身份自带的。
   * 所以两者是叠加关系：控制器先过 `user.manage` 声明，再过这里，
   * 而 service 层也会再调一次（即使有人绕过控制器直接调 service，也拒绝）。
   */
  assertSuperAdmin(user: AuthUser): void {
    if (!this.isSuperAdmin(user)) {
      throw AppError.forbidden(
        '账号管理只有超级管理员可以操作。',
        'SUPERADMIN_REQUIRED',
      )
    }
  }

  /** 权限的生效范围类型（directory | global）。 */
  scopeOf(permission: PermissionCode): 'directory' | 'global' {
    return PERMISSIONS[permission].scope
  }
}
