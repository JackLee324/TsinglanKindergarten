/**
 * scripts/bootstrap-admin.mjs —— 初始化第一个管理员
 * ============================================================================
 *   INITIAL_ADMIN_USERNAME=admin INITIAL_ADMIN_PASSWORD='<强口令>' node scripts/bootstrap-admin.mjs
 *
 * 三条约束（业主 §67）：
 *   1. **不要** admin/admin 或 admin/123456 —— 口令必须由环境变量显式提供，
 *      没有默认值；不给就直接失败。
 *   2. 只在**没有任何 ADMIN** 时创建。已经初始化过就拒绝，避免误建第二个管理员。
 *   3. 创建成功后打印一次**修改口令的提示**（界面上的改密入口在阶段 4），
 *      并且这件事写进审计。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import postgres from 'postgres'

// 编译产物是 CommonJS（NestJS/SWC 的默认输出），所以用 require 加载，
// 而不是 ESM 的具名导入 —— 后者对 CJS 模块会报 "Named export not found"。
const require = createRequire(import.meta.url)
const { hashPassword } = require('../dist/server/auth/password.js')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
void ROOT

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_v2_dev'
const username = process.env.INITIAL_ADMIN_USERNAME
const password = process.env.INITIAL_ADMIN_PASSWORD

if (!username || !password) {
  console.error(
    '必须显式提供 INITIAL_ADMIN_USERNAME 与 INITIAL_ADMIN_PASSWORD。\n' +
      '本项目**没有**默认管理员口令 —— 那不是"方便"，那是把生产入口公开。',
  )
  process.exit(2)
}
if (password.length < 12) {
  console.error('管理员口令至少 12 位。')
  process.exit(2)
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} })

try {
  const existing = await sql`SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN'`
  if (existing[0].n > 0) {
    console.error(`已经存在 ${existing[0].n} 个管理员账号，拒绝重复初始化。`)
    process.exit(3)
  }

  const created = await sql`
    INSERT INTO users (username, name, name_en, password_hash, role)
    VALUES (${username}, '系统管理员', 'Administrator', ${hashPassword(password)}, 'ADMIN')
    RETURNING id
  `
  await sql`
    INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, result, detail)
    VALUES (${created[0].id}, '系统', 'user.create', 'user', ${created[0].id}, 'success',
            ${sql.json({ bootstrap: true, username })})
  `
  console.log(`  ✔ 已创建管理员：${username}（id=${created[0].id}）`)
  console.log('  ⚠️  请立刻登录并修改口令；本账号仅有 ADMIN 身份，不需要额外授权。')
} catch (error) {
  console.error('初始化失败：' + (error?.message ?? error))
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}
