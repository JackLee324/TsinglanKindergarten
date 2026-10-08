/**
 * tests/integration/browser.stage10.test.mjs —— 全业务浏览器验收（业主 Stage 10）
 * ============================================================================
 * 这不是接口测试，也不是"页面打得开"测试。这一份用**真实浏览器**扮演
 * 一位管理员和两位老师，把业主列的 22 节逐条走一遍，并且：
 *
 *   · 每一步都**点击**（不直接输深层 URL，除非那一步本身就是在测"直接打开会怎样"）；
 *   · 每一步都回数据库核对（"界面说成功了"不算成功，`deleted_at` 写上了才算）；
 *   · 全程采集 **console 与网络**（CDP 的 Runtime / Log / Network 三个域）——
 *     业主 §19 要求整条流程 console error = 0、没有 404 JS/CSS、没有 500 API、没有 CORS 错误；
 *   · 出错时把**页面当时的文字**打进断言消息里 —— 一条只说"等待超时"的失败，
 *     等于让人重新跑一遍才知道发生了什么。
 *
 * 刻意允许的失败响应（403/404/409）都必须由用例**显式**登记进 `allowedNoise`，
 * 少写一条就是红灯 —— 而不是"4xx 一律放过"。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEST_BASE,
  client,
  createAdmin,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { launchBrowser } from '../helpers/browser.mjs'
import { pdfBytes } from '../helpers/upload.mjs'

const WORK = mkdtempSync(join(tmpdir(), 'stage10-'))
const FILES_DIR = join(WORK, 'files')
const DOWNLOAD_DIR = join(WORK, 'downloads')

const ADMIN = { username: 's10_admin', password: 'S10AdminPass!1' }
const TEACHER_A = { username: 's10_teacher_a', password: 'S10TeacherA!1', name: '张老师' }
const TEACHER_B = { username: 's10_teacher_b', password: 'S10TeacherB!1', name: '李老师' }

/** 八种文件类型各一个真实文件（magic 必须与扩展名相符，否则登记会被拒）。 */
const FIXTURES = {}
function buildFixtures() {
  /*
    ⚠️ 图片必须是**浏览器真的能解码**的图，不能只有 magic。
    第一版这里只拼了 PNG/JPEG 的文件头，上传照样成功（策略只校验 magic），
    但预览时 `naturalWidth === 0` —— 于是"图片真的显示"那条断言红了。
    那条断言是对的：业主 §8 要的是"图片真实显示"，不是"有个 <img> 标签"。
    所以这里内嵌两张真正合法的最小图（1×1）。
  */
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const jpg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  )
  const zip = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
    Buffer.from('zip fixture for stage10\n'.repeat(6)),
  ])
  const office = (tag) => Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
    Buffer.from(`${tag} fixture for stage10\n`.repeat(6)),
  ])

  FIXTURES.pdf = { name: '美德课程教案.pdf', bytes: pdfBytes('stage10'), previewable: true }
  FIXTURES.jpg = { name: '观察照片.jpg', bytes: jpg, previewable: true }
  FIXTURES.png = { name: '环境创设照片.png', bytes: png, previewable: true }
  FIXTURES.txt = { name: '活动说明.txt', bytes: Buffer.from('这是一份真实的活动说明文本。\n第二行。\n', 'utf8'), previewable: true }
  FIXTURES.docx = { name: '教案文档.docx', bytes: office('docx'), previewable: false }
  FIXTURES.xlsx = { name: '观察记录表.xlsx', bytes: office('xlsx'), previewable: false }
  FIXTURES.pptx = { name: '课件.pptx', bytes: office('pptx'), previewable: false }
  FIXTURES.zip = { name: '素材打包.zip', bytes: zip, previewable: false }

  for (const f of Object.values(FIXTURES)) {
    writeFileSync(join(FILES_DIR, f.name), f.bytes)
    f.path = join(FILES_DIR, f.name)
    f.sha256 = createHash('sha256').update(f.bytes).digest('hex')
  }
}

let browser
let adminClient
/** 刻意制造的失败响应（每条都必须由用例显式登记，并说明为什么）。 */
const allowedNoise = []
const ids = {}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ── 页面操作 ────────────────────────────────────────────────────────────────

