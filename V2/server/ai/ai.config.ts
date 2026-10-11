/**
 * server/ai/ai.config.ts —— AI 助手配置（唯一入口）
 * ============================================================================
 * 业主 Stage 15 §四 的硬要求，逐条落在这里：
 *   · 密钥**只在服务端环境变量**（`AI_API_KEY`，兼容 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`）；
 *   · 模型名走服务端配置（`AI_MODEL`），前端一行都不写死；
 *   · 密钥未配置 → AI **整体禁用**，网站其它功能不受任何影响；
 *   · 超时、限流、最大输入输出、并发上限都有显式配置项。
 *
 * 默认供应商是 **DeepSeek**（业主指定），走它的 **OpenAI 兼容端点**：
 *   base_url = https://api.deepseek.com，Responses API 也在同一域名下。
 * 默认模型 `deepseek-flash`：官方文档写明它支持图像输入（JPEG/PNG/GIF/WebP），
 * 所以"用模型视觉能力做 OCR"（业主已选）与问答共用同一个模型与密钥。
 *
 * 为什么把"没启用"和"配置错了"分开说：只报"AI 不可用"没法排查，
 * 而 `disabledReason` 会点名**缺哪个变量**（只说变量名，绝不回显值）。
 */
export interface AiConfig {
  readonly enabled: boolean
  /** 未启用时的人话原因（缺哪个变量 / 显式关闭）；已启用时为 null。 */
  readonly disabledReason: string | null
  readonly provider: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  /** 视觉/OCR 用的模型；默认与 `model` 相同（deepseek-flash 本身支持图片）。 */
  readonly visionModel: string
  readonly visionOcrEnabled: boolean
  readonly embeddingsEnabled: boolean
  readonly maxOutputTokens: number
  readonly topK: number
  readonly maxChunkChars: number
  readonly maxContextChars: number
  readonly timeoutMs: number
  readonly rateLimitPerMin: number
  readonly maxConcurrent: number
  /** 索引 worker：一次取多少个任务、轮询间隔、最大重试次数。 */
  readonly indexBatch: number
  readonly indexIntervalMs: number
  readonly maxIndexAttempts: number
  /** 单个文件允许提取的最大字符数（防止超大文档把内存与 token 打爆）。 */
  readonly maxFileChars: number
}

const DEFAULTS = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  maxOutputTokens: 1200,
  topK: 8,
  maxChunkChars: 800,
  maxContextChars: 12000,
  timeoutMs: 45_000,
  rateLimitPerMin: 10,
  maxConcurrent: 2,
  indexBatch: 5,
  indexIntervalMs: 15_000,
  maxIndexAttempts: 3,
  maxFileChars: 400_000,
} as const

/** 布尔开关：只有显式写 `0/false/no/off` 才算关；写 `1/true/yes/on` 才算开。 */
function readFlag(raw: string | undefined, fallback: boolean): boolean {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === '') return fallback
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

function readNumber(raw: string | undefined, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const text = String(raw ?? '').trim()
  if (text === '') return fallback
  const value = Number(text)
  if (!Number.isFinite(value)) return fallback
  const int = Math.floor(value)
  if (int < min || int > max) return fallback
  return int
}

/**
 * 解析 AI 配置。密钥从三个名字里按优先级取（都只读，不回显、不写日志）。
 */
export function resolveAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const apiKey = String(env.AI_API_KEY ?? env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY ?? '').trim()
  const model = String(env.AI_MODEL ?? '').trim() || DEFAULTS.model
  const baseUrl = String(env.AI_BASE_URL ?? '').trim() || DEFAULTS.baseUrl
  const explicit = String(env.AI_ENABLED ?? '').trim()

  const base: Omit<AiConfig, 'enabled' | 'disabledReason'> = {
    provider: String(env.AI_PROVIDER ?? '').trim() || DEFAULTS.provider,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    visionModel: String(env.AI_VISION_MODEL ?? '').trim() || model,
    // 业主已决定：用模型的视觉能力做 OCR（默认开；关掉就是"图片只索引元数据"）
    visionOcrEnabled: readFlag(env.AI_VISION_OCR, true),
    // 生产库**没有 pgvector**（实测），DeepSeek 也没有 embeddings 端点 → 默认关
    embeddingsEnabled: readFlag(env.AI_EMBEDDINGS, false),
    maxOutputTokens: readNumber(env.AI_MAX_OUTPUT_TOKENS, DEFAULTS.maxOutputTokens, { min: 64, max: 32_000 }),
    topK: readNumber(env.AI_TOP_K, DEFAULTS.topK, { min: 1, max: 50 }),
    maxChunkChars: readNumber(env.AI_MAX_CHUNK_CHARS, DEFAULTS.maxChunkChars, { min: 200, max: 4_000 }),
    maxContextChars: readNumber(env.AI_MAX_CONTEXT_CHARS, DEFAULTS.maxContextChars, { min: 1_000, max: 200_000 }),
    timeoutMs: readNumber(env.AI_TIMEOUT_MS, DEFAULTS.timeoutMs, { min: 5_000, max: 300_000 }),
    rateLimitPerMin: readNumber(env.AI_RATE_LIMIT_PER_MIN, DEFAULTS.rateLimitPerMin, { min: 1, max: 600 }),
    maxConcurrent: readNumber(env.AI_MAX_CONCURRENT, DEFAULTS.maxConcurrent, { min: 1, max: 16 }),
    indexBatch: readNumber(env.AI_INDEX_BATCH, DEFAULTS.indexBatch, { min: 1, max: 50 }),
    indexIntervalMs: readNumber(env.AI_INDEX_INTERVAL_MS, DEFAULTS.indexIntervalMs, { min: 1_000, max: 600_000 }),
    maxIndexAttempts: readNumber(env.AI_MAX_INDEX_ATTEMPTS, DEFAULTS.maxIndexAttempts, { min: 1, max: 10 }),
    maxFileChars: readNumber(env.AI_MAX_FILE_CHARS, DEFAULTS.maxFileChars, { min: 1_000, max: 5_000_000 }),
  }

  if (explicit !== '' && !readFlag(explicit, true)) {
    return { ...base, enabled: false, disabledReason: 'AI_ENABLED 显式关闭（设为 1 才启用）' }
  }
  if (apiKey === '') {
    return {
      ...base,
      enabled: false,
      disabledReason: '未配置 AI_API_KEY（也可用 DEEPSEEK_API_KEY / OPENAI_API_KEY）——AI 已禁用，网站其它功能不受影响',
    }
  }
  if (model === '') {
    return { ...base, enabled: false, disabledReason: '未配置 AI_MODEL' }
  }
  return { ...base, enabled: true, disabledReason: null }
}
