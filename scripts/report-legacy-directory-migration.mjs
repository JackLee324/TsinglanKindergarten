#!/usr/bin/env node
/**
 * scripts/report-legacy-directory-migration.mjs
 *   —— 历史资源的 `folder_type` 落到可编辑 `directories` 树上的**只读**盘点报告
 * ===========================================================================
 *
 *   node scripts/report-legacy-directory-migration.mjs
 *   node scripts/report-legacy-directory-migration.mjs --out /tmp/x.md --json /tmp/x.json
 *   node scripts/report-legacy-directory-migration.mjs --help
 *
 * 为什么要有这份报告
 * ------------------
 * 「迁移做完了没有」在这个仓库里不能靠感觉回答，因为结构被分成了三步：
 *
 *   * `shared/curriculum.ts` 的 `FOLDER_DEFINITIONS` 定义 6 个历史 `folder_type`；
 *   * 0009 / 0010 把 PDF《教师平台》的那棵树搬进 `directories` 表（权威、可编辑）；
 *   * 0012 给 `resources` 加了 `directory_id`，但**只回填到科目节点**，
 *     资料夹层级刻意留空 —— 见 `0012_resource_directory.sql` 的 BACKFILL 段，
 *     那里明确写了"把 legacy folder_type 猜成 PDF 的某个资料夹需要业务判断，
 *     PDF 没有规定，所以一律留 NULL"。
 *
 * 于是库里同时存在三种状态：已经挂在资料夹上的、只挂到科目的、哪儿都没挂的。
 * 这个脚本把三者数清楚，并把**数不出来的那些连同原因**列出来，
 * 而不是把"不知道"混进"已完成"，也不是替所有人猜一个资料夹。
 *
 * 只报告，不改数据（可核查，不是口头承诺）
 * ----------------------------------------
 *   1. 与数据库的**唯一**通道是 `roRead`。它的第一个动作是断言语句以 `select`
 *      开头，否则立刻抛错 —— 顺手加一条写语句会在运行时就炸，而不是悄悄生效。
 *   2. 连接在**启动参数**里带上 `default_transaction_read_only = on`，
 *      由 PostgreSQL 自己拒绝写（连 `create temp table` 都会被拒）。
 *      这不是"我记得没写 update"，是服务端层面的兜底。
 *   3. 脚本跑完会打印本次实际执行了多少条 SQL、首关键字分别是什么。
 *   4. 需要修数据时，请另写一次**可评审**的迁移；不要把它塞进这个脚本。
 *      报告里给出的 SQL 是给那次迁移用的参考，本脚本不会执行它们。
 *
 * 连接串优先级：QLS_ADMIN_DB / MIGRATION_DATABASE_URL / DATABASE_URL /
 *               SUDA_DATABASE_URL，都没有时退到本机验证库
 *               `postgresql://…@127.0.0.1:55432/qls_test_0005`
 *               （与 scripts/dev-postgres.sh / CI 用的是同一个库）。
 *
 * 退出码：0 成功；1 失败；2 用法或前置条件不满足（连不上库 / 表或列还没有）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// =============================================================================
// 0. 参数
// =============================================================================

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = 'LEGACY_RESOURCE_DIRECTORY_MIGRATION_REPORT.md';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
};
const HELP = argv.includes('--help') || argv.includes('-h');

function die(msg, code) {
  process.stderr.write(`[legacy-dir-report] ${msg}\n`);
  process.exit(code);
}
function say(msg = '') {
  process.stdout.write(`${msg}\n`);
}

/**
 * 相对路径按**仓库根目录**解析，而不是当前工作目录。
 * 这份报告属于仓库，落到哪里不应该取决于你当时站在哪个目录里敲的命令。
 */
const resolveUnderRoot = (p) => resolve(ROOT, p);

/**
 * `--from-export <ndjson>` —— 从**离线导出产物**出报告，而不是连库。
 *
 * WHY: §9 要的是"清点**真实**历史资源"。第一版报告连的是本机测试库
 * （`qls_test_0005`，349 条），生产上有多少、分布如何**完全没有被测量** ——
 * 那份报告在生产口径上不成立。生产库不该为了出一份报告去直连，
 * 但 `POST /api/admin/data-export` 已经导出了**整库逻辑快照**
 * （`backups/prod-export-*.ndjson`，含 `resources` 与 `directories` 全表）。
 *
 * 于是加了这个模式：读那份产物、做**完全相同**的归类，得到生产口径的报告。
 * 它比连库更严的一点是产物有 sha256 —— 报告里会写入哈希，
 * "这份数字来自哪一份字节"可核对。
 *
 * 产物里的行本来就是数据库的 snake_case 列名（`folder_type` / `directory_id` /
 * `sub_subject` / `parent_id` …），所以能直接喂给同一套归类函数，
 * **不需要任何字段映射** —— 少一层映射就少一处"报告与库不一致"的可能。
 */
const EXPORT_ARG = argOf('--from-export');
const FROM_EXPORT = EXPORT_ARG === null ? null : resolveUnderRoot(EXPORT_ARG);

const EXPORT_DEFAULT_OUT = 'LEGACY_RESOURCE_DIRECTORY_MIGRATION_REPORT.production.md';

const OUT = resolveUnderRoot(
  argOf('--out') ?? (FROM_EXPORT === null ? DEFAULT_OUT : EXPORT_DEFAULT_OUT),
);
const JSON_ARG = argOf('--json');
const JSON_OUT = JSON_ARG === null ? null : resolveUnderRoot(JSON_ARG);

if (HELP) {
  process.stdout.write(
    '用法：node scripts/report-legacy-directory-migration.mjs [--out <path>] [--json <path>]\n' +
      '      node scripts/report-legacy-directory-migration.mjs --from-export <ndjson> [--out <path>]\n' +
      `  --out   报告写到哪里（默认 ${DEFAULT_OUT}，相对路径按仓库根目录解析）\n` +
      '  --json  同时把原始数字 dump 成 JSON（默认不写）\n' +
      '  --from-export  不连库，改从 data-export 产物（NDJSON）出报告 —— 用于**生产口径**；' +
      `默认输出 ${EXPORT_DEFAULT_OUT}。\n` +
      '只读：不做任何 INSERT / UPDATE / DELETE / DDL；--from-export 连库都不连。\n',
  );
  process.exit(0);
}

// 用法错误要在连库之前就拒绝，否则会白连一次再失败。
if (argv.includes('--out') && argOf('--out') === null) die('--out 后面需要一个路径', 2);
if (argv.includes('--json') && JSON_ARG === null) die('--json 后面需要一个路径', 2);
if (argv.includes('--from-export') && EXPORT_ARG === null) die('--from-export 后面需要一个 NDJSON 路径', 2);

// =============================================================================
// 1. 映射表 —— 全部来自仓库里的既有定义，不在这里发明新语义
// =============================================================================

/**
 * 6 个历史 `folder_type`。key / name / nameEn 逐字抄自
 * `shared/curriculum.ts` 的 `FOLDER_DEFINITIONS`（那里是唯一的定义处）。
 *
 * `pdfFolder` 是**业主本轮明确给出的**映射：PDF《教师平台》把资料夹压成 4 个，
 * 历史值是 6 个，所以必然有两个历史值并到一个 PDF 资料夹（courseware 与
 * materials 都去「教学资源」），也必然有一个历史值没有去处（research_archive）。
 *
 * 注意：这与 0012 迁移注释里"PDF 没有规定、一律留 NULL"的说法**不一致**。
 * 0012 当时的结论是"只有 curriculum_outline 同名，其余需要业务判断"；
 * 本轮的业主指令就是那次业务判断。两者不是矛盾，是先后关系 ——
 * 但 0012 的注释仍在仓库里，改动前应该有人显式确认一次，报告里也写明了这一点。
 */
const FOLDER_DEFINITIONS = [
  { key: 'curriculum_outline', name: '课程大纲', nameEn: 'Curriculum Outline', pdfFolder: '课程大纲', codeSuffix: 'outline' },
  { key: 'weekly_plans', name: '周次教案', nameEn: 'Weekly Lesson Plans', pdfFolder: '教学详案', codeSuffix: 'lesson' },
  { key: 'courseware', name: '课件与示范', nameEn: 'Courseware & Demonstration', pdfFolder: '教学资源', codeSuffix: 'resource' },
  { key: 'materials', name: '素材与工作单', nameEn: 'Materials & Worksheets', pdfFolder: '教学资源', codeSuffix: 'resource' },
  { key: 'observation', name: '观察与评价', nameEn: 'Observation & Assessment', pdfFolder: '考核评估', codeSuffix: 'assessment' },
  // PDF《教师平台》里没有与「教研归档」对应的资料夹。业主明确要求不要硬猜，
  // 所以这里是 null：不是"忘了填"，是**刻意判为无对应**。
  { key: 'research_archive', name: '教研归档', nameEn: 'Teaching Research Archive', pdfFolder: null, codeSuffix: null },
];

