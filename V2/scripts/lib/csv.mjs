/**
 * scripts/lib/csv.mjs —— **合规**的 CSV 解析（RFC 4180）
 * ============================================================================
 * 为什么不能 `split(',')`：R2 控制台导出的对象清单里，**对象键天然带逗号**。
 * 例如 `uploads/76b60eb6-…/1791293126057-校服申领登记,副本.png` ——
 * 一次 `split(',')` 就把它劈成两段，key 变得不存在于桶里。
 * 后果不是"少一行"那么轻：对账时会**报出根本不存在的"对象消失"**，
 * 或者把真实存在的对象判成缺失 —— 这正是业主 Stage 13C.1 §二点出的问题。
 *
 * 所以这里的规则是"要么正确解析，要么明确报错"，**不偷偷跳过任何一行**：
 *   · 支持双引号包裹的字段（字段内的逗号、双引号 `""`、合法换行）；
 *   · 支持 CRLF / LF、UTF-8 BOM；
 *   · 引号未闭合、引号闭合后还有多余字符、引号出现在未加引号字段中间 —— 一律抛错；
 *   · 出错信息带**行号/列号**，便于把导出文件打开来对着看。
 *
 * 不引入第三方依赖：这段规则很短很稳定，而清单工具会跑在运维现场，
 * 越少的依赖越好（也避免"为了解析一行 CSV 引入一个几百 KB 的包"）。
 */

export class CsvError extends Error {
  constructor(message, { line = null, column = null } = {}) {
    const where = line === null ? '' : `（第 ${line} 行${column === null ? '' : `第 ${column} 列`}）`
    super(`${message}${where}`)
    this.name = 'CsvError'
    this.line = line
    this.column = column
  }
}

/**
 * 解析 CSV 文本 → 二维数组（每行是字符串数组）。
 *
 * @param {string} text
 * @returns {string[][]}
 * @throws {CsvError} 格式损坏时抛出（调用方应据此**失败**，而不是跳过）
 */
export function parseCsv(text) {
  // UTF-8 BOM：Windows/Excel 导出常见，留着会让第一个表头变成 `\uFEFFkey`
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows = []
  let row = []
  let field = ''
  let line = 1
  let fieldStartLine = 1
  let fieldStartColumn = 1
  let inQuotes = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < src.length) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        // 引号闭合之后只允许：分隔符、换行、文件结束
        const next = src[i]
        if (next !== undefined && next !== ',' && next !== '\r' && next !== '\n') {
          throw new CsvError('引号闭合后还有多余字符', { line, column: i + 1 })
        }
        continue
      }
      if (ch === '\n') line += 1
      field += ch
      i += 1
      continue
    }

    if (ch === '"') {
      if (field !== '') {
        throw new CsvError('引号出现在未加引号的字段中间', { line, column: i + 1 })
      }
      inQuotes = true
      fieldStartLine = line
      fieldStartColumn = i + 1
      i += 1
      continue
    }

    if (ch === ',') {
      endField()
      fieldStartLine = line
      fieldStartColumn = i + 2
      i += 1
      continue
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      endRow()
      line += 1
      fieldStartLine = line
      fieldStartColumn = 1
      i += 1
      continue
    }

    field += ch
    i += 1
  }

  if (inQuotes) {
    throw new CsvError('引号没有闭合（文件在引号中间就结束了）', {
      line: fieldStartLine,
      column: fieldStartColumn,
    })
  }
  // 最后一行没有换行结尾时仍要收进去；纯空白结尾不算一行
  if (field !== '' || row.length > 0) endRow()

  return rows
}
