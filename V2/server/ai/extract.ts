/**
 * server/ai/extract.ts —— 从文件字节里取可检索文字（**只读、不落地、不改原文件**）
 * ============================================================================
 * 业主 Stage 15 §五 / §九 的约束，逐条落在这里：
 *   · 不支持的格式必须**明确记录**，不许假装索引成功（返回 `UNSUPPORTED_FORMAT`）；
 *   · 空文本（扫描件没有文字层）记 `EMPTY_TEXT`，不是"成功但没内容"；
 *   · 超大文件先拦（`TOO_LARGE`），不把内存和 token 打爆；
 *   · 压缩包（zip 等）**不解压、不执行**：只识别我们主动支持的 Office 家族
 *     （docx/pptx/xlsx 本身就是 zip，但只读其中固定的 XML 成员）；
 *   · 文档里的文字是**待检索数据**，不是指令 —— 这里只负责取字，
 *     防提示词注入的封装在 provider/回答层（见 prompt.ts）。
 *
 * 图片识别交给模型的视觉能力（业主已选）：`ocr` 回调由调用方注入，
 * 这样提取层不依赖任何供应商，也能在没有密钥时明确返回 `OCR_DISABLED`。
 */
import { unzipSync } from 'fflate'
import type { ExtractOutcome, AiUsage } from './ai.types'

export interface ExtractLimits {
  /** 单文件最多提取多少字符（超出即截断并标注）。 */
  readonly maxChars: number
  /** 单文件最多多少字节（超过直接不处理）。 */
  readonly maxBytes: number
}

export interface OcrRequest {
  readonly bytes: Buffer
  readonly mimeType: string
  readonly fileName: string
}

export interface ExtractInput {
  readonly bytes: Buffer
  readonly fileName: string
  readonly mimeType: string
  readonly limits: ExtractLimits
  /** 图片 OCR 的注入点；未提供表示 OCR 未启用。 */
  readonly ocr?: (request: OcrRequest) => Promise<{ text: string; usage?: AiUsage }>
}

/** 图片格式按**文件内容**判断（DeepSeek 文档明确：不看扩展名、不看声明的 MIME）。 */
export function sniffImageMime(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/** 纯文本类（零依赖、直接解码）。 */
const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/xml',
  'text/xml',
])
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml']

function looksLikeText(fileName: string, mimeType: string): boolean {
  if (TEXT_MIMES.has(mimeType.toLowerCase())) return true
  const lower = fileName.toLowerCase()
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** XML → 纯文字：去标签、还原常见实体、把块级标签变成换行。 */
export function xmlToText(xml: string): string {
  return xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(w:p|a:p|row|c|text|p|div|tr)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/** 从 Office（zip）里取出固定成员的文字。**不遍历、不解压其它成员。** */
export function extractOfficeText(bytes: Buffer, fileName: string): ExtractOutcome | null {
  const lower = fileName.toLowerCase()
  const isDocx = lower.endsWith('.docx')
  const isPptx = lower.endsWith('.pptx')
  const isXlsx = lower.endsWith('.xlsx') || lower.endsWith('.xlsm')
  if (!isDocx && !isPptx && !isXlsx) return null

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(bytes))
  } catch {
    return { ok: false, code: 'CORRUPT', reason: '压缩结构读不出来（文件可能损坏或不是真正的 Office 文档）' }
  }

  const read = (name: string): string | null => {
    const entry = files[name]
    return entry === undefined ? null : Buffer.from(entry).toString('utf8')
  }

  const parts: string[] = []
  if (isDocx) {
    const doc = read('word/document.xml')
    if (doc === null) return { ok: false, code: 'CORRUPT', reason: 'docx 里找不到 word/document.xml' }
    parts.push(xmlToText(doc))
  } else if (isPptx) {
    const slides = Object.keys(files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNo(a) - slideNo(b))
    if (slides.length === 0) return { ok: false, code: 'CORRUPT', reason: 'pptx 里找不到任何幻灯片' }
    for (const name of slides) {
      const xml = read(name)
      if (xml === null) continue
      // pptx 的正文在 <a:t>…</a:t>；按段落 </a:p> 断行由 xmlToText 处理
      parts.push(`【第 ${slideNo(name)} 页】\n${xmlToText(xml)}`)
    }
  } else {
    const shared = read('xl/sharedStrings.xml')
    if (shared !== null) parts.push(xmlToText(shared))
    const sheets = Object.keys(files)
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort()
    if (sheets.length === 0 && shared === null) {
      return { ok: false, code: 'CORRUPT', reason: 'xlsx 里既没有共享字符串也没有工作表' }
    }
    for (const name of sheets) {
      const xml = read(name)
      if (xml !== null) parts.push(xmlToText(xml))
    }
  }

  const text = parts.join('\n').trim()
  if (text === '') return { ok: false, code: 'EMPTY_TEXT', reason: '文档里没有可提取的文字' }
  return { ok: true, text, kind: 'FILE_TEXT' }
}