/**
 * 资料夹节点靠 **`code` 后缀**认，不靠中文 `name` 认。
 *
 * WHY：`code` 是稳定标识（`directories_code_key` 唯一索引，改不了），
 * `name` 是管理员可以随手改的显示名 —— 「课程大纲」完全可能被改成别的。
 * 拿显示名当程序判断的键，管理员改一次名字就会让整份报告全变成
 * "科目下缺少对应资料夹节点"。所以名字只用来**核对**，不用来**定位**：
 * 后缀命中优先，后缀缺失时才退回名字，并把退回的次数报出来。
 */
const PDF_FOLDER_BY_CODE_SUFFIX = new Map(
  FOLDER_DEFINITIONS.filter((d) => d.codeSuffix !== null).map((d) => [d.codeSuffix, d.pdfFolder]),
);

const FOLDER_BY_KEY = new Map(FOLDER_DEFINITIONS.map((d) => [d.key, d]));

/** PDF 资料夹的中英名 —— 只用于报告展示。 */
const PDF_FOLDER_EN = {
  课程大纲: 'Curriculum Outline',
  教学详案: 'Lesson Plans',
  教学资源: 'Teaching Resources',
  考核评估: 'Assessment',
};

/**
 * 历史科目真名与目录 `code` 不同名的那几个。
 *
 * 这张表**不是新发明的**：它逐条抄自 `0012_resource_directory.sql` 里那段
 * `subject_node(program, subject_token, directory_code)` 的 VALUES ——
 * 迁移作者已经确认过这些是真名，我在这里只是让**没挂目录的行**也能用上它。
 * 今天这张表命中 0 行（库里没有 PE 资源），保留它是为了将来出现 PE 数据时
 * 不会静默判成"定位不到"。
 */
const LEGACY_SUBJECT_CODE_ALIASES = new Map([['physical_education', 'pe']]);

/** 科目层的目录节点类型。资料夹要挂在它们下面。 */
const SUBJECT_LEVEL_TYPES = new Set(['subject', 'sub_subject']);

/** 歧义原因目录。id 只在代码里用，label / detail 进报告。 */
const REASONS = [
  {
    id: 'unknown_folder_type',
    label: 'folder_type 不认识',
    detail: '`folder_type` 不在 `shared/curriculum.ts` 的 6 个值里，映射不到任何 PDF 资料夹。',
  },
  {
    id: 'no_pdf_counterpart',
    label: 'research_archive（PDF 无对应资料夹）',
    detail: '按业主指令：PDF《教师平台》没有与「教研归档」对应的资料夹，**不做映射**，留给人工决定。',
  },
  {
    id: 'directory_dangling',
    label: 'directory_id 悬空',
    detail: '`directory_id` 非空，但 `directories` 里没有这个 id。外键本应阻止这种情况，出现即为异常。',
  },
  {
    id: 'directory_not_in_own_subject',
    label: '指向的节点不在科目层之下',
    detail: '`directory_id` 指向的既不是资料夹（或其父不是科目 / 子科），也不是科目 / 子科节点本身 —— 例如指向 program / root / growth_* 节点。',
  },
  {
    id: 'directory_disabled',
    label: '指向的节点已停用',
    detail: '归属节点 `enabled = false`。已停用的节点在界面上默认不显示，资源会变成"看不见但确实存在"。',
  },
  {
    id: 'linked_to_other_subject',
    label: '挂到了别的科目下',
    detail: '`(program, subject)` 能唯一定位一个科目节点，但 `directory_id` 指向的是另一个科目 —— 归属与资源自身的元数据互相矛盾。',
  },
  {
    id: 'folder_under_other_subject',
    label: '挂的资料夹不是目标资料夹',
    detail: '已挂在资料夹节点上，但该节点不是本资源由 `folder_type` + 科目唯一确定的那个资料夹（挂到了别的资料夹，或挂到了别的科目下）。',
  },
  {
    id: 'folder_not_in_tree',
    label: '科目下缺少对应资料夹节点',
    detail: '科目 / 子科节点定位到了，但它下面没有名为该 PDF 资料夹的子节点 —— 目录树还没铺到这个层级。',
  },
  {
    id: 'folder_ambiguous',
    label: '同一科目下有重名资料夹',
    detail: '同一个父节点下有两个同名资料夹，无法判断该挂哪一个。（`directories` 没有 (parent_id, name) 唯一约束，所以这种状态是可能的。）',
  },
  {
    id: 'subject_unresolved',
    label: '元组定位不到科目节点',
    detail: '`(program, subject, sub_subject)` 退到科目层也命中不了任何 `directories` 节点。',
  },
];

/** 每个原因最多列多少行样例。超出只报数 —— 报告不是数据导出。 */
const SAMPLE_CAP = 20;

