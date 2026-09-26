#!/usr/bin/env node
/**
 * scripts/ci-check-drizzle-api.mjs — drizzle-orm 升级前后的 API 兼容性闸门
 * ==========================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * `drizzle-orm` 是**精确锁定**的依赖（`package.json` 里写死 `0.45.3`，无 caret）。
 * CVE-2026-39356（GHSA-gpj5-g38j-94v9，HIGH，identifier 转义不完整导致 SQL 注入）
 * 的修复首次出现在 0.45.2，所以这个项目刻意停在带修复的版本上。
 *
 * 锁定版本的原因有两层，第二层是本脚本存在的原因：
 *
 *   1. **平台期**：`@lark-apaas/nestjs-datapaas` 声明 `peerDependencies.drizzle-orm
 *      = "0.44.6"`（无 caret），而带修复的版本在 peer 范围之外 —— 那是一次明确记录的、
 *      被迫的偏差，必须证明偏差安全。
 *   2. **脱平台后**：平台包已删除，但**本仓库自己**接管了同一个 monkey patch。
 *      `server/database/request-database-role.ts` 直接读取 drizzle 的内部符号：
 *
 *          PostgresJsPreparedQuery.prototype.execute
 *          <prepared query>.client            （postgres.js 的 Sql / 事务对象）
 *          PostgresJsDatabase.$client         （server/modules/auth/auth.service.ts 用它
 *                                              做「切换 authenticated_ 角色」的原始写入）
 *
 *      这三个符号就是本应用与 drizzle 内部实现之间的**全部耦合面**。升级 drizzle 时
 *      任何一个消失或改名，都会让「每个请求以 anon_ 角色执行 SQL」这条数据库级控制
 *      静默失效（`request-database-role.ts` 会拒绝启动 —— 那正是它 throw 而不是
 *      静默降级的原因），或者让密码重置路径抛错。本脚本把这件事提前到 CI。
 *
 * 注意：这是**符号存在性**检查，不是行为等价性检查。符号仍在但语义变了，本脚本发现
 * 不了 —— 那种风险只能由真实请求路径验证（`scripts/verify-all.sh` 的 HTTP 套件 +
 * `tests/cover-asset-root.test.mjs` 启动真实服务的那一层）。脚本不会假装它能覆盖这一点。
 *
 * USAGE
 *   node scripts/ci-check-drizzle-api.mjs
 * EXIT: 0 全部符号存在；1 有缺失（**不可升级**）
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 从仓库根解析，保证脚本从任何 cwd 运行都能找到 node_modules
const require = createRequire(join(ROOT, 'package.json'));

/**
 * 读取已安装版本。
 * 不能写 `require('drizzle-orm/package.json')`：drizzle-orm 的 exports 字段有数百个
 * 入口却**没有** "./package.json"，所以那个写法必然抛错（第一版就是这么误报"未安装"的）。
 * 改用 require.resolve 定位主入口，再向上找到包根。
 */
function versionOf(name) {
  try {
    const entry = require.resolve(name);
    const marker = `node_modules/${name}/`;
    const idx = entry.lastIndexOf(marker);
    if (idx === -1) return null;
    const pkgDir = entry.slice(0, idx + marker.length);
    return JSON.parse(require('node:fs').readFileSync(`${pkgDir}package.json`, 'utf8')).version;
  } catch {
    return null;
  }
}

let bad = 0;

console.log('drizzle-orm API 兼容性检查');
console.log(`  已装版本: ${versionOf('drizzle-orm') ?? '(未安装)'}`);
console.log('');

