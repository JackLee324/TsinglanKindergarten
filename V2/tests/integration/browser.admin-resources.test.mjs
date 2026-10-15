/**
 * tests/integration/browser.admin-resources.test.mjs
 *   —— 超级管理员「资源管理」页（/admin/resources）的真实浏览器验收
 * ============================================================================
 * 为什么必须用真浏览器，而不是再写一份接口测试：
 *
 *   · 「入口只有超管看得见」是**侧边栏渲染**的结果 —— 接口断言证明不了
 *     "老师打开网站看不到那个按钮"，而那正是业主关心的那件事。
 *   · 「多选 → 批量删除 → 逐条结果」是一串界面状态（勾选跨页保留、
 *     确认弹窗、结果弹窗、删完列表刷新）。中间任何一步断了，
 *     接口测试都还是绿的。
 *   · 「全局入口上传要先选目录」是**弹窗里的一次交互**：
 *     不选就提交必须被拦住，这不是接口的职责。
 *
 * 因此这一份同时做三件事，缺一不可：
 *   ① 每一步都用**点击**（不直接开深层 URL，除非那一步本身在测"直接开会怎样"）；
 *   ② 每一步都回数据库核对（界面说成功了不算，`deleted_at` 写上了才算）；
 *   ③ 全程采集 console / 网络（CDP 的 Runtime / Log / Network 三个域）。
 *
 * ── 一条硬纪律 ───────────────────────────────────────────────────────────
 * 界面上"没有按钮"永远不是安全证据。所有"老师被拒"的用例都另外直接构造
 * API 请求打服务端一次，并且回查"东西还在不在"（拒绝必须无副作用）。
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
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { launchBrowser } from '../helpers/browser.mjs'
import { makeResource } from '../helpers/resource-fixture.mjs'

const WORK = mkdtempSync(join(tmpdir(), 'admin-res-'))
const FILES_DIR = join(WORK, 'files')
const DOWNLOAD_DIR = join(WORK, 'downloads')

const ADMIN = { username: 'adm_res', password: 'AdmResPass!2026' }
const TEACHER = { username: 't_res', password: 'TeachResPass!2026', name: '资源老师' }

/**
 * 造多少条：**必须超过一页**（页面固定 20 条/页），否则"分页"和
 * "跨页保留勾选"两条根本测不到。
 *
 *   草稿：23 条在「教学资源」+ 2 条在「教学详案」= 25
 *   已发布：2 条
 *   合计 27 → 第 1 页 20 条、第 2 页 7 条
 */
const DRAFT_IN_RESOURCES = 23
const DRAFT_IN_LESSON = 2
const PUBLISHED = 2
const TOTAL = DRAFT_IN_RESOURCES + DRAFT_IN_LESSON + PUBLISHED
const PAGE_SIZE = 20

const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/** 一个真实的 PNG（1×1）—— 预览要能真的解码，不能只有 magic。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const TXT_BYTES = Buffer.from('管理员全局上传的探针文件。\n第二行。\n', 'utf8')

let browser
let adminApi
const ids = {}
/**
 * 刻意制造的失败响应（每条都必须由用例显式登记，并说明为什么）。
 *
 * `/api/auth/me`：应用启动时会先问一次"我是谁"，**未登录时这一问必然 401**
 * （服务端把"没有会话"实现成 401，而不是 200 + null）。这是设计如此，
 * 但它是真的 401，所以必须显式登记 —— 不能靠"4xx 一律放过"。
 */
const allowedNoise = ['/api/auth/me']

// ── 数据库核对 ──────────────────────────────────────────────────────────────

/**
 * `directories` 表里没有 `path` 列 —— 路径是 slug 链算出来的
 * （服务端也是这么算的）。测试里照抄同一份算法，而不是偷偷加一列。
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

async function auditRowsFor(targetId) {
  return withSql((sql) => sql`
    SELECT action, result, detail FROM audit_logs
    WHERE target_id = ${targetId} ORDER BY created_at`)
}

// ── 夹具：走完整的三步上传 ──────────────────────────────────────────────────

/**
 * 申请地址 → 直传 → 登记。夹具与界面上的上传用的是**同一条链路**，
 * 没有绕过校验的后门写法。
 */
async function attachFile(api, resourceId, fileName, bytes, mimeType) {
  const ask = await api.post(`/api/resources/${resourceId}/files/upload-url`, {
    fileName,
    mimeType,
    size: bytes.length,
    sha256: sha256(bytes),
  })
  assert.equal(ask.status, 201, JSON.stringify(ask.data))
  const put = await fetch(
    ask.data.uploadUrl.startsWith('http') ? ask.data.uploadUrl : `${TEST_BASE}${ask.data.uploadUrl}`,
    { method: 'PUT', headers: ask.data.headers, body: bytes },
  )
  assert.equal(put.status, 200, `PUT 应当成功：${await put.text()}`)
  const reg = await api.post(`/api/resources/${resourceId}/files/register`, {
    uploadId: ask.data.uploadId,
  })
  assert.equal(reg.status, 201, JSON.stringify(reg.data))
  return { storageKey: ask.data.storageKey, fileId: reg.data.id }
}

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
  await browser.waitFor(`!!document.querySelector('[data-testid="login-page"]')`, 20000, '登录页')
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor(`!!document.querySelector('[data-testid="sidebar"]')`, 20000, `登录 ${username}`)
}

