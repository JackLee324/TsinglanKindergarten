/**
 * server/ai/ai-chat.service.ts —— 问答编排（检索 → 权限复核 → 模型 → 落库）
 * ============================================================================
 * 业主 Stage 15 §三 / §六 / §九 的编排层。一次提问的顺序是**刻意固定**的：
 *
 *   ① 未配置密钥 → 直接 503 说清"AI 未启用"，不做任何事（网站其它功能不受影响）；
 *   ② 用户级限流 + 并发闸门（花钱的是调用本身，闸门必须在服务端）；
 *   ③ 会话归属校验（只能读自己的会话；别人的一律 404，不泄露"存在这样一个会话"）；
 *   ④ 检索（权限在 SQL 里）→ **再复核一次可引用性** → 才拼上下文；
 *   ⑤ 调模型（超时/可取消，错误分类）；
 *   ⑥ 落库（消息 + 引用快照）+ 用量记账 + 审计。
 *
 * 为什么"再复核"放在**生成之前**：如果先让模型看到、事后才把引用删掉，
 * 答案正文里可能已经复述了不该出现的内容 —— 那就成了"过滤器在出口、泄漏在正文"。
 * 放在入口，模型从一开始就看不到无权内容。
 *
 * 取不到任何资料时**不调模型**，直接给确定性回答（"现有资料里没有找到"）：
 * 既省成本，也避免模型用通用知识编出"站内有哪些资料"这种没有依据的话。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import type { Sql } from 'postgres'
import { SQL } from '../db/database.module'
import { AuditService } from '../audit/audit.service'
import { AuthorizationService } from '../authz/authorization.service'
import type { PermissionCode } from '../../shared/permissions'
import { AppError } from '../common/http-error'
import type { AuthUser } from '../common/auth-user'
import { resolveAiConfig, type AiConfig } from './ai.config'
import { AI_PROVIDER, type AiProvider } from './ai.provider.token'
import { AiProviderError, type RetrievedChunk } from './ai.types'
import { AiRetrievalService } from './retrieval.service'
import { AiRateLimiter } from './ai-rate-limit'
import {
  SUGGESTED_QUESTIONS,
  buildContextBlock,
  buildPlatformFacts,
  buildSystemPrompt,
  buildUserMessage,
  isMetaQuestion,
} from './prompt'

export interface AiCitation {
  readonly index: number
  readonly resourceId: string
  readonly title: string
  readonly directoryPath: string
  readonly sourceKind: string
  readonly fileId: string | null
  /** 前端直接可用的站内链接；资源类才有。 */
  readonly url: string | null
}

export interface AiChatResult {
  readonly conversationId: string
  readonly answer: string
  readonly citations: readonly AiCitation[]
  readonly model: string | null
  readonly usage: { inputTokens: number; outputTokens: number } | null
  /** true = 没有检索到任何**资源**依据（站内资料层面）。 */
  readonly noEvidence: boolean
  /**
   * 这条回答是谁写的：
   *   · `model`  —— 真实模型回答（含"问助手自己"那一类，它依据服务端配置事实回答）；
   *   · `system` —— 系统提示（**没有调用模型**）。界面必须明显区分，
   *                 否则用户会把它当成"AI 在敷衍"，实测就是这样被误判成"假的"。
   */
  readonly answeredBy: 'model' | 'system'
}

export interface AiStatus {
  readonly enabled: boolean
  readonly disabledReason: string | null
  readonly provider: string
  readonly model: string
  readonly api: string
  readonly visionOcr: boolean
  readonly suggestedQuestions: readonly string[]
  readonly limits: { readonly perMinute: number; readonly maxConcurrent: number; readonly topK: number }
  readonly index: { readonly jobs: Record<string, number>; readonly chunks: Record<string, number> }
}

interface ConversationRow {
  id: string
  title: string | null
  updated_at: Date
}

interface MessageRow {
  id: string
  role: string
  content: string
  citations: unknown
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  created_at: Date
}

