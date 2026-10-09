#!/usr/bin/env node
/**
 * scripts/prepare-v2-cutover-snapshot.mjs
 * ============================================================================
 * 业主 Stage 12C §3.2：从已验证的生产快照生成**V2 专用迁移文件**，并精确排除
 * 已授权的两条测试资源。
 *
 * 安全边界（写进代码，不靠人工小心）：
 *   · 原快照**只读**：只读文件、只写新文件，绝不覆盖 `prod-export-*.ndjson`；
 *   · 排除是**白名单式**的：只排除"精确 ID + 证据同时命中"的那几条，
 *     绝不做 `title LIKE '%test%'` 这类模糊删除；
 *   · 排除必须**引用完整**：从表行要按 V1 自己的 `ON DELETE` 语义一起处理，
 *     否则会留下指向不存在资源的孤儿行 —— 轻则装载时被外键拒绝，重则数据不一致。
 *     任何"没被显式处理、也没被显式豁免"的引用都会被拒绝（见 §引用完整性）。
 *   · 排除规则与理由逐条写进清单（可审计）；
 *   · 新文件算独立 SHA-256，并把"原快照 sha → 新文件 sha"的链条写进清单；
 *   · **输出必须是可复现的**：产物内容里不含生成时间（时间只写进清单文件），
 *     因此任何人拿冻结快照重跑一次，都必须得到**同一个 sha256**；
 *   · **不碰任何数据库**（导入是后续步骤）。
 *
 * 用法：
 *   node scripts/prepare-v2-cutover-snapshot.mjs            # 生成（不改原文件）
 *   node scripts/prepare-v2-cutover-snapshot.mjs --check    # 只校验已有产物，不写任何文件
 *
 * 退出码：0 成功 / 2 原快照 sha 不符 / 3 排除条数不对 / 4 标题证据不符 /
 *         5 快照头不唯一 / 6 找不到产物（--check）/ 7 引用不完整 /
 *         1 校验不通过（--check）
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const CHECK_MODE = process.argv.includes('--check')
const SRC = resolve(ROOT, arg('snapshot', '.migration/prod-exports/prod-export-20261008_031823.ndjson'))
const OUT_DIR = resolve(ROOT, '.migration/prod-exports')
const OUT_NAME = arg('out', 'v2-cutover-20261008.ndjson')
const OUT = resolve(OUT_DIR, OUT_NAME)
const EVIDENCE = resolve(OUT_DIR, OUT_NAME.replace(/\.ndjson$/, '.exclusion.json'))
const EXPECTED_SRC_SHA = 'b1a2e0e8b3fec3c1b2c24ade483f97aff7810e81bea41786fcdd395c511b708e'

/*
  已授权的排除规则（业主 §3.2）：**两条测试资源**。
  识别依据同时命中才排除 —— 只有"标题是 test"不够，必须 ID + 这两个特征同时对上：
    · 标题字面量为 `test`（不是包含 test）
    · 关联同一个 smoke 文件 `校服申领登记.png`
  两条的 ID 已由上一轮逐条审计确认（见 docs/V1_PRODUCTION_SOURCE_FREEZE.md §4/§5）。
*/
const EXCLUDED_RESOURCE_IDS = [
  '76b60eb6-42ca-4143-a76c-9efd0202ee3e', // published，带文件，V1 里无目录归属
  '62928bcc-4f63-4626-95b5-19ec0b5b7705', // draft，在 V1 回收站里，桶名是 placeholder-bucket
]
const EXPECTED_TITLE = 'test'
const EXPECTED_FILE = '校服申领登记.png'

/*
  §引用完整性
  ---------------------------------------------------------------------------
  只把 resources 那两行删掉是不够的：V1 的这两个从表都写着
      resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE
  （server/database/init.sql:184 review_records；server/database/migrations/
   0011_resource_versions.sql:36 resource_versions），
  删掉主表行却不处理从表行 → 孤儿行，装载进 V1 schema 时会被外键直接拒绝。
  所以按 V1 自己的 `ON DELETE CASCADE` 语义，把这些从表行一起排除。
*/
const CASCADE_DEPENDENTS = [
  { table: 'resource_versions', column: 'resource_id', v1Ddl: '0011_resource_versions.sql:36 NOT NULL REFERENCES resources(id) ON DELETE CASCADE' },
  { table: 'review_records', column: 'resource_id', v1Ddl: 'init.sql:184 NOT NULL REFERENCES resources(id) ON DELETE CASCADE' },
]