async function logout() {
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor(`!!document.querySelector('[data-testid="login-page"]')`, 15000, '退出')
  }
}

/** 打开资源管理页并等它加载完（空列表时渲染的是空态，没有分页信息）。 */
async function openAdminResources() {
  await browser.goto(`${TEST_BASE}/admin/resources`)
  await browser.waitFor(
    `!!document.querySelector('[data-testid="admin-resources-page"]')`,
    20000,
    '资源管理页',
  )
  await browser.waitFor(
    `!!document.querySelector('[data-testid="admin-resources-page-info"]') ||
     !!document.querySelector('[data-testid="admin-resources-empty"]')`,
    20000,
    '列表加载完成',
  )
}

/**
 * 打开「我的资源 → 回收站」。
 *
 * 管理员在这个页面上看到的是 `/api/resources/recycle-bin`（**全部人**删掉的），
 * 老师看到的是 `/mine/recycle-bin`（只有自己的）。两者是同一个界面的两种口径。
 */
async function openRecycleBin() {
  await browser.goto(`${TEST_BASE}/my-resources`)
  await browser.waitFor(
    `!!document.querySelector('[data-testid="my-resources-tabs"]')`,
    20000,
    '我的资源',
  )
  const switched = await browser.session.eval(
    `(() => {
       const tab = [...document.querySelectorAll('[data-testid="my-resources-tab"]')]
         .find((t) => t.innerText.trim() === '回收站')
       if (!tab) return false
       tab.click()
       return true
     })()`,
  )
  assert.equal(switched, true, '要有「回收站」这一栏')
  // 等这一栏真的换过来：列表或空态二选一（回收站可能是空的）
  await browser.waitFor(
    `!!document.querySelector('[data-testid="my-resources-list"]') ||
     !!document.querySelector('[data-testid="my-resources-empty"]')`,
    20000,
    '回收站列表加载完成',
  )
}

/** 页面底部那行「筛选结果共 N 条」。不从这里正则抠数字的话，只能靠行数猜。 */
async function resultTotal() {
  const info = await browser.text('[data-testid="admin-resources-page-info"]')
  const match = /筛选结果共 (\d+) 条/.exec(String(info))
  return match === null ? null : Number(match[1])
}

/** 等筛选结果收敛到 n 条。n = 0 时页面渲染的是空态。 */
async function waitForTotal(n, label) {
  if (n === 0) {
    await browser.waitFor(
      `!!document.querySelector('[data-testid="admin-resources-empty"]')`,
      20000,
      `${label}：应当是空列表`,
    )
    return
  }
  await browser.waitFor(
    `(() => {
       const el = document.querySelector('[data-testid="admin-resources-page-info"]')
       return !!el && /筛选结果共 ${n} 条/.test(el.innerText)
     })()`,
    20000,
    `${label}：筛选结果应当是 ${n} 条`,
  )
}

async function rowTitles() {
  return browser.allTexts('[data-testid="admin-resource-title"]')
}

const pageRowCount = () => browser.count('[data-testid="admin-resource-row"]')

/**
 * 按钮是不是禁用。
 *
 * ⚠️ 不能用 `attr(sel, 'disabled')`：React 有时只设 DOM 属性不设 HTML 属性，
 * 断言会以"看起来没禁用"的形式假红。读 `.disabled` 才是权威。
 */
async function isDisabled(selector) {
  return browser.session.eval(
    `document.querySelector(${JSON.stringify(selector)})?.disabled === true`,
  )
}

/** 当前在第几页。 */
async function currentPage() {
  const info = String(await browser.text('[data-testid="admin-resources-page-info"]'))
  const match = /第 (\d+) 页/.exec(info)
  return match === null ? null : Number(match[1])
}

/**
 * 翻页，并等**数据**真的换过来。
 *
 * ⚠️ 只看页码是**不够**的，这里踩过一次：React 一点击就先把 `page` 状态改了，
 * 而列表数据要等请求回来 —— 中间那段时间"页码已经是第 2 页、行还是第 1 页的 20 条"。
 * 第一版只等页码，于是紧接着读行数拿到 20（期望 7），
 * 而且这条失败还把后面的用例一起带红了（勾选残留、页码停在别处）。
 * 所以这里同时等**行数**，并且已经在目标页时**不点**（翻页助手要幂等，
 * 否则一次失败会级联成一串看着毫不相关的红）。
 */
