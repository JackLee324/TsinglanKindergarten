/**
 * tests/integration/migration-v1.test.mjs —— V1 → V2 迁移的验收（阶段 9）
 * ============================================================================
 * 规则书：`docs/V1_MIGRATION.md`。这一份测的是**规则真的生效了**，而且分两段：
 *
 *   A. 合成夹具（`tests/helpers/v1-fixture.mjs`）：真实 V1 库里**碰不到**的那些路径 ——
 *      subject_permissions 转换、deny 覆盖、没有用户名、没有口令、文件对象、
 *      无目录归属、V1 没有写原因的退回。这些路径一旦在生产库里出现，
 *      就是"数据丢失去处"，所以不能因为本机数据没触发就不测。
 *
 *   B. 真实 V1 库（`qls_test_0005`，348 条资源 / 7651 条审计）：迁移能不能在
 *      **真实脏数据**上站住 —— 孤儿操作者、MFA 历史动作、346 条资源挂在
 *      一个没有用户名的种子账号上。真实库不在时这一整段会失败而不是跳过，
 *      因为"跳过"会让阶段门禁说谎。
 *
 * 门禁里最重要的三条断言，都在这份文件里：
 *   · **幂等**：连跑两次，第二次一条也不新增（且不覆盖管理员的修改）；
 *   · **V1 没被动过**：迁移前后源库快照逐表 sha256 一致；
 *   · **没有权限扩大**：迁移不产生任何 V1 里不存在的授权。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TEST_DB_URL,
  adminSql,
  client,
  createAdmin,
  resetDatabase,
  runProjectScriptCaptured,
  runProjectScriptFailure,
  startServer,
  stopServer,
} from '../helpers/harness.mjs'
import {
  ADMIN_URL, FIXTURE_IDS, KNOWN, REAL_FILE, buildV1Fixture, deleteUnassignedResource,
  insertUnassignedResource,
} from '../helpers/v1-fixture.mjs'
import postgres from 'postgres'

/** 真实的 V1 库（本机；缺失时下面的"真实数据"一段会红，而不是跳过）。 */
const REAL_V1_URL =
  process.env.V1_REAL_DATABASE_URL ??
  'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005'

let fixture
let importStorage

/** 跑一次导入（默认走夹具）。 */
async function importOnce(extraArgs = [], env = {}) {
  return runProjectScriptCaptured(
    'scripts/import-v1.mjs',
    { NODE_ENV: 'test', V2_ALLOW_DEV_SECRETS: '1', STORAGE_PROVIDER: 'local', STORAGE_LOCAL_DIR: importStorage, ...env },
    ['--source', fixture.url, '--target', TEST_DB_URL, ...extraArgs],
  )
}

async function importExpectFailure(extraArgs = [], env = {}) {
  return runProjectScriptFailure(
    'scripts/import-v1.mjs',
    { NODE_ENV: 'test', V2_ALLOW_DEV_SECRETS: '1', STORAGE_PROVIDER: 'local', STORAGE_LOCAL_DIR: importStorage, ...env },
    ['--source', fixture.url, '--target', TEST_DB_URL, ...extraArgs],
  )
}

function withSql(fn) {
  const sql = adminSql()
  return Promise.resolve(fn(sql)).finally(() => sql.end({ timeout: 5 }))
}

before(async () => {
  await resetDatabase()
  fixture = await buildV1Fixture()
  importStorage = mkdtempSync(join(tmpdir(), 'v2-import-storage-'))
})

after(async () => {
  await stopServer()
})