/*
  这些列**保留原值、不删行也不改值** —— 它们是审计历史，且两边的 schema 都**没有外键**：
    · V1 server/database/init.sql：audit_logs.resource_id uuid（定义里就没有 REFERENCES）
    · V2 database/migrations/0001_init.sql：audit_logs.target_id text（自由文本）
  所以审计行里留着一个"已排除资源的 id"是允许的，也正是 V1 自己的行为
  （V1 没有这条外键，删资源本来就不会动审计行）。审计行本身一条都不删。
*/
const ALLOWED_KEPT_REFS = [
  { table: 'audit_logs', column: 'resource_id', why: '审计历史，V1/V2 该列均无外键；只保留不修改' },
]

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const stable = (obj) => JSON.stringify(obj, Object.keys(obj).sort())
const refKey = (table, column) => `${table}.${column}`
const isAllowedKeptRef = (table, column) => ALLOWED_KEPT_REFS.some((a) => a.table === table && a.column === column)
const cascadeFor = (table, column) => CASCADE_DEPENDENTS.find((d) => d.table === table && d.column === column)

// ── 读原快照（只读）────────────────────────────────────────────────────────
const raw = readFileSync(SRC)
const srcSha = sha256(raw)
if (srcSha !== EXPECTED_SRC_SHA) {
  console.error(`❌ 原快照 sha256 与冻结文档不一致：\n  期望 ${EXPECTED_SRC_SHA}\n  实际 ${srcSha}\n  拒绝继续。`)
  process.exit(2)
}
const lines = raw.toString('utf8').split('\n').filter((l) => l.trim() !== '')
const excludedIdSet = new Set(EXCLUDED_RESOURCE_IDS)

// ── 先确认要排除的确实是那两条（证据同时命中）──────────────────────────────
const excludedRows = []
const excludedDependents = []
const keptLines = []
const counts = { before: {}, after: {} }
const referencedPairs = {} // "table.column" → 原快照里指向被排除资源的引用行数
let headerObj = null
let headerCount = 0
for (const line of lines) {
  const obj = JSON.parse(line)
  if (obj.kind === 'header') {
    headerCount += 1
    headerObj = obj
  }
  if (obj.kind === 'row') {
    counts.before[obj.table] = (counts.before[obj.table] ?? 0) + 1

    const isPrimaryTarget =
      obj.table === 'resources' &&
      excludedIdSet.has(String(obj.row.id)) &&
      obj.row.title === EXPECTED_TITLE &&
      (obj.row.file_name === EXPECTED_FILE || obj.row.file_name === null)

    if (isPrimaryTarget) {
      excludedRows.push(obj.row)
      continue // 不写进新文件
    }

    // 该行所有指向被排除资源的引用（resources.id 是行自身主键，不算引用）
    const hitColumns = Object.entries(obj.row)
      .filter(([col, v]) => typeof v === 'string' && excludedIdSet.has(v) && !(obj.table === 'resources' && col === 'id'))
      .map(([col]) => col)
    for (const col of hitColumns) {
      const k = refKey(obj.table, col)
      referencedPairs[k] = (referencedPairs[k] ?? 0) + 1
    }

    // 从表行：按 V1 的 ON DELETE CASCADE 一起排除
    const cascaded = hitColumns.find((col) => cascadeFor(obj.table, col) !== undefined)
    if (cascaded !== undefined) {
      excludedDependents.push({ table: obj.table, column: cascaded, row: obj.row })
      continue // 不写进新文件
    }

    counts.after[obj.table] = (counts.after[obj.table] ?? 0) + 1
  }
  keptLines.push(line)
}

// 快照头必须唯一 —— 它是"这份数据从哪个库、什么时候导出"的身份，导入与审计都靠它。
if (headerCount !== 1 || headerObj === null) {
  console.error(`❌ 快照头不唯一：期望 1 条 header，实际 ${headerCount} 条。拒绝继续。`)
  process.exit(5)
}

// 两条必须一条不多、一条不少
if (excludedRows.length !== EXCLUDED_RESOURCE_IDS.length) {
  console.error(
    `❌ 排除条数不对：期望 ${EXCLUDED_RESOURCE_IDS.length}，实际 ${excludedRows.length}。\n` +
      '   （不猜、不改规则：请人工核对后再跑。）',
  )
  process.exit(3)
}
for (const r of excludedRows) {
  if (r.title !== EXPECTED_TITLE) {
    console.error(`❌ 资源 ${r.id} 的标题不是「${EXPECTED_TITLE}」，拒绝排除。`)
    process.exit(4)
  }
}

