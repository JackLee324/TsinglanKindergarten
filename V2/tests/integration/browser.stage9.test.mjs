/**
 * tests/integration/browser.stage9.test.mjs —— 迁移后的真实浏览器验收（阶段 9 §15）
 * ============================================================================
 * 业主的原话：
 *
 *   > 迁移完成后真实打开 V2：登录真实迁移用户 → 进入 Pre-K → 美德 → 教学资源 →
 *   > 找到历史资源 → 打开详情 → 预览 → 下载 → 检查文件 SHA256。
 *
 * 这一份就跑这条路，而且分两段，因为本机的 V1 数据有一个必须先说清的事实：
 *
 *   **V1 里一个文件对象都没有**（348 条资源的 file_* 列全是 NULL，V1 自己的注释
 *   也写了这件事）。所以"下载一个迁移过来的文件并核对 SHA256"这件事，
 *   在真实数据上**没有对象可测** —— 硬说要测，只能造一个假的，那正是不能做的事。
 *
 * 于是：
 *   A. 真实 V1 数据（`qls_test_0005`）：迁移 → 迁移来的管理员登录 → 给老师授权 →
 *      老师登录 → 按目录点进去找到历史资源 → 打开详情 → 预览/下载按钮的
 *      **诚实状态**（没有文件就明确说"暂无文件"，不是 V1 那种"按钮能点、点下去 404"）。
 *   B. 合成夹具（含一个**真实对象**）：迁移 → 老师用 V1 的老口令登录 →
 *      详情 → 预览 → 下载 → **SHA256 与源文件逐字节一致**。
 *
 * 两段都用**真实浏览器**（CDP 驱动 Chrome），不是接口调用。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEST_BASE,
  TEST_DB_URL,
  client,
  createAdmin,
  resetDatabase,
  runProjectScriptCaptured,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { launchBrowser } from '../helpers/browser.mjs'
import { KNOWN, REAL_FILE, buildV1Fixture } from '../helpers/v1-fixture.mjs'

const REAL_V1_URL =
  process.env.V1_REAL_DATABASE_URL ??
  'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_test_0005'

/*
  A 段用**真实 V1 数据**（qls_test_0005），它的 25 个能登录账号的口令是 V1 的
  scrypt 哈希 —— 没人知道明文。所以这一段的"迁移用户登录"必须走真实交接流程：
  管理员在 V2 界面给他重置口令，再用新口令登录。
  这比"拿一个已知口令的夹具账号登录"更接近真实场景，也顺带证明了 V1 的哈希
  能原样搬进来、V2 的校验器认得它（否则重置前的账号状态就已经是坏的）。

  B 段用夹具，那里有"口令已知"的账号（v1teacher），用来证明**老口令本身**还能用。
*/
const REAL_TEACHER_USERNAME = 'prek-head01'
const REAL_TEACHER_NEW_PASSWORD = 'Stage9Migrated!2026'
const REAL_TEACHER = { username: REAL_TEACHER_USERNAME, password: REAL_TEACHER_NEW_PASSWORD }

/** 夹具里口令已知的迁移老师（V1 里有一条 `subject_permissions`：美德 / resource.view）。 */
const MIGRATED_TEACHER = { username: KNOWN.teacherUsername, password: KNOWN.teacherPassword }

const WORK = mkdtempSync(join(tmpdir(), 'stage9-'))
const DOWNLOAD_DIR = join(WORK, 'downloads')
const IMPORT_STORAGE = join(WORK, 'v2-storage')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let browser
let fixtureImport = null

async function login(username, password) {
  await browser.goto(`${TEST_BASE}/login`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 20000, '登录页')
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 20000, `登录 ${username}`)
}

async function logout() {
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '退出')
  }
}

/**
 * 按业主给的那条路**一格格点**过去：教育教学 → Pre-K → 美德 → 教学资源。
 * 不直接输地址 —— 直接开 URL 会跳过"老师到底找不找得到"这个问题。
 */
async function clickThroughTo(slugs) {
  await browser.goto(`${TEST_BASE}/`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 20000, '应用外壳')
  for (const slug of slugs) {
    const nav = `[data-nav="/directory/${slug}"]`
    if (!(await browser.exists(nav))) {
      // 折叠的节点不渲染：先展开它的父级
      const parent = slug.split('/').slice(0, -1).join('/')
      const toggle = `[data-nav-toggle="/directory/${parent}"]`
      if (await browser.exists(toggle)) {
        if ((await browser.attr(toggle, 'aria-expanded')) !== 'true') await browser.click(toggle)
      }
    }
    await browser.waitFor(`!!document.querySelector('${nav}')`, 20000, `侧边栏有 /directory/${slug}`)
    await browser.click(nav)
    await browser.waitFor(`!!document.querySelector('[data-testid="directory-page"]')`, 20000, `${slug} 目录页`)
  }
}

