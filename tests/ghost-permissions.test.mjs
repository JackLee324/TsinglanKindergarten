/**
 * tests/ghost-permissions.test.mjs —— 幽灵权限审计（§22/§27/§29）。
 *
 * 背景（真实发现，不是假想）：`AuthorizationService.setPermissionOverride()`
 * 有表（`account_permission_overrides`）、有读、有写函数，但**全仓没有任何调用者**
 * —— 也就是说这套机制"定义了却完全无法使用"。这类东西在界面上看不出来、
 * 在类型检查里也看不出来，只能靠"声明与使用对照"扫出来。
 *
 * 本测试做两件事：
 *   1. `shared/rbac.ts` 里声明的每个权限，必须至少被**一个服务端位置**消费
 *      （`@RequirePermission` 装饰器，或服务层显式判定）。没被消费的 = 幽灵权限。
 *   2. 每个被消费的权限，必须**确实存在于** `PERMISSIONS` 目录里。
 *      拼错一个权限名会让装饰器静默失效（守卫查不到就等于放行），
 *      所以这一条比第 1 条更关键。
 *
 * 例外必须**显式列在下面**并写明理由 —— 否则"加白名单"就成了把测试调绿的手段。
 */
import { register } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/ts-alias-loader.mjs', import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rbac = await import(new URL('../shared/rbac.ts', import.meta.url).href);
const { PERMISSION_CODES, PERMISSIONS } = rbac;

let pass = 0, fail = 0;
const failures = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(64) + ' -> ' + String(actual) +
    (ok ? '' : '   expected ' + String(expected)));
  if (ok) pass++; else { fail++; failures.push(label); }
}

/** 递归收集 .ts 文件（跳过测试与生成物）。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (['node_modules', 'dist', 'gen', 'vendor'].includes(entry)) continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const serverFiles = walk(join(ROOT, 'server'));

/**
 * 去掉注释再扫描。
 *
 * 第一版没做这件事，结果 4 处"业务层内联角色判断"全是**注释** ——
 * 它们恰恰是在解释"这里以前写的是 roles.includes('principal')，现在改成声明式权限了"。
 * 把注释当代码扫，会让审计报出一堆不存在的问题，而真正的问题淹在里面。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * 收集"被消费的权限"：`@RequirePermission('a','b')`、`@RequireSuperAdminPer()`
 * 之外的两种写法 —— 装饰器数组，以及服务层 `require(authz, 'x')` /
 * `permissions.includes('x')` 这类显式比较。
 */
const consumed = new Map(); // permission -> [file:line]
const patternDecorator = /@RequirePermission\(([^)]*)\)/g;
const patternStringUse = /['"]([a-z_]+\.[a-z_]+)['"]/g;

/**
 * 通过**常量**消费的权限也要算数。
 *
 * 例如 `shared/rbac.ts` 导出
 *   export const RESET_PRIVILEGED_PASSWORD_PERMISSION = 'account.reset_privileged_password'
 * 而服务端引用的是这个常量名，不是权限字符串字面量。第一版只找字面量，
 * 于是把一个**确实被消费**的权限报成了幽灵权限 —— 审计的第一版就是会因为
 * 检测方式而误报，所以修检测方式，而不是把它登记进白名单。
 */
const rbacSource = readFileSync(join(ROOT, 'shared', 'rbac.ts'), 'utf8');
const constantToCode = new Map();
for (const m of rbacSource.matchAll(
  /export const ([A-Z0-9_]+)(?::\s*PermissionCode)?\s*=\s*\n?\s*'([a-z_]+\.[a-z_]+)'/g,
)) {
  constantToCode.set(m[1], m[2]);
}

/**
 * 去掉 import 语句。
 *
 * **这是本轮抓到的一个真实误报**：`role.assign` 的常量被 import 进
 * teachers.service.ts 之后，审计就把它算成"已消费" —— 而那份代码里
 * 根本没有任何地方使用它（参数摆在那里没人读）。也就是说
 * **只要 import 一下就能骗过这个审计**，那它检查的就不是"有没有被使用"。
 * 现在先剥 import 再统计：只有真正出现在表达式里的引用才算消费。
 */
function stripImports(text) {
  return text.replace(/^\s*import[\s\S]*?from\s+'[^']+';\s*$/gm, '');
}

for (const file of serverFiles) {
  const text = stripImports(stripComments(readFileSync(file, 'utf8')));
  const rel = relative(ROOT, file);

  // 常量形式的消费
  for (const [name, code] of constantToCode) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      if (!consumed.has(code)) consumed.set(code, []);
      consumed.get(code).push(`${rel} (via ${name})`);
    }
  }

  for (const m of text.matchAll(patternDecorator)) {
    for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
      const key = s[1];
      if (!consumed.has(key)) consumed.set(key, []);
      consumed.get(key).push(`${rel} (decorator)`);
    }
  }

  // 服务层里的权限字面量：只在"看起来像权限码"（含点、且前缀是已知分组）时才算，
  // 否则会把 'resource.download' 之外的普通字符串误判成权限。
  const groups = new Set(PERMISSIONS.map((p) => p.code.split('.')[0]));
  for (const m of text.matchAll(patternStringUse)) {
    const key = m[1];
    if (!groups.has(key.split('.')[0])) continue;
    if (!PERMISSION_CODES.includes(key)) continue; // 只统计确实存在的权限码
    if (!consumed.has(key)) consumed.set(key, []);
    const line = text.slice(0, m.index).split('\n').length;
    consumed.get(key).push(`${rel}:${line}`);
  }
}

