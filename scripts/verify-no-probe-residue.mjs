/**
 * scripts/verify-no-probe-residue.mjs —— **系统性**探针残留检查。
 *
 * WHY THIS EXISTS
 * ---------------
 * `DELETE /api/resources/:id` 是软删除。任何"建探针 → 用完 DELETE"的套件，
 * 每跑一次就往回收站留一行。实测本机测试库积了 **233 行**，其中约 220 行
 * 是反复跑门禁留下的探针。
 *
 * 这个缺陷此前被**单独修过三次**，每次修的都是"那一条没清干净的探针"，
 * 所以下一条继续漏。点修解决不了"每一处都要记得清"这种问题 ——
 * 需要一道**不依赖谁记得**的检查：
 *
 *   套件跑完后扫一遍回收站。**只要还有符合"每轮探针"形态的行，就整体失败**，
 *   并把标题打出来。任何套件以后漏了都会被这里抓住，
 *   不需要有人先想到去改那一个脚本。
 *
 * 「每轮探针」的形态怎么定 —— 这是本文件唯一需要判断的地方：
 *   探针标题里几乎都带一个**时间戳或 run id**（`Date.now().toString().slice(-6)`、
 *   12 位 runId 等），而真实业务数据的标题不会长这样。所以规则是：
 *     标题里出现**连续 6 位以上数字**，或出现形如 `__files_http_probe_<id>__` 的 runId。
 *
 *   这条规则刻意**不**去匹配"探针"这个词本身：本地测试库里有大量
 *   **长期固定**的夹具数据标题带"探针"（例如 `序列探针`、`范围探针 prek-english`），
 *   它们由 fixtures 创建、本来就该在库里。用"探针"二字去扫会产生一堆假红，
 *   而假红会让人把这道检查关掉 —— 那就等于没有。
 *   （这个教训是实打实的：我第一版用 `%探针%` 扫，得到 577 行"残留"，
 *     其中绝大多数是夹具。）
 *
 * 用法：
 *   DATABASE_URL=… node scripts/verify-no-probe-residue.mjs
 * 退出码：0 = 干净；1 = 有残留；2 = 环境缺失（**不算通过**）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 允许存在的"带数字"的固定夹具标题白名单（每一条都要写明为什么）。 */
const ALLOWED_TITLE_PATTERNS = [
  // 固定夹具账号名形如 `perm_actor_929527`，随套件运行而变，但它是**账号**不是资源；
  // 资源侧暂无需要豁免的固定夹具。留空数组 + 明确注释，好过悄悄放宽。
];

function loadEnvFile() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnvFile();

const DB_URL = process.env.DATABASE_URL || process.env.AUTHZ_TEST_DB || null;
if (!DB_URL) {
  console.error(
    '[probe-residue] 需要 DATABASE_URL 或 AUTHZ_TEST_DB。' +
      '没有数据库就**无法**证明没有残留 —— 这一项不算通过。',
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] ?? null); };
const SNAPSHOT = argOf('--snapshot');
const COMPARE = argOf('--compare');

const postgres = (await import('postgres')).default;
const sql = postgres(DB_URL, { max: 1 });

/**
 * 快照 / 比对模式 —— 这才是可靠的判据。
 *
 * WHY：第一版用"标题里带 6 位以上数字"来识别探针，
 * 于是**漏掉了 54 行** `版本探针（改名）` —— 那个套件把探针改名成不带时间戳的标题，
 * 模式就匹配不上了。凡是"靠标题形态猜"的检查都会这样：猜得松就假红，猜得紧就漏报。
 *
 * 改成**精确的集合比对**，不需要任何猜测：
 *   门禁在跑 HTTP 套件**之前**存一份 resources + teachers 的 id 快照，
 *   跑完之后再比一次。结论只有三种，都直接可判定：
 *     · 新增的行 → 某个套件建了东西没清干净；
 *     · 消失的行 → 某个套件删掉了不属于它的夹具（同样严重，会破坏可重复性）；
 *     · 完全一致 → 干净。
 * 这条不变式不依赖任何命名约定，所以新套件、新标题、改名都逃不过。
 */
