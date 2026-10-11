#!/usr/bin/env node
/**
 * scripts/reset-user-password.mjs —— 离线重置某个账号的口令（生产运维动作）
 * ============================================================================
 * 为什么需要它：V2 的口令哈希是**从 V1 原样搬过来**的（`import-v1.mjs`：非空就复制），
 * 所以"某位老师忘了口令、而 V1 那边只有管理员能重置"就会卡住整个上线验收。
 * 项目刻意**没有**默认口令（`bootstrap-admin.mjs` 也拒绝 admin/123456），
 * 也不该为了登录去改 V1 —— 于是给一个显式、可审计、只动 V2 的入口。
 *
 * 用法（口令走**文件**，不进 shell 历史、不进进程列表）：
 *   DATABASE_URL='postgresql://…/V2 库' \
 *   RESET_USERNAME=TsinglanAdmin \
 *   RESET_PASSWORD_FILE=/tmp/newpw.txt \
 *   RESET_CONFIRM=RESET-USER-PASSWORD \
 *   node scripts/reset-user-password.mjs [--reason '说明'] [--dry-run]
 *
 * 三条硬规则（与 `transfer-superadmin.mjs` 同一套）：
 *   1. **没有 `DATABASE_URL` 就立刻退出** —— 运维脚本不接受任何默认库，
 *      否则"我以为在跑目标环境、其实在跑本机开发库"；
 *   2. 连库**之前**打印**脱敏**目标（`user@host:port/db`，不含口令）并标明本机/非本机；
 *   3. 要求 `RESET_CONFIRM=RESET-USER-PASSWORD` 字面量 —— 改别人口令是低风险但不可逆的动作
 *      （旧口令立即失效），敲错用户名就会真的改错人。
 *
 * 它在**一个事务**里做三件事：
 *   ① 锁行核对账号存在（不存在 → 退出码 3，什么都不改）；
 *   ② 写入新的 scrypt 哈希（用应用自己的 `hashPassword()`，即登录校验的同一段代码）；
 *   ③ **撤销该账号全部会话**（凭据变了，旧会话不该继续有效）+ 写一条审计
 *      （`user.password_change`，与"用户自己改口令"的 `auth.change_password` 分开记）。
 *
 * 它**不回显口令**：口令由调用方提供，脚本只确认"已重置 + 撤销了几条会话"。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import postgres from 'postgres'
import { announceDatabaseTarget, resolveDatabaseTarget } from './lib/db-target.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { hashPassword } = require(join(ROOT, 'dist/server/auth/password.js'))

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const CONFIRM = 'RESET-USER-PASSWORD'
const MIN_LENGTH = 12

function fail(message, code) {
  console.error(`✖ ${message}`)
  process.exit(code)
}

const username = String(process.env.RESET_USERNAME ?? '').trim()
const reason = String(arg('reason') ?? '离线重置（ops 脚本）')
const dryRun = has('dry-run')

const passwordFile = process.env.RESET_PASSWORD_FILE ?? ''
const password = passwordFile === ''
  ? String(process.env.RESET_PASSWORD ?? '')
  : readFileSync(passwordFile, 'utf8').replace(/\n$/, '')

/** 目标库：不接受默认值，也不猜。 */
const target = resolveDatabaseTarget(process.env)
if (!target.ok) fail(target.reason, 2)
announceDatabaseTarget(target)

if (username === '') fail('必须提供 RESET_USERNAME（要点名重置哪个账号）。', 2)
if (password === '') fail('必须提供 RESET_PASSWORD_FILE（推荐）或 RESET_PASSWORD。', 2)
if (password.length < MIN_LENGTH) fail(`口令至少 ${MIN_LENGTH} 位（当前 ${password.length} 位）。`, 2)
if (password.trim() !== password) fail('口令首尾不能有空白字符（粘贴时最容易带上）。', 2)
if (password.toLowerCase().includes(username.toLowerCase())) {
  fail('口令不能包含用户名本身 —— 那是最典型的弱口令特征。', 2)
}
if (process.env.RESET_CONFIRM !== CONFIRM) {
  fail(`需要 RESET_CONFIRM=${CONFIRM} 字面量（改口令不可逆：旧口令会立即失效）。`, 2)
}

const sql = postgres(target.url, { max: 1, onnotice: () => {}, connect_timeout: 20 })

try {
  const result = await sql.begin(async (tx) => {
    const [user] = await tx`
      SELECT id::text, username, name, role, status FROM users
      WHERE lower(username) = ${username.toLowerCase()} FOR UPDATE`
    if (!user) return { found: false }

    if (dryRun) return { found: true, dryRun: true, user }

    const hash = hashPassword(password)
    await tx`
      UPDATE users SET password_hash = ${hash}, updated_at = now() WHERE id = ${user.id}`

    const revoked = await tx`
      UPDATE sessions SET revoked_at = now()
      WHERE user_id = ${user.id} AND revoked_at IS NULL
      RETURNING id::text`

    await tx`
      INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, result, detail)
      VALUES (NULL, '口令重置（离线脚本）', 'user.password_change', 'user', ${user.id},
              'success', ${tx.json({
                targetName: user.name,
                targetUsername: user.username,
                reason,
                sessionsRevoked: revoked.length,
                dryRun: false,
              })})`

    return { found: true, user, revoked: revoked.length }
  })

  if (!result.found) {
    fail(`库里没有 username=${username} 的账号（一个字都没改）。`, 3)
  }
  if (result.dryRun) {
    console.log(`✔ 演练通过：找到 ${result.user.username}（${result.user.name}，${result.user.role}/${result.user.status}）—— --dry-run 没有写任何东西。`)
    process.exit(0)
  }

  console.log(`✔ 已重置 ${result.user.username}（${result.user.name}）的口令 —— 口令值不回显`)
  console.log(`  已撤销该账号的会话：${result.revoked} 条（凭据变了，旧会话不该继续有效）`)
  console.log('  审计：user.password_change（actor 为空、写明"口令重置（离线脚本）"）')
  if (result.user.status !== 'active') {
    console.log(`  ⚠ 注意：该账号状态是 ${result.user.status} —— 换了口令也**登不进去**，需要先启用。`)
  }
} catch (error) {
  fail(`执行失败：${error.message}`, 4)
} finally {
  await sql.end()
}
