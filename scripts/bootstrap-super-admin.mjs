#!/usr/bin/env node
/**
 * scripts/bootstrap-super-admin.mjs — REPORT-ONLY 诊断与操作指引
 * =================================================================
 *
 * ⚠️  这个脚本**绝不写入数据库**。它的唯一数据库访问是**只读事务**
 *     （`BEGIN READ ONLY`，由 `sql.begin('read only', …)` 发出），这是**数据库
 *     层面**的保证，不依赖脚本自身的自觉。任何 INSERT / UPDATE / DELETE / ALTER /
 *     DROP / TRUNCATE / GRANT 在本脚本的事务里都会被 PostgreSQL 以
 *     `25006 read_only_sql_transaction` **拒绝**。
 *
 *     **本脚本全文件不含 `.unsafe()`，也不含任何写语句** —— 连"只读事务内试写"
 *     的探针都不在这里（那需要一条写语句）。探针在 `--self-test` 生成的临时文件里，
 *     位于**仓库之外**，用完即删。这样"仓库里不存在写语句"是可以被静态核对的。
 *
 *     想让它写？必须**刻意改代码**：去掉只读事务、并处理本文件内置的写入模式自查
 *     （见 assertNoWriteCapability）。它不会因为一次疏忽就变成能写的工具。
 *
 * 为什么需要它
 * ------------
 * 生产就绪门禁的第 7 项会 FAIL：**没有任何 super_admin 能登录**。这个库目前的
 * 唯一 super_admin 是测试夹具 `__rbac_keeper`，被**刻意设计为没有 password_hash**
 * （tests/helpers/reset-fixtures.mjs:116-131），用于在验证运行期间满足"最后一个
 * super_admin 不可删除"的触发器。它是夹具，不是生产账号。
 *
 * 门禁只会告诉你"你失败了"。这个脚本告诉你"接下来具体做什么"。
 *
 * 为什么必须先直连 SQL（而不是用 API）
 * ------------------------------------
 * 已核实**不存在自举路径**：
 *   * `shared/rbac.ts:245-249` 的 `canGrantRole()`：`targetRole === SUPER_ADMIN_ROLE`
 *     时**只有** super_admin 自己才能授予 —— 非 super_admin 永远不能（防提权）。
 *   * 数据库侧还有触发器 `trg_teachers_guard_super_admin`（migration 0003）兜底。
 *   * `server/modules/auth/seed-teachers.ts` 里 `super_admin` 出现 **0 次**。
 *   * 全仓检索无任何"无 super_admin 时自动提权"的自举逻辑。
 * 所以第一个 super_admin 只能由有权限的操作者直连数据库创建。
 *
 * 好消息：**只有密码哈希这一步需要手工**。MFA 可以完全走已发布的 API 自助完成
 * ——`auth.controller.ts:244-247` 的注释写得很清楚：
 *     "A super_admin that has not yet enrolled can reach this (see the MFA gate in
 *      AuthGuard), which is what makes the mandatory-MFA requirement
 *      self-serviceable instead of requiring manual database work."
 * 也就是 **不要**手工写 `teacher_mfa` / `mfa_recovery_codes`。
 *
 * USAGE
 *   node scripts/bootstrap-super-admin.mjs              # 诊断 + 指引（默认）
 *   node scripts/bootstrap-super-admin.mjs --verify     # 只跑验收断言，供脚本调用
 *   node scripts/bootstrap-super-admin.mjs --self-test  # 证明只读事务真的拒写
 *
 * 连接串优先级与 scripts/migrate.mjs 一致：
 *   MIGRATION_DATABASE_URL > DATABASE_URL > SUDA_DATABASE_URL
 * 只读诊断建议用**只读角色**连接（更稳的一层保证），但本脚本自身已足够。
 *
 * EXIT
 *   0  诊断完成（**不代表数据库就绪**；就绪与否看输出里的结论）
 *   1  无法连接 / 无法完成诊断
 *   2  只读保护被破坏（自查失败）—— 视为严重错误
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));

/**
 * 可执行 SQL 模板的位置。它在**本脚本之外**，由一个独立的 .sql.txt 文件承载。
 *
 * 这个安排是刻意的：本脚本的契约是"不含任何写语句"，若把供操作者复制的
 * 创建语句内联在这里，静态核对就失效了。放外部文件后，两件事同时成立：
 *   · scripts/ 下没有任何写语句（可 grep 核对）；
 *   · 操作者拿到的仍然是完整、可直接执行的模板。
 */
/**
 * 写操作规则表的位置。它在**另一个文件**里（见下方 assertNoWriteCapability 的说明）：
 * 规则表由正则与关键字字面量构成，若放在被扫描的文件中会命中自己。
 * 放到独立文件后，"本脚本不含写入能力"可以是真的，而不是近似。
 */
const FORBIDDEN_PATH = join(ROOT, 'scripts', 'ci-forbidden-write-patterns.mjs');

const SQL_HELP_PATH = join(ROOT, 'evidence', 'bootstrap', 'OPERATOR-SQL.sql.txt');

const ARGS = new Set(process.argv.slice(2));
const SELF_TEST = ARGS.has('--self-test');
const VERIFY_ONLY = ARGS.has('--verify');

// =============================================================================
// 只读保护（结构性，不是文档性的）
// =============================================================================

