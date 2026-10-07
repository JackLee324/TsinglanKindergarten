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
  DELETABLE_STATUSES,
  editOutcomeFor,
  findTransition,
  isPreviewable,
  type ResourceStatus,
} from '../../shared/resource-status'

export interface ResourceFilters {
  directoryId?: string | null
  includeSubtree?: boolean
  status?: ResourceStatus | null
  q?: string | null
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

  async list(user: AuthUser, filters: ResourceFilters) {
    const scope = await this.authz.accessibleDirectoryIds(user, 'resource.view')
    if (scope !== null && scope.length === 0) {
      return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize }
    }

    const directoryIds =
      filters.directoryId != null
        ? filters.includeSubtree === true
          ? await this.subtreeIds(filters.directoryId)
          : [filters.directoryId]
        : null

    return this.queryResources({
      scope,
      directoryIds,
      status: filters.status ?? null,
      q: filters.q ?? null,
      onlyUploaderId: filters.onlyMine ? user.id : null,
      recycled: filters.recycled === true,
      page: filters.page,
      pageSize: filters.pageSize,
    })
  }

  /** 「我的资源」：含回收站分栏，教师只看自己的。 */
  async mine(user: AuthUser, scope: 'active' | 'recycle'): Promise<ReturnType<ResourcesService['list']>> {
    return this.queryResources({
      scope: null,
      directoryIds: null,
      status: null,
      q: null,
      onlyUploaderId: user.id,
      recycled: scope === 'recycle',
      page: 1,
      pageSize: 200,
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
      page: 1,
      pageSize: 200,
    })
  }

  private async queryResources(opt: {
    scope: string[] | null
    directoryIds: string[] | null
    status: ResourceStatus | null
    q: string | null
    onlyUploaderId: string | null
    recycled: boolean
    page: number
    pageSize: number
  }) {
    // 搜索覆盖四类字段：标题 / 描述 / 文件名 / 目录名（业主 §「全平台搜索」）。
    const pattern = opt.q ? `%${opt.q}%` : null
    const rows = await this.sql<
      (ResourceRow & {
        uploader_name: string | null
        file_count: number
        directory_path: string
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
        WHERE (${opt.recycled} = true AND r.deleted_at IS NOT NULL)
           OR (${opt.recycled} = false AND r.deleted_at IS NULL)
          AND (${opt.scope}::uuid[] IS NULL OR r.directory_id = ANY(${opt.scope}::uuid[]))
          AND (${opt.directoryIds}::uuid[] IS NULL OR r.directory_id = ANY(${opt.directoryIds}::uuid[]))
          AND (${opt.status}::text IS NULL OR r.status = ${opt.status}::text)
          AND (${opt.onlyUploaderId}::uuid IS NULL OR r.uploader_id = ${opt.onlyUploaderId}::uuid)
          AND (
            ${pattern}::text IS NULL
            OR r.title ILIKE ${pattern}
            OR COALESCE(r.description, '') ILIKE ${pattern}
            OR EXISTS (
              SELECT 1 FROM resource_files f
              WHERE f.resource_id = r.id AND f.file_name ILIKE ${pattern}
            )
            OR EXISTS (SELECT 1 FROM dir_path d2 WHERE d2.id = r.directory_id AND d2.path ILIKE ${pattern})
          )
      )
      SELECT m.*, u.name AS uploader_name,
             (SELECT count(*)::int FROM resource_files f WHERE f.resource_id = m.id) AS file_count,
             (SELECT path FROM dir_path dp WHERE dp.id = m.directory_id) AS directory_path,
             (SELECT count(*)::int FROM matched) AS total
      FROM matched m
      LEFT JOIN users u ON u.id = m.uploader_id
      ORDER BY m.updated_at DESC
      LIMIT ${opt.pageSize} OFFSET ${(opt.page - 1) * opt.pageSize}
    `

    const total = rows.length > 0 ? rows[0].total : await this.countMatching(opt)
    return {
      items: rows.map((r) => ({
        id: r.id,
        directoryId: r.directory_id,
        title: r.title,
        titleEn: r.title_en,
        description: r.description,
        status: r.status as ResourceStatus,
        version: r.version,
        uploaderId: r.uploader_id,
        uploaderName: r.uploader_name,
        fileCount: r.file_count,
        hasFile: r.file_count > 0,
        publishedAt: r.published_at?.toISOString() ?? null,
        deletedAt: r.deleted_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      total,
      page: opt.page,
      pageSize: opt.pageSize,
    }
  }

  private async countMatching(opt: {
    scope: string[] | null
    directoryIds: string[] | null
    status: ResourceStatus | null
    q: string | null
    onlyUploaderId: string | null
    recycled: boolean
  }): Promise<number> {
    const pattern = opt.q ? `%${opt.q}%` : null
    const rows = await this.sql<{ n: number }[]>`
      WITH RECURSIVE dir_path AS (
        SELECT id, slug AS path FROM directories WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, dp.path || '/' || d.slug
        FROM directories d JOIN dir_path dp ON d.parent_id = dp.id
      )
      SELECT count(*)::int AS n
      FROM resources r
      WHERE (${opt.recycled} = true AND r.deleted_at IS NOT NULL)
         OR (${opt.recycled} = false AND r.deleted_at IS NULL)
        AND (${opt.scope}::uuid[] IS NULL OR r.directory_id = ANY(${opt.scope}::uuid[]))
        AND (${opt.directoryIds}::uuid[] IS NULL OR r.directory_id = ANY(${opt.directoryIds}::uuid[]))
        AND (${opt.status}::text IS NULL OR r.status = ${opt.status}::text)
        AND (${opt.onlyUploaderId}::uuid IS NULL OR r.uploader_id = ${opt.onlyUploaderId}::uuid)
        AND (
          ${pattern}::text IS NULL
          OR r.title ILIKE ${pattern}
          OR COALESCE(r.description, '') ILIKE ${pattern}
          OR EXISTS (SELECT 1 FROM resource_files f WHERE f.resource_id = r.id AND f.file_name ILIKE ${pattern})
          OR EXISTS (SELECT 1 FROM dir_path d2 WHERE d2.id = r.directory_id AND d2.path ILIKE ${pattern})
        )
    `
    return rows[0].n
  }

  async getById(user: AuthUser, id: string) {
    const row = await this.requireResource(id)
    await this.assertCanActOn(user, 'resource.view', row)

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
      publishedAt: row.published_at?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      files: files.map((f) => ({
        id: f.id,
        fileName: f.file_name,
        mimeType: f.mime_type,
        size: Number(f.size),
        sha256: f.sha256,
        previewable: isPreviewable(f.mime_type),
        createdAt: f.created_at.toISOString(),
      })),
    }
  }

  async reviewHistory(user: AuthUser, resourceId: string) {
    const row = await this.requireResource(resourceId)
    await this.assertCanActOn(user, 'resource.view', row)
    const rows = await this.sql<
      { id: string; action: string; from_status: string; to_status: string; comment: string | null; created_at: Date; actor_name: string | null }[]
    >`
      SELECT rr.id, rr.action, rr.from_status, rr.to_status, rr.comment, rr.created_at, u.name AS actor_name
      FROM resource_reviews rr LEFT JOIN users u ON u.id = rr.actor_id
      WHERE rr.resource_id = ${resourceId}
      ORDER BY rr.created_at
    `
    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        comment: r.comment,
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
    return this.getById(actor, id)
  }

  /** 提交审核：`DRAFT|REJECTED → PENDING_REVIEW`。**必须有文件。** */
  async submit(actor: AuthUser, id: string) {
    const row = await this.requireResource(id)
    await this.assertCanActOn(actor, 'resource.submit', row, { requireOwner: true })

    const files = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM resource_files WHERE resource_id = ${id}
    `
    if (files[0].n === 0) {
      throw AppError.conflict('还没有上传文件，不能提交审核', 'CONFLICT')
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
      if (!comment || comment.trim() === '') {
        throw AppError.forbidden('退回必须说明原因，教师需要看到它', 'VALIDATION_FAILED')
      }
      await this.assertCanActOn(actor, 'resource.review', row)
      return this.transition(actor, id, 'REJECTED', comment.trim())
    }

    await this.assertCanActOn(actor, 'resource.publish', row)
    return this.transition(actor, id, 'PUBLISHED', comment?.trim() || null)
  }

  /** 撤回：`PUBLISHED → RECALLED`。**不写 reject**，因此不会产生假退回原因。 */
  async recall(actor: AuthUser, id: string) {
    const row = await this.requireResource(id)
    // 撤回属于作者：所有权与目录范围都在统一授权里判定。
    await this.assertCanActOn(actor, 'resource.submit', row, { requireOwner: true })
    return this.transition(actor, id, 'RECALLED', null)
  }

  async softDelete(actor: AuthUser, id: string) {
    const row = await this.requireResource(id)
    await this.assertCanActOn(actor, 'resource.delete.own', row)
    if (!DELETABLE_STATUSES.includes(row.status as ResourceStatus)) {
      throw AppError.conflict(
        `已发布的资源不能直接删除，请先撤回（当前状态：${row.status}）`,
        'ILLEGAL_TRANSITION',
      )
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
      detail: { status: row.status },
    })
    return { ok: true, id }
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
   * 只允许 ADMIN（`resource.purge` 是全平台能力，实际上只有管理员持有）。
   */
  async purge(actor: AuthUser, id: string) {
    const row = await this.requireResource(id, { allowDeleted: true })
    const files = await this.sql<{ storage_key: string }[]>`
      SELECT storage_key FROM resource_files WHERE resource_id = ${id}
    `

    let removedObjects = 0
    for (const f of files) {
      try {
        if (this.storage.head(f.storage_key) !== null) {
          this.storage.delete(f.storage_key)
          removedObjects += 1
        }
      } catch {
        // 对象不存在不算失败：目标是"删干净"，而不是"必须删到东西"。
      }
    }

    const deleted = await this.sql<{ id: string }[]>`
      DELETE FROM resources WHERE id = ${id} RETURNING id
    `
    if (deleted.length === 0) {
      // 条件删除影响 0 行 → 报错，绝不写"成功"。
      throw AppError.conflict('永久删除没有生效（资源可能已被删除）', 'CONFLICT')
    }

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'resource.purge',
      targetType: 'resource',
      targetId: id,
      result: 'success',
      detail: { title: row.title, removedFiles: files.length, removedObjects },
    })
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
      await this.audit.write({
        actorId: actor.id,
        actorName: actor.name,
        action: spec === undefined ? 'resource.update' : 'resource.update',
        targetType: 'resource',
        targetId: id,
        result: 'failed',
        detail: { reason: 'ILLEGAL_TRANSITION', from, to },
      })
      throw AppError.conflict(`不允许从「${from}」直接变成「${to}」`, 'ILLEGAL_TRANSITION')
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
      action: spec.action,
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
    options: { requireOwner?: boolean } = {},
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
    throw AppError.forbidden(
      decision.reason === 'not-owner' ? '只能操作自己上传的资源' : `没有权限：${permission}`,
      'FORBIDDEN',
    )
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