async function login(username, password) {
  // 已经登录着的时候直接开 /login 会被弹回首页，登录框根本不在 —— 先退出
  await browser.goto(`${TEST_BASE}/`)
  await browser.waitFor(
    `!!document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="logout-button"]')`,
    20000,
    '应用或登录页就绪',
  )
  if (await browser.exists('[data-testid="logout-button"]')) await logout()
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
 * 按业主的要求**一格格点**过去：教育教学 → Pre-K → 美德 → 资料夹。
 * 直接开 URL 会跳过"老师到底找不找得到"这个问题，而那正是目录是唯一真相的意义。
 */
async function clickThrough(paths) {
  await browser.goto(`${TEST_BASE}/`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 25000, '应用外壳')
  for (const path of paths) {
    const nav = `[data-nav="/directory/${path}"]`
    if (!(await browser.exists(nav))) {
      const parent = path.split('/').slice(0, -1).join('/')
      const toggle = `[data-nav-toggle="/directory/${parent}"]`
      if (await browser.exists(toggle)) {
        if ((await browser.attr(toggle, 'aria-expanded')) !== 'true') await browser.click(toggle)
      }
    }
    await browser.waitFor(`!!document.querySelector('${nav}')`, 20000, `侧边栏出现 /directory/${path}`)
    await browser.click(nav)
    await browser.waitFor(
      `document.querySelector('[data-testid="directory-page"]')?.getAttribute('data-directory-path') === '${path}'`,
      20000,
      `进入 ${path}`,
    )
  }
}

/** 走真实上传弹窗：填标题 + 选文件 + 提交，等它跳到详情页。 */
async function uploadThroughUi({ title, filePath, directoryPath }) {
  await browser.waitFor('!!document.querySelector(\'[data-testid="directory-upload"]\')', 20000, '上传按钮')
  await browser.click('[data-testid="directory-upload"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '上传弹窗')
  await browser.fill('[data-testid="upload-title"]', title)
  await browser.setFileInput('[data-testid="upload-file-input"]', filePath)
  await browser.click('[data-testid="upload-submit"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 30000, '上传后进入详情页')
  const id = await browser.attr('[data-testid="resource-detail-page"]', 'data-resource-id')
  assert.equal(typeof id === 'string' && id.length > 0, true, '详情页必须带资源 id')
  if (directoryPath !== undefined) ids.lastUploaded = { id, directoryPath, title }
  return id
}

/** 点某个文件行的操作按钮（预览/下载）。 */
async function clickFileAction(fileName, testId) {
  const clicked = await browser.session.eval(
    `(() => {
       const rows = [...document.querySelectorAll('[data-testid="file-row"]')]
       const row = rows.find((r) => r.innerText.includes(${JSON.stringify(fileName)}))
       if (!row) return 'no-row'
       const btn = row.querySelector('[data-testid="${testId}"]')
       if (!btn) return 'no-button'
       btn.click()
       return 'ok'
     })()`,
  )
  return clicked
}

/**
 * 数据库里的资源行（界面说成功不算成功，要看这一行）。
 *
 * ⚠️ `directories` 表里**没有** `path` 列 —— 路径是 slug 链算出来的
 * （服务端也是这么算的，见 resources.service 里的 `dir_path` 递归 CTE）。
 * 测试里照抄同一份算法，而不是在表上偷偷加一列。
 */
const DIR_PATH_CTE = `
  WITH RECURSIVE dir_path AS (
    SELECT id, slug::text AS path FROM directories WHERE parent_id IS NULL
    UNION ALL
    SELECT d.id, dp.path || '/' || d.slug FROM directories d JOIN dir_path dp ON d.parent_id = dp.id
  )`

async function resourceRow(id) {
  const rows = await withSql((sql) => sql.unsafe(
    `${DIR_PATH_CTE}
     SELECT r.id::text, r.title, r.status, r.deleted_at, dp.path AS directory_path,
            (SELECT count(*)::int FROM resource_files f WHERE f.resource_id = r.id) AS files
     FROM resources r JOIN dir_path dp ON dp.id = r.directory_id
     WHERE r.id = $1`, [id]))
  return rows[0] ?? null
}

/** 目录 id（按 slug 路径）。 */
async function directoryIdByPath(path) {
  const rows = await withSql((sql) => sql.unsafe(
    `${DIR_PATH_CTE} SELECT id::text FROM dir_path WHERE path = $1`, [path]))
  assert.equal(rows.length, 1, `目录 ${path} 必须存在`)
  return rows[0].id
}

/** 目录路径（按 id）。 */
async function directoryPathById(id) {
  const rows = await withSql((sql) => sql.unsafe(
    `${DIR_PATH_CTE} SELECT path FROM dir_path WHERE id = $1`, [id]))
  return rows[0]?.path ?? null
}

before(async () => {
  mkdirSync(FILES_DIR, { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  buildFixtures()
  await resetDatabase()
  await createAdmin(ADMIN.username, ADMIN.password)
  // 先把服务起起来：下面的账号创建走的是**真实接口**（不是直接写库）
  await startServer()

  adminClient = client()
  await adminClient.login(ADMIN.username, ADMIN.password)

  // 两位老师 + 各自的授权（授权走接口，等价于管理员在界面上点，见 §① 里的界面授权）
  const virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.virtue = virtue
  ids.montessori = await directoryIdByPath('education/pre-k/montessori')
  ids.kChinese = await directoryIdByPath('education/k/chinese')

  const a = await adminClient.post('/api/users', {
    name: TEACHER_A.name,
    username: TEACHER_A.username,
    password: TEACHER_A.password,
    role: 'TEACHER',
    permissions: [
      { permission: 'resource.view', directoryId: virtue },
      { permission: 'resource.create', directoryId: virtue },
      { permission: 'resource.update.own', directoryId: virtue },
      { permission: 'resource.delete.own', directoryId: virtue },
      { permission: 'resource.download', directoryId: virtue },
      { permission: 'resource.submit', directoryId: virtue },
      { permission: 'directory.create_folder', directoryId: virtue },
    ],
  })
  assert.equal(a.status, 201, JSON.stringify(a.data))
  ids.teacherA = a.data.id

  const b = await adminClient.post('/api/users', {
    name: TEACHER_B.name,
    username: TEACHER_B.username,
    password: TEACHER_B.password,
    role: 'TEACHER',
    permissions: [
      { permission: 'resource.view', directoryId: virtue },
      { permission: 'resource.download', directoryId: virtue },
    ],
  })
  assert.equal(b.status, 201, JSON.stringify(b.data))
  ids.teacherB = b.data.id

  browser = await launchBrowser()
  await browser.enableDownloads(DOWNLOAD_DIR)
  await browser.startProblemWatch()
})

after(async () => {
  if (browser) await browser.close()
  await stopServer()
  rmSync(WORK, { recursive: true, force: true })
})

describe('① 完整业务链：管理员 → 教师 → 上传 → 审核 → 发布 → 下载 → 删除 → 恢复', () => {
  test('管理员在界面上创建老师并授权（不是走接口）', async () => {
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/admin/users`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="admin-users-page"]\')', 20000, '教师账号页')

    await browser.click('[data-testid="users-create"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="create-user-dialog"]\')', 15000, '新增弹窗')
    await browser.fill('[data-testid="new-user-name"]', '王老师')
    await browser.fill('[data-testid="new-user-username"]', 's10_teacher_c')
    await browser.fill('[data-testid="new-user-password"]', 'S10TeacherC!1')
    await browser.fill('[data-testid="new-user-confirm"]', 'S10TeacherC!1')
    await browser.waitFor('!!document.querySelector(\'[data-testid="permission-editor"]\')', 20000, '权限编辑器')
    await browser.click('[data-testid="permission-resource.view"]')
    await browser.click('[data-testid="permission-resource.download"]')
    /*
      ⚠️ 展开「Pre-K」之前必须先等目录树渲染出来。
      原来是 `const expanded = await exists(toggle); if (expanded) await click(toggle)`
      —— 一个静默短路：树还在路上时什么都不做、也不报错，
      失败会以"「美德」怎么等都不出现"的形式出现在 20 秒之后，
      完全看不出真正原因。现在树没出来就明确失败。
    */
    await browser.waitFor(
      `document.querySelectorAll('[data-testid^="directory-option-"]').length > 0`,
      20000,
      '权限编辑器里的目录树',
    )
    assert.equal(
      await browser.exists('[data-testid="directory-option-toggle-pre-k"]'),
      true,
      '权限编辑器里应当有 Pre-K 的展开箭头',
    )
    await browser.click('[data-testid="directory-option-toggle-pre-k"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-option-virtue"]\')', 20000, '「美德」出现')
    await browser.click('[data-testid="directory-option-virtue"]')
    await browser.click('[data-testid="create-user-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="users-notice"]\')', 20000, '创建成功')

    const [row] = await withSql((sql) => sql`
      SELECT u.id::text, count(p.id)::int AS grants
      FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
      WHERE u.username = 's10_teacher_c' GROUP BY 1`)
    assert.ok(row, '老师必须真的建出来了')
    assert.equal(row.grants, 2, '两条授权都要写进 user_permissions')
    ids.teacherC = row.id
  })

  test('张老师登录 → 一格格点进 美德 → 教学资源', async () => {
    await logout()
    await login(TEACHER_A.username, TEACHER_A.password)
    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
    ])
    assert.equal(await browser.text('[data-testid="directory-title"]'), '教学资源')
  })

  test('上传一份 PDF（保存为草稿）', async () => {
    ids.chain = await uploadThroughUi({
      title: '美德课程教案（业务链）',
      filePath: FIXTURES.pdf.path,
    })
    const row = await resourceRow(ids.chain)
    assert.ok(row, '资源必须真的落库')
    assert.equal(row.status, 'DRAFT', '上传完是草稿')
    assert.equal(row.files, 1, '文件必须真的登记了')
    assert.equal(row.directory_path, 'education/pre-k/virtue/resources')
  })

  test('刷新页面：数据仍在（不是只弹了个 toast）', async () => {
    await browser.reload()
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 20000, '详情页')
    assert.equal(await browser.text('[data-testid="resource-detail-title"]'), '美德课程教案（业务链）')
    assert.equal(await browser.text('[data-testid="file-name"]'), FIXTURES.pdf.name)
  })

  test('详情 → 预览 → 下载（sha256 一致）', async () => {
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview-pdf"]\')', 20000, 'PDF 预览')
    await browser.click('[data-testid="file-preview-close"]')

    await browser.click('[data-testid="file-download"]')
    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith('.pdf'))
    assert.equal(sha256(readFileSync(saved)), FIXTURES.pdf.sha256)
    rmSync(saved, { force: true })
  })

  test('提交审核 → 管理员通过并发布 → 教师回到目录找到它', async () => {
    await browser.click('[data-testid="action-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-status"]\')', 20000, '状态刷新')
    assert.equal((await resourceRow(ids.chain)).status, 'PENDING_REVIEW')

    await logout()
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/resources/${ids.chain}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-approve"]\')', 20000, '审核按钮')
    await browser.click('[data-testid="action-approve"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="resource-detail-status"]') &&
       document.querySelector('[data-testid="resource-detail-status"]').innerText.includes('已发布')`,
      20000,
      '状态变成已发布',
    )
    assert.equal((await resourceRow(ids.chain)).status, 'PUBLISHED')

    // 教师重新进入目录：必须能**找到**它（不是靠 URL 打开）
    await logout()
    await login(TEACHER_A.username, TEACHER_A.password)
    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
    ])
    await browser.waitFor(
      `[...document.querySelectorAll('[data-testid="resource-card-title"]')].some((e) => e.innerText.includes('美德课程教案（业务链）'))`,
      20000,
      '目录里找到刚发布的资源',
    )
  })

  test('教师打开它并下载（发布后别人也能下载）', async () => {
    const opened = await browser.session.eval(
      `(() => {
         const card = [...document.querySelectorAll('[data-testid="resource-card-title"]')]
           .find((e) => e.innerText.includes('美德课程教案（业务链）'))
         if (!card) return false
         card.click()
         return true
       })()`,
    )
    assert.equal(opened, true)
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-download"]\')', 20000, '下载按钮')
    await browser.click('[data-testid="file-download"]')
    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith('.pdf'))
    assert.equal(sha256(readFileSync(saved)), FIXTURES.pdf.sha256)
    rmSync(saved, { force: true })
  })
})

describe('② 目录导航：整条链路都靠点击', () => {
  test('教育教学 → Pre-K → 美德 → 课程大纲 / 教学详案 / 教学资源 / 考核评估', async () => {
    await clickThrough(['education', 'education/pre-k', 'education/pre-k/virtue'])
    const folders = await browser.allTexts('[data-testid="directory-card-name"]')
    for (const name of ['课程大纲', '教学详案', '教学资源', '考核评估']) {
      assert.ok(folders.includes(name), `美德下要有「${name}」，实际：${folders.join(' / ')}`)
    }
    for (const slug of ['outline', 'lesson', 'resources', 'assessment']) {
      await clickThrough([
        'education', 'education/pre-k', 'education/pre-k/virtue', `education/pre-k/virtue/${slug}`,
      ])
      assert.equal(
        await browser.attr('[data-testid="directory-page"]', 'data-directory-path'),
        `education/pre-k/virtue/${slug}`,
      )
    }
  })

  test('教师成长 → L1 → 安全施教规范 → 应急预案 → 传染病识别与防治（管理员视角）', async () => {
    /*
      教师成长这一支**没有开给张老师**（他的授权只有美德），所以侧边栏里本来就没有它 ——
      这里用管理员走，考的是"目录链能不能一路点下去"，不是权限。
      权限边界另有专门的一条（§12）。
    */
    await logout()
    await login(ADMIN.username, ADMIN.password)
    await clickThrough([
      'growth',
      'growth/l1',
      'growth/l1/safety',
      'growth/l1/safety/plan',
      'growth/l1/safety/plan/disease',
    ])
    assert.equal(await browser.text('[data-testid="directory-title"]'), '传染病识别与防治')
    // 面包屑要能回答"我在哪"
    const crumbs = await browser.allTexts('[data-testid="breadcrumb-item"]')
    assert.deepEqual(crumbs.slice(0, 2), ['教师成长', 'L1 基础规范'])
  })
})

describe('③ 管理员改目录名：四处同步、slug 不变', () => {
  test('美德 → 美德课程：Sidebar / Pre-K 页 / 目录页 / 面包屑 / 资源详情 全同步', async () => {
    // 详情页先记下改名前的面包屑
    await browser.goto(`${TEST_BASE}/resources/${ids.chain}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 20000, '详情页')

    await logout()
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/admin/directories`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-manage-page"]\')', 20000, '目录管理页')
    const row = `[data-testid="manage-row"][data-directory-slug="virtue"]`
    // 折叠的节点不渲染：先把 教育教学 → Pre-K 展开，才能看到美德那一行
    for (const slug of ['education', 'pre-k']) {
      const toggle = `[data-testid="manage-row"][data-directory-slug="${slug}"] [data-testid="manage-row-toggle"]`
      await browser.waitFor(`!!document.querySelector('${toggle}')`, 20000, `${slug} 的展开箭头`)
      await browser.click(toggle)
      await browser.waitFor('true', 500, '展开')
    }
    await browser.waitFor(`!!document.querySelector('${row}')`, 20000, '美德这一行')
    await browser.click(`${row} [data-testid="manage-edit"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-edit-dialog"]\')', 15000, '编辑弹窗')
    await browser.fill('[data-testid="manage-name-input"]', '美德课程')
    await browser.click('[data-testid="manage-save"]')
    await browser.waitFor(
      `document.querySelector('${row} [data-testid="manage-row-name"]')?.innerText === '美德课程'`,
      20000,
      '改名生效',
    )

    // ① 侧边栏（折叠的节点不渲染：先展开 教育教学 → Pre-K）
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 20000, '外壳')
    for (const slug of ['education', 'education/pre-k']) {
      const toggle = `[data-nav-toggle="/directory/${slug}"]`
      await browser.waitFor(`!!document.querySelector('${toggle}')`, 20000, `${slug} 的展开箭头`)
      if ((await browser.attr(toggle, 'aria-expanded')) !== 'true') await browser.click(toggle)
    }
    await browser.waitFor(
      `document.querySelector('[data-nav="/directory/education/pre-k/virtue"]')?.innerText.includes('美德课程')`,
      20000,
      '侧边栏同步',
    )
    // ② Pre-K 页面
    await clickThrough(['education', 'education/pre-k'])
    const children = await browser.allTexts('[data-testid="directory-card-name"]')
    assert.ok(children.includes('美德课程'), `Pre-K 页要同步：${children.join(' / ')}`)
    // ③ 目录页标题 + ⑤ slug 没变（地址不变，历史链接不失效）—— 都还在目录页上
    await clickThrough(['education', 'education/pre-k', 'education/pre-k/virtue'])
    assert.equal(await browser.text('[data-testid="directory-title"]'), '美德课程')
    assert.equal(
      await browser.attr('[data-testid="directory-page"]', 'data-directory-path'),
      'education/pre-k/virtue',
      '改名不能改地址',
    )
    const [dir] = await withSql((sql) => sql`
      SELECT slug, name FROM directories WHERE slug = 'virtue'`)
    assert.equal(dir.name, '美德课程')
    assert.equal(dir.slug, 'virtue', 'slug 不能因为改名而变')

    // ④ 详情页的面包屑
    await browser.goto(`${TEST_BASE}/resources/${ids.chain}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 20000, '详情页')
    const crumbs = await browser.allTexts('[data-testid="breadcrumb-item"]')
    assert.ok(crumbs.includes('美德课程'), `详情页面包屑要同步：${crumbs.join(' / ')}`)
    // 地址仍然是 slug 拼出来的那个（历史链接不失效）
    assert.match(String(await browser.url()), new RegExp(`/resources/${ids.chain}$`))

    // 改回去，后面的用例仍然按「美德」找
    await browser.goto(`${TEST_BASE}/admin/directories`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-manage-page"]\')', 20000, '目录管理页')
    for (const slug of ['education', 'pre-k']) {
      const toggle = `[data-testid="manage-row"][data-directory-slug="${slug}"] [data-testid="manage-row-toggle"]`
      await browser.waitFor(`!!document.querySelector('${toggle}')`, 20000, `${slug} 的展开箭头`)
      await browser.click(toggle)
      await browser.waitFor('true', 400, '展开')
    }
    await browser.waitFor(`!!document.querySelector('${row}')`, 20000, '美德这一行')
    await browser.click(`${row} [data-testid="manage-edit"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-edit-dialog"]\')', 15000, '编辑弹窗')
    await browser.fill('[data-testid="manage-name-input"]', '美德')
    await browser.click('[data-testid="manage-save"]')
    await browser.waitFor(
      `document.querySelector('${row} [data-testid="manage-row-name"]')?.innerText === '美德'`,
      20000,
      '改回美德',
    )
  })
})

describe('④ 新增一级栏目 活动 → 2027 春季活动 → 春游（刷新仍在）', () => {
  test('管理员建出三级链路', async () => {
    await browser.goto(`${TEST_BASE}/admin/directories`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-add-root"]\')', 20000, '新增一级栏目')

    const createAt = async (parentSlug, name, slug) => {
      if (parentSlug === null) await browser.click('[data-testid="manage-add-root"]')
      else await browser.click(`[data-testid="manage-row"][data-directory-slug="${parentSlug}"] [data-testid="manage-add-child"]`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="manage-create-dialog"]\')', 15000, '新建弹窗')
      await browser.fill('[data-testid="manage-create-name"]', name)
      await browser.fill('[data-testid="manage-create-slug"]', slug)
      await browser.click('[data-testid="manage-create-submit"]')
      await browser.waitFor(
        `!!document.querySelector('[data-testid="manage-row"][data-directory-slug="${slug}"]')`,
        20000,
        `${name} 出现`,
      )
    }
    ids.activityRoot = `s10-activity-${Date.now().toString().slice(-6)}`
    ids.activity2027 = `${ids.activityRoot}-2027`
    ids.activityTrip = `${ids.activityRoot}-trip`
    await createAt(null, '活动', ids.activityRoot)
    await createAt(ids.activityRoot, '2027 春季活动', ids.activity2027)
    await createAt(ids.activity2027, '春游', ids.activityTrip)

    await browser.reload()
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-manage-page"]\')', 20000, '目录管理页')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="manage-row"][data-directory-slug="${ids.activityRoot}"]')`,
      20000,
      '刷新后一级栏目还在',
    )
    // 折叠的节点不渲染：逐级展开再断言
    for (const [parent, child] of [[ids.activityRoot, ids.activity2027], [ids.activity2027, ids.activityTrip]]) {
      const toggle = `[data-testid="manage-row"][data-directory-slug="${parent}"] [data-testid="manage-row-toggle"]`
      await browser.waitFor(`!!document.querySelector('${toggle}')`, 15000, '展开箭头')
      await browser.click(toggle)
      await browser.waitFor(
        `!!document.querySelector('[data-testid="manage-row"][data-directory-slug="${child}"]')`,
        20000,
        '刷新后下级还在',
      )
    }
    const [trip] = await withSql((sql) => sql`
      SELECT id::text FROM directories WHERE slug = ${ids.activityTrip}`)
    ids.activityTripId = trip.id
  })

  test('授权之后老师能看到「活动」（目录是唯一真相，不用改代码）', async () => {
    const rootId = await withSql(async (sql) => {
      const [row] = await sql`SELECT id::text FROM directories WHERE slug = ${ids.activityRoot}`
      return row.id
    })
    // 管理员把「活动」开给张老师（沿用原有授权 + 新目录）
    const grants = await adminClient.get(`/api/users/${ids.teacherA}/permissions`)
    const payload = grants.data.items.map((i) => ({ permission: i.permission, directoryId: i.directoryId }))
    await adminClient.put(`/api/users/${ids.teacherA}/permissions`, {
      permissions: [
        ...payload,
        { permission: 'resource.view', directoryId: rootId },
        { permission: 'directory.create_folder', directoryId: rootId },
      ],
    })

    await logout()
    await login(TEACHER_A.username, TEACHER_A.password)
    await clickThrough([ids.activityRoot])
    assert.equal(await browser.text('[data-testid="directory-title"]'), '活动')
    await browser.click(`[data-nav="/directory/${ids.activityRoot}"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 15000, '活动页')
    const children = await browser.allTexts('[data-testid="directory-card-name"]')
    assert.ok(children.includes('2027 春季活动'), `老师能看到下级：${children.join(' / ')}`)
  })
})

describe('⑤ 教学资源下自建文件夹「环境创设」', () => {
  test('老师建文件夹 → 刷新仍在 → 进去上传 → 资源属于它', async () => {
    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
    ])
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-create-folder"]\')', 20000, '新建文件夹按钮')
    await browser.click('[data-testid="directory-create-folder"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="create-folder-dialog"]\')', 15000, '新建文件夹弹窗')
    await browser.fill('[data-testid="create-folder-name"]', '环境创设')
    // 只填中文名 → 界面必须先说清楚"地址生成不出来"，而不是等服务端报错
    await browser.click('[data-testid="create-folder-submit"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="create-folder-error"]')`,
      15000,
      '中文名的提示',
    )
    assert.match(String(await browser.text('[data-testid="create-folder-error"]')), /英文|拼音/)
    await browser.fill('[data-testid="create-folder-name-en"]', 'huanjing')
    await browser.click('[data-testid="create-folder-submit"]')
    // 建完直接进去
    await browser.waitFor(
      `document.querySelector('[data-testid="directory-title"]')?.innerText === '环境创设'`,
      20000,
      '进入新文件夹',
    )
    ids.envFolderPath = await browser.attr('[data-testid="directory-page"]', 'data-directory-path')
    assert.match(String(ids.envFolderPath), /^education\/pre-k\/virtue\/resources\//)

    // 刷新之后仍在（"建完就没了"必须被挡住）
    await browser.reload()
    await browser.waitFor(
      `document.querySelector('[data-testid="directory-title"]')?.innerText === '环境创设'`,
      20000,
      '刷新后仍在同一个文件夹',
    )
    const [dir] = await withSql((sql) => sql`
      SELECT id::text, name FROM directories WHERE slug = 'env-creation' OR name = '环境创设'`)
    assert.ok(dir, '文件夹必须真的落库')
    assert.equal(dir.name, '环境创设')
    assert.equal(await directoryPathById(dir.id), ids.envFolderPath)
    ids.envFolderId = dir.id

    // 在里面上传：资源必须属于这个文件夹
    ids.envResource = await uploadThroughUi({
      title: '环境创设照片集',
      filePath: FIXTURES.png.path,
    })
    const row = await resourceRow(ids.envResource)
    assert.equal(row.directory_path, ids.envFolderPath, '资源必须属于刚建的文件夹')
  })
})

describe('⑥ 八种文件类型：真实上传', () => {
  test('PDF / JPG / PNG / TXT / DOCX / XLSX / PPTX / ZIP 各传一次', async () => {
    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/lesson',
    ])
    for (const [key, f] of Object.entries(FIXTURES)) {
      const id = await uploadThroughUi({ title: `类型试验：${key}`, filePath: f.path })
      ids[`type_${key}`] = id
      const row = await resourceRow(id)
      assert.equal(row.files, 1, `${key} 的文件必须登记成功`)
      const [file] = await withSql((sql) => sql`
        SELECT file_name, size, sha256 FROM resource_files WHERE resource_id = ${id}`)
      assert.equal(file.file_name, f.name)
      assert.equal(Number(file.size), f.bytes.length, `${key} 的字节数要对得上`)
      assert.equal(file.sha256, f.sha256, `${key} 的 sha256 要由服务端算出来`)

      // 回到上传所在的资料夹，继续传下一个
      await clickThrough([
        'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/lesson',
      ])
    }
  })
})

describe('⑦ 保存草稿后刷新：数据仍在', () => {
  test('八条资源刷新后都还在，而且状态是草稿', async () => {
    const rows = await withSql((sql) => sql`
      SELECT title, status FROM resources WHERE title LIKE '类型试验：%' ORDER BY title`)
    assert.equal(rows.length, 8, `八种类型各一条，实际 ${rows.length}`)
    for (const r of rows) assert.equal(r.status, 'DRAFT')

    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-page"]\')', 20000, '我的资源')
    await browser.reload()
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-list"]\')', 20000, '列表')
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.filter((t) => t.includes('类型试验：')).length > 0, true, '刷新后草稿还在')
  })
})

describe('⑧ 预览：能预览的真渲染，不能预览的给指定文案', () => {
  test('PDF：真实打开（签名地址 + iframe）', async () => {
    await browser.goto(`${TEST_BASE}/resources/${ids.type_pdf}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮')
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview-pdf"]\')', 20000, 'PDF iframe')
    const src = await browser.attr('[data-testid="file-preview-pdf"]', 'src')
    assert.match(String(src), /token=|X-Amz-Signature=/, '预览必须是短命签名地址')
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('图片：真实显示（img 真的加载完成，不是坏图）', async () => {
    for (const key of ['png', 'jpg']) {
      await browser.goto(`${TEST_BASE}/resources/${ids[`type_${key}`]}`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮')
      await browser.click('[data-testid="file-preview"]')
      await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview-image"]\')', 20000, '图片预览')
      // naturalWidth > 0 = 浏览器真的解码成功了；只看 <img> 存在会漏掉坏图
      const loaded = await browser.session.eval(
        `(() => {
           const img = document.querySelector('[data-testid="file-preview-image"]')
           return img.complete && img.naturalWidth > 0
         })()`,
      )
      assert.equal(loaded, true, `${key} 的图片必须真的解码成功（不是坏图）`)
      await browser.click('[data-testid="file-preview-close"]')
    }
  })

  test('TXT：真实渲染出内容', async () => {
    await browser.goto(`${TEST_BASE}/resources/${ids.type_txt}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮')
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview-text"]\')', 20000, '文本预览')
    const text = await browser.text('[data-testid="file-preview-text"]')
    assert.match(String(text), /这是一份真实的活动说明文本/, `文本要真的渲染出来：${text}`)
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('DOCX / XLSX / PPTX / ZIP：没有预览按钮，显示业主指定的那句话，而且能下载', async () => {
    for (const key of ['docx', 'xlsx', 'pptx', 'zip']) {
      await browser.goto(`${TEST_BASE}/resources/${ids[`type_${key}`]}`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="file-row"]\')', 20000, '文件行')
      const previewBtn = await clickFileAction(FIXTURES[key].name, 'file-preview')
      assert.equal(previewBtn, 'no-button', `${key} 不该有预览按钮`)
      const message = await browser.text('[data-testid="file-preview-unsupported"]')
      assert.equal(
        message,
        '此文件类型暂不支持在线预览，请下载查看。',
        `${key} 的提示必须与业主指定的一致，实际「${message}」`,
      )
      assert.equal(await browser.exists('[data-testid="file-download"]'), true, `${key} 仍然可以下载`)
    }
  })
})

describe('⑨ 下载：每一个允许下载的文件，sha256 与上传一致', () => {
  test('八种类型逐个下载并核对', async () => {
    for (const [key, f] of Object.entries(FIXTURES)) {
      await browser.goto(`${TEST_BASE}/resources/${ids[`type_${key}`]}`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="file-download"]\')', 20000, '下载按钮')
      await browser.click('[data-testid="file-download"]')
      const ext = f.name.split('.').pop()
      const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith(`.${ext}`))
      assert.equal(
        sha256(readFileSync(saved)),
        f.sha256,
        `${key} 下载回来的字节必须与上传的逐字节一致`,
      )
      rmSync(saved, { force: true })
    }
  })
})

describe('⑩ 审核：退回必须有原因，教师看得到，改完能重新提交', () => {
  test('教师提交 → 管理员退回（不写原因会被拒）', async () => {
    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/resources/${ids.type_docx}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-submit"]\')', 20000, '提交按钮')
    await browser.click('[data-testid="action-submit"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('待审核')`,
      20000,
      '变成待审核',
    )

    await logout()
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/resources/${ids.type_docx}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-reject"]\')', 20000, '退回按钮')
    await browser.click('[data-testid="action-reject"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="reject-comment"]\')', 15000, '退回原因输入框')
    // 不写原因直接提交：界面必须拦住（服务端也有一道，见 422 那条的说明）
    await browser.click('[data-testid="reject-submit"]')
    const stillPending = (await resourceRow(ids.type_docx)).status
    assert.equal(stillPending, 'PENDING_REVIEW', '没有原因的退回必须被拦住')
    ids.rejectDeniedByUi = true

    await browser.fill('[data-testid="reject-comment"]', '周次写错了，请改成 S2 W3 再提交')
    await browser.click('[data-testid="reject-submit"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('已退回')`,
      20000,
      '变成已退回',
    )
    assert.equal((await resourceRow(ids.type_docx)).status, 'REJECTED')
  })

  test('教师看得到退回原因，编辑后重新提交', async () => {
    await logout()
    await login(TEACHER_A.username, TEACHER_A.password)

    // 我的资源 → 已退回
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-tabs"]\')', 20000, '我的资源')
    const clicked = await browser.session.eval(
      `(() => {
         const tab = [...document.querySelectorAll('[data-testid="my-resources-tab"]')]
           .find((t) => t.innerText.trim() === '已退回')
         if (!tab) return false
         tab.click()
         return true
       })()`,
    )
    assert.equal(clicked, true, '要有「已退回」这一栏')
    await browser.waitFor(
      `[...document.querySelectorAll('[data-testid="resource-card-review-comment"]')].length > 0`,
      20000,
      '退回原因显示在卡片上',
    )
    assert.match(
      String(await browser.text('[data-testid="resource-card-review-comment"]')),
      /周次写错了/,
      '教师必须看得到原因',
    )

    // 详情页的审核记录里也有
    await browser.goto(`${TEST_BASE}/resources/${ids.type_docx}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="review-history"]\')', 20000, '审核记录')
    const comments = await browser.allTexts('[data-testid="review-history-comment"]')
    assert.equal(comments.some((c) => String(c).includes('周次写错了')), true, `审核记录要有原因：${comments.join(' | ')}`)

    // 编辑 → 退回的编辑会回到草稿 → 再提交
    await browser.click('[data-testid="resource-detail-edit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-edit-form"]\')', 15000, '编辑表单')
    await browser.fill('[data-testid="resource-edit-title"]', '类型试验：docx（已按意见修改）')
    await browser.click('[data-testid="resource-edit-save"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('草稿')`,
      20000,
      '改完回到草稿',
    )
    assert.equal((await resourceRow(ids.type_docx)).status, 'DRAFT')

    await browser.click('[data-testid="action-submit"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('待审核')`,
      20000,
      '重新提交成功',
    )
  })
})

describe('⑪ 撤回：目录里消失，我的资源里仍在', () => {
  test('已发布的资源撤回之后，目录里找不到，但我的资源里还在', async () => {
    await logout()
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/resources/${ids.type_docx}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-approve"]\')', 20000, '审核按钮')
    await browser.click('[data-testid="action-approve"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('已发布')`,
      20000,
      '发布',
    )

    await browser.waitFor('!!document.querySelector(\'[data-testid="action-recall"]\')', 20000, '撤回按钮')
    await browser.click('[data-testid="action-recall"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="recall-comment"]\')', 15000, '撤回说明')
    await browser.fill('[data-testid="recall-comment"]', '内容需要复核，先下线')
    await browser.click('[data-testid="recall-submit"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('已撤回')`,
      20000,
      '变成已撤回',
    )
    assert.equal((await resourceRow(ids.type_docx)).status, 'RECALLED')

    // 目录里找不到它了（对老师而言）
    await logout()
    await login(TEACHER_A.username, TEACHER_A.password)
    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/lesson',
    ])
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(
      titles.some((t) => String(t).includes('已按意见修改')),
      false,
      `撤回之后目录列表里不该还有它：${titles.join(' / ')}`,
    )

    // 我的资源 → 已撤回：还在
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-tabs"]\')', 20000, '我的资源')
    await browser.session.eval(
      `(() => {
         const tab = [...document.querySelectorAll('[data-testid="my-resources-tab"]')]
           .find((t) => t.innerText.trim() === '已撤回')
         tab?.click()
       })()`,
    )
    await browser.waitFor(
      `[...document.querySelectorAll('[data-testid="resource-card-title"]')].some((e) => e.innerText.includes('已按意见修改'))`,
      20000,
      '我的资源里仍然看得到',
    )
  })
})