/** 只打印 host:port/db，**绝不**打印连接串本身 —— 它带密码。 */
function describeTarget(url) {
  try {
    const u = new URL(url);
    return { host: `${u.hostname}:${u.port || '5432'}`, database: u.pathname.replace(/^\//, '') || '?' };
  } catch {
    return { host: '(连接串无法解析)', database: '?' };
  }
}

// =============================================================================
// 2. 连库 + 只读取数入口
// =============================================================================

const LOCAL_TEST_DB = 'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005';

const DB_URL =
  process.env.QLS_ADMIN_DB ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  process.env.SUDA_DATABASE_URL ||
  LOCAL_TEST_DB;

const TARGET = describeTarget(DB_URL);

/**
 * 连接。`default_transaction_read_only = on` 走的是**启动参数**，
 * 所以它是这个会话的既成事实，而不是一条需要记得执行的 SET 语句。
 */
const sql = postgres(DB_URL, {
  max: 1,
  // 连不上时要**尽快**说不连通，不要挂在那里等人以为脚本在跑。
  connect_timeout: 10,
  onnotice: () => {},
  connection: {
    application_name: 'legacy-directory-migration-report',
    default_transaction_read_only: 'on',
  },
});

/** 本次运行执行过的 SQL 首关键字。跑完打印，作为"只读"的运行时证据。 */
const STATEMENT_LOG = [];

/**
 * 与数据库的**唯一**通道。第一个动作是断言语句以 `select` 开头。
 * 有意不做 `sql.unsafe` 之类的旁路 —— 留一个后门就等于没有这道门。
 */
function roRead(strings, ...values) {
  const text = strings.raw.join('?');
  const head = text.trimStart().slice(0, 6).toLowerCase();
  if (head !== 'select') {
    throw new Error(`拒绝执行非 SELECT 语句：${text.trim().slice(0, 80)}…`);
  }
  STATEMENT_LOG.push('select');
  return sql(strings, ...values);
}

// =============================================================================
// 3. 取数（全部 SELECT）
// =============================================================================

async function probe() {
  const identity = (
    await roRead`
      select current_database()                               as database,
             current_user                                     as db_user,
             now()                                            as db_now,
             current_setting('TimeZone')                      as db_tz,
             current_setting('default_transaction_read_only') as read_only
    `
  )[0];

  const tables = await roRead`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('resources', 'directories')
  `;
  const have = new Set(tables.map((t) => t.table_name));
  if (!have.has('resources')) {
    die('这个库里没有 `resources` 表。请确认连对了库，或先跑 node scripts/migrate.mjs up', 2);
  }
  if (!have.has('directories')) {
    die('这个库里没有 `directories` 表（migration 0009 还没跑）。本次报告无从谈起。', 2);
  }

  const cols = await roRead`
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'resources'
       and column_name in ('directory_id', 'folder_type', 'program', 'subject', 'sub_subject', 'deleted_at', 'title')
  `;
  const has = new Set(cols.map((c) => c.column_name));
  for (const need of ['title', 'program', 'subject', 'sub_subject', 'folder_type', 'deleted_at', 'directory_id']) {
    // `directory_id` 缺失说明 migration 0012 没跑；其余列缺失说明这不是这个项目的库。
    if (!has.has(need)) {
      die(
        `\`resources\` 缺少 \`${need}\` 列。` +
          (need === 'directory_id' ? '请先跑 migration 0012。' : '请确认连对了库。'),
        2,
      );
    }
  }

  const dirs = await roRead`
    select id, parent_id, code, name, name_en, type, program, subject, enabled
      from directories
     order by code
  `;

  // 50 万行以内的量级，整表读进内存再在 JS 里归类：
  // 归类规则集中在一处、可读可审，比把 11 种判断压成一条巨型 SQL 更不容易误判。
  // 取列是白名单的（不 select *），标题只用于样例展示，不参与任何判断。
  const rows = await roRead`
    select id, title, program, subject, sub_subject, folder_type, directory_id, deleted_at
      from resources
     order by id
  `;

  // SQL 侧的原始计数 —— 用来和 JS 归类的结果对账。
  // 两套独立算法给出同一个数，才配说"这个数字是对的"。
  const rawCounts = (
    await roRead`
      select count(*)::int                                                              as rows_total,
             count(*) filter (where deleted_at is null)::int                             as rows_active,
             count(*) filter (where deleted_at is not null)::int                         as rows_deleted,
             count(*) filter (where deleted_at is null and directory_id is null)::int     as active_unlinked,
             count(*) filter (where deleted_at is null and directory_id is not null)::int as active_linked
        from resources
    `
  )[0];

  return { identity, dirs, rows, rawCounts };
}

/**
 * 从 data-export 产物读取同样的四样东西（identity / dirs / rows / rawCounts）。
 *
 * 读数规则与连库模式**逐字段对齐**（见 probe()）：同样的列、同样的排序、
 * 同样的活跃行判定（`deleted_at IS NULL`）。刻意不做任何字段映射 ——
 * 产物里就是库里的 snake_case 列名。
 *
 * ⚠️ 有一条连库模式才有的保障在这里**不可用**，必须说出来：
 * 连库模式用 SQL 侧的聚合与 JS 归类**两套独立算法对账**（两边都算出同一个数
 * 才敢说这个数字是对的）。离线产物没有 SQL 引擎，所以对账退化成
 * "对产物里声明的 `rowCount` 与真实解析出的行数" —— 那仍然是一道校验
 * （声明 348 行、实际解析出 347 行就是产物损坏），但它**不等于** SQL 对账。
 * 报告里会如实写明这一点，不假装两者等价。
 */
async function probeFromExport(file) {
  if (!existsSync(file)) {
    die(`找不到导出产物：${file}\n  先导出一份：POST /api/admin/data-export（见 RUNBOOK.md 第 10 节）`, 2);
  }
  const raw = readFileSync(file);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const lines = raw.toString('utf8').split('\n').filter((l) => l.trim() !== '');

  let header = null;
  let footer = null;
  const declared = new Map();
  const dirs = [];
  const rows = [];

  for (const [i, line] of lines.entries()) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (error) {
      die(`产物第 ${i + 1} 行不是合法 JSON：${error.message}`, 2);
    }
    if (obj.kind === 'header') {
      header = obj;
      continue;
    }
    if (obj.kind === 'table') {
      declared.set(obj.table, obj.rowCount);
      continue;
    }
    if (obj.kind === 'row') {
      if (obj.table === 'directories') dirs.push(obj.row);
      else if (obj.table === 'resources') rows.push(obj.row);
      continue;
    }
    if (obj.kind === 'footer') {
      footer = obj;
      continue;
    }
    die(`产物第 ${i + 1} 行有未知的 kind=${JSON.stringify(obj.kind)}`, 2);
  }

  if (header === null) die('产物缺少 header 行 —— 这不是 data-export 的产物。', 2);
  if (declared.size === 0) die('产物没有任何 table 声明行 —— 无法核对行数。', 2);
  if (dirs.length === 0) die('产物里没有 directories 行 —— 目录树无从谈起。', 2);
  if (rows.length === 0) die('产物里没有 resources 行。', 2);

  /**
   * **三重行数核对** —— 这是离线模式用来替代"SQL 侧 vs JS 侧两套算法对账"的东西。
   *
   * 产物里同一张表的行数出现在三个地方：
   *   1. `kind:"table"` 行声明的 `rowCount`；
   *   2. `kind:"footer"` 里的 `counts[table]`；
   *   3. 我们真正解析出来的行数。
   * 三者必须完全一致。任何一个对不上，说明产物被截断/损坏/改写 ——
   * 这种输入下算出来的百分比没有意义，所以**直接失败**而不是照常出报告。
   *
   * 它比"连库模式的 SQL 对账"弱在哪里，也写清楚：SQL 对账是两个**独立实现**
   * 互相验证（聚合 SQL 与 JS 归类），而这里是同一份文件里的三处自述 ——
   * 它能抓"文件被截断"，抓不到"导出时就导错了"。报告里如实标注。
   */
  const footerCounts = footer?.counts ?? {};
  for (const [table, count] of declared) {
    const actual = table === 'directories' ? dirs.length : table === 'resources' ? rows.length : null;
    if (actual === null) continue;
    if (actual !== count) {
      die(
        `产物自身不一致：表 ${table} 的 table 行声明 ${count} 条，实际解析出 ${actual} 条。` +
          '产物可能被截断或损坏 —— 这种输入不能用来出报告。',
        2,
      );
    }
    const foot = footerCounts[table];
    if (foot !== undefined && foot !== actual) {
      die(
        `产物自身不一致：表 ${table} 的 footer 声明 ${foot} 条，实际解析出 ${actual} 条。`,
        2,
      );
    }
  }

  // 必备列校验，与连库模式同一份清单。
  for (const need of ['title', 'program', 'subject', 'sub_subject', 'folder_type', 'deleted_at', 'directory_id']) {
    if (!(need in rows[0])) {
      die(`产物里的 resources 缺少 \`${need}\` 列。`, 2);
    }
  }
  for (const need of ['id', 'parent_id', 'code', 'name', 'name_en', 'type', 'program', 'subject', 'enabled']) {
    if (!(need in dirs[0])) {
      die(`产物里的 directories 缺少 \`${need}\` 列。`, 2);
    }
  }

  // 与连库模式同样的排序，保证两次报告的行顺序与样例一致。
  dirs.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const active = rows.filter((r) => r.deleted_at === null || r.deleted_at === undefined);
  const rawCounts = {
    rows_total: rows.length,
    rows_active: active.length,
    rows_deleted: rows.length - active.length,
    active_unlinked: active.filter((r) => r.directory_id === null || r.directory_id === undefined).length,
    active_linked: active.filter((r) => r.directory_id !== null && r.directory_id !== undefined).length,
  };

  const identity = {
    database: `导出产物（源库：${header.sourceDatabase ?? '未知'}）`,
    db_user: '(离线产物，未连库)',
    db_now: new Date(header.createdAt ?? Date.now()),
    db_tz: '(不适用)',
    read_only: '文件只读（本模式连库都不连）',
    artifact: {
      path: basename(file),
      sha256,
      bytes: raw.length,
      createdAt: header.createdAt ?? null,
      formatVersion: header.formatVersion ?? null,
      declared,
      footerCounts,
      /** 三重核对是否全部通过（失败会直接 die，所以到这里必然是 true）。 */
      integrity: 'table 行 / footer / 实际解析行数 三者一致',
    },
  };

  return { identity, dirs, rows, rawCounts };
}

let identity;
let dirRows;
let resRows;
let rawCounts;

try {
  ({ identity, dirs: dirRows, rows: resRows, rawCounts } =
    FROM_EXPORT === null ? await probe() : await probeFromExport(FROM_EXPORT));
} catch (error) {
  // 连不上就说不连通，绝不把零当成答案。
  const detail = error instanceof Error ? error.message : String(error);
  sql.end({ timeout: 1 }).catch(() => {});
  die(
    [
      `连不上数据库：${TARGET.host}/${TARGET.database}`,
      `  原因：${detail}`,
      '  本机验证库不在运行时，可以先拉起它：',
      '    bash scripts/dev-postgres.sh start     # 127.0.0.1:55432 / qls_test_0005',
      '  也可以指向别的库：DATABASE_URL=postgres://… node scripts/report-legacy-directory-migration.mjs',
      '  没有数据就不出报告 —— 一份全是 0 的报告比不出报告更危险。',
    ].join('\n'),
    2,
  );
}

// =============================================================================
// 4. 归类
// =============================================================================

const index = (() => {
  const byId = new Map();
  const byCode = new Map();
  const children = new Map();
  for (const d of dirRows) {
    byId.set(d.id, d);
    byCode.set(d.code, d);
    if (d.parent_id) {
      if (!children.has(d.parent_id)) children.set(d.parent_id, []);
      children.get(d.parent_id).push(d);
    }
  }
  return { byId, byCode, children };
})();

/** 从 `(program, subject, sub_subject)` 定位科目 / 子科节点。绝不模糊匹配。 */
function resolveByTuple(row) {
  const segments = [row.program, row.subject, row.sub_subject].filter(
    (s) => s !== null && s !== undefined && s !== '',
  );
  // 从最深的候选 code 往上退：先试 `program:subject:sub_subject`，再试 `program:subject`。
  // 退一步只改变"定位到哪一层"，不改变"是谁" —— 命中哪个 code 就在报告里写哪个。
  for (let depth = segments.length; depth >= 2; depth -= 1) {
    const node = index.byCode.get(segments.slice(0, depth).join(':'));
    if (node && SUBJECT_LEVEL_TYPES.has(node.type)) {
      return { node, path: depth === segments.length ? 'code-exact' : 'code-ancestor' };
    }
  }
  const alias = LEGACY_SUBJECT_CODE_ALIASES.get(row.subject);
  if (alias) {
    const code = [row.program, alias, row.sub_subject]
      .filter((s) => s !== null && s !== undefined && s !== '')
      .join(':');
    const node = index.byCode.get(code);
    if (node && SUBJECT_LEVEL_TYPES.has(node.type)) return { node, path: 'legacy-alias' };
  }
  return { node: null, path: 'unresolved' };
}

/** 从 `directory_id` 反查归属节点。这是数据库里既有的事实，不重新猜。 */
function resolveByLink(row) {
  const node = index.byId.get(row.directory_id);
  if (!node) {
    return { node: null, folder: null, path: 'linked-dangling', reason: 'directory_dangling' };
  }
  if (node.type === 'folder') {
    const parent = node.parent_id ? index.byId.get(node.parent_id) : undefined;
    if (!parent || !SUBJECT_LEVEL_TYPES.has(parent.type)) {
      return { node: null, folder: node, path: 'linked-folder', reason: 'directory_not_in_own_subject' };
    }
    return { node: parent, folder: node, path: 'linked-folder', reason: null };
  }
  if (SUBJECT_LEVEL_TYPES.has(node.type)) {
    return { node, folder: null, path: 'linked-subject', reason: null };
  }
  return { node: null, folder: null, path: 'linked-other-type', reason: 'directory_not_in_own_subject' };
}

/** `prek:virtue_outline` → `outline`。自建文件夹（`.custom_x`）不在官方后缀表里。 */
function codeSuffixOf(node) {
  const last = String(node.code).split(':').pop() ?? '';
  const i = last.lastIndexOf('_');
  return i === -1 ? last : last.slice(i + 1);
}

/**
 * 科目 / 子科节点下，那个资料夹子节点。
 *
 * 先按 **code 后缀**（稳定）找，找不到才退回按 **显示名**（可改）找。
 * 两种都找不到 = 目录树还没铺到这一层；两条路各命中一个不同的节点 = 真歧义。
 * 返回 `{ node, by: 'code' | 'name' }` / `null` / `'AMBIGUOUS'`。
 */
function findFolder(owner, def) {
  const kids = (index.children.get(owner.id) ?? []).filter((k) => k.type === 'folder');
  const byCode = kids.filter((k) => codeSuffixOf(k) === def.codeSuffix);
  const byName = kids.filter((k) => k.name === def.pdfFolder);
  const pick = byCode.length > 0 ? byCode : byName;
  if (pick.length === 0) return null;
  if (pick.length > 1) return 'AMBIGUOUS';
  // 两条路指向不同节点 —— 位置本身有矛盾，不替它选。
  if (byCode.length === 1 && byName.length === 1 && byCode[0].id !== byName[0].id) return 'AMBIGUOUS';
  return { node: pick[0], by: byCode.length > 0 ? 'code' : 'name' };
}

/**
 * 一行资源 → 一个结论。
 * `reason` 为 null 表示"判断出来了"；非 null 表示"判断不出来，且这是原因"。
 * `bucket` 只有三个取值，且三者之和必须等于在用总行数（第 6 节会断言）。
 */
function classify(row) {
  const out = {
    bucket: 'undecidable', // exact | subject_only | undecidable
    reason: null,
    ownerPath: null,
    owner: null,
    pdfFolder: null,
    targetFolder: null,
    linked: row.directory_id !== null,
  };

  const def = FOLDER_BY_KEY.get(row.folder_type);
  if (!def) {
    out.reason = 'unknown_folder_type';
    return out;
  }
  out.pdfFolder = def.pdfFolder;
  if (def.pdfFolder === null) {
    out.reason = 'no_pdf_counterpart';
    return out;
  }

  if (row.directory_id !== null) {
    const link = resolveByLink(row);
    out.ownerPath = link.path;
    out.owner = link.node;
    if (link.reason) {
      out.reason = link.reason;
      return out;
    }
    if (link.folder && !link.folder.enabled) {
      out.reason = 'directory_disabled';
      return out;
    }
    if (!link.node.enabled) {
      out.reason = 'directory_disabled';
      return out;
    }
    // 归属与资源自身元数据必须一致。不一致就是数据里的矛盾，不能替它选一边。
    const tuple = resolveByTuple(row);
    if (tuple.node && tuple.node.id !== link.node.id) {
      out.reason = 'linked_to_other_subject';
      return out;
    }
    const target = findFolder(link.node, def);
    if (target === null) {
      out.reason = 'folder_not_in_tree';
      return out;
    }
    if (target === 'AMBIGUOUS') {
      out.reason = 'folder_ambiguous';
      return out;
    }
    out.targetFolder = target.node.code;
    out.targetFolderMatchedBy = target.by;
    if (link.folder) {
      // 已挂在资料夹层：认定标准是"它**就是**那个节点"，不是"名字看起来对"。
      if (link.folder.id !== target.node.id) {
        out.reason = 'folder_under_other_subject';
        return out;
      }
      out.bucket = 'exact';
      return out;
    }
    // 已挂在科目 / 子科层 —— 目标资料夹唯一确定，但**还没挂上去**。
    out.bucket = 'subject_only';
    return out;
  }

  // directory_id 为 NULL：只能靠元组定位。
  const tuple = resolveByTuple(row);
  out.ownerPath = tuple.path;
  out.owner = tuple.node;
  if (!tuple.node) {
    out.reason = 'subject_unresolved';
    return out;
  }
  if (!tuple.node.enabled) {
    out.reason = 'directory_disabled';
    return out;
  }
  const target = findFolder(tuple.node, def);
  if (target === null) {
    out.reason = 'folder_not_in_tree';
    return out;
  }
  if (target === 'AMBIGUOUS') {
    out.reason = 'folder_ambiguous';
    return out;
  }
  out.targetFolder = target.node.code;
  out.targetFolderMatchedBy = target.by;
  out.bucket = 'subject_only';
  return out;
}

const classified = resRows.map((row) => ({ row, result: classify(row) }));
const activeRows = classified.filter((c) => c.row.deleted_at === null);
const deletedRows = classified.filter((c) => c.row.deleted_at !== null);

// =============================================================================
// 5. 汇总
// =============================================================================

const countBucket = (list, bucket) => list.filter((c) => c.result.bucket === bucket).length;

const totals = {
  total: activeRows.length,
  exact: countBucket(activeRows, 'exact'),
  subjectOnly: countBucket(activeRows, 'subject_only'),
  undecidable: countBucket(activeRows, 'undecidable'),
};
totals.sumCheck = totals.exact + totals.subjectOnly + totals.undecidable;

const recycleBin = {
  total: deletedRows.length,
  exact: countBucket(deletedRows, 'exact'),
  subjectOnly: countBucket(deletedRows, 'subject_only'),
  undecidable: countBucket(deletedRows, 'undecidable'),
};
recycleBin.sumCheck = recycleBin.exact + recycleBin.subjectOnly + recycleBin.undecidable;

const activeLinked = activeRows.filter((c) => c.result.linked).length;
const activeUnlinked = totals.total - activeLinked;

/** 每个 folder_type（含数据里出现但定义表里没有的值）一行。 */
const byFolderType = (() => {
  const keys = new Set([...resRows.map((r) => r.folder_type), ...FOLDER_DEFINITIONS.map((d) => d.key)]);
  return [...keys]
    .map((key) => {
      const def = FOLDER_BY_KEY.get(key);
      const rows = activeRows.filter((c) => c.row.folder_type === key);
      const exact = rows.filter((c) => c.result.bucket === 'exact').length;
      const subjectOnly = rows.filter((c) => c.result.bucket === 'subject_only').length;
      const undecidable = rows.filter((c) => c.result.bucket === 'undecidable').length;
      return {
        folderType: key,
        label: def ? def.name : '(未定义)',
        pdfFolder: def ? def.pdfFolder : null,
        count: rows.length,
        withDirectoryId: rows.filter((c) => c.result.linked).length,
        exact,
        subjectOnly,
        undecidable,
        autoLocatable: exact + subjectOnly,
        inRecycleBin: deletedRows.filter((c) => c.row.folder_type === key).length,
      };
    })
    .sort((a, b) => b.count - a.count || a.folderType.localeCompare(b.folderType));
})();

/** 归属是怎么定下来的 —— 让"已挂科目 N 行"这个数字可核查，而不是一个断言。 */
const byOwnerPath = (() => {
  const labels = {
    'linked-subject': '已挂到科目 / 子科节点（数据库事实，未重新推断）',
    'linked-folder': '已挂到资料夹节点（数据库事实）',
    'linked-other-type': '已挂到非科目层节点',
    'linked-dangling': 'directory_id 悬空',
    'code-exact': '未挂，元组与目录 code 完全一致',
    'code-ancestor': '未挂，只命中更浅的科目节点（子科节点在树里不存在）',
    'legacy-alias': '未挂，按 0012 声明的历史科目别名定位',
    unresolved: '未挂，定位不到任何节点',
  };
  const seen = new Map();
  for (const c of activeRows) {
    const p = c.result.ownerPath ?? '(未走到定位)';
    if (!seen.has(p)) seen.set(p, { path: p, label: labels[p] ?? p, count: 0, linked: 0 });
    const entry = seen.get(p);
    entry.count += 1;
    if (c.result.linked) entry.linked += 1;
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
})();

/**
 * 目标资料夹是**靠 code 后缀**认出来的，还是退回**靠显示名**认出来的。
 * 退回次数 > 0 说明树上出现了后缀不合规的资料夹节点（例如管理员自建了一个同名节点），
 * 这是需要人看一眼的信号 —— 不是错误，但也不能悄悄发生。
 */
const targetMatchStats = (() => {
  const stats = { code: 0, name: 0, none: 0 };
  for (const c of activeRows) {
    const by = c.result.targetFolderMatchedBy;
    if (by === 'code') stats.code += 1;
    else if (by === 'name') stats.name += 1;
    else stats.none += 1;
  }
  return stats;
})();

/**
 * 官方资料夹节点里，显示名与 PDF 名不一致的那些。
 *
 * `name` 是管理员可改的显示名（目录树号称"可编辑"就必然如此），所以这**不是错误**，
 * 也不影响判定（判定看 code 后缀）。列出来只是为了让人看见"名字已经和 PDF 不一样了"，
 * 免得下一个读报告的人以为是自己对不上。
 */
const renamedOfficialFolders = (() => {
  const out = [];
  for (const d of dirRows) {
    if (d.type !== 'folder' || !d.enabled) continue;
    const pdfName = PDF_FOLDER_BY_CODE_SUFFIX.get(codeSuffixOf(d));
    if (!pdfName || d.name === pdfName) continue;
    out.push({ code: d.code, name: d.name, nameEn: d.name_en, expected: pdfName });
  }
  return out;
})();

function sampleOf({ row, result }) {
  return {
    id: row.id,
    title: row.title,
    program: row.program,
    subject: row.subject,
    subSubject: row.sub_subject,
    folderType: row.folder_type,
    directoryId: row.directory_id,
    ownerPath: result.ownerPath,
    pdfFolder: result.pdfFolder,
  };
}

/** 每个原因命中几行 + 有上限的样例。 */
function ambiguityGroups(list) {
  const groups = [];
  for (const reason of REASONS) {
    const hits = list.filter((c) => c.result.reason === reason.id);
    if (hits.length === 0) continue;
    groups.push({
      ...reason,
      count: hits.length,
      sample: hits.slice(0, SAMPLE_CAP).map(sampleOf),
    });
  }
  return groups;
}

/** 库里有资源、但目录树里根本没有节点的那些组合 —— 决定"还差哪些节点"。 */
const missingNodes = (() => {
  const seen = new Map();
  for (const { row, result } of activeRows) {
    if (result.reason !== 'subject_unresolved' && result.reason !== 'folder_not_in_tree') continue;
    const key = `${row.program}/${row.subject}/${row.sub_subject ?? '-'}`;
    if (!seen.has(key)) seen.set(key, { tuple: key, reason: result.reason, count: 0 });
    seen.get(key).count += 1;
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
})();

const activeAmbiguities = ambiguityGroups(activeRows);
const recycleAmbiguities = ambiguityGroups(deletedRows);
const generatedAtLocal = new Date().toISOString();

// =============================================================================
// 6. 自校验 —— 数字不对就不要出报告
// =============================================================================

const problems = [];
if (totals.sumCheck !== totals.total) {
  problems.push(`三个分档之和 ${totals.sumCheck} 不等于总资源 ${totals.total}`);
}
if (recycleBin.sumCheck !== recycleBin.total) {
  problems.push(`回收站三个分档之和 ${recycleBin.sumCheck} 不等于 ${recycleBin.total}`);
}
if (totals.total !== rawCounts.rows_active) {
  problems.push(`JS 归类出的在用资源 ${totals.total} 不等于 SQL 直接数出来的 ${rawCounts.rows_active}`);
}
if (recycleBin.total !== rawCounts.rows_deleted) {
  problems.push(`回收站 ${recycleBin.total} 不等于 SQL 直接数出来的 ${rawCounts.rows_deleted}`);
}
if (activeLinked !== rawCounts.active_linked) {
  problems.push(`有 directory_id 的行数 ${activeLinked} 不等于 SQL 直接数出来的 ${rawCounts.active_linked}`);
}
if (activeUnlinked !== rawCounts.active_unlinked) {
  problems.push(`无 directory_id 的行数 ${activeUnlinked} 不等于 SQL 直接数出来的 ${rawCounts.active_unlinked}`);
}
if (STATEMENT_LOG.some((k) => k !== 'select')) {
  problems.push('本次运行执行过非 SELECT 语句 —— 这不该发生');
}

if (problems.length > 0) {
  sql.end({ timeout: 1 }).catch(() => {});
  die(`自校验失败，不出报告：\n  - ${problems.join('\n  - ')}`, 1);
}

// =============================================================================
// 7. Markdown 片段
// =============================================================================

/** Markdown 表格里的 `|` 必须转义，否则一条带竖线的标题就能把整张表拆掉。 */
const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const clip = (v, n) => {
  const s = String(v ?? '');
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
};

const mappingTable = (() => {
  const head =
    '| `folder_type` | 历史中文名 | `nameEn` | 映射到的 PDF 资料夹 | 资料夹 `code` 后缀 | PDF 英文名 | 树里的资料夹节点数 | 本库在用行数 |\n' +
    '| --- | --- | --- | --- | --- | --- | ---: | ---: |';
  const body = FOLDER_DEFINITIONS.map((d) => {
    // 节点数按 **code 后缀**统计：显示名可以被管理员改，用它统计会随改名变化。
    const folderNodes = dirRows.filter(
      (x) => x.type === 'folder' && PDF_FOLDER_BY_CODE_SUFFIX.get(codeSuffixOf(x)) === d.pdfFolder,
    );
    const count = activeRows.filter((c) => c.row.folder_type === d.key).length;
    return (
      `| \`${d.key}\` | ${d.name} | ${d.nameEn} | ${d.pdfFolder ?? '**无对应（不映射）**'} | ` +
      `${d.codeSuffix ? `\`_${d.codeSuffix}\`` : '—'} | ${d.pdfFolder ? PDF_FOLDER_EN[d.pdfFolder] : '—'} | ` +
      `${folderNodes.length} | ${count} |`
    );
  });
  return [head, ...body].join('\n');
})();

const totalsTable = [
  '| 指标 | 数量 | 口径 |',
  '| --- | ---: | --- |',
  `| 总资源（在用，\`deleted_at IS NULL\`） | ${totals.total} | 下面三行的分母。回收站**不计入**。 |`,
  `| 已精确归档 | ${totals.exact} | \`directory_id\` 指向的**就是**本资源由 \`folder_type\` + 科目唯一确定的那个资料夹节点（按 \`code\` 后缀认定，见第 3.1 节），不是「名字看起来对」。 |`,
  `| 仅归档到科目 | ${totals.subjectOnly} | 科目 / 子科节点已确定（要么 \`directory_id\` 已指向它、要么元组能唯一定位它），\`folder_type\` 也映射到一个真实存在的 PDF 资料夹子节点；**差的只是"挂到资料夹那一层"**。 |`,
  `| 无法自动判断 | ${totals.undecidable} | 共 ${REASONS.length} 类原因，逐条列在第 4 节。绝不替数据猜一个资料夹。 |`,
  `| 三项之和（自校验） | ${totals.sumCheck} | 必须等于总资源 ${totals.total}，否则脚本直接报错、不生成报告。 |`,
  '',
  `> 回收站（软删除）另有 **${recycleBin.total}** 行，**单独统计、不计入上表**（见第 5 节）。`,
  `> 全部行合计 ${rawCounts.rows_total} 行 = 在用 ${rawCounts.rows_active} + 回收站 ${rawCounts.rows_deleted}。`,
].join('\n');

const breakdownTable = (() => {
  const sum = (pick) => byFolderType.reduce((a, r) => a + pick(r), 0);
  const head =
    '| `folder_type` | 历史中文名 | 映射到的 PDF 资料夹 | 资源数 | 已有 `directory_id` | 可自动定位合计 | 其中：已精确归档 | 其中：仅归档到科目 | 无法自动判断 | 回收站中 |\n' +
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |';
  const body = byFolderType.map(
    (r) =>
      `| \`${esc(r.folderType)}\` | ${esc(r.label)} | ${r.pdfFolder ? esc(r.pdfFolder) : '**无对应**'} | ${r.count} | ` +
      `${r.withDirectoryId} | ${r.autoLocatable} | ${r.exact} | ${r.subjectOnly} | ${r.undecidable} | ${r.inRecycleBin} |`,
  );
  const totalRow =
    `| **合计** |  |  | **${sum((r) => r.count)}** | **${sum((r) => r.withDirectoryId)}** | ` +
    `**${sum((r) => r.autoLocatable)}** | **${sum((r) => r.exact)}** | **${sum((r) => r.subjectOnly)}** | ` +
    `**${sum((r) => r.undecidable)}** | **${sum((r) => r.inRecycleBin)}** |`;
  return [head, ...body, totalRow].join('\n');
})();

const ownerPathTable = [
  '| 归属来源 | 行数 | 其中已有 `directory_id` | 说明 |',
  '| --- | ---: | ---: | --- |',
  ...byOwnerPath.map((p) => `| \`${esc(p.path)}\` | ${p.count} | ${p.linked} | ${esc(p.label)} |`),
].join('\n');

function sampleTable(group) {
  const head =
    '| # | `resources.id` | 标题 | 班型 | 科目 | 子科 | `folder_type` | `directory_id` |\n' +
    '| ---: | --- | --- | --- | --- | --- | --- | --- |';
  const body = group.sample.map(
    (s, i) =>
      `| ${i + 1} | \`${esc(s.id)}\` | ${esc(clip(s.title, 40))} | \`${esc(s.program)}\` | \`${esc(s.subject)}\` | ` +
      `${s.subSubject === null ? '—' : `\`${esc(s.subSubject)}\``} | \`${esc(s.folderType)}\` | ` +
      `${s.directoryId === null ? '—（NULL）' : `\`${esc(s.directoryId)}\``} |`,
  );
  return [head, ...body].join('\n');
}

const ambiguityBody = (() => {
  const out = [];
  if (activeAmbiguities.length === 0) {
    out.push(
      `在用资源里**没有任何一行**落进"无法自动判断" —— ${totals.total} 行的目标资料夹全都是确定的。`,
    );
    out.push('');
    out.push(
      `下面把 ${REASONS.length} 条判定规则连同本库的命中数一起列出来，` +
        '这样"为什么是 0"是看得见的（这些规则被逐一检查过），而不是"忘了检查"。',
    );
    out.push('');
    out.push('| 原因 | 命中行数 | 判定规则 |');
    out.push('| --- | ---: | --- |');
    for (const r of REASONS) out.push(`| \`${r.id}\` | 0 | ${r.detail} |`);
  } else {
    activeAmbiguities.forEach((g, i) => {
      out.push(`### 4.${i + 1} \`${g.id}\` — ${g.label}（${g.count} 行）`);
      out.push('');
      out.push(g.detail);
      out.push('');
      out.push(
        `样例 ${g.sample.length} 行（每组上限 ${SAMPLE_CAP} 行）` +
          (g.count > SAMPLE_CAP ? `，另有 ${g.count - SAMPLE_CAP} 行未列出` : '') +
          '：',
      );
      out.push('');
      out.push(sampleTable(g));
      out.push('');
    });
  }
  return out.join('\n');
})();

const missingNodesBlock =
  missingNodes.length === 0
    ? ''
    : [
        '### 4.x 缺的是"目录树还没铺到"，不是"数据有问题"',
        '',
        '| `(program, subject, sub_subject)` | 原因 | 行数 |',
        '| --- | --- | ---: |',
        ...missingNodes.map((m) => `| \`${esc(m.tuple)}\` | \`${m.reason}\` | ${m.count} |`),
        '',
      ].join('\n');

const recycleBody = (() => {
  const out = [];
  const pct = rawCounts.rows_total === 0 ? '0.0' : ((recycleBin.total / rawCounts.rows_total) * 100).toFixed(1);
  out.push(
    `\`deleted_at IS NOT NULL\` 的有 **${recycleBin.total}** 行（占全部 ${rawCounts.rows_total} 行的 ${pct}%）。`,
  );
  out.push('');
  out.push(
    '按业主口径，**软删除的行不参与自动归档**：它们在界面上本来就不可见。' +
      '把它们算进"已归档"会让完成度虚高，算进"无法判断"又会让人以为需要人工处理。' +
      '所以它们只出现在本节。经 `POST /api/resources/:id/restore` 恢复之后，才回到第 2 节的口径。',
  );
  out.push('');
  out.push('| 指标 | 数量 |');
  out.push('| --- | ---: |');
  out.push(`| 回收站总行数 | ${recycleBin.total} |`);
  out.push(`| 其中若按同一套规则归类，会落到"已精确归档" | ${recycleBin.exact} |`);
  out.push(`| 其中会落到"仅归档到科目" | ${recycleBin.subjectOnly} |`);
  out.push(`| 其中会落到"无法自动判断" | ${recycleBin.undecidable} |`);
  out.push('');
  out.push(
    '> "会落到"是按**同一套映射规则**算出来的参考值，不代表这些行应该被归档 ——' +
      '它们处在回收站里，人工处理前要先决定的是"恢复还是清除"，而不是"挂到哪个资料夹"。',
  );
  if (recycleAmbiguities.length > 0) {
    out.push('');
    out.push(`回收站里判断不出来的原因（每组同样最多列 ${SAMPLE_CAP} 行样例）：`);
    for (const g of recycleAmbiguities) {
      out.push('');
      out.push(`\`${g.id}\` —— ${g.label}：**${g.count}** 行`);
      out.push('');
      out.push(sampleTable(g));
    }
  }
  return out.join('\n');
})();

const researchArchiveBody = (() => {
  const inUse = activeRows.filter((c) => c.row.folder_type === 'research_archive').length;
  const inBin = deletedRows.filter((c) => c.row.folder_type === 'research_archive').length;
  return [
    '业主的原话是"PDF 没有对应，不要硬猜"。这个脚本把这句话落成了代码里的 `null`：',
    '`FOLDER_DEFINITIONS` 里 `research_archive.pdfFolder === null`，于是这一类**永远**进"无法自动判断"，',
    '不会因为将来某个人觉得"教研归档 ≈ 教学资源"就被悄悄归档。',
    '',
    '| 指标 | 数量 |',
    '| --- | ---: |',
    `| 在用资源中 \`folder_type = 'research_archive'\` 的行数 | ${inUse} |`,
    `| 回收站中同样值的行数 | ${inBin} |`,
    '| 自动映射到的 PDF 资料夹 | **无**（刻意留空） |',
    '',
    'PDF《教师平台》的 4 个资料夹是：课程大纲 / 教学详案 / 教学资源 / 考核评估。「教研归档」不在其中，',
    '迁移 0012 的注释也是同一个结论（"research_archive→无对应"）。',
    '**要么由业主补一条业务规则，要么由管理员逐条人工归属** —— 在此之前，这些行在目录树上就是"尚未归属"，',
    '而不是被塞进某个看起来最像的资料夹。',
  ].join('\n');
})();

const howToHandleBody = (() => {
  const out = [];
  out.push('### 7.1 先说清楚：`/admin/unassigned-resources` 这个入口在当前代码里**不存在**');
  out.push('');
  out.push('业主希望用 `/admin/unassigned-resources` 处理这些行。核对过 `client/src/app.tsx` 的路由表：');
  out.push('注册的是 `/admin/teachers`、`/admin/permissions`、`/admin/recycle-bin`、`/admin/audit`、`/directory`、`/review`，');
  out.push('**没有** `unassigned-resources`。服务端也没有"列出未归属资源"的接口：');
  out.push('`GET /api/resources?directory=<code>` 只列某个节点**子树内**的资源（`server/modules/resources/resources.service.ts:698`），');
  out.push('而 `server/modules/directories/directories.service.ts:194` 的注释写明"未归属（`directory_id IS NULL`）的资源不属于任何节点，');
  out.push('因此不出现在任何数字里"。');
  out.push('');
  out.push('所以这条路今天走不通 —— 这本身就是一条需要上报的结论，而不是可以绕过去的细节。');
  out.push('');
  out.push('### 7.2 情况比"无法判断"乐观得多');
  out.push('');
  out.push(
    `* 在用资源 ${totals.total} 行里，**${totals.exact + totals.subjectOnly} 行的目标资料夹是完全确定的**` +
      '（`folder_type` + 科目元组唯一确定了一个资料夹节点，见第 3 节）。',
  );
  out.push(`* 其中 ${totals.exact} 行已经挂在资料夹上了。`);
  out.push(
    `* 余下 ${activeLinked} 行已经挂在科目 / 子科节点上，只差"再往下一层挪到资料夹"这一步 ——` +
      '这是**批量**动作，不是逐条判断。',
  );
  out.push(
    `* 另有 ${activeUnlinked} 行连 \`directory_id\` 都还是 NULL，同样只能靠那次批量迁移补齐。`,
  );
  out.push(`* ${totals.undecidable} 行真的需要人工判断。`);
  out.push('');
  out.push('### 7.3 管理员实际能走的三条路');
  out.push('');
  out.push(
    '1. **逐条改：上传页的编辑模式。** `/upload?id=<resourceId>` —— 上传页的编辑表单里有「目录归属」下拉' +
      '（`client/src/pages/Upload/UploadPage.tsx`），保存时走 `PATCH /api/resources/:id`。' +
      `一次一行。只有 ${totals.undecidable + activeUnlinked} 行左右需要这么处理时是可接受的；` +
      `${totals.subjectOnly} 行靠点击完成不现实。`,
  );
  out.push(
    '2. **批量改：一次可评审的迁移。** 既然目标是确定性映射，正确做法是写一条新的 SQL 迁移' +
      '（编号接在 0012 之后），把映射表**显式写进 VALUES**（像 0012 那样，不靠字符串拼接猜），' +
      '并在迁移内部断言回填行数与预期一致、不一致就中止。' +
      '**本报告不提供可直接运行的写入语句** —— 写入必须是一次独立的、可 review、可回滚的改动。',
  );
  out.push(
    '3. **先看：`/directory` 页面。** 它渲染的是数据库里那棵权威目录树，点进任意节点能看到挂在该节点子树下的资源。' +
      '用它核对"某个资料夹下现在到底有什么"，是上面两条路的前置动作。',
  );
  out.push('');
  out.push('### 7.4 处理顺序建议');
  out.push('');
  out.push(
    '1. 先让业主确认 `courseware → 教学资源`、`materials → 教学资源`、`observation → 考核评估`、' +
      '`weekly_plans → 教学详案` 这 4 条映射（理由见第 8.2 节）。',
  );
  out.push('2. 确认后写那次批量迁移，把「仅归档到科目」那批补到资料夹层。');
  out.push(
    totals.undecidable === 0
      ? '3. 第 4 节「无法自动判断」目前是 0 行，暂时没有需要逐条判断的对象；' +
          '重跑后这个数一旦变大，就按第 4 节列出的原因逐条处理。`research_archive` 单独等业务规则。'
      : `3. 剩下的 ${totals.undecidable} 行按第 4 节的原因逐条处理；\`research_archive\` 单独等业务规则。`,
  );
  out.push(
    '4. 处理完重跑本脚本 —— 数字应该变成"已精确归档 ↑、仅归档到科目 ↓"，而不是"总数变了"。' +
      '总数变了就说明有东西被删了，要停下来查。',
  );
  out.push('');
  out.push('### 7.5 需要完整清单时，用这段只读 SQL 自己拉');
  out.push('');
  out.push('下面这段**只读**，可以随便跑。它和本脚本用的是同一套判断，只是把结果直接吐出来：');
  out.push('');
  out.push('```sql');
  out.push('-- 未归属（directory_id IS NULL）的在用资源，按科目 + folder_type 分组计数');
  out.push('SELECT program, subject, sub_subject, folder_type, count(*)');
  out.push('  FROM resources');
  out.push(' WHERE deleted_at IS NULL AND directory_id IS NULL');
  out.push(' GROUP BY 1, 2, 3, 4');
  out.push(' ORDER BY 5 DESC;');
  out.push('');
  out.push('-- 只挂到科目节点、还没挂到资料夹节点上的在用资源');
  out.push('SELECT r.id, r.title, r.folder_type, d.code AS current_node');
  out.push('  FROM resources r');
  out.push('  JOIN directories d ON d.id = r.directory_id');
  out.push(' WHERE r.deleted_at IS NULL');
  out.push("   AND d.type IN ('subject', 'sub_subject')");
  out.push(' ORDER BY d.code, r.folder_type;');
  out.push('```');
  return out.join('\n');
})();

const caveatsBody = [
  '### 8.1 没有做的事',
  '',
  '* **没有改任何数据。** 全部取数走 `roRead`（断言以 `select` 开头），连接带 `default_transaction_read_only = on`，',
  '  脚本结束会打印本次执行了多少条 SQL、首关键字是什么。',
  '* **没有替 `research_archive` 猜一个资料夹。** 见第 6 节。',
  '* **没有把软删除的行算进在用口径。** 见第 5 节。',
  '* **没有断言"这个映射是唯一正确答案"。** 第 1.2 节的映射表来自业主本轮的指令；',
  '  它与仓库里 0012 的注释不一致，两者谁说了算需要人确认。',
  '* **没有读标题、描述等自由文本。** 判断只用 `folder_type` + `(program, subject, sub_subject)`。',
  '',
  '### 8.2 需要业主确认的三件事',
  '',
  '1. **0012 的注释与本轮指令冲突。** `0012_resource_directory.sql:27-36` 明确写着：',
  '   "只有 `curriculum_outline→outline` 是同名，其余（`courseware→?`、`weekly_plans→lesson?`、',
  '   `observation→assessment?`、`research_archive→无对应`）都需要业务判断，PDF 没有规定"，',
  '   所以当时**一律留 NULL**。本报告按业主本轮的指令给出了映射。这不算矛盾（是先后关系），',
  '   但改数据前应该由同一个人显式确认一次，并把 0012 的注释一并更新，',
  '   否则下一个读代码的人会以为它是错的。',
  '2. **两个历史值并进同一个 PDF 资料夹，映射不可逆。** `courseware`（课件与示范）和 `materials`（素材与工作单）',
  '   都映射到「教学资源」。归档之后光看目录树，分不出某份资源原来是课件还是素材。',
  '   如果这个区分对老师重要，PDF 的 4 个资料夹就不够用 —— 这是需要业务决定的事，脚本决定不了。',
  '3. **历史名与 PDF 名不同名，容易读错。** `weekly_plans` 的历史中文名是「周次教案」，PDF 资料夹叫「教学详案」；',
  '   `observation` 的历史中文名是「观察与评价」，PDF 资料夹叫「考核评估」。',
  '   名字不同但含义相近，最容易发生的是"看起来已经归档了，其实挂错了"。',
  '   确认时请按 **key**（英文 token）确认，不要按中文名确认。',
  '',
  '### 8.3 本报告读不出来的东西',
  '',
  '* 目录树里**没有科目节点**的组合，本报告只能报"定位不到"。',
  '  要判断是"节点该建"还是"资源的科目填错了"，需要业务输入，数据库本身给不出答案。',
  '* 本报告判断不了"资源内容与它的 `folder_type` 是否相符"。',
  '  它只回答"按现有元数据能归档到哪里"，不回答"这个元数据填得对不对"。',
].join('\n');

// =============================================================================
// 8. Markdown 全文
// =============================================================================

const markdown = [
  '# 历史资源 → 可编辑目录树 迁移盘点报告',
  '',
  '> **本报告只读，不代表任何数据被修改。** 生成它的脚本',
  '> `scripts/report-legacy-directory-migration.mjs` 与数据库的唯一通道只接受 `select` 语句，',
  '> 连接本身带 `default_transaction_read_only = on`，全程不执行 `INSERT` / `UPDATE` / `DELETE` / DDL。',
  '> 报告中出现的修复 SQL 都只是**参考文本**，脚本不会执行它们。需要改数据时请另写一次可评审的迁移。',
  '',
  '## 1. 这份报告是什么',
  '',
  '资源历史上带一个 6 值的 `folder_type`（定义在 `shared/curriculum.ts` 的 `FOLDER_DEFINITIONS`）。',
  '0009 / 0010 把 PDF《教师平台》的目录树搬进了 `directories` 表，0012 又给 `resources` 加了 `directory_id`，',
  '但**只回填到科目节点**，资料夹层级刻意留空（`0012_resource_directory.sql` 的 BACKFILL 段）。',
  '',
  '于是"迁移完成度"不能被感觉回答。这份报告把它变成可核对的数字：',
  '哪些已经精确到资料夹、哪些只到科目、哪些根本无法自动判断 —— 并把判断不出来的**连同原因**列出来。',
  '它不替数据猜一个资料夹，也不把"不知道"混进"已完成"。',
  '',
  '### 1.1 运行环境',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  `| 数据来源 | ${identity.artifact === undefined ? '**直连数据库**' : `**离线导出产物** \`${identity.artifact.path}\`（未连库）`} |`,
  `| 数据库主机 | ${identity.artifact === undefined ? `\`${TARGET.host}\`` : '(不适用 —— 本模式连库都不连)'} |`,
  `| 数据库名 | \`${identity.database}\` |`,
  `| 连接用户 | \`${identity.db_user}\` |`,
  `| 生成时刻（本机） | ${generatedAtLocal} |`,
  `| 数据库时刻 | ${identity.db_now.toISOString()}（时区 ${identity.db_tz}） |`,
  `| 会话只读 | \`${identity.read_only}\` |`,
  `| 本次执行 SQL 条数 | ${STATEMENT_LOG.length}（首关键字：${[...new Set(STATEMENT_LOG)].join(' / ')}） |`,
  ...(identity.artifact === undefined
    ? []
    : [
        `| 产物 sha256 | \`${identity.artifact.sha256}\` |`,
        `| 产物字节数 | ${identity.artifact.bytes} |`,
        `| 产物导出时刻 | ${identity.artifact.createdAt ?? '(未声明)'} |`,
        `| 产物格式版本 | ${identity.artifact.formatVersion ?? '(未声明)'} |`,
        `| 行数核对 | ${identity.artifact.integrity} |`,
        '',
        '> **这一份是生产口径的报告**：数字来自上面那个 sha256 对应的字节。',
        '> 本模式**连数据库都没连**，因此不可能改动任何数据。',
        '> 但有一条保障是它**没有**的，必须说清楚：连库模式用"聚合 SQL"与"JS 归类"',
        '> 两套**独立实现**互相验证；离线模式只能核对同一份文件里的三处自述',
        '> （table 行 / footer / 实际解析行数）。它能抓"文件被截断"，',
        '> 抓不到"导出时就导错了"。要对齐后者，请在真实的库上再跑一次连库模式。',
      ]),
  '',
  '> 连接串本身（含密码）**不会**出现在本报告或终端输出里，这里只有主机与库名。',
  '',
  '### 1.2 映射表（第 2 节起的所有数字都基于它）',
  '',
  mappingTable,
  '',
  '`research_archive` 的 `pdfFolder` 是 `null`：PDF 的 4 个资料夹里没有它的对应，**刻意不映射**（见第 6 节）。',
  '',
  '## 2. 四个总数',
  '',
  totalsTable,
  '',
  '### 2.1 先看这三句话，否则上面的数字会被读反',
  '',
  `1. **「已精确归档 = ${totals.exact}」不等于「什么都没有归属」。** 它说的是"精确到资料夹层级的有 ${totals.exact} 行"。`,
  `   库里 ${activeLinked} 行资源已经挂在目录树上，只是**挂在科目节点上，不在资料夹节点上** ——`,
  '   这正是 migration 0012 当时的刻意选择（只回填科目层，见第 8.2 节）。',
  `2. **「仅归档到科目 = ${totals.subjectOnly}」里的绝大多数已经挂在科目节点上了。**`,
  `   未挂 \`directory_id\` 的只有 ${activeUnlinked} 行。两者都只精确到"科目"，所以并进同一档；`,
  '   差别在第 3.1 节的归属来源表里分开列。',
  totals.undecidable === 0
    ? `3. **「无法自动判断 = 0」不是"没检查"，是 ${REASONS.length} 条判定规则逐一跑过、确实一条都没命中。** ` +
      '规则本身与命中数都在第 4 节，可以自己核对。'
    : `3. **「无法自动判断 = ${totals.undecidable}」是真的判断不出来，不是"懒得判断"。** 原因逐条列在第 4 节。`,
  '',
  '## 3. 按 `folder_type` 分解',
  '',
  breakdownTable,
  '',
  '**列的含义**：`资源数` = 在用行数；`已有 directory_id` = 该列非 NULL 的行数；',
  '`可自动定位合计` = `已精确归档` + `仅归档到科目`（目标资料夹能被确定的行数）；',
  '`无法自动判断` 与 `回收站中` 互不重叠 —— 后者不计入任何一档。',
  '',
  '### 3.1 归属是怎么定下来的',
  '',
  `为了让「仅归档到科目 = ${totals.subjectOnly}」这个数字可核查、而不是一句断言，`,
  '这里列出每一行的归属**来源**。`linked-*` 是数据库里既有的事实（没有重新推断），`code-*` 是从元组推出来的。',
  '',
  ownerPathTable,
  '',
  `目标资料夹的定位方式：**靠 \`code\` 后缀**认出 ${targetMatchStats.code} 行；` +
    `退回靠**显示名**认出 ${targetMatchStats.name} 行。`,
  '`code` 是稳定标识（唯一索引，改不了），显示名是管理员可以随手改的 —— ' +
    '所以判定看后缀、名字只用来核对。退回数为 0 说明这棵树和后缀约定是一致的。',
  '',
  renamedOfficialFolders.length === 0
    ? '官方资料夹节点的显示名目前与 PDF 名完全一致（没有改名过）。'
    : [
        `**树里有 ${renamedOfficialFolders.length} 个官方资料夹的显示名与 PDF 名不一样** —— ` +
          '这不影响判定（判定看 `code` 后缀），但要让人看见，免得以后误以为对不上：',
        '',
        '| 节点 `code` | 现在的显示名 | PDF 里的名字 |',
        '| --- | --- | --- |',
        ...renamedOfficialFolders.map(
          (f) => `| \`${esc(f.code)}\` | ${esc(f.name)} | ${esc(f.expected)} |`,
        ),
      ].join('\n'),
  '',
  '## 4. 无法自动判断的行：按原因分组',
  '',
  `**每个原因最多列 ${SAMPLE_CAP} 行样例，超出只报数量。** 报告不是数据导出：`,
  '把上万行贴进来，只会让真正需要处理的那几条淹掉。完整清单请用第 7.5 节的只读 SQL 自己取。',
  '',
  ambiguityBody,
  '',
  ...(missingNodesBlock === '' ? [] : [missingNodesBlock]),
  '## 5. 回收站（软删除）—— 单独统计，不计入第 2 节的四个总数',
  '',
  recycleBody,
  '',
  '## 6. `research_archive`（教研归档）：PDF 里没有对应资料夹，因此**不做任何自动映射**',
  '',
  researchArchiveBody,
  '',
  '## 7. 如何人工处理',
  '',
  howToHandleBody,
  '',
  '## 8. 本报告没有做的事，以及需要业主确认的三件事',
  '',
  caveatsBody,
  '',
  '---',
  '',
  '本报告由 `scripts/report-legacy-directory-migration.mjs` 生成，重跑会覆盖同名文件。',
  '若数字与预期不符，先怀疑数据，不要先怀疑脚本。',
  '',
].join('\n');

// =============================================================================
// 9. 终端输出
// =============================================================================

const pad = (v, n) => String(v).padEnd(n, ' ');
const lpad = (v, n) => String(v).padStart(n, ' ');

say('');
say('=== 历史资源 → 可编辑目录树 的迁移盘点（只读）===');
say(
  identity.artifact === undefined
    ? `  库：${TARGET.host}/${identity.database}    用户：${identity.db_user}`
    : `  来源：离线导出产物 ${identity.artifact.path}（sha256 ${identity.artifact.sha256.slice(0, 16)}…，未连库）`,
);
say(`  生成时刻（本机）：${generatedAtLocal}`);
say(`  数据库时刻：${identity.db_now.toISOString()}    时区：${identity.db_tz}`);
say(`  会话只读（default_transaction_read_only）：${identity.read_only}`);
say('');
say('  四个总数（口径：deleted_at IS NULL）');
say(`    总资源        ${lpad(totals.total, 6)}`);
say(`    已精确归档    ${lpad(totals.exact, 6)}   （已挂在资料夹节点上）`);
say(`    仅归档到科目  ${lpad(totals.subjectOnly, 6)}   （目标资料夹可定，但还没挂到资料夹层）`);
say(`    无法自动判断  ${lpad(totals.undecidable, 6)}`);
say(`    三项之和      ${lpad(totals.sumCheck, 6)}   ${totals.sumCheck === totals.total ? 'OK' : '不一致'}`);
say(`    回收站（不计入上面四个数）  ${lpad(recycleBin.total, 6)}`);
say(`    全部行合计    ${lpad(rawCounts.rows_total, 6)}`);
say('');
say('  按 folder_type');
say(
  `    ${pad('folder_type', 20)} ${pad('PDF 资料夹', 12)} ${lpad('资源数', 7)} ${lpad('有目录', 7)} ` +
    `${lpad('可定位', 7)} ${lpad('精确', 6)} ${lpad('仅科目', 7)} ${lpad('判断不出', 9)}`,
);
for (const r of byFolderType) {
  say(
    `    ${pad(r.folderType, 20)} ${pad(r.pdfFolder ?? '（无对应）', 12)} ${lpad(r.count, 7)} ` +
      `${lpad(r.withDirectoryId, 7)} ${lpad(r.autoLocatable, 7)} ${lpad(r.exact, 6)} ` +
      `${lpad(r.subjectOnly, 7)} ${lpad(r.undecidable, 9)}`,
  );
}
say('');
say('  归属是怎么定下来的（在用资源）');
for (const p of byOwnerPath) {
  say(`    ${pad(p.path, 20)} ${lpad(p.count, 5)}   ${p.label}`);
}
say('');
if (activeAmbiguities.length === 0) {
  say(`  无法自动判断：在用资源里一条都没有（${REASONS.length} 条判定规则全部检查过）。`);
} else {
  say('  无法自动判断的原因');
  for (const g of activeAmbiguities) {
    say(`    ${pad(g.id, 32)} ${lpad(g.count, 5)}   ${g.label}`);
  }
}
if (recycleAmbiguities.length > 0) {
  say('');
  say('  回收站里判断不出来的原因（单独统计，不计入上面的数）');
  for (const g of recycleAmbiguities) {
    say(`    ${pad(g.id, 32)} ${lpad(g.count, 5)}   ${g.label}`);
  }
}
say('');
say(`  本次共执行 ${STATEMENT_LOG.length} 条 SQL，首关键字：${[...new Set(STATEMENT_LOG)].join(' / ')}`);
say('  报告里给出的修复 SQL 只是参考文本，本脚本不会执行它们。');

// =============================================================================
// 10. 落盘
// =============================================================================

const relPath = (p) => (p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p);

try {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, markdown, 'utf8');
} catch (error) {
  sql.end({ timeout: 1 }).catch(() => {});
  die(`写不出报告：${error instanceof Error ? error.message : String(error)}`, 1);
}

