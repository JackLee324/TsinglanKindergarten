/**
 * server/ai/index.service.ts —— 知识索引（异步、幂等、可重试、绝不碰原文件）
 * ============================================================================
 * 业主 Stage 15 §五 / §七 / §八 的落点。几条不能破的规矩：
 *
 * ① **只读原始文件**：通过 `StorageService.read()` 取字节，只用于提取文字；
 *    不写、不改、不删、不重命名任何对象，`resource_files` 只被读、从不被更新。
 * ② **异步**：入队发生在**上传登记成功之后**，且 `enqueue()` 永不抛错到上传路径；
 *    解析与模型调用全部在 worker 里跑，上传接口里一行重活都没有。
 * ③ **幂等**：任务按 (resource_id, file_id) 去重（数据库部分唯一索引）；
 *    片段按 (source_kind, resource_id, file_id, chunk_index) 去重（UNIQUE ... DO UPDATE）。
 *    重复入队 = 不会重复生成内容，也不会无限堆记录。
 * ④ **失败要留痕**：不支持/空文本/损坏/超限/OCR 失败分别记录原因，任务进入
 *    SKIPPED（永久性）或 PENDING（可重试），绝不假装成功。
 * ⑤ **来源变了旧片段作废**：同一来源指纹变了，或片段数变少，多出来的旧片段置 STALE。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { StorageService } from '../storage/storage.service'
import { resolveAiConfig, type AiConfig } from './ai.config'
import { AI_PROVIDER, type AiProvider } from './ai.provider.token'
import { chunkText } from './chunk'
import { extractFileText } from './extract'
import { siteRulesSha256, siteRulesText } from './site-rules'
import type { AiUsage, ChunkSourceKind } from './ai.types'

/** 入队原因（与 `0005_ai.sql` 的 CHECK 一致）。 */
export type IndexReason = 'UPLOADED' | 'UPDATED' | 'MANUAL' | 'BACKFILL'

export interface EnqueueTarget {
  readonly resourceId: string
  /** 为空表示只索引资源元数据（标题/描述/目录/文件名）。 */
  readonly fileId?: string | null
  readonly reason: IndexReason
}

export interface IndexRunResult {
  readonly claimed: number
  readonly done: number
  readonly retried: number
  readonly skipped: number
  readonly failed: number
}

interface JobRow {
  id: string
  resource_id: string | null
  file_id: string | null
  reason: IndexReason
  attempts: number
}

interface FileRow {
  id: string
  resource_id: string
  storage_key: string
  file_name: string
  mime_type: string
  size: string
  sha256: string
}

interface ResourceRow {
  id: string
  title: string
  title_en: string | null
  description: string | null
  status: string
  directory_path: string
  directory_id: string
}