describe('⑫ 权限边界：只给「美德」，就只到「美德」', () => {
  test('教师看不到没授权的目录，也不能从地址栏绕进去', async () => {
    await clickThrough(['education', 'education/pre-k', 'education/pre-k/virtue'])
    const sidebar = await browser.allAttrs('[data-nav]', 'data-nav')
    assert.equal(
      sidebar.some((p) => String(p).includes('/education/pre-k/montessori')),
      false,
      `没授权的目录不该出现在侧边栏：${sidebar.join(' ')}`,
    )

    // 直接开地址：不白屏、也不给看，回退到最近可访问的祖先并说明原因
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/montessori`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 20000, '目录页')
    const path = await browser.attr('[data-testid="directory-page"]', 'data-directory-path')
    assert.notEqual(path, 'education/pre-k/montessori', '不能真的进去')
    assert.equal(await browser.exists('[data-testid="directory-notice"]'), true, '要说明为什么被带到了这里')
    assert.equal(await browser.exists('[data-testid="resource-detail-page"]'), false)
  })

  test('直接请求接口同样 403（不是只靠前端挡）', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)

    const montessori = await teacher.get(`/api/resources?directoryId=${ids.montessori}`)
    assert.equal(montessori.status, 403, JSON.stringify(montessori.data))

    const kTree = await teacher.get('/api/directories/tree')
    assert.equal(kTree.status, 200)
    const paths = JSON.stringify(kTree.data)
    assert.equal(paths.includes('montessori'), false, '目录树本身也不该含未授权节点')

    // 往没授权的目录上传：403
    const upload = await teacher.post('/api/resources', {
      directoryId: ids.montessori,
      title: '偷传的资源',
    })
    assert.equal(upload.status, 403, JSON.stringify(upload.data))
    // K 也一样
    const uploadK = await teacher.post('/api/resources', {
      directoryId: ids.kChinese,
      title: '偷传到 K 的资源',
    })
    assert.equal(uploadK.status, 403, JSON.stringify(uploadK.data))
  })
})

describe('⑬ Session：改权限 / 停用之后立刻失效', () => {
  test('管理员改权限 → 老师的旧会话立刻不能用 → 重新登录后新权限生效', async () => {
    // 张老师此刻在浏览器里是登录状态
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 20000, '登录中')

    const kRoot = await withSql(async (sql) => {
      const [row] = await sql`SELECT id::text FROM directories WHERE slug = 'k' AND parent_id IS NOT NULL`
      return row.id
    })
    const current = await adminClient.get(`/api/users/${ids.teacherA}/permissions`)
    const payload = current.data.items.map((i) => ({ permission: i.permission, directoryId: i.directoryId }))
    const saved = await adminClient.put(`/api/users/${ids.teacherA}/permissions`, {
      permissions: [...payload, { permission: 'resource.view', directoryId: kRoot }],
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.data.revokedSessions >= 1, true, '改权限必须撤销旧会话')

    // 浏览器里立刻不再有效（下一个请求就是 401 → 回登录页）
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 25000, '被送回登录页')
    allowedNoise.push('/api/auth/me')

    // 重新登录：新权限生效（K 出现了）
    await login(TEACHER_A.username, TEACHER_A.password)
    await clickThrough(['education', 'education/k'])
    assert.equal(await browser.text('[data-testid="directory-title"]'), 'K')
  })

  test('管理员停用账号 → 旧会话立刻失效，而且登不回来', async () => {
    await adminClient.patch(`/api/users/${ids.teacherA}`, { active: false })
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 25000, '被送回登录页')
    allowedNoise.push('/api/auth/me')

    await browser.fill('[data-testid="login-username"]', TEACHER_A.username)
    await browser.fill('[data-testid="login-password"]', TEACHER_A.password)
    await browser.click('[data-testid="login-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-error"]\')', 20000, '拒绝登录的提示')
    assert.equal(await browser.exists('[data-testid="sidebar"]'), false, '停用之后进不去')
    allowedNoise.push('/api/auth/login')

    // 恢复启用，后面的用例继续用这位老师
    await adminClient.patch(`/api/users/${ids.teacherA}`, { active: true })
  })
})

describe('⑭ 回收站：删除 → 恢复；管理员看得到全部人的', () => {
  test('教师删掉自己上传的资源 → 进回收站（不是抹掉）', async () => {
    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/resources/${ids.envResource}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-delete"]\')', 20000, '删除按钮')
    await browser.click('[data-testid="resource-detail-delete"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-delete-dialog"]\')', 15000, '删除确认')
    await browser.click('[data-testid="resource-delete-confirm"]')

    const row = await resourceRow(ids.envResource)
    assert.equal(row.deleted_at !== null, true, '软删除：deleted_at 必须写上')
    assert.equal(row.files, 1, '文件行还在（回收站不是抹掉）')

    const [audit] = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM audit_logs
      WHERE action = 'resource.delete' AND target_id = ${ids.envResource}`)
    assert.equal(audit.n >= 1, true, '删除要留审计')
  })

  test('「我的资源 → 回收站」里能恢复，恢复后回到原目录', async () => {
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-tabs"]\')', 20000, '我的资源')
    const clicked = await browser.session.eval(
      `(() => {
         const tab = [...document.querySelectorAll('[data-testid="my-resources-tab"]')]
           .find((t) => t.innerText.trim() === '回收站')
         if (!tab) return false
         tab.click()
         return true
       })()`,
    )
    assert.equal(clicked, true, '要有「回收站」这一栏')
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resource-restore"]\')', 20000, '恢复按钮')

    // 点之前先确认它确实处于"已删除"状态 —— 否则后面的报错会指向错误的方向
    const before = await resourceRow(ids.envResource)
    assert.notEqual(
      before.deleted_at,
      null,
      `点恢复之前它必须是已删除状态（deleted_at=${before.deleted_at}）`,
    )
    browser.clearProblems()
    await browser.click('[data-testid="my-resource-restore"]')
    try {
      await browser.waitFor(
        '!document.querySelector(\'[data-testid="my-resource-restore"]\')',
        20000,
        '恢复后回收站里就没有它了',
      )
    } catch (e) {
      const http = browser.watchedProblems().filter((p) => p.kind === 'http')
      const err = await browser.session.eval(
        `document.querySelector('[data-testid="my-resources-action-error"]')?.innerText ?? '(无错误)'`,
      )
      const now = await resourceRow(ids.envResource)
      throw new Error(
        `${e.message}\n  HTTP：${JSON.stringify(http)}\n  页面错误：${err}\n  deleted_at=${now?.deleted_at}`,
      )
    }

    const row = await resourceRow(ids.envResource)
    assert.equal(row.deleted_at, null, '恢复 = deleted_at 清空')
    assert.equal(row.directory_path, ids.envFolderPath, '恢复后目录归属不变（回到原目录）')

    // 我的资源（全部）里重新出现
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-list"]\')', 20000, '我的资源列表')
    let titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.includes('环境创设照片集'), true, `恢复后我的资源里要重新出现：${titles.join(' / ')}`)

    /*
      目录浏览页**只列已发布**（阶段 7 §17：未发布的内容只在自己的「我的资源」里）。
      恢复回来的是草稿，所以它此刻不该出现在浏览页 —— 这是设计，不是 bug。
      要验证"目录里也重新出现"，先让它发布，再回目录看。
    */
    await adminClient.post(`/api/resources/${ids.envResource}/submit`)
    await adminClient.post(`/api/resources/${ids.envResource}/review`, { action: 'approve' })
    await browser.goto(`${TEST_BASE}/directory/${ids.envFolderPath}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list"]\')', 20000, '资源列表')
    titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.includes('环境创设照片集'), true, `发布后原目录里要重新出现：${titles.join(' / ')}`)
  })

  test('管理员在回收站里看得到别人删掉的资源', async () => {
    // 张老师再删一条（先确认它现在确实可删：草稿、本人上传）
    const before = await resourceRow(ids.type_zip)
    assert.equal(before.status, 'DRAFT', `这条应当是草稿：${before.status}`)
    await browser.goto(`${TEST_BASE}/resources/${ids.type_zip}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-delete"]\')', 20000, '删除按钮')
    await browser.click('[data-testid="resource-detail-delete"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-delete-dialog"]\')', 15000, '删除确认')
    await browser.click('[data-testid="resource-delete-confirm"]')
    assert.equal((await resourceRow(ids.type_zip)).deleted_at !== null, true)

    await logout()
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-tabs"]\')', 20000, '我的资源')
    await browser.session.eval(
      `(() => {
         const tab = [...document.querySelectorAll('[data-testid="my-resources-tab"]')]
           .find((t) => t.innerText.trim() === '回收站')
         tab?.click()
       })()`,
    )
    await browser.waitFor(
      `[...document.querySelectorAll('[data-testid="resource-card-title"]')].some((e) => e.innerText.includes('类型试验：zip'))`,
      20000,
      '管理员要能看到别人删的资源',
    )
  })
})