@Injectable()
export class AiChatService {
  private readonly logger = new Logger('AiChat')
  private readonly config: AiConfig
  private readonly limiter: AiRateLimiter

  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly retrieval: AiRetrievalService,
    private readonly audit: AuditService,
    /**
     * 权限策略的唯一来源。这里只用它算"这个人能看哪些目录"，
     * 为"没找到"时的系统回复提供路标（列出的目录必须是他真能访问的）。
     */
    private readonly authz: AuthorizationService,
    @Optional() @Inject(AI_PROVIDER) private readonly provider: AiProvider | null = null,
    @Optional() @Inject('AI_CONFIG') config: AiConfig | null = null,
  ) {
    this.config = config ?? resolveAiConfig()
    this.limiter = new AiRateLimiter(this.config.rateLimitPerMin, this.config.maxConcurrent)
  }

  /** 状态：前端据此决定"能不能用"与"为什么不能用"。**不含任何密钥信息。** */
  async status(): Promise<AiStatus> {
    const [jobs, chunks] = await Promise.all([
      this.sql<{ state: string; n: number }[]>`SELECT state, count(*)::int AS n FROM ai_index_jobs GROUP BY state`,
      this.sql<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM ai_chunks GROUP BY status`,
    ])
    return {
      enabled: this.config.enabled && this.provider !== null,
      disabledReason: this.provider === null ? this.config.disabledReason : null,
      provider: this.config.provider,
      model: this.config.model,
      api: this.config.api,
      visionOcr: this.config.visionOcrEnabled,
      suggestedQuestions: SUGGESTED_QUESTIONS,
      limits: {
        perMinute: this.config.rateLimitPerMin,
        maxConcurrent: this.config.maxConcurrent,
        topK: this.config.topK,
      },
      index: {
        jobs: Object.fromEntries(jobs.map((r) => [r.state, r.n])),
        chunks: Object.fromEntries(chunks.map((r) => [r.status, r.n])),
      },
    }
  }

  // ── 会话 ──────────────────────────────────────────────────────────────────

  async listConversations(user: AuthUser) {
    const rows = await this.sql<ConversationRow[]>`
      SELECT id::text, title, updated_at FROM ai_conversations
      WHERE user_id = ${user.id} ORDER BY updated_at DESC LIMIT 50
    `
    return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at.toISOString() }))
  }

  async createConversation(user: AuthUser, title?: string) {
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO ai_conversations (user_id, title) VALUES (${user.id}, ${title?.trim() || null})
      RETURNING id::text
    `
    return { id: row.id }
  }

  /** 读某会话的消息。**只允许本人**：别人的会话一律 404（不暴露"存在"这件事）。 */
  async messages(user: AuthUser, conversationId: string) {
    await this.requireOwnConversation(user, conversationId)
    const rows = await this.sql<MessageRow[]>`
      SELECT id::text, role, content, citations, model, input_tokens, output_tokens, created_at
      FROM ai_messages WHERE conversation_id = ${conversationId} ORDER BY created_at, id
    `
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      citations: Array.isArray(row.citations) ? row.citations : [],
      model: row.model,
      usage:
        row.input_tokens === null && row.output_tokens === null
          ? null
          : { inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0 },
      createdAt: row.created_at.toISOString(),
    }))
  }

  async deleteConversation(user: AuthUser, conversationId: string) {
    await this.requireOwnConversation(user, conversationId)
    await this.sql`DELETE FROM ai_conversations WHERE id = ${conversationId} AND user_id = ${user.id}`
    return { deleted: true }
  }

  private async requireOwnConversation(user: AuthUser, conversationId: string): Promise<void> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id::text FROM ai_conversations WHERE id = ${conversationId} AND user_id = ${user.id} LIMIT 1
    `
    if (row === undefined) throw AppError.notFound('会话不存在')
  }

  // ── 提问 ──────────────────────────────────────────────────────────────────

  async chat(
    user: AuthUser,
    input: { readonly question: string; readonly conversationId?: string },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AiChatResult> {
    if (this.provider === null) {
      throw AppError.serviceUnavailable(this.config.disabledReason ?? 'AI 未启用', 'AI_DISABLED')
    }
    /*
      ① 限流 + 并发闸门。
      ⚠️ 这里必须**自己**把 AiProviderError 翻成 HTTP —— 它发生在 try/catch 之前，
      如果直接让它冒出去，全局异常过滤器只认 HttpException，会把"提问太快"
      变成 500 INTERNAL_ERROR：前端以为服务器崩了、用户以为系统坏了，
      而真实原因只是等几秒再试。这条路径由集成测试压着（连续提问 → 429）。
    */
    try {
      this.limiter.acquire(user.id)
    } catch (error) {
      await this.finishTurn({ user, conversationId: input.conversationId ?? null, outcome: 'rate_limited', model: null, usage: null, started: Date.now(), noEvidence: false })
      throw mapProviderError(error)
    }
    let release: () => void
    try {
      release = this.limiter.enter()
    } catch (error) {
      await this.finishTurn({ user, conversationId: input.conversationId ?? null, outcome: 'rate_limited', model: null, usage: null, started: Date.now(), noEvidence: false })
      throw mapProviderError(error)
    }
    const started = Date.now()
    try {
      // ② 会话：有就校验归属，没有就新建（标题取第一个问题）
      let conversationId = input.conversationId
      if (conversationId === undefined) {
        const created = await this.createConversation(user, input.question.slice(0, 40))
        conversationId = created.id
      } else {
        await this.requireOwnConversation(user, conversationId)
      }

      // ③ 检索（权限在 SQL 里）→ 再复核一次可引用性 → 拼上下文
      const candidates = await this.retrieval.retrieve(user, input.question, { limit: this.config.topK })
      const chunks = await this.retrieval.filterCitable(user, candidates)

      /*
        多轮上下文要在**写入本轮提问之前**取。
        否则历史里已经包含本条问题，模型会在"历史 + 本次提问"里读到两遍 ——
        既多花 token，也可能让模型把同一句话当两个不同的诉求。
      */
      const history = await this.recentHistory(conversationId)

      await this.sql`
        INSERT INTO ai_messages (conversation_id, role, content) VALUES (${conversationId}, 'user', ${input.question})
      `

      /*
        ── 没有资源依据时怎么办（2026-10-11 业主反馈"回答好像是假的"之后改的）──────
        旧行为：一律不调模型，回一句固定文案。省成本、绝不可能编造，但有两个硬伤：
          · 「你现在是什么模型」这种**问助手自己**的问题，答案不在资料里，
            用户收到的却是一句与问题无关的"没有找到" —— 看起来就是个假机器人；
          · 固定文案不区分问题，用户也看不出"这不是模型在敷衍，而是系统根本没调模型"。

        新行为分两条路：
          · 问助手自己的（`isMetaQuestion`）：**照常调模型**，系统提示里附上
            服务端配置的事实（供应商/模型名/能做与不能做），并允许它只依据这些事实回答；
            同时用"只查平台文档"的检索把站规里"AI 助手能做什么、不能做什么"一节带进去。
            这些都不是资料内容，不存在越权问题。
          · 其它问题：仍然是**确定性系统回复**（不调模型），但文案改成
            带着用户的问题原样回话 + 明说"未调用 AI 模型" + 列出他有权限访问的目录当路标。
      */
      const meta = isMetaQuestion(input.question)
      let usedChunks = chunks
      if (usedChunks.length === 0) {
        /*
          资源里没有依据时，**再查一次平台文档**（站规 + 目录说明），而不是直接给固定文案。
          这是业主第二轮反馈（问「调用Ai」拿到固定文案）之后补的：
          这类问题的答案本来就在文档里（站规里就有一节叫「AI 助手能做什么、不能做什么」），
          以前只有"问助手自己"的问题才会去查文档。
          放宽到"命中 1 个词元"：文档语料小而精编，命中一个词元就值得交给模型判断；
          而且这条路**碰不到任何用户资料**（SQL 里已经把资源片段排除掉了）。
        */
        const docs = await this.retrieval.retrieve(user, input.question, {
          limit: meta ? 3 : 4,
          docsOnly: true,
          minHits: 1,
        })
        usedChunks = await this.retrieval.filterCitable(user, docs)
      }

      /*
        没有资料时**也交给模型**（2026-10-11 业主第二次反馈"和 AI 聊天还是不行"之后改的）。
        旧行为是自己写死一段"与「…」相关的内容没有找到"，问"在吗""现在有什么内容""今天教什么"
        收到的都是同一句话 —— 那确实不像在聊天。
        现在的分工：**文案交给模型**（它能把话说得像样、能给出下一步），
        **纪律留给我们**：用户消息里明确要求"据实说没有找到、不许编造、不许给编号引用"，
        并附上"平台事实"（他有权限访问的目录 + 他能看到的资源条数）让这类问题答得出具体内容。
      */
      const noEvidence = usedChunks.length === 0
      const contextBlock = buildContextBlock(usedChunks, this.config.maxContextChars)
      const facts = noEvidence
        ? buildPlatformFacts({
            directoryNames: await this.accessibleDirectoryNames(user),
            visibleResourceCount: await this.visibleResourceCount(user),
          })
        : undefined
      const citations = citationsOf(usedChunks)
      let completion
      try {
        completion = await this.provider.complete(
          {
            system: buildSystemPrompt(
              {
                provider: this.config.provider,
                model: this.config.model,
                visionOcrEnabled: this.config.visionOcrEnabled,
                topK: this.config.topK,
                rateLimitPerMin: this.config.rateLimitPerMin,
              },
              { meta },
            ),
            history,
            question: buildUserMessage(input.question, contextBlock, { meta, facts }),
          },
          { signal: options.signal },
        )
      } catch (error) {
        const kind = error instanceof AiProviderError ? error.kind : 'provider_error'
        await this.finishTurn({ user, conversationId, outcome: kind, model: this.provider.model, usage: null, started, noEvidence: false })
        throw mapProviderError(error)
      }

      await this.persistAssistant(conversationId, completion.text, citations, completion.model, completion.usage)
      await this.finishTurn({
        user,
        conversationId,
        outcome: 'ok',
        model: completion.model,
        usage: completion.usage,
        started,
        noEvidence: chunks.length === 0,
      })
      return {
        conversationId,
        answer: completion.text,
        citations,
        model: completion.model,
        usage: completion.usage,
        noEvidence: chunks.length === 0,
        answeredBy: 'model',
      }
    } finally {
      release()
    }
  }

  /**
   * 当前账号**看得见**的已发布资源条数（与检索同一套权限策略）。
   * 用途：没有资料依据时，让"站内有什么"这类问题有一个真实的数字可答。
   */
  private async visibleResourceCount(user: AuthUser): Promise<number> {
    const scope = await this.authz.accessibleDirectoryIds(user, 'resource.view' as PermissionCode)
    if (Array.isArray(scope) && scope.length === 0) return 0
    const { othersStatuses, ownerId } = await this.authz.resourceVisibility(user)
    const [row] = await this.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM resources r
      WHERE r.deleted_at IS NULL
        AND (${scope}::uuid[] IS NULL OR r.directory_id = ANY(${scope}::uuid[]))
        AND (r.uploader_id = ${ownerId}::uuid OR r.status = ANY(${othersStatuses}::text[]))
    `
    return row?.n ?? 0
  }

  /**
   * 当前账号**有权限访问**的目录名（最多 8 个，取他能触达的最浅一层）。
   *
   * 用途：没检索到依据时给用户路标 —— "你其实能看这些目录"。
   * 边界：只列他确实授权的目录（策略来自 AuthorizationService，与检索同一份），
   * 所以这条提示**不会**泄露任何他没有权限的目录名。
   */
  private async accessibleDirectoryNames(user: AuthUser): Promise<string[]> {
    const scope = await this.authz.accessibleDirectoryIds(user, 'resource.view' as PermissionCode)
    if (Array.isArray(scope) && scope.length === 0) return []
    const rows = await this.sql<{ name: string }[]>`
      WITH RECURSIVE dir_path AS (
        SELECT id, slug AS path FROM directories WHERE parent_id IS NULL
        UNION ALL
        SELECT d.id, dp.path || '/' || d.slug FROM directories d JOIN dir_path dp ON d.parent_id = dp.id
      )
      SELECT d.name
      FROM directories d JOIN dir_path dp ON dp.id = d.id
      WHERE d.enabled
        AND (${scope}::uuid[] IS NULL OR d.id = ANY(${scope}::uuid[]))
        AND array_length(string_to_array(dp.path, '/'), 1) = (
          SELECT min(array_length(string_to_array(dp2.path, '/'), 1))
          FROM directories d2 JOIN dir_path dp2 ON dp2.id = d2.id
          WHERE d2.enabled AND (${scope}::uuid[] IS NULL OR d2.id = ANY(${scope}::uuid[]))
        )
      ORDER BY dp.path
      LIMIT 8
    `
    return rows.map((row) => row.name)
  }

  /** 最近几轮对话作为多轮上下文（只取本会话，且只取文本，不带引用）。 */
  private async recentHistory(conversationId: string): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const rows = await this.sql<{ role: string; content: string }[]>`
      SELECT role, content FROM ai_messages
      WHERE conversation_id = ${conversationId}
      ORDER BY created_at DESC, id DESC LIMIT 6
    `
    return rows
      .reverse()
      .slice(-5)
      .map((row) => ({ role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: row.content }))
  }

  private async persistAssistant(
    conversationId: string,
    content: string,
    citations: readonly AiCitation[],
    model: string | null,
    usage: { inputTokens: number; outputTokens: number } | null,
  ): Promise<void> {
    await this.sql`
      INSERT INTO ai_messages (conversation_id, role, content, citations, model, input_tokens, output_tokens)
      VALUES (${conversationId}, 'assistant', ${content}, ${this.sql.json(citations as never)},
              ${model}, ${usage?.inputTokens ?? null}, ${usage?.outputTokens ?? null})
    `
    await this.sql`UPDATE ai_conversations SET updated_at = now() WHERE id = ${conversationId}`
  }

  /** 用量记账 + 审计（两者失败都不该让回答丢失）。 */
  private async finishTurn(input: {
    user: AuthUser
    /** null = 还没建会话就被拦下（例如限流），审计里只记"谁做了这个动作"。 */
    conversationId: string | null
    outcome: string
    model: string | null
    usage: { inputTokens: number; outputTokens: number } | null
    started: number
    noEvidence: boolean
  }): Promise<void> {
    const latency = Date.now() - input.started
    try {
      await this.sql`
        INSERT INTO ai_usage_events (user_id, kind, model, input_tokens, output_tokens, latency_ms, outcome)
        VALUES (${input.user.id}, 'CHAT', ${input.model}, ${input.usage?.inputTokens ?? null},
                ${input.usage?.outputTokens ?? null}, ${latency}, ${input.outcome})
      `
    } catch (error) {
      this.logger.warn(`AI 用量记账失败：${(error as Error).message}`)
    }
    try {
      await this.audit.write({
        actorId: input.user.id,
        actorName: input.user.name,
        action: 'ai.chat',
        targetType: 'system',
        targetId: input.conversationId,
        result: input.outcome === 'ok' ? 'success' : 'failed',
        detail: { latencyMs: latency, model: input.model, noEvidence: input.noEvidence, outcome: input.outcome },
      })
    } catch (error) {
      this.logger.warn(`AI 审计写入失败：${(error as Error).message}`)
    }
  }
}

