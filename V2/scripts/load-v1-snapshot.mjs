#!/usr/bin/env node
/**
 * scripts/load-v1-snapshot.mjs —— 把生产快照（NDJSON）还原成**本地 V1 库**
 * ============================================================================
 * 为什么需要它：正式迁移的正确做法是"从生产 V1 读"，而生产库在 Zeabur 内网，
 * 本机够不到。所以本机演练要**先把生产快照还原成一个真的 V1 库**，再让
 * `import-v1.mjs` 去读它 —— 这样演练用的就是**生产的真实数据**，
 * 而不是本机那份测试库（那份已证明与生产零重叠）。
 *
 * 表结构从哪来：用 `CREATE DATABASE … TEMPLATE <本机 V1 库>` 拿到**同一套真实 schema**
 * （V1 的 12 个 migration 已经在模板库里应用过；直接从零跑 V1 migration 会在
 * 0001 上失败 —— 它是"基线对齐"，假设表已经存在）。
 *
 * 用法：
 *   node scripts/load-v1-snapshot.mjs --snapshot <ndjson> [--template qls_test_0005]
 *     [--database qls_v1_prod_rehearsal] [--keep-existing]
 *
 * 安全性：只写本机演练库。拒绝指向非本机地址的目标。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const snapshotPath = resolve(ROOT, arg('snapshot', '.migration/prod-exports/prod-export-20261008_031823.ndjson'))
const template = arg('template', 'qls_test_0005')
const database = arg('database', 'qls_v1_prod_rehearsal')
const adminUrl = arg('admin-url', 'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/postgres')

// 只允许本机演练：这条脚本会 DROP/CREATE 库。
const host = new URL(adminUrl).hostname
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`拒绝执行：admin-url 指向 ${host}，这不是本机。`)
  process.exit(2)
}

// ── 读快照 ──────────────────────────────────────────────────────────────────
const tables = new Map() // table → { columns, rows }
let header = null
let footer = null
for (const line of readFileSync(snapshotPath, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  const obj = JSON.parse(line)
  if (obj.kind === 'header') header = obj
  else if (obj.kind === 'footer') footer = obj
  else if (obj.kind === 'table') {
    const t = tables.get(obj.table) ?? { columns: obj.columns ?? [], rows: [] }
    if ((obj.columns ?? []).length > 0) t.columns = obj.columns
    tables.set(obj.table, t)
  } else if (obj.kind === 'row') {
    const t = tables.get(obj.table) ?? { columns: [], rows: [] }
    t.rows.push(obj.row)
    tables.set(obj.table, t)
  }
}
console.log(`快照：${snapshotPath}`)
console.log(`来源：${header?.sourceDatabase ?? '?'}，生成于 ${header?.createdAt ?? '?'}`)
console.log(`表：${tables.size} 张，行：${[...tables.values()].reduce((n, t) => n + t.rows.length, 0)}`)

// ── 建库（从模板克隆 → 同一套真实 schema）─────────────────────────────────
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`
if (exists.length > 0) {
  // 断开可能还在的连接，否则 DROP 会失败
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`,
  )
  await admin.unsafe(`DROP DATABASE "${database}"`)
  console.log(`已删除旧库 ${database}`)
}
await admin.unsafe(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${template}' AND pid <> pg_backend_pid()`,
)
await admin.unsafe(`CREATE DATABASE "${database}" TEMPLATE "${template}"`)
await admin.end()
console.log(`已从模板 ${template} 克隆出 ${database}（真实 V1 schema）`)

const url = `postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/${database}`
const sql = postgres(url, { max: 1, onnotice: () => {} })

// ── 校验：快照里的每一列，目标库都要有 ─────────────────────────────────────
const problems = []
for (const [table, t] of tables) {
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`
  if (cols.length === 0) {
    problems.push(`表 ${table} 在目标库里不存在`)
    continue
  }
  const have = new Set(cols.map((c) => c.column_name))
  const missing = t.columns.filter((c) => !have.has(c))
  if (missing.length > 0) problems.push(`表 ${table} 缺少列：${missing.join(', ')}`)
}
if (problems.length > 0) {
  console.error('❌ 快照与目标 schema 不一致：')
  for (const p of problems) console.error(`   - ${p}`)
  await sql.end()
  process.exit(3)
}

// ── 清空 + 灌入 ─────────────────────────────────────────────────────────────
await sql.unsafe('SET session_replication_role = replica') // 关掉外键/触发器，按快照原样还原

/*
  ⚠️ 生成列（GENERATED ALWAYS AS …）不能显式插入：
  V1 的 `resources.has_stored_file` 就是生成列，而导出文件里带着它的值
  （导出走的是 SELECT *）。直接插会报 428C9。所以这里把它排除掉、让目标库重算，
  并且**核对重算出来的值与快照里的值是否一致** —— 排除不等于放过。
*/
const generatedByTable = new Map()
for (const table of tables.keys()) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND is_generated = 'ALWAYS'`
  generatedByTable.set(table, new Set(rows.map((r) => r.column_name)))
}

/*
  ⚠️ 先把**所有基表**一次性清空，再灌数据 —— 顺序不能反。

  为什么：这里踩过一次真实的坑。第一版是"按表循环：TRUNCATE 这张 → INSERT 这张"，
  于是当循环走到 `teachers`（对应 V2 的 users）时，`TRUNCATE teachers CASCADE`
  **顺着外键把 `resources` 也清了**（resources.uploader_id → teachers.id），
  而 resources 已经在前面灌好了 —— 结果 349 条资源被静默抹掉，脚本还报"349 已插入"。
  更糟的是它看起来是成功的：teachers/audit 都对，只有资源是 0。
  现在：一次性清空全部基表（含模板库里带的、快照里没有的表），然后只做插入。
*/
const baseTables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
const tableList = baseTables.map((r) => `"${r.table_name}"`).join(', ')
if (tableList !== '') {
  await sql.unsafe(`TRUNCATE ${tableList} CASCADE`)
  console.log(`已清空 ${baseTables.length} 张基表（一次性，避免 CASCADE 互相牵连）`)
}

const report = []
const generatedCheck = []
for (const [table, t] of tables) {
  const generated = generatedByTable.get(table) ?? new Set()
  let inserted = 0
  for (const row of t.rows) {
    const cols = Object.keys(row).filter((c) => !generated.has(c))
    if (cols.length === 0) continue
    const idents = cols.map((c) => `"${c}"`).join(', ')
    const values = cols.map((c) => row[c])
    await sql.unsafe(
      `INSERT INTO "${table}" (${idents}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    )
    inserted += 1
  }
  report.push({ table, inserted, footerSays: footer?.counts?.[table] ?? null, generated: [...generated] })

  for (const col of generated) {
    if (!t.columns.includes('id')) continue
    let same = 0
    let diff = 0
    for (const row of t.rows) {
      const [actual] = await sql.unsafe(`SELECT "${col}"::text AS v FROM "${table}" WHERE id = $1`, [row.id])
      if (actual === undefined) continue
      if (String(actual.v) === String(row[col])) same += 1
      else diff += 1
    }
    generatedCheck.push({ table, column: col, same, diff })
  }
}
await sql.unsafe('SET session_replication_role = DEFAULT')
await sql.end()

console.log()
console.log('灌入结果（与快照 footer 对照）：')
let mismatch = 0
for (const r of report.sort((a, b) => b.inserted - a.inserted)) {
  const ok = r.footerSays === null || r.footerSays === r.inserted
  if (!ok) mismatch += 1
  const extra = r.generated.length > 0 ? `（生成列 ${r.generated.join(', ')} 由库重算）` : ''
  console.log(`  ${r.table.padEnd(28)} ${String(r.inserted).padStart(7)}  footer=${r.footerSays ?? '-'} ${ok ? '✅' : '❌'}${extra}`)
}
for (const g of generatedCheck) {
  console.log(`  生成列核对 ${g.table}.${g.column}：相同 ${g.same}，不同 ${g.diff}${g.diff === 0 ? ' ✅' : ' ❌'}`)
  if (g.diff > 0) mismatch += 1
}
if (mismatch > 0) {
  console.error()
  console.error(`❌ 有 ${mismatch} 处与快照 footer 不一致 —— 还原不可信，不要拿它当迁移源。`)
  process.exit(4)
}
console.log()
console.log(`✅ ${database} 已还原成生产快照的样子（${report.length} 张表，逐表与 footer 一致）`)
console.log(`连接串：${url}`)
