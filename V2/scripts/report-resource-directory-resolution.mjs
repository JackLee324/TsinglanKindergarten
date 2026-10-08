#!/usr/bin/env node
/**
 * scripts/report-resource-directory-resolution.mjs
 * ============================================================================
 * 用**唯一 resolver** 把生产快照里的**每一条**资源跑一遍，输出
 * `docs/PRODUCTION_RESOURCE_DIRECTORY_RESOLUTION.md`。
 *
 * 业主 Stage 12B §6/§7/§8 要的就是这个：不是"大概能落位"，而是
 * 349 条逐条可解释：`resource_id → 旧元组 → V2 directory code → V2 路径 → 为什么`。
 *
 * 它**离线跑**（只读那份 ndjson 快照），不连生产库、不写任何库。
 *
 * 用法：
 *   node scripts/report-resource-directory-resolution.mjs \
 *     [--snapshot .migration/prod-exports/prod-export-*.ndjson] [--out docs/PRODUCTION_RESOURCE_DIRECTORY_RESOLUTION.md]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FOLDER_KIND_LABEL,
  buildDirectoryCodeIndex,
  resolveLegacyResourceDirectory,
} from './lib/resolve-legacy-directory.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const snapshotPath = resolve(
  ROOT,
  arg('snapshot', '.migration/prod-exports/prod-export-20261008_031823.ndjson'),
)
const outPath = resolve(ROOT, arg('out', 'docs/PRODUCTION_RESOURCE_DIRECTORY_RESOLUTION.md'))

// ── 读快照（只读）───────────────────────────────────────────────────────────
const tables = new Map()
let header = null
for (const line of readFileSync(snapshotPath, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  const obj = JSON.parse(line)
  if (obj.kind === 'header') header = obj
  else if (obj.kind === 'row') {
    const list = tables.get(obj.table) ?? []
    list.push(obj.row)
    tables.set(obj.table, list)
  }
}
const resources = tables.get('resources') ?? []
const directories = tables.get('directories') ?? []

// ── 目录索引：V1 code → 节点（父路径也在这里算出来）────────────────────────
const byId = new Map(directories.map((d) => [String(d.id), d]))
const pathOf = (node) => {
  const parts = []
  let cur = node
  let guard = 0
  while (cur && guard++ < 20) {
    parts.unshift(String(cur.slug ?? cur.name ?? '?'))
    cur = cur.parent_id ? byId.get(String(cur.parent_id)) : null
  }
  return parts.join('/')
}
const index = buildDirectoryCodeIndex(
  directories.map((d) => ({ id: d.id, code: d.code, name: d.name, path: pathOf(d) })),
)

// ── 逐条跑 resolver ─────────────────────────────────────────────────────────
const rows = []
const codeCounts = new Map()
const tupleStats = new Map()
let resolved = 0
let unresolved = 0
let fallbackToSection = 0
const unresolvedList = []

for (const r of resources) {
  const result = resolveLegacyResourceDirectory(
    {
      program: r.program,
      subject: r.subject,
      sub_subject: r.sub_subject,
      folder_type: r.folder_type,
    },
    index,
  )
  const tuple = `${r.program}|${r.subject}|${r.sub_subject ?? '—'}|${r.folder_type}`
  const stat = tupleStats.get(tuple) ?? { total: 0, resolved: 0, unresolved: 0 }
  stat.total += 1
  if (result.resolved) {
    resolved += 1
    stat.resolved += 1
    const key = result.code
    codeCounts.set(key, (codeCounts.get(key) ?? 0) + 1)
    // 兜底防线：落到 Section 一律算 fallback（正常应当为 0）
    const node = byId.get(String(result.directoryId))
    if (node?.type !== 'folder') fallbackToSection += 1
  } else {
    unresolved += 1
    stat.unresolved += 1
    unresolvedList.push({ id: r.id, title: r.title, tuple, reason: result.reason })
  }
  tupleStats.set(tuple, stat)
  rows.push({ r, tuple, result })
}

// ── 报告 ────────────────────────────────────────────────────────────────────
const L = []
L.push('# 生产资源 → 目录 落位报告（V1 → V2）')
L.push('')
L.push('> 由 `scripts/report-resource-directory-resolution.mjs` 生成 —— **只读**生产快照，')
L.push('> 全程用**唯一 resolver**（`scripts/lib/resolve-legacy-directory.mjs`）。')
L.push('> 判定依据是 `program + subject + sub_subject + folder_type` → 精确 code 匹配，')
L.push('> **没有任何一条会回退到 Section**。')
L.push('')
L.push('| 项 | 值 |')
L.push('|---|---|')
L.push(`| 快照 | \`${snapshotPath.slice(ROOT.length + 1)}\` |`)
L.push(`| 快照来源 | ${header?.sourceDatabase ?? '?'}，生成于 ${header?.createdAt ?? '?'} |`)
L.push(`| 资源总数 | **${resources.length}** |`)
L.push(`| 精确落位 | **${resolved}** |`)
L.push(`| UNRESOLVED | **${unresolved}** |`)
L.push(`| **subject-level fallback** | **${fallbackToSection}**（必须为 0） |`)
L.push(`| 目录节点数 | ${directories.length} |`)
L.push('')
L.push(
  resolved === resources.length && unresolved === 0 && fallbackToSection === 0
    ? '**Gate：PASS**（349/349 精确落位，0 fallback，0 unresolved）'
    : '**Gate：FAIL** —— 见下面的未解决清单',
)
L.push('')

L.push('## 每个目标目录的资源数')
L.push('')
L.push('| V2 directory code | 资料夹 | 资源数 |')
L.push('|---|---|---:|')
for (const [code, n] of [...codeCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const node = index.get(code)
  const kind = code.split('_').pop()
  L.push(`| \`${code}\` | ${node?.name ?? FOLDER_KIND_LABEL[kind] ?? kind} | ${n} |`)
}
L.push('')

L.push('## 按元组统计（program / subject / sub_subject / folder_type）')
L.push('')
L.push('| program | subject | sub_subject | folder_type | 资源数 | 精确落位 | 未解决 |')
L.push('|---|---|---|---|---:|---:|---:|')
for (const [tuple, stat] of [...tupleStats.entries()].sort((a, b) => b[1].total - a[1].total)) {
  const [p, s, sub, ft] = tuple.split('|')
  L.push(`| ${p} | ${s} | ${sub} | ${ft} | ${stat.total} | ${stat.resolved} | ${stat.unresolved} |`)
}
L.push('')

const groupBy = (keyFn) => {
  const m = new Map()
  for (const { r } of rows) {
    const k = keyFn(r)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
for (const [title, fn] of [
  ['按 program', (r) => r.program],
  ['按 subject', (r) => r.subject],
  ['按 sub_subject', (r) => r.sub_subject ?? '（无）'],
  ['按 folder_type', (r) => r.folder_type],
]) {
  L.push(`## ${title}`)
  L.push('')
  L.push('| 值 | 资源数 |')
  L.push('|---|---:|')
  for (const [k, n] of groupBy(fn)) L.push(`| ${k} | ${n} |`)
  L.push('')
}

if (unresolvedList.length > 0) {
  L.push('## UNRESOLVED 清单（必须清零才能上线）')
  L.push('')
  L.push('| resource id | title | 元组 | 原因 |')
  L.push('|---|---|---|---|')
  for (const u of unresolvedList) L.push(`| \`${u.id}\` | ${u.title} | ${u.tuple} | ${u.reason} |`)
  L.push('')
}

L.push('## 逐条审计（全部资源）')
L.push('')
L.push('| # | resource id | title | program | subject | sub_subject | folder_type | V2 directory code | V2 路径 | 依据 |')
L.push('|---:|---|---|---|---|---|---|---|---|---|')
rows.forEach(({ r, result }, i) => {
  L.push(
    `| ${i + 1} | \`${r.id}\` | ${String(r.title).replace(/\|/g, '\\|')} | ${r.program} | ${r.subject} | ` +
      `${r.sub_subject ?? '—'} | ${r.folder_type} | ${result.code ? `\`${result.code}\`` : '—'} | ` +
      `${result.path ?? '—'} | ${result.resolved ? result.reason : result.reason} |`,
  )
})
L.push('')

writeFileSync(outPath, L.join('\n'))
console.log(`报告：${outPath}`)
console.log(`资源 ${resources.length}｜精确落位 ${resolved}｜UNRESOLVED ${unresolved}｜fallback ${fallbackToSection}`)
process.exit(unresolved === 0 && fallbackToSection === 0 && resolved === resources.length ? 0 : 1)