// ── §引用完整性：每个引用都必须"被处理"或"被显式豁免"，否则拒绝出文件 ────────
const unresolvedRefs = Object.entries(referencedPairs).filter(([k]) => {
  const [table, column] = k.split('.')
  return cascadeFor(table, column) === undefined && !isAllowedKeptRef(table, column)
})
if (unresolvedRefs.length > 0) {
  console.error('❌ 引用不完整：以下列仍指向被排除的资源，但既没有从表排除规则，也没有豁免声明：')
  for (const [k, n] of unresolvedRefs) console.error(`   · ${k}  ${n} 行`)
  console.error('   加进 CASCADE_DEPENDENTS（V1 是 ON DELETE CASCADE 的）或 ALLOWED_KEPT_REFS（并写清理由）。')
  process.exit(7)
}

// ══════════════════════════════════════════════════════════════════════════
// --check：只校验已有产物，**不写任何文件**（部署前/切换前都可反复跑）
// ══════════════════════════════════════════════════════════════════════════
if (CHECK_MODE) {
  const fail = []
  if (!existsSync(OUT) || !existsSync(EVIDENCE)) {
    console.error(`❌ 找不到产物：\n  ${OUT}\n  ${EVIDENCE}\n  先跑一次生成命令。`)
    process.exit(6)
  }
  const outRaw = readFileSync(OUT)
  const ev = JSON.parse(readFileSync(EVIDENCE, 'utf8'))

  // 1) sha 链条：原快照 → 产物
  if (ev.source?.sha256 !== EXPECTED_SRC_SHA) fail.push(`清单里的原快照 sha 不是冻结值：${ev.source?.sha256}`)
  if (ev.source?.sha256 !== srcSha) fail.push('清单里的原快照 sha 与磁盘上的原快照不一致')
  const outSha = sha256(outRaw)
  if (ev.output?.sha256 !== outSha) fail.push(`产物 sha 与清单不符：清单 ${ev.output?.sha256} / 实际 ${outSha}`)
  if (ev.output?.bytes !== outRaw.length) fail.push(`产物字节数与清单不符：清单 ${ev.output?.bytes} / 实际 ${outRaw.length}`)

  // 2) 产物自身：行类型、footer 口径、被排除的 ID 真的不在里面、引用完整
  const outLines = outRaw.toString('utf8').split('\n').filter((l) => l.trim() !== '')
  const outCounts = {}
  const outExcludedSeen = []
  const outBadRefs = {}
  const cellsChecked = { rows: 0, cells: 0 }
  let outHeader = 0
  let footer = null
  for (const line of outLines) {
    const obj = JSON.parse(line)
    if (obj.kind === 'header') outHeader += 1
    if (obj.kind === 'footer') footer = obj
    if (obj.kind === 'row') {
      outCounts[obj.table] = (outCounts[obj.table] ?? 0) + 1
      cellsChecked.rows += 1
      for (const [col, v] of Object.entries(obj.row)) {
        cellsChecked.cells += 1
        if (typeof v !== 'string' || !excludedIdSet.has(v)) continue
        if (obj.table === 'resources' && col === 'id') outExcludedSeen.push(v)
        else if (!isAllowedKeptRef(obj.table, col)) {
          const k = refKey(obj.table, col)
          outBadRefs[k] = (outBadRefs[k] ?? 0) + 1
        }
      }
    }
  }
  if (outHeader !== 1) fail.push(`产物的 header 数不是 1：${outHeader}`)
  if (outExcludedSeen.length !== 0) fail.push(`产物里仍能读到被排除的资源行：${outExcludedSeen.join(', ')}`)
  if (Object.keys(outBadRefs).length > 0) {
    fail.push(`产物里还有未豁免的引用指向被排除资源：${Object.entries(outBadRefs).map(([k, n]) => `${k}×${n}`).join(', ')}`)
  }
  if (stable(outCounts) !== stable(counts.after)) fail.push(`产物实际行数与清单 after 不符：实际 ${stable(outCounts)} / 清单 ${stable(counts.after)}`)
  if (stable(ev.counts?.after ?? {}) !== stable(counts.after)) fail.push('清单的 after 与本次重算不一致')
  // footer 是新数量口径（导入脚本与审计核对都读它），必须与产物实际行数一致
  for (const table of new Set([...Object.keys(footer?.counts ?? {}), ...Object.keys(counts.before)])) {
    const claimed = footer?.counts?.[table] ?? 0
    const actual = outCounts[table] ?? 0
    if (claimed !== actual) fail.push(`footer 里 ${table}=${claimed}，产物实际 ${actual}`)
  }

  // 3) 差额守恒：原快照 = 产物 + 被排除的主表行 + 被排除的从表行（逐表核对，防"顺手多删"）
  const expectedDrop = {}
  for (const entry of ev.excluded ?? []) {
    const t = entry.table ?? 'resources'
    expectedDrop[t] = (expectedDrop[t] ?? 0) + 1
  }
  for (const d of ev.excludedDependents ?? []) expectedDrop[d.table] = (expectedDrop[d.table] ?? 0) + 1
  for (const table of new Set([...Object.keys(counts.before), ...Object.keys(counts.after)])) {
    const before = counts.before[table] ?? 0
    const after = counts.after[table] ?? 0
    const drop = expectedDrop[table] ?? 0
    if (before - after !== drop) fail.push(`差额不守恒：${table} ${before} → ${after}，但清单只授权排除 ${drop} 条`)
  }
  if ((ev.excluded ?? []).length !== EXCLUDED_RESOURCE_IDS.length) fail.push(`清单里的排除条数不是 ${EXCLUDED_RESOURCE_IDS.length}`)
  // 清单声明的从表排除，必须与本次按源快照重算的一致
  const recomputedDependents = {}
  for (const d of excludedDependents) recomputedDependents[refKey(d.table, d.column)] = (recomputedDependents[refKey(d.table, d.column)] ?? 0) + 1
  const declaredDependents = {}
  for (const d of ev.excludedDependents ?? []) declaredDependents[refKey(d.table, d.column)] = (declaredDependents[refKey(d.table, d.column)] ?? 0) + 1
  if (stable(recomputedDependents) !== stable(declaredDependents)) {
    fail.push(`清单的从表排除与重算不一致：清单 ${stable(declaredDependents)} / 重算 ${stable(recomputedDependents)}`)
  }

  console.log('— CUTOVER SNAPSHOT CHECK —')
  console.log(`原快照  ${SRC}`)
  console.log(`  sha256 ${srcSha}  ✓ 与冻结值一致`)
  console.log(`产物    ${OUT}`)
  console.log(`  sha256 ${outSha}`)
  console.log(`  字节 ${outRaw.length}`)
  console.log(`  header ${outHeader} ｜ after ${stable(outCounts)}`)
  console.log(`排除    主表 ${(ev.excluded ?? []).length} 条 ｜ 从表 ${(ev.excludedDependents ?? []).length} 条（清单：${EVIDENCE}）`)
  console.log(`引用完整性 扫了 ${cellsChecked.rows} 行 / ${cellsChecked.cells} 个字段，未豁免的残留引用 0`)
  console.log(`差额守恒 ${fail.length === 0 ? '✓ 每张表都只少了被授权的那几条' : '✗'}`)
  if (fail.length > 0) {
    for (const f of fail) console.error(`  ✗ ${f}`)
    console.error('\n❌ CUTOVER SNAPSHOT CHECK = FAIL')
    process.exit(1)
  }
  console.log('\n✅ CUTOVER SNAPSHOT CHECK = PASS')
  process.exit(0)
}