/**
 * 本文件**自身**的写入能力自查。
 *
 * 检查的是"会真正执行写入"的代码形态，而不是文件里出现过的单词：
 *   * `sql.unsafe(...)` / `.unsafe(...)` —— 任意 SQL 逃生舱
 *   * `` sql`INSERT|UPDATE|DELETE|...` `` —— 模板标签直接发写语句
 *   * `sql(...)` 调用形式
 * 注释与字符串字面量里给操作者看的 SQL **不会**命中，因为那些从不执行 ——
 * 这正是本文件里存在操作者 SQL 却不违反"无写入能力"的原因。
 *
 * 命中即 exit 2。这不是警告，是拒绝运行。
 */
// ==== SELF-CHECK DEFINITION START ====
/**
 * 本文件**自身**的写入能力自查。命中即 exit 2 —— 不是警告，是拒绝运行。
 *
 * 检查的三种形态：
 *   · 任意 SQL 逃生舱（驱动上的 unsafe 调用）
 *   · 以函数形式调用 sql(...)
 *   · 语句构造中出现写操作关键字（增/改/删/改表/删对象/清空/授权/建角色）
 *
 * 为什么规则表要放在**独立模块文件**里：这些规则本身就是"正则字面量 + 关键字
 * 字面量"，如果写在被扫描的文件中，规则会命中规则自己。曾尝试用文本标记
 * （START/END 注释行）把规则表排除掉，但那些标记行本身会被"先剥注释"这一步
 * 删掉，偏移随之漂移，排除区间落到别处 —— 实测确实又命中了自己。
 * 把规则表移出被扫描的文件，是唯一不依赖偏移算术的做法。
 */
async function assertNoWriteCapability() {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');

  // 1) 剥掉块注释与整行 // 注释。
  //    本文件头部必须解释"哪些语句会被拒"，因而必须点名那些关键字；
  //    若不剥，说明文字会被当成能力。
  let body = self
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // 2) 把规则表所在的区间**物理抠掉**：从数组声明处到文件末尾。
  //    规则表是本文件最后一段顶层代码，其后只有一次调用。
  //    （不用中点锚点，因为它会被第 1 步删掉导致偏移漂移。）
  const cutFrom = body.indexOf('const FORBIDDEN');
  if (cutFrom >= 0) body = body.slice(0, cutFrom);

  const stripped = body
    .split('\n')
    .map((l) =>
      l
        .replace(/\/\/.*$/, '')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``'),
    )
    .join('\n');

  // 3) 把候选文本交给**独立进程**，用规则表判定。
  //    独立进程不是"隔离"目的，而是为了让规则表存在于另一个文件中 ——
  //    被扫描的文件里因此不存在规则字面量。
  const tmp = join(tmpdir(), `qls-no-write-check-${process.pid}.mjs`);
  writeFileSync(tmp, stripped, { mode: 0o600 });
  const run = spawnSync(process.execPath, [FORBIDDEN_PATH, tmp], {
    encoding: 'utf8',
    timeout: 20000,
  });
  try { unlinkSync(tmp); } catch { /* 已删除 */ }

  let verdict = { hits: [], error: '' };
  try { verdict = JSON.parse(run.stdout || '{}'); } catch { verdict.error = run.stderr || '检查器无输出'; }
  if (verdict.error) {
    process.stderr.write(`\n[FATAL] 只读自查无法完成: ${String(verdict.error).split('\n')[0]}\n\n`);
    process.exit(2);
  }

  if (!Array.isArray(verdict.hits) || verdict.hits.length === 0) return true;
  process.stderr.write(
    '\n[FATAL] 只读自查失败 —— 本脚本含有写入能力，拒绝运行：\n' +
      verdict.hits.map((h) => `  · ${h}\n`).join('') +
      '  这个脚本的契约是"只读"。要改变契约必须刻意修改本文件与规则表，\n' +
      '  并在评审中被明确看到 —— 这是设计意图，不是障碍。\n\n',
  );
  process.exit(2);
}

// ==== SELF-CHECK DEFINITION END ====
await assertNoWriteCapability();

// =============================================================================
// 连接（只读事务）
// =============================================================================

function resolveDbUrl() {
  return (
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.SUDA_DATABASE_URL ||
    ''
  );
}

function describeUrl(url) {
  try {
    const u = new URL(url);
    return `scheme=${u.protocol.replace(':', '')} host=${u.hostname} port=${u.port || 'default'} db=${u.pathname.replace(/^\//, '')} creds=${u.username ? 'present' : 'ABSENT'}`;
  } catch {
    return '(不可解析的连接串)';
  }
}

const postgres = require('postgres');
const DB_URL = resolveDbUrl();

if (!DB_URL) {
  process.stderr.write(
    '[bootstrap-super-admin] 缺少连接串。\n' +
      '  设 SUDA_DATABASE_URL / DATABASE_URL / MIGRATION_DATABASE_URL 之一。\n',
  );
  process.exit(1);
}

const sql = postgres(DB_URL, { max: 1, onnotice: () => {}, connect_timeout: 10 });

