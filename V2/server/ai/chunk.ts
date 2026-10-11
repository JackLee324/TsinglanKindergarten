/**
 * server/ai/chunk.ts —— 文本分片（纯函数，可单测、可复现）
 * ============================================================================
 * 为什么分片必须是**确定性**的：`ai_chunks` 的唯一键是
 * `(source_kind, resource_id, file_id, chunk_index)`。同一份来源重新索引时，
 * 同样的输入必须切出同样的片 —— 否则每次重索引都会产生"看起来是新内容"的行，
 * 唯一键就形同虚设（业主 §五：重复入队必须幂等，不得无限增加索引记录）。
 *
 * 所以这里不引入任何随机性、不看时间、不做语言相关的智能切分：
 * 先规范化空白 → 按段落/句子边界贪心装箱 → 超长段落硬切 → 带一点重叠。
 */

export interface ChunkOptions {
  /**
   * 单个片段的**目标**上限（字符数）。带上重叠后最多 `maxChars + overlap + 2`：
   * 不为了卡死上限而把句子截断（见 chunkText 内部注释）。
   */
  readonly maxChars: number
  /** 相邻片段的重叠字符数（避免答案正好被切在边界上）。 */
  readonly overlap?: number
  /** 片段总数上限（防御超大文档）。 */
  readonly maxChunks?: number
}

/** 规范化空白：统一换行、压缩 3 个以上空行、去掉首尾空白，保留段落边界。 */
export function normalizeText(input: string): string {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 把一段文本切成确定性片段。
 *
 * 切分单位：先按空行分段；段落本身超过上限时，再按句子边界（中英文标点）切；
 * 仍然超长（例如一整段没有标点的 OCR 结果）则硬切。
 */
export function chunkText(input: string, options: ChunkOptions): string[] {
  const text = normalizeText(input)
  if (text === '') return []

  const maxChars = Math.max(80, Math.floor(options.maxChars))
  const overlap = Math.max(0, Math.min(Math.floor(options.overlap ?? Math.floor(maxChars * 0.1)), maxChars - 1))
  const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? 200))

  const units: string[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim()
    if (trimmed === '') continue
    if (trimmed.length <= maxChars) {
      units.push(trimmed)
      continue
    }
    for (const piece of splitLongParagraph(trimmed, maxChars)) units.push(piece)
  }

  // 贪心装箱：能塞进当前片段的就塞，塞不下就开新片段
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    const trimmed = current.trim()
    if (trimmed !== '') chunks.push(trimmed)
    current = ''
  }
  for (const unit of units) {
    if (current === '') {
      current = unit
      continue
    }
    if (current.length + 2 + unit.length <= maxChars) {
      current = `${current}\n\n${unit}`
      continue
    }
    flush()
    /*
      重叠：把上一片段尾部带进新片段，避免答案正好被切在边界上。

      这里**不**为了卡死 maxChars 去截断 unit —— 那会把一句话从中间切开，
      而检索质量恰恰取决于"每个片段是完整的语义单元"。
      代价是带上重叠后单片最多 `maxChars + overlap + 2`（重叠默认只有 10%，+2 是拼接用的换行），
      是有界的小幅超出：`maxChunkChars` 是**目标值**，不是硬上限。
      （真正的硬边界在检索侧：`AI_MAX_CONTEXT_CHARS` 控制送进模型的总量。）
    */
    const previous = chunks[chunks.length - 1] ?? ''
    const tail = overlap > 0 ? previous.slice(Math.max(0, previous.length - overlap)) : ''
    current = tail === '' ? unit : `${tail}\n\n${unit}`
  }
  flush()

  return chunks.slice(0, maxChunks)
}

/** 按句子边界切长段落；找不到边界就硬切。 */
function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const out: string[] = []
  let rest = paragraph
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    // 中文句末标点 + 英文句末标点 + 换行，取最后一个
    const boundary = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf('; '),
    )
    const cut = boundary > maxChars * 0.5 ? boundary + 1 : maxChars
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim() !== '') out.push(rest.trim())
  return out
}