if (JSON_OUT !== null) {
  const payload = {
    kind: 'legacy-resource-directory-migration-census',
    readOnly: true,
    generatedAt: generatedAtLocal,
    database: {
      host: TARGET.host,
      name: identity.database,
      user: identity.db_user,
      now: identity.db_now.toISOString(),
      sessionReadOnly: identity.read_only,
    },
    mapping: FOLDER_DEFINITIONS,
    totals,
    totalsIncludingRecycleBin: {
      total: rawCounts.rows_total,
      exact: totals.exact + recycleBin.exact,
      subjectOnly: totals.subjectOnly + recycleBin.subjectOnly,
      undecidable: totals.undecidable + recycleBin.undecidable,
    },
    recycleBin,
    rawCounts,
    byFolderType,
    byOwnerPath,
    targetMatchStats,
    renamedOfficialFolders,
    ambiguities: activeAmbiguities,
    recycleBinAmbiguities: recycleAmbiguities,
    missingNodes,
    statements: { count: STATEMENT_LOG.length, keywords: [...new Set(STATEMENT_LOG)] },
  };
  try {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    sql.end({ timeout: 1 }).catch(() => {});
    die(`写不出 JSON：${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

say('');
say(`  已写出：${relPath(OUT)}${existsSync(OUT) ? '' : '（警告：写盘后找不到该文件）'}`);
if (JSON_OUT !== null) say(`  已写出：${relPath(JSON_OUT)}`);
say('');

await sql.end({ timeout: 5 });
process.exit(0);