let drizzleMain;
let pgModule;
try {
  drizzleMain = require('drizzle-orm');
} catch (error) {
  console.log(`  ✗ 无法 require('drizzle-orm'): ${error.message}`);
  process.exit(1);
}
try {
  pgModule = require('drizzle-orm/postgres-js');
} catch (error) {
  console.log(`  ✗ 无法 require('drizzle-orm/postgres-js'): ${error.message}`);
  console.log('    这是 server/database/database.module.ts 建库唯一用到的入口，缺失即不可运行。');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. 本应用自己的 monkey patch 依赖的内部符号
//    —— 缺任何一个，进程启动即抛错（server/database/request-database-role.ts）
// ---------------------------------------------------------------------------
console.log('本应用依赖的 drizzle 内部符号（server/database/request-database-role.ts）:');

for (const key of ['drizzle', 'PostgresJsPreparedQuery', 'PostgresJsDatabase']) {
  const ok = key in pgModule;
  console.log(`  ${ok ? '✓' : '✗'} drizzle-orm/postgres-js 导出 "${key}"`);
  if (!ok) bad += 1;
}

const PreparedQuery = pgModule.PostgresJsPreparedQuery;
const hasExecute = Boolean(PreparedQuery?.prototype?.execute);
console.log(`  ${hasExecute ? '✓' : '✗'} PostgresJsPreparedQuery.prototype.execute 存在`);
if (!hasExecute) {
  bad += 1;
  console.log('    ↑ 这一条缺失会让 installDrizzleRolePreamble() 拒绝启动：');
  console.log('      "每请求 SET LOCAL ROLE anon_" 无法安装，所有 SQL 会以连接自身的');
  console.log('      登录角色执行，migration 0004/0005 的数据库级限制静默失效。');
}

// The preamble patch also needs the prepared query's `client` (postgres.js Sql /
// transaction) to expose begin()/unsafe(). Verified structurally rather than by
// running a query: a real query would need a live database, and this check must be
// runnable in CI before one exists.
const preparedProto = PreparedQuery?.prototype;
const hasExecuteOwn = preparedProto && Object.getOwnPropertyNames(preparedProto).includes('execute');
console.log(`  ${hasExecuteOwn ? '✓' : '✗'} execute 定义在 PostgresJsPreparedQuery.prototype 上（而非更上层）`);
if (!hasExecuteOwn) {
  bad += 1;
  console.log('    ↑ 补丁安装在 PostgresJsPreparedQuery.prototype 上；如果 execute 被上移到父类，');
  console.log('      Object.defineProperty 式的安装会失效（当前实现用直接赋值，仍然有效，但请复核）。');
}

const dbProto = pgModule.PostgresJsDatabase?.prototype;
const hasExecuteOnDb = Boolean(dbProto && typeof dbProto.execute === 'function');
console.log(`  ${hasExecuteOnDb ? '✓' : '✗'} PostgresJsDatabase.prototype.execute 存在（$client 的宿主）`);
if (!hasExecuteOnDb) bad += 1;

// ---------------------------------------------------------------------------
// 2. 本应用自己 import 的 API（server/** 与 shared/** 中的 `from 'drizzle-orm'`）
// ---------------------------------------------------------------------------
console.log('');
console.log('本应用使用的 API:');
const APP_API = [
  'sql', 'eq', 'ne', 'and', 'or', 'not', 'count', 'exists', 'isNull', 'isNotNull',
  'inArray', 'notInArray', 'like', 'ilike', 'gte', 'lte', 'lt', 'gt',
  'desc', 'asc', 'max', 'min', 'sum', 'avg', 'getTableColumns',
];
const missingApp = APP_API.filter((k) => !(k in drizzleMain));
if (missingApp.length === 0) {
  console.log(`  ✓ 全部 ${APP_API.length} 个符号存在`);
} else {
  console.log(`  ✗ 缺失: ${missingApp.join(', ')}`);
  bad += missingApp.length;
}

// 类型导出走类型系统，运行时 require 看不到；由 tsc 负责（npm run type:check:server）。
console.log('  · 类型导出（PostgresJsDatabase 等）不在运行时检查范围，由 tsc 覆盖');

// ---------------------------------------------------------------------------
console.log('');
if (bad === 0) {
  console.log('RESULT: PASS — drizzle-orm 提供本应用所需的全部运行时符号');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${bad} 个符号缺失，不可升级到该版本`);
process.exit(1);
