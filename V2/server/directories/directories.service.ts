import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { AuditService } from '../audit/audit.service'
import { AuthorizationService } from '../authz/authorization.service'
import type { AuthUser } from '../common/auth-user'
import { AppError } from '../common/http-error'
import {
  MAX_DIRECTORY_DEPTH,
  isValidSlug,
  slugWithSuffix,
  slugifyCandidate,
  type DirectoryType,
} from '../../shared/directory'

interface NodeRow {
  id: string
  parent_id: string | null
  slug: string
  name: string
  name_en: string | null
  description: string | null
  type: string
  sort_order: number
  enabled: boolean
  allow_children: boolean
  allow_files: boolean
  allow_custom_folders: boolean
  icon: string | null
  created_at: Date
  updated_at: Date
}

/** 服务端算好、前端直接渲染的能力位。前端不得自行推断这些。 */
export interface NodeCapabilities {
  readonly canManage: boolean
  readonly canCreateChild: boolean
  readonly canUpload: boolean
  readonly canCreateFolder: boolean
}

export interface NodeView {
  readonly id: string
  readonly parentId: string | null
  readonly slug: string
  readonly name: string
  readonly nameEn: string | null
  readonly description: string | null
  readonly type: DirectoryType
  readonly sortOrder: number
  readonly enabled: boolean
  readonly allowChildren: boolean
  readonly allowFiles: boolean
  readonly allowCustomFolders: boolean
  readonly icon: string | null
  readonly path: string
  readonly capabilities: NodeCapabilities
  readonly resourceCount: number
  readonly children: NodeView[]
}

/**
 * DirectoriesService —— V2 唯一的目录读写入口
 * ============================================================================
 * 业主原话：「Directory 必须成为整个网页课程导航的唯一真相。」
 *
 * 这里是全站**唯一**能改目录的地方。侧边栏、浏览页、面包屑、上传入口、
 * 资源详情读的都是这个模块的输出。
 *
 * 三条刻意写在代码里的规则：
 *   1. `id` / `slug` / `parentId` **不通过普通改名修改**（改名只动 name/nameEn/description）。
 *   2. **没有** `isSystem => 不允许改名` —— 系统目录（PDF 初始目录）照样能改名。
 *   3. 删除只删**空**目录（无子节点、无资源），**绝不级联删资源**。
 */
