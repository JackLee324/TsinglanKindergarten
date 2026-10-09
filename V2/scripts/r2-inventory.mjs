#!/usr/bin/env node
/**
 * scripts/r2-inventory.mjs —— **只读**的对象存储清单（业主 Stage 13C §3）
 * ============================================================================
 * 为什么需要它：V1 的数据库里 `resource_files = 0` **不能**推断"线上桶里没有东西"。
 * 数据库记录与桶里的对象是两套事实；正式切换前必须**真的列一次桶**，
 * 才能说清"有没有需要迁移的文件"，而且这一步在拿到清单之前
 * **严禁删除或覆盖任何生产对象**（业主明确要求）。
 *
 * 安全边界（写进代码，不靠人工小心）：
 *   · **只读**：唯一会调用的接口是 `ListObjectsV2` / `HeadBucket`。
 *     没有 PutObject / DeleteObject / CopyObject —— 这一点由
 *     `tests/unit/r2-inventory-safety.test.mjs` **静态扫描源码**盯着；
 *   · **缺配置就退出**：不猜默认桶、不猜 endpoint（猜错桶 = 已经越界）；
 *   · **凭证只从环境变量读**，不接受命令行参数（不进 shell 历史），且**永不回显**：
 *     输出里只有 endpoint 主机、桶名、对象数、总字节数、前缀分布；
 *   · **不覆写任何已有产物**：`--out` 指向已存在的文件时拒绝（除非显式 `--force`）；
 *   · `--from-console <json>` 允许**完全不连网**：直接用 R2 控制台导出的清单，
 *     适合"没有只读凭证、但能从控制台下载清单"的情况。
 *
 * 用法（本机，凭证走环境变量）：
 *   R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
 *   R2_BUCKET=tsinglan-curriculum \
 *   R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *   node scripts/r2-inventory.mjs --out .migration/r2-inventory.json
 *
 *   node scripts/r2-inventory.mjs --from-console ./r2-console-export.json --out .migration/r2-inventory.json
 *   node scripts/r2-inventory.mjs --compare .migration/r2-inventory.prev.json --from-console ./now.json
 *
 * 退出码：0 成功 / 2 缺配置或参数不合法 / 3 列举失败 / 4 产物已存在（未给 --force）
 *         / 5 对比发现对象消失（**这是要人来判断的事，不能静默通过**）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { buildInventoryArtifact, resolveR2Config, summarizeObjects } from './lib/r2-target.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

function fail(message, code = 2) {
  console.error(`✖ ${message}`)
  process.exit(code)
}

const OUT = arg('out', null)
const CONSOLE_FILE = arg('from-console', null)
const COMPARE = arg('compare', null)
const PREFIX = arg('prefix', '')
const MAX = Number(arg('max', '0')) || 0

/** R2 控制台导出的清单（CSV/JSON）→ 统一形状；只读解析，不猜字段名以外的东西。 */
function readConsoleExport(path) {
  const text = readFileSync(resolve(ROOT, path), 'utf8')
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    const rows = Array.isArray(parsed) ? parsed : (parsed.objects ?? parsed.Contents ?? [])
    return rows.map((r) => ({
      key: String(r.key ?? r.Key ?? ''),
      size: Number(r.size ?? r.Size ?? 0),
      lastModified: String(r.lastModified ?? r.LastModified ?? ''),
      etag: String(r.etag ?? r.ETag ?? ''),
    }))
  }
  // CSV：第一行是表头，取 key/size 两列（列名大小写不敏感）
  const lines = trimmed.split('\n').filter((l) => l.trim() !== '')
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/"/g, ''))
  const keyIdx = header.findIndex((h) => h === 'key' || h === 'name' || h === 'object key')
  const sizeIdx = header.findIndex((h) => h === 'size' || h === 'bytes')
  if (keyIdx < 0) fail('控制台导出的 CSV 里找不到 key/name 列。', 2)
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    return { key: cells[keyIdx], size: sizeIdx >= 0 ? Number(cells[sizeIdx]) : 0, lastModified: '', etag: '' }
  })
}