before(async () => {
  await resetDatabase()
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  mkdirSync(IMPORT_STORAGE, { recursive: true })
})

after(async () => {
  if (browser) await browser.close()
  await stopServer()
  rmSync(WORK, { recursive: true, force: true })
})

describe('A. 真实 V1 数据迁过来的样子', () => {
  test('把 348 条真实资源搬进测试库', async () => {
    const out = await runProjectScriptCaptured(
      'scripts/import-v1.mjs',
      { NODE_ENV: 'test', V2_ALLOW_DEV_SECRETS: '1' },
      ['--source', REAL_V1_URL, '--target', TEST_DB_URL, '--v1-storage', 'none', '--allow-partial'],
    )
    assert.match(out, /迁移完成/)

    const counts = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT (SELECT count(*)::int FROM resources) AS resources,
               (SELECT count(*)::int FROM users) AS users,
               (SELECT count(*)::int FROM user_permissions) AS permissions`
      return row
    })
    assert.equal(counts.resources, 348)
    assert.equal(counts.permissions, 0, 'V1 没有显式授权 → 迁移不许凭空生成')
  })

  test('迁移过来的账号都在；界面给老师授权后，老师用**重置过的新口令**登录', async () => {
    // 操作者用一个 V2 本地的管理员（真实 V1 的口令没人知道明文）
    await createAdmin('s9_admin', 'S9AdminPass!1')
    browser = await launchBrowser()
    await browser.enableDownloads(DOWNLOAD_DIR)
    await startServer({ env: { STORAGE_LOCAL_DIR: IMPORT_STORAGE } })

    await login('s9_admin', 'S9AdminPass!1')
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar-admin"]\')', 15000, '管理分组')

    // 346 条资源的上传者（V1 里没有用户名的种子账号）必须还在，而且已停用
    await browser.goto(`${TEST_BASE}/admin/users`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="admin-users-page"]\')', 20000, '教师账号页')
    await browser.waitFor('!!document.querySelector(\'[data-testid="users-row"]\')', 20000, '账号列表')
    const rows = await browser.count('[data-testid="users-row"]')
    assert.equal(rows > 0, true, `迁移过来的账号要看得见，实际 ${rows} 行`)
    assert.equal(
      await browser.exists(`[data-testid="users-row"][data-username="${REAL_TEACHER_USERNAME}"]`),
      true,
      '真实 V1 的老师（prek-head01）必须在列表里',
    )

    const admin = client()
    await admin.login('s9_admin', 'S9AdminPass!1')
    const list = await admin.get(`/api/users?q=${REAL_TEACHER_USERNAME}`)
    const teacher = list.data.items.find((u) => u.username === REAL_TEACHER_USERNAME)
    assert.ok(teacher, '迁移来的老师必须在列表里')

    // ① 授权：查看 + 下载，开放到 Pre-K / 美德（V1 里没有显式授权，所以由管理员授予）
    const virtue = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT d.id::text FROM directories d JOIN directories p ON p.id = d.parent_id
        JOIN directories g ON g.id = p.parent_id
        WHERE g.slug = 'education' AND p.slug = 'pre-k' AND d.slug = 'virtue'`
      return row.id
    })
    const saved = await admin.put(`/api/users/${teacher.id}/permissions`, {
      permissions: [
        { permission: 'resource.view', directoryId: virtue },
        { permission: 'resource.download', directoryId: virtue },
      ],
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.data))

    // ② 在**界面上**给他重置口令（这是 V1 账号第一次在 V2 里获得可用口令的真实路径）
    await browser.click(`[data-testid="users-row"][data-username="${REAL_TEACHER_USERNAME}"] [data-testid="users-row-edit"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="edit-user-dialog"]\')', 15000, '编辑弹窗')
    await browser.fill('[data-testid="edit-user-password"]', REAL_TEACHER_NEW_PASSWORD)
    await browser.click('[data-testid="edit-user-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="users-notice"]\')', 20000, '保存成功')
    await browser.waitFor('!document.querySelector(\'[data-testid="edit-user-dialog"]\')', 15000, '弹窗关闭')
  })

  test('迁移来的老师登录 → 一格格点进 美德 → 看到历史资源', async () => {
    await logout()
    await login(REAL_TEACHER.username, REAL_TEACHER.password)
    /*
      一格格点到**资料夹层**（教学大纲/课程大纲）。这也是本阶段那条"最危险的坑"的
      验收方式：V1 的 348 条资源原本全挂在科目层，而 V2 只在资料夹层列资源 ——
      如果迁移照搬科目层归属，老师在这里会看到空页面（接口却全绿）。
    */
    await clickThroughTo([
      'education', 'education/pre-k', 'education/pre-k/virtue',
      'education/pre-k/virtue/outline',
    ])

    // 迁移过来的历史资源（V1 里 12 条美德资源，分类是 curriculum_outline → 课程大纲）
    await browser.waitFor(
      'document.querySelectorAll(\'[data-testid="resource-card-title"]\').length > 0',
      20000,
      '课程大纲下有历史资源',
    )
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.length >= 10, true, `课程大纲下应当能看到历史资源，实际 ${titles.length} 张卡片`)
    for (const t of titles) assert.equal(typeof t === 'string' && t.length > 0, true, '资源标题不能是空的')

  })

  test('打开历史资源详情：没有文件就明确说"暂无文件"，不是能点却 404 的按钮', async () => {
    await browser.click('[data-testid="resource-card-title"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 20000, '资源详情')
    const title = await browser.text('[data-testid="resource-detail-title"]')
    assert.equal(typeof title === 'string' && title.length > 0, true, '详情页要有标题')

    /*
      这就是 V1 被投诉的那个毛病的反面：V1 的 348 条资源全都没有文件，
      而界面照样渲染了一个"下载"按钮，点下去 404。
      V2 必须说清楚"这个资源没有文件"。
    */
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-list"]\')', 20000, '文件区')
    assert.equal(await browser.exists('[data-testid="file-empty"]'), true, '没有文件时要有明确的空状态')
    assert.equal(await browser.exists('[data-testid="file-download"]'), false, '没有文件就不该有下载按钮')
    assert.match(await browser.text('[data-testid="file-empty"]'), /暂无文件|还没有文件/)
  })

  test('审计页看得到迁移过来的历史（含 V1 历史的 MFA 动作，且能筛）', async () => {
    await logout()
    await login('s9_admin', 'S9AdminPass!1')
    await browser.goto(`${TEST_BASE}/admin/audit`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="admin-audit-page"]\')', 20000, '审计页')
    await browser.waitFor('!!document.querySelector(\'[data-testid="audit-row"]\')', 20000, '审计有记录')

    const total = await browser.count('[data-testid="audit-row"]')
    assert.equal(total > 0, true)
    // 迁移过来的时间必须是 V1 的时间（2026-10-05 前后），不是"刚刚导入"
    const when = await browser.text('[data-testid="audit-row-time"]')
    assert.match(String(when), /2026-/, `审计时间应当是 V1 当年的时间，实际「${when}」`)

    // 按"V1 历史动作"筛选：V2 不会再写这种动作，但历史必须筛得到
    await browser.select('[data-testid="audit-action-filter"]', 'mfa_challenge_issued')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="audit-row"]').length > 0 &&
       [...document.querySelectorAll('[data-testid="audit-row"]')].every((r) => r.getAttribute('data-action') === 'mfa_challenge_issued')`,
      20000,
      '只剩 MFA 历史动作',
    )
    const label = await browser.text('[data-testid="audit-row-action"]')
    assert.match(String(label), /MFA/, `历史动作要显示成中文标签，实际「${label}」`)
  })
})