@Injectable()
export class AiIndexService {
  private readonly logger = new Logger('AiIndex')
  private readonly config: AiConfig

  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly storage: StorageService,
    @Optional() @Inject(AI_PROVIDER) private readonly provider: AiProvider | null = null,
    @Optional() config: AiConfig | null = null,
  ) {
    this.config = config ?? resolveAiConfig()
  }

  // ── 入队（调用方：上传登记成功后 / 手动 / 回填）──────────────────────────
  /**
   * 幂等入队。**绝不抛错**：上传路径调用它时，任何异常都只记日志。
   * 返回 true 表示这次真的新增了任务（false = 已有未结束的同目标任务）。
   */
  async enqueue(target: EnqueueTarget): Promise<boolean> {
    try {
      const rows = await this.sql<{ id: string }[]>`
        INSERT INTO ai_index_jobs (resource_id, file_id, reason)
        VALUES (${target.resourceId}, ${target.fileId ?? null}, ${target.reason})
        ON CONFLICT DO NOTHING
        RETURNING id
      `
      return rows.length > 0
    } catch (error) {
      // 索引排不上队不该影响任何业务动作
      this.logger.warn(`索引入队失败（不影响业务）：${(error as Error).message}`)
      return false
    }
  }

  /** 上传成功后的统一入口：资源元数据 + 该文件各排一个任务。 */
  async enqueueAfterUpload(resourceId: string, fileId: string): Promise<void> {
    await this.enqueue({ resourceId, reason: 'UPLOADED' })
    await this.enqueue({ resourceId, fileId, reason: 'UPLOADED' })
  }

  /** 手动/回填：把现有资源与文件全部重新排一遍（幂等，不会重复生成片段）。 */
  async enqueueAll(reason: IndexReason = 'BACKFILL'): Promise<{ resources: number; files: number }> {
    const resources = await this.sql<{ id: string }[]>`SELECT id::text FROM resources WHERE deleted_at IS NULL`
    const files = await this.sql<{ id: string; resource_id: string }[]>`
      SELECT id::text, resource_id::text FROM resource_files
    `
    let enqueuedResources = 0
    for (const row of resources) {
      if (await this.enqueue({ resourceId: row.id, reason })) enqueuedResources += 1
    }
    let enqueuedFiles = 0
    for (const row of files) {
      if (await this.enqueue({ resourceId: row.resource_id, fileId: row.id, reason })) enqueuedFiles += 1
    }
    return { resources: enqueuedResources, files: enqueuedFiles }
  }

  // ── worker 主循环 ────────────────────────────────────────────────────────
  /** 取一批到期任务并处理。返回本轮统计（供日志与测试断言）。 */
  async runOnce(limit = this.config.indexBatch): Promise<IndexRunResult> {
    const jobs = await this.claim(limit)
    let done = 0
    let retried = 0
    let skipped = 0
    let failed = 0
    for (const job of jobs) {
      try {
        const outcome = await this.process(job)
        if (outcome === 'DONE') done += 1
        else if (outcome === 'SKIPPED') skipped += 1
        else retried += 1
      } catch (error) {
        const attempts = job.attempts + 1
        const transient = attempts < this.config.maxIndexAttempts
        await this.finishJob(job.id, transient ? 'PENDING' : 'FAILED', (error as Error).message, attempts)
        this.logger.warn(`索引任务 ${job.id} 失败（第 ${attempts} 次）：${(error as Error).message}`)
        if (transient) retried += 1
        else failed += 1
      }
    }
    return { claimed: jobs.length, done, retried, skipped, failed }
  }

  /** 领取任务：`FOR UPDATE SKIP LOCKED`，多进程/多轮次都不会重复处理。 */
  private async claim(limit: number): Promise<JobRow[]> {
    return await this.sql<JobRow[]>`
      UPDATE ai_index_jobs SET state = 'RUNNING', locked_at = now(),
             attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM ai_index_jobs
        WHERE state = 'PENDING' AND next_attempt_at <= now()
        ORDER BY id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text, resource_id::text, file_id::text, reason, attempts
    `
  }

  private async process(job: JobRow): Promise<'DONE' | 'SKIPPED' | 'RETRY'> {
    if (job.resource_id === null) {
      await this.finishJob(job.id, 'SKIPPED', '任务没有目标（resource_id 为空）', null)
      return 'SKIPPED'
    }
    if (job.file_id === null) {
      await this.indexResourceMeta(job.resource_id)
      await this.finishJob(job.id, 'DONE', null, null)
      return 'DONE'
    }
    const [file] = await this.sql<FileRow[]>`

      SELECT id::text, resource_id::text, storage_key, file_name, mime_type, size::text AS size, sha256
      FROM resource_files WHERE id = ${job.file_id} LIMIT 1
    `
    if (file === undefined) {
      // 文件被删了 → 片段会随外键级联删除；任务标 SKIPPED（不是失败）
      await this.finishJob(job.id, 'SKIPPED', '文件记录已不存在（可能已被删除）', null)
      return 'SKIPPED'
    }

    const bytes = await this.storage.read(file.storage_key)
    const ocr =
      this.config.visionOcrEnabled && this.provider !== null
        ? async (request: { bytes: Buffer; mimeType: string; fileName: string }) => {
            const result = await this.provider!.ocr({ bytes: request.bytes, mimeType: request.mimeType })
            await this.recordUsage('OCR', result.model, result.usage, 'ok', null)
            return { text: result.text, usage: result.usage }
          }
        : undefined

    const outcome = await extractFileText({
      bytes,
      fileName: file.file_name,
      mimeType: file.mime_type,
      limits: { maxChars: this.config.maxFileChars, maxBytes: 64 * 1024 * 1024 },
      ocr,
    })

    if (!outcome.ok) {
      // 永久性失败（格式不支持/空文本/损坏/超限/OCR 关着）→ SKIPPED，原因留痕
      await this.finishJob(job.id, 'SKIPPED', `${outcome.code}：${outcome.reason}`, null)
      return 'SKIPPED'
    }

    await this.writeChunks({
      resourceId: file.resource_id,
      fileId: file.id,
      directoryId: await this.directoryOf(file.resource_id),
      sourceKind: outcome.kind as ChunkSourceKind,
      sourceSha256: file.sha256,
      text: outcome.text,
    })
    await this.finishJob(job.id, 'DONE', null, null)
    return 'DONE'
  }

  /** 资源元数据片段：标题/英文标题/描述/目录中文链路/状态/文件名列表。 */
  async indexResourceMeta(resourceId: string): Promise<number> {
    const [resource] = await this.sql<(ResourceRow & { file_names: string[] | null })[]>`
      WITH RECURSIVE dir_path AS (
        SELECT id, slug AS path FROM directories WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, dp.path || '/' || d.slug FROM directories d JOIN dir_path dp ON d.parent_id = dp.id
      )
      SELECT r.id::text, r.title, r.title_en, r.description, r.status, r.directory_id::text,
             COALESCE(dp.path, '') AS directory_path,
             (SELECT array_agg(f.file_name) FROM resource_files f WHERE f.resource_id = r.id) AS file_names
      FROM resources r
      LEFT JOIN dir_path dp ON dp.id = r.directory_id
      WHERE r.id = ${resourceId} LIMIT 1
    `
    if (resource === undefined) return 0

    const lines = [
      `资源标题：${resource.title}`,
      resource.title_en === null || resource.title_en === '' ? null : `英文标题：${resource.title_en}`,
      resource.description === null || resource.description === '' ? null : `说明：${resource.description}`,
      `所属目录：${resource.directory_path}`,
      `当前状态：${resource.status}`,
      resource.file_names === null || resource.file_names.length === 0
        ? '暂无文件'
        : `包含文件：${resource.file_names.join('、')}`,
    ].filter((line): line is string => line !== null)

    const text = lines.join('\n')
    return await this.writeChunks({
      resourceId: resource.id,
      fileId: null,
      directoryId: resource.directory_id,
      sourceKind: 'RESOURCE_META',
      sourceSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      text,
    })
  }

  /** 站点规则与目录说明（无资源归属，对所有登录用户可见）。 */
  async seedStaticChunks(): Promise<{ siteRules: number; directories: number }> {
    const rules = await this.writeChunks({
      resourceId: null,
      fileId: null,
      directoryId: null,
      sourceKind: 'SITE_RULE',
      sourceSha256: siteRulesSha256(),
      text: siteRulesText(),
    })

    const directories = await this.sql<{ id: string; text: string }[]>`
      WITH RECURSIVE dir_path AS (
        SELECT id, slug AS path FROM directories WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, dp.path || '/' || d.slug FROM directories d JOIN dir_path dp ON d.parent_id = dp.id
      )
      SELECT d.id::text,
             ('目录名称：' || d.name
              || COALESCE('（' || d.name_en || '）', '')
              || E'\\n位置：' || dp.path
              || COALESCE(E'\\n说明：' || NULLIF(btrim(d.description), ''), '')) AS text
      FROM directories d JOIN dir_path dp ON dp.id = d.id
      WHERE d.enabled = true
    `
    let count = 0
    for (const row of directories) {
      count += await this.writeChunks({
        resourceId: null,
        fileId: null,
        directoryId: row.id,
        sourceKind: 'DIRECTORY_META',
        sourceSha256: createHash('sha256').update(row.text, 'utf8').digest('hex'),
        text: row.text,
      })
    }
    return { siteRules: rules, directories: count }
  }

  /**
   * 写片段：按唯一键 upsert（幂等），并把"这一来源多出来的旧片段"置为 STALE。
   * 返回本次写入（含更新）的片段数。
   */
  private async writeChunks(input: {
    resourceId: string | null
    fileId: string | null
    directoryId: string | null
    sourceKind: ChunkSourceKind
    sourceSha256: string
    text: string
  }): Promise<number> {
    const pieces = chunkText(input.text, {
      maxChars: this.config.maxChunkChars,
      overlap: Math.floor(this.config.maxChunkChars * 0.1),
    })
    if (pieces.length === 0) {
      // 没有可索引的内容 → 把旧片段全部作废（来源已经变空）
      await this.markStale(input, 0)
      return 0
    }
    for (const [index, text] of pieces.entries()) {
      await this.sql`
        INSERT INTO ai_chunks (resource_id, file_id, directory_id, source_kind, chunk_index, text, source_sha256, status)
        VALUES (${input.resourceId}, ${input.fileId}, ${input.directoryId}, ${input.sourceKind},
                ${index}, ${text}, ${input.sourceSha256}, 'READY')
        ON CONFLICT (source_kind, resource_id, file_id, directory_id, chunk_index)
        DO UPDATE SET text = EXCLUDED.text, source_sha256 = EXCLUDED.source_sha256,
                      directory_id = EXCLUDED.directory_id, status = 'READY', updated_at = now()
      `
    }
    await this.markStale(input, pieces.length)
    return pieces.length
  }

  private async markStale(
    input: {
      resourceId: string | null
      fileId: string | null
      directoryId: string | null
      sourceKind: ChunkSourceKind
      sourceSha256: string
    },
    keep: number,
  ): Promise<void> {
    // ⚠️ 四个来源维度都要对上：少了 directory_id，给一个目录重新播种会把**所有**目录的
    //    说明片段一起置为 STALE（本机端到端跑出来过）。
    await this.sql`
      UPDATE ai_chunks SET status = 'STALE', updated_at = now()
      WHERE source_kind = ${input.sourceKind}
        AND resource_id IS NOT DISTINCT FROM ${input.resourceId}
        AND file_id IS NOT DISTINCT FROM ${input.fileId}
        AND directory_id IS NOT DISTINCT FROM ${input.directoryId}
        AND (source_sha256 IS DISTINCT FROM ${input.sourceSha256} OR chunk_index >= ${keep})
    `
  }

  private async directoryOf(resourceId: string): Promise<string | null> {
    const [row] = await this.sql<{ directory_id: string }[]>`
      SELECT directory_id::text FROM resources WHERE id = ${resourceId} LIMIT 1
    `
    return row?.directory_id ?? null
  }

  /**
   * 收尾任务。`attempts` 传具体次数表示"可重试，按指数退避再排"（null = 终结状态）。
   * 退避上限 300 秒 —— 供应商限流时不要几秒一次地撞墙（业主 §四.7 防止循环烧钱）。
   */
  private async finishJob(
    id: string,
    state: 'DONE' | 'SKIPPED' | 'FAILED' | 'PENDING',
    error: string | null,
    attempts: number | null,
  ): Promise<void> {
    const backoffSeconds = attempts === null ? 0 : Math.min(300, 15 * 2 ** Math.max(0, attempts - 1))
    await this.sql`
      UPDATE ai_index_jobs
      SET state = ${state}, last_error = ${error}, locked_at = NULL, updated_at = now(),
          next_attempt_at = now() + (${backoffSeconds} || ' seconds')::interval
      WHERE id = ${id}
    `
  }

  /** 用量记账（业主 §四.7：成本统计与异常监控）。失败只记日志。 */
  private async recordUsage(
    kind: 'CHAT' | 'OCR' | 'EMBED',
    model: string,
    usage: AiUsage | undefined,
    outcome: string,
    latencyMs: number | null,
    userId: string | null = null,
  ): Promise<void> {
    try {
      await this.sql`
        INSERT INTO ai_usage_events (user_id, kind, model, input_tokens, output_tokens, latency_ms, outcome)
        VALUES (${userId}, ${kind}, ${model}, ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null},
                ${latencyMs}, ${outcome})
      `
    } catch (error) {
      this.logger.warn(`用量记账失败（不影响业务）：${(error as Error).message}`)
    }
  }

  /** 进度视图（管理端与运维用）：任务状态 + 片段状态。 */
  async progress(): Promise<{
    jobs: Record<string, number>
    chunks: Record<string, number>
    lastError: string | null
  }> {
    const jobs = await this.sql<{ state: string; n: number }[]>`
      SELECT state, count(*)::int AS n FROM ai_index_jobs GROUP BY state
    `
    const chunks = await this.sql<{ status: string; n: number }[]>`
      SELECT status, count(*)::int AS n FROM ai_chunks GROUP BY status
    `
    const [last] = await this.sql<{ last_error: string | null }[]>`
      SELECT last_error FROM ai_index_jobs WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1
    `
    return {
      jobs: Object.fromEntries(jobs.map((r) => [r.state, r.n])),
      chunks: Object.fromEntries(chunks.map((r) => [r.status, r.n])),
      lastError: last?.last_error ?? null,
    }
  }
}