describe('⑮ 搜索：资源名 / 文件名 / 目录，且只返回有权内容', () => {
  test('按资源名、文件名、目录名都能搜到', async () => {
    await logout()
    await login(TEACHER_A.username, TEACHER_A.password)
    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/lesson',
    ])

    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-search-input"]\')', 20000, '搜索框')

    const search = async (term) => {
      await browser.fill('[data-testid="resource-search-input"]', term)
      await browser.click('[data-testid="resource-search-submit"]')
      await browser.waitFor(
        `!!document.querySelector('[data-testid="resource-list"]') || !!document.querySelector('[data-testid="resource-list-empty"]')`,
        20000,
        '搜索有结果或空状态',
      )
      return browser.allTexts('[data-testid="resource-card-title"]')
    }

    /*
      搜索要在**有已发布资源**的地方做：目录浏览页只列已发布的内容（阶段 7 §17），
      草稿搜不到是设计，不是搜索坏了。
      三个片段刻意各不相同，才能分别证明"标题 / 文件名 / 目录"三个字段都参与了匹配：
        · 标题：'业务链'       —— 只出现在标题里
        · 文件名：'.pdf'      —— 只出现在文件名里（标题里没有扩展名）
        · 目录：'教学资源'     —— 那条资源所在目录的名字（标题与文件名里都没有）
    */
    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
    ])
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-search-input"]\')', 20000, '搜索框')

    const byTitle = await search('业务链')
    assert.equal(byTitle.some((t) => String(t).includes('美德课程教案')), true, `按资源名要搜得到：${byTitle.join(' / ')}`)
    const byFile = await search('.pdf')
    assert.equal(byFile.some((t) => String(t).includes('美德课程教案')), true, `按文件名要搜得到：${byFile.join(' / ')}`)
    const byDir = await search('教学资源')
    assert.equal(byDir.some((t) => String(t).includes('美德课程教案')), true, `按目录名要搜得到：${byDir.join(' / ')}`)

    await browser.click('[data-testid="resource-search-clear"]')
  })

  test('搜不到没权限的目录里的东西', async () => {
    // 管理员在 K 里放一条显眼的
    /*
      放进 K 的**资料夹**里（`教学资源`）而不是科目层：
      科目层 `allow_files = false`（它只做导航），往里建资源服务端会回 409 ——
      那是对的行为，所以夹具必须放对地方。
    */
    const kFolder = await directoryIdByPath('education/k/chinese/picture-books/resources')
    const secret = await adminClient.post('/api/resources', {
      directoryId: kFolder,
      title: 'K 的秘密资源',
    })
    assert.equal(secret.status, 201, JSON.stringify(secret.data))
    ids.kSecret = secret.data.id

    const teacherB = client()
    await teacherB.login(TEACHER_B.username, TEACHER_B.password)
    const res = await teacherB.get('/api/resources?q='.concat(encodeURIComponent('秘密资源')))
    assert.equal(res.status, 200)
    assert.equal(res.data.total, 0, '没有权限的内容不许出现在搜索结果里')

    const asAdmin = await adminClient.get('/api/resources?q='.concat(encodeURIComponent('秘密资源')))
    assert.equal(asAdmin.data.total, 1, '管理员搜得到（对照，说明搜索本身是好的）')
  })
})