async function gotoPage(n, expectedRows) {
  if ((await currentPage()) !== n) {
    await browser.click(
      n > (await currentPage())
        ? '[data-testid="admin-resources-next"]'
        : '[data-testid="admin-resources-prev"]',
    )
  }
  await browser.waitFor(
    `(() => {
       const info = document.querySelector('[data-testid="admin-resources-page-info"]')
       const rows = document.querySelectorAll('[data-testid="admin-resource-row"]').length
       return !!info && info.innerText.includes('第 ${n} 页') && rows === ${expectedRows}
     })()`,
    20000,
    `翻到第 ${n} 页（应当是 ${expectedRows} 条）`,
  )
}

/** 按资源 id 勾选一行（id 是夹具给的，不靠标题文本定位）。 */
async function selectRow(id) {
  await browser.click(`[data-resource-id="${id}"] [data-testid="admin-resource-select"]`)
}

async function waitForSelectedTotal(n) {
  await browser.waitFor(
    `document.querySelector('[data-testid="admin-resources-selected-total"]')?.innerText === '${n}'`,
    15000,
    `已选数量应当是 ${n}`,
  )
}

/**
 * 把勾选清空。
 *
 * 每条依赖勾选数量的用例都先调它：勾选是**跨页保留**的（这是特性），
 * 所以上一条用例留下的残留会以"数量对不上"的形式污染下一条 ——
 * 那种失败看起来像新缺陷，其实只是用例之间没有互相隔离。
 */
async function clearSelection() {
  if (await browser.exists('[data-testid="admin-resources-clear-selection"]')) {
    await browser.click('[data-testid="admin-resources-clear-selection"]')
    await waitForSelectedTotal(0)
  }
}

