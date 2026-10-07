/**
 * scripts/cleanup-orphans.mjs —— 清理孤儿对象（业主 §29）
 * ============================================================================
 * 孤儿 = **对象存储里有、数据库里没有**的文件。真实成因有三类：
 *
 *   1. PUT 成功了，但登记失败（哈希不符 / 内容类型不符 / 票据过期 / 页面被关掉）；
 *   2. 用户申请了上传地址、传了文件，但从来没点"保存草稿"；
 *   3. 登记过程中进程被杀掉。
 *
 * 业主明确说过本阶段**不要引入任务系统**，所以这里不是常驻任务，而是一个
 * 可以手工跑（或交给 cron 跑）的脚本。它做两件事：
 *
 *   · `--markers`（默认）：处理 `storage_orphans` 里的待处理标记 —— 删对象、置 cleaned_at。
 *   · `--sweep`：扫对象存储，把**没有对应 resource_files 行**且创建时间超过
 *     `--older-than` 小时的对象也删掉。这一条覆盖"第 2 类"（连标记都没有的）。
 *
 * 用法：
 *   node scripts/cleanup-orphans.mjs                    # 只处理标记
 *   node scripts/cleanup-orphans.mjs --sweep            # 顺便扫桶（默认 24 小时前的）
 *   node scripts/cleanup-orphans.mjs --sweep --older-than 1
 *   node scripts/cleanup-orphans.mjs --dry-run          # 只报告，不删
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const postgres = require('postgres')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const dryRun = has('--dry-run')
const sweep = has('--sweep')
const olderThanHours = (() => {
  const i = args.indexOf('--older-than')
  if (i === -1) return 24
  const value = Number(args[i + 1])
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('--older-than 需要一个小时候数，例如 --older-than 24')
  }
  return value
})()

// 复用编译产物里的存储实现：**不要**在这里另写一套删除逻辑，
// 否则本地驱动与 S3 驱动会各长出第二份真相。
const { StorageService } = require(join(ROOT, 'dist/server/storage/storage.service.js'))
const { LocalStorageProvider } = require(join(ROOT, 'dist/server/storage/local.provider.js'))
const { S3StorageProvider } = require(join(ROOT, 'dist/server/storage/s3.provider.js'))
const { loadConfig } = require(join(ROOT, 'dist/server/config.js'))

/*
 * 这个脚本要用**和部署同一套**环境变量跑（STORAGE_*，以及应用本身的密钥）。
 * 配置不全会在这里失败，而那句原始报错（"V2_SESSION_SECRET 未设置"）看不出
 * 它跟"清理孤儿"有什么关系，所以补一句能照做的说明。
 */
let config
let storage
try {
  config = loadConfig()
  storage = new StorageService(new LocalStorageProvider(), new S3StorageProvider())
} catch (error) {
  console.error(`✖ 读不到配置：${error.message}`)
  console.error('  这个脚本要和部署用同一套环境变量（STORAGE_*、V2_SESSION_SECRET、DATABASE_URL）。')
  console.error('  开发机上可以这样跑：V2_ALLOW_DEV_SECRETS=1 node scripts/cleanup-orphans.mjs')
  process.exit(1)
}

const sql = postgres(process.env.DATABASE_URL ?? config.databaseUrl, { max: 1, onnotice: () => {} })

let deleted = 0
let failed = 0

async function main() {
  console.log(`存储驱动：${storage.providerName}`)
  console.log(dryRun ? '模式：dry-run（只报告）' : '模式：真实清理')

  // ── 1. 处理登记失败留下的标记 ────────────────────────────────────────────
  const markers = await sql`
    SELECT id::text, storage_key, reason, created_at
    FROM storage_orphans
    WHERE cleaned_at IS NULL
    ORDER BY created_at
  `
  console.log(`\n[标记] 待处理 ${markers.length} 条`)

  for (const marker of markers) {
    // 对象可能已经被删掉了（重复登记 / 上一轮清理过）—— 那不叫失败。
    const stat = await storage.head(marker.storage_key).catch(() => null)
    if (stat === null) {
      console.log(`  · ${marker.storage_key} 对象已不存在，只置标记`)
    } else if (dryRun) {
      console.log(`  · 会删除 ${marker.storage_key}（原因 ${marker.reason}）`)
      continue
    } else {
      try {
        await storage.delete(marker.storage_key)
        console.log(`  · 已删除 ${marker.storage_key}（原因 ${marker.reason}）`)
        deleted += 1
      } catch (error) {
        failed += 1
        console.error(`  ! 删除失败 ${marker.storage_key}：${error.message}`)
        continue // 删不掉就不要标记成已清理
      }
    }
    if (!dryRun) {
      await sql`UPDATE storage_orphans SET cleaned_at = now() WHERE id = ${marker.id}`
    }
  }

  // ── 2. 扫桶：没有数据库行、且足够旧的对象 ────────────────────────────────
  if (sweep) {
    const keys = await storage.list('resources/')
    console.log(`\n[扫描] 对象存储里共 ${keys.length} 个对象`)
    const known = new Set(
      (await sql`SELECT storage_key FROM resource_files`).map((r) => r.storage_key),
    )
    const cutoff = Date.now() - olderThanHours * 3600 * 1000
    let swept = 0
    for (const key of keys) {
      if (known.has(key)) continue
      const stat = await storage.head(key).catch(() => null)
      if (stat === null) continue
      // 拿不到时间戳时**不删**：宁可留一个孤儿，
      // 也不要删掉"刚传上来、还没来得及登记"的文件 —— 那是数据丢失，不是清理。
      if (stat.createdAt === null) {
        console.log(`  · ${key} 没有时间戳，跳过（保守起见不删）`)
        continue
      }
      if (stat.createdAt.getTime() > cutoff) continue
      if (dryRun) {
        console.log(`  · 会删除未登记对象 ${key}`)
        continue
      }
      try {
        await storage.delete(key)
        await sql`
          INSERT INTO storage_orphans (storage_key, resource_id, reason, detail, cleaned_at)
          VALUES (${key}, NULL, 'SWEEP_UNREGISTERED',
                  ${sql.json({ olderThanHours })}, now())
          ON CONFLICT (storage_key) WHERE cleaned_at IS NULL DO NOTHING
        `
        swept += 1
        console.log(`  · 已删除未登记对象 ${key}`)
      } catch (error) {
        failed += 1
        console.error(`  ! 删除失败 ${key}：${error.message}`)
      }
    }
    console.log(`[扫描] 清理 ${swept} 个未登记对象`)
  } else {
    console.log('\n[扫描] 未启用（加 --sweep 才会扫对象存储）')
  }

  console.log(
    `\n完成：按标记删除 ${deleted} 个${failed > 0 ? `，失败 ${failed} 个` : '，无失败'}` +
      (dryRun ? '（dry-run，未真正删除）' : ''),
  )
  if (failed > 0) process.exitCode = 1
}

try {
  await main()
} finally {
  await sql.end({ timeout: 5 })
}