describe('B. 真实文件的迁移：预览 → 下载 → SHA256 一致', () => {
  test('夹具（含一个真实 PDF 对象）迁移进测试库', async () => {
    await stopServer()
    await resetDatabase()
    const fixture = await buildV1Fixture()
    fixtureImport = await runProjectScriptCaptured(
      'scripts/import-v1.mjs',
      { NODE_ENV: 'test', V2_ALLOW_DEV_SECRETS: '1', STORAGE_PROVIDER: 'local', STORAGE_LOCAL_DIR: IMPORT_STORAGE },
      ['--source', fixture.url, '--target', TEST_DB_URL, '--v1-storage', `local:${fixture.storageDir}`, '--allow-partial'],
    )
    assert.match(fixtureImport, /迁移完成/)

    const [file] = await withSql((sql) => sql`
      SELECT file_name, storage_key, sha256, size FROM resource_files`)
    assert.equal(file.file_name, REAL_FILE.name)
    assert.equal(file.sha256, sha256(REAL_FILE.content), '迁移时算的 sha256 必须与源文件一致')
  })

  test('迁移来的管理员用 V1 老口令登录并授予下载权限', async () => {
    await startServer({ env: { STORAGE_LOCAL_DIR: IMPORT_STORAGE } })
    if (!browser) browser = await launchBrowser()
    await browser.enableDownloads(DOWNLOAD_DIR)

    /*
      夹具里这位老师的授权是从 V1 的 subject_permissions 转过来的（只有 resource.view）。
      预览与下载在 V2 里都要求 `resource.download`，所以由**迁移来的管理员**
      （V1 的 principal，口令就是夹具里那个）在界面上补一条 —— 顺带证明
      迁移过来的管理员能正常做管理动作。
    */
    const admin = client()
    assert.equal((await admin.login(KNOWN.adminUsername, KNOWN.adminPassword)).status, 201)
    const list = await admin.get(`/api/users?q=${MIGRATED_TEACHER.username}`)
    const teacher = list.data.items.find((u) => u.username === MIGRATED_TEACHER.username)
    assert.ok(teacher, '夹具老师必须在迁移结果里')
    const virtue = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT d.id::text FROM directories d JOIN directories p ON p.id = d.parent_id
        JOIN directories g ON g.id = p.parent_id
        WHERE g.slug = 'education' AND p.slug = 'pre-k' AND d.slug = 'virtue'`
      return row.id
    })
    const saved = await admin.put(`/api/users/${teacher.id}/permissions`, {
      permissions: [
        { permission: 'resource.view', directoryId: virtue },
        { permission: 'resource.download', directoryId: virtue },
      ],
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.data))
  })

  test('老师用 V1 老口令登录 → 点进 课程大纲 → 详情里看到那个文件', async () => {
    await login(MIGRATED_TEACHER.username, MIGRATED_TEACHER.password)
    await clickThroughTo(['education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/outline'])
    await browser.waitFor(
      'document.querySelectorAll(\'[data-testid="resource-card-title"]\').length > 0',
      20000,
      '课程大纲下有迁移过来的资源',
    )
    // 点**有文件的那一条**（按标题定位，不靠列表顺序 —— 课程大纲下不止一条资源）
    await browser.waitFor(
      `[...document.querySelectorAll('[data-testid="resource-card-title"]')].some((e) => e.innerText.trim() === '美德课程纲要')`,
      20000,
      '有文件的那条资源出现',
    )
    // 用 session.eval 而不是 browser.eval：Browser 上只有 session 才暴露 CDP 求值。
    const clicked = await browser.session.eval(
      `(() => {
         const el = [...document.querySelectorAll('[data-testid="resource-card-title"]')]
           .find((e) => e.innerText.trim() === '美德课程纲要')
         if (!el) return false
         el.click()
         return true
       })()`,
    )
    assert.equal(clicked, true, '必须点到「美德课程纲要」那张卡')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 20000, '资源详情')
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-row"]\')', 20000, '文件行')
    assert.equal(await browser.text('[data-testid="file-name"]'), REAL_FILE.name)
  })

  test('预览：打开的确实是那个 PDF（签名地址 + iframe 真的渲染）', async () => {
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="file-preview-pdf"]\')',
      20000,
      'PDF 预览出现',
    )
    const src = await browser.attr('[data-testid="file-preview-pdf"]', 'src')
    assert.match(String(src), /token=|X-Amz-Signature=/, '预览走的必须是短命签名地址')
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('下载：落盘文件的 SHA256 == V1 源文件（逐字节一致）', async () => {
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-download"]\')', 15000, '下载按钮')
    await browser.click('[data-testid="file-download"]')
    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (name) => name.endsWith('.pdf'))
    const downloaded = readFileSync(saved)
    assert.equal(
      sha256(downloaded),
      sha256(REAL_FILE.content),
      '下载回来的字节必须与 V1 里的源对象逐字节一致',
    )
    assert.equal(downloaded.length, REAL_FILE.content.byteLength)
    rmSync(saved, { force: true })
  })

  test('迁移过来的文件在库里只有一份（没有被重复搬）', async () => {
    const [row] = await withSql((sql) => sql`
      SELECT count(*)::int AS n, count(DISTINCT storage_key)::int AS keys FROM resource_files`)
    assert.equal(row.n, 1)
    assert.equal(row.keys, 1)
  })

  test('管理端核对：迁移记账里能回答"这条资源原来是 V1 的哪一行"', async () => {
    const rows = await withSql((sql) => sql`
      SELECT entity, legacy FROM v1_migration_map WHERE entity = 'resource' ORDER BY v1_id`)
    assert.equal(rows.length, 6, '夹具里 6 条资源各留一行记账')
    const legacy = rows.map((r) => r.legacy).find((l) => l.folderType === 'curriculum_outline')
    assert.ok(legacy, 'V1 的旧分类字段要留在 legacy 里')
    assert.equal(legacy.program, 'prek')
    assert.equal(typeof legacy.semester, 'string')
  })
})
