import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { AuditService } from '../audit/audit.service'
import { AuthorizationService } from '../authz/authorization.service'
import { StorageService } from '../storage/storage.service'
import { DirectoriesService } from '../directories/directories.service'
import type { AuthUser } from '../common/auth-user'
import { AppError } from '../common/http-error'
import type { PermissionCode } from '../../shared/permissions'
import {
  DEFAULT_PAGE_SIZE,
  computeTotalPages,
  type ResourceSortKey,
} from '../../shared/resource-query'
import {
  ACTION_AUDIT_NAME,
  DELETABLE_STATUSES,
  FORCE_STATUS_COMMENT_PREFIX,
  FORCE_STATUS_REQUIRES_COMMENT,
  FORCE_STATUS_REVIEW_ACTION,
  RESOURCE_STATUS_LABEL,
  RESOURCE_STATUSES,
  editOutcomeFor,
  findTransition,
  type ResourceStatus,
} from '../../shared/resource-status'
import { toFileView } from '../files/file-view'

/**
 * 转义 LIKE 的通配符。
 *
 * WHY：搜索词直接拼进 LIKE 时，`%` 与 `_` 会变成通配符 ——
 * 实测搜索 `%` 会返回**全部**资源；`50%` 这种正常输入也会命中一堆无关内容。
 * 这不是注入（值仍然是参数化的），但结果同样是错的。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 空页：分页字段仍然要齐全，否则前端渲染不出"共 0 条 / 第 1 页"。 */
function emptyPage(page: number, pageSize: number) {
  return { items: [], total: 0, page, pageSize, totalPages: computeTotalPages(0, pageSize) }
}

/** 状态机动作 → 界面中文标签。只有这一份映射。 */
function resourceActionLabel(action: string): string {
  const labels: Record<string, string> = {
    create: '创建',
    update: '编辑',
    submit: '提交审核',
    'review.approve': '审核通过并发布',
    'review.reject': '审核退回',
    'review.recall': '撤回',
    delete: '删除',
    restore: '恢复',
    purge: '永久删除',
  }
  return labels[action] ?? action
}

/**
 * 被拒时说一句能照做的话。
 *
 * 「不能审核自己上传的资源」尤其要说清楚：它不是一个权限配置问题，
 * 而是系统故意不允许的行为 —— 如果只说"没有权限"，老师会去找管理员要权限，
 * 而管理员给了也没用（仍然会被拒）。这正是防自审最容易引起困惑的地方。
 */
function deniedMessage(reason: string, permission: string): string {
  if (reason === 'not-owner') return '只能操作自己上传的资源'
  if (reason === 'self-review') return '不能审核自己上传的资源，请由其他审核员处理'
  if (reason === 'status-hidden') return '这条资源还没有发布，只有上传者本人能看到'
  return `没有权限：${permission}`
}

export interface ResourceFilters {
  directoryId?: string | null
  includeSubtree?: boolean
  status?: ResourceStatus | null
  q?: string | null
  sort?: ResourceSortKey
  page: number
  pageSize: number
  onlyMine?: boolean
  recycled?: boolean
}

interface ResourceRow {
  id: string
  directory_id: string
  title: string
  title_en: string | null
  description: string | null
  status: string
  version: number
  uploader_id: string | null
  published_at: Date | null
  deleted_at: Date | null
  created_at: Date
  updated_at: Date
}

/**
 * 批量软删除里**单条**的结果。
 *
 * 三种结局互斥且都要如实回报，不能合并成一个布尔量：
 *   · `deleted` —— 这条真的进了回收站；
 *   · `skipped` —— 输入合法但按规则不该动（不存在 / 已在回收站 / 已发布 / 并发抢先），
 *                  **不是错误**，重试也不会变；
 *   · `failed`  —— 处理过程中出了错，重试可能成功。
 *
 * `reason` 是给程序看的稳定标识，`message` 是给人看的中文说明 ——
 * 前端据此分类展示，而不是去解析文案。
 */
export interface BulkDeleteItemResult {
  readonly id: string
  readonly outcome: 'deleted' | 'skipped' | 'failed'
  readonly reason: string | null
  readonly message: string
}

export interface BulkDeleteResult {
  /** 请求里给的 ID 个数（含重复）。 */
  readonly requested: number
  /** 去重后实际处理的个数。 */
  readonly unique: number
  /** 被去掉的重复个数（`requested - unique`）。 */
  readonly duplicated: number
  readonly deleted: number
  readonly skipped: number
  readonly failed: number
  readonly items: readonly BulkDeleteItemResult[]
}

/**
 * 批量**强制改状态**里单条的结果。
 *
 * 与删除那一份同构（三种结局、`reason` 给程序、`message` 给人），
 * 只是成功那一档叫 `updated` 而不是 `deleted` ——
 * 名字混用会让"我到底删了还是改了"在类型层面就分不清。
 */
export interface BulkStatusItemResult {
  readonly id: string
  readonly outcome: 'updated' | 'skipped' | 'failed'
  readonly reason: string | null
  readonly message: string
  /** 改动前后的状态（跳过的条目为 null）。给界面显示「草稿 → 已发布」用。 */
  readonly from: string | null
  readonly to: string | null
}

export interface BulkStatusResult {
  readonly requested: number
  readonly unique: number
  readonly duplicated: number
  readonly updated: number
  readonly skipped: number
  readonly failed: number
  readonly status: string
  readonly items: readonly BulkStatusItemResult[]
}

/**
 * ResourcesService —— 资源与状态机
 * ============================================================================
 * 三条不变量（都由测试钉住）：
 *
 * 1. **不允许假成功。** 所有状态变更都是**条件更新**（`WHERE status = <期望的当前状态>`），
 *    影响 0 行就返回 409，而不是照样回一句"操作成功"。
 *    V1 的 `resource.purge` 曾在数据库层影响 0 行而审计写了 success。
 *
 * 2. **状态机只有一份。** 合法转换来自 `shared/resource-status.ts`；
 *    这里只做"查表 + 条件更新 + 写流水"，不写任何自己的 if 规则。
 *
 * 3. **列表必须显式按范围过滤。** `accessibleDirectoryIds()` 的结果是 WHERE 的一部分；
 *    没有它，一个只有 Pre-K 权限的老师调一次 `/api/resources` 就能看到全校资源。
 */