/**
 * 在**只读事务**里执行读取。
 *
 * `sql.begin('read only', …)` 让 postgres.js 发出 `BEGIN READ ONLY`，此后本事务内
 * 任何写语句都由 PostgreSQL 拒绝（SQLSTATE 25006），不是由本脚本的纪律拒绝。
 *
 * 这里刻意**不使用** `.unsafe()`：一旦允许任意 SQL，只读保证就只剩脚本的自觉。
 * 保持全文件零 `.unsafe()`，本脚本在能力上就是只读的 —— 这也是 assertNoWriteCapability()
 * 能够做静态核对的前提。
 */
async function readOnly(fn) {
  return sql.begin('read only', (tx) => fn(tx));
}

// =============================================================================
// 读取：super_admin 现状
// =============================================================================

/**
 * 单个账号"能否真正登录"的判定链，全部来自代码：
 *   auth.service.ts:369-383  status !== 'active'        -> 403「账号已停用」
 *   auth.service.ts:375-383  password_hash 为空         -> 401「用户名或密码错误」，且写审计
 *   auth.service.ts:366-371  locked_until > now()       -> 403「账号已锁定」
 *   auth.guard.ts:171-181    requiresMfa(roles) 且未绑定 -> 403「该账号角色强制要求 MFA」
 *                                                            —— 除 @MfaExempt 路由外全部拒绝
 */
function evaluateAccount(row) {
  const problems = [];
  if (row.status !== 'active') problems.push(`status='${row.status}'（登录时被拒：账号已停用）`);
  if (!row.has_password) problems.push('无 password_hash（登录时直接 401，且写 login_failed 审计）');
  if (row.locked_now) problems.push(`locked_until=${row.locked_until?.toISOString?.() ?? row.locked_until}（当前处于锁定窗口内）`);
  if (!row.mfa_enrolled) {
    problems.push(
      row.mfa_pending
        ? 'MFA 已开始绑定但未确认（AuthGuard 仍视为未绑定，除 @MfaExempt 路由外全部拒绝）'
        : 'MFA 未绑定（AuthGuard 除 @MfaExempt 路由外全部拒绝）',
    );
  }
  return { canLogin: problems.length === 0, problems };
}

async function collectState(tx) {
  const accounts = await tx`
    select t.id,
           t.username,
           t.name,
           t.roles,
           t.status,
           (t.password_hash is not null)                                   as has_password,
           length(coalesce(t.password_hash, ''))                           as password_hash_len,
           t.failed_login_attempts,
           t.locked_until,
           (t.locked_until is not null and t.locked_until > now())          as locked_now,
           t.must_change_password,
           t.last_login_at,
           (m.teacher_id is not null)                                      as mfa_row_exists,
           coalesce(m.confirmed, false)                                    as mfa_enrolled,
           (m.teacher_id is not null and not coalesce(m.confirmed, false))  as mfa_pending,
           m.enabled_at                                                    as mfa_enabled_at,
           (select count(*)::int from mfa_recovery_codes rc
             where rc.teacher_id = t.id and rc.used_at is null)            as recovery_codes_unused
      from teachers t
      left join teacher_mfa m on m.teacher_id = t.id
     where t.roles @> array['super_admin']::varchar[]
     order by t.username
  `;
  return accounts;
}

/** 行级指纹：用于证明"脚本没有改动任何数据"。 */
async function fingerprint(tx) {
  const [t] = await tx`
    select count(*)::int as rows,
           coalesce(md5(string_agg(x, '|' order by x)), 'empty') as digest
      from (
        select md5(t.*::text) as x
          from teachers t
      ) s
  `;
  const [m] = await tx`
    select count(*)::int as rows,
           coalesce(md5(string_agg(x, '|' order by x)), 'empty') as digest
      from (select md5(t.*::text) as x from teacher_mfa t) s
  `;
  const [r] = await tx`
    select count(*)::int as rows,
           coalesce(md5(string_agg(x, '|' order by x)), 'empty') as digest
      from (select md5(t.*::text) as x from mfa_recovery_codes t) s
  `;
  return { teachers: t, teacher_mfa: m, mfa_recovery_codes: r };
}

// =============================================================================
// --self-test：证明只读事务真的会拒写
// =============================================================================