/** 点「批量删除」→（确认弹窗已经开着就跳过）→ 确认 → 等结果弹窗，读逐条结果。 */
async function runBulkDelete() {
  if (!(await browser.exists('[data-testid="admin-bulk-delete-dialog"]'))) {
    await browser.click('[data-testid="admin-resources-bulk-delete"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="admin-bulk-delete-dialog"]')`,
      15000,
      '批量删除确认弹窗',
    )
  }
  await browser.click('[data-testid="admin-bulk-delete-confirm"]')
  await browser.waitFor(
    `!!document.querySelector('[data-testid="admin-bulk-result-body"]')`,
    25000,
    '批量删除结果弹窗',
  )
  return {
    deleted: Number(await browser.text('[data-testid="admin-bulk-deleted"]')),
    skipped: Number(await browser.text('[data-testid="admin-bulk-skipped"]')),
    failed: Number(await browser.text('[data-testid="admin-bulk-failed"]')),
    items: await browser.allTexts('[data-testid="admin-bulk-items"] li'),
  }
}

async function closeBulkResult() {
  await browser.click('[data-testid="admin-bulk-result-close"]')
  await browser.waitFor(
    `!document.querySelector('[data-testid="admin-bulk-result-body"]')`,
    15000,
    '关闭结果弹窗',
  )
}

/** 一次性改掉搜索框 / 目录 / 状态三个筛选条件，并等结果收敛。 */
async function applyFilters({ q, directoryId, status }, expectTotal, label) {
  if (q !== undefined) await browser.fill('[data-testid="admin-resources-search"]', q)
  await browser.click('[data-testid="admin-resources-search-submit"]')
  if (directoryId !== undefined) {
    await browser.select('[data-testid="admin-resources-directory-filter"]', directoryId)
  }
  if (status !== undefined) {
    await browser.select('[data-testid="admin-resources-status-filter"]', status)
  }
  await waitForTotal(expectTotal, label)
}

before(async () => {
  mkdirSync(FILES_DIR, { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  writeFileSync(join(FILES_DIR, '探针.png'), PNG_BYTES)
  writeFileSync(join(FILES_DIR, '全局上传探针.txt'), TXT_BYTES)

  await resetDatabase()
  const admin = await createAdmin(ADMIN.username, ADMIN.password)
  ids.adminId = admin.id

  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.lesson = await directoryIdByPath('education/pre-k/virtue/lesson')

  const teacher = await createTeacher(
    TEACHER.username,
    TEACHER.password,
    [
      { permission: 'resource.view', directoryId: ids.resources },
      { permission: 'resource.create', directoryId: ids.resources },
      { permission: 'resource.submit', directoryId: ids.resources },
      { permission: 'resource.delete.own', directoryId: ids.resources },
      { permission: 'resource.download', directoryId: ids.resources },
    ],
    TEACHER.name,
  )
  ids.teacherId = teacher.id

  // 先起服务：下面的夹具走的是**真实接口**的上传链路
  await startServer()
  adminApi = client()
  await adminApi.login(ADMIN.username, ADMIN.password)

  // ── 夹具：让列表同时有"别人的草稿""我自己的草稿""已发布""别的目录" ──
  // 半数是老师上传的 —— 管理员必须看得到**别人**的草稿，这条是本页的核心能力。
  const drafts = []
  for (let i = 1; i <= DRAFT_IN_RESOURCES; i += 1) {
    drafts.push(await makeResource({
      directoryId: ids.resources,
      uploaderId: i % 2 === 0 ? ids.teacherId : ids.adminId,
      title: `ADM-草稿 ${String(i).padStart(2, '0')}`,
      status: 'DRAFT',
    }))
  }
  for (let i = 1; i <= DRAFT_IN_LESSON; i += 1) {
    drafts.push(await makeResource({
      directoryId: ids.lesson,
      uploaderId: ids.teacherId,
      title: `ADM-他处 ${String(i).padStart(2, '0')}`,
      status: 'DRAFT',
    }))
  }

  /*
    已发布的两条。

    第一条必须走**真实链路**造出来（草稿 → 挂文件 → 提交 → 管理员通过），
    而不是直接写一条 PUBLISHED 再补文件 —— 因为「已发布的资源不能直接增删文件」
    （`RESOURCE_LOCKED`），文件只能在发布**之前**挂上去。
    这也正是"跳过的已发布资源"用来证明"跳过没有碰它的文件"所必需的前提。
  */
  const publishedWithFile = await makeResource({
    directoryId: ids.resources,
    uploaderId: ids.teacherId,
    title: 'ADM-已发布 01',
    status: 'DRAFT',
  })
  ids.published = publishedWithFile
  await attachFile(adminApi, publishedWithFile, '已发布探针.png', PNG_BYTES, 'image/png')

  const teacherApi = client()
  await teacherApi.login(TEACHER.username, TEACHER.password)
  const submitted = await teacherApi.post(`/api/resources/${publishedWithFile}/submit`)
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data))
  const approved = await adminApi.post(`/api/resources/${publishedWithFile}/review`, {
    action: 'approve',
  })
  assert.equal(approved.status, 201, JSON.stringify(approved.data))
  // 前提没成立就早点炸，别让后面 25 条用例一起去猜"为什么它不是已发布"
  assert.equal((await resourceRow(publishedWithFile)).status, 'PUBLISHED')

  ids.published2 = await makeResource({
    directoryId: ids.resources,
    uploaderId: ids.teacherId,
    title: 'ADM-已发布 02',
    status: 'PUBLISHED',
  })

  // 两条草稿：一条带文件（用来证明"删除不动文件"），一条干净的
  ids.draftWithFile = drafts[0]
  ids.draftPlain = drafts[1]
  await attachFile(adminApi, ids.draftWithFile, '草稿探针.png', PNG_BYTES, 'image/png')

  browser = await launchBrowser()
  await browser.enableDownloads(DOWNLOAD_DIR)
  await browser.startProblemWatch()
})

after(async () => {
  if (browser) await browser.close()
  await stopServer()
  rmSync(WORK, { recursive: true, force: true })
})

// ────────────────────────────────────────────────────────────────────────────

describe('① 入口：只有超级管理员看得见，而且真的进得去', () => {
  test('管理员侧边栏有「资源管理」，点进去看到全站 27 条', async () => {
    await login(ADMIN.username, ADMIN.password)

    const nav = '[data-testid="nav-admin-resources"]'
    await browser.waitFor(`!!document.querySelector('${nav}')`, 20000, '侧边栏的「资源管理」入口')
    assert.equal(await browser.text(nav), '资源管理')
    await browser.click(nav)

    await browser.waitFor(
      `location.pathname === '/admin/resources'`,
      20000,
      '点进去应当停在 /admin/resources',
    )
    assert.equal(await browser.text('[data-testid="page-title"]'), '资源管理')
    await waitForTotal(TOTAL, '未筛选的全部资源')

    /*
      用户可见的文案里**不该出现 Markdown 的 `**` 强调标记**。
      这个页面第一版真的漏过两处（`平台上的**全部**资源`），在界面上就是
      一对裸露的星号 —— 只有真浏览器看得到，接口测试永远发现不了。
    */
    const body = String(await browser.text('body'))
    assert.equal(
      body.includes('**'),
      false,
      `界面上不该出现 Markdown 的 ** 标记：${body.slice(0, 200)}`,
    )
  })

  test('列表里能看到**别人**上传的草稿（管理员视角不是"我的资源"）', async () => {
    const uploaders = await browser.allTexts('[data-testid="admin-resource-uploader"]')
    assert.ok(
      uploaders.includes(TEACHER.name),
      `管理员必须看得到老师上传的资源，实际上传者列：${[...new Set(uploaders)].join(' / ')}`,
    )
    // 目录列必须显示中文名（不是 slug）
    const dirs = await browser.allTexts('[data-testid="admin-resource-directory"]')
    assert.ok(
      dirs.some((d) => String(d).includes('教学资源')),
      `目录列要显示可读的名字：${[...new Set(dirs)].join(' / ')}`,
    )
  })

  test('普通教师：侧边栏没有入口，直接开 URL 也没有后台', async () => {
    await logout()
    await login(TEACHER.username, TEACHER.password)
    assert.equal(
      await browser.exists('[data-testid="nav-admin-resources"]'),
      false,
      '老师的侧边栏里不该有「资源管理」',
    )

    // 直接敲地址：不是白屏、不是空表格，而是一句说清楚的话
    await browser.goto(`${TEST_BASE}/admin/resources`)
    await browser.waitFor(
      `!!document.querySelector('[data-testid="admin-resources-forbidden"]')`,
      20000,
      '老师打开这个地址应当看到「没有权限」',
    )
    assert.equal(
      await browser.exists('[data-testid="admin-resources-table"]'),
      false,
      '被拒的页面不该渲染出资源表格',
    )
  })
})

describe('② 检索 / 筛选：全部走后端，不是前端过滤', () => {
  test('按关键词搜索（命中、以及一条都不命中）', async () => {
    await logout()
    await login(ADMIN.username, ADMIN.password)
    await openAdminResources()

    await applyFilters({ q: 'ADM-已发布' }, PUBLISHED, '搜索「ADM-已发布」')
    for (const t of await rowTitles()) assert.match(String(t), /ADM-已发布/)

    await applyFilters({ q: 'ADM-绝对不存在的关键词' }, 0, '搜索一个不存在的关键词')

    await applyFilters({ q: '' }, TOTAL, '清空搜索')
  })

  test('按目录筛选（只看出「教学详案」那两条）', async () => {
    await applyFilters({ directoryId: ids.lesson }, DRAFT_IN_LESSON, '目录筛选：教学详案')
    for (const t of await rowTitles()) assert.match(String(t), /ADM-他处/)
  })

  test('按状态筛选（已发布 2 条 / 草稿 25 条）', async () => {
    await applyFilters(
      { directoryId: '', status: 'PUBLISHED' },
      PUBLISHED,
      '状态筛选：已发布',
    )
    await applyFilters(
      { status: 'DRAFT' },
      DRAFT_IN_RESOURCES + DRAFT_IN_LESSON,
      '状态筛选：草稿',
    )
    await applyFilters({ status: '' }, TOTAL, '状态调回全部')
  })

  test('搜索 + 目录 + 状态三个条件是叠加的', async () => {
    await applyFilters(
      { q: 'ADM-已发布 01', directoryId: ids.resources, status: 'PUBLISHED' },
      1,
      '三个条件叠加',
    )
    assert.equal(await rowTitles().then((t) => t[0]), 'ADM-已发布 01')

    // 换一个目录：同一个搜索词立刻变 0 条（证明目录条件真的生效了）
    await applyFilters(
      { directoryId: ids.lesson },
      0,
      '同一个搜索词换目录 → 0 条',
    )

    await applyFilters({ q: '', directoryId: '', status: '' }, TOTAL, '复位')
  })
})

describe('③ 分页：一页 20 条，翻页真的换数据', () => {
  test('第 1 页 20 条 / 第 2 页 7 条，首末页的按钮禁用', async () => {
    assert.equal(await currentPage(), 1)
    assert.equal(await pageRowCount(), PAGE_SIZE, `第一页应当正好 ${PAGE_SIZE} 条`)
    assert.equal(await resultTotal(), TOTAL)
    assert.equal(await isDisabled('[data-testid="admin-resources-prev"]'), true,
      '第一页的「上一页」应当是禁用的')

    const firstPageTitles = await rowTitles()
    await gotoPage(2, TOTAL - PAGE_SIZE)
    assert.equal(await isDisabled('[data-testid="admin-resources-next"]'), true,
      '最后一页的「下一页」应当是禁用的')

    for (const t of await rowTitles()) {
      assert.equal(firstPageTitles.includes(t), false, `第 2 页不该重复第 1 页的「${t}」`)
    }

    await gotoPage(1, PAGE_SIZE)
  })
})

describe('④ 批量软删除：进回收站、可恢复、已发布被跳过', () => {
  test('全选本页 → 跨页保留 → 清空选择', async () => {
    await clearSelection()
    await browser.click('[data-testid="admin-resources-select-page"]')
    await waitForSelectedTotal(PAGE_SIZE)

    // 翻到第 2 页再勾一条：总数必须是 21 —— 勾选跨页保留
    await gotoPage(2, TOTAL - PAGE_SIZE)
    await browser.click('[data-testid="admin-resource-row"] [data-testid="admin-resource-select"]')
    await waitForSelectedTotal(PAGE_SIZE + 1)
    assert.match(
      String(await browser.text('[data-testid="admin-resources-selected-count"]')),
      /含其他页/,
      '跨页之后要明确标出"含其他页"，否则管理员会以为只选了这一页',
    )

    // 回到第 1 页：本页 20 条必须还是勾着的（不是"翻页就丢"）
    await gotoPage(1, PAGE_SIZE)
    await waitForSelectedTotal(PAGE_SIZE + 1)

    await browser.click('[data-testid="admin-resources-clear-selection"]')
    await waitForSelectedTotal(0)
  })

  test('两条草稿（一条带文件）→ 删掉 2、跳过 0、失败 0', async () => {
    // 用搜索把两条目标收进同一页，不靠"列表恰好怎么排序"
    await applyFilters({ q: 'ADM-草稿 0' }, 9, '收窄到草稿 01–09')
    await clearSelection()

    await selectRow(ids.draftWithFile)
    await selectRow(ids.draftPlain)
    await waitForSelectedTotal(2)

    // 确认弹窗必须说清楚"这是可恢复的"，而且要提醒已发布的删不掉
    await browser.click('[data-testid="admin-resources-bulk-delete"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="admin-bulk-delete-dialog"]')`,
      15000,
      '确认弹窗',
    )
    assert.match(
      String(await browser.text('[data-testid="admin-bulk-delete-summary"]')),
      /即将删除\s*2\s*条/,
    )
    const dialogText = String(await browser.text('[data-testid="admin-bulk-delete-dialog"]'))
    assert.match(dialogText, /可恢复|回收站/, '确认弹窗必须说明这是可恢复的操作')
    assert.match(dialogText, /已发布/, '确认弹窗必须提醒已发布的要先撤回')

    const result = await runBulkDelete()
    assert.equal(result.failed, 0, `不该有失败的：${result.items.join(' | ')}`)
    assert.equal(result.deleted, 2, `应当删掉 2 条：${result.items.join(' | ')}`)
    assert.equal(result.skipped, 0, `不该有跳过的：${result.items.join(' | ')}`)
    assert.equal(result.items.length, 2, '结果必须逐条如实（条数 = 提交条数）')
    for (const line of result.items) assert.match(String(line), /已删除/)

    // 结果弹窗里要告诉管理员去哪儿恢复
    assert.match(
      String(await browser.text('[data-testid="admin-bulk-recover-hint"]')),
      /回收站/,
      '结果弹窗必须给出恢复入口',
    )
    await closeBulkResult()
    ids.bulkDeleted = [ids.draftWithFile, ids.draftPlain]
  })

  test('已发布的资源：跳过而不是删掉，而且说明原因', async () => {
    await applyFilters({ q: '', status: 'PUBLISHED' }, PUBLISHED, '只看已发布')
    await clearSelection()

    await selectRow(ids.published)
    await waitForSelectedTotal(1)
    const result = await runBulkDelete()

    assert.equal(result.deleted, 0, '已发布的资源不该被删掉')
    assert.equal(result.skipped, 1, `应当跳过 1 条：${result.items.join(' | ')}`)
    assert.equal(result.failed, 0)
    assert.match(String(result.items[0]), /已跳过/)
    assert.match(String(result.items[0]), /撤回/, '跳过原因要告诉管理员下一步怎么做')

    await closeBulkResult()
    await applyFilters({ status: '' }, TOTAL - 2, '复位')
  })

  test('数据库核对：deleted_at 写上了，已发布那条没被动', async () => {
    for (const id of ids.bulkDeleted) {
      const row = await resourceRow(id)
      assert.ok(row, `${row.title} 的行必须还在 —— 这是"可恢复"的前提`)
      assert.notEqual(row.deleted_at, null, `${row.title} 必须是软删除（deleted_at 非空）`)
    }
    const published = await resourceRow(ids.published)
    assert.equal(published.deleted_at, null, '已发布的资源不该被删除')
    assert.equal(published.status, 'PUBLISHED')
    assert.equal(published.files, 1, '跳过的资源连文件都不该被动')
  })

  test('软删除没有碰文件记录（对象要到"能不能下载"那一步再证）', async () => {
    const row = await resourceRow(ids.draftWithFile)
    assert.equal(row.files, 1, '文件记录必须保留（回收站恢复之后要能下载）')

    const [file] = await withSql((sql) => sql`
      SELECT file_name, size, sha256, storage_key FROM resource_files
      WHERE resource_id = ${ids.draftWithFile}`)
    assert.equal(file.file_name, '草稿探针.png')
    assert.equal(Number(file.size), PNG_BYTES.length)
    assert.equal(file.sha256, sha256(PNG_BYTES), '文件内容指纹不该变')
    assert.ok(file.storage_key.length > 0)
    ids.softDeletedStorageKey = file.storage_key
  })

  test('软删除的资源立刻从默认列表里消失，但回收站里有', async () => {
    await openAdminResources()
    await waitForTotal(TOTAL - 2, '删掉两条之后')

    for (const id of ids.bulkDeleted) {
      assert.equal(
        await browser.exists(`[data-resource-id="${id}"]`),
        false,
        '被软删除的资源不该还出现在资源管理列表里',
      )
    }
    assert.equal(await browser.exists(`[data-resource-id="${ids.published}"]`), true)

    // ── 回收站（管理员的回收站接口返回**全部人**删掉的资源）──
    await openRecycleBin()
    for (const id of ids.bulkDeleted) {
      await browser.waitFor(
        `!!document.querySelector('[data-resource-id="${id}"]')`,
        20000,
        '刚删掉的资源应当出现在回收站里',
      )
    }
  })

  test('审计：每条删除都留了记录，来源标成 bulk', async () => {
    for (const id of ids.bulkDeleted) {
      const rows = await auditRowsFor(id)
      const del = rows.filter((r) => String(r.action).includes('delete'))
      assert.ok(del.length > 0, `资源 ${id} 必须有删除审计`)
      assert.equal(del[del.length - 1].result, 'success')
      const detail = JSON.stringify(del[del.length - 1].detail ?? {})
      assert.match(detail, /bulk/, `审计里要能看出这是批量删除：${detail}`)
    }
  })
})

