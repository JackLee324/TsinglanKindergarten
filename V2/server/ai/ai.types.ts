/**
 * server/ai/ai.types.ts —— AI 模块的共享类型
 * ============================================================================
 * 一条贯穿全模块的规矩：**提取失败必须是一个明确的结果，不是异常**。
 * 业主 Stage 15 §五："如果某种格式当前无法可靠解析，要记录为不支持或待处理，
 * 不得假装索引成功。" 所以 `ExtractOutcome` 用联合类型表达"成功/失败+原因"，
 * 调用方（索引服务）据此把失败写进任务表，而不是吞掉。
 */

/** 片段来源种类（与 `0005_ai.sql` 的 CHECK 一致）。 */
export type ChunkSourceKind = 'RESOURCE_META' | 'DIRECTORY_META' | 'FILE_TEXT' | 'FILE_OCR' | 'SITE_RULE'

/** 提取失败的原因码 —— 每一种都要能落库、能在进度里看到。 */
export type ExtractFailureCode =
  /** 这种格式目前不支持（例如还没接入 PDF 解析） */
  | 'UNSUPPORTED_FORMAT'
  /** 提取出来是空的（扫描件没有文字层、空文档） */
  | 'EMPTY_TEXT'
  /** 文件损坏 / 打不开 */
  | 'CORRUPT'
  /** 超过单文件字符上限或字节上限 */
  | 'TOO_LARGE'
  /** 图片需要 OCR，但 OCR 未启用（缺密钥或显式关闭） */
  | 'OCR_DISABLED'
  /** OCR 调模型失败（超时/限流/供应商错误） */
  | 'OCR_FAILED'

export type ExtractOutcome =
  | {
      readonly ok: true
      readonly text: string
      readonly kind: ExtractKind
      readonly usage?: AiUsage
    }
  | { readonly ok: false; readonly code: ExtractFailureCode; readonly reason: string }

/** 提取到的文字从哪来：文件自身文字层，还是模型识别（OCR）。 */
export type ExtractKind = 'FILE_TEXT' | 'FILE_OCR'

export interface AiUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** 一次模型调用的结果。 */
export interface AiCompletion {
  readonly text: string
  readonly model: string
  readonly usage: AiUsage
}

/** 供应商错误的分类（用于重试策略与运维监控）。 */
export type AiErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'auth_error'
  | 'provider_error'
  | 'cancelled'
  | 'disabled'

export class AiProviderError extends Error {
  readonly kind: AiErrorKind
  constructor(kind: AiErrorKind, message: string) {
    super(message)
    this.name = 'AiProviderError'
    this.kind = kind
  }
}

/** 检索到的一段可引用内容（已经过权限过滤）。 */
export interface RetrievedChunk {
  readonly chunkId: string
  readonly resourceId: string
  readonly fileId: string | null
  readonly directoryId: string | null
  readonly sourceKind: ChunkSourceKind
  readonly score: number
  /** 片段原文（送进模型前还会按上下文预算截断）。 */
  readonly text: string
  /** 资源侧信息，用于生成引用与链接。 */
  readonly title: string
  readonly status: string
  /** 目录中文链路（如「教育教学 / Pre-K / 体能 / 课程大纲」）。 */
  readonly directoryPath: string
}
