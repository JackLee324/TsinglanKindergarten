#!/usr/bin/env node
/**
 * scripts/seed-curriculum.mjs — 把课程内容（347 条资源）灌进**一个已经建好表**的数据库
 * =====================================================================================
 * 为什么需要这个脚本
 * ------------------
 * `server/database/seed-curriculum.sql`（493 KB，347 条 `INSERT INTO resources`）就是
 * 全部课程内容。但**没有任何部署步骤会执行它**：
 *
 *   * `scripts/entrypoint.sh` 不跑它；
 *   * `Dockerfile` 只是把它随 `server/database` 复制进镜像；
 *   * 唯一读它的地方是 `tests/helpers/legacy-fixture.mjs`（测试夹具），
 *     它把种子灌进**测试库**。
 *
 * 于是出现了一个非常容易误判的状态：**本地测试库里有 347 条课程内容，线上一条都没有。**
 * 线上首页显示「Pre-K 资源 0」、每个科目页都是空的，不是数据被删了，而是**从来没被载入过**。
 *
 * `seed-curriculum.sql:9-10` 开头是一条 `DELETE FROM resources WHERE uploader_id = (…)`，
 * 所以它**不能**被当作幂等的初始化步骤无条件重跑（`MIGRATION_REPORT.md:459` 也是这个结论）。
 * 本脚本因此把"要不要真的执行"做成显式决定：
 *
 *   node scripts/seed-curriculum.mjs                 # 只体检、只报告，不写库（默认）
 *   node scripts/seed-curriculum.mjs --apply         # 真正写入（库里有资源时拒绝）
 *   node scripts/seed-curriculum.mjs --apply --force # 明知会先删掉 system_initializer
 *                                                    # 名下的资源，仍然执行
 *
 * 连接串优先级：QLS_ADMIN_DB / MIGRATION_DATABASE_URL / DATABASE_URL / SUDA_DATABASE_URL。
 * 退出码：0 成功或（默认模式下）体检完成；1 失败；2 用法/前置错误。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_FILE = join(ROOT, 'server', 'database', 'seed-curriculum.sql');
const UPLOADER_WECOM_ID = 'system_initializer';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const HELP = args.includes('--help') || args.includes('-h');

const line = (s = '') => process.stdout.write(s + '\n');
const die = (msg, code = 2) => { process.stderr.write(`[seed-curriculum] ${msg}\n`); process.exit(code); };

if (HELP) {
  line(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
  process.exit(0);
}

const DB_URL =
  process.env.QLS_ADMIN_DB ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.SUDA_DATABASE_URL ||
  '';
if (!DB_URL) {
  die('缺少连接串。请设置 QLS_ADMIN_DB / MIGRATION_DATABASE_URL / DATABASE_URL / SUDA_DATABASE_URL。');
}
if (!existsSync(SEED_FILE)) die(`找不到种子文件：${SEED_FILE}`);

function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 'default'}/${u.pathname.replace(/^\//, '')} as ${u.username || '(no user)'}`;
  } catch { return '(不可解析)'; }
}

const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });

try {
  line('=== 目标数据库 ===');
  line(`  ${describeUrl(DB_URL)}`);
  line('');

  // ---- 前置检查：表在不在 -------------------------------------------------
  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ('teachers', 'resources')
  `;
  const have = new Set(tables.map((t) => t.table_name));
  if (!have.has('teachers') || !have.has('resources')) {
    die(`表还不存在（teachers=${have.has('teachers')} resources=${have.has('resources')}）。` +
        '请先跑迁移：node scripts/migrate.mjs up', 2);
  }
  line('=== 前置检查 ===');
  line('  teachers / resources 表均存在                  OK');

  // ---- 当前状态 -----------------------------------------------------------
  const [{ n: before }] = await sql`select count(*)::int n from resources`;
  const [{ n: active }] = await sql`select count(*)::int n from resources where deleted_at is null`;
  const owner = await sql`
    select id, name, roles from teachers where wecom_user_id = ${UPLOADER_WECOM_ID} limit 1
  `;
  const [{ n: owned }] = owner.length
    ? await sql`select count(*)::int n from resources where uploader_id = ${owner[0].id}`
    : [{ n: 0 }];

  line(`  当前 resources 行数                             ${before}（未删除 ${active}）`);
  line(`  种子依赖的上传者 ${UPLOADER_WECOM_ID.padEnd(20)} ${owner.length ? '存在' : '**不存在（本脚本会创建）**'}`);
  if (owner.length) line(`    其名下资源数                                  ${owned}`);
  line('');

  // ---- 安全检查：库里已经有资源就不动 --------------------------------------
  line('=== 安全性检查 ===');
  if (before > 0 && !FORCE) {
    line(`  ✗ 这个库里已经有 ${before} 条资源，拒绝执行。`);
    line('');
    line('  原因：seed-curriculum.sql 第 9-10 行是一条');
    line(`        DELETE FROM resources WHERE uploader_id = (… '${UPLOADER_WECOM_ID}')`);
    line('        它会先删掉该上传者名下的全部资源再重新插入。库里有内容时无条件重跑有丢数据的风险。');
    line('');
    line('  如果你确认要重灌（例如线上内容确实为空、或有备份）：');
    line('      node scripts/seed-curriculum.mjs --apply --force');
    line('  如果只是想看看会做什么：本脚本默认就是只读体检，不需要加参数。');
    await sql.end({ timeout: 5 });
    process.exit(before > 0 && !FORCE ? 1 : 0);
  }
  if (before > 0 && FORCE) {
    line(`  ⚠️ 库里有 ${before} 条资源，但你给了 --force：会先删掉 ${UPLOADER_WECOM_ID} 名下的 ${owned} 条。`);
  } else {
    line('  库里没有资源，执行是纯新增（那条 DELETE 不会命中任何行）。  OK');
  }
  line('');

  const seed = readFileSync(SEED_FILE, 'utf8');
  const insertCount = (seed.match(/INSERT INTO resources/g) || []).length;
  line(`=== 种子文件 ===`);
  line(`  ${SEED_FILE}`);
  line(`  ${insertCount} 条 INSERT INTO resources（${(seed.length / 1024).toFixed(0)} KB）`);
  line('');

  if (!APPLY) {
    line('=== 只读体检结束（未写库）===');
    line('  真正执行请加 --apply。');
    await sql.end({ timeout: 5 });
    process.exit(0);
  }

  // ---- 执行 ---------------------------------------------------------------
  line('=== 执行 ===');
  await sql.begin(async (tx) => {
    if (owner.length === 0) {
      await tx`
        insert into teachers (wecom_user_id, name, name_en, roles, status)
        values (${UPLOADER_WECOM_ID}, '系统初始化', 'System Initializer',
                array['principal']::varchar[], 'active')
      `;
      line(`  已创建上传者账号 ${UPLOADER_WECOM_ID}（无密码，不能登录，只是内容归属）`);
    } else {
      line(`  上传者 ${UPLOADER_WECOM_ID} 已存在，复用`);
    }
    await tx.unsafe(seed);
    line(`  已执行种子 SQL（单事务）`);
  });

  const [{ n: after }] = await sql`select count(*)::int n from resources`;
  const [{ n: published }] = await sql`select count(*)::int n from resources where status = 'published'`;
  const byArea = await sql`
    select program, subject, folder_type, count(*)::int n
    from resources group by 1, 2, 3 order by 1, 2, 3
  `;
  line('');
  line('=== 结果 ===');
  line(`  resources：${before} → ${after}   其中 published = ${published}`);
  line('');
  line('  内容分布（program / subject / folder_type）：');
  for (const r of byArea) {
    line(`    ${String(r.program).padEnd(5)} ${String(r.subject).padEnd(12)} ${String(r.folder_type).padEnd(19)} ${String(r.n).padStart(3)}`);
  }
  line('');
  // 这一点必须写出来，否则"某些科目页仍然是空的"会被误判成装载失败。
  line('  ⚠️ 这份种子只覆盖上表列出的科目。K 中文（古诗/绘本/戏剧/STEM）、体能、K 美德等');
  line('     没有出现在上表里 —— 源文件里本来就没有它们的内容。那些页面载入后仍然是空的，');
  line('     这是数据缺口，不是装载失败。');
  line('');
  if (after > before) line('  ✅ 课程内容已载入。');
  else line('  ⚠️ 行数没有增加 —— 请检查 system_initializer 是否与种子文件里的一致。');
} catch (error) {
  process.stderr.write(`[seed-curriculum] 失败：${error.stack || error.message}\n`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

await sql.end({ timeout: 5 });