describe('A. 合成夹具：规则逐条生效', () => {
  let beforeSnapshot = null

  test('第一次导入：数字对得上', async () => {
    const { snapshot } = await import('../../scripts/v1-snapshot.mjs')
    beforeSnapshot = await snapshot(fixture.url)

    const fixtureImportOut = await importOnce([
      '--v1-storage', `local:${fixture.storageDir}`,
      '--allow-partial',
      '--unassigned', '/tmp/v2-unassigned-probe.md',
      '--report', '/tmp/v2-migration-probe.md',
    ])

    assert.match(fixtureImportOut, /迁移完成/, '第一次导入应当正常完成')
    const counts = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT (SELECT count(*)::int FROM users) AS users,
               (SELECT count(*)::int FROM directories) AS directories,
               (SELECT count(*)::int FROM resources) AS resources,
               (SELECT count(*)::int FROM resource_files) AS files,
               (SELECT count(*)::int FROM resource_reviews) AS reviews,
               (SELECT count(*)::int FROM audit_logs) AS audit,
               (SELECT count(*)::int FROM user_permissions) AS permissions`
      return row
    })
    // 夹具里 5 个老师 + 1 个建出来准备登录的账号（下面 startServer 之后才建）
    assert.equal(counts.users, 5, 'V1 的 5 个账号都要搬过来')
    assert.equal(counts.resources, 6, '6 条资源（其中一条声称有文件但源里没有）')
    // 审核记录 3 条（两条属于时间线、一条没有原因）+ 审计里的 2 次提交 = 5 条时间线事件
    assert.equal(counts.reviews, 5, '审核记录 3 条 + 提交 2 次 = 5 条时间线事件')
    assert.equal(counts.audit, 6, '6 条审计一条不少')
    assert.equal(counts.permissions, 1, '只有一条 V1 授权能转换')
    assert.equal(counts.files, 1, '只有 1 个真实文件对象能搬')
  })

  test('目录：同名的对齐，V1 独有的（活动）被建出来', async () => {
    const rows = await withSql((sql) => sql`
      SELECT d.slug, d.name, p.slug AS parent_slug
      FROM directories d LEFT JOIN directories p ON p.id = d.parent_id
      WHERE d.name IN ('活动', '美德', 'Pre-K', 'L1 基础规范')
      ORDER BY d.name`)
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
    assert.equal(byName['活动'].slug, 'activity', 'V1 独有的目录要按 code 规整出 slug')
    assert.equal(byName['活动'].parent_slug, 'education', '要挂在映射后的父节点下')
    assert.equal(byName['美德'].slug, 'virtue', '同名节点必须对齐到 V2 seed 的节点')
    assert.equal(byName['Pre-K'].slug, 'pre-k')
    assert.equal(byName['L1 基础规范'].parent_slug, 'growth')

    // 对齐之后，V2 的初始目录一个都不能少（PDF 目录是基准）
    const [total] = await withSql((sql) => sql`SELECT count(*)::int AS n FROM directories`)
    assert.equal(total.n > 60, true, `V2 的初始目录树必须还在，实际 ${total.n} 个节点`)
  })

  test('资源按 V1 自己的分类表落到资料夹（老师看得见的位置）', async () => {
    const rows = await withSql((sql) => sql`
      SELECT r.id::text, r.title, d.name AS folder_name, d.allow_files
      FROM resources r JOIN directories d ON d.id = r.directory_id
      WHERE r.id::text LIKE '33333333%' ORDER BY r.title`)
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]))
    // 夹具里的 folder_type：课程纲要=curriculum_outline、周计划=weekly_plans、课件=courseware
    assert.equal(byTitle['美德课程纲要'].folder_name, '课程大纲', 'curriculum_outline → 课程大纲')
    assert.equal(byTitle['美德周计划 W3'].folder_name, '教学详案', 'weekly_plans → 教学详案')
    assert.equal(byTitle['还没写完的教案'].folder_name, '教学详案')
    assert.equal(byTitle['被退回的课件'].folder_name, '教学资源', 'courseware → 教学资源')
    assert.equal(byTitle['多版本的美德课件'].folder_name, '教学资源')
    assert.equal(byTitle['美德周计划 W3'].allow_files, true)
  })

  test('**没有**任何资源落在"浏览页不列资源"的目录上（这是本阶段最危险的坑）', async () => {
    /*
      V2 的目录浏览页只在 allowFiles = true 的资料夹层列资源。
      V1 的 348 条资源全部挂在科目层（allowFiles = false），
      所以"照搬 directory_id"会让资源迁移完**一条都看不到**。
      这条断言就是那个坑的门闩：所有迁移过来的资源都必须落在能看见的位置。
    */
    const [row] = await withSql((sql) => sql`
      SELECT count(*)::int AS n
      FROM resources r JOIN directories d ON d.id = r.directory_id
      WHERE d.allow_files = false`)
    assert.equal(row.n, 0, `有 ${row.n} 条资源落在浏览页不会列出的目录上`)
  })

  test('资源状态原样保留（大写到 V2 的取值）', async () => {
    const rows = await withSql((sql) => sql`
      SELECT title, status FROM resources WHERE id::text LIKE '33333333%'`)
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.status]))
    assert.equal(byTitle['被退回的课件'], 'REJECTED')
    assert.equal(byTitle['还没写完的教案'], 'DRAFT')
    assert.equal(byTitle['美德课程纲要'], 'PUBLISHED')
  })

  test('V1 独有的分类字段进了 legacy，一个都没丢', async () => {
    const [row] = await withSql((sql) => sql`
      SELECT legacy FROM v1_migration_map
      WHERE entity = 'resource' AND v1_id = ${FIXTURE_IDS.resPublished}`)
    assert.equal(row.legacy.folderType, 'curriculum_outline')
    assert.equal(row.legacy.program, 'prek')
    // V1 的 subject 是**纯科目名**（生产快照实测：prek/english、prek/virtue 这种），
    // legacy 里必须原样保留它，不能写成转换后的 code。
    assert.equal(row.legacy.subject, 'virtue')
    assert.equal(row.legacy.semester, 'S1')
    assert.equal(row.legacy.weekNumber, 3)
    assert.equal(row.legacy.theme, '主题一')
    assert.equal(row.legacy.v1Status, 'published')
    // 落点与依据也要留痕：任何一条资源都能回答"现在在哪、凭什么在那儿"
    // 落点写的是**那个资料夹的 code**（同级还有 placementBasis 记着判定依据），
    // 加上 V2 侧的 directory_id，任何一条资源都能回答"现在在哪、凭什么在那儿"
    assert.equal(row.legacy.placedIn, 'folder:prek:virtue_outline')
    assert.match(row.legacy.placementBasis, /folder_type/)
    // V2 的业务表里**没有**这些列 —— 这是设计，不是遗漏。
    const columns = await withSql((sql) => sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'resources'`)
    const names = columns.map((c) => c.column_name)
    for (const banned of ['folder_type', 'program', 'subject', 'semester', 'week_number', 'theme']) {
      assert.equal(names.includes(banned), false, `V2 的 resources 不该有 ${banned}`)
    }
  })

  test('版本行数进 legacy（V2 没有版本表）', async () => {
    const [row] = await withSql((sql) => sql`
      SELECT legacy FROM v1_migration_map WHERE v1_id = ${FIXTURE_IDS.resVersioned}`)
    assert.equal(row.legacy.v1Versions, 3)
  })

  test('审核时间线完整：提交 → 退回 → 再提交 → 通过', async () => {
    const rows = await withSql((sql) => sql`
      SELECT action, from_status, to_status, comment
      FROM resource_reviews WHERE resource_id = ${FIXTURE_IDS.resTimeline}
      ORDER BY created_at`)
    assert.deepEqual(rows.map((r) => [r.action, r.from_status, r.to_status]), [
      ['submit', 'DRAFT', 'PENDING_REVIEW'],
      ['review.reject', 'PENDING_REVIEW', 'REJECTED'],
      ['submit', 'DRAFT', 'PENDING_REVIEW'],
      ['review.approve', 'PENDING_REVIEW', 'PUBLISHED'],
    ])
    assert.equal(rows[1].comment, '周次写错了，请改', '退回原因要原样保留')
  })

  test('V1 没写原因的退回：不编原因，但记录必须还在', async () => {
    const [row] = await withSql((sql) => sql`
      SELECT comment FROM resource_reviews WHERE resource_id = ${FIXTURE_IDS.resRejectNoComment}`)
    assert.equal(row.comment, '（V1 未记录退回原因）')
    const [mapped] = await withSql((sql) => sql`
      SELECT legacy, needs_review FROM v1_migration_map WHERE entity = 'review' AND v2_id IS NOT NULL
        AND legacy ->> 'commentMissing' = 'true'`)
    assert.equal(mapped.legacy.commentMissing, true, '要标明这条原因是缺的，而不是假装 V1 写了')
  })

  test('审计：一条不少，而且**保留 V1 的时间**', async () => {
    const rows = await withSql((sql) => sql`
      SELECT action, result, actor_id::text, actor_name, target_id, created_at, detail
      FROM audit_logs ORDER BY created_at`)
    assert.equal(rows.length, 6)

    const orphan = rows.find((r) => r.actor_name === '早就删掉的测试账号')
    assert.equal(orphan.actor_id, null, 'V1 里已经不存在的操作者：actor_id 置空')
    assert.equal(orphan.action, 'auth.login', '登录动作要翻译成 V2 的动作名')

    const mfa = rows.find((r) => r.action === 'mfa_challenge_issued')
    assert.ok(mfa, 'V2 没有 MFA，但当年发生过这件事，审计里必须还在')

    // V1 的"下载被拒"归到 V2 的统一动作 authz.denied，原名留在 detail 里
    const denied = rows.find((r) => r.detail?.v1Action === 'resource_download_denied')
    assert.equal(denied.action, 'authz.denied')
    assert.equal(denied.result, 'denied')
    assert.equal(rows.find((r) => r.action === 'auth.login' && r.actor_id === null).result, 'success')
    assert.equal(rows.find((r) => r.actor_name === '（V1 未记录操作者）').result, 'failed')

    // V1 的时间（2026-09-01T08:00Z）而不是导入时间
    assert.equal(new Date(rows[0].created_at).toISOString(), '2026-09-01T08:00:00.000Z')
  })

  test('授权：能编码的编成 user_permissions，编不出来的进报告', async () => {
    const rows = await withSql((sql) => sql`
      SELECT p.permission, d.name AS directory_name, u.username
      FROM user_permissions p
      JOIN directories d ON d.id = p.directory_id
      JOIN users u ON u.id = p.user_id`)
    assert.equal(rows.length, 1, 'V1 里只有一条能转换的授权，V2 就必须只有一条')
    assert.equal(rows[0].permission, 'resource.view')
    assert.equal(rows[0].directory_name, '美德')
    assert.equal(rows[0].username, KNOWN.teacherUsername)

    // deny 覆盖 / scope / V2 没有的权限码 —— 都要被记下来，而不是悄悄丢掉
    const reports = readFileSync('/tmp/v2-migration-probe.md', 'utf8')
    assert.match(reports, /permission_overrides/, 'deny 覆盖要进报告')
    assert.match(reports, /account_scopes/, 'scope 要进报告')
    assert.match(reports, /没有口令/, '没有口令的账号要进报告')
  })

  test('角色只产出 ADMIN / TEACHER，原角色进 legacy', async () => {
    const rows = await withSql((sql) => sql`SELECT username, role, status FROM users ORDER BY username`)
    for (const r of rows) assert.ok(['ADMIN', 'TEACHER'].includes(r.role), `身份只能是这两种：${r.role}`)

    /*
      规则变更（业主 Stage 13 §4）：迁移**不再**依据 V1 的岗位名自动提升管理员。
      夹具里有两个 principal（园长 / 系统初始化），旧默认会把它们都变成 ADMIN；
      现在必须由人显式指定 —— 所以这里断言"一个自动提升的管理员都没有"。
      第一个超级管理员的正规入口是 `scripts/bootstrap-admin.mjs`（显式凭据）。
    */
    assert.equal(
      rows.filter((r) => r.role === 'ADMIN').length,
      0,
      '默认不提升任何账号为管理员（不再看 V1 岗位名）',
    )

    const [admin] = await withSql((sql) => sql`
      SELECT legacy FROM v1_migration_map WHERE entity = 'user' AND v1_id = ${FIXTURE_IDS.admin}`)
    assert.deepEqual(admin.legacy.roles, ['principal'], 'V1 的角色数组要完整留在 legacy 里')
  })

  test('没有用户名的账号：导入为停用 + 占位用户名，346 条资源的上传者不断链', async () => {
    const [row] = await withSql((sql) => sql`
      SELECT username, status, role FROM users WHERE id = ${FIXTURE_IDS.noUsername}`)
    assert.equal(row.status, 'inactive')
    assert.equal(row.username, `v1-no-username-${FIXTURE_IDS.noUsername.slice(0, 8)}`)
    // 它在 V1 里是 principal，但迁移不再按岗位名自动提管理员 —— 一律 TEACHER，
    // 由人显式指定（--admin-usernames 或 bootstrap-admin）。
    assert.equal(row.role, 'TEACHER', '不按 V1 岗位名自动提升身份')
  })

  test('没有口令的账号：占位值任何口令都进不去', async () => {
    const [row] = await withSql((sql) => sql`
      SELECT password_hash FROM users WHERE id = ${FIXTURE_IDS.noPassword}`)
    assert.match(row.password_hash, /^v1\$no-password\$/)

    const { password } = await import('../helpers/modules.mjs')
    for (const guess of ['', 'password', 'k_assistant', row.password_hash]) {
      assert.equal(password.verifyPassword(guess, row.password_hash), false)
    }
  })

  test('文件：真实对象被搬过来，sha256 是算出来的', async () => {
    const [row] = await withSql((sql) => sql`
      SELECT file_name, storage_key, size, sha256 FROM resource_files WHERE resource_id = ${FIXTURE_IDS.resPublished}`)
    assert.equal(row.file_name, REAL_FILE.name)
    assert.equal(Number(row.size), REAL_FILE.content.byteLength)
    assert.match(row.storage_key, new RegExp(`^resources/${FIXTURE_IDS.resPublished}/`))

    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update(REAL_FILE.content).digest('hex')
    assert.equal(row.sha256, expected, 'sha256 必须是文件内容算出来的')

    // 对象真的落在存储里（不是只写了数据库）
    assert.equal(existsSync(join(importStorage, row.storage_key)), true, '对象必须真的落盘')
    const onDisk = readFileSync(join(importStorage, row.storage_key))
    assert.equal(createHash('sha256').update(onDisk).digest('hex'), expected)
  })

  test('声称有文件、源里却没有：报 MISSING_FILE，**不造文件**', async () => {
    const [row] = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM resource_files WHERE resource_id = ${FIXTURE_IDS.resMissingFile}`)
    assert.equal(row.n, 0, '源对象不在，就不许有 resource_files 行')
    // v1_id 同时出现在 resource 与 resource_file 两个实体上（同一个资源 id），
    // 所以必须限定 entity —— 否则取到的是资源那行，"需要人工确认"看着像 false。
    const [mapped] = await withSql((sql) => sql`
      SELECT needs_review, review_note FROM v1_migration_map
      WHERE entity = 'resource_file' AND v1_id = ${FIXTURE_IDS.resMissingFile}`)
    assert.equal(mapped.needs_review, true)
    assert.match(mapped.review_note, /找不到对象/)
    // MISSING_FILE 记在**报告文件**里（给了 --report 就不再往 stdout 打全文）
    assert.match(readFileSync('/tmp/v2-migration-probe.md', 'utf8'), /MISSING_FILE/)
  })

  test('**V1 没有被改过**：迁移前后源库逐表 sha256 一致', async () => {
    const { snapshot, compareSnapshots } = await import('../../scripts/v1-snapshot.mjs')
    const afterSnapshot = await snapshot(fixture.url)
    const diffs = compareSnapshots(beforeSnapshot, afterSnapshot)
    assert.deepEqual(diffs, [], `源库必须逐字节不变，实际差异：${JSON.stringify(diffs)}`)
  })

  test('迁移后没有悬空外键', async () => {
    const checks = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT
          (SELECT count(*)::int FROM resources r LEFT JOIN directories d ON d.id = r.directory_id WHERE d.id IS NULL) AS resources_dir,
          (SELECT count(*)::int FROM resources r LEFT JOIN users u ON u.id = r.uploader_id WHERE r.uploader_id IS NOT NULL AND u.id IS NULL) AS resources_uploader,
          (SELECT count(*)::int FROM resource_files f LEFT JOIN resources r ON r.id = f.resource_id WHERE r.id IS NULL) AS files_resource,
          (SELECT count(*)::int FROM resource_reviews v LEFT JOIN resources r ON r.id = v.resource_id WHERE r.id IS NULL) AS reviews_resource,
          (SELECT count(*)::int FROM user_permissions p LEFT JOIN directories d ON d.id = p.directory_id WHERE p.directory_id IS NOT NULL AND d.id IS NULL) AS perms_dir`
      return row
    })
    for (const [name, n] of Object.entries(checks)) assert.equal(n, 0, `${name}: ${n}`)
  })

  test('迁移后的老师能用 V1 的老口令登录（口令兼容是**真的**）', async () => {
    await createAdmin('mig_admin', 'MigAdminPass!1')
    await startServer({ env: { STORAGE_LOCAL_DIR: importStorage } })

    const teacher = client()
    const res = await teacher.login(KNOWN.teacherUsername, KNOWN.teacherPassword)
    assert.equal(res.status, 201, JSON.stringify(res.data))
    const me = await teacher.get('/api/auth/me')
    assert.equal(me.status, 200)
    assert.equal(me.data.user.username, KNOWN.teacherUsername)
    /*
      V1 里这位老师有一条 `subject_permissions`（美德 / resource.view），
      迁移把它转成了一条真实的授权 —— 所以这里应当**恰好**是它，
      既不能少（丢授权），也不能多（那才是"权限扩大"）。
    */
    assert.deepEqual(me.data.permissions, ['resource.view'], '授权集合必须与 V1 的显式授权完全一致')
    const grants = await withSql((sql) => sql`
      SELECT p.permission, d.name AS directory_name
      FROM user_permissions p JOIN directories d ON d.id = p.directory_id
      JOIN users u ON u.id = p.user_id WHERE u.username = ${KNOWN.teacherUsername}`)
    assert.deepEqual(grants.map((g) => [g.permission, g.directory_name]), [['resource.view', '美德']])
  })

  test('幂等：第二次导入一条也不新增，而且不覆盖 V2 里改过的东西', async () => {
    // 管理员先在 V2 里改一次（改标题）—— 重新导入**不能**把它改回去。
    await withSql((sql) => sql`
      UPDATE resources SET title = '管理员改过的标题' WHERE id = ${FIXTURE_IDS.resPublished}`)

    await importOnce(['--v1-storage', `local:${fixture.storageDir}`, '--allow-partial'])

    // 幂等不能只看"总数没变"——要看**这一次运行到底插了几行**。
    // 依据是记账表里最新两次运行的计数（脚本自己写的，不是测试替它算的）。
    const runs = await withSql((sql) => sql`
      SELECT id, counts FROM v1_import_runs ORDER BY id DESC LIMIT 2`)
    assert.equal(runs.length, 2, '夹具导入应当有两次运行记录')
    for (const [entity, c] of Object.entries(runs[0].counts)) {
      assert.equal(c.inserted ?? 0, 0, `第二次运行不该新增 ${entity}：${JSON.stringify(c)}`)
    }
    const secondInsertedTotal = Object.values(runs[0].counts)
      .reduce((sum, c) => sum + (c.inserted ?? 0), 0)
    assert.equal(secondInsertedTotal, 0, '第二次运行必须是空操作')

    const counts = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT (SELECT count(*)::int FROM users) AS users,
               (SELECT count(*)::int FROM resources) AS resources,
               (SELECT count(*)::int FROM resource_reviews) AS reviews,
               (SELECT count(*)::int FROM audit_logs) AS audit,
               (SELECT count(*)::int FROM user_permissions) AS permissions,
               (SELECT count(*)::int FROM resource_files) AS files`
      return row
    })
    // 5 个 V1 账号 + 上面 createAdmin 建的 1 个 = 6；
    // 审计 6 条来自夹具，再加登录测试产生的那 1 条 = 7。
    assert.deepEqual(counts, {
      users: 6, resources: 6, reviews: 5, audit: 7, permissions: 1, files: 1,
    })

    const [kept] = await withSql((sql) => sql`
      SELECT title FROM resources WHERE id = ${FIXTURE_IDS.resPublished}`)
    assert.equal(kept.title, '管理员改过的标题', '重新导入不是回滚管理员的工作')
  })

  test('审计去重是**数据库约束**，不是脚本自觉', async () => {
    const [index] = await withSql((sql) => sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'audit_logs_v1_dedup'`)
    assert.ok(index, 'audit_logs_v1_dedup 索引必须存在')
    assert.match(index.indexdef, /UNIQUE/)
    assert.match(index.indexdef, /v1AuditId/)
  })
})