@Injectable()
export class DirectoriesService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // 「可用」—— `enabled` 的真实语义
  // ─────────────────────────────────────────────────────────────────────────
  //
  // 停用一个节点，意思是**它和它的整棵子树都不再投入使用**。
  // 只在界面上把这一行藏起来是不够的，实测有三个泄漏点（阶段 3 修掉）：
  //   · 子节点会被"提升"成顶层 —— 父节点被过滤掉之后，buildTree 会把它当成孤儿挂到根上，
  //     于是「教育教学」里会突然多出一个「美德」顶级栏目；
  //   · 教师可以**直接调接口**往停用的目录里建资源（HTTP 201）；
  //   · `by-path` 仍然解析进停用节点，老链接指向一个已经停用的地方。
  //
  // 因此这里给出唯一的判定：**自身与所有祖先都 enabled 才算"可用"**。
  // 用一个递归 CTE 从根往下走、遇到停用即停 —— 与"子树"判定同一套写法。

  /** 全部可用节点 id（自身与祖先都 enabled）。 */
  async usableDirectoryIds(sql?: Sql): Promise<Set<string>> {
    const client = sql ?? this.sql
    const rows = await client<{ id: string }[]>`
      WITH RECURSIVE usable AS (
        SELECT id FROM directories WHERE parent_id IS NULL AND enabled = true
        UNION ALL
        SELECT d.id FROM directories d JOIN usable u ON d.parent_id = u.id
        WHERE d.enabled = true
      )
      SELECT id FROM usable
    `
    return new Set(rows.map((r) => r.id))
  }

  /** 单个节点是否可用（自身与所有祖先都 enabled）。 */
  async isUsable(id: string): Promise<boolean> {
    const rows = await this.sql<{ ok: boolean }[]>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, enabled FROM directories WHERE id = ${id}
        UNION ALL
        SELECT d.id, d.parent_id, d.enabled FROM directories d JOIN up ON d.id = up.parent_id
      )
      SELECT bool_and(enabled) AS ok FROM up
    `
    return rows.length > 0 && rows[0].ok === true
  }

  /** 写入前的前置检查：目标目录必须可用（否则 409 而不是静默接受）。 */
  private async assertUsable(id: string, what: string): Promise<void> {
    const node = await this.requireNode(id)
    if (!(await this.isUsable(id))) {
      throw AppError.conflict(
        `「${node.name}」已停用（或它的上级已停用），${what}`,
        'CONFLICT',
      )
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 读
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 当前用户可见的完整目录树（侧边栏与浏览页都读它）。
   *
   * 可见性 = 有 `resource.view` 的目录 ∪ 有 `directory.manage` 的目录，
   * 再加上它们的**祖先**（否则导航链断掉）。
   * 停用节点只有管理得到它的用户才看得到。
   */
  async getTree(user: AuthUser): Promise<{ roots: NodeView[] }> {
    const [rows, viewIds, manageIds, createIds, folderIds, counts] = await Promise.all([
      this.allNodes(),
      this.authz.accessibleDirectoryIds(user, 'resource.view'),
      this.authz.accessibleDirectoryIds(user, 'directory.manage'),
      this.authz.accessibleDirectoryIds(user, 'resource.create'),
      this.authz.accessibleDirectoryIds(user, 'directory.create_folder'),
      this.subtreeResourceCounts(),
    ])

    const canManageFully = manageIds === null
    const visible = new Set<string>()
    const allIds = rows.map((r) => r.id)
    if (viewIds === null || manageIds === null) {
      for (const id of allIds) visible.add(id)
    } else {
      for (const id of viewIds) visible.add(id)
      for (const id of manageIds) visible.add(id)
      // 补祖先
      const byId = new Map(rows.map((r) => [r.id, r]))
      for (const id of [...visible]) {
        let cur = byId.get(id)
        while (cur?.parent_id) {
          visible.add(cur.parent_id)
          cur = byId.get(cur.parent_id)
        }
      }
    }

    const allowed = (set: string[] | null, id: string) => set === null || set.includes(id)

    const usable = await this.usableDirectoryIds()

    // 第一轮：范围过滤 + 停用过滤。
    // 停用节点只有能管理它的人才看得到（管理界面需要看到它并重新启用）。
    const shown = new Set<string>()
    for (const r of rows) {
      if (!visible.has(r.id)) continue
      if (usable.has(r.id) || allowed(manageIds, r.id)) shown.add(r.id)
    }

    // 第二轮：**祖先闭合**。父节点不在结果里时，子节点必须一起移除，
    // 而不是被提升成顶层 —— 那正是实测到的泄漏：
    // 停用「Pre-K」之后，「美德」会变成「教育教学」下的一个顶级栏目。
    for (let pass = 0; pass < MAX_DIRECTORY_DEPTH; pass += 1) {
      let removed = 0
      for (const r of rows) {
        if (!shown.has(r.id)) continue
        if (r.parent_id !== null && !shown.has(r.parent_id)) {
          shown.delete(r.id)
          removed += 1
        }
      }
      if (removed === 0) break
    }

    const visibleRows = rows.filter((r) => shown.has(r.id))

    const builds = buildTree(visibleRows, (row) => ({
      ...toNodeView(row, this.pathOf(rows, row.id), counts.get(row.id) ?? 0),
      capabilities: {
        canManage: canManageFully || allowed(manageIds, row.id),
        canCreateChild:
          row.allow_children && (canManageFully || allowed(manageIds, row.id)),
        canUpload: row.allow_files && allowed(createIds, row.id),
        canCreateFolder: row.allow_custom_folders && allowed(folderIds, row.id),
      },
    }))

    return { roots: builds }
  }

  /**
   * 按 slug 路径解析节点（`/directory/pre-k/virtue` → `pre-k/virtue`）。
   *
   * 解析失败时**退到最近一个仍可解析的祖先**并如实告知，而不是 404 或白屏 ——
   * 目录被改名/停用/移动之后，老链接仍然要能落到一个有意义的位置。
   */
  async resolvePath(
    user: AuthUser,
    segments: string[],
  ): Promise<{ node: NodeView | null; resolvedCount: number; restSegments: string[] }> {
    let parentId: string | null = null
    let current: NodeRow | null = null
    let resolvedCount = 0

    for (const segment of segments) {
      const rows: NodeRow[] = parentId
        ? await this.sql<NodeRow[]>`
            SELECT id, parent_id, slug, name, name_en, description, type, sort_order,
             enabled, allow_children, allow_files, allow_custom_folders, icon,
             created_at, updated_at FROM directories
            WHERE parent_id = ${parentId} AND slug = ${segment}
          `
        : await this.sql<NodeRow[]>`
            SELECT id, parent_id, slug, name, name_en, description, type, sort_order,
             enabled, allow_children, allow_files, allow_custom_folders, icon,
             created_at, updated_at FROM directories
            WHERE parent_id IS NULL AND slug = ${segment}
          `
      if (rows.length === 0) break

      // 停用的节点对**普通用户**到此为止：回退到最近一个可用祖先。
      // 管理员仍然可以解析进去（管理界面需要打开它并重新启用）。
      if (!rows[0].enabled) {
        const manage = await this.authz.can(user, 'directory.manage', rows[0].id)
        if (!manage.allowed) break
      }

      current = rows[0]
      parentId = current.id
      resolvedCount += 1
    }

    if (current === null) {
      return { node: null, resolvedCount: 0, restSegments: [...segments] }
    }
    const view = await this.toNodeViewFor(user, current)
    return {
      node: view,
      resolvedCount,
      restSegments: segments.slice(resolvedCount),
    }
  }

  async getById(user: AuthUser, id: string): Promise<NodeView & { ancestors: NodeView[] }> {
    const row = await this.requireNode(id)
    if (!(await this.isUsable(id))) {
      const manage = await this.authz.can(user, 'directory.manage', id)
      if (!manage.allowed) throw AppError.notFound('目录不存在')
    }
    const node = await this.toNodeViewFor(user, row)
    const ancestors = await this.ancestorsOf(user, id)
    return { ...node, ancestors }
  }

  async ancestorsOf(user: AuthUser, id: string): Promise<NodeView[]> {
    const rows = await this.sql<NodeRow[]>`
      WITH RECURSIVE up AS (
        SELECT * FROM directories WHERE id = ${id}
        UNION ALL
        SELECT d.* FROM directories d JOIN up ON d.id = up.parent_id
      )
      SELECT * FROM up
    `
    const chain = rows.filter((r) => r.id !== id)
    const ordered = chain.reverse()
    const out: NodeView[] = []
    for (const r of ordered) out.push(await this.toNodeViewFor(user, r))
    return out
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 写
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 建节点。`parentId === null` 就是**新增一级栏目** ——
   * 业主的核心验收：「新增一级栏目『活动』→ 刷新 → 侧边栏出现『活动』」。
   *
   * 整个操作**不需要改任何代码**：它只是目录表里多了一行。
   */
  async create(
    actor: AuthUser,
    input: {
      parentId?: string | null
      name: string
      nameEn?: string | null
      description?: string | null
      slug?: string
      type?: DirectoryType
      allowChildren?: boolean
      allowFiles?: boolean
      allowCustomFolders?: boolean
    },
  ): Promise<NodeView> {
    const parentId = input.parentId ?? null
    let depth = 1
    if (parentId !== null) {
      const parent = await this.requireNode(parentId)
      await this.assertUsable(parentId, '不能在其下新建目录')
      if (!parent.allow_children) {
        throw AppError.conflict(`「${parent.name}」不允许在其下继续新建目录`, 'CONFLICT')
      }
      const ancestors = await this.ancestorsOf(actor, parentId)
      depth = ancestors.length + 2
    }
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw AppError.conflict(`目录层级不能超过 ${MAX_DIRECTORY_DEPTH} 层`, 'CONFLICT')
    }

    const slug = await this.allocateSlug(parentId, input.slug, input.nameEn ?? input.name)

    const rows = await this.sql<NodeRow[]>`
      INSERT INTO directories
        (parent_id, slug, name, name_en, description, type, sort_order,
         allow_children, allow_files, allow_custom_folders)
      VALUES
        (${parentId}, ${slug}, ${input.name}, ${input.nameEn ?? null}, ${input.description ?? null},
         ${input.type ?? (parentId === null ? 'ROOT' : 'SECTION')},
         ${await this.nextSortOrder(parentId)},
         ${input.allowChildren ?? true}, ${input.allowFiles ?? false},
         ${input.allowCustomFolders ?? false})
      RETURNING *
    `

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'directory.create',
      targetType: 'directory',
      targetId: rows[0].id,
      result: 'success',
      detail: { slug, name: input.name, parentId, level: parentId === null ? '一级栏目' : '子目录' },
    })

    return this.toNodeViewFor(actor, rows[0])
  }

  /**
   * 普通教师建文件夹（业主 §「新建文件夹」）。
   *
   * 与 `create()` 的区别：**必须**满足目标目录的 `allowCustomFolders = true`，
   * 且只能建 `FOLDER` 类型、不能带子节点 —— 教师建的是"装东西的文件夹"，
   * 不是"新的栏目"。
   */
  async createFolder(actor: AuthUser, parentId: string, name: string, nameEn?: string | null) {
    const parent = await this.requireNode(parentId)
    await this.assertUsable(parentId, '不能在其下新建文件夹')
    if (!parent.allow_custom_folders) {
      throw AppError.forbidden(
        `「${parent.name}」不允许教师自建文件夹`,
        'FORBIDDEN',
      )
    }
    return this.create(actor, {
      parentId,
      name,
      nameEn: nameEn ?? null,
      type: 'FOLDER',
      allowChildren: true,
      allowFiles: true,
      allowCustomFolders: false,
    })
  }

  /**
   * 改目录。**只改展示层**：`name` / `nameEn` / `description` / 排序 / 启停 / 能力开关。
   *
   * `slug` 与 `parentId` 在这里**永远不会**被修改 —— 改 slug 会让所有历史链接失效，
   * 改 parent 是"移动"，必须走 `move()`（它要查环与同名冲突）。
   * 系统目录（PDF 初始目录）在这里同样可以改名。
   */
  async update(
    actor: AuthUser,
    id: string,
    input: {
      name?: string
      nameEn?: string | null
      description?: string | null
      type?: DirectoryType
      sortOrder?: number
      enabled?: boolean
      allowChildren?: boolean
      allowFiles?: boolean
      allowCustomFolders?: boolean
      icon?: string | null
    },
  ): Promise<NodeView> {
    const before = await this.requireNode(id)

    const assignments: string[] = []
    const values: unknown[] = []
    const push = (column: string, value: unknown) => {
      values.push(value)
      assignments.push(`${column} = $${values.length}`)
    }
    if (input.name !== undefined) push('name', input.name)
    if (input.nameEn !== undefined) push('name_en', input.nameEn)
    if (input.description !== undefined) push('description', input.description)
    if (input.type !== undefined) push('type', input.type)
    if (input.sortOrder !== undefined) push('sort_order', input.sortOrder)
    if (input.enabled !== undefined) push('enabled', input.enabled)
    if (input.allowChildren !== undefined) push('allow_children', input.allowChildren)
    if (input.allowFiles !== undefined) push('allow_files', input.allowFiles)
    if (input.allowCustomFolders !== undefined)
      push('allow_custom_folders', input.allowCustomFolders)
    if (input.icon !== undefined) push('icon', input.icon)

    if (assignments.length === 0) return this.toNodeViewFor(actor, before)

    values.push(id)
    // 唯一允许拼进 SQL 的是上面 push() 里的列名字面量；
    // 所有**值**都走参数占位符。
    const rows = await this.sql.unsafe(
      `UPDATE directories SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $${values.length}
       RETURNING id, parent_id, slug, name, name_en, description, type, sort_order,
                 enabled, allow_children, allow_files, allow_custom_folders, icon,
                 created_at, updated_at`,
      values as never[],
    ) as unknown as NodeRow[]

    /*
     * 审计：启停**单独记一条**（业主 §15 点名要 directory.enable / directory.disable）。
     *
     * 混在 `directory.update` 里的后果很具体：某天某个目录对老师们"消失"了，
     * 你想查"谁把它关掉的"，按动作筛 `directory.update` 会捞出一堆改名记录，
     * 而真正的元凶躲在 detail.changed 里 —— 那不是能用来查问题的形状。
     */
    const enabledChanged = input.enabled !== undefined && input.enabled !== before.enabled
    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: enabledChanged
        ? input.enabled === true
          ? 'directory.enable'
          : 'directory.disable'
        : 'directory.update',
      targetType: 'directory',
      targetId: id,
      result: 'success',
      detail: {
        changed: Object.keys(input),
        before: { name: before.name, nameEn: before.name_en, enabled: before.enabled },
        after: { name: rows[0].name, nameEn: rows[0].name_en, enabled: rows[0].enabled },
        // slug 与 parentId 没变这件事值得单独记一笔：它是"历史链接不会失效"的证据。
        slugUnchanged: rows[0].slug === before.slug,
      },
    })

    return this.toNodeViewFor(actor, rows[0])
  }

  /**
   * 移动节点（换 parentId）。
   *
   * 两条必须拒绝的情况：
   *   · 移动到**自己的子树**里 → 树成环，递归查询会无限循环；
   *   · 目标父节点下**已有同名 slug** → 拒绝而不是自动改名
   *     （自动改名会静默让旧链接 404）。
   */
  async move(actor: AuthUser, id: string, newParentId: string | null): Promise<NodeView> {
    const node = await this.requireNode(id)
    if (newParentId === id) throw AppError.conflict('不能把目录移动到它自己下面', 'CONFLICT')

    if (newParentId !== null) {
      const parent = await this.requireNode(newParentId)
      await this.assertUsable(newParentId, '不能把目录移动到它下面')
      if (!parent.allow_children) {
        throw AppError.conflict(`「${parent.name}」不允许在其下继续新建目录`, 'CONFLICT')
      }
      if (await this.authz.isInSubtree(id, newParentId)) {
        throw AppError.conflict('不能把目录移动到它自己的子树里', 'CONFLICT')
      }
      const ancestors = await this.ancestorsOf(actor, newParentId)
      const subtreeDepth = await this.subtreeDepth(id)
      if (ancestors.length + subtreeDepth + 1 > MAX_DIRECTORY_DEPTH) {
        throw AppError.conflict(`移动后会超过 ${MAX_DIRECTORY_DEPTH} 层`, 'CONFLICT')
      }
    }

    const clash = newParentId
      ? await this.sql<{ id: string }[]>`
          SELECT id FROM directories WHERE parent_id = ${newParentId} AND slug = ${node.slug}
        `
      : await this.sql<{ id: string }[]>`
          SELECT id FROM directories WHERE parent_id IS NULL AND slug = ${node.slug}
        `
    if (clash.length > 0) {
      throw AppError.conflict(
        `目标位置已存在 slug 为「${node.slug}」的目录，请先改名或换一个位置`,
        'CONFLICT',
      )
    }

    const rows = await this.sql<NodeRow[]>`
      UPDATE directories SET parent_id = ${newParentId}, updated_at = now()
      WHERE id = ${id} RETURNING *
    `

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'directory.move',
      targetType: 'directory',
      targetId: id,
      result: 'success',
      detail: { from: node.parent_id, to: newParentId, slug: node.slug, slugUnchanged: true },
    })

    return this.toNodeViewFor(actor, rows[0])
  }

  /** ↑ / ↓：只交换相邻两个节点的 sort_order。 */
  async reorder(actor: AuthUser, id: string, direction: 'up' | 'down'): Promise<{ ok: true }> {
    const node = await this.requireNode(id)
    const siblings = node.parent_id
      ? await this.sql<{ id: string; sort_order: number }[]>`
          SELECT id, sort_order FROM directories WHERE parent_id = ${node.parent_id}
          ORDER BY sort_order, name
        `
      : await this.sql<{ id: string; sort_order: number }[]>`
          SELECT id, sort_order FROM directories WHERE parent_id IS NULL
          ORDER BY sort_order, name
        `

    // 先把整组重新编号，避免多个节点共享同一个 sort_order 时"交换"没有效果。
    const index = siblings.findIndex((s) => s.id === id)
    const target = direction === 'up' ? index - 1 : index + 1
    if (index < 0) throw AppError.notFound('目录不存在')
    if (target < 0 || target >= siblings.length) {
      throw AppError.conflict(
        direction === 'up' ? '已经在最前面了' : '已经在最后面了',
        'CONFLICT',
      )
    }

    const ordered = [...siblings]
    const [moved] = ordered.splice(index, 1)
    ordered.splice(target, 0, moved)

    await this.sql.begin(async (tx) => {
      for (const [i, s] of ordered.entries()) {
        await tx`UPDATE directories SET sort_order = ${i + 1} WHERE id = ${s.id}`
      }
    })

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'directory.reorder',
      targetType: 'directory',
      targetId: id,
      result: 'success',
      detail: { direction, from: index + 1, to: target + 1 },
    })
    return { ok: true }
  }

  /**
   * 删除目录。**只允许删空目录**（业主 §40）。
   *
   * 数据库层还有 `parent_id ON DELETE RESTRICT` 与
   * `resources.directory_id ON DELETE RESTRICT` 双重兜底 ——
   * 即使这里有 bug，也不会有一批资源随目录消失。
   */
  async remove(actor: AuthUser, id: string): Promise<{ ok: true; name: string }> {
    const node = await this.requireNode(id)

    const children = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM directories WHERE parent_id = ${id}
    `
    if (children[0].n > 0) {
      throw AppError.conflict(
        `「${node.name}」下面还有 ${children[0].n} 个子目录，请先删除或移动它们`,
        'DIRECTORY_HAS_CHILDREN',
      )
    }

    // 回收站里的资源也算"有资源" —— 否则删目录会让那些资源永远无法恢复。
    const resources = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM resources WHERE directory_id = ${id}
    `
    if (resources[0].n > 0) {
      throw AppError.conflict(
        `「${node.name}」下还有 ${resources[0].n} 条资源（含回收站），请先移动或删除它们`,
        'DIRECTORY_HAS_RESOURCES',
      )
    }

    // 第三种保护：**还有授权挂靠在这个节点上**。
    //
    // 外键是 ON DELETE CASCADE，所以不检查的话，删一个"空目录"会**静默删掉**
    // 别人对这个目录的授权 —— 实测就是这样：删完授权行从 2 变成 1，界面上毫无提示。
    // 「删除保护」的本意是不做用户没要求的数据删除，因此这里拒绝并要求先解除授权。
    const grants = await this.authz.countGrantsOnDirectory(id)
    if (grants > 0) {
      throw AppError.conflict(
        `「${node.name}」上还挂着 ${grants} 条授权，请先在权限设置里解除，` +
          `否则删除它会连带删除这些授权（且无法撤销）`,
        'DIRECTORY_HAS_PERMISSIONS',
      )
    }

    await this.sql`DELETE FROM directories WHERE id = ${id}`

    await this.audit.write({
      actorId: actor.id,
      actorName: actor.name,
      action: 'directory.delete',
      targetType: 'directory',
      targetId: id,
      result: 'success',
      detail: { name: node.name, slug: node.slug, parentId: node.parent_id },
    })
    return { ok: true, name: node.name }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 内部
  // ─────────────────────────────────────────────────────────────────────────

  private async allNodes(): Promise<NodeRow[]> {
    return this.sql<NodeRow[]>`
      SELECT id, parent_id, slug, name, name_en, description, type, sort_order,
             enabled, allow_children, allow_files, allow_custom_folders, icon,
             created_at, updated_at
      FROM directories
      ORDER BY sort_order, name
    `
  }

  private async requireNode(id: string): Promise<NodeRow> {
    const rows = await this.sql<NodeRow[]>`
      SELECT id, parent_id, slug, name, name_en, description, type, sort_order,
             enabled, allow_children, allow_files, allow_custom_folders, icon,
             created_at, updated_at
      FROM directories WHERE id = ${id}
    `
    if (rows.length === 0) throw AppError.notFound('目录不存在')
    return rows[0]
  }

  private async toNodeViewFor(user: AuthUser, row: NodeRow): Promise<NodeView> {
    const path = await this.pathOfId(row.id)
    const counts = await this.subtreeResourceCounts()
    return {
      ...toNodeView(row, path, counts.get(row.id) ?? 0),
      children: [],
      capabilities: await this.capabilitiesFor(user, row),
    }
  }

  private async capabilitiesFor(user: AuthUser, row: NodeRow): Promise<NodeCapabilities> {
    const [manage, create, folder] = await Promise.all([
      this.authz.can(user, 'directory.manage', row.id),
      this.authz.can(user, 'resource.create', row.id),
      this.authz.can(user, 'directory.create_folder', row.id),
    ])
    return {
      canManage: manage.allowed,
      canCreateChild: row.allow_children && manage.allowed,
      canUpload: row.allow_files && create.allowed,
      canCreateFolder: row.allow_custom_folders && folder.allowed,
    }
  }

  private pathOf(rows: NodeRow[], id: string): string {
    const byId = new Map(rows.map((r) => [r.id, r]))
    const segments: string[] = []
    let cur = byId.get(id)
    while (cur) {
      segments.unshift(cur.slug)
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
    return segments.join('/')
  }

  private async pathOfId(id: string): Promise<string> {
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

  private async subtreeDepth(id: string): Promise<number> {
    const rows = await this.sql<{ d: number }[]>`
      WITH RECURSIVE down AS (
        SELECT id, 1 AS d FROM directories WHERE id = ${id}
        UNION ALL
        SELECT c.id, down.d + 1 FROM directories c JOIN down ON c.parent_id = down.id
      )
      SELECT max(d)::int AS d FROM down
    `
    return rows[0]?.d ?? 1
  }

  /** 每个节点的**子树**资源数（不含回收站）。用于目录卡片上的数量。 */
  async subtreeResourceCounts(): Promise<Map<string, number>> {
    const rows = await this.sql<{ id: string; n: number }[]>`
      WITH RECURSIVE reach AS (
        SELECT id, id AS root FROM directories
        UNION ALL
        SELECT d.id, r.root FROM directories d JOIN reach r ON d.parent_id = r.id
      )
      SELECT r.root AS id, count(res.id)::int AS n
      FROM reach r
      LEFT JOIN resources res ON res.directory_id = r.id AND res.deleted_at IS NULL
      GROUP BY r.root
    `
    return new Map(rows.map((r) => [r.id, r.n]))
  }

  private async nextSortOrder(parentId: string | null): Promise<number> {
    const rows = parentId
      ? await this.sql<{ n: number }[]>`
          SELECT COALESCE(max(sort_order), 0)::int + 1 AS n FROM directories WHERE parent_id = ${parentId}
        `
      : await this.sql<{ n: number }[]>`
          SELECT COALESCE(max(sort_order), 0)::int + 1 AS n FROM directories WHERE parent_id IS NULL
        `
    return rows[0].n
  }

  /**
   * 分配同级唯一的 slug。
   *
   * 中文名无法音译，所以当 `nameEn`/`name` 都生成不出合法 slug 时，
   * **要求调用方显式提供 slug**，而不是编造 `node-1` 这种永远读不懂的值。
   */
  private async allocateSlug(
    parentId: string | null,
    preferred: string | undefined,
    source: string,
  ): Promise<string> {
    const base = preferred ?? slugifyCandidate(source)
    if (!base) {
      throw AppError.forbidden(
        '这个名称无法生成可读的地址（slug），请显式提供一个英文/拼音 slug',
        'VALIDATION_FAILED',
      )
    }
    if (!isValidSlug(base)) {
      throw AppError.forbidden(
        `slug 只能包含小写字母、数字和连字符：${base}`,
        'VALIDATION_FAILED',
      )
    }

    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const candidate = slugWithSuffix(base, attempt)
      const existing = parentId
        ? await this.sql<{ id: string }[]>`
            SELECT id FROM directories WHERE parent_id = ${parentId} AND slug = ${candidate}
          `
        : await this.sql<{ id: string }[]>`
            SELECT id FROM directories WHERE parent_id IS NULL AND slug = ${candidate}
          `
      if (existing.length === 0) return candidate
    }
    throw AppError.conflict('无法分配唯一的地址，请换一个名称', 'CONFLICT')
  }
}

function toNodeView(row: NodeRow, path: string, resourceCount: number): Omit<NodeView, 'children' | 'capabilities'> {
  return {
    id: row.id,
    parentId: row.parent_id,
    slug: row.slug,
    name: row.name,
    nameEn: row.name_en,
    description: row.description,
    type: row.type as DirectoryType,
    sortOrder: row.sort_order,
    enabled: row.enabled,
    allowChildren: row.allow_children,
    allowFiles: row.allow_files,
    allowCustomFolders: row.allow_custom_folders,
    icon: row.icon,
    path,
    resourceCount,
  }
}

/** 组装成树。子节点按 sort_order 排好序。 */
function buildTree(
  rows: NodeRow[],
  decorate: (row: NodeRow) => Omit<NodeView, 'children'>,
): NodeView[] {
  const byParent = new Map<string | null, NodeRow[]>()
  for (const row of rows) {
    const key = row.parent_id
    const list = byParent.get(key) ?? []
    list.push(row)
    byParent.set(key, list)
  }
  const build = (parentId: string | null): NodeView[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((row) => ({ ...decorate(row), children: build(row.id) }))

  // 只从"可见且父节点不可见"的节点开始，避免把孤儿挂到根上。
  const visibleIds = new Set(rows.map((r) => r.id))
  const rootless = rows.filter((r) => r.parent_id === null || !visibleIds.has(r.parent_id))
  return rootless
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((row) => ({ ...decorate(row), children: build(row.id) }))
}

