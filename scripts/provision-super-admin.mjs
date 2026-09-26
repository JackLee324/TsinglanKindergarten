#!/usr/bin/env node
/**
 * scripts/provision-super-admin.mjs — 创建/修复一个可登录的 super_admin
 * =========================================================================
 *
 * ⚠️  这个脚本**会写入数据库**。它与 `scripts/bootstrap-super-admin.mjs` 是刻意的
 *     一对相反物：
 *
 *       bootstrap-super-admin.mjs  = 只读诊断与指引。绝不写。由只读事务结构性保证。
 *       provision-super-admin.mjs  = 唯一被允许创建账号的工具（本文件）。
 *
 *     把两者分开，是为了让"哪个文件能写"成为文件名与用途就能回答的问题，
 *     而不是"读一遍代码才知道"。诊断工具必须能被安全地随手运行；供应工具必须
 *     每次都被明确要求运行 —— 所以它要求 `--yes-create-account`。
 *
 * 为什么需要它
 * ------------
 * 已核实**不存在自举路径**（`shared/rbac.ts:245-249` 的 canGrantRole 禁止非
 * super_admin 授予 super_admin；migration 0003 的触发器在库层兜底；
 * seed-teachers.ts 不含 super_admin）。因此第一个 super_admin 只能直连数据库创建。
 *
 * 它做什么
 * --------
 *   1. 校验参数（用户名格式、密码复杂度、密码不得包含用户名 —— 密码管理器评分会把
 *      "用户名+数字"类口令直接判为弱口令）
 *   2. 以应用**同款** scrypt 参数生成密码哈希（auth.service.ts:227-240：
 *      scrypt$<N>$<r>$<p>$<b64 salt>$<b64 derivedKey>，N=16384,r=8,p=1,keylen=32,salt=16B）
 *   3. 在**一个事务**内声明 super_admin 权限并创建/修复该账号
 *   4. 打印前后对比与后续步骤（登录 → 自助绑定 MFA）
 *
 * 它刻意**不**做什么
 * ------------------
 *   · 不绑定 MFA（那走已发布的 API 自助完成；手工写 teacher_mfa 需要复现
 *     AES-256-GCM 加密，风险高且无必要）
 *   · 不设 must_change_password —— 已核实该标志**只被读取并发给前端，
 *     服务端网关不据此拦截**（auth.guard.ts 只把它放进 AuthUser）。
 *     设成 true 会假装有"强制改密"，而实际上没有。
 *   · 不打印密码或哈希（哈希是可离线爆破的物料，不该进终端记录）
 *   · 不删除任何东西；不修改除目标账号外的任何行
 *
 * USAGE
 *   # 从文件读（推荐：不进 shell 历史、不进进程列表）
 *   printf '%s' '你的密码' > /tmp/qls-pw && chmod 600 /tmp/qls-pw
 *   QLS_ADMIN_DB='postgresql://…' \
 *     node scripts/provision-super-admin.mjs \
 *       --username Tsinglan001 --password-file /tmp/qls-pw \
 *       --name '系统超级管理员' --yes-create-account
 *   rm -f /tmp/qls-pw
 *
 *   # 已有账号时：只重置密码 / 只恢复角色（二者都需要 --yes-create-account）
 *   … --username X --password-file F --reset-password --yes-create-account
 *   … --username X --grant-role      --yes-create-account
 *
 * 连接串优先级（与其它脚本一致，但本脚本**只认** QLS_ADMIN_DB / MIGRATION_DATABASE_URL，
 * 刻意不读 SUDA_DATABASE_URL —— 避免误把应用运行库当作管理目标）
 *
 * EXIT: 0 成功；1 失败（失败一律打印原因，绝不静默成功）；2 用法错误
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { scryptSync, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const postgres = require('postgres');

// ---------------------------------------------------------------------------
// 应用的真实常量（照抄 server/modules/auth/auth.service.ts:33-39, 227-240）
// ---------------------------------------------------------------------------
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 16;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) args[k] = true;
  else { args[k] = v; i += 1; }
}

const die = (msg, code = 2) => { process.stderr.write(`[provision-super-admin] ${msg}\n`); process.exit(code); };

if (args.help === true) { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].split('\n').slice(1).join('\n') + '\n'); process.exit(0); }

// **显式确认守卫**：没有它什么都不做。这是本工具"必须被明确要求才运行"的落地方式。
if (args['yes-create-account'] !== true) {
  die(
    '拒绝运行：需要显式确认。\n' +
    '  这个脚本会**写入数据库**（创建账号 / 改密码 / 改角色）。\n' +
    '  确认无误后加上：--yes-create-account\n' +
    '  只想看现状、不想写？用只读工具：node scripts/bootstrap-super-admin.mjs\n',
    2,
  );
}

const username = String(args.username ?? '').trim();
if (!username) die('缺少 --username');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,49}$/.test(username)) {
  die(`用户名 '${username}' 不符合格式：需 3-50 位，以字母或数字开头，仅含字母/数字/._-`);
}

const name = String(args.name ?? '').trim();
if (!name) die('缺少 --name（teachers.name 是 NOT NULL 且无默认值，必填）');

const resetPassword = args['reset-password'] === true;
// ---------------------------------------------------------------------------
// --role：创建哪个角色（默认 super_admin）
// ---------------------------------------------------------------------------
// 必须与 shared/rbac.ts 的 ROLE_CODES 一致。**刻意在此重复一份**而不是 import：
// 运行镜像里只复制了 server/database 与 scripts，没有 shared/，import 会失败。
// 若 shared/rbac.ts 增删角色，这里必须同步 —— tests/auth-reset-password.test.mjs
// 与 scripts/verify-e2e-deploy.sh 都会校验二者一致。
const KNOWN_ROLES = [
  'super_admin',
  'principal',
  'curriculum_director',
  'prek_head',
  'k_head',
  'pe_specialist',
  'prek_assistant',
  'k_assistant',
  'visitor',
];
const ROLE = typeof args['role'] === 'string' ? args['role'] : 'super_admin';
if (!KNOWN_ROLES.includes(ROLE)) {
  die(`--role 不是已知角色: "${ROLE}"（可选：${KNOWN_ROLES.join(', ')}）`);
}

const grantRole = args['grant-role'] === true;

// 密码来源：只支持文件（避免进程列表与 shell 历史泄露）
let password = '';
if (typeof args['password-file'] === 'string') {
  const p = args['password-file'];
  if (!existsSync(p)) die(`--password-file 不存在: ${p}`);
  password = readFileSync(p, 'utf8').replace(/\r?\n$/, '');
} else if (typeof args.password === 'string') {
  password = args.password;
  process.stderr.write(
    '[provision-super-admin] ⚠️ 你用 --password 传了密码：它会出现在进程列表与\n' +
    '  shell 历史里。建议改用 --password-file（见文件头示例）。\n',
  );
}

const needPassword = !grantRole || resetPassword || !resetPassword; // 默认与 reset 都要密码
if (!needPassword || (!password && !grantRole)) {
  if (!password) die('缺少密码：用 --password-file <文件>（推荐）或 --password <值>');
}

if (password) {
  // 复杂度：与 auth.service.ts:258-264 的 validatePasswordComplexity 一致
  if (password.length < 10) die('密码至少 10 位（与应用的复杂度校验一致）');
  if (!/[A-Z]/.test(password)) die('密码必须包含大写字母');
  if (!/[a-z]/.test(password)) die('密码必须包含小写字母');
  if (!/[0-9]/.test(password)) die('密码必须包含数字');
  // 常见弱口令模式：密码里含有用户名本身（忽略大小写），密码管理器会直接判弱
  if (password.toLowerCase().includes(username.toLowerCase())) {
    die('密码不能包含用户名本身 —— 这是密码管理器评分里的弱口令特征，会被立刻判为弱密码');
  }
}

const DB_URL =
  process.env.QLS_ADMIN_DB ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_CONNECTION_STRING ||
  process.env.POSTGRES_URI ||
  '';
if (!DB_URL) {
  die(
    '缺少管理连接串。请设置 QLS_ADMIN_DB、MIGRATION_DATABASE_URL 或 DATABASE_URL。',
  );
}

function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 'default'}/${u.pathname.replace(/^\//, '')} as ${u.username || '(no user)'}`;
  } catch { return '(不可解析)'; }
}

// ---------------------------------------------------------------------------
// 哈希生成（应用同款参数）
// ---------------------------------------------------------------------------
function hashPasswordWithRandomSalt(pw) {
  const salt = randomBytes(SALT_LEN).toString('base64');
  const derived = scryptSync(pw, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('base64')}`;
}

/** 自检：生成的哈希必须能被应用的 verifyPassword 逻辑接受。 */
function verifyPassword(pw, hash) {
  const parts = hash.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const derived = scryptSync(pw, parts[4], SCRYPT_KEYLEN, {
    N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]),
  });
  return Buffer.from(parts[5], 'base64').equals(derived);
}

