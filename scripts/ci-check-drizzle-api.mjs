#!/usr/bin/env node
/**
 * scripts/ci-check-drizzle-api.mjs — drizzle-orm 升级前后的 API 兼容性闸门
 * ==========================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * `drizzle-orm` 是**精确锁定**的 peer 依赖，被两个平台包声明为 `"0.44.6"`
 * （无 caret）：
 *     @lark-apaas/fullstack-nestjs-core@1.1.64  peerDependencies.drizzle-orm = "0.44.6"
 *     @lark-apaas/nestjs-datapaas@1.0.22       peerDependencies.drizzle-orm = "0.44.6"
 *
 * 而 CVE-2026-39356（GHSA-gpj5-g38j-94v9，HIGH，identifier 转义不完整导致 SQL 注入）
 * 的修复首次出现在 **0.45.2**。也就是说：要不带洞，就必须升级到平台包 peer 范围之外的
 * 版本 —— 这是一个**明确记录的、被迫的偏差**，不是随手升级。
 *
 * 因为有偏差，就必须证明偏差是安全的。`@lark-apaas/nestjs-datapaas` 有一个
 * monkey patch，直接读 drizzle 的内部符号：
 *
 *     // node_modules/@lark-apaas/nestjs-datapaas/dist/index.js:728+
 *     const pgModule = __require("drizzle-orm/postgres-js");
 *     const PreparedQuery = pgModule.PostgresJsPreparedQuery;
 *     if (!PreparedQuery?.prototype?.execute) {
 *       throw new Error("drizzle-orm PostgresJsPreparedQuery.prototype.execute 不存在，版本可能不兼容");
 *     }
 *
 * 如果升级后这个符号没了，进程会在启动阶段直接抛错。本脚本把那个检查前移到这里，
 * 于升级**前后**各跑一次：升级前必须通过（证明检查本身有效），升级后也必须通过
 * （证明新版本仍然提供这些符号）。
 *
 * 注意：这是**符号存在性**检查，不是行为等价性检查。`PostgresJsPreparedQuery` 仍然
 * 存在但语义变了，本脚本是发现不了的 —— 那种风险只能由平台上真实的请求路径验证。
 * 脚本不会假装它能覆盖这一点。
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
 * 不能写 `require('drizzle-orm/package.json')`：drizzle-orm 的 exports 字段有 443 个
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

// ---------------------------------------------------------------------------
// 1. @lark-apaas/nestjs-datapaas 的 monkey patch 依赖的内部符号
//    —— 缺任何一个，进程启动即抛错
// ---------------------------------------------------------------------------
console.log('平台包依赖的内部符号（@lark-apaas/nestjs-datapaas monkey patch）:');

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
  console.log('    这是 @lark-apaas/nestjs-datapaas 建库唯一用到的入口，缺失即不可升级。');
  process.exit(1);
}

for (const key of ['sql']) {
  const ok = key in drizzleMain;
  console.log(`  ${ok ? '✓' : '✗'} drizzle-orm 导出 "${key}"`);
  if (!ok) bad += 1;
}
for (const key of ['drizzle', 'PostgresJsPreparedQuery']) {
  const ok = key in pgModule;
  console.log(`  ${ok ? '✓' : '✗'} drizzle-orm/postgres-js 导出 "${key}"`);
  if (!ok) bad += 1;
}

const PreparedQuery = pgModule.PostgresJsPreparedQuery;
const hasExecute = Boolean(PreparedQuery?.prototype?.execute);
console.log(`  ${hasExecute ? '✓' : '✗'} PostgresJsPreparedQuery.prototype.execute 存在`);
if (!hasExecute) {
  bad += 1;
  console.log('    ↑ 这一条缺失会让 @lark-apaas/nestjs-datapaas 在 applyDrizzleMonkeyPatch() 里');
  console.log('      直接 throw("drizzle-orm PostgresJsPreparedQuery.prototype.execute 不存在，版本可能不兼容")');
}

// ---------------------------------------------------------------------------
// 2. 本应用自己 import 的 API（14 个文件 `from 'drizzle-orm'`）
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
console.log('  · 类型导出（SQLWrapper 等）不在运行时检查范围，由 tsc 覆盖');

// ---------------------------------------------------------------------------
console.log('');
if (bad === 0) {
  console.log('RESULT: PASS — drizzle-orm 提供平台包与应用所需的全部运行时符号');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${bad} 个符号缺失，不可升级到该版本`);
process.exit(1);