async function snapshot(file) {
  const r = await sql`select id from resources order by id`;
  const t = await sql`select id from teachers order by id`;
  /**
   * ⚠️ **`directories` 也要进快照。**
   *
   * 第一版只记 resources 与 teachers，于是 6 个探针自建文件夹（我自己的临时
   * 探针脚本留下的）**完全没被这道检查看见** —— 直到 `directories` 套件报
   * "节点总数 = 75，expected 69" 才暴露。
   * 而这正是这道检查存在的意义：它应该比我更早发现残留，而不是漏掉整整一类。
   *
   * 目录树是"唯一真相"（§1），多出来的节点会直接改变 PDF 结构与
   * `allowCustomFolders` 叶节点计数 —— 比多一行探针资源严重得多。
   */
  const d = await sql`select id from directories order by id`;
  const payload = {
    takenAt: new Date().toISOString(),
    resources: r.map((x) => x.id),
    teachers: t.map((x) => x.id),
    directories: d.map((x) => x.id),
  };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, JSON.stringify(payload));
  console.log(
    `快照已写入 ${file}：resources=${payload.resources.length} ` +
      `teachers=${payload.teachers.length} directories=${payload.directories.length}`,
  );
  await sql.end();
  process.exit(0);
}

async function compare(file) {
  const { readFileSync } = await import('node:fs');
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const rNow = await sql`select id, title, deleted_at from resources order by id`;
  const tNow = await sql`select id, username from teachers order by id`;
  const dNow = await sql`select id, code, name, is_system from directories order by id`;
  const beforeRes = new Set(before.resources);
  const beforeTea = new Set(before.teachers);
  const beforeDir = new Set(before.directories ?? []);
  const addedRes = rNow.filter((x) => !beforeRes.has(x.id));
  const addedTea = tNow.filter((x) => !beforeTea.has(x.id));
  const addedDir = dNow.filter((x) => !beforeDir.has(x.id));
  const removedRes = before.resources.filter((id) => !rNow.some((x) => x.id === id));
  const removedDir = (before.directories ?? []).filter((id) => !dNow.some((x) => x.id === id));

  console.log(`\n=== 探针残留（精确集合比对，快照 ${before.takenAt}）===\n`);
  console.log(`  resources  ：${before.resources.length} → ${rNow.length}（新增 ${addedRes.length}）`);
  console.log(`  teachers   ：${before.teachers.length} → ${tNow.length}（新增 ${addedTea.length}）`);
  console.log(`  directories：${(before.directories ?? []).length} → ${dNow.length}（新增 ${addedDir.length}）`);
  console.log(`  被删除的既有行：resources ${removedRes.length} / directories ${removedDir.length}`);

  const dirty =
    addedRes.length > 0 ||
    addedTea.length > 0 ||
    addedDir.length > 0 ||
    removedRes.length > 0 ||
    removedDir.length > 0;
  if (!dirty) {
    console.log('\n  ✅ 跑完一轮门禁后，库与开跑前完全一致（没有新增、没有误删）。');
    console.log('\n=== RESULT ===\n  pass=1 fail=0');
    await sql.end();
    process.exit(0);
  }

  if (addedRes.length > 0) {
    console.log('\n  ❌ 有套件建了资源没清干净：');
    for (const x of addedRes.slice(0, 30)) {
      console.log(`      [${x.deleted_at === null ? '在用' : '回收站'}] ${String(x.title).slice(0, 64)}`);
    }
  }
  if (addedTea.length > 0) {
    console.log('\n  ❌ 有套件建了账号没清干净：');
    for (const x of addedTea.slice(0, 30)) console.log(`      [账号] ${x.username}`);
  }
  if (addedDir.length > 0) {
    console.log('\n  ❌ 有套件建了目录/文件夹没清干净（会改变 PDF 结构与 allowCustomFolders 计数）：');
    for (const x of addedDir.slice(0, 30)) {
      console.log(`      [目录] ${x.code}  ${String(x.name).slice(0, 30)}  is_system=${x.is_system}`);
    }
  }
  if (removedRes.length > 0) {
    console.log('\n  ❌ 有套件删掉了**既有**的资源行（会破坏可重复性）：');
    for (const id of removedRes.slice(0, 30)) console.log(`      [已消失] ${id}`);
  }
  if (removedDir.length > 0) {
    console.log('\n  ❌ 有套件删掉了**既有**的目录节点：');
    for (const id of removedDir.slice(0, 30)) console.log(`      [已消失] ${id}`);
  }
  console.log(
    '\n  怎么修：清理请用 tests/helpers/probe-cleanup.mjs 的 purgeProbeResources()，' +
      '\n  它在收尾时会**核实**行真的没了（DELETE 只是软删除，会进回收站）。',
  );
  console.log('\n=== RESULT ===\n  pass=0 fail=1');
  await sql.end();
  process.exit(1);
}

