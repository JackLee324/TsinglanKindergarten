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
import { AppError } from '../common/http-error'
import type { AuthUser } from '../common/auth-user'
import { resolveAiConfig, type AiConfig } from './ai.config'
import { AI_PROVIDER, type AiProvider } from './ai.provider.token'
import { AiProviderError, type RetrievedChunk } from './ai.types'
import { AiRetrievalService } from './retrieval.service'
import { AiRateLimiter } from './ai-rate-limit'
import { AI_SYSTEM_PROMPT, SUGGESTED_QUESTIONS, buildContextBlock, buildUserMessage } from './prompt'

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
  /** true = 没有检索到任何依据（回答是确定性文案，没调模型）。 */
  readonly noEvidence: boolean
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

const NO_EVIDENCE_ANSWER =
  '现有资料里没有找到相关内容。\n\n' +
  '可能的原因：这条资料还没被索引、或者你当前的目录权限里看不到它。' +
  '可以换个说法再问一次，或者直接去「课程目录」里找；如果确实应该有这份资料，请联系管理员确认你的目录权限。'

@Injectable()
export class AiChatService {
  private readonly logger = new Logger('AiChat')
  private readonly config: AiConfig
  private readonly limiter: AiRateLimiter

  constructor(
    @Inject(SQL) private readonly sql: Sql,
    private readonly retrieval: AiRetrievalService,
    private readonly audit: AuditService,
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
      const citations = citationsOf(chunks)

      /*
        多轮上下文要在**写入本轮提问之前**取。
        否则历史里已经包含本条问题，模型会在"历史 + 本次提问"里读到两遍 ——
        既多花 token，也可能让模型把同一句话当两个不同的诉求。
      */
      const history = await this.recentHistory(conversationId)

      await this.sql`
        INSERT INTO ai_messages (conversation_id, role, content) VALUES (${conversationId}, 'user', ${input.question})
      `

      if (chunks.length === 0) {
        // 没有依据：**不调模型**，给确定性回答（省成本、也不给编造留空间）
        await this.persistAssistant(conversationId, NO_EVIDENCE_ANSWER, [], null, null)
        await this.finishTurn({ user, conversationId, outcome: 'ok', model: null, usage: null, started, noEvidence: true })
        return {
          conversationId,
          answer: NO_EVIDENCE_ANSWER,
          citations: [],
          model: null,
          usage: null,
          noEvidence: true,
        }
      }

      const contextBlock = buildContextBlock(chunks, this.config.maxContextChars)
      let completion
      try {
        completion = await this.provider.complete(
          { system: AI_SYSTEM_PROMPT, history, question: buildUserMessage(input.question, contextBlock) },
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
        noEvidence: false,
      })
      return {
        conversationId,
        answer: completion.text,
        citations,
        model: completion.model,
        usage: completion.usage,
        noEvidence: false,
      }
    } finally {
      release()
    }
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