function slideNo(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name)
  return m === null ? 0 : Number(m[1])
}

/** 入口：按内容/名称判定格式并提取。 */
export async function extractFileText(input: ExtractInput): Promise<ExtractOutcome> {
  const { bytes, fileName, mimeType, limits } = input

  if (bytes.byteLength > limits.maxBytes) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      reason: `文件 ${bytes.byteLength} 字节超过上限 ${limits.maxBytes} 字节，未做解析（原文件不受影响）`,
    }
  }

  // ① 图片 → 需要 OCR（按内容判格式）
  const imageMime = sniffImageMime(bytes)
  if (imageMime !== null || mimeType.toLowerCase().startsWith('image/')) {
    if (input.ocr === undefined) {
      return {
        ok: false,
        code: 'OCR_DISABLED',
        reason: '这是图片，需要模型视觉能力做 OCR；当前 OCR 未启用（缺密钥或已关闭）——只索引了元数据',
      }
    }
    try {
      const result = await input.ocr({ bytes, mimeType: imageMime ?? mimeType, fileName })
      const text = result.text.trim()
      if (text === '') return { ok: false, code: 'EMPTY_TEXT', reason: 'OCR 没有识别出文字' }
      return { ok: true, text: text.slice(0, limits.maxChars), kind: 'FILE_OCR', usage: result.usage }
    } catch (error) {
      return { ok: false, code: 'OCR_FAILED', reason: `OCR 调用失败：${(error as Error).message}` }
    }
  }

  // ② Office 家族（zip + 固定 XML 成员）
  const office = extractOfficeText(bytes, fileName)
  if (office !== null) {
    if (office.ok) return { ...office, text: office.text.slice(0, limits.maxChars) }
    return office
  }

  // ③ 纯文本类
  if (looksLikeText(fileName, mimeType)) {
    const text = bytes.toString('utf8').trim()
    if (text === '') return { ok: false, code: 'EMPTY_TEXT', reason: '文本文件是空的' }
    return { ok: true, text: text.slice(0, limits.maxChars), kind: 'FILE_TEXT' }
  }

  // ④ 明确不支持 —— 记录原因，不假装成功
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf') || mimeType.toLowerCase() === 'application/pdf') {
    return {
      ok: false,
      code: 'UNSUPPORTED_FORMAT',
      reason: 'PDF 文字层解析尚未接入（下一轮），本轮记为待处理 —— 原文件可正常预览与下载',
    }
  }
  if (lower.endsWith('.zip') || lower.endsWith('.rar') || lower.endsWith('.7z')) {
    return { ok: false, code: 'UNSUPPORTED_FORMAT', reason: '压缩包不做解压（安全策略）：不索引其内容' }
  }
  return {
    ok: false,
    code: 'UNSUPPORTED_FORMAT',
    reason: `暂不支持解析该格式（${mimeType || fileName}）`,
  }
}