if (SNAPSHOT !== null) await snapshot(SNAPSHOT);
if (COMPARE !== null) await compare(COMPARE);

/**
 * 账号侧的同类残留。
 *
 * 同一类缺陷也会落在**账号**上：套件为每一轮创建 `xx_probe_<runId>` 账号，
 * 跑完删除；一旦中途被 kill（或收尾抛错），账号就留下了。
 * 实测抓到过 `__qt_files_admin_1yaamuw67tk1` / `__qt_files_low_1yaamuw67tk1`
 * 两个 —— 它们与更早那条被漏掉的探针资源**来自同一次被中断的运行**。
 *
 * 与资源侧一样，只认"带 runId/时间戳"的形态，不认"探针"这个词 ——
 * `__rbac_keeper`、`prek-head01` 这些是**长期固定夹具**，本来就该在库里。
 */
const ACCOUNT_PATTERNS = [
  /^(boot_probe|perm_actor|perm_target|biz_probe|ia_probe|dir_probe|qt_probe)_[0-9a-z]+$/,
  /^__qt_[a-z]+_(admin|low|actor|target)_[0-9a-z]{6,}$/,
  /^__[a-z]+_probe_[0-9a-z]{6,}$/,
];

try {
  const accountRows = await sql`select username from teachers order by username`;
  const accountOffenders = accountRows
    .map((r) => String(r.username))
    .filter((u) => ACCOUNT_PATTERNS.some((re) => re.test(u)));

  const rows = await sql`
    select title, deleted_at
      from resources
     where title ~ '[0-9]{6,}'
        or title like '%__files_http_probe_%'
        or title ~ '__(qt|ia|biz)_probe_'
     order by deleted_at desc nulls first, title`;

  const offenders = rows.filter(
    (r) => !ALLOWED_TITLE_PATTERNS.some((re) => re.test(String(r.title))),
  );

  console.log(`  每轮探针账号（带 runId 形态）：${accountOffenders.length}`);
  for (const u of accountOffenders) console.log(`      [账号] ${u}`);

  const active = offenders.filter((r) => r.deleted_at === null);
  const recycled = offenders.filter((r) => r.deleted_at !== null);

  console.log(
    `\n=== 探针残留检查（${new URL(DB_URL).hostname}/${new URL(DB_URL).pathname.replace(/^\//, '')}）===\n`,
  );
  console.log(`  带时间戳/runsId 的资源行：${rows.length}（豁免 ${rows.length - offenders.length}）`);
  console.log(`  其中仍在用：${active.length}    在回收站：${recycled.length}`);

  if (offenders.length === 0 && accountOffenders.length === 0) {
    console.log('\n  ✅ 没有探针残留。');
    console.log('\n=== RESULT ===');
    console.log(`  pass=1 fail=0`);
    await sql.end();
    process.exit(0);
  }

  console.log('\n  ❌ 发现探针残留（每跑一次门禁就会多几行）：');
  for (const r of offenders.slice(0, 40)) {
    console.log(`      [${r.deleted_at === null ? '在用' : '回收站'}] ${String(r.title).slice(0, 70)}`);
  }
  if (offenders.length > 40) console.log(`      … 另有 ${offenders.length - 40} 行`);
  console.log(
    '\n  怎么修：这些行的产生方式是「建探针 → DELETE（软删除）」——' +
      '\n  DELETE 只进回收站。清理请改用 tests/helpers/probe-cleanup.mjs 的' +
      '\n  purgeProbeResources()，它在收尾时**核实**行真的没了。',
  );
  console.log('\n=== RESULT ===');
  console.log(`  pass=0 fail=1`);
  await sql.end();
  process.exit(1);
} catch (e) {
  console.error(`[probe-residue] 检查失败：${e?.message ?? String(e)}`);
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(2);
}
