/**
 * server/ai/retrieval.service.ts —— 权限优先的检索（AI 不许成为绕过授权的入口）
 * ============================================================================
 * 业主 Stage 15 §六 是硬要求，这里是它的落点。三条纪律：
 *
 * ① **权限不是过滤，而是 WHERE 的一部分。**
 *    候选集在 SQL 里就用"这个人此刻能看的目录 + 能看的状态"限制住 ——
 *    不是先取出全站再在应用层筛。这样"教师用 AI 看到别人草稿"在结构上不可能：
 *    那些行**从来没有**进入候选集。
 *
 * ② **规则只有一条来源。**
 *    可见性策略来自 `AuthorizationService`：
 *      · `accessibleDirectoryIds(user, 'resource.view')` → 目录范围（null=全平台）
 *      · `resourceVisibility(user)` → 别人上传的哪些状态可见（教师只有 PUBLISHED）
 *    这与资源列表用的是**同两个方法**（见 `resources.service.list`），
 *    并有集成测试比对"AI 检索到的资源集合 == 资源列表接口返回的集合"。
 *
 * ③ **索引不是权限事实源。**
 *    `ai_chunks` 里没有任何授权字段；检索、以及**渲染引用之前**都会重新核验
 *    资源当前状态与目录权限 —— 撤回/删除/改权限之后，旧片段立刻不可见。
 *
 * 无资源归属的片段（站点规则 SITE_RULE、目录说明 DIRECTORY_META）对所有已登录用户可见：
 * 这两类内容本来就展现在界面里（侧边栏目录树、目录页说明），不是资源权限的对象。
 */
import { Inject, Injectable } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import type { AuthUser } from '../common/auth-user'
import { AuthorizationService } from '../authz/authorization.service'
import type { PermissionCode } from '../../shared/permissions'
import type { ChunkSourceKind, RetrievedChunk } from './ai.types'
import { likePattern, queryTerms } from './query-terms'

interface RetrievalScope {
  /** null = 全平台（管理员/全平台授权）；[] = 一个目录都没有。 */
  readonly directoryIds: string[] | null
  readonly ownerId: string
  readonly statuses: readonly string[]
}

export interface RetrievalOptions {
  readonly limit: number
  /** 相似度下限：低于它的片段不进上下文（宁缺毋滥，避免把无关内容喂给模型）。 */
  readonly minScore?: number
}

