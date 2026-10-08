#!/usr/bin/env node
/**
 * scripts/crosscheck-v1-production.mjs —— 生产快照 vs 本机"生产等价"数据
 * ============================================================================
 * 业主的要求：本机那份数据**没有资格**当生产源，它只能用来交叉核对。
 * 这个脚本就是那次核对，而且它**不替任何一方说话**：
 * 一致就报 `LOCAL_EQUIVALENT_MATCHES_PRODUCTION_EXPORT`，
 * 不一致就逐项列出差异 —— 哪一条只在生产里、哪一条只在本机、哪些字段不一样。
 *
 * 比对的不只是 `resources.total`（业主特别点名过 347/348 这一类差异）：
 *   · 各表行数
 *   · resources：id 集合、title、status、uploader、directory、deleted_at（回收站）、
 *     文件元数据（file_path/file_name/file_size/file_type）
 *   · teachers：用户名集合
 *   · directories：树路径集合
 *   · audit_logs：条数 + 时间范围
 *
 * 用法：
 *   node scripts/crosscheck-v1-production.mjs --snapshot <ndjson> \
 *     [--local postgresql://…/qls_test_0005] [--out 报告.md] [--json 证据.json]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const snapshotPath = resolve(ROOT, arg('snapshot', ''))
if (arg('snapshot') === null) {
  console.error('用法：node scripts/crosscheck-v1-production.mjs --snapshot <prod-export.ndjson> [--local <V1_URL>]')
  process.exit(1)
}
const localUrl = arg('local', 'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005')

// ── 读生产快照 ──────────────────────────────────────────────────────────────
const prod = {}
let header = null
let footer = null
for (const line of readFileSync(snapshotPath, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  const obj = JSON.parse(line)
  if (obj.kind === 'header') header = obj
  else if (obj.kind === 'footer') footer = obj
  else if (obj.kind === 'row') (prod[obj.table] ??= []).push(obj.row)
}

// ── 读本机 V1 ───────────────────────────────────────────────────────────────
const sql = postgres(localUrl, { max: 1, onnotice: () => {} })
const local = {}
for (const t of ['teachers', 'directories', 'resources', 'review_records', 'audit_logs', 'resource_versions']) {
  local[t] = await sql.unsafe(`SELECT * FROM "${t}"`)
}
await sql.end()

// ── 比对 ────────────────────────────────────────────────────────────────────
const lines = []
const diffs = []
const say = (s = '') => lines.push(s)

say('## 行数对照')
say()
say('| 表 | 生产快照 | 本机 qls_test_0005 | 一致？ |')
say('|---|---:|---:|---|')
for (const t of ['teachers', 'directories', 'resources', 'review_records', 'audit_logs', 'resource_versions']) {
  const p = (prod[t] ?? []).length
  const l = (local[t] ?? []).length
  const same = p === l
  if (!same) diffs.push(`表 ${t}：生产 ${p} 行，本机 ${l} 行`)
  say(`| ${t} | ${p} | ${l} | ${same ? '✅' : '❌'} |`)
}
say()

const idSet = (rows, key = 'id') => new Set(rows.map((r) => String(r[key])))

// resources：id 集合 + 关键字段
{
  const p = prod.resources ?? []
  const l = local.resources ?? []
  const pIds = idSet(p)
  const lIds = idSet(l)
  const onlyProd = [...pIds].filter((id) => !lIds.has(id))
  const onlyLocal = [...lIds].filter((id) => !pIds.has(id))
  const common = [...pIds].filter((id) => lIds.has(id))
  const pById = new Map(p.map((r) => [String(r.id), r]))
  const lById = new Map(l.map((r) => [String(r.id), r]))

  const fields = ['title', 'status', 'uploader_id', 'directory_id', 'deleted_at', 'file_path', 'file_name', 'file_size', 'file_type']
  const fieldDiffs = {}
  for (const id of common) {
    for (const f of fields) {
      const a = pById.get(id)?.[f] ?? null
      const b = lById.get(id)?.[f] ?? null
      if (String(a) !== String(b)) {
        fieldDiffs[f] = fieldDiffs[f] ?? []
        fieldDiffs[f].push({ id, 生产: a, 本机: b })
      }
    }
  }

  say('## resources 逐项')
  say()
  say(`- 只在生产里：**${onlyProd.length}**${onlyProd.length ? '（' + onlyProd.slice(0, 5).join(', ') + '…）' : ''}`)
  say(`- 只在本机：**${onlyLocal.length}**${onlyLocal.length ? '（' + onlyLocal.slice(0, 5).join(', ') + '…）' : ''}`)
  say(`- 两边都有：${common.length} 条`)
  say()
  const fieldNames = Object.keys(fieldDiffs)
  if (fieldNames.length === 0) {
    say('共有 id 的关键字段：**全部相同**（title / status / uploader / directory / deleted_at / 文件元数据）')
  } else {
    say('共有 id 上**字段有差异**：')
    say()
    say('| 字段 | 差异条数 | 样例 |')
    say('|---|---:|---|')
    for (const f of fieldNames) {
      const sample = fieldDiffs[f][0]
      say(`| ${f} | ${fieldDiffs[f].length} | ${sample.id.slice(0, 8)}：生产 \`${sample.生产}\` / 本机 \`${sample.本机}\` |`)
      diffs.push(`resources.${f}：${fieldDiffs[f].length} 条不同`)
    }
  }
  say()

  // 回收站
  const pRecycled = p.filter((r) => r.deleted_at !== null && r.deleted_at !== undefined).length
  const lRecycled = l.filter((r) => r.deleted_at !== null && r.deleted_at !== undefined).length
  const pHasFile = p.filter((r) => (r.file_name ?? null) !== null || (r.file_path ?? null) !== null).length
  const lHasFile = l.filter((r) => (r.file_name ?? null) !== null || (r.file_path ?? null) !== null).length
  say('## 业主点名的四项')
  say()
  say('| 项 | 生产快照 | 本机 | 一致？ |')
  say('|---|---:|---:|---|')
  say(`| 资源总数 | ${p.length} | ${l.length} | ${p.length === l.length ? '✅' : '❌'} |`)
  say(`| 回收站（deleted_at 非空） | ${pRecycled} | ${lRecycled} | ${pRecycled === lRecycled ? '✅' : '❌'} |`)
  say(`| 带文件元数据的资源 | ${pHasFile} | ${lHasFile} | ${pHasFile === lHasFile ? '✅' : '❌'} |`)
  const probeLike = (rows) => rows.filter((r) => /probe|探针|scope_|rbac_keeper|no-username|__/i.test(JSON.stringify(r))).length
  say(`| 疑似探针/夹具痕迹 | ${probeLike(p)} | ${probeLike(l)} | ${probeLike(p) === probeLike(l) ? '✅' : '❌'} |`)
  say()
  if (pRecycled !== lRecycled) diffs.push(`回收站：生产 ${pRecycled}，本机 ${lRecycled}`)
  if (pHasFile !== lHasFile) diffs.push(`带文件元数据的资源：生产 ${pHasFile}，本机 ${lHasFile}`)
}

// teachers：用户名集合
{
  const p = prod.teachers ?? []
  const l = local.teachers ?? []
  const pNames = new Set(p.map((r) => String(r.username ?? r.name)))
  const lNames = new Set(l.map((r) => String(r.username ?? r.name)))
  const onlyProd = [...pNames].filter((n) => !lNames.has(n))
  const onlyLocal = [...lNames].filter((n) => !pNames.has(n))
  say('## teachers 用户名集合')
  say()
  say(`- 只在生产里（${onlyProd.length}）：${onlyProd.join(', ') || '（无）'}`)
  say(`- 只在本机（${onlyLocal.length}）：${onlyLocal.join(', ') || '（无）'}`)
  say()
  if (onlyProd.length || onlyLocal.length) {
    diffs.push(`teachers 用户名：生产独有 ${onlyProd.length} 个、本机独有 ${onlyLocal.length} 个`)
  }
}

// directories：路径集合
{
  const path = (rows) => {
    const byId = new Map(rows.map((r) => [String(r.id), r]))
    const out = new Set()
    for (const r of rows) {
      const parts = []
      let cur = r
      let guard = 0
      while (cur && guard++ < 20) {
        parts.unshift(String(cur.slug ?? cur.name ?? '?'))
        cur = cur.parent_id ? byId.get(String(cur.parent_id)) : null
      }
      out.add(parts.join('/'))
    }
    return out
  }
  const p = path(prod.directories ?? [])
  const l = path(local.directories ?? [])
  const onlyProd = [...p].filter((x) => !l.has(x))
  const onlyLocal = [...l].filter((x) => !p.has(x))
  say('## directories 树路径')
  say()
  say(`- 生产 ${p.size} 条路径，本机 ${l.size} 条路径`)
  say(`- 只在生产里（${onlyProd.length}）：${onlyProd.slice(0, 10).join(', ') || '（无）'}`)
  say(`- 只在本机（${onlyLocal.length}）：${onlyLocal.slice(0, 10).join(', ') || '（无）'}`)
  say()
  if (onlyProd.length || onlyLocal.length) diffs.push(`directories 路径：生产独有 ${onlyProd.length}、本机独有 ${onlyLocal.length}`)
}

// audit_logs 时间范围
{
  const range = (rows) => {
    const times = rows.map((r) => String(r._created_at ?? r.created_at ?? '')).filter((x) => x !== '').sort()
    return { first: times[0] ?? null, last: times[times.length - 1] ?? null }
  }
  const p = range(prod.audit_logs ?? [])
  const l = range(local.audit_logs ?? [])
  say('## audit_logs 时间范围')
  say()
  say(`- 生产：${(prod.audit_logs ?? []).length} 条，${p.first} → ${p.last}`)
  say(`- 本机：${(local.audit_logs ?? []).length} 条，${l.first} → ${l.last}`)
  say()
}

// ── 判定 ────────────────────────────────────────────────────────────────────
const verdict = diffs.length === 0 ? 'LOCAL_EQUIVALENT_MATCHES_PRODUCTION_EXPORT' : 'LOCAL_EQUIVALENT_DIFFERS_FROM_PRODUCTION_EXPORT'
say('## 判定')
say()
say('```')
say(verdict)
say('```')
say()
if (diffs.length > 0) {
  say('差异清单：')
  say()
  for (const d of diffs) say(`- ${d}`)
  say()
  say('> 按业主的规则：**本机数据没有资格覆盖生产快照**。不一致时不要自行猜哪份正确，')
  say('> 停下来报告。生产切换的唯一 source of truth 是上面那份带 sha256 的生产快照。')
} else {
  say('本机"生产等价"数据与生产快照逐项一致。')
}

const report = lines.join('\n') + '\n'
const outPath = arg('out', null)
if (outPath !== null) writeFileSync(resolve(ROOT, outPath), report)
const jsonPath = arg('json', null)
if (jsonPath !== null) {
  writeFileSync(
    resolve(ROOT, jsonPath),
    JSON.stringify({ snapshotPath, localUrl, header, footerCounts: footer?.counts ?? null, verdict, diffs }, null, 2) + '\n',
  )
}

console.log(report)
console.log(`判定：${verdict}`)
console.log(`差异 ${diffs.length} 项`)
process.exit(verdict === 'LOCAL_EQUIVALENT_MATCHES_PRODUCTION_EXPORT' ? 0 : 5)
