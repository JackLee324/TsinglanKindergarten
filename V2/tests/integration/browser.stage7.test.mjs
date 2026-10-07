/**
 * tests/integration/browser.stage7.test.mjs —— 审核工作流的真实浏览器验收
 * ============================================================================
 * 业主 §23 / §24 / §25 指定的三条路，全在真实浏览器里走完，每一步都同时核对
 * **界面**与**数据库**（业主的要求是"API + 数据库 + UI + Audit 四个一起变化"）。
 *
 *   ① 通过：教师 上传 → 保存草稿 → 我的资源 → 提交审核
 *          → 管理员 审核工作台 → 查看 → 预览 → 下载 → 通过并发布
 *          → 教师回到目录页，看到它
 *
 *   ② 退回：教师 提交 → 管理员 退回（必须填原因）
 *          → 教师 我的资源里看到「已退回」和那句原因 → 编辑 → 重新提交 → 又变「待审核」
 *
 *   ③ 撤回：管理员通过 → 管理员/作者 撤回（填原因）→ 目录里不再显示，
 *          但「我的资源」里仍然看得到
 *
 * ⚠️ 这里不做"点一下按钮就算过"的断言：每一步都去数据库里读状态，
 * 因为业主最担心的缺陷正是「按钮有了，但状态没真的变化」。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const WORK = mkdtempSync(join(tmpdir(), 'v2-stage7-e2e-'))
const FIXTURE_DIR = join(WORK, 'fixtures')

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('1 0 obj<</Type/Catalog/Pages 2 R>>endobj\n'.repeat(40)),
  Buffer.from('%%EOF\n'),
])

let browser
let admin
let ids = {}
const createdResources = []

/** 数据库里这条资源当前的状态 —— 界面说什么不算，这里说了算。 */
async function statusInDb(resourceId) {
  return withSql(async (sql) => {
    const rows = await sql`SELECT status FROM resources WHERE id = ${resourceId}`
    return rows[0]?.status ?? null
  })
}

/** 数据库里的审核流水（时间线）。 */
async function reviewsInDb(resourceId) {
  return withSql(async (sql) => {
    return sql`
      SELECT action, comment FROM resource_reviews
      WHERE resource_id = ${resourceId} ORDER BY created_at ASC, id ASC
    `
  })
}

async function login(username, password) {
  await ensureLoggedOut()
  await browser.goto(`${TEST_BASE}/login`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '登录页出现')
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 15000, `登录 ${username}`)
}

async function ensureLoggedOut() {
  await browser.goto(`${TEST_BASE}/`)
  await browser.waitFor(
    `!!document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="logout-button"]')`,
    20000,
    '应用或登录页就绪',
  )
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '退出到登录页')
  }
}

/** 走一遍"上传资源"，返回资源 id（停在详情页）。 */
async function uploadDraftThroughUi(title) {
  await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
  await browser.waitFor(
    '!!document.querySelector(\'[data-testid="directory-upload"]\')',
    20000,
    '「上传资源」按钮出现',
  )
  await browser.click('[data-testid="directory-upload"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '上传弹窗打开')
  await browser.fill('[data-testid="upload-title"]', title)
  await browser.setFileInput('[data-testid="upload-file-input"]', join(FIXTURE_DIR, '教案.pdf'))
  await browser.waitFor('!!document.querySelector(\'[data-testid="upload-file-name"]\')', 15000, '文件名出现')
  await browser.click('[data-testid="upload-submit"]')
  await browser.waitFor('location.pathname.startsWith("/resources/")', 60000, '跳到详情页')
  const id = (await browser.url()).replace('/resources/', '')
  createdResources.push(id)
  return id
}

before(async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(join(FIXTURE_DIR, '教案.pdf'), PDF_BYTES)

  await resetDatabase()
  await createAdmin('s7_admin', 'S7AdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')

  await startServer()

  await createTeacher('s7_teacher', 'S7TeacherPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.create', directoryId: ids.virtue },
    { permission: 'resource.update.own', directoryId: ids.virtue },
    { permission: 'resource.delete.own', directoryId: ids.virtue },
    { permission: 'resource.download', directoryId: ids.virtue },
    { permission: 'resource.submit', directoryId: ids.virtue },
  ], '阶段七老师')

  // 审核员（**不是管理员**）：用来验证审核台对非管理员同样可用。
  await createTeacher('s7_reviewer', 'S7ReviewerPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.download', directoryId: ids.virtue },
    { permission: 'resource.review', directoryId: ids.virtue },
    { permission: 'resource.publish', directoryId: ids.virtue },
  ], '阶段七审核员')

  admin = client()
  await admin.login('s7_admin', 'S7AdminPass!1')

  browser = await launchBrowser()
})