describe('B. 拒绝路径：宁可停下，不许猜', () => {
  test('资源没有目录归属 → 停止，并写出未归属清单', async () => {
    await insertUnassignedResource()
    try {
      const unassignedPath = join(mkdtempSync(join(tmpdir(), 'v2-unassigned-')), 'UNASSIGNED_RESOURCES.md')
      const { code, out } = await importExpectFailure([
        '--v1-storage', `local:${fixture.storageDir}`,
        '--unassigned', unassignedPath,
      ])
      assert.notEqual(code, 0, `必须失败，实际：\n${out}`)
      // 输出要说清"为什么落不下去、还不许猜"，并指出清单写在哪
      assert.match(out, /目录无法唯一确定|UNRESOLVED_DIRECTORY|无目录归属/)
      assert.equal(existsSync(unassignedPath), true, '要留下清单让人去决定')
      assert.match(readFileSync(unassignedPath, 'utf8'), /不知道放哪的资源/)

      // 整个事务回滚：这条资源不许偷偷落进 V2，但更不许**悄悄消失**
      const [row] = await withSql((sql) => sql`
        SELECT count(*)::int AS n FROM resources WHERE id = ${FIXTURE_IDS.resUnassigned}`)
      assert.equal(row.n, 0)
      // 它必须出现在清单里（人去决定），而不是被跳过之后无人知晓
      assert.match(readFileSync(unassignedPath, 'utf8'), /无法确定目录归属|没有目录归属/)
    } finally {
      await deleteUnassignedResource()
    }
  })

  test('V1 声称有文件、却声明"这次没有对象要搬" → 报错退出，不装作搬成功', async () => {
    const { code, out } = await importExpectFailure(['--v1-storage', 'none'])
    assert.notEqual(code, 0)
    assert.match(out, /声称有文件|v1-storage/)
  })

  test('未知的 V1 资源状态 → 停止（不默认成草稿，也不跳过）', async () => {
    const sql = postgres(fixture.url, { max: 1, onnotice: () => {} })
    try {
      await sql`UPDATE resources SET status = 'archived' WHERE id = ${FIXTURE_IDS.resDraft}`
    } finally {
      await sql.end({ timeout: 5 })
    }
    try {
      const { code, out } = await importExpectFailure([
        '--v1-storage', `local:${fixture.storageDir}`,
      ])
      assert.notEqual(code, 0)
      assert.match(out, /archived/)
      assert.match(out, /没有对应值/)
    } finally {
      const back = postgres(fixture.url, { max: 1, onnotice: () => {} })
      try {
        await back`UPDATE resources SET status = 'draft' WHERE id = ${FIXTURE_IDS.resDraft}`
      } finally {
        await back.end({ timeout: 5 })
      }
    }
  })

  test('目标库里若已经有同名用户名 → 停止（不许静默顶掉一个人）', async () => {
    const PROBE_TEACHER_ID = '22222222-0000-4000-8000-0000000000ff'
    // 目标库里先占住一个名字（大小写不同也要算占用：V2 的唯一性建在 lower(username) 上）
    await withSql((sql) => sql`
      INSERT INTO users (username, name, password_hash, role, status)
      VALUES ('clash_probe', '界面上的另一个人', 'x', 'TEACHER', 'active')`)
    // V1 侧来一个**同名的**老师
    const v1 = postgres(fixture.url, { max: 1, onnotice: () => {} })
    try {
      await v1`
        INSERT INTO teachers (id, username, name, roles, status, password_hash)
        VALUES (${PROBE_TEACHER_ID}, 'Clash_Probe', '撞名的老师', ARRAY['k_head'], 'active', ${'scrypt$16384$8$1$x$y'})`
      const { code, out } = await importExpectFailure(['--v1-storage', `local:${fixture.storageDir}`, '--allow-partial'])
      assert.notEqual(code, 0, `必须停下，实际退出码 0：\n${out}`)
      assert.match(out, /Clash_Probe/i)
      assert.match(out, /占用|已被/)
    } finally {
      await v1`DELETE FROM teachers WHERE id = ${PROBE_TEACHER_ID}`
      await v1.end({ timeout: 5 })
      await withSql((sql) => sql`DELETE FROM users WHERE lower(username) = 'clash_probe'`)
    }
  })

  test('源库与目标库是同一个库 → 直接拒绝（不给自己机会）', async () => {
    const { code, out } = await runProjectScriptFailure(
      'scripts/import-v1.mjs',
      {},
      ['--source', TEST_DB_URL, '--target', TEST_DB_URL],
    )
    assert.notEqual(code, 0)
    assert.match(out, /同一个库|teachers 表/)
  })

  test('目标库没应用 0003 迁移 → 拒绝写入', async () => {
    const other = await (async () => {
      const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
      try {
        await admin.unsafe('DROP DATABASE IF EXISTS qls_v2_no_ledger WITH (FORCE)')
        await admin.unsafe('CREATE DATABASE qls_v2_no_ledger')
      } finally {
        await admin.end({ timeout: 5 })
      }
      return `postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_v2_no_ledger`
    })()
    try {
      const { code, out } = await runProjectScriptFailure(
        'scripts/import-v1.mjs',
        {},
        ['--source', fixture.url, '--target', other],
      )
      assert.notEqual(code, 0)
      assert.match(out, /schema_migrations|migrate/)
    } finally {
      const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
      try {
        await admin.unsafe('DROP DATABASE IF EXISTS qls_v2_no_ledger WITH (FORCE)')
      } finally {
        await admin.end({ timeout: 5 })
      }
    }
  })

  test('--dry-run 与真跑同一条路径：预演不改库', async () => {
    const before = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT (SELECT count(*)::int FROM resources) AS resources,
               (SELECT count(*)::int FROM audit_logs) AS audit,
               (SELECT count(*)::int FROM v1_import_runs) AS runs`
      return row
    })
    const out = await importOnce(['--dry-run', '--v1-storage', `local:${fixture.storageDir}`])
    assert.match(out, /预演|dry/i)
    const after = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT (SELECT count(*)::int FROM resources) AS resources,
               (SELECT count(*)::int FROM audit_logs) AS audit,
               (SELECT count(*)::int FROM v1_import_runs) AS runs`
      return row
    })
    assert.deepEqual(after, before, '预演不许留下任何痕迹')
  })
})

