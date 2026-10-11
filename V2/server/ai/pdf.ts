/**
 * server/ai/pdf.ts —— PDF 文本提取（零依赖，够用即止，**宁可少也不要乱码**）
 * ============================================================================
 * 业主 Stage 15 §五 要求"已上传的文档能被检索"。Word/PPT 导出的 PDF 里，
 * 正文是按字符编码存在内容流里的，取出来就能索引；但 PDF 没有"一段文字"这种概念，
 * 只有"在某个位置画某个字形"，所以要自己把这几步接起来：
 *
 *   ① 找对象：`N 0 obj … endobj`，以及新一代 PDF 的**对象流**（`/Type /ObjStm`，
 *      对象本身被 Flate 压缩在一个流里）—— 不处理它就等于只能读老文件；
 *   ② 解压流：`/Filter /FlateDecode` 用 zlib（Node 内置，不引依赖）；
 *   ③ 找字符到 Unicode 的映射：字体字典的 `/ToUnicode` CMap
 *      （`beginbfchar` / `beginbfrange`）—— **中文 PDF 全靠它**；
 *   ④ 读内容流：`Tf` 选字体、`Tj`/`TJ`/`'`/`"` 画文字，
 *      `Td`/`TD`/`T*`/`ET` 换行，`TJ` 里的小负数当空格。

 * ## 最重要的设计决定：**宁可少，也不要乱码**
 *
 * 索引一旦被灌进乱码，最坏后果不是"搜不到"，而是"AI 拿着乱码硬答"（业主 §九 明确禁止）。
 * 所以这里有一条硬规则：
 *   · 两字节字体的文码**没有** ToUnicode → **一个字符都不输出**（不是猜、不是按 latin1 硬翻）；
 *   · 单字节字体没有 ToUnicode → 按 WinAnsi/ASCII 解（英文 PDF 的常规情况），
 *     但只接受 0x20~0xFF，控制字符丢弃；
 *   · 解出来的正文如果短于阈值（例如扫描件只有零星几个字符）→ 返回 EMPTY_TEXT，
 *     由调用方如实记 SKIPPED（"扫描件，本轮不索引"），而不是把几行噪声入库。
 *
 * 加密 PDF（`/Encrypt`）直接判为不支持 —— 不去猜密码，也不假装读到了。
 */
import { inflateSync } from 'node:zlib'

export interface PdfExtractResult {
  readonly ok: boolean
  readonly text: string
  readonly reason?: string
  /** 用到了 ToUnicode 的字体数 / 两字节字体数（诊断用：中文 PDF 是否走通一眼能看出来）。 */
  readonly fonts: { readonly total: number; readonly mapped: number }
}

/** 一个 PDF 对象：字典文本 + 可选的（已解压的）流内容。 */
interface PdfObject {
  readonly num: number
  readonly dict: string
  readonly data: Buffer | null
}

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)(?:\bendobj\b|$)/g

/** 从字典文本里取一个键的值（只做这一种最常见的形态，不做完整解析器）。 */
function dictValue(dict: string, key: string): string | null {
  const m = new RegExp(`/${key}\\s*([^/<>\\[\\]()]*?)(?=/[A-Za-z]|>>|\\]|$)`).exec(dict)
  return m === null ? null : m[1].trim()
}

/** `/Root 3 0 R` / `/Length 12` / `/Filter [/FlateDecode]` 都能取到。 */
function dictRef(dict: string, key: string): number | null {
  const raw = dictValue(dict, key)
  if (raw === null) return null
  const m = /(\d+)\s+\d+\s+R/.exec(raw)
  if (m !== null) return Number(m[1])
  return null
}

/** 取流字节：`stream` 与 `endstream` 之间（按 /Length 优先，否则找 endstream）。 */
function streamBytes(raw: Buffer, offset: number): Buffer | null {
  const head = raw.subarray(offset).toString('latin1')
  const at = head.indexOf('stream')
  if (at === -1) return null
  let start = offset + at + 'stream'.length
  // stream 关键字后面必须是 CRLF 或 LF（规范如此）
  if (raw[start] === 0x0d) start += 1
  if (raw[start] === 0x0a) start += 1
  const tail = raw.subarray(start).toString('latin1')
  const end = tail.indexOf('endstream')
  if (end === -1) return null
  let slice = raw.subarray(start, start + end)
  // endstream 前通常会有一个换行，不属于数据
  while (slice.length > 0 && (slice[slice.length - 1] === 0x0a || slice[slice.length - 1] === 0x0d)) {
    slice = slice.subarray(0, slice.length - 1)
  }
  return slice
}