// ── footer 也要按新数量重写（它是导入脚本与审计核对的口径）──────────────────
// 注意：note 里**不写生成时间**，否则同一个原快照每次生成的 sha256 都不一样，
// 产物就不再可复现、也就没法用 sha256 当"这份数据没被人动过"的凭证。
const kept = keptLines.map((l) => {
  const obj = JSON.parse(l)
  if (obj.kind === 'footer') {
    // footer 的 counts 枚举了**全部**表（含 0 行的），所以按 footer 自己的键补齐：
    // 某张表被排到 0 行时必须写成 0，不能保留旧值（否则 footer 与实际不符）。
    const newCounts = { ...obj.counts }
    for (const table of Object.keys(newCounts)) newCounts[table] = counts.after[table] ?? 0
    const note = [
      obj.note ?? '',
      `⚠️ 这是 V2 专用迁移文件：已精确排除 ${excludedRows.length} 条已授权的测试资源，` +
        `并按 V1 的 ON DELETE CASCADE 语义一并排除其从表行 ${excludedDependents.length} 条` +
        `（规则与逐条理由见 ${OUT_NAME.replace(/\.ndjson$/, '.exclusion.json')}）。原快照未被修改。`,
    ]
      .filter((s) => s !== '')
      .join('\n')
      .trim()
    return JSON.stringify({ ...obj, counts: newCounts, note })
  }
  return l
})
const outText = kept.join('\n') + '\n'
const outBuf = Buffer.from(outText, 'utf8')
writeFileSync(OUT, outBuf)
const outSha = sha256(outBuf)