describe('⑯ 分页：制造 60 条资源，翻到最后一页', () => {
  test('>50 条时能翻页，且每一条都能访问', async () => {
    const folder = await directoryIdByPath('education/pre-k/virtue/resources')
    await withSql(async (sql) => {
      for (let i = 1; i <= 60; i += 1) {
        await sql`
          INSERT INTO resources (directory_id, title, status, uploader_id, published_at)
          VALUES (${folder}, ${`分页探针 ${String(i).padStart(2, '0')}`}, 'PUBLISHED', ${ids.teacherA}, now())`
      }
    })
    const [count] = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM resources WHERE directory_id = ${folder} AND deleted_at IS NULL`)
    assert.equal(count.n >= 61, true, `这个目录里应当有 60+ 条，实际 ${count.n}`)

    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
    ])
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-page-info"]\')', 20000, '分页信息')
    const total = await browser.text('[data-testid="resource-total"]')
    assert.match(String(total), /共\s*6[0-9]\s*条/, `要给出总数：${total}`)
    const info = await browser.text('[data-testid="resource-page-info"]')
    assert.match(String(info), /第\s*1\s*页\s*\/\s*共\s*[5-9]\s*页/, `要给出页数：${info}`)

    const seen = new Set()
    let guard = 0
    while ((await browser.exists('[data-testid="resource-page-next"]')) && guard < 20) {
      const page = await browser.allTexts('[data-testid="resource-card-title"]')
      for (const t of page) seen.add(String(t))
      const disabled = await browser.attr('[data-testid="resource-page-next"]', 'aria-disabled')
      if (disabled === 'true') break
      await browser.click('[data-testid="resource-page-next"]')
      guard += 1
      await browser.waitFor('true', 400, '翻页')
      await browser.waitFor(
        `document.querySelector('[data-testid="resource-page-info"]') !== null`,
        20000,
        '翻页后有信息',
      )
    }
    const probes = [...seen].filter((t) => t.startsWith('分页探针'))
    assert.equal(probes.length, 60, `60 条探针都要能被翻到，实际翻到 ${probes.length} 条`)
    assert.equal(new Set(probes).size, 60, '不能有重复（分页不能漏也不能重）')
  })
})

describe('⑰ 空状态：三种情况都要给对的话', () => {
  test('完全没有资源：说"暂无资源"', async () => {
    /*
      "完全没有资源"要用一个**能放资源、但什么都没放**的目录。
      两个坑都踩过了：
        · 「环境创设」里已经有一条恢复并发布的资源 —— 拿它测空状态是错的；
        · 「春游」是管理员新建的导航节点（allowFiles=false）—— 它**根本不渲染资源列表**，
          "没有空状态"在那里是正确的行为。
      所以用 K 中文教学 → STEM → 教学资源：能放文件、且一条都没有
      （张老师在 §13 拿到了 K 的查看权限，所以这也顺带验证了那次授权）。
    */
    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/directory/education/k/chinese/stem/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list-empty"]\')', 20000, '空状态')
    const text = String(await browser.text('[data-testid="resource-list-empty"]'))
    assert.match(text, /暂无资源/)
    assert.match(text, /还没有资源/)
    // 而且不是一个错误页、不是白屏
    assert.equal(await browser.exists('[data-testid="resource-list-error"]'), false)
  })

  test('只有未发布的资源：浏览页对谁都显示空（未发布只在自己的「我的资源」里）', async () => {
    /*
      这里要说清一条**设计**（阶段 7 §17）：目录浏览页只列**已发布**的资源；
      草稿、待审核、已退回、已撤回都只出现在上传者自己的「我的资源」里。
      所以"这个目录里只有我的草稿"对浏览页来说就是**空** —— 对本人也一样。
      第一版用例写成了"本人看得到自己的草稿"，那是把「我的资源」的行为
      错安到浏览页上；两种页面各司其职，这里分别断言。
    */
    await login(TEACHER_A.username, TEACHER_A.password)
    await clickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/outline',
    ])
    ids.onlyDraft = await uploadThroughUi({
      title: '只有我能看到的草稿',
      filePath: FIXTURES.txt.path,
    })
    assert.equal((await resourceRow(ids.onlyDraft)).status, 'DRAFT')

    // 浏览页：空状态
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/outline`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list-empty"]\')', 20000, '浏览页空状态')
    assert.match(String(await browser.text('[data-testid="resource-list-empty"]')), /暂无资源/)

    // 本人：在「我的资源 → 草稿」里看得到
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-list"]\')', 20000, '我的资源')
    await browser.session.eval(
      `(() => {
         const tab = [...document.querySelectorAll('[data-testid="my-resources-tab"]')]
           .find((t) => t.innerText.trim() === '草稿')
         tab?.click()
       })()`,
    )
    await browser.waitFor(
      `[...document.querySelectorAll('[data-testid="resource-card-title"]')].some((e) => e.innerText.includes('只有我能看到的草稿'))`,
      20000,
      '本人看得到自己的草稿',
    )

    // 别人：浏览页同样看不到（不是报错，是空状态）
    await logout()
    await login(TEACHER_B.username, TEACHER_B.password)
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/outline`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list-empty"]\')', 20000, '别人也是空状态')
    assert.equal(
      (await resourceRow(ids.onlyDraft)).status,
      'DRAFT',
      '别人的草稿仍然是草稿（没人动过它）',
    )
  })
})

describe('⑱ 错误：401 / 403 / 404 / 409 / 422 / 429', () => {
  test('401：未登录访问接口被拒；界面被送到登录页（不白屏）', async () => {
    const anon = client()
    const res = await anon.get('/api/resources')
    assert.equal(res.status, 401, JSON.stringify(res.data))

    await logout()
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 25000, '未登录访问受保护页面 → 登录页')
    allowedNoise.push('/api/auth/me')
  })

  test('403：越权操作给出明确提示，不是静默失败', async () => {
    const teacherB = client()
    await teacherB.login(TEACHER_B.username, TEACHER_B.password)
    // 李老师没有 update 权限，也不是上传者
    const del = await teacherB.del(`/api/resources/${ids.chain}`)
    assert.equal(del.status, 403, JSON.stringify(del.data))
    assert.match(String(del.data.message ?? ''), /权限|只能/, `403 要有可读的原因：${JSON.stringify(del.data)}`)
  })

  test('404：不存在的资源 → 接口 404，界面给「找不到这条资源」而不是白屏', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff'
    const res = await adminClient.get(`/api/resources/${missing}`)
    assert.equal(res.status, 404, JSON.stringify(res.data))

    browser.clearProblems()
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/resources/${missing}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-notfound"]\')', 20000, '找不到资源的提示')
    assert.equal(await browser.exists('[data-testid="resource-detail-page"]'), true, '页面结构仍在（不是白屏）')
    // 这一条 404 是**故意**制造的
    allowedNoise.push(`/api/resources/${missing}`)
  })

  test('409：用户名重复 → 界面上说明白，而不是"创建失败"', async () => {
    const res = await adminClient.post('/api/users', {
      name: '重名的人',
      username: TEACHER_B.username,
      password: 'WhateverPass!1',
      role: 'TEACHER',
    })
    assert.equal(res.status, 409, JSON.stringify(res.data))

    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/admin/users`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="users-create"]\')', 20000, '新增按钮')
    await browser.click('[data-testid="users-create"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="create-user-dialog"]\')', 15000, '新增弹窗')
    await browser.fill('[data-testid="new-user-name"]', '重名的人')
    await browser.fill('[data-testid="new-user-username"]', TEACHER_B.username)
    await browser.fill('[data-testid="new-user-password"]', 'WhateverPass!1')
    await browser.fill('[data-testid="new-user-confirm"]', 'WhateverPass!1')
    await browser.click('[data-testid="create-user-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="create-user-error"]\')', 20000, '错误提示')
    const message = await browser.text('[data-testid="create-user-error"]')
    assert.match(String(message), /用户名|已存在|占用/, `要说清是用户名重复：${message}`)
    allowedNoise.push('/api/users')
  })

  test('422 / 429：V2 的错误契约里没有这两个码（如实说明，不造假）', async () => {
    /*
      业主 §18 要求"真实制造 401/403/404/409/422/429"。
      前四个已经真实制造过了。后两个在 V2 里**不存在**，原因是设计上的：
        · 422：V2 的入参校验一律回 **400 + 机器可读的 code**（class-validator + 统一错误体），
          没有"语义错误用 422"这一层；
        · 429：V2 **没有实现限流**（grep 全仓没有 429 的产出点）。限流属于部署层
          （Nginx / Caddy），那是阶段 12 的课题。
      与其伪造一个 422/429，不如把**真实发生的事**钉住：下面的断言就是那条契约。
      这也是本阶段唯一一处"要求的东西不存在"的地方，已写进报告。
    */
    const codes = await withSql(async (sql) => {
      const [row] = await sql`
        SELECT count(*)::int AS n FROM audit_logs WHERE detail ? 'statusCode'`
      return row.n
    })
    assert.equal(typeof codes, 'number')

    // 入参不合法 → 400（不是 422），而且带 code
    const bad = await adminClient.post('/api/resources', { title: '没有目录的资源' })
    assert.equal(bad.status, 400, JSON.stringify(bad.data))
    assert.equal(typeof bad.data.code, 'string', `400 要带机器可读的 code：${JSON.stringify(bad.data)}`)

    // 连续多次登录失败也不会出现 429（因为没有限流）—— 如实记录
    const attacker = client()
    const statuses = []
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await attacker.login(TEACHER_B.username, 'WrongPass!1')).status)
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401], `没有限流：${statuses.join(',')}`)
  })
})