/** 连网列举（只读）。分页直到列完或到 --max。 */
async function listFromEndpoint(config) {
  const client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
  await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
  const objects = []
  let token
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        ...(PREFIX === '' ? {} : { Prefix: PREFIX }),
        ...(token === undefined ? {} : { ContinuationToken: token }),
      }),
    )
    for (const item of page.Contents ?? []) {
      objects.push({
        key: String(item.Key ?? ''),
        size: Number(item.Size ?? 0),
        lastModified: item.LastModified instanceof Date ? item.LastModified.toISOString() : String(item.LastModified ?? ''),
        etag: String(item.ETag ?? '').replaceAll('"', ''),
      })
      if (MAX > 0 && objects.length >= MAX) return objects
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined
  } while (token !== undefined)
  return objects
}

// ── 主体 ─────────────────────────────────────────────────────────────────────
let objects
let source
if (CONSOLE_FILE !== null) {
  objects = readConsoleExport(CONSOLE_FILE)
  source = `控制台导出 ${CONSOLE_FILE}（未连网）`
} else {
  const config = resolveR2Config(process.env)
  if (!config.ok) fail(config.reason)
  try {
    objects = await listFromEndpoint(config)
  } catch (error) {
    fail(`列举对象失败：${error?.message ?? error}（endpoint=${config.redactedEndpoint} bucket=${config.bucket}）`, 3)
  }
  source = `ListObjectsV2 endpoint=${config.redactedEndpoint} bucket=${config.bucket}${PREFIX === '' ? '' : ` prefix=${PREFIX}`}`
}

objects = objects.filter((o) => o.key !== '')
const summary = summarizeObjects(objects)

console.log('对象存储清单（**只读**，没有任何写/删动作）')
console.log(`  来源：${source}`)
console.log(`  对象数：${summary.count}`)
console.log(`  总字节：${summary.totalBytes}`)
if (summary.prefixes.length > 0) {
  console.log('  前缀分布（前 10）：')
  for (const p of summary.prefixes.slice(0, 10)) console.log(`    ${p.prefix}  ${p.count} 个`)
}

let compareResult = null
if (COMPARE !== null) {
  const previous = JSON.parse(readFileSync(resolve(ROOT, COMPARE), 'utf8'))
  const prevKeys = new Set((previous.objects ?? []).map((o) => o.key))
  const nowKeys = new Set(objects.map((o) => o.key))
  const missing = [...prevKeys].filter((k) => !nowKeys.has(k))
  const added = [...nowKeys].filter((k) => !prevKeys.has(k))
  compareResult = {
    comparedWith: COMPARE,
    missingCount: missing.length,
    addedCount: added.length,
    missingSample: missing.slice(0, 20),
    addedSample: added.slice(0, 20),
  }
  console.log(`  对比（${COMPARE}）：消失 ${missing.length} 个 / 新增 ${added.length} 个`)
  if (missing.length > 0) {
    console.error('  ⚠ 有对象消失了 —— 这必须由人来判断（是不是被谁删了？），工具不替你下结论。')
  }
}

if (OUT !== null) {
  const outPath = resolve(ROOT, OUT)
  if (existsSync(outPath) && !has('force')) {
    fail(`产物已存在，拒绝覆盖：${OUT}（确认要覆盖时加 --force）`, 4)
  }
  mkdirSync(dirname(outPath), { recursive: true })
  // 产物由纯函数构造（见 lib/r2-target.mjs）：它的入参里没有凭证，
  // 所以"清单里混进 secret"这种事在结构上就不可能发生。
  writeFileSync(
    outPath,
    JSON.stringify(buildInventoryArtifact({ source, objects, compare: compareResult }), null, 2) + '\n',
    'utf8',
  )
  console.log(`  已写入：${OUT}（该文件只含 key/size/etag/时间，不含任何凭证）`)
}

if (compareResult !== null && compareResult.missingCount > 0) process.exit(5)
