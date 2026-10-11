#!/usr/bin/env node
/**
 * scripts/ai-index.mjs —— AI 索引与检索的运维入口（不经过 HTTP）
 * ============================================================================
 * 为什么需要它：索引是后台跑的，检索逻辑又必须在**真实权限**下检查 ——
 * 这两件事都不该只能通过"打开浏览器问一句"来验证。这个脚本直接调用编译后的
 * `AiIndexService` / `AiRetrievalService`（**同一份实现，不复制逻辑**），
 * 于是运维和测试都能：
 *   · 看进度、跑一轮、回填存量、播种站点规则/目录说明；
 *   · **以某个账号的身份**检索一次，用来核对权限边界。
 *
 * 用法（全部只读或只写 AI 自己的表；**不碰资源/文件/对象**）：
 *   DATABASE_URL=… STORAGE_PROVIDER=local STORAGE_LOCAL_DIR=… V2_ALLOW_DEV_SECRETS=1 \
 *   node scripts/ai-index.mjs progress
 *   node scripts/ai-index.mjs run-once [--limit 5] [--quiet]
 *   node scripts/ai-index.mjs seed-static
 *   node scripts/ai-index.mjs backfill
 *   node scripts/ai-index.mjs search --user <用户名> --query "主题教学" [--limit 8]
 *
 * 退出码：0 正常 / 2 参数不合法 / 3 连不上或执行失败 / 4 search 找不到该账号
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import postgres from 'postgres'
import { announceDatabaseTarget, resolveDatabaseTarget } from './lib/db-target.mjs'

/*
  本机跑要注意：存储配置走应用自己的 `loadConfig()`（与线上同一份），
  所以非生产环境需要 `V2_ALLOW_DEV_SECRETS=1`（或不给密钥就用生产密钥）。
  这不是偷懒 —— 迁移与索引写进去的东西必须是**应用之后能读到的那一份**。
*/

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const command = process.argv[2]
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

if (!['progress', 'run-once', 'seed-static', 'backfill', 'search'].includes(command ?? '')) {
  console.error(
    '用法：node scripts/ai-index.mjs <progress|run-once|seed-static|backfill|search> [--limit N] [--user 用户名] [--query 文本]',
  )
  process.exit(2)
}

const target = resolveDatabaseTarget(process.env)
if (!target.ok) {
  console.error(`✖ ${target.reason}`)
  process.exit(2)
}
announceDatabaseTarget(target)

const { AiIndexService } = require(join(ROOT, 'dist/server/ai/index.service.js'))
const { AiRetrievalService } = require(join(ROOT, 'dist/server/ai/retrieval.service.js'))
const { AuthorizationService } = require(join(ROOT, 'dist/server/authz/authorization.service.js'))
const { StorageService } = require(join(ROOT, 'dist/server/storage/storage.service.js'))
const { LocalStorageProvider } = require(join(ROOT, 'dist/server/storage/local.provider.js'))
const { S3StorageProvider } = require(join(ROOT, 'dist/server/storage/s3.provider.js'))
const { resolveAiConfig } = require(join(ROOT, 'dist/server/ai/ai.config.js'))
const { createAiProvider } = require(join(ROOT, 'dist/server/ai/provider.js'))

/*
  直接手工装配：这些服务的依赖都是普通对象（sql / storage / provider），
  不需要 Nest 容器。**刻意不复制任何业务逻辑** —— 与线上跑的是同一份实现。
*/
const sql = postgres(target.url, { max: 2, onnotice: () => {} })
const config = resolveAiConfig(process.env)
const provider = createAiProvider(config)
// 与线上装配同一份实现（见 server/storage/storage.module.ts）
const storage = new StorageService(new LocalStorageProvider(), new S3StorageProvider())
const index = new AiIndexService(sql, storage, provider, config)
const authz = new AuthorizationService(sql)
const retrieval = new AiRetrievalService(sql, authz)

try {
  if (command === 'progress') {
    const progress = await index.progress()
    console.log('  索引任务：', JSON.stringify(progress.jobs))
    console.log('  片段状态：', JSON.stringify(progress.chunks))
    console.log(`  AI 供应商：${config.enabled ? `已启用（${config.provider} / ${config.model} / ${config.api}）` : `未启用 —— ${config.disabledReason}`}`)
    if (progress.lastError !== null) console.log(`  最近一次失败：${progress.lastError}`)
  } else if (command === 'run-once') {
    const limit = Number(arg('limit', '5'))
    const result = await index.runOnce(Number.isFinite(limit) && limit > 0 ? limit : 5)
    if (!has('quiet')) console.log('  本轮：', JSON.stringify(result))
    if (result.claimed === 0 && !has('quiet')) console.log('  （没有到期任务；先 backfill 或上传新文件）')
  } else if (command === 'seed-static') {
    const seeded = await index.seedStaticChunks()
    console.log(`  站点规则片段：${seeded.siteRules} 条；目录说明片段：${seeded.directories} 条`)
  } else if (command === 'backfill') {
    const enqueued = await index.enqueueAll('BACKFILL')
    console.log(`  已入队：资源 ${enqueued.resources} 个、文件 ${enqueued.files} 个（重复的会被幂等忽略）`)
    console.log('  接着跑 run-once（或等 worker）直到 progress 里 PENDING 归零')
  } else {
    // ── search：以某个账号的身份检索（权限边界的人工核对入口）──────────────
    const username = arg('user')
    const query = arg('query')
    if (username === null || query === null) {
      console.error('✖ search 需要 --user <用户名> 与 --query <文本>')
      process.exit(2)
    }
    const [user] = await sql`
      SELECT id::text, username, name, role, status FROM users WHERE lower(username) = ${username.toLowerCase()} LIMIT 1
    `
    if (user === undefined) {
      console.error(`✖ 找不到账号 ${username}`)
      process.exit(4)
    }
    const limit = Number(arg('limit', '8'))
    const actor = { id: user.id, username: user.username, name: user.name, role: user.role, status: user.status }
    const started = Date.now()
    const chunks = await retrieval.retrieve(actor, query, { limit: Number.isFinite(limit) ? limit : 8 })
    const citable = await retrieval.filterCitable(actor, chunks)
    console.log(`  以 ${user.username}（${user.role}）检索「${query}」：命中 ${chunks.length} 条，复核可引用 ${citable.length} 条，用时 ${Date.now() - started}ms`)
    for (const chunk of citable) {
      const where = chunk.directoryPath === '' ? '(无目录)' : chunk.directoryPath
      console.log(
        `   · [${chunk.sourceKind}] ${chunk.title || '(无标题)'} ｜ ${where} ｜ score=${chunk.score.toFixed(3)}` +
          (chunk.resourceId === '' ? '' : ` ｜ /resources/${chunk.resourceId}`),
      )
      console.log(`      ${chunk.text.replace(/\s+/g, ' ').slice(0, 120)}…`)
    }
    if (citable.length === 0) console.log('   （没有命中：可能是没索引、或这个账号看不到任何相关内容 —— 这正是权限过滤该有的样子）')
  }
} catch (error) {
  console.error(`✖ 执行失败：${error.message}`)
  process.exitCode = 3
} finally {
  await sql.end()
}