function inflate(data: Buffer): Buffer | null {
  try {
    return inflateSync(data)
  } catch {
    try {
      // 有些流带 zlib 头信息差异，退回"原始 deflate"再试一次
      return inflateSync(data, { finishFlush: 2 })
    } catch {
      return null
    }
  }
}

/** 收集全部对象（含对象流里被压缩的那些）。 */
function collectObjects(raw: Buffer): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>()
  const latin = raw.toString('latin1')

  OBJ_RE.lastIndex = 0
  let match: RegExpExecArray | null
  const pending: { num: number; dict: string; streamAt: number }[] = []
  while ((match = OBJ_RE.exec(latin)) !== null) {
    const num = Number(match[1])
    const body = match[3]
    const dictEnd = body.indexOf('>>')
    const dict = dictEnd === -1 ? body : body.slice(0, dictEnd + 2)
    const streamAt = match.index + match[0].indexOf(body) + body.indexOf('stream')
    pending.push({ num, dict, streamAt: body.includes('stream') ? streamAt : -1 })
  }

  for (const item of pending) {
    const data = item.streamAt === -1 ? null : streamBytes(raw, item.streamAt)
    const filter = item.dict.includes('FlateDecode') ? 'flate' : 'none'
    const decoded = data === null ? null : filter === 'flate' ? inflate(data) : data
    objects.set(item.num, { num: item.num, dict: item.dict, data: decoded })
  }

  // 对象流：里面的对象也要能取到（现代 PDF 的字体/资源常常在这里）
  for (const object of [...objects.values()]) {
    if (!object.dict.includes('/ObjStm') || object.data === null) continue
    const text = object.data.toString('latin1')
    const count = Number(dictValue(object.dict, 'N') ?? '0')
    const first = Number(dictValue(object.dict, 'First') ?? '0')
    const header = text.slice(0, first).trim().split(/\s+/).map(Number)
    for (let i = 0; i < count; i += 1) {
      const num = header[i * 2]
      const offset = header[i * 2 + 1]
      if (!Number.isFinite(num) || !Number.isFinite(offset)) continue
      const nextOffset = i + 1 < count ? header[(i + 1) * 2 + 1] : text.length - first
      const body = text.slice(first + offset, Number.isFinite(nextOffset) ? first + nextOffset : undefined)
      const dictEnd = body.indexOf('>>')
      objects.set(num, { num, dict: dictEnd === -1 ? body : body.slice(0, dictEnd + 2), data: null })
    }
  }

  return objects
}

/** 解析 ToUnicode CMap：beginbfchar / beginbfrange（含数组形式的 range）。 */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>()
  const hexToText = (hex: string): string => {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '')
    let out = ''
    for (let i = 0; i + 4 <= clean.length; i += 4) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16))
    }
    return out
  }

  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of block.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) ?? []) {
      const m = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(pair)
      if (m === null) continue
      map.set(parseInt(m[1], 16), hexToText(m[2]))
    }
  }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    /*
      两种形态，**必须先判数组形态**：
        形态一：`<lo> <hi> <dst>`        连续码位
        形态二：`<lo> <hi> [<d1> <d2> …]` 逐个指定
      为什么顺序要紧（实测踩到）：形态一的正则能在一行数组里**从中间**匹配上
      ——`<0001> <0004> [<5468> <8ba1> <5212> <ff1a>]` 会匹配成
      lo=0x5468 / hi=0x8ba1 / dst=0x5212（于是 lo>hi，一个映射都不写，还把它当成
      "形态一已处理"而跳过了数组分支）。表现是**前几个字消失**，
      而且不报错 —— 中文 PDF 一旦这样，标题里的关键词就检索不到了。
    */
    for (const line of block.split('\n')) {
      const array = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/.exec(line)
      if (array !== null) {
        const lo = parseInt(array[1], 16)
        const targets = array[3].match(/<([0-9a-fA-F]+)>/g) ?? []
        targets.forEach((t, i) => {
          const hex = /<([0-9a-fA-F]+)>/.exec(t)
          if (hex !== null) map.set(lo + i, hexToText(hex[1]))
        })
        continue
      }
      if (line.includes('[')) continue
      const simple = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(line)
      if (simple === null) continue
      const lo = parseInt(simple[1], 16)
      const hi = parseInt(simple[2], 16)
      const dst = parseInt(simple[3], 16)
      for (let code = lo; code <= hi && code - lo < 65_536; code += 1) {
        map.set(code, String.fromCharCode(dst + (code - lo)))
      }
    }
  }
  return map
}