describe('⑤ 恢复：管理员能在回收站里把它救回来，文件也真的还在', () => {
  test('回收站 → 恢复一条 → 重新出现在资源管理列表', async () => {
    /*
      自己导航过去，**不依赖上一条用例把浏览器留在哪儿** ——
      依赖上一条的落点会让"上一条失败"变成"这一条也失败"，
      而两条实际查的是完全不同的东西。
    */
    await openRecycleBin()
    const target = ids.bulkDeleted[0]
    await browser.click(`[data-resource-id="${target}"] [data-testid="my-resource-restore"]`)
    await browser.waitFor(
      `!document.querySelector('[data-resource-id="${target}"]')`,
      20000,
      '恢复之后它应当离开回收站',
    )

    const row = await resourceRow(target)
    assert.equal(row.deleted_at, null, '恢复必须真的把 deleted_at 清空')

    await openAdminResources()
    await waitForTotal(TOTAL - 1, '恢复一条之后')
    assert.equal(await browser.exists(`[data-resource-id="${target}"]`), true)
    ids.restored = target
  })

  test('恢复之后文件能下载，字节与软删除之前逐字节一致', async () => {
    /*
      这一条才是"软删除没有碰对象存储"的真正证据。
      只查 `resource_files` 行还在，证明不了桶里的对象还在 ——
      真正的证据是**把它取回来**并核对 sha256。
      （软删除期间下载会被 404 挡住：回收站里的东西不能直接下载，
        要恢复之后才能取 —— 那是有意的行为，另有专门用例。）
    */
    /*
      前置条件显式断言：没有这一句，上一条用例失败后这里会拿着 `undefined`
      去开 `/resources/undefined` —— 报出来的是"详情页等不到"，
      而真实原因是上一条没跑完。那种失败信息会把人带到错的方向去。
    */
    assert.equal(
      typeof ids.restored === 'string' && ids.restored.length > 0,
      true,
      '上一条用例必须先成功恢复一条资源（ids.restored）',
    )

    await browser.goto(`${TEST_BASE}/resources/${ids.restored}`)
    await browser.waitFor(
      `!!document.querySelector('[data-testid="resource-detail-page"]')`,
      20000,
      '详情页',
    )
    assert.equal(await browser.text('[data-testid="file-name"]'), '草稿探针.png')
    await browser.click('[data-testid="file-download"]')
    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith('.png'))
    assert.equal(
      sha256(readFileSync(saved)),
      sha256(PNG_BYTES),
      '软删除 + 恢复之后，取回的字节必须与上传时完全一致',
    )
    rmSync(saved, { force: true })
  })
})