@Injectable()
export class ResourcesService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly directories: DirectoriesService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // 查询
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 资源列表。
   *
   * 三条约束，缺一条就会出现"看到了不该看的"：
   *   1. **目录范围**：`accessibleDirectoryIds(resource.view)` 进 WHERE；
   *   2. **可见性**：未发布的资源只有上传者自己能看到（管理员看全部）——
   *      这条以前缺失，实测 B 老师能看到 A 老师的草稿；
   *   3. **显式指定目录时必须是 403 而不是空列表** —— 空列表会让调用方以为
   *      "这个目录没有资源"，而事实是"你没有权限"。两者要分清。
   */
  async list(user: AuthUser, filters: ResourceFilters) {
    if (filters.directoryId != null) {
      await this.assertCanViewDirectory(user, filters.directoryId)
    }

    const scope = await this.authz.accessibleDirectoryIds(user, 'resource.view')
    if (scope !== null && scope.length === 0) {
      return emptyPage(filters.page, filters.pageSize)
    }

    const directoryIds =
      filters.directoryId != null
        ? filters.includeSubtree === true
          ? await this.subtreeIds(filters.directoryId)
          : [filters.directoryId]
        : null

    const visibility = await this.authz.resourceVisibility(user)

    return this.queryResources({
      scope,
      directoryIds,
      status: filters.status ?? null,
      q: filters.q ?? null,
      onlyUploaderId: filters.onlyMine ? user.id : null,
      recycled: filters.recycled === true,
      visibility,
      sort: filters.sort,
      page: filters.page,
      pageSize: filters.pageSize,
    })
  }

  /**
   * 审核队列（业主 Stage 7 §3）。
   *
   * 与普通列表**共用同一个查询**，只是固定了"看哪种状态"：
   * 于是搜索 / 目录过滤 / 排序 / 分页 / **可见性**全部自动一致 ——
   * 队列不可能变成一条绕过权限的独立查询路径（业主 §18 的要求）。
   *
   * 审核岗看到的待审资源，靠的就是 `resourceVisibility()` 里
   * "审核 / 发布岗能看别人已提交的内容"那一条策略；这里不另开判定。
   */
  async queue(
    user: AuthUser,
    status: ResourceStatus,
    filters: {
      directoryId?: string | null
      q?: string | null
      sort?: ResourceSortKey
      page: number
      pageSize: number
    },
  ) {
    return this.list(user, {
      directoryId: filters.directoryId ?? null,
      // 目录过滤**包含子树**：审核台的筛选是"我要看 Pre-K 这一块"，
      // 而资源挂在资料夹叶节点上。不递归的话，选「Pre-K」会一条都看不到
      // （集成测试一开始就是这么发现的：期望 3 条，实际 0 条）。
      includeSubtree: true,
      status,
      q: filters.q ?? null,
      sort: filters.sort,
      page: filters.page,
      pageSize: filters.pageSize,
    })
  }

  /**
   * 「我的资源」。
   *
   * 只按上传者过滤，且**只有自己** —— 因此未发布资源在这里天然可见，
   * 不需要再叠加可见性条件（自己看自己的草稿是正当的）。
   */
  async mine(
    user: AuthUser,
    scope: 'active' | 'recycle',
    options: { status?: ResourceStatus | null; page?: number; pageSize?: number } = {},
  ) {
    return this.queryResources({
      scope: null,
      directoryIds: null,
      status: options.status ?? null,
      q: null,
      onlyUploaderId: user.id,
      recycled: scope === 'recycle',
      visibility: { othersStatuses: RESOURCE_STATUSES, ownerId: user.id },
      page: options.page ?? 1,
      pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    })
  }

  /**
   * 回收站。
   * 教师只能看自己的（由 `onlyUploaderId` 实现）；管理员看全部。
   */
  async recycleBin(user: AuthUser) {
    return this.queryResources({
      scope: null,
      directoryIds: null,
      status: null,
      q: null,
      onlyUploaderId: await this.authz.recycleBinUploaderFilter(user),
      recycled: true,
      visibility: { othersStatuses: RESOURCE_STATUSES, ownerId: user.id },
      page: 1,
      pageSize: 200,
    })
  }

  /**
   * 显式请求某个目录时，没有权限必须 **403**。
   *
   * 走 `canActOnResource` 之外的目录判定：这里的目标是目录本身，不是某条资源，
   * 所以用 `can(permission, directoryId)`。
   */
  /**
   * 单条资源的可见性检查（列表那一条 SQL 之外的另一半）。
   *
   * 判定本身在 AuthorizationService 里，这里只负责把"不可见"翻译成 403 + 审计。
   */
  private async assertCanViewResource(
    user: AuthUser,
    row: { id: string; status: string; uploader_id: string | null; directory_id: string },
  ): Promise<void> {
    const decision = await this.authz.canViewResource(user, {
      status: row.status,
      uploaderId: row.uploader_id,
    })
    if (decision.allowed) return
    await this.audit.write({
      actorId: user.id,
      actorName: user.name,
      action: 'authz.denied',
      targetType: 'resource',
      targetId: row.id,
      result: 'denied',
      detail: { permission: 'resource.view', reason: decision.reason, status: row.status },
    })
    throw AppError.forbidden(
      '这条资源还没有发布，只有上传者本人能看到',
      'FORBIDDEN',
    )
  }

  private async assertCanViewDirectory(user: AuthUser, directoryId: string): Promise<void> {
    const decision = await this.authz.can(user, 'resource.view', directoryId)
    if (decision.allowed) return
    await this.audit.write({
      actorId: user.id,
      actorName: user.name,
      action: 'authz.denied',
      targetType: 'directory',
      targetId: directoryId,
      result: 'denied',
      detail: { permission: 'resource.view', reason: decision.reason, directoryId },
    })
    throw AppError.forbidden('没有权限查看这个目录下的资源', 'FORBIDDEN')
  }

  private async queryResources(opt: {
    scope: string[] | null
    directoryIds: string[] | null
    status: ResourceStatus | null
    q: string | null
    onlyUploaderId: string | null
    recycled: boolean
    visibility: { othersStatuses: readonly ResourceStatus[]; ownerId: string }
    sort?: ResourceSortKey
    page: number
    pageSize: number
  }) {
    // 搜索覆盖五类字段：中文标题 / 英文标题 / 描述 / 文件名 / 目录名。
    const pattern = opt.q ? `%${escapeLike(opt.q)}%` : null
    // 可见性：策略值来自 AuthorizationService（见 resourceVisibility 的说明）。
    // 这里只负责把它翻译成 SQL：自己上传的全可见，别人上传的按状态集合。
    const othersStatuses = opt.visibility.othersStatuses
    const ownerId = opt.visibility.ownerId
    const rows = await this.sql<
      (ResourceRow & {
        uploader_name: string | null
        file_count: number
        directory_path: string
        latest_reject_comment: string | null
        total: number
      })[]
    >`
      WITH RECURSIVE dir_path AS (
        SELECT id, slug AS path FROM directories WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, dp.path || '/' || d.slug
        FROM directories d JOIN dir_path dp ON d.parent_id = dp.id
      ), matched AS (
        SELECT r.*
        FROM resources r
        LEFT JOIN dir_path dp ON dp.id = r.directory_id
        WHERE /*
                ⚠️ 「在不在回收站」必须写成**一个**布尔比较，不能写成两个析取项。
                2026-10-15 之前这里是：

                  WHERE (recycled = true AND deleted_at IS NOT NULL)
                     OR (recycled = false AND deleted_at IS NULL)
                    AND (...目录范围...) AND (...上传者...) AND (...可见性...)

                SQL 里 AND 比 OR 结合得紧，于是它实际等价于
                「回收站那一支**绕过后面所有过滤条件**」——
                老师在自己的回收站里能看到**全平台**所有被删的资源
                （标题、目录路径、上传者姓名），目录范围与可见性判定一条都没生效。
                普通列表走 recycled = false 那一支（第一个析取项恒假），
                所以只有回收站这一条路是坏的，一直没被发现。
                （回归：tests/integration/my-resources.integration.test.mjs
                  「回收站也只看得到自己的」）

                写成相等比较之后，"哪个分支"与"后面的过滤条件"之间
                不再有优先级可踩 —— 这类缺陷在结构上消失了。

                ⚠️ 这段注释是**模板字符串里的文本**，不能出现反引号
                （会提前结束模板字符串，报一堆莫名其妙的 TS1005）。
              */
              (r.deleted_at IS NOT NULL) = ${opt.recycled}
          AND (${opt.scope}::uuid[] IS NULL OR r.directory_id = ANY(${opt.scope}::uuid[]))
          AND (${opt.directoryIds}::uuid[] IS NULL OR r.directory_id = ANY(${opt.directoryIds}::uuid[]))
          AND (${opt.status}::text IS NULL OR r.status = ${opt.status}::text)
          AND (${opt.onlyUploaderId}::uuid IS NULL OR r.uploader_id = ${opt.onlyUploaderId}::uuid)
          AND (
            r.uploader_id = ${ownerId}::uuid
            OR r.status = ANY(${othersStatuses}::text[])
          )
          AND (
            ${pattern}::text IS NULL
            OR r.title ILIKE ${pattern} ESCAPE '\\'
            OR COALESCE(r.title_en, '') ILIKE ${pattern} ESCAPE '\\'
            OR COALESCE(r.description, '') ILIKE ${pattern} ESCAPE '\\'
            OR EXISTS (
              SELECT 1 FROM resource_files f
              WHERE f.resource_id = r.id AND f.file_name ILIKE ${pattern} ESCAPE '\\'
            )
            OR EXISTS (SELECT 1 FROM dir_path d2 WHERE d2.id = r.directory_id AND d2.path ILIKE ${pattern} ESCAPE '\\')
          )
      )
      SELECT m.*, u.name AS uploader_name,
             (SELECT count(*)::int FROM resource_files f WHERE f.resource_id = m.id) AS file_count,
             (SELECT path FROM dir_path dp WHERE dp.id = m.directory_id) AS directory_path,
             -- 最新一条退回意见：教师要在列表上直接看到"为什么被退回来了"，
             -- 而不是点进详情才知道（业主 §16）。
             (SELECT rr.comment FROM resource_reviews rr
               WHERE rr.resource_id = m.id AND rr.action = 'review.reject'
               ORDER BY rr.created_at DESC, rr.id DESC LIMIT 1) AS latest_reject_comment,
             (SELECT count(*)::int FROM matched) AS total
      FROM matched m
      LEFT JOIN users u ON u.id = m.uploader_id
      -- id 这个 tiebreaker 不是装饰：只按 updated_at 排序时，
      -- updated_at 完全相同的行之间的顺序由 Postgres 自由决定，
      -- 翻页就可能重复取到同一行、同时漏掉另一行（不重不漏被破坏）。
      -- 见 tests/integration/resource-pagination.integration.test.mjs。
      ORDER BY ${this.orderBy(opt.sort)}
      LIMIT ${opt.pageSize} OFFSET ${(opt.page - 1) * opt.pageSize}
    `

    const total = rows.length > 0 ? rows[0].total : await this.countMatching(opt)
    const totalPages = computeTotalPages(total, opt.pageSize)
    return {
      /**
       * 详情链接用**资源 id**，不用标题。
       * 标题是可改的、可重复的；拿它做 URL identity 会让改名后的分享链接失效。
       */
      items: rows.map((r) => ({
        id: r.id,
        directoryId: r.directory_id,
        /** 资源所在位置（完整目录路径）—— 让"我上传的东西去哪了"一眼可见。 */
        directoryPath: r.directory_path,
        title: r.title,
        titleEn: r.title_en,
        description: r.description,
        status: r.status as ResourceStatus,
        version: r.version,
        uploaderId: r.uploader_id,
        uploaderName: r.uploader_name,
        fileCount: r.file_count,
        hasFile: r.file_count > 0,
        latestReviewComment: r.latest_reject_comment ?? null,
        publishedAt: r.published_at?.toISOString() ?? null,
        deletedAt: r.deleted_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      total,
      page: opt.page,
      pageSize: opt.pageSize,
      totalPages,
    }
  }

  /**
   * 排序片段。
   *
   * ⚠️ **只从白名单映射**，绝不把客户端传来的字段名拼进 SQL。
   * 每一种排序都带 `id` 作为 tiebreaker：只按时间排序时，
   * 时间完全相同的行之间顺序由 Postgres 自由决定，翻页就可能重复取到某行、
   * 同时漏掉另一行（阶段 5 的 resource-pagination 套件钉住了这一点）。
   *
   * 用 `sql()` 片段而不是字符串拼 SQL：让 postgres.js 去处理标识符与参数，
   * 我们这边永远不会拼错引号。
   */
  private orderBy(sort: ResourceSortKey | undefined) {
    switch (sort) {
      case 'updated_asc':
        return this.sql`m.updated_at ASC, m.id ASC`
      case 'created_desc':
        return this.sql`m.created_at DESC, m.id DESC`
      case 'title_asc':
        // 中文标题按 unicode 码点排，对"找某一条"足够用（真正的拼音排序需要额外字典）。
        return this.sql`m.title ASC, m.id ASC`
      case 'updated_desc':
      default:
        return this.sql`m.updated_at DESC, m.id DESC`
    }
  }

  private async countMatching(opt: {
    scope: string[] | null
    directoryIds: string[] | null
    status: ResourceStatus | null
    q: string | null
    onlyUploaderId: string | null
    recycled: boolean
    visibility: { othersStatuses: readonly ResourceStatus[]; ownerId: string }
  }): Promise<number> {
    const pattern = opt.q ? `%${escapeLike(opt.q)}%` : null
    const rows = await this.sql<{ n: number }[]>`
      WITH RECURSIVE dir_path AS (
        SELECT id, slug AS path FROM directories WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, dp.path || '/' || d.slug
        FROM directories d JOIN dir_path dp ON d.parent_id = dp.id
      )
      SELECT count(*)::int AS n
      FROM resources r
      WHERE -- 同上：回收站判定必须是**一个**布尔比较，见 queryResources 里的说明
            (r.deleted_at IS NOT NULL) = ${opt.recycled}
        AND (${opt.scope}::uuid[] IS NULL OR r.directory_id = ANY(${opt.scope}::uuid[]))
        AND (${opt.directoryIds}::uuid[] IS NULL OR r.directory_id = ANY(${opt.directoryIds}::uuid[]))
        AND (${opt.status}::text IS NULL OR r.status = ${opt.status}::text)
        AND (${opt.onlyUploaderId}::uuid IS NULL OR r.uploader_id = ${opt.onlyUploaderId}::uuid)
        AND (
          r.uploader_id = ${opt.visibility.ownerId}::uuid
          OR r.status = ANY(${opt.visibility.othersStatuses}::text[])
        )
        AND (
          ${pattern}::text IS NULL
          OR r.title ILIKE ${pattern} ESCAPE '\\'
          OR COALESCE(r.title_en, '') ILIKE ${pattern} ESCAPE '\\'
          OR COALESCE(r.description, '') ILIKE ${pattern} ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM resource_files f WHERE f.resource_id = r.id AND f.file_name ILIKE ${pattern} ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM dir_path d2 WHERE d2.id = r.directory_id AND d2.path ILIKE ${pattern} ESCAPE '\\')
        )
    `
    return rows[0].n
  }

  async getById(user: AuthUser, id: string) {
    const row = await this.requireResource(id)
    await this.assertCanActOn(user, 'resource.view', row)
    await this.assertCanViewResource(user, row)

    const files = await this.sql<
      { id: string; file_name: string; mime_type: string; size: string; sha256: string; created_at: Date }[]
    >`
      SELECT id, file_name, mime_type, size::text, sha256, created_at
      FROM resource_files WHERE resource_id = ${id} ORDER BY created_at
    `
    const uploader = row.uploader_id
      ? await this.sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${row.uploader_id}`
      : []
    const lastReject = await this.sql<{ comment: string | null }[]>`
      SELECT comment FROM resource_reviews
      WHERE resource_id = ${id} AND action = 'review.reject'
      ORDER BY created_at DESC LIMIT 1
    `

    // 能力位由服务端算：前端不写"我是不是上传者""我是不是管理员"。
    // 阶段 7 起这里不止 canEdit —— 详情页要按权限显示 提交 / 通过并发布 / 退回 / 撤回。
    const capabilities = await this.authz.resourceCapabilities(user, {
      id: row.id,
      status: row.status,
      directoryId: row.directory_id,
      uploaderId: row.uploader_id,
    })

    return {
      id: row.id,
      directoryId: row.directory_id,
      directoryPath: await this.pathOfDirectory(row.directory_id),
      title: row.title,
      titleEn: row.title_en,
      description: row.description,
      status: row.status as ResourceStatus,
      version: row.version,
      uploaderId: row.uploader_id,
      uploaderName: uploader[0]?.name ?? null,
      fileCount: files.length,
      hasFile: files.length > 0,
      reviewComment: lastReject[0]?.comment ?? null,
      capabilities,
      publishedAt: row.published_at?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      // ⚠️ 用与文件接口**同一份**映射。这里曾经自己 map 一遍，
      // 结果详情页少了 viewer / sizeLabel / previewMessage，
      // "此文件类型暂不支持在线预览"这句话在详情页是空的。
      files: files.map(toFileView),
    }
  }

  async reviewHistory(user: AuthUser, resourceId: string) {
    const row = await this.requireResource(resourceId)
    await this.assertCanActOn(user, 'resource.view', row)
    await this.assertCanViewResource(user, row)
    const rows = await this.sql<
      {
        id: string
        action: string
        from_status: string
        to_status: string
        comment: string | null
        created_at: Date
        actor_id: string | null
        actor_name: string | null
      }[]
    >`
      SELECT rr.id, rr.action, rr.from_status, rr.to_status, rr.comment, rr.created_at,
             rr.actor_id, u.name AS actor_name
      FROM resource_reviews rr LEFT JOIN users u ON u.id = rr.actor_id
      WHERE rr.resource_id = ${resourceId}
      -- 时间升序：这是**时间线**，最近发生的事在最后，读起来像一封信。
      -- 并列时用 id 兜底，保证顺序稳定（同一次请求两次结果一致）。
      ORDER BY rr.created_at ASC, rr.id ASC
    `
    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        // 动作的中文标签由服务端给：界面不该自己维护一份 action→中文 的映射
        // （那种映射迟早在两处漂移）。
        actionLabel: resourceActionLabel(r.action),
        fromStatus: r.from_status,
        toStatus: r.to_status,
        comment: r.comment,
        actorId: r.actor_id,
        actorName: r.actor_name,
        createdAt: r.created_at.toISOString(),
      })),
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 写
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 建资源。
   *
   * `directoryId` 是**必填**，且目录必须 `allowFiles = true` ——
   * 业主：「教师不填写班型/科目/资料夹/目录；系统已经知道 directoryId」。
   * 那些分类字段在 V2 的表里**根本不存在**。
   */
  async create(actor: AuthUser, input: {
    directoryId: string
    title: string
    titleEn?: string | null
    description?: string | null
  }) {
    const target = await this.sql<{ id: string; name: string; allow_files: boolean }[]>`
      SELECT id, name, allow_files FROM directories WHERE id = ${input.directoryId}
    `
    if (target.length === 0) throw AppError.notFound('目录不存在')
    if (!target[0].allow_files) {
      throw AppError.conflict(
        `「${target[0].name}」不是可以放资源的目录（它只做导航）`,
        'CONFLICT',
      )
    }
    // 停用的目录（或上级已停用）不能再往里放东西 —— 判定与目录模块共用同一份实现。
    if (!(await this.directories.isUsable(input.directoryId))) {
      throw AppError.conflict(
        `「${target[0].name}」已停用（或它的上级已停用），不能在这里新建资源`,
        'CONFLICT',
      )
    }

    const rows = await this.sql<ResourceRow[]>`
      INSERT INTO resources (directory_id, title, title_en, description, uploader_id)
      VALUES (${input.directoryId}, ${input.title}, ${input.titleEn ?? null},
              ${input.description ?? null}, ${actor.id})
      RETURNING *
    `

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.create',
      targetType: 'resource',
      targetId: rows[0].id,
      result: 'success',
      detail: { directoryId: input.directoryId, title: input.title },
    })
    return this.getById(actor, rows[0].id)
  }

  /**
   * 编辑资源。
   *
   * 已发布资源**不允许原地覆盖**：`version += 1` 并回到 `DRAFT`，重新走审核。
   * 这道规则来自 `editOutcomeFor()`，不是这里的 if。
   */
  async update(actor: AuthUser, id: string, input: {
    title?: string
    titleEn?: string | null
    description?: string | null
    directoryId?: string | null
  }) {
    const row = await this.requireResource(id)
    await this.assertCanActOn(actor, 'resource.update.own', row)

    if (!DELETABLE_STATUSES.includes(row.status as ResourceStatus) && row.status !== 'PUBLISHED') {
      throw AppError.conflict(`当前状态（${row.status}）不允许编辑`, 'ILLEGAL_TRANSITION')
    }

    const outcome = editOutcomeFor(row.status as ResourceStatus)

    const assignments: string[] = []
    const values: unknown[] = []
    const push = (col: string, v: unknown) => {
      values.push(v)
      assignments.push(`${col} = $${values.length}`)
    }
    if (input.title !== undefined) push('title', input.title)
    if (input.titleEn !== undefined) push('title_en', input.titleEn)
    if (input.description !== undefined) push('description', input.description)
    if (input.directoryId !== undefined && input.directoryId !== null) {
      const target = await this.sql<{ allow_files: boolean }[]>`
        SELECT allow_files FROM directories WHERE id = ${input.directoryId}
      `
      if (target.length === 0) throw AppError.notFound('目标目录不存在')
      if (!target[0].allow_files) throw AppError.conflict('目标目录不能放资源', 'CONFLICT')
      if (!(await this.directories.isUsable(input.directoryId))) {
        throw AppError.conflict('目标目录已停用（或它的上级已停用）', 'CONFLICT')
      }
      push('directory_id', input.directoryId)
    }
    if (outcome.bumpVersion) push('version', row.version + 1)
    push('status', outcome.status)

    values.push(id)
    const updated = (await this.sql.unsafe(
      `UPDATE resources SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $${values.length} RETURNING *`,
      values as never[],
    )) as unknown as ResourceRow[]

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.update',
      targetType: 'resource',
      targetId: id,
      result: 'success',
      detail: {
        changed: Object.keys(input),
        statusFrom: row.status,
        statusTo: updated[0].status,
        version: updated[0].version,
        publishedOverwritePrevented: row.status === 'PUBLISHED',
      },
    })

    /*
     * 编辑改变了状态（REJECTED→DRAFT / RECALLED→DRAFT / PUBLISHED→DRAFT）时，
     * 记录在**审计日志**里（上面那条 audit.write 的 statusFrom / statusTo），
     * 而**不**写进 resource_reviews。
     *
     * WHY 不写 resource_reviews：那张表的约束明确只允许四种**审核**动作
     * （submit / review.approve / review.reject / review.recall），
     * 它就是"审核流水"，不是"字段变更流水"。
     * 我第一版往里插了一条 'update'，被 CHECK 约束当场拦下（接口 500）——
     * 约束是对的，是我的分工想错了：字段变更属于审计日志。
     */
    return this.getById(actor, id)
  }

  /** 提交审核：`DRAFT|REJECTED → PENDING_REVIEW`。**必须有文件。** */
  async submit(actor: AuthUser, id: string) {
    const row = await this.requireResource(id)
    await this.assertCanActOn(actor, 'resource.submit', row, { requireOwner: true })

    // 业主 §18：**没有文件不能提交审核**（400，且给的是能照做的一句话）。
    //
    // 这里数的是 `resource_files` 的行数，而不是"资源上有个 hasFile 布尔"——
    // 行数来自真实登记过的对象（登记前校验过对象存在与哈希），
    // 所以"有文件"这件事本身是有据可查的。
    const files = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM resource_files WHERE resource_id = ${id}
    `
    if (files[0].n === 0) {
      throw AppError.badRequest('请先上传至少一个文件。', 'NO_FILE_TO_SUBMIT')
    }
    return this.transition(actor, id, 'PENDING_REVIEW', null)
  }

  /**
   * 审核裁决。**只接受 approve / reject** —— 撤回走 `recall()`，
   * 不允许通过这个接口改状态（业主：「审核操作不要混用」）。
   */
  async review(actor: AuthUser, id: string, action: 'approve' | 'reject', comment?: string | null) {
    const row = await this.requireResource(id)

    if (action === 'reject') {
      // 退回**必须**有原因：业主的原话是"教师之后必须能够看到退回原因"，
      // 一条没有原因的退回等于让老师自己去猜哪里不合格。
      if (!comment || comment.trim() === '') {
        throw AppError.badRequest('退回必须填写审核意见，教师需要知道哪里要改', 'COMMENT_REQUIRED')
      }
      await this.assertCanActOn(actor, 'resource.review', row, { forbidSelf: true })
      return this.transition(actor, id, 'REJECTED', comment.trim())
    }

    // 「通过并发布」是**一步**（业主 §14）：不再拆成"审核通过 → 再点发布"两道人工步骤。
    await this.assertCanActOn(actor, 'resource.publish', row, { forbidSelf: true })
    return this.transition(actor, id, 'PUBLISHED', comment?.trim() || null)
  }

  /**
   * 撤回：`PUBLISHED → RECALLED`。
   *
   * **绝不写进 reject**（业主从阶段 2 起反复强调"审核操作不要混用"）：
   * 如果撤回写成一次 reject，教师的「我的资源」里就会出现一条
   * **假的退回原因**，他会以为自己被否了。
   *
   * 撤回属于作者本人（管理员可越过所有权，走统一的 admin 绕过）。
   * 原因可选 —— 但给了就记进审核时间线，方便日后回答"这份东西为什么下架了"。
   */
  async recall(actor: AuthUser, id: string, comment?: string | null) {
    const row = await this.requireResource(id)
    // 撤回属于作者：所有权与目录范围都在统一授权里判定。
    await this.assertCanActOn(actor, 'resource.submit', row, { requireOwner: true })
    return this.transition(actor, id, 'RECALLED', comment?.trim() ? comment.trim() : null)
  }

  async softDelete(actor: AuthUser, id: string) {
    const row = await this.requireResource(id)
    await this.assertCanActOn(actor, 'resource.delete.own', row)
    /*
      ⚠️ 这里**必须**检查返回值。第一版写成 `await this.assertDeletable(...)` 就直接往下删了 ——
      于是"普通教师不能删已发布的"这条规则在单条 `DELETE` 这条路上**完全失效**
      （集成测试抓到了：老师删自己那条已发布的资源返回了 200）。
      "名字带 assert、实际只返回原因"是最容易被读漏的一种形状，所以这里把原因显式抛出去。
    */
    const blocked = await this.assertDeletable(actor, row, id)
    if (blocked !== null) {
      throw AppError.conflict(blocked.message, blocked.reason)
    }
    const updated = await this.sql<{ id: string }[]>`
      UPDATE resources SET deleted_at = now(), updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING id
    `
    if (updated.length === 0) {
      throw AppError.conflict('资源已经被删除过了', 'ILLEGAL_TRANSITION')
    }
    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.delete',
      targetType: 'resource',
      targetId: id,
      result: 'success',
      detail: { status: row.status, forcedPublished: row.status === 'PUBLISHED' },
    })
    return { ok: true, id }
  }

  /**
   * 这条资源现在能不能被软删除？不能的话抛 409（单个）或返回 null（批量）。
   *
   * 规则（业主 2026-10-15 的决定）：
   *   · `DELETABLE_STATUSES` 里的状态 —— 上传者本人（或管理员）直接删；
   *   · **已发布** —— 普通角色仍然必须先撤回（照旧）；
   *     但**超级管理员可以直接删**，代价是先把这条记为「已撤回」再进回收站
   *     （见 `recallForForcedDelete`）。
   *
   * 为什么超管这条路要"先记为已撤回"而不是只写 `deleted_at`：
   *   1. 审核时间线里留下"这东西为什么下线了"；
   *   2. 从回收站**恢复之后是「已撤回」**，不会一恢复就重新对全园可见 ——
   *      恢复一个被下线的已发布内容，本来就不该等于重新发布。
   *
   * @returns 给批量路径用的失败原因（成功返回 null）
   */
  private async assertDeletable(
    actor: AuthUser,
    row: ResourceRow,
    id: string,
  ): Promise<{ reason: string; message: string } | null> {
    const status = row.status as ResourceStatus
    if (DELETABLE_STATUSES.includes(status)) return null

    if (status !== 'PUBLISHED') {
      // 理论上到不了：DELETABLE_STATUSES 之外只有 PUBLISHED。
      // 留着是为了将来加状态时**默认拒绝**，而不是默认放行。
      return {
        reason: 'ILLEGAL_TRANSITION',
        message: `这个状态不能直接删除（当前状态：${status}）`,
      }
    }

    if (!this.authz.isSuperAdmin(actor)) {
      return { reason: 'ILLEGAL_TRANSITION', message: '已发布的资源不能直接删除，请先撤回' }
    }

    const recalled = await this.recallForForcedDelete(actor, id)
    if (!recalled) {
      return { reason: 'CONFLICT', message: '资源状态刚刚被别人改过，请刷新后重试' }
    }
    return null
  }

  /**
   * 把一条**已发布**的资源记为「已撤回」—— 超级管理员直接删除已发布内容时的第一步。
   *
   * 条件更新（`WHERE status = 'PUBLISHED'`）保证并发下只有一个人能记上；
   * 记不上就返回 false，由调用方如实报"跳过"，绝不硬删。
   */
  private async recallForForcedDelete(actor: AuthUser, id: string): Promise<boolean> {
    const updated = await this.sql<{ id: string }[]>`
      UPDATE resources
      SET status = 'RECALLED', updated_at = now()
      WHERE id = ${id} AND status = 'PUBLISHED' AND deleted_at IS NULL
      RETURNING id
    `
    if (updated.length === 0) return false

    await this.sql`
      INSERT INTO resource_reviews (resource_id, actor_id, action, from_status, to_status, comment)
      VALUES (${id}, ${actor.id}, 'review.recall', 'PUBLISHED', 'RECALLED',
              ${'超级管理员直接删除已发布资源（自动记为已撤回）'})
    `
    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.recall',
      targetType: 'resource',
      targetId: id,
      result: 'success',
      detail: { from: 'PUBLISHED', to: 'RECALLED', via: 'force-delete' },
    })
    return true
  }

  /**
   * 批量**软**删除（进回收站、**可恢复**）。超级管理员专用。
   *
   * 与 `softDelete()` 是同一件事的批量形态：同样的状态规则
   * （`DELETABLE_STATUSES`）、同样的条件更新、同样的审计动作
   * （`resource.delete`），只是把"失败"翻译成逐条结果。
   *
   * ── 为什么必须逐条 ──────────────────────────────────────────────────────
   * 批量操作的现实是"部分成功"：选中的 10 条里可能有 1 条已发布、1 条刚被别人删了。
   * 所以返回值必须能让调用方分清 **成功 / 跳过 / 失败**，
   * 而不是一个 `ok: true` —— 那会让界面把"9 条没删掉"显示成"全部删除成功"。
   *
   * ── 安全边界 ────────────────────────────────────────────────────────────
   * · 身份：只有超级管理员。控制器已有 `@RequireSuperAdmin()`，这里再判一次
   *   （纵深防御：直接调 service 的路径也绕不过去）。
   * · 授权：逐条仍走 `assertCanActOn()` —— 唯一授权入口，不在批量路径上另开一套。
   * · **不碰对象存储**：只写 `deleted_at`。文件对象、审核历史、审计全部保留，
   *   回收站里能恢复。永久删除是另一个接口（`purge`），门槛更高。
   */
  async bulkSoftDelete(actor: AuthUser, ids: readonly string[]): Promise<BulkDeleteResult> {
    this.authz.assertSuperAdmin(actor, '批量删除资源')

    // 去重但保留首次出现的顺序 —— 结果要能按调用方给的顺序核对。
    const unique = [...new Set(ids)]

    const items: BulkDeleteItemResult[] = []
    for (const id of unique) {
      items.push(await this.softDeleteOne(actor, id))
    }

    const count = (outcome: BulkDeleteItemResult['outcome']) =>
      items.filter((i) => i.outcome === outcome).length

    return {
      requested: ids.length,
      unique: unique.length,
      duplicated: ids.length - unique.length,
      deleted: count('deleted'),
      skipped: count('skipped'),
      failed: count('failed'),
      items,
    }
  }

  /**
   * 批量删除里的**单条**。
   *
   * 规则与 `softDelete()` 完全一致，唯一区别是**把失败翻译成结果对象**而不是抛异常：
   * 批量操作必须逐条如实 —— 一条不合法不能让整批看起来全失败，
   * 一条成功也不能让整批看起来全成功。
   */
  private async softDeleteOne(actor: AuthUser, id: string): Promise<BulkDeleteItemResult> {
    try {
      // 这里不复用 `requireResource()`：它遇到"不存在"会抛 404，
      // 而批量场景要的是"这一条跳过、其余照常"。
      const rows = await this.sql<ResourceRow[]>`
        SELECT * FROM resources WHERE id = ${id}
      `
      if (rows.length === 0) {
        return { id, outcome: 'skipped', reason: 'NOT_FOUND', message: '资源不存在' }
      }
      const row = rows[0]
      if (row.deleted_at !== null) {
        return { id, outcome: 'skipped', reason: 'ALREADY_DELETED', message: '资源已在回收站中' }
      }
      // 唯一授权入口：所有权 / 目录范围 / 管理员绕过都在 AuthorizationService 里判。
      await this.assertCanActOn(actor, 'resource.delete.own', row)

      /*
        能不能删由 `assertDeletable()` 一处判定（单个与批量共用）——
        已发布的资源：普通角色跳过，超级管理员**先记为已撤回**再删。
        判定失败返回原因而不是抛异常：批量要逐条如实。
      */
      const blocked = await this.assertDeletable(actor, row, id)
      if (blocked !== null) {
        return { id, outcome: 'skipped', reason: blocked.reason, message: blocked.message }
      }

      /*
        条件更新是**并发安全**的关键：`WHERE deleted_at IS NULL` 保证两个同时到达的
        请求里只有一个能改到行，另一个拿到 0 行 → 报"跳过 · 并发抢先"。
        没有它，两个请求都会回"成功"，而其中一次什么也没做。
      */
      const updated = await this.sql<{ id: string }[]>`
        UPDATE resources SET deleted_at = now(), updated_at = now()
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING id
      `
      if (updated.length === 0) {
        return { id, outcome: 'skipped', reason: 'CONFLICT', message: '资源已被并发删除' }
      }

      await this.audit.write({
        actorId: actor.id,
        actorName: actor.name,
        action: 'resource.delete',
        targetType: 'resource',
        targetId: id,
        result: 'success',
        detail: { status: row.status, via: 'bulk', forcedPublished: row.status === 'PUBLISHED' },
      })
      return {
        id,
        outcome: 'deleted',
        reason: null,
        // 已发布的那条要如实说明"先记成了已撤回"，否则管理员会以为删完还能原样恢复上线
        message: row.status === 'PUBLISHED' ? '已记为「已撤回」并移入回收站' : '已移入回收站',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      // 失败也留痕：批量里"这一条为什么没删掉"必须能从审计里查得到。
      // `AuditService.write` 自己吞掉写失败，不会盖掉这里的真实原因。
      await this.audit.write({
        actorId: actor.id,
        actorName: actor.name,
        action: 'resource.delete',
        targetType: 'resource',
        targetId: id,
        result: 'failed',
        detail: { via: 'bulk', reason: message },
      })
      return { id, outcome: 'failed', reason: 'ERROR', message }
    }
  }

  /**
   * 批量**强制修改状态**（超级管理员专用，业主 2026-10-15 新增）。
   *
   * ── 它和六条合法转换是什么关系 ────────────────────────────────────────────
   * **完全不同的两条路**。`submit / approve / reject / recall` 那六条是**流程**：
   * 每条都有前置状态、有权限码、有所有权要求，只能一格一格走。
   * 这里是**管理员的强制覆盖**：不查 `TRANSITIONS`，五个状态里任何一个都能设。
   *
   * 之所以敢开这个口子，是因为它被三件事围住：
   *   1. **身份**：控制器与 service 双层 `assertSuperAdmin()`；普通角色连门都进不来，
   *      他们走的仍然是原来的六条转换（一个字没改）；
   *   2. **留痕**：审计写 `resource.status.force`（与流程动作分开的独立动作名），
   *      并写进 `resource_reviews` 时间线 —— "这一步是走流程还是有人直接改的"一眼可辨；
   *   3. **代价明确**：退回必须写原因（否则教师端只看到"已退回"不知道为什么），
   *      改成已发布在界面上要**二次确认**（那一步绕过审核）。
   *
   * 逐条如实：与批量删除同一套结果语义（成功 / 跳过 / 失败），
   * 一条不合法不让整批看起来全失败，一条成功也不让整批看起来全成功。
   */
  async bulkForceStatus(
    actor: AuthUser,
    ids: readonly string[],
    status: ResourceStatus,
    comment: string | null,
  ): Promise<BulkStatusResult> {
    this.authz.assertSuperAdmin(actor, '批量修改资源状态')

    if (!RESOURCE_STATUSES.includes(status)) {
      throw AppError.badRequest('目标状态不合法', 'VALIDATION_FAILED')
    }

    const unique = [...new Set(ids)]
    const items: BulkStatusItemResult[] = []
    for (const id of unique) {
      items.push(await this.forceStatusOne(actor, id, status, comment))
    }

    const count = (outcome: BulkStatusItemResult['outcome']) =>
      items.filter((i) => i.outcome === outcome).length

    return {
      requested: ids.length,
      unique: unique.length,
      duplicated: ids.length - unique.length,
      updated: count('updated'),
      skipped: count('skipped'),
      failed: count('failed'),
      status,
      items,
    }
  }

  /**
   * 强制改状态里的**单条**。
   *
   * 与 `softDeleteOne()` 同构：不抛异常，把结局翻译成结果对象。
   */
  private async forceStatusOne(
    actor: AuthUser,
    id: string,
    to: ResourceStatus,
    commentFromCaller: string | null,
  ): Promise<BulkStatusItemResult> {
    const skip = (reason: string, message: string): BulkStatusItemResult => ({
      id,
      outcome: 'skipped',
      reason,
      message,
      from: null,
      to: null,
    })
    try {
      const rows = await this.sql<ResourceRow[]>`SELECT * FROM resources WHERE id = ${id}`
      if (rows.length === 0) return skip('NOT_FOUND', '资源不存在')
      const row = rows[0]
      if (row.deleted_at !== null) {
        return skip('ALREADY_DELETED', '资源已在回收站中，请先恢复再改状态')
      }

      const from = row.status as ResourceStatus
      if (from === to) return skip('NO_CHANGE', `已经是「${RESOURCE_STATUS_LABEL[to]}」`)

      // 授权仍然走唯一入口（超级管理员在 AuthorizationService 里被放行，
      // 但这条调用保证了"将来放开给别的角色"时不会绕开判定）。
      await this.assertCanActOn(actor, 'resource.update.own', row)

      const trimmed = commentFromCaller?.trim() ?? ''
      if (FORCE_STATUS_REQUIRES_COMMENT.includes(to) && trimmed === '') {
        // 数据库上也有同名 CHECK 约束（resource_reviews_reject_needs_comment）
        // —— 这里先挡住是为了给出**可读**的逐条结果，而不是让整条 insert 报错。
        return skip('COMMENT_REQUIRED', '退回必须写原因（教师端要能看到）')
      }
      const comment =
        trimmed !== ''
          ? trimmed
          : `${FORCE_STATUS_COMMENT_PREFIX}：${RESOURCE_STATUS_LABEL[from]} → ${RESOURCE_STATUS_LABEL[to]}`

      const reviewAction = FORCE_STATUS_REVIEW_ACTION[to]
      const publishedAt = to === 'PUBLISHED' ? new Date() : row.published_at

      // 条件更新：并发下只有一个人能改到这一行，另一个如实报"跳过"。
      const updated = await this.sql<ResourceRow[]>`
        UPDATE resources
        SET status = ${to}, published_at = ${publishedAt}, updated_at = now()
        WHERE id = ${id} AND status = ${from} AND deleted_at IS NULL
        RETURNING *
      `
      if (updated.length === 0) return skip('CONFLICT', '状态刚刚被别人改过，请刷新后重试')

      /*
        写审核时间线。
        `resource_reviews.action` 有 CHECK 约束，只接受
        submit / review.approve / review.reject / review.recall 四种，
        所以"改成草稿"没有对应的流程动作（`FORCE_STATUS_REVIEW_ACTION.DRAFT === null`）
        —— 那一步本来就只该留在审计里（教师编辑回草稿走的也是 resource.update 审计）。
      */
      if (reviewAction !== null) {
        await this.sql`
          INSERT INTO resource_reviews (resource_id, actor_id, action, from_status, to_status, comment)
          VALUES (${id}, ${actor.id}, ${reviewAction}, ${from}, ${to}, ${comment})
        `
      }

      await this.audit.write({
        actorId: actor.id,
        actorName: actor.name,
        action: 'resource.status.force',
        targetType: 'resource',
        targetId: id,
        result: 'success',
        detail: { from, to, comment, via: 'bulk', reviewAction },
      })

      return {
        id,
        outcome: 'updated',
        reason: null,
        message: `${RESOURCE_STATUS_LABEL[from]} → ${RESOURCE_STATUS_LABEL[to]}`,
        from,
        to,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      await this.audit.write({
        actorId: actor.id,
        actorName: actor.name,
        action: 'resource.status.force',
        targetType: 'resource',
        targetId: id,
        result: 'failed',
        detail: { to, via: 'bulk', reason: message },
      })
      return { id, outcome: 'failed', reason: 'ERROR', message, from: null, to: null }
    }
  }

  /**
   * 恢复。
   *
   * 原目录已被删除时**明确报错**，而不是把资源恢复到一个看不见的地方 ——
   * V1 的 `RestoreOutcome` 枚举已经证明了这条分支是必要的。
   */
  async restore(actor: AuthUser, id: string) {
    const row = await this.requireResource(id, { allowDeleted: true })
    if (row.deleted_at === null) throw AppError.conflict('资源没有被删除', 'CONFLICT')
    await this.assertCanActOn(actor, 'resource.delete.own', row)

    const dir = await this.sql<{ id: string; name: string; enabled: boolean }[]>`
      SELECT id, name, enabled FROM directories WHERE id = ${row.directory_id}
    `
    if (dir.length === 0 || !dir[0].enabled) {
      throw AppError.conflict(
        `原目录已不存在或已停用，请先恢复/启用目标目录再恢复这条资源`,
        'CONFLICT',
      )
    }

    await this.sql`UPDATE resources SET deleted_at = NULL, updated_at = now() WHERE id = ${id}`
    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.restore',
      targetType: 'resource',
      targetId: id,
      result: 'success',
      detail: { directoryId: row.directory_id },
    })
    return { ok: true, id }
  }

  /**
   * 永久删除：**数据库行 + 对象存储文件 + 审计**，三件都必须真的发生。
   *
   * 生命周期文档第 11 行：`软删除 → 永久删除`，门槛是 `resource.purge`（仅 ADMIN）。
   * 所以这里有两道**服务端**约束，缺一不可：
   *
   *   ① 身份：只有超级管理员。控制器上已有 `@RequireSuperAdmin()`，
   *      这里再判一次是**纵深防御** —— 任何直接调 service 的路径也绕不过去。
   *   ② 状态：**只处理回收站里的资源**（`deleted_at IS NOT NULL`）。
   *      以前传的是 `allowDeleted: true`，那是"允许"而不是"要求"，
   *      于是没进回收站的资源也能被一步抹掉，正好绕过软删除这一步。
   *
   * ── 存储一致性（2026-10-12 修复）─────────────────────────────────────────
   * 修复前这段有三个叠加缺陷：
   *   · `head()` / `delete()` 都是 `async`，却**没有 await** ——
   *     `Promise !== null` 恒为真（那个判断形同虚设），删对象在后台异步跑，
   *     返回的 Promise 被丢弃（失败会变成 unhandled rejection）；
   *   · `catch {}` **吞掉所有异常**，把"存储不可用 / 权限错误"
   *     一律当成"对象不存在"放行；
   *   · 于是**对象没删掉，数据库记录却已经删了** ——
   *     R2 上留下永远无法回收的孤儿文件（生命周期文档明令禁止），
   *     而界面显示的是"删除成功"。
   *
   * 现在的规则（与 `files.service` 那条注释同一条）：
   *   1. **先删对象，再删数据库行**。反过来则存储失败时记录已删，孤儿无人认领。
   *   2. `head()` 返回 `null` = 对象本就不在 → **幂等**，跳过并继续；
   *      `head()` / `delete()` **抛异常** = 真实故障 → 整体失败，不碰数据库。
   *   3. 删完数据库行后**回查对象是否真的不在了** —— 把"承诺"变成"核验"。
   */
  async purge(actor: AuthUser, id: string) {
    this.authz.assertSuperAdmin(actor, '永久删除资源')

    const row = await this.requireResource(id, { allowDeleted: true })
    await this.assertCanActOn(actor, 'resource.delete.own', row)

    /*
      「永久删除」的前置条件：目标必须**已经在回收站里**（`deleted_at` 非空）。

      为什么要这条：`purge` 是不可逆的（删行 + 删对象）。业主的规则是
      「已发布的资源要先撤回、再删除」——那次删除是软删除、**可恢复**的。
      有了这条前置条件，"永久删除"就永远是**软删除之后的第二步**，
      而不是一次调用就能把线上正在用的东西直接抹掉。

      界面侧不提供 purge 入口（阶段 8 的范围决定），所以这条只影响直接调
      API 的运维脚本：先 `DELETE /api/resources/:id`，再 `POST :id/purge`。
    */
    if (row.deleted_at === null) {
      throw AppError.conflict(
        '只能永久删除回收站里的资源：请先删除（进回收站），再永久删除',
        'RESOURCE_NOT_IN_RECYCLE_BIN',
      )
    }

    const files = await this.sql<{ storage_key: string }[]>`
      SELECT storage_key FROM resource_files WHERE resource_id = ${id}
    `

    // ① 先把对象删干净。任何一步抛异常都在这里中止 —— 数据库记录保持不动。
    let removedObjects = 0
    let alreadyMissing = 0
    for (const f of files) {
      const stat = await this.storage.head(f.storage_key)
      if (stat === null) {
        // 对象本来就不在：这是**幂等**情形（上次删到一半、或人工清理过），
        // 不是故障。只有这一种情况允许继续。
        alreadyMissing += 1
        continue
      }
      await this.storage.delete(f.storage_key)
      removedObjects += 1
    }

    // ② 条件删除数据库行。影响 0 行 → 报错，绝不写"成功"。
    const deleted = await this.sql<{ id: string }[]>`
      DELETE FROM resources WHERE id = ${id} RETURNING id
    `
    if (deleted.length === 0) {
      throw AppError.conflict('永久删除没有生效（资源可能已被删除）', 'CONFLICT')
    }

    // ③ 回查：数据库记录已删，关联对象是不是真的不在了。
    const leftover: string[] = []
    for (const f of files) {
      if ((await this.storage.head(f.storage_key)) !== null) leftover.push(f.storage_key)
    }

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.purge',
      targetType: 'resource',
      targetId: id,
      // 核验没过就不写 success —— 审计说"成功"而桶里还有东西，是最坏的一种记录。
      result: leftover.length === 0 ? 'success' : 'failed',
      detail: {
        title: row.title,
        removedFiles: files.length,
        removedObjects,
        alreadyMissing,
        leftoverObjects: leftover.length,
      },
    })

    if (leftover.length > 0) {
      // 记录已删但对象仍在：如实报错。返回"成功"会把孤儿的排查线索一起丢掉。
      throw AppError.serviceUnavailable(
        `资源记录已永久删除，但有 ${leftover.length} 个文件对象未能确认清理，请检查对象存储`,
        'STORAGE_UNAVAILABLE',
      )
    }

    return { ok: true, removedFiles: files.length, removedObjects }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 状态机
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 执行一次状态转换。
   *
   * 两步都不可缺少：
   *   1. 查表确认这次转换合法（不合法 → 409，且写审计）；
   *   2. **条件更新** `WHERE status = <from>`，影响 0 行 → 409。
   *      第 2 步挡住的是并发（两个审核员同时点"通过"）。
   */
  private async transition(
    actor: AuthUser,
    id: string,
    to: ResourceStatus,
    comment: string | null,
  ) {
    const row = await this.requireResource(id)
    const from = row.status as ResourceStatus
    const spec = findTransition(from, to)
    if (spec === undefined) {
      // 非法转换也要留痕：它是"有人在绕过流程"的信号，不能只回一个 409。
      await this.audit.write({
        actorId: actor.id,
        actorName: actor.name,
        action: 'resource.update',
        targetType: 'resource',
        targetId: id,
        result: 'failed',
        detail: { reason: 'ILLEGAL_TRANSITION', from, to },
      })
      throw AppError.conflict(
        `不允许从「${RESOURCE_STATUS_LABEL[from]}」直接变成「${RESOURCE_STATUS_LABEL[to]}」`,
        'ILLEGAL_TRANSITION',
      )
    }

    // 所有权在这里也用**同一个**入口判定 —— 状态机只决定"这条转换是否合法"。
    if (spec.requireOwner) {
      await this.assertCanActOn(actor, spec.permission as PermissionCode, row, {
        requireOwner: true,
      })
    }

    const publishedAt = to === 'PUBLISHED' ? new Date() : row.published_at
    const updated = await this.sql<ResourceRow[]>`
      UPDATE resources
      SET status = ${to}, published_at = ${publishedAt}, updated_at = now()
      WHERE id = ${id} AND status = ${from}
      RETURNING *
    `
    if (updated.length === 0) {
      throw AppError.conflict(
        '状态已经被别人改过了，请刷新后重试',
        'ILLEGAL_TRANSITION',
      )
    }

    await this.sql`
      INSERT INTO resource_reviews (resource_id, actor_id, action, from_status, to_status, comment)
      VALUES (${id}, ${actor.id}, ${spec.action}, ${from}, ${to}, ${comment})
    `

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      // 审计动作名只由这一张映射决定（见 shared/resource-status.ts）。
      action: ACTION_AUDIT_NAME[spec.action],
      targetType: 'resource',
      targetId: id,
      result: 'success',
      detail: { from, to, comment: comment ?? undefined },
    })

    return this.getById(actor, id)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 内部
  // ─────────────────────────────────────────────────────────────────────────

  private async requireResource(
    id: string,
    options: { allowDeleted?: boolean } = {},
  ): Promise<ResourceRow> {
    const rows = await this.sql<ResourceRow[]>`
      SELECT * FROM resources WHERE id = ${id}
    `
    if (rows.length === 0) throw AppError.notFound('资源不存在')
    if (rows[0].deleted_at !== null && options.allowDeleted !== true) {
      throw AppError.notFound('资源不存在')
    }
    return rows[0]
  }

  /**
   * 唯一的资源级授权入口。
   *
   * **它只是转发到 AuthorizationService** —— 这里不再有任何
   * `uploader_id !== actor.id` 或 `role === 'ADMIN'` 的判断。
   * 所有权、目录范围、管理员绕过全部在那一个地方决定。
   */
  private async assertCanActOn(
    actor: AuthUser,
    permission: PermissionCode,
    row: ResourceRow,
    options: { requireOwner?: boolean; forbidSelf?: boolean } = {},
  ): Promise<void> {
    const decision = await this.authz.canActOnResource(
      actor,
      permission,
      { id: row.id, directoryId: row.directory_id, uploaderId: row.uploader_id },
      options,
    )
    if (decision.allowed) return

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'authz.denied',
      targetType: 'resource',
      targetId: row.id,
      result: 'denied',
      detail: {
        permission,
        directoryId: row.directory_id,
        reason: decision.reason,
      },
    })
    throw AppError.forbidden(deniedMessage(decision.reason, permission), 'FORBIDDEN')
  }

  async subtreeIds(directoryId: string): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      WITH RECURSIVE reach AS (
        SELECT id FROM directories WHERE id = ${directoryId}
        UNION ALL
        SELECT d.id FROM directories d JOIN reach r ON d.parent_id = r.id
      )
      SELECT id FROM reach
    `
    return rows.map((r) => r.id)
  }

  private async pathOfDirectory(id: string): Promise<string> {
    const rows = await this.sql<{ slug: string; depth: number }[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, slug, 1 AS depth FROM directories WHERE id = ${id}
        UNION ALL
        SELECT d.id, d.parent_id, d.slug, up.depth + 1
        FROM directories d JOIN up ON d.id = up.parent_id
      )
      SELECT slug, depth FROM up ORDER BY depth DESC
    `
    return rows.map((r) => r.slug).join('/')
  }
}