/** 片段 → 引用（按资源去重；资源类给站内链接，目录/站规类没有链接）。 */
export function citationsOf(chunks: readonly RetrievedChunk[]): AiCitation[] {
  const out: AiCitation[] = []
  const seen = new Set<string>()
  for (const [index, chunk] of chunks.entries()) {
    const key = chunk.resourceId === '' ? `plain:${chunk.chunkId}` : `res:${chunk.resourceId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      index: index + 1,
      resourceId: chunk.resourceId,
      title: chunk.title,
      directoryPath: chunk.directoryPath,
      sourceKind: chunk.sourceKind,
      fileId: chunk.fileId,
      url: chunk.resourceId === '' ? null : `/resources/${chunk.resourceId}`,
    })
  }
  return out
}

/** 供应商错误 → HTTP。**不把供应商原始报文透给前端**（里面可能有账号信息），只给分类。 */
function mapProviderError(error: unknown): Error {
  if (!(error instanceof AiProviderError)) {
    return AppError.http(502, 'AI_PROVIDER_ERROR', 'AI 服务暂时不可用，请稍后再试')
  }
  switch (error.kind) {
    case 'rate_limited':
      return AppError.http(429, 'AI_RATE_LIMITED', 'AI 服务繁忙或提问过快，请稍后再试')
    case 'auth_error':
      return AppError.http(502, 'AI_AUTH_ERROR', 'AI 服务鉴权失败：请管理员检查服务端密钥配置')
    case 'timeout':
      return AppError.http(504, 'AI_TIMEOUT', 'AI 回答超时，请重试或把问题问得更具体一些')
    case 'cancelled':
      return AppError.http(408, 'AI_CANCELLED', '请求已取消')
    default:
      return AppError.http(502, 'AI_PROVIDER_ERROR', 'AI 服务暂时不可用，请稍后再试')
  }
}