describe('⑲ Console 与网络：整条流程 0 错误', () => {
  test('没有 console error、没有 500 API、没有 404 资源、没有 CORS', async () => {
    const problems = browser.problemReport({ allow: allowedNoise })
    const readable = problems
      .map((p) => `${p.kind}/${p.level ?? ''} ${p.status ?? ''} ${p.text ?? ''} ${p.url ?? ''}`.trim())
      .join('\n  ')
    assert.equal(
      problems.length,
      0,
      `整条流程不该有 console/网络错误，实际 ${problems.length} 条：\n  ${readable}`,
    )
  })

  test('采集本身是有效的（不是"采集器坏了所以永远为 0"）', async () => {
    /*
      一条"永远为 0"的门禁等于没有门禁。所以这里**故意**制造一次 500 与一次
      console.error，确认采集器真的看得见 —— 然后清掉，不影响上一条的结论。
    */
    browser.clearProblems()
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 20000, '外壳')
    await browser.session.eval(
      `(async () => {
         console.error('stage10 采集器自检：这条必须被抓到')
         try { await fetch('/api/stage10-not-exist') } catch {}
       })()`,
    )
    await browser.waitFor('true', 600, '等采集')
    const seen = browser.problemReport()
    assert.equal(
      seen.some((p) => p.kind === 'console' && String(p.text).includes('采集器自检')),
      true,
      `console.error 必须被采集到：${JSON.stringify(seen)}`,
    )
    assert.equal(
      seen.some((p) => p.kind === 'http' && p.status === 404),
      true,
      '404 的响应必须被采集到',
    )
    allowedNoise.push('/api/stage10-not-exist')
    browser.clearProblems()
  })
})
