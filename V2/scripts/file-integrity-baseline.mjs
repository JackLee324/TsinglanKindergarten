#!/usr/bin/env node
/**
 * scripts/file-integrity-baseline.mjs —— 文件完整性基线：采集 / 比对（**只读**）
 * ============================================================================
 * 业主 Stage 15 的前置门禁：动 AI 之前先把"现有文件长什么样"钉住，
 * 上线前后各跑一次，任何漂移就停下查明原因。
 * （不能拿"迁移成功"当文件完整性证据。）
 *
 * 用法：
 *   # 采集（写一个 JSON 产物；已存在时拒绝覆盖，除非 --force）
 *   DATABASE_URL='postgresql://…/库' \
 *   R2_ENDPOINT=… R2_BUCKET=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *   node scripts/file-integrity-baseline.mjs --capture --out .migration/file-baseline.json
 *
 *   # 比对（读基线 + 重新采集当前状态；有漂移则退出码 5）
 *   …同上… node scripts/file-integrity-baseline.mjs --compare .migration/file-baseline.json
 *
 * 严格只读：只 SELECT 与 ListObjectsV2 / HeadObject；没有任何写库、写桶、删对象的路径。
 * 退出码：0 一致 / 2 参数或配置不合法 / 3 连不上 / 4 产物已存在（未给 --force）/ 5 发现漂移
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { announceDatabaseTarget, resolveDatabaseTarget } from './lib/db-target.mjs'
import { resolveR2Config } from './lib/r2-target.mjs'
import { buildBaseline, diffBaselines, findMissingObjects } from './lib/file-integrity.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const target = resolveDatabaseTarget(process.env)
if (!target.ok) {
  console.error(`✖ ${target.reason}`)
  process.exit(2)
}
const r2 = resolveR2Config(process.env)
if (!r2.ok) {
  console.error(`✖ ${r2.reason}`)
  process.exit(2)
}

/** 采集当前状态（只读）。 */
async function capture() {
  const sql = postgres(target.url, { max: 1, onnotice: () => {}, connect_timeout: 20 })
  let rows
  try {
    const resources = await sql`
      SELECT id::text, title, status, directory_id::text AS directory_id, updated_at
      FROM resources ORDER BY id`
    const files = await sql`
      SELECT rf.id::text, rf.resource_id::text, rf.storage_key, rf.file_name, rf.mime_type,
             rf.size::text AS size, rf.sha256
      FROM resource_files rf ORDER BY rf.id`
    const [counts] = await sql`
      SELECT (SELECT count(*) FROM resources)::int        AS resources,
             (SELECT count(*) FROM resource_files)::int    AS resource_files,
             (SELECT count(*) FROM directories)::int       AS directories,
             (SELECT count(*) FROM upload_tickets)::int    AS upload_tickets,
             (SELECT count(*) FROM storage_orphans)::int   AS storage_orphans`
    rows = { resources, files, counts }
  } finally {
    await sql.end()
  }

  const client = new S3Client({
    endpoint: r2.endpoint,
    region: process.env.R2_REGION ?? 'auto',
    forcePathStyle: true,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  await client.send(new HeadBucketCommand({ Bucket: r2.bucket }))
  const objects = []
  let token
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: r2.bucket, ContinuationToken: token }))
    for (const o of page.Contents ?? []) {
      objects.push({ key: o.Key, size: String(o.Size ?? 0), etag: String(o.ETag ?? '').replace(/"/g, '') })
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token !== undefined)

  return buildBaseline({
    takenAt: new Date().toISOString(),
    database: { redacted: target.redacted, local: target.local },
    storage: { bucket: r2.bucket, endpointHost: new URL(r2.endpoint).host },
    counts: rows.counts,
    resources: rows.resources.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      directoryId: r.directory_id,
      updatedAt: r.updated_at?.toISOString?.() ?? null,
    })),
    files: rows.files.map((f) => ({
      id: f.id,
      resourceId: f.resource_id,
      storageKey: f.storage_key,
      fileName: f.file_name,
      mimeType: f.mime_type,
      size: String(f.size),
      sha256: String(f.sha256),
    })),
    objects,
  })
}

if (has('capture')) {
  const out = arg('out')
  if (out === null) {
    console.error('✖ --capture 需要 --out <文件>')
    process.exit(2)
  }
  const outPath = resolve(ROOT, out)
  if (existsSync(outPath) && !has('force')) {
    console.error(`✖ 产物已存在，拒绝覆盖：${out}\n  （要覆盖就显式加 --force）`)
    process.exit(4)
  }
  announceDatabaseTarget(target)
  console.log(`  存储：bucket=${r2.bucket} host=${new URL(r2.endpoint).host}`)
  const baseline = await capture()
  writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`)
  const missing = findMissingObjects(baseline.files, baseline.objects)
  console.log(`✔ 基线已写入 ${out}`)
  console.log(`  资源 ${baseline.counts.resources} / 文件引用 ${baseline.counts.resource_files} / 目录 ${baseline.counts.directories}`)
  console.log(`  桶内对象 ${baseline.objects.length} 个，其中被数据库引用 ${baseline.files.length} 个`)
  if (missing.length > 0) {
    console.error(`  ✖ 有 ${missing.length} 条文件引用在桶里找不到对象：`)
    for (const m of missing) console.error(`    · ${m.storageKey}`)
    process.exit(5)
  }
  console.log('  ✔ 每一条文件引用在桶里都能找到对象')
  process.exit(0)
}

if (has('compare')) {
  const baselinePath = resolve(ROOT, process.argv[process.argv.indexOf('--compare') + 1] ?? '')
  if (!existsSync(baselinePath)) {
    console.error(`✖ 找不到基线文件：${baselinePath}`)
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(baselinePath, 'utf8'))
  announceDatabaseTarget(target)
  console.log(`  基线采集于 ${before.takenAt}（bucket=${before.storage?.bucket}）`)
  const after = await capture()
  const { drift, notes, added } = diffBaselines(before, after)
  console.log(`  新增：资源 ${added.resources} / 文件 ${added.files} / 对象 ${added.objects}`)
  for (const n of notes.slice(0, 10)) console.log(`  · 提示 ${n.kind}：${n.detail}`)
  if (notes.length > 10) console.log(`  · 另有 ${notes.length - 10} 条状态变化提示（正常业务）`)
  if (drift.length === 0) {
    console.log('✔ 文件数据完整性门禁通过：没有删除、没有改写、没有 storage key 变化')
    process.exit(0)
  }
  console.error(`✖ 发现 ${drift.length} 处漂移 —— 停止发布并查明原因：`)
  for (const d of drift.slice(0, 30)) console.error(`  · ${d.kind}：${d.detail}`)
  if (drift.length > 30) console.error(`  · 另有 ${drift.length - 30} 处`)
  process.exit(5)
}

console.error(
  '用法：\n' +
    '  node scripts/file-integrity-baseline.mjs --capture --out .migration/file-baseline.json [--force]\n' +
    '  node scripts/file-integrity-baseline.mjs --compare .migration/file-baseline.json',
)
process.exit(2)