after(async () => {
  if (browser) await browser.close()
  if (createdResources.length > 0) {
    await withSql(async (sql) => {
      await sql`DELETE FROM resources WHERE id = ANY(${createdResources}::uuid[])`
    })
  }
  await stopServer()
  rmSync(WORK, { recursive: true, force: true })
})

describe('① 通过：提交 → 审核 → 通过并发布 → 目录可见（§23）', () => {
  let resourceId

  test('教师：上传 → 保存草稿 → 我的资源 → 提交审核（状态真的变成待审核）', async () => {
    await login('s7_teacher', 'S7TeacherPass!1')
    resourceId = await uploadDraftThroughUi('审核通过流程探针')
    assert.equal(await statusInDb(resourceId), 'DRAFT', '详情页说的不算，库里才是草稿')

    // 刷新之后仍然在（业主最担心的"上传成功但刷新就没了"）
    await browser.reload()
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-row"]\')', 20000, '刷新后文件仍在')

    // 我的资源 → 提交审核
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(
      `!!document.querySelector('[data-resource-id="${resourceId}"]')`,
      20000,
      '我的资源里出现这条',
    )
    await browser.waitFor(
      `!!document.querySelector('[data-resource-id="${resourceId}"] [data-testid="my-resource-submit"]')`,
      15000,
      '草稿有「提交审核」按钮',
    )
    await browser.click(`[data-resource-id="${resourceId}"] [data-testid="my-resource-submit"]`)

    // 界面变成待审核，并且**数据库也是**
    await browser.waitFor(
      `(document.querySelector('[data-resource-id="${resourceId}"] [data-testid="my-resource-status"]')?.innerText || '').includes('待审核')`,
      20000,
      '卡片显示「待审核」',
    )
    assert.equal(await statusInDb(resourceId), 'PENDING_REVIEW', '数据库必须真的变了')
    assert.deepEqual(
      (await reviewsInDb(resourceId)).map((r) => r.action),
      ['submit'],
      '提交要写进审核流水',
    )

    // 待审核不能再提交（业主 §16）
    assert.equal(
      await browser.exists(`[data-resource-id="${resourceId}"] [data-testid="my-resource-submit"]`),
      false,
      '待审核不该再出现「提交审核」按钮',
    )
  })

  test('管理员：审核工作台看得到它，打开详情能预览与下载', async () => {
    await login('s7_admin', 'S7AdminPass!1')
    await browser.goto(`${TEST_BASE}/review`)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="review-queue-page"]\')',
      20000,
      '审核工作台出现',
    )
    // ⚠️ 页面外壳先渲染、队列后到。必须等**行**出现再读文字 ——
    // 直接 text() 会在数据还没到时报 null（第一版就是这么红的）。
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="review-row-title"]\')',
      20000,
      '待审队列里出现一条',
    )
    assert.equal(
      await browser.text('[data-testid="review-row-title"]'),
      '审核通过流程探针',
      '待审队列里应当有这条',
    )
    assert.equal(
      await browser.text('[data-testid="review-row-location"]'),
      '教育教学 / Pre-K / 美德 / 教学资源',
    )
    assert.equal(await browser.text('[data-testid="review-row-uploader"]'), '阶段七老师')

    await browser.click('[data-testid="review-row-open"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-detail-page"]\')',
      20000,
      '打开资源详情（审核员与教师用的是同一个页面）',
    )

    // 预览
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 15000, '预览按钮')
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="file-preview-pdf"]\')',
      20000,
      'PDF 预览出现',
    )
    await browser.click('[data-testid="file-preview-close"]')

    // 通过并发布（一步）
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-approve"]\')', 15000, '通过按钮')
    assert.equal(
      await browser.exists('[data-testid="action-reject"]'),
      true,
      '审核员同时应当看到「退回」',
    )
  })

  test('点「通过并发布」→ 状态真的变成已发布（界面 + 数据库 + 流水）', async () => {
    await browser.click('[data-testid="action-approve"]')
    await browser.waitFor(
      `(document.querySelector('[data-testid="resource-detail-status"]')?.innerText || '').includes('已发布')`,
      20000,
      '详情页显示已发布',
    )
    assert.equal(await statusInDb(resourceId), 'PUBLISHED')
    assert.deepEqual(
      (await reviewsInDb(resourceId)).map((r) => r.action),
      ['submit', 'review.approve'],
    )
    // 审核流水与审核记录都出现在界面上（业主 §7）
    await browser.waitFor('!!document.querySelector(\'[data-testid="review-history"]\')', 15000, '审核记录出现')
    assert.equal(await browser.count('[data-testid="review-history-item"]'), 2)
  })

  test('教师回到目录页：这条资源出现了（发布 = 共享）', async () => {
    await login('s7_teacher', 'S7TeacherPass!1')
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor(
      `!!document.querySelector('[data-resource-id="${resourceId}"]')`,
      20000,
      '目录里出现已发布的资源',
    )
    const status = await browser.attr(`[data-resource-id="${resourceId}"]`, 'data-resource-status')
    assert.equal(status, 'PUBLISHED')
  })
})