describe('⑥ 权限只在服务端：老师直接打接口也是 403，而且没有副作用', () => {
  test('老师调批量删除：403，一条都没被删', async () => {
    const teacherApi = client()
    await teacherApi.login(TEACHER.username, TEACHER.password)

    const before = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM resources WHERE deleted_at IS NOT NULL`)
    const victim = ids.published2

    const res = await teacherApi.post('/api/resources/bulk-delete', { ids: [victim] })
    assert.equal(res.status, 403, JSON.stringify(res.data))
    allowedNoise.push('/api/resources/bulk-delete')

    const after = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM resources WHERE deleted_at IS NOT NULL`)
    assert.equal(after[0].n, before[0].n, '被拒的请求不能删掉任何东西')
    assert.equal((await resourceRow(victim)).deleted_at, null, '目标资源必须毫发无伤')

    // 未登录：401
    const anon = client()
    const anonRes = await anon.post('/api/resources/bulk-delete', { ids: [victim] })
    assert.equal(anonRes.status, 401, JSON.stringify(anonRes.data))
  })

  test('老师连"永久删除"也调不动（purge 需要超管）', async () => {
    const teacherApi = client()
    await teacherApi.login(TEACHER.username, TEACHER.password)
    const victim = ids.published2
    const res = await teacherApi.post(`/api/resources/${victim}/purge`)
    assert.equal(res.status, 403, JSON.stringify(res.data))
    allowedNoise.push('/purge')
    assert.equal((await resourceRow(victim)).deleted_at, null, 'purge 被拒也必须无副作用')
  })

  test('老师的"回收站"只含自己的：看不到别人删掉的资源', async () => {
    /*
      `/api/resources/recycle-bin` 不是管理员专属（老师调也返回 200），
      真正的边界在服务端的 `recycleBinUploaderFilter()`：
      管理员拿到 null（看全部），老师拿到自己的 id（只看自己的）。
      所以这条不测状态码，测**内容** —— 两侧各造一条已删除的资源来对比。
    */
    const adminOnly = await makeResource({
      directoryId: ids.resources,
      uploaderId: ids.adminId,
      title: 'ADM-别人的回收站探针',
      status: 'DRAFT',
    })
    const mine = await makeResource({
      directoryId: ids.resources,
      uploaderId: ids.teacherId,
      title: 'ADM-我的回收站探针',
      status: 'DRAFT',
    })
    for (const id of [adminOnly, mine]) {
      const res = await adminApi.del(`/api/resources/${id}`)
      assert.equal(res.status, 200, JSON.stringify(res.data))
    }

    const teacherApi = client()
    await teacherApi.login(TEACHER.username, TEACHER.password)
    const res = await teacherApi.get('/api/resources/recycle-bin')
    assert.equal(res.status, 200, JSON.stringify(res.data))
    const seen = res.data.items.map((i) => i.id)
    assert.equal(seen.includes(mine), true, '老师要看得到**自己**删掉的')
    assert.equal(seen.includes(adminOnly), false, '老师不该看到**别人**删掉的')
  })
})