// ── 可审计的排除清单（生成时间只写在这里，不影响产物字节）────────────────────
const evidence = {
  generatedAt: new Date().toISOString(),
  source: { file: SRC, sha256: srcSha, bytes: raw.length },
  sourceHeader: {
    tool: headerObj.tool,
    formatVersion: headerObj.formatVersion,
    createdAt: headerObj.createdAt,
    sourceDatabase: headerObj.sourceDatabase,
  },
  output: { file: OUT, sha256: outSha, bytes: outBuf.length },
  rule: {
    description:
      '排除两条已授权的测试资源：ID + 标题字面量 "test" + 同一个 smoke 文件 校服申领登记.png 同时命中才排除；不做模糊匹配；' +
      '并按 V1 的 ON DELETE CASCADE 语义一并排除其从表行（resource_versions / review_records），保证引用完整',
    excludedIds: EXCLUDED_RESOURCE_IDS,
    cascadeDependents: CASCADE_DEPENDENTS,
    allowedKeptRefs: ALLOWED_KEPT_REFS,
    authorizedBy: '业主 Stage 12C §1.1 第 6 条（明确授权不导入这两条测试资源）',
  },
  excluded: excludedRows.map((r) => ({
    table: 'resources',
    id: r.id,
    title: r.title,
    status: r.status,
    directoryId: r.directory_id,
    deletedAt: r.deleted_at,
    uploaderId: r.uploader_id,
    createdAt: r._created_at,
    file: r.file_name === null ? null : { name: r.file_name, size: r.file_size, path: r.file_path, bucket: r.file_bucket_id },
    why:
      r.deleted_at === null
        ? '标题字面量 test、带 smoke 上传的图片、V1 里没有目录归属（三条特征同时命中）'
        : '标题字面量 test、在 V1 回收站里、桶名是 placeholder-bucket（占位符）',
  })),
  excludedDependents: excludedDependents.map((d) => ({
    table: d.table,
    column: d.column,
    id: d.row.id,
    resourceId: d.row[d.column],
    why: `V1 里 ${refKey(d.table, d.column)} 是 NOT NULL REFERENCES resources(id) ON DELETE CASCADE（${cascadeFor(d.table, d.column).v1Ddl}）；资源被排除，从表行必须同时排除`,
  })),
  keptDanglingRefs: Object.entries(referencedPairs)
    .filter(([k]) => {
      const [t, c] = k.split('.')
      return isAllowedKeptRef(t, c)
    })
    .map(([k, n]) => {
      const [table, column] = k.split('.')
      return { table, column, rows: n, why: ALLOWED_KEPT_REFS.find((a) => a.table === table && a.column === column).why }
    }),
  counts: { before: counts.before, after: counts.after },
}
writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')

console.log(`原快照（只读）：${SRC}`)
console.log(`  sha256 ${srcSha}`)
console.log(`新文件：${OUT}`)
console.log(`  sha256 ${outSha}`)
console.log(`  字节 ${outBuf.length}`)
console.log(`排除 ${excludedRows.length} 条主表行：`)
for (const r of evidence.excluded) console.log(`  · ${r.id}  [${r.status}]  ${r.title}  deleted=${r.deletedAt ?? '-'}`)
console.log(`排除 ${excludedDependents.length} 条从表行（V1 的 ON DELETE CASCADE）：`)
for (const d of evidence.excludedDependents) console.log(`  · ${d.table}.${d.column} = ${d.resourceId}  (行 ${d.id})`)
for (const k of evidence.keptDanglingRefs) console.log(`保留 ${k.rows} 条 ${k.table}.${k.column} 引用（${k.why}）`)
console.log('\n数量变化（逐表核对）：')
for (const table of Object.keys(counts.before)) {
  const b = counts.before[table]
  const a = counts.after[table] ?? 0
  if (b !== a) console.log(`  ${table}: ${b} → ${a}`)
}
console.log(`\n清单：${EVIDENCE}`)
console.log('复核：node scripts/prepare-v2-cutover-snapshot.mjs --check')
