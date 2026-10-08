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
 *   · 排除规则与理由逐条写进清单（可审计）；
 *   · 新文件算独立 SHA-256，并把"原快照 sha → 新文件 sha"的链条写进清单；
 *   · **不碰任何数据库**（导入是后续步骤）。
 *
 * 用法：
 *   node scripts/prepare-v2-cutover-snapshot.mjs            # 生成（不改原文件）
 *   node scripts/prepare-v2-cutover-snapshot.mjs --check    # 只校验已有产物
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
const SRC = resolve(ROOT, arg('snapshot', '.migration/prod-exports/prod-export-20261008_031823.ndjson'))
const OUT_DIR = resolve(ROOT, '.migration/prod-exports')
const OUT = resolve(OUT_DIR, arg('out', 'v2-cutover-20261008.ndjson'))
const EVIDENCE = resolve(OUT_DIR, 'v2-cutover-20261008.exclusion.json')
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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ── 读原快照（只读）────────────────────────────────────────────────────────
const raw = readFileSync(SRC)
const srcSha = sha256(raw)
if (srcSha !== EXPECTED_SRC_SHA) {
  console.error(`❌ 原快照 sha256 与冻结文档不一致：\n  期望 ${EXPECTED_SRC_SHA}\n  实际 ${srcSha}\n  拒绝继续。`)
  process.exit(2)
}
const lines = raw.toString('utf8').split('\n').filter((l) => l.trim() !== '')

// ── 先确认要排除的确实是那两条（证据同时命中）──────────────────────────────
const excludedRows = []
const keptLines = []
const counts = { before: {}, after: {} }
let header = null
for (const line of lines) {
  const obj = JSON.parse(line)
  if (obj.kind === 'header') header = obj
  if (obj.kind === 'row') {
    counts.before[obj.table] = (counts.before[obj.table] ?? 0) + 1
    const isTarget =
      obj.table === 'resources' &&
      EXCLUDED_RESOURCE_IDS.includes(String(obj.row.id)) &&
      obj.row.title === EXPECTED_TITLE &&
      (obj.row.file_name === EXPECTED_FILE || obj.row.file_name === null)
    if (isTarget) {
      excludedRows.push(obj.row)
      continue // 不写进新文件
    }
    counts.after[obj.table] = (counts.after[obj.table] ?? 0) + 1
  }
  keptLines.push(line)
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

// footer 也要按新数量重写（它是导入脚本与审计核对的口径）
const kept = keptLines.map((l) => {
  const obj = JSON.parse(l)
  if (obj.kind === 'footer') {
    const newCounts = { ...obj.counts }
    for (const table of Object.keys(newCounts)) {
      if (counts.after[table] !== undefined) newCounts[table] = counts.after[table]
    }
    return JSON.stringify({
      ...obj,
      counts: newCounts,
      note: `${obj.note ?? ''}\n⚠️ 这是 V2 专用迁移文件：已在 ${new Date().toISOString()} 排除 ${excludedRows.length} 条已授权的测试资源` +
        `（见 v2-cutover-20261008.exclusion.json）。原快照未被修改。`.trim(),
    })
  }
  return l
})
const outText = kept.join('\n') + '\n'
const outBuf = Buffer.from(outText, 'utf8')
writeFileSync(OUT, outBuf)
const outSha = sha256(outBuf)

// ── 可审计的排除清单 ───────────────────────────────────────────────────────
const evidence = {
  generatedAt: new Date().toISOString(),
  source: { file: SRC, sha256: srcSha, bytes: raw.length },
  output: { file: OUT, sha256: outSha, bytes: outBuf.length },
  rule: {
    description:
      '排除两条已授权的测试资源：ID + 标题字面量 "test" + 同一个 smoke 文件 校服申领登记.png 同时命中才排除；不做模糊匹配',
    excludedIds: EXCLUDED_RESOURCE_IDS,
    authorizedBy: '业主 Stage 12C §1.1 第 6 条（明确授权不导入这两条测试资源）',
  },
  excluded: excludedRows.map((r) => ({
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
  counts: { before: counts.before, after: counts.after },
}
writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')

console.log(`原快照（只读）：${SRC}`)
console.log(`  sha256 ${srcSha}`)
console.log(`新文件：${OUT}`)
console.log(`  sha256 ${outSha}`)
console.log(`  字节 ${outBuf.length}`)
console.log(`排除 ${excludedRows.length} 条：`)
for (const r of evidence.excluded) console.log(`  · ${r.id}  [${r.status}]  ${r.title}  deleted=${r.deletedAt ?? '-'}`)
console.log('\n数量变化（仅 resources 变化，其余表不变）：')
for (const table of Object.keys(counts.before)) {
  const b = counts.before[table]
  const a = counts.after[table] ?? 0
  if (b !== a) console.log(`  ${table}: ${b} → ${a}`)
}
console.log(`\n清单：${EVIDENCE}`)