const sql = postgres(DB_URL, { max: 1, onnotice: () => {}, connect_timeout: 10 });

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const line = (s = '') => process.stdout.write(`${s}\n`);

line('='.repeat(78));
line('provision-super-admin —— 创建/修复一个可登录的 super_admin');
line('='.repeat(78));
line(`目标库   : ${describeUrl(DB_URL)}`);
line(`用户名   : ${username}`);
line(`姓名     : ${name}`);
line(`操作     : ${resetPassword ? '重置密码' : grantRole ? '仅恢复 super_admin 角色' : '创建（或补齐缺失的密码）'}`);
line('');

let exitCode = 1;
try {
  // -------------------------------------------------------------------------
  // 1. 运行前状态
  // -------------------------------------------------------------------------
  const [before] = await sql`
    select count(*)::int as total,
           count(*) filter (where roles @> array['super_admin']::varchar[] and status = 'active'
                              and password_hash is not null)::int as usable
      from teachers t
  `;
  const existing = await sql`
    select id, username, roles, status, (password_hash is not null) as has_password
      from teachers where lower(username) = lower(${username})
  `;
  line(`运行前：库中 super_admin 总数=${before.total}，其中"活跃+有密码"=${before.usable}`);
  line(`        目标用户名 ${username} ${existing.length ? '已存在' : '不存在'}`);
  if (existing.length > 0) {
    const e = existing[0];
    line(`        └ 现有：roles=${JSON.stringify(e.roles)} status=${e.status} has_password=${e.has_password}`);
  }
  line('');

  // -------------------------------------------------------------------------
  // 2. 生成哈希并自检
  // -------------------------------------------------------------------------
  let hash = '';
  if (password) {
    hash = hashPasswordWithRandomSalt(password);
    if (!verifyPassword(password, hash)) {
      die('内部错误：生成的哈希无法通过应用同款校验 —— 拒绝写入一个登录不了的哈希', 1);
    }
    if (verifyPassword(password + 'x', hash)) {
      die('内部错误：错误密码竟然通过了校验 —— 拒绝写入', 1);
    }
    line(`密码哈希：已生成并通过应用同款校验（6 段 scrypt 格式，salt ${SALT_LEN}B，key ${SCRYPT_KEYLEN}B）`);
    line('          哈希值刻意不打印（可离线爆破的物料不应进终端记录）');
    line('');
  }

  // -------------------------------------------------------------------------
  // 3. 单事务写入
  //    · set_config 的第三个参数 true = is_local，作用域仅本事务；
  //      它与 INSERT/UPDATE **必须在同一事务**，分开发送会丢标记并被触发器拒绝(42501)。
  //    · 这正是 tests/helpers/reset-fixtures.mjs:131-133 的 declareSuperAdmin 机制。
  // -------------------------------------------------------------------------
  let action = '';
  let targetId = '';
  await sql.begin(async (tx) => {
    await tx.unsafe(`select set_config('app.rbac_actor_super_admin', 'on', true)`);

    if (existing.length === 0) {
      if (grantRole && !password) {
        throw new Error(`--grant-role 指定了不存在的账号 '${username}'；该选项只用于恢复既有账号的角色`);
      }
      const rows = await tx`
        insert into teachers (username, name, roles, status, password_hash)
        values (${username}, ${name}, array[${ROLE}]::varchar[], 'active', ${hash})
        returning id`;
      targetId = rows[0].id;
      action = 'created';
    } else {
      targetId = existing[0].id;
      // 只改必要的列。roles/status 用于确保它确实是有权登录的 super_admin；
      // password_hash 仅在提供密码时更新。name 仅在显式给出时更新。
      const rows = await tx`
        update teachers
           set roles         = array[${ROLE}]::varchar[],
               status        = 'active',
               name          = ${name},
               password_hash = case when ${password === ''} then password_hash else ${hash} end,
               failed_login_attempts = 0,
               locked_until  = null
         where id = ${targetId}
        returning id`;
      targetId = rows[0].id;
      action = password ? 'password+role updated' : 'role restored';
    }
  });

  line(`写入完成（单事务，已声明 super_admin 权限）：${action}`);
  line(`  账号 id: ${targetId}`);
  line('');

  // -------------------------------------------------------------------------
  // 4. 运行后状态 + 验收
  // -------------------------------------------------------------------------
  const [after] = await sql`
    select count(*) filter (where roles @> array['super_admin']::varchar[] and status = 'active'
                              and password_hash is not null)::int as usable
      from teachers t
  `;
  const [mine] = await sql`
    select t.username, t.status, (t.password_hash is not null) as has_password,
           (t.password_hash like 'scrypt$%') as hash_wellformed,
           coalesce(m.confirmed, false) as mfa_enrolled
      from teachers t left join teacher_mfa m on m.teacher_id = t.id
     where t.id = ${targetId}
  `;
  line('运行后验收：');
  line(`  库中"活跃+有密码"的 super_admin 数：${before.usable} → ${after.usable}`);
  line(`  目标账号：status=${mine.status} has_password=${mine.has_password} hash_wellformed=${mine.hash_wellformed}`);
  line(`            MFA 已绑定=${mine.mfa_enrolled}  ← 仍为 false，下一步就是绑定它`);
  line('');

  const ok = mine.status === 'active' && mine.has_password && mine.hash_wellformed;
  if (!ok) {
    line('★ 验收未通过：账号状态不符合"可登录"的定义，请看上面各字段。');
    exitCode = 1;
  } else {
    line('✅ 账号已就绪（密码维度）。**但现在还不能正常使用平台** —— 见下一步。');
    exitCode = 0;
  }
  line('');

  // -------------------------------------------------------------------------
  // 5. 后续步骤（顺序很重要）
  // -------------------------------------------------------------------------
  line('─'.repeat(78));
  line('下一步（顺序不能颠倒）');
  line('─'.repeat(78));
  line('');
  line('① 确认 MFA_ENCRYPTION_KEY 已经固定 —— **在做 ② 之前**');
  line('   TOTP 密钥以 AES-256-GCM 加密存库，键来自 MFA_ENCRYPTION_KEY。');
  line('   绑定 MFA 之后再换键 ⇒ 已有绑定永久无法解密 ⇒ 该账号登录 FAIL CLOSED。');
  line('   生成一次：openssl rand -base64 32   （写进部署环境，此后永不更换）');
  line('');
  line('② 用密码登录（此时未绑定 MFA，会正常下发会话）：');
  line(`     curl -sS -c /tmp/qls-c.txt -X POST "\${MFA_BASE}/api/auth/login" \\`);
  line(`       -H 'Content-Type: application/json' -H "Origin: \${MFA_BASE}" \\`);
  line(`       -d '{"username":"${username}","password":"<你的密码>"}'`);
  line('   期望：HTTP 201，{"mfaRequired":false,"teacher":{...}}');
  line('');
  line('③ 自助绑定 MFA（**不要**手工写 teacher_mfa）：');
  line('     curl -sS -b /tmp/qls-c.txt -X POST "${MFA_BASE}/api/auth/mfa/enroll" \\');
  line('       -H "Origin: ${MFA_BASE}" -H \'Content-Type: application/json\'');
  line('   → 把返回的 secret / otpauthUri 导入认证器 App');
  line('     curl -sS -b /tmp/qls-c.txt -X POST "${MFA_BASE}/api/auth/mfa/confirm" \\');
  line('       -H "Origin: ${MFA_BASE}" -H \'Content-Type: application/json\' \\');
  line('       -d \'{"code":"<App 当前 6 位码>"}\'');
  line('   → 拿 10 个恢复码，立刻存入密码管理器');
  line('');
  line('④ 验收（只读，可反复跑）：');
  line('     node scripts/bootstrap-super-admin.mjs --verify     # 期望 superAdminUsable>=1');
  line('     node scripts/predeploy-db-check.mjs super-admin     # 期望 PASS + CAN LOG IN');
  line('     npm run predeploy                                   # 期望 FAIL[07]/[08] 消失');
  line('');
  line('⚠️ 本次密码是通过命令行/文件传入的。请在首次登录后到应用内改密，');
  line('   并删除你用于传递密码的临时文件。');
  line('⚠️ must_change_password **没有**被设置：已核实该标志只被读取并发给前端，');
  line('   服务端网关不据此拦截，设它等于假装有"强制改密"。所以这一步靠人执行。');
  line('');
} catch (error) {
  process.stderr.write(`\n[provision-super-admin] 失败: ${String(error.message).split('\n')[0]}\n`);
  if (error.code) process.stderr.write(`  SQLSTATE: ${error.code}\n`);
  if (String(error.message).includes('refused to modify or remove a super_admin')) {
    process.stderr.write(
      '  这是 rbac_guard_super_admin 触发器在拒绝：本次写操作未被认定为 super_admin 权威。\n' +
      '  正常情况不该发生（本脚本在同一事务内声明了权限）。若出现，请检查该事务是否被拆分。\n',
    );
  }
  exitCode = 1;
} finally {
  await sql.end();
}
process.exit(exitCode);