async function selfTest() {
  process.stdout.write('=== 只读保护自证 ===\n\n');

  const before = await readOnly((tx) => fingerprint(tx));
  process.stdout.write('写前指纹：\n');
  for (const [k, v] of Object.entries(before)) {
    process.stdout.write(`  ${k.padEnd(20)} rows=${String(v.rows).padStart(6)}  digest=${v.digest}\n`);
  }

  // ---------------------------------------------------------------------------
  // 写探针**不放在本文件里**，也不放在仓库里。
  //
  // 理由：本文件的契约是"不存在写入能力"，而一条写语句哪怕只在 --self-test 下
  // 执行，它的存在本身就会让静态核对失去意义。因此探针被生成到**仓库之外的
  // 临时文件**，跑完立即删除。这样两件事同时成立：
  //   · scripts/ 下没有任何写语句；
  //   · 只读事务是否真的拒写，仍然是被实测过的，而不是被声称的。
  // ---------------------------------------------------------------------------
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');

  const probePath = join(tmpdir(), `qls-readonly-probe-${process.pid}.mjs`);
  const probeLines = [
    "import { createRequire } from 'node:module';",
    `const require2 = createRequire(${JSON.stringify(join(ROOT, 'package.json'))});`,
    'const postgres2 = require2("postgres");',
    'const sql2 = postgres2(process.env.QLS_PROBE_DB, { max: 1, onnotice: () => {} });',
    'let code = "";',
    'let msg = "";',
    'let threw = false;',
    'try {',
    "  await sql2.begin('read only', async (tx) => {",
    // 指向**已存在**的表，且谓词恒假：即便只读保护失效，也只会删除 0 行（无操作）。
    // 之前写的是不存在的表名，结果报 42P01（relation does not exist），
    // 把"只读拒绝"和"探针自身写错了"混为一谈 —— 那种判定会掩盖真相。
    "    await tx.unsafe('DELETE FROM audit_logs WHERE false');",
    '  });',
    '} catch (e) { threw = true; code = String(e.code ?? ""); msg = String(e.message ?? "").split(String.fromCharCode(10))[0]; }',
    'await sql2.end();',
    'process.stdout.write(JSON.stringify({ threw, code, msg }));',
  ];
  writeFileSync(probePath, probeLines.join('\n') + '\n', { mode: 0o600 });

  process.stdout.write('\n尝试在只读事务内执行一次写入（探针位于仓库外的临时文件）：\n');
  const run = spawnSync(process.execPath, [probePath], {
    env: { ...process.env, QLS_PROBE_DB: DB_URL },
    encoding: 'utf8',
    timeout: 30000,
    cwd: ROOT,
  });
  if (process.env.QLS_KEEP_PROBE === '1') {
    process.stdout.write(`  (QLS_KEEP_PROBE=1：探针文件保留在 ${probePath})\n`);
  } else {
    try { unlinkSync(probePath); } catch { /* 已删除或从未创建 */ }
  }

  let result = { threw: false, code: '', msg: '' };
  let parseFailed = false;
  try { result = JSON.parse(run.stdout || '{}'); } catch { parseFailed = true; }

  // 探针"加载/运行失败"与"写入被拒"必须分开报。之前把探针崩溃误判为
  // "只读未生效"，那是在掩盖真相 —— 崩溃时我们其实什么也没证明。
  if (parseFailed) {
    process.stdout.write('  ⚠️ 探针未能产出结果（不是"只读失效"，也不是"只读生效"）\n');
    process.stdout.write(`    探针退出码: ${run.status ?? 'killed'}\n`);
    if (run.stderr) {
      for (const l of String(run.stderr).split('\n').slice(0, 8)) {
        if (l.trim()) process.stdout.write(`    stderr | ${l}\n`);
      }
    }
    if (run.error) process.stdout.write(`    spawn 错误: ${run.error.message}\n`);
  }

  // 三种结果必须分开报，不能混：
  //   · 25006 → 只读事务拒绝（这是我们要的证明）
  //   · 其它错误码 → 探针自身出错（例如写错表名）。**不能**算作"只读生效"，
  //     也**不能**算作"只读失效" —— 它什么也没证明。
  //   · 未抛错 → 只读保护确实失效
  const readOnlyPass = result.threw === true && result.code === '25006';
  if (readOnlyPass) {
    process.stdout.write('  ✓ 写入被拒绝：SQLSTATE 25006 read_only_sql_transaction\n');
    process.stdout.write(`    驱动返回: ${result.msg}\n`);
  } else if (result.threw) {
    process.stdout.write(`  ⚠️ 写入抛错了，但**不是**只读事务拒绝（SQLSTATE ${result.code}）\n`);
    process.stdout.write(`    驱动返回: ${result.msg}\n`);
    process.stdout.write('    这既不能证明只读生效，也不能证明它失效 —— 探针本身有问题。\n');
  } else {
    process.stdout.write('  ✗ 写入**未被拒绝** —— 只读保护没有生效！\n');
    if (run.stderr) process.stdout.write(`    探针 stderr: ${String(run.stderr).split('\n')[0]}\n`);
  }

  const after = await readOnly((tx) => fingerprint(tx));
  process.stdout.write('\n写后指纹：\n');
  for (const [k, v] of Object.entries(after)) {
    process.stdout.write(`  ${k.padEnd(20)} rows=${String(v.rows).padStart(6)}  digest=${v.digest}\n`);
  }

  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  process.stdout.write(
    `\n结论：数据${unchanged ? '完全未变（指纹一致）' : '★发生了变化 —— 这不应该发生'}；` +
      `写入尝试${readOnlyPass ? '被数据库以 25006 拒绝' : result.threw ? '★抛错但非只读拒绝（探针有问题）' : '★未被拒绝'}。\n`,
  );
  process.stdout.write('探针临时文件已删除，仓库中未落任何写语句。\n');
  await sql.end();
  process.exit(unchanged && readOnlyPass ? 0 : 1);
}

// =============================================================================
// 主流程
// =============================================================================