/**
 * 已知的、**刻意**没有服务端消费点的权限，必须写明理由。
 * 这个列表每增加一项都应该被追问一次。
 */
const KNOWN_UNCONSUMED = new Map([
  // 目前为空。若有权限确实只用于前端展示门控，在这里登记并说明。
]);

console.log('\n=== 幽灵权限审计 ===\n');
console.log(`  目录里的权限数 = ${PERMISSION_CODES.length}`);
console.log(`  服务端被消费的权限数 = ${consumed.size}\n`);

// ---- 1. 拼错的权限名（最危险：守卫查不到等于放行）----
const unknown = [...consumed.keys()].filter((k) => !PERMISSION_CODES.includes(k));
check('服务端引用的权限码全部存在于目录中（拼错会让守卫静默失效）', unknown.length, 0);
if (unknown.length > 0) {
  for (const k of unknown) console.log(`      ! ${k} —— 出现在 ${consumed.get(k).join(', ')}`);
}

// ---- 2. 幽灵权限：声明了但没人消费 ----
const unconsumed = PERMISSION_CODES.filter(
  (code) => !consumed.has(code) && !KNOWN_UNCONSUMED.has(code),
);

/**
 * 棘轮（ratchet）：**已知**的幽灵权限登记在此，数量不得增长。
 *
 * 为什么不直接把 22 条全删了：它们同时出现在 `PERMISSIONS` 目录与
 * `ROLE_PERMISSIONS` 角色默认值里，权限矩阵界面会照常显示"某角色拥有 X"。
 * 删掉目录项会让矩阵少一行，但**不会**让"授予了也没用"这件事消失 ——
 * 真正的问题是没有消费点，不是目录项多余。所以这里把它们记成已知债务，
 * 并在每次运行时完整打印出来，任何人加新权限却忘了接消费点时**立刻失败**。
 */
// 22 → 21：`role.assign` 接上消费点（teachers.service 的 `assertCanAssignRoles`）。
// 21 → 19：§11 的按账号授权接口让 `permission.view` 与 `permission.revoke` 也有了消费点。
// 棘轮只能往下走；每次下降都要能指出是哪条权限、被哪个位置消费。
/**
 * 基线是**棘轮**：只许变小，不许变大。
 *
 * 19 → 18（本轮）：`resource.purge` 原先只声明、从未被任何路由或守卫检查，
 * 于是回收站里的资源只能等 30 天保留期到期，运维**没有按需永久删除的入口**。
 * 加上 `POST /api/resources/:id/purge`（要求 `resource.purge`，且只接受
 * 已在回收站中的行 + 必填 reason 进审计）之后，它被真正消费了，所以基线收紧到 18。
 *
 * 收紧而不是保持不变是刻意的：保持 19 等于允许再冒出一个幽灵权限。
 */
const KNOWN_GHOST_BASELINE = 18;

check('幽灵权限没有比已知基线更多（新增权限必须接上消费点）',
  unconsumed.length <= KNOWN_GHOST_BASELINE ? 0 : unconsumed.length - KNOWN_GHOST_BASELINE, 0);

console.log(`\n  已知幽灵权限 ${unconsumed.length} 条（基线 ${KNOWN_GHOST_BASELINE}）—— 声明了但服务端从不检查：`);
for (const code of unconsumed) console.log(`      · ${code}`);
console.log('  含义：授予或撤销这些权限**不会改变任何服务端行为**；权限矩阵界面仍会照常显示它们。');

// ---- 3. 反向：服务端判定是否都走声明式权限（避免内联角色判断）----
const roleLiterals = [];
const ROLE_LITERAL = /roles\.includes\(\s*['"](principal|curriculum_director|prek_head|k_head|pe_specialist|prek_assistant|k_assistant|super_admin|visitor)['"]/g;
for (const file of serverFiles) {
  const rel = relative(ROOT, file);
  if (rel.includes('auth.guard.ts') || rel.includes('authorization.service.ts')) continue; // 这两处是规则实现本身
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const m of text.matchAll(ROLE_LITERAL)) {
    const line = text.slice(0, m.index).split('\n').length;
    roleLiterals.push(`${rel}:${line}`);
  }
}
check('业务层没有内联的角色字面量判断（§8 单一真相）', roleLiterals.length, 0);
if (roleLiterals.length > 0) for (const l of roleLiterals) console.log(`      ! ${l}`);

console.log(`\n=== RESULT ===`);
console.log(`  pass=${pass} fail=${fail}`);
if (fail > 0) { console.log('\n失败明细：'); for (const f of failures) console.log('  * ' + f); process.exit(1); }
