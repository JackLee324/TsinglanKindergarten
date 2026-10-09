/**
 * scripts/lib/inventory-source.mjs —— 解析**清单来源**（控制台导出的 JSON / CSV）
 * ============================================================================
 * 业主 Stage 13C.1 §二：解析必须"要么正确，要么报错"，**不许悄悄跳过坏行** ——
 * 静默跳过会让对账少几条对象，而"少几条"看起来和"对象被删了"一模一样。
 *
 * 三条规则：
 *   1. **JSON 优先**：控制台的完整 JSON 导出没有歧义，文档里也优先推荐它；
 *   2. **CSV 按 RFC 4180 解析**（`scripts/lib/csv.mjs`）：支持带引号字段、
 *      字段内逗号/双引号/换行、CRLF、BOM；
 *   3. **任何异常都失败**：缺 key、空 key、非法 size、列数不符、重复 key、
 *      结构无法解释 —— 一律抛出 `InventorySourceError`，并带行号。
 */
import { CsvError, parseCsv } from './csv.mjs'

export class InventorySourceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InventorySourceError'
  }
}

const KEY_ALIASES = ['key', 'name', 'object key', 'objectkey', '对象键', '文件名']
const SIZE_ALIASES = ['size', 'bytes', 'object size', '大小', '字节']

const norm = (s) => String(s ?? '').trim().toLowerCase()

/** 严格解析 size：非负整数（允许字符串形式的数字）。 */
function parseSize(value, where) {
  const text = String(value ?? '').trim()
  if (text === '') throw new InventorySourceError(`${where}：size 为空`)
  if (!/^\d+$/.test(text)) throw new InventorySourceError(`${where}：size 不是非负整数（"${text}"）`)
  return Number(text)
}

/** 收集重复 key —— 重复通常意味着"两个导出被拼在了一起"，对账前必须失败。 */
function assertNoDuplicates(objects) {
  const seen = new Map()
  for (const o of objects) {
    const n = (seen.get(o.key) ?? 0) + 1
    seen.set(o.key, n)
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
  if (dup.length > 0) {
    throw new InventorySourceError(
      `清单里出现重复对象键（常见原因：两次导出被拼在一起）—— 共 ${dup.length} 个，例如：${dup.slice(0, 3).join(' | ')}`,
    )
  }
}

/** JSON 导出 → objects（接受数组 / {objects} / {Contents} / {items} 四种形状）。 */
function parseJsonExport(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new InventorySourceError(`JSON 解析失败：${error.message}`)
  }

  let rows
  if (Array.isArray(parsed)) rows = parsed
  else if (parsed !== null && typeof parsed === 'object') {
    const candidate = parsed.objects ?? parsed.Contents ?? parsed.items
    if (!Array.isArray(candidate)) {
      throw new InventorySourceError(
        'JSON 结构无法解释：期望数组，或含 objects / Contents / items 数组的对象。',
      )
    }
    rows = candidate
  } else {
    throw new InventorySourceError('JSON 结构无法解释：既不是数组也不是对象。')
  }

  return rows.map((r, index) => {
    const where = `第 ${index + 1} 条`
    if (r === null || typeof r !== 'object') throw new InventorySourceError(`${where}：不是对象`)
    const key = r.key ?? r.Key ?? r.name ?? r.Name
    if (typeof key !== 'string' || key.trim() === '') {
      throw new InventorySourceError(`${where}：缺少对象键（key / Key / name）`)
    }
    const size = parseSize(r.size ?? r.Size ?? r.bytes, where)
    const lastModified = r.lastModified ?? r.LastModified ?? ''
    const etag = String(r.etag ?? r.ETag ?? '').replaceAll('"', '')
    return {
      key: key.trim(),
      size,
      lastModified: lastModified instanceof Date ? lastModified.toISOString() : String(lastModified ?? ''),
      etag,
    }
  })
}

/** CSV 导出 → objects（表头必须在第一行）。 */
function parseCsvExport(text) {
  let rows
  try {
    rows = parseCsv(text)
  } catch (error) {
    if (error instanceof CsvError) throw new InventorySourceError(`CSV 解析失败：${error.message}`)
    throw error
  }
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''))
  if (nonEmpty.length === 0) throw new InventorySourceError('CSV 里没有任何行。')

  const header = nonEmpty[0].map(norm)
  const keyIdx = header.findIndex((h) => KEY_ALIASES.includes(h))
  const sizeIdx = header.findIndex((h) => SIZE_ALIASES.includes(h))
  if (keyIdx < 0) {
    throw new InventorySourceError(
      `CSV 表头里找不到对象键列（认得的列名：${KEY_ALIASES.join(' / ')}）；实际表头：${nonEmpty[0].join(' | ')}`,
    )
  }
  if (sizeIdx < 0) {
    throw new InventorySourceError(
      `CSV 表头里找不到大小列（认得的列名：${SIZE_ALIASES.join(' / ')}）；实际表头：${nonEmpty[0].join(' | ')}`,
    )
  }

  const objects = []
  for (let i = 1; i < nonEmpty.length; i += 1) {
    const row = nonEmpty[i]
    const where = `第 ${i + 1} 行`
    if (row.length !== nonEmpty[0].length) {
      throw new InventorySourceError(
        `${where}：列数与表头不符（表头 ${nonEmpty[0].length} 列，本行 ${row.length} 列）—— 不猜、不跳过`,
      )
    }
    const key = String(row[keyIdx] ?? '').trim()
    if (key === '') throw new InventorySourceError(`${where}：对象键为空`)
    objects.push({
      key,
      size: parseSize(row[sizeIdx], where),
      lastModified: '',
      etag: '',
    })
  }
  if (objects.length === 0) throw new InventorySourceError('CSV 只有表头，没有任何对象行。')
  return objects
}

/**
 * 解析控制台导出（按内容自动判别 JSON / CSV）。
 *
 * @param {string} text 文件内容
 * @param {{label?: string}} [options]
 * @returns {{format: 'json' | 'csv', objects: {key: string, size: number, lastModified: string, etag: string}[]}}
 */
export function parseConsoleExport(text, { label = '导出文件' } = {}) {
  const trimmed = text.trim()
  if (trimmed === '') throw new InventorySourceError(`${label}是空文件。`)
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  const objects = looksJson ? parseJsonExport(trimmed) : parseCsvExport(text)
  assertNoDuplicates(objects)
  return { format: looksJson ? 'json' : 'csv', objects }
}