describe('② 退回：原因必须写，教师看得到，改完能重新提交（§24）', () => {
  let resourceId

  test('教师提交一条新的', async () => {
    await login('s7_teacher', 'S7TeacherPass!1')
    resourceId = await uploadDraftThroughUi('审核退回流程探针')
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-submit"]\')', 15000, '提交按钮出现')
    await browser.click('[data-testid="action-submit"]')
    await browser.waitFor(
      `(document.querySelector('[data-testid="resource-detail-status"]')?.innerText || '').includes('待审核')`,
      20000,
      '变成待审核',
    )
    assert.equal(await statusInDb(resourceId), 'PENDING_REVIEW')
  })

  test('管理员：退回弹窗不填原因就点不动（业主 §6）', async () => {
    await login('s7_admin', 'S7AdminPass!1')
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-reject"]\')', 20000, '退回按钮')
    await browser.click('[data-testid="action-reject"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="reject-dialog"]\')', 15000, '退回弹窗')
    const disabled = await browser.attr('[data-testid="reject-submit"]', 'disabled')
    assert.notEqual(disabled, null, '没填原因时「确认退回」必须是禁用的')
  })

  test('填写原因后退回 → 状态变已退回，原因进流水', async () => {
    await browser.fill('[data-testid="reject-comment"]', '请补充课程目标。')
    await browser.click('[data-testid="reject-submit"]')
    await browser.waitFor(
      `(document.querySelector('[data-testid="resource-detail-status"]')?.innerText || '').includes('已退回')`,
      20000,
      '详情页显示已退回',
    )
    assert.equal(await statusInDb(resourceId), 'REJECTED')

    const reviews = await reviewsInDb(resourceId)
    const reject = reviews.find((r) => r.action === 'review.reject')
    assert.equal(reject.comment, '请补充课程目标。', '退回原因必须真的存进数据库')
  })

  test('教师：我的资源里看到「已退回」和那句原因', async () => {
    await login('s7_teacher', 'S7TeacherPass!1')
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(
      `!!document.querySelector('[data-resource-id="${resourceId}"]')`,
      20000,
      '我的资源里出现这条',
    )
    await browser.waitFor(
      `(document.querySelector('[data-resource-id="${resourceId}"] [data-testid="resource-card-status"]')?.innerText || '').includes('已退回')`,
      15000,
      '卡片显示已退回',
    )
    const comment = await browser.text(
      `[data-resource-id="${resourceId}"] [data-testid="resource-card-review-comment"]`,
    )
    assert.match(comment ?? '', /请补充课程目标。/, `卡片上要能看到退回原因，实际「${comment}」`)

    // 已退回可以编辑后重新提交
    await browser.waitFor(
      `!!document.querySelector('[data-resource-id="${resourceId}"] [data-testid="my-resource-edit"]')`,
      15000,
      '出现「编辑后重新提交」',
    )
  })

  test('教师编辑 → 状态回到草稿 → 重新提交 → 又变待审核（REJECTED→DRAFT→PENDING_REVIEW）', async () => {
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-edit"]\')', 20000, '编辑按钮')
    await browser.click('[data-testid="resource-detail-edit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-edit-form"]\')', 15000, '编辑表单')
    await browser.fill('[data-testid="resource-edit-description"]', '已补充课程目标与评价方式。')
    await browser.click('[data-testid="resource-edit-save"]')
    await browser.waitFor(
      `(document.querySelector('[data-testid="resource-detail-status"]')?.innerText || '').includes('草稿')`,
      20000,
      '编辑后回到草稿',
    )
    assert.equal(await statusInDb(resourceId), 'DRAFT', '编辑已退回的资源必须回到草稿')

    await browser.waitFor('!!document.querySelector(\'[data-testid="action-submit"]\')', 15000, '提交按钮')
    await browser.click('[data-testid="action-submit"]')
    await browser.waitFor(
      `(document.querySelector('[data-testid="resource-detail-status"]')?.innerText || '').includes('待审核')`,
      20000,
      '重新提交后又是待审核',
    )
    assert.equal(await statusInDb(resourceId), 'PENDING_REVIEW')

    // 整条时间线都在：提交 → 退回 → 提交
    const actions = (await reviewsInDb(resourceId)).map((r) => r.action)
    assert.deepEqual(actions, ['submit', 'review.reject', 'submit'])
  })
})