describe('⑦ 全局上传入口：先选目录，再传文件', () => {
  test('不选目录直接提交 → 界面拦住，而且不建资源', async () => {
    await logout()
    await login(ADMIN.username, ADMIN.password)
    await openAdminResources()

    const [before] = await withSql((sql) => sql`SELECT count(*)::int AS n FROM resources`)

    await browser.click('[data-testid="admin-resources-upload"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="upload-dialog"]')`,
      15000,
      '上传弹窗',
    )
    await browser.waitFor(
      `!!document.querySelector('[data-testid="upload-directory-select"]')`,
      15000,
      '全局入口必须有目录下拉（目录页那套只读位置在这里没有意义）',
    )

    await browser.fill('[data-testid="upload-title"]', '管理员全局上传探针')
    await browser.setFileInput('[data-testid="upload-file-input"]', join(FILES_DIR, '全局上传探针.txt'))
    await browser.click('[data-testid="upload-submit"]')

    await browser.waitFor(
      `!!document.querySelector('[data-testid="upload-error"]')`,
      15000,
      '不选目录时应当被拦住',
    )
    assert.match(
      String(await browser.text('[data-testid="upload-error"]')),
      /目录/,
      '提示要说清楚是缺目录',
    )
    const [after] = await withSql((sql) => sql`SELECT count(*)::int AS n FROM resources`)
    assert.equal(after.n, before.n, '被拦住的提交不能建出资源')
  })

  test('选目录 → 上传 → 进详情页 → 目录/文件/字节数都对', async () => {
    await browser.select('[data-testid="upload-directory-select"]', ids.lesson)
    await browser.click('[data-testid="upload-submit"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="resource-detail-page"]')`,
      30000,
      '上传后进入详情页',
    )
    const id = await browser.attr('[data-testid="resource-detail-page"]', 'data-resource-id')
    assert.equal(typeof id === 'string' && id.length > 0, true, '详情页必须带资源 id')
    ids.uploaded = id

    assert.equal(await browser.text('[data-testid="resource-detail-title"]'), '管理员全局上传探针')
    assert.equal(await browser.text('[data-testid="file-name"]'), '全局上传探针.txt')

    const row = await resourceRow(id)
    assert.equal(row.directory_path, 'education/pre-k/virtue/lesson', '资源必须落在选中的目录里')
    assert.equal(row.status, 'DRAFT', '上传完是草稿')
    assert.equal(row.files, 1)

    const [file] = await withSql((sql) => sql`
      SELECT file_name, size, sha256 FROM resource_files WHERE resource_id = ${id}`)
    assert.equal(file.file_name, '全局上传探针.txt')
    assert.equal(Number(file.size), TXT_BYTES.length, '字节数要对得上')
    assert.equal(file.sha256, sha256(TXT_BYTES), 'sha256 必须由服务端算出来')
  })

  test('全局上传的资源能下载，字节与上传的逐字节一致', async () => {
    await browser.click('[data-testid="file-download"]')
    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith('.txt'))
    assert.equal(sha256(readFileSync(saved)), sha256(TXT_BYTES))
    rmSync(saved, { force: true })
  })
})

describe('⑧ 全程没有 console / 网络问题', () => {
  test('没有未捕获异常、没有 404 静态资源、没有 500 API', async () => {
    const problems = browser.problemReport({ allow: allowedNoise })
    assert.deepEqual(
      problems,
      [],
      `浏览器里出现了这些问题：\n${problems
        .map((p) => `  · [${p.kind}] ${p.status ?? p.level} ${p.text ?? ''} ${p.url ?? ''}`)
        .join('\n')}`,
    )
  })

  test('清掉本文件造出来的资源，不给后面的套件留残留', async () => {
    await withSql((sql) => sql`
      DELETE FROM resources WHERE title LIKE 'ADM-%' OR title LIKE '%探针%'`)
    const [after] = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM resources
      WHERE title LIKE 'ADM-%' OR title LIKE '%探针%'`)
    assert.equal(after.n, 0)
  })
})