@Injectable()
export class AiRetrievalService {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly authz: AuthorizationService,
  ) {}

  /** 读取当前用户的可见性策略 —— 全模块只有这一处，避免出现第二套规则。 */
  private async scopeFor(user: AuthUser): Promise<RetrievalScope> {
    const directoryIds = await this.authz.accessibleDirectoryIds(user, 'resource.view' as PermissionCode)
    const { othersStatuses, ownerId } = await this.authz.resourceVisibility(user)
    return { directoryIds, ownerId, statuses: othersStatuses }
  }

  /**
   * 检索。返回的每一条都已经过当前权限过滤，可直接作为"可引用来源"。
   */
  async retrieve(user: AuthUser, query: string, options: RetrievalOptions): Promise<RetrievedChunk[]> {
    const q = query.trim()
    if (q === '') return []
    const { directoryIds, ownerId, statuses } = await this.scopeFor(user)
    // 一个目录都没有 → 只能看到"无资源归属"的站点规则/目录说明
    const scope = directoryIds ?? null
    const minScore = options.minScore ?? 0.08
    const limit = Math.max(1, Math.min(options.limit, 50))

    const { raw, terms } = queryTerms(q)
    const pattern = likePattern(raw)
    const termCount = Math.max(1, terms.length)

    /*
      逐词元计数：把"提问里有多少个词元出现在这段文字里"算成一个数，
      再用它算覆盖率。放在 LATERAL 里算一次，避免在打分表达式里重复写 24 个 ILIKE
      （重复写会被 Postgres 求值两遍，白花 CPU）。
    */
    const hitSum =
      terms.length === 0
        ? this.sql`0`
        : terms
            .map((term) => this.sql`(CASE WHEN c.text ILIKE ${likePattern(term)} ESCAPE '\\' THEN 1 ELSE 0 END)`)
            .reduce((acc, fragment) => this.sql`${acc} + ${fragment}`)

    const rows = await this.sql<
      {
        chunk_id: string
        resource_id: string | null
        file_id: string | null
        directory_id: string | null
        source_kind: ChunkSourceKind
        text: string
        title: string | null
        status: string | null
        directory_path: string | null
        score: number
      }[]
    >`
      WITH RECURSIVE dir_path AS (
        SELECT id, slug AS path FROM directories WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, dp.path || '/' || d.slug FROM directories d JOIN dir_path dp ON d.parent_id = dp.id
      )
      SELECT * FROM (
        SELECT c.id::text AS chunk_id,
               c.resource_id::text AS resource_id,
               c.file_id::text AS file_id,
               c.directory_id::text AS directory_id,
               c.source_kind,
               c.text,
               CASE WHEN c.resource_id IS NULL THEN COALESCE(d.name, '平台使用说明') ELSE r.title END AS title,
               CASE WHEN c.resource_id IS NULL THEN NULL::text ELSE r.status END AS status,
               CASE WHEN c.resource_id IS NULL THEN COALESCE(d.slug, '') ELSE COALESCE(dp.path, '') END AS directory_path,
               GREATEST(
                 -- ① 字面量整句命中（老师直接搜关键词时最准）
                 CASE WHEN c.text ILIKE ${pattern} ESCAPE '\\' THEN 1.0 ELSE 0 END,
                 -- ② 与整句的模糊相似度
                 similarity(c.text, ${raw}),
                 -- ③ 全文检索（英文/数字有效；中文整段成词，作用有限）
                 ts_rank(to_tsvector('simple', c.text), plainto_tsquery('simple', ${raw})),
                 -- ④ 词元覆盖：至少命中 2 个词元、且覆盖 ≥20% 才算"相关"，映射到 0.6~1.0
                 CASE
                   WHEN h.hits >= 2 AND h.hits::numeric / ${termCount}::numeric >= 0.2
                   THEN 0.5 + 0.5 * (h.hits::numeric / ${termCount}::numeric)
                   ELSE 0
                 END
               ) AS score
        FROM ai_chunks c
        LEFT JOIN resources r ON r.id = c.resource_id
        LEFT JOIN directories d ON d.id = c.directory_id
        LEFT JOIN dir_path dp ON dp.id = r.directory_id
        CROSS JOIN LATERAL (SELECT (${hitSum})::numeric AS hits) h
        WHERE c.status = 'READY'
          AND (
            -- ① 资源片段：目录范围 + 状态可见性（策略同样来自 AuthorizationService）
            (
              c.resource_id IS NOT NULL
              AND r.id IS NOT NULL
              AND r.deleted_at IS NULL
              AND (${scope}::uuid[] IS NULL OR r.directory_id = ANY(${scope}::uuid[]))
              AND (r.uploader_id = ${ownerId}::uuid OR r.status = ANY(${statuses}::text[]))
            )
            -- ② 无资源归属的片段：站点规则 / 目录说明（本来就对所有登录用户可见）
            OR (
              c.resource_id IS NULL
              AND (c.source_kind <> 'DIRECTORY_META' OR d.enabled = true)
            )
          )
      ) ranked
      WHERE ranked.score >= ${minScore}
      ORDER BY ranked.score DESC, ranked.chunk_id
      LIMIT ${limit}
    `

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      resourceId: row.resource_id ?? '',
      fileId: row.file_id,
      directoryId: row.directory_id,
      sourceKind: row.source_kind,
      score: Number(row.score),
      text: row.text,
      title: row.title ?? '',
      status: row.status ?? '',
      directoryPath: row.directory_path ?? '',
    }))
  }

  /**
   * **渲染引用之前**再核验一次：这条资源此刻还对这个人可见吗？
   *
   * 为什么必须有：索引是"某一刻的快照"。资源被撤回/删除/移动目录、
   * 或这个人的授权被收回之后，片段可能还在（后台任务还没来得及标记 STALE）。
   * 引用一旦渲染出来，就等于泄漏了"存在这样一份资料"这件事。
   */
  async isResourceCitable(user: AuthUser, resourceId: string): Promise<boolean> {
    if (resourceId === '') return false
    const [row] = await this.sql<
      { status: string; uploader_id: string | null; directory_id: string; deleted_at: Date | null }[]
    >`
      SELECT status, uploader_id, directory_id::text, deleted_at
      FROM resources WHERE id = ${resourceId} LIMIT 1
    `
    if (row === undefined || row.deleted_at !== null) return false

    const decision = await this.authz.canViewResource(user, {
      status: row.status,
      uploaderId: row.uploader_id,
    })
    if (!decision.allowed) return false

    const directoryIds = await this.authz.accessibleDirectoryIds(user, 'resource.view' as PermissionCode)
    return directoryIds === null || directoryIds.includes(row.directory_id)
  }

  /** 只保留"此刻仍可引用"的来源（回答生成后、写库与渲染前都要过一遍）。 */
  async filterCitable(user: AuthUser, chunks: readonly RetrievedChunk[]): Promise<RetrievedChunk[]> {
    const out: RetrievedChunk[] = []
    const cache = new Map<string, boolean>()
    for (const chunk of chunks) {
      if (chunk.resourceId === '') {
        out.push(chunk)
        continue
      }
      if (!cache.has(chunk.resourceId)) {
        cache.set(chunk.resourceId, await this.isResourceCitable(user, chunk.resourceId))
      }
      if (cache.get(chunk.resourceId) === true) out.push(chunk)
    }
    return out
  }
}