describe('③ 撤回：从目录消失，但我的资源仍然看得到（§25）', () => {
  let resourceId

  test('准备一条已发布的资源', async () => {
    await login('s7_teacher', 'S7TeacherPass!1')
    resourceId = await uploadDraftThroughUi('撤回流程探针')
    await browser.click('[data-testid="action-submit"]')
    await browser.waitFor(
      `(document.querySelector('[data-testid="resource-detail-status"]')?.innerText || '').includes('待审核')`,
      20000,
      '待审核',
    )
    await login('s7_reviewer', 'S7ReviewerPass!1')
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-approve"]\')', 20000, '通过按钮')
    await browser.click('[data-testid="action-approve"]')
    await browser.waitFor(
      `(document.querySelector('[data-testid="resource-detail-status"]')?.innerText || '').includes('已发布')`,
      20000,
      '已发布',
    )
    assert.equal(await statusInDb(resourceId), 'PUBLISHED')
  })

  test('作者撤回（填原因）→ RECALLED，且**没有**假的退回原因', async () => {
    await login('s7_teacher', 'S7TeacherPass!1')
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-recall"]\')', 20000, '撤回按钮')
    await browser.click('[data-testid="action-recall"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="recall-dialog"]\')', 15000, '撤回弹窗')
    await browser.fill('[data-testid="recall-comment"]', '内容需要调整，暂时下架。')
    await browser.click('[data-testid="recall-submit"]')
    await browser.waitFor(
      `(document.querySelector('[data-testid="resource-detail-status"]')?.innerText || '').includes('已撤回')`,
      20000,
      '已撤回',
    )
    assert.equal(await statusInDb(resourceId), 'RECALLED')

    const reviews = await reviewsInDb(resourceId)
    assert.equal(
      reviews.some((r) => r.action === 'review.reject'),
      false,
      '撤回**绝不能**写一条 reject —— 那会让教师看到假的退回原因',
    )
    assert.equal(reviews.some((r) => r.action === 'review.recall'), true)
  })

  test('目录里不再显示，但「我的资源」里仍然看得到', async () => {
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list-section"]\')', 20000, '目录页')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-list"]\') || !!document.querySelector(\'[data-testid="resource-list-empty"]\')',
      20000,
      '资源区渲染完成',
    )
    assert.equal(
      await browser.exists(`[data-resource-id="${resourceId}"]`),
      false,
      '撤回之后目录里不该再看到它',
    )

    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(
      `!!document.querySelector('[data-resource-id="${resourceId}"]')`,
      20000,
      '我的资源里仍然看得到',
    )
    const status = await browser.text(
      `[data-resource-id="${resourceId}"] [data-testid="my-resource-status"]`,
    )
    assert.equal(status, '已撤回')
  })
})

describe('④ 权限：审核台只对审核岗开放（§4）', () => {
  test('普通教师的侧边栏里没有审核工作台，直接访问也进不去', async () => {
    await login('s7_teacher', 'S7TeacherPass!1')
    assert.equal(
      await browser.exists('[data-testid="nav-review"]'),
      false,
      '教师不该看到审核入口',
    )
    await browser.goto(`${TEST_BASE}/review`)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="review-forbidden"]\')',
      20000,
      '直接访问也要被挡住',
    )
  })

  test('审核员的侧边栏里有审核工作台', async () => {
    await login('s7_reviewer', 'S7ReviewerPass!1')
    await browser.waitFor('!!document.querySelector(\'[data-testid="nav-review"]\')', 15000, '审核入口出现')
  })
})