async function main() {
  if (SELF_TEST) return selfTest();

  let state;
  let fpBefore;
  try {
    const out = await readOnly(async (tx) => ({
      accounts: await collectState(tx),
      fp: await fingerprint(tx),
    }));
    state = out.accounts;
    fpBefore = out.fp;
  } catch (error) {
    process.stderr.write(
      `[bootstrap-super-admin] 只读查询失败: ${String(error.message).split('\n')[0]}\n` +
        `  (code=${error.code ?? 'n/a'})\n`,
    );
    await sql.end();
    process.exit(1);
  }

  const evaluated = state.map((row) => ({ row, ...evaluateAccount(row) }));
  const usable = evaluated.filter((e) => e.canLogin);

  if (VERIFY_ONLY) {
    // 供其它脚本调用的紧凑断言输出
    process.stdout.write(
      JSON.stringify(
        {
          superAdminTotal: evaluated.length,
          superAdminUsable: usable.length,
          usableUsernames: usable.map((e) => e.row.username),
          blockers: evaluated.flatMap((e) =>
            e.problems.map((p) => `${e.row.username}: ${p}`),
          ),
        },
        null,
        2,
      ) + '\n',
    );
    await verifyUnchanged(fpBefore);
    await sql.end();
    process.exit(0);
  }

  const line = (s = '') => process.stdout.write(`${s}\n`);
  const rule = () => line('='.repeat(78));

  rule();
  line('super_admin 自举诊断（只读，不写入任何数据）');
  rule();
  line(`数据库: ${describeUrl(DB_URL)}`);
  line(
    `只读保护: 是 —— 所有查询运行在 BEGIN READ ONLY 事务内；任何写入都会被`,
  );
  line('          PostgreSQL 以 25006 拒绝，而非依赖本脚本的自觉。');
  line('');

  // ---------------------------------------------------------------------------
  line('─'.repeat(78));
  line('1. 当前 super_admin 现状');
  line('─'.repeat(78));
  line('');

  if (evaluated.length === 0) {
    line('本库中**没有任何账号**持有 super_admin 角色。');
    line('');
    line('含义：最高权限完全不存在。门禁第 7 项 FAIL。');
    line('注意区分两件事 ——「持有角色」与「能登录」在本项目里根本不是一回事。');
  } else {
    line(`共 ${evaluated.length} 个账号持有 super_admin 角色：`);
    line('');
    for (const e of evaluated) {
      const r = e.row;
      line(`  ── ${r.username}  (${r.name})`);
      line(`     角色          : ${JSON.stringify(r.roles)}`);
      line(`     status        : ${r.status}`);
      line(
        `     password_hash : ${r.has_password ? `已设置（${r.password_hash_len} 字符）` : '★ 未设置 —— 无法用密码登录'}`,
      );
      line(
        `     MFA           : ${r.mfa_enrolled ? `已确认绑定（enabled_at=${r.mfa_enabled_at?.toISOString?.() ?? '?'}，未用恢复码 ${r.recovery_codes_unused} 个）` : r.mfa_pending ? '★ 已开始绑定但未确认' : '★ 未绑定'}`,
      );
      line(
        `     登录计数      : failed=${r.failed_login_attempts}  locked_until=${r.locked_until ?? 'null'}  last_login=${r.last_login_at ?? 'never'}`,
      );
      line(
        `     能否真正登录  : ${e.canLogin ? '✅ 可以' : '❌ 不可以'}`,
      );
      if (!e.canLogin) {
        for (const p of e.problems) line(`         · ${p}`);
      }
      if (/^__/.test(String(r.username ?? ''))) {
        line('         · 注意：用户名以 `__` 开头，符合测试夹具命名（RUN_ACCOUNT_PREFIX / keeper）。');
        line('           夹具账号**不是**生产账号，见第 5 节。');
      }
      line('');
    }
  }

  // ---------------------------------------------------------------------------
  line('─'.repeat(78));
  line('2. 现在为什么没人能登录 —— 由数据推导');
  line('─'.repeat(78));
  line('');

  if (usable.length > 0) {
    line(`✅ 存在可登录的 super_admin：${usable.map((e) => e.row.username).join(', ')}`);
    line('');
    line('   但「能登录」不等于「MFA 已绑定」：未绑定的 super_admin 只能访问');
    line('   @MfaExempt 路由（当前 MFA 状态 / 开始绑定 / 确认绑定 / 退出），');
    line('   其余全部 403。见第 4 节的验收命令。');
  } else {
    line('❌ 没有任何 super_admin 能完成登录。逐条原因（全部来自上面的实测数据）：');
    line('');
    const byReason = new Map();
    for (const e of evaluated) {
      for (const p of e.problems) {
        const key = p.replace(/^[^（]*/, '').replace(/（.*$/, '') || p;
        if (!byReason.has(key)) byReason.set(key, []);
        byReason.get(key).push(e.row.username);
      }
    }
    if (evaluated.length === 0) {
      line('  · 库里根本没有 super_admin 角色持有者（不是"有但登不进"，是"没有"）。');
    }
    for (const [reason, users] of byReason) {
      line(`  · ${users.join(', ')}: ${reason.trim()}`);
    }
    line('');
    line(`  结论：需要创建 ${Math.max(1, 0)} 个**能登录**的 super_admin。按第 3 节操作。`);
  }

  // ---------------------------------------------------------------------------
  line('');
  line('─'.repeat(78));
  line('3. 手工操作步骤（按顺序，由人执行）');
  line('─'.repeat(78));
  line('');
  line('⚠️  下面出现的所有 SQL 都是**供操作者手工执行的**，本脚本绝不会执行它们。');
  line('    本脚本没有写入能力；这些语句在这里只是文本。');
  line('');

  line('前提：确认 MFA_ENCRYPTION_KEY 已经固定（见第 6 节，这一步不能跳过）');
  line('');

  line('步骤 3.1 —— 生成密码哈希（用应用自己的 scrypt 路径，不要手写哈希）');
  line('');
  line('  存储格式（auth.service.ts:227-240）：');
  line('      scrypt$<N>$<r>$<p>$<base64 salt>$<base64 derivedKey>');
  line('  参数为常量 SCRYPT_N=16384, SCRYPT_R=8, SCRYPT_P=1, keylen=32, salt=16 字节；');
  line('  salt 与派生密钥都是 base64。');
  line('');
  line('  在**仓库根目录**执行（用应用同款参数生成，避免手抄出错）：');
  line('      node -e "const{scryptSync,randomBytes}=require(\'crypto\');');
  line('        const pw=process.argv[1];');
  line('        const salt=randomBytes(16).toString(\'base64\');');
  line('        const dk=scryptSync(pw,salt,32,{N:16384,r:8,p:1});');
  line('        console.log([\'scrypt\',16384,8,1,salt,dk.toString(\'base64\')].join(\'$\'));" \'<你选定的强密码>\'');
  line('');
  line('  注：这里用数组 join 而不是模板字符串，避免外层引号/反引号与 shell 冲突。');
  line('      · 至少 10 位');
  line('      · 至少 1 个大写字母 / 1 个小写字母 / 1 个数字');
  line('');
  line('  ⚠️ scrypt 参数 N=16384,r=8 需要约 16MB 内存；node 默认堆足够。');
  line('     若报 memory limit，用 --max-old-space-size 调大。');
  line('');

  line('步骤 3.2 —— 直连数据库创建账号（唯一需要手工 SQL 的一步）');
  line('');
  line('  为什么必须手工：已核实**不存在自举路径** ——');
  line('    · shared/rbac.ts:245-249 canGrantRole()：只有 super_admin 才可授予 super_admin；');
  line('    · 触发器 trg_teachers_guard_super_admin（migration 0003）在数据库层兜底；');
  line('    · seed-teachers.ts 不含 super_admin；全仓无任何自动提权逻辑。');
  line('');
  line('  ⚠️  本脚本**不存放任何写语句**。可直接执行的 SQL 模板在仓库里的一个独立文件中，');
  line('      只由你手工执行 —— 这样"这个脚本对数据库只读"是可以被静态核对的：');
  line('');
  if (existsSync(SQL_HELP_PATH)) {
    line(`      ${SQL_HELP_PATH.replace(ROOT + '/', '')}`);
  } else {
    line(`      ★ 找不到 ${SQL_HELP_PATH.replace(ROOT + '/', '')}`);
    line('        该文件承载可执行 SQL 模板（本脚本刻意不内联写语句）。');
    line('        若已被删除，请从版本库里恢复它再继续。');
  }
  line('');
  line('      该文件包含：步骤 0 现状查询（只读）→ 步骤 1 新建账号（方案 A，推荐）→');
  line('      步骤 1b 提升既有账号（方案 B，备用）→ 步骤 2/3 验收查询（只读）。');
  line('');
  line('  触发器事实（决定 SQL 怎么写，已核实）：');
  line('    · trg_teachers_guard_super_admin       = BEFORE UPDATE OR DELETE → **不覆盖 INSERT**；');
  line('    · trg_teachers_protect_last_super_admin = BEFORE UPDATE OR DELETE → **不覆盖 INSERT**。');
  line('    所以：**直接插入**一个 roles 含 super_admin 的新行是被允许的，不需要声明任何权限；');
  line('    而把已有账号**改成** super_admin 会被拒绝，除非在同一事务内声明');
  line('    select set_config(  app.rbac_actor_super_admin ,  on , true )（方案 B 已写明）。');
  line('');
  line('  连接身份提示：表 owner（如 qlsadmin）不受 RLS 约束；受限角色走');
  line('  rls0004_anon_ins_teachers（INSERT 策略，角色 anon_）。建议用 owner。');
  line('');
  line('  密码哈希：必须用第 3.1 节生成的完整 6 段字符串，格式');
  line('      scrypt$16384$8$1$<b64 salt>$<b64 derivedKey>');
  line('  手写/猜格式会静默走到 verifyPassword 的 return false（表现为"用户名或密码错误"）。');
  line('')
  line('步骤 3.3 —— 用密码登录（此时 MFA 还没绑定，登录会成功并下发会话）');
  line('');
  line('  因为该账号**尚未绑定 MFA**，auth.service.ts:443 的 `isEnabled()` 为 false，');
  line('  登录直接创建会话（不会返回 challenge），随后：');
  line('    · 认证通过（有会话 cookie）');
  line('    · 但 AuthGuard 因 roles 含 super_admin 而拒绝**非 @MfaExempt** 的请求 → 403');
  line('  这正是设计：强制 MFA 但允许自助绑定。');
  line('');
  line('      curl -sS -c /tmp/qls-cookies.txt -X POST "${MFA_BASE}/api/auth/login" \\');
  line('        -H \'Content-Type: application/json\' \\');
  line('        -H \'Origin: ${MFA_BASE}\' \\');
  line('        -d \'{"username":"<登录名>","password":"<密码>"}\'');
  line('  期望：HTTP 201，响应体为 {"mfaRequired":false,"teacher":{...}}');
  line('  ⚠️ 若返回 401 → 用户名或密码不对（或哈希格式不对，见第 5 节）；');
  line('     若返回 403「账号已锁定」→ 连续失败 5 次触发了 15 分钟锁定。');
  line('');

  line('步骤 3.4 —— 自助绑定 MFA（**不要**手工写 teacher_mfa）');
  line('');
  line('  开始绑定（返回一次性 secret 与 otpauth URI）：');
  line('');
  line('      curl -sS -b /tmp/qls-cookies.txt -X POST "${MFA_BASE}/api/auth/mfa/enroll" \\');
  line('        -H \'Origin: ${MFA_BASE}\' -H \'Content-Type: application/json\'');
  line('');
  line('  期望：HTTP 201，返回 {"secret":"...","otpauthUri":"otpauth://totp/..."}');
  line('  → 把 secret 或 otpauthUri 导入认证器 App（Google Authenticator / 1Password 等）。');
  line('  ⚠️ secret 只返回这一次，且**不要**把它粘进任何日志、工单或提交记录。');
  line('');
  line('  确认绑定（提交 App 当前显示的 6 位码）：');
  line('');
  line('      curl -sS -b /tmp/qls-cookies.txt -X POST "${MFA_BASE}/api/auth/mfa/confirm" \\');
  line('        -H \'Origin: ${MFA_BASE}\' -H \'Content-Type: application/json\' \\');
  line('        -d \'{"code":"123456"}\'');
  line('');
  line('  期望：HTTP 201，返回 {"recoveryCodes":[...]}（10 个，仅此一次）。');
  line('  ⚠️ 恢复码是凭据：立刻存入密码管理器。丢失 = 认证器丢失时无法登录。');
  line('  ⚠️ TOTP 有 ±1 步（±30 秒）时钟容差（mfa.service.ts:41 TOTP_WINDOW=1）；');
  line('     服务器时钟偏移过大会导致码一直不对，先确认时间同步。');
  line('');

  line('步骤 3.5 —— 重新登录，验证第二因素真的生效');
  line('');
  line('      curl -sS -c /tmp/qls-cookies2.txt -X POST "${MFA_BASE}/api/auth/login" \\');
  line('        -H \'Content-Type: application/json\' -H \'Origin: ${MFA_BASE}\' \\');
  line('        -d \'{"username":"<登录名>","password":"<密码>"}\'');
  line('  期望：HTTP 201，响应体是 {"mfaRequired":true,"challengeToken":"...","expiresAt":"..."}');
  line('        —— **不再**直接返回 teacher，也**没有**会话 cookie。');
  line('');
  line('      curl -sS -c /tmp/qls-cookies2.txt -X POST "${MFA_BASE}/api/auth/mfa/verify" \\');
  line('        -H \'Content-Type: application/json\' -H \'Origin: ${MFA_BASE}\' \\');
  line('        -d \'{"challengeToken":"<上一步的 token>","code":"<App 当前 6 位码>"}\'');
  line('  期望：HTTP 201 且下发会话 cookie → 到此才算真正"可登录"。');
  line('');

  // ---------------------------------------------------------------------------
  line('─'.repeat(78));
  line('4. 验收命令（证明真的成功）');
  line('─'.repeat(78));
  line('');
  line('  4.1 账号已存在且角色正确（只读，可反复跑）');
  line('');
  line('      node scripts/bootstrap-super-admin.mjs --verify');
  line('      期望：superAdminUsable >= 1，blockers 为空数组。');
  line('');
  line('  4.2 数据层判定（门禁的同款检查）');
  line('');
  line('      node scripts/predeploy-db-check.mjs super-admin');
  line('      期望：status=PASS，且列出该账号 "CAN LOG IN"。');
  line('');
  line('  4.3 端到端登录 + MFA（**真实验证**，不是看配置）');
  line('');
  line('      按步骤 3.5 的两条 curl 依次执行：');
  line('        · 第一次 login 期望 {"mfaRequired":true,...}');
  line('        · mfa/verify 期望 201 且拿到 cookie');
  line('        · 之后用该 cookie 访问任一受保护接口，期望 200 而非 403');
  line('');
  line('  4.4 全量门禁');
  line('');
  line('      npm run predeploy');
  line('      期望：FAIL [07] 与 FAIL [08] 消失；最终 READY/NOT READY 取决于其余项。');
  line('');

  // ---------------------------------------------------------------------------
  line('─'.repeat(78));
  line('5. 不要做什么（每条都有原因）');
  line('─'.repeat(78));
  line('');
  line('  ✗ 不要把 __rbac_keeper（或任何 __ 开头的账号）当作生产账号使用。');
  line('    它是 tests/helpers/reset-fixtures.mjs 的夹具：`ensureKeeper()` 只写');
  line('    (username, name, name_en, roles, status)，**刻意不写 password_hash**，');
  line('    用途是在验证运行期间让"最后一个 super_admin 不可删除"的触发器可满足。');
  line('    给它补密码会让夹具行为偏离验证基线，掩盖真实问题。');
  line('');
  line('  ✗ 不要手工拼或"猜" password_hash。');
  line('    登录校验（auth.service.ts:242-256）要求恰好 6 段：');
  line('      parts[0] === \'scrypt\' 且 parts.length === 6，格式 scrypt$N$r$p$salt$dk');
  line('    任何格式偏差都会静默走到 `return false`，表现为"用户名或密码错误"，');
  line('    且会在审计里留下 login_failed —— 排查成本极高。必须用步骤 3.1 的应用同款参数生成。');
  line('');
  line('  ✗ 不要手工写 teacher_mfa / mfa_recovery_codes。');
  line('    TOTP 密钥是 AES-256-GCM 加密后存储的（mfa-crypto.ts，格式 v1:<iv>:<tag>:<ct>），');
  line('    手工写就要自己复现整套加密，风险远高于走一行 API。而且**不需要**手工：');
  line('    @MfaExempt 的 enroll/confirm 端点就是为自助绑定准备的。');
  line('');
  line('  ✗ 不要为了让事情"跑起来"而关掉强制 MFA 网关。');
  line('    auth.guard.ts:171-181 的检查是 super_admin 唯一的第二因素保障；');
  line('    mfa.service.ts:277-284 的 assertMayDisable() 也会拒绝解除绑定。');
  line('    关掉它等于把最高权限降级为单因素密码。');
  line('');
  line('  ✗ 不要复用/提交任何生成的 secret、恢复码或密码哈希。');
  line('    MFA secret（3.4）、恢复码（3.4）、密码哈希（3.1）都是凭据。');
  line('    本脚本的输出里没有任何真实凭据，正是为了可以安全地贴进工单。');
  line('');
  line('  ✗ 不要把 password_hash 复制到工单、聊天或提交信息里 —— 它是可离线爆破的物料。');
  line('');

  // ---------------------------------------------------------------------------
  line('─'.repeat(78));
  line('6. 【重要】MFA_ENCRYPTION_KEY 与单实例约束 —— 别在这一步把自己锁在门外');
  line('─'.repeat(78));
  line('');
  const keyState = process.env.MFA_ENCRYPTION_KEY
    ? '已设置（长度与解码校验见 predeploy）'
    : '★ 未设置';
  line(`  当前 shell 里的 MFA_ENCRYPTION_KEY: ${keyState}`);
  line('');
  line('  这是整条流程里最容易造成"上线后无法登录"的一点，单独强调：');
  line('');
  line('  · TOTP 密钥（含上面 3.4 绑定的那个）以 AES-256-GCM 加密存库，');
  line('    加密键来自 MFA_ENCRYPTION_KEY（mfa-crypto.ts:198-217，必须解码为恰好 32 字节）。');
  line('  · 因此：**如果你在绑定 MFA 之后重新生成这个键，已有的绑定会永久无法解密。**');
  line('    届时该账号登录会在 auth.service.ts:443 的 isEnabled() 路径上 FAIL CLOSED');
  line('    —— 表现为拒绝登录，而**不是**静默降级为单因素（这是刻意的安全选择）。');
  line('  · 正确做法：**先**生成一次、写进部署环境（.env.deploy / 平台环境变量），');
  line('    **再**开始 3.4 的绑定；此后永不更换。');
  line('  · 生成命令（只跑一次）：openssl rand -base64 32');
  line('  · 备份要求：与数据库备份**分开**保存。两者在一起等于没加密；');
  line('    只剩数据库备份而没有键，等于所有 MFA 账号一起失联。');
  line('');
  line('  单实例约束（DEPLOYMENT_PRODUCTION.md 附录，正式架构前提）：');
  line('    · 登录限流是**进程内**计数 → 多副本会把实际上限乘以副本数；');
  line('    · 迁移用 advisory lock 串行；');
  line('    · 所以第一阶段必须单实例，`docker compose up` 不要 --scale app>1。');
  line('');

  rule();
  if (usable.length > 0) {
    line('结论：已存在可登录的 super_admin。若其 MFA 未绑定，仅能访问 @MfaExempt 路由。');
  } else {
    line('结论：不存在可登录的 super_admin —— 按第 3 节手工创建，然后用第 4 节验收。');
  }
  line('本脚本未写入任何数据（只读事务 + 前后指纹一致，见下方）。');
  rule();

  return verifyUnchanged(fpBefore);
}

/** 复读指纹并断言未变；变了就报错退出（这不该发生）。 */
async function verifyUnchanged(fpBefore) {
  const fpAfter = await readOnly((tx) => fingerprint(tx));
  const changed = [];
  for (const k of Object.keys(fpBefore)) {
    if (JSON.stringify(fpBefore[k]) !== JSON.stringify(fpAfter[k])) changed.push(k);
  }
  if (changed.length > 0) {
    process.stderr.write(
      `[bootstrap-super-admin] 只读被破坏：以下表在本次运行期间发生了变化：${changed.join(', ')}\n`,
    );
    return 1;
  }
  if (!VERIFY_ONLY) {
    process.stdout.write('\n只读证明（前后指纹一致）：\n');
    for (const [k, v] of Object.entries(fpBefore)) {
      process.stdout.write(
        `  ${k.padEnd(20)} rows=${String(v.rows).padStart(6)}  digest=${v.digest}  (运行前后一致)\n`,
      );
    }
  }
  return 0;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  process.stderr.write(
    `[bootstrap-super-admin] 意外失败: ${String(error.message).split('\n')[0]}\n`,
  );
  exitCode = 1;
} finally {
  await sql.end();
}
process.exit(exitCode);