describe('C. 真实 V1 库（348 条资源 / 7651 条审计）', () => {
  let realAvailable = false

  before(async () => {
    try {
      const sql = postgres(REAL_V1_URL, { max: 1, onnotice: () => {} })
      const [row] = await sql`SELECT count(*)::int AS n FROM resources`
      realAvailable = row.n > 0
      await sql.end({ timeout: 5 })
    } catch {
      realAvailable = false
    }
  })

  test('真实 V1 库必须存在（阶段 9 的门禁不允许"跳过"）', () => {
    assert.equal(
      realAvailable,
      true,
      `找不到真实 V1 库：${REAL_V1_URL}。迁移的验收必须打在真实数据上，不接受跳过。`,
    )
  })

  test('真实数据能整体搬过来，数字与盘点一致', async () => {
    if (!realAvailable) return
    await resetDatabase()

    const { snapshot } = await import('../../scripts/v1-snapshot.mjs')
    const before = await snapshot(REAL_V1_URL)
    const importStorage2 = mkdtempSync(join(tmpdir(), 'v2-import-storage-'))
    const out = await runProjectScriptCaptured(
      'scripts/import-v1.mjs',
      { NODE_ENV: 'test', V2_ALLOW_DEV_SECRETS: '1', STORAGE_PROVIDER: 'local', STORAGE_LOCAL_DIR: importStorage2 },
      ['--source', REAL_V1_URL, '--target', TEST_DB_URL, '--v1-storage', 'none', '--allow-partial'],
    )
    assert.match(out, /迁移完成/)

    const counts = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT (SELECT count(*)::int FROM users) AS users,
               (SELECT count(*)::int FROM resources) AS resources,
               (SELECT count(*)::int FROM audit_logs) AS audit,
               (SELECT count(*)::int FROM resource_files) AS files,
               (SELECT count(*)::int FROM user_permissions) AS permissions`
      return row
    })
    assert.equal(counts.users, before.teachers.total, '账号一个不少')
    assert.equal(counts.resources, before.resources.total, '资源一条不少')
    assert.equal(counts.audit, before.audit.total, '审计一条不少')
    assert.equal(counts.files, 0, 'V1 里本来就没有文件对象')
    assert.equal(counts.permissions, 0, 'V1 的授权表是空的 → V2 就不许凭空多出授权')

    // 346 条资源上传者是一个没有用户名的种子账号 —— 它必须被搬过来，历史才不断链
    const [orphanUploader] = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM resources WHERE uploader_id IS NULL`)
    assert.equal(orphanUploader.n, 0, 'V1 里每条资源都有上传者，迁移后不该出现 NULL')
    const [seed] = await withSql((sql) => sql`
      SELECT username, status FROM users WHERE name = '系统初始化'`)
    assert.equal(seed.status, 'inactive')
    assert.match(seed.username, /^v1-no-username-/)

    // 孤儿操作者：V1 的 3092 条审计指向根本不存在的老师 —— 保留姓名，actor_id 置空
    const [orphans] = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM audit_logs WHERE actor_id IS NULL AND detail ? 'v1AuditId'`)
    assert.equal(orphans.n > 0, true, '孤儿操作者的审计必须还在')

    // 源库逐字节不变
    const after = await snapshot(REAL_V1_URL)
    const { compareSnapshots } = await import('../../scripts/v1-snapshot.mjs')
    assert.deepEqual(compareSnapshots(before, after), [], '真实 V1 库不许被动过')
  })
})