/** 内容流里的字符串（字面量 `(…)` 或十六进制 `<…>`）解码成"码点序列"。 */
function decodeStringBody(body: string, hex: boolean): number[] {
  if (hex) {
    const clean = body.replace(/[^0-9a-fA-F]/g, '')
    const codes: number[] = []
    for (let i = 0; i + 2 <= clean.length; i += 2) codes.push(parseInt(clean.slice(i, i + 2), 16))
    return codes
  }
  const codes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '\\') {
      codes.push(body.charCodeAt(i))
      continue
    }
    const next = body[i + 1]
    if (next === undefined) break
    if (next === 'n') codes.push(10)
    else if (next === 'r') codes.push(13)
    else if (next === 't') codes.push(9)
    else if (next === 'b') codes.push(8)
    else if (next === 'f') codes.push(12)
    else if (next >= '0' && next <= '7') {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))
      if (oct !== null) {
        codes.push(parseInt(oct[0], 8))
        i += oct[0].length
        continue
      }
      codes.push(next.charCodeAt(0))
    } else if (next === '\n') {
      // 行尾反斜杠 = 续行，什么都不加
    } else codes.push(next.charCodeAt(0))
    i += 1
  }
  return codes
}

/** 把内容流里的字符串片段按顺序抽出来，并保留"换行/空格"的语义。 */
function textFromContentStream(content: string, fonts: Map<string, FontInfo>): string {
  const out: string[] = []
  let currentFont: FontInfo | null = null
  let pendingText: string[] = []

  const flush = (): void => {
    if (pendingText.length === 0) return
    out.push(pendingText.join(''))
    pendingText = []
  }

  const decode = (codes: number[]): string => {
    if (currentFont === null) {
      // 没有选字体就画字：只在全是可打印 ASCII 时才认（保守）
      return codes.every((c) => c >= 0x20 && c < 0x7f) ? codes.map((c) => String.fromCharCode(c)).join('') : ''
    }
    if (currentFont.twoByte) {
      if (currentFont.toUnicode.size === 0) return '' // 两字节且无映射 → 不猜，直接丢
      let text = ''
      for (let i = 0; i + 2 <= codes.length; i += 2) {
        const code = (codes[i] << 8) | codes[i + 1]
        text += currentFont.toUnicode.get(code) ?? ''
      }
      return text
    }
    let text = ''
    for (const code of codes) {
      const mapped = currentFont.toUnicode.get(code)
      if (mapped !== undefined) text += mapped
      else if (code >= 0x20 && code <= 0xff) text += String.fromCharCode(code)
    }
    return text
  }

  // 逐算子扫描：`/F1 12 Tf`、`(…) Tj`、`[(…) -200 (…)] TJ`、`T*`、`Td`、`TD`、`ET`
  const token = /\/([A-Za-z0-9#+._-]+)\s+[\d.]+\s+Tf|\((?:[^()\\]|\\.)*\)\s*Tj|<[0-9a-fA-F\s]*>\s*Tj|\[(?:[^[\]\\]|\\.)*\]\s*TJ|\bT\*|\bTd\b|\bTD\b|\bET\b|\bTJ\b/g

  for (const m of content.matchAll(token)) {
    const raw = m[0]
    if (raw.endsWith('Tf')) {
      currentFont = fonts.get(m[1]) ?? null
      continue
    }
    if (raw.endsWith('TJ')) {
      const array = raw.slice(raw.indexOf('[') + 1, raw.lastIndexOf(']'))
      // 数组里：<…> 或 (…) 是字，数字是位移（负得比较多 → 空格）
      for (const piece of array.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:[^()\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g)) {
        if (piece[1] !== undefined) pendingText.push(decode(decodeStringBody(piece[1], true)))
        else if (piece[2] !== undefined) pendingText.push(decode(decodeStringBody(piece[2], false)))
        else if (piece[3] !== undefined && Number(piece[3]) <= -100) pendingText.push(' ')
      }
      continue
    }
    if (raw.endsWith('Tj')) {
      const hex = raw[0] === '<'
      pendingText.push(decode(decodeStringBody(raw.slice(hex ? 1 : 0, raw.lastIndexOf(hex ? '>' : ')')).trim(), hex)))
      continue
    }
    // 换行/段落类算子
    flush()
    out.push('\n')
  }

  flush()
  return out.join('')
}

interface FontInfo {
  readonly twoByte: boolean
  readonly toUnicode: Map<number, string>
}

/** 从对象集合里组装"资源名 → 字体"的映射（只做最常用的一层：/Font << /F1 N 0 R >>）。 */
function collectFonts(objects: Map<number, PdfObject>): { fonts: Map<string, FontInfo>; total: number; mapped: number } {
  const byObject = new Map<number, FontInfo>()
  let total = 0
  let mapped = 0

  for (const object of objects.values()) {
    if (!/\/Type\s*\/Font/.test(object.dict) && !/\/Subtype\s*\/(Type0|TrueType|Type1|CIDFontType0|CIDFontType2)/.test(object.dict)) {
      continue
    }
    total += 1
    const twoByte = /\/Subtype\s*\/Type0/.test(object.dict)
    const cmapRef = dictRef(object.dict, 'ToUnicode')
    let toUnicode = new Map<number, string>()
    if (cmapRef !== null) {
      const cmapObject = objects.get(cmapRef)
      if (cmapObject?.data != null) toUnicode = parseToUnicode(cmapObject.data.toString('latin1'))
    }
    // 子字体（CIDFont）也可能挂 ToUnicode；父字典没有就往下找一层
    if (toUnicode.size === 0) {
      const descendant = dictRef(object.dict, 'DescendantFonts')
      if (descendant !== null) {
        const child = objects.get(descendant)
        const childCmap = child === undefined ? null : dictRef(child.dict, 'ToUnicode')
        const childCmapObject = childCmap === null ? undefined : objects.get(childCmap)
        if (childCmapObject?.data != null) toUnicode = parseToUnicode(childCmapObject.data.toString('latin1'))
      }
    }
    if (toUnicode.size > 0) mapped += 1
    byObject.set(object.num, { twoByte, toUnicode })
  }

  // 资源字典：`/Font << /F1 12 0 R /F2 13 0 R >>`
  const fonts = new Map<string, FontInfo>()
  for (const object of objects.values()) {
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(object.dict)
    if (fontDict === null) continue
    for (const ref of fontDict[1].matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const info = byObject.get(Number(ref[2]))
      if (info !== undefined) fonts.set(ref[1], info)
    }
  }
  // 资源字典在对象流里时上面拿不到：退一步，按顺序把已解析字体当作 F1..Fn
  if (fonts.size === 0 && byObject.size > 0) {
    let index = 1
    for (const info of byObject.values()) {
      fonts.set(`F${index}`, info)
      index += 1
    }
  }
  return { fonts, total, mapped }
}

/**
 * 提取 PDF 正文。
 *
 * @param maxChars 上限（超长文档只取前 N 个字符，避免把 token 预算打爆）
 */
export function extractPdfText(bytes: Buffer, options: { readonly maxChars: number }): PdfExtractResult {
  const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('latin1')
  if (!head.startsWith('%PDF-')) {
    return { ok: false, text: '', reason: '不是 PDF（缺少 %PDF- 头）', fonts: { total: 0, mapped: 0 } }
  }
  if (/\/Encrypt\b/.test(bytes.subarray(0, Math.min(bytes.length, 200_000)).toString('latin1'))) {
    return { ok: false, text: '', reason: 'PDF 已加密，未做解密（不猜密码）', fonts: { total: 0, mapped: 0 } }
  }

  const objects = collectObjects(bytes)
  const { fonts, total, mapped } = collectFonts(objects)

  const pieces: string[] = []
  let used = 0
  for (const object of objects.values()) {
    if (object.data === null) continue
    const content = object.data.toString('latin1')
    // 只看内容流：必须有文本算子
    if (!/\bBT\b/.test(content) || !/(Tj|TJ)\b/.test(content)) continue
    const text = textFromContentStream(content, fonts)
    if (text.trim() === '') continue
    const room = options.maxChars - used
    if (room <= 0) break
    pieces.push(text.length > room ? text.slice(0, room) : text)
    used += Math.min(text.length, room)
  }

  const text = pieces
    .join('\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // 太短 → 几乎肯定是扫描件（只有页眉页脚几个字），如实报告，不往索引里灌噪声
  if (text.length < 16) {
    return {
      ok: false,
      text: '',
      reason:
        text.length === 0
          ? 'PDF 里没有可提取的文字层（多半是扫描件或纯图片 PDF）——本轮不索引'
          : `PDF 可提取的文字过少（${text.length} 字），疑似扫描件——本轮不索引`,
      fonts: { total, mapped },
    }
  }
  return { ok: true, text, fonts: { total, mapped } }
}
