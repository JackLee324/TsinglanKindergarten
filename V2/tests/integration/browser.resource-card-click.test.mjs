/**
 * tests/integration/browser.resource-card-click.test.mjs
 *   —— "点整个框框就能打开资源"（业主 2026-10-11 的要求）
 * ============================================================================
 * 现状（修之前）：卡片里**只有标题**是 `<Link>`，点卡片其余位置毫无反应。
 * 业主的原话是"我需要点击这个框框就能打开，不需要点接 test 才能打开" ——
 * 用户不会去瞄准那几个字，卡片的空白处、状态标签旁边、位置那一行，都是"这张卡片"。
 *
 * 这份测试钉三件事（缺一条都会在真机上被投诉）：
 *   ① **点卡片空白处** → 打开资源详情（本轮新增的行为）；
 *   ② **点标题**仍然能打开（原有行为不能因为改动而坏掉）；
 *   ③ 卡片里**自带按钮**的地方（我的资源里的「提交审核」）不能被整卡链接吞掉 ——
 *      这是"整卡可点"最常见的翻车方式：手指点在按钮上，结果跳进了详情页。
 *
 * 定位一律用稳定标识；点击一律用**真实鼠标事件**（CDP），不是 `element.click()`。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEST_BASE,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
} from '../helpers/harness.mjs'
import { makeResource, purgeResources } from '../helpers/resource-fixture.mjs'
import { launchBrowser } from '../helpers/browser.mjs'

const BROWSE_URL = `${TEST_BASE}/directory/education/pre-k/virtue/resources`

let browser
let teacher
let resourceId
let draftId

before(async () => {
  await resetDatabase()
  await createAdmin('card_admin', 'CardAdminPass!2026')
  const education = await directoryIdByPath('education')
  const directoryId = await directoryIdByPath('education/pre-k/virtue/resources')
  teacher = await createTeacher(
    'card_teacher',
    'CardTeacherPass!1',
    [
      { permission: 'resource.view', directoryId: education },
      { permission: 'resource.update.own', directoryId: education },
      { permission: 'resource.submit', directoryId: education },
    ],
    '框框老师',
  )
  await startServer()
  browser = await launchBrowser({ headless: true })
  resourceId = await makeResource({ directoryId, uploaderId: teacher.id, title: '框框点开测试', status: 'PUBLISHED' })
  draftId = await makeResource({ directoryId, uploaderId: teacher.id, title: '待提交的草稿', status: 'DRAFT' })
})

/**
 * 用界面登录（和后端同一套 Cookie/CSRF，不绕过前端）。
 *
 * 幂等：同一个浏览器里会话是**跨用例保留**的，所以第二次调用时 `/login` 会直接
 * 跳回应用里 —— 那时没有登录表单，硬填空就会红在"找不到 login-password"。
 * 这里两种情形都处理，并且**核对当前身份**，避免"其实以别的身份跑完了全套"。
 */
async function login(username, password, expectedName) {
  await browser.goto(`${TEST_BASE}/login`)
  if (await browser.exists('[data-testid="login-username"]')) {
    await browser.fill('[data-testid="login-username"]', username)
    await browser.fill('[data-testid="login-password"]', password)
    await browser.click('[data-testid="login-submit"]')
  }
  await browser.waitFor('!!document.querySelector(\'[data-testid="app-layout"]\')', 20000, '应用外壳')
  if (expectedName !== undefined) {
    await browser.waitFor(
      `document.body.innerText.includes(${JSON.stringify(expectedName)})`,
      15000,
      `身份是 ${expectedName}`,
    )
  }
}

after(async () => {
  if (browser) await browser.close()
  await purgeResources([resourceId, draftId].filter(Boolean))
  await stopServer()
})

/**
 * 卡片正中间那个点：是哪个元素？**在不在标题文字框里**？
 *
 * 为什么需要"在不在标题框里"这个判据：
 *   修好之后，整张卡片都是链接的命中区（标题链接的伪元素铺满卡片），
 *   所以 `elementFromPoint` 在卡片任何位置都会返回那个 `<a>` —— 这正是我们要的结果。
 *   但那样就无法区分"整卡可点"和"只有标题可点"了。
 *   所以真正要证明的是：**点击点落在标题文字的矩形之外**，
 *   也就是说，用户在标题下面的空白处按下去也能打开。
 */
async function describeCardCenter(testId, id) {
  return JSON.parse(
    await browser.session.eval(`(() => {
      const card = document.querySelector('[data-testid="${testId}"][data-resource-id="${id}"]')
      if (!card) return JSON.stringify({ found: false })
      const r = card.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const el = document.elementFromPoint(x, y)
      const title = card.querySelector('[data-testid="resource-card-title"]')
      const tr = title.getBoundingClientRect()
      const inTitleBox = x >= tr.left && x <= tr.right && y >= tr.top && y <= tr.bottom
      return JSON.stringify({
        found: true,
        tag: el ? el.tagName.toLowerCase() : null,
        hitTestId: el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        clickPoint: { x: Math.round(x), y: Math.round(y) },
        titleBox: { top: Math.round(tr.top), bottom: Math.round(tr.bottom) },
        inTitleBox,
      })
    })()`),
  )
}

describe('① 点卡片空白处就能打开资源', () => {
  test('卡片中心不是标题，而且是"点整张卡"也能进详情', async () => {
    await login('card_teacher', 'CardTeacherPass!1', '框框老师')
    await browser.goto(`${BROWSE_URL}`)
    await browser.waitFor(
      `!!document.querySelector('[data-testid="resource-card"][data-resource-id="${resourceId}"]')`,
      20000,
      '资源卡片',
    )

    const center = await describeCardCenter('resource-card', resourceId)
    assert.equal(center.found, true, '找不到卡片')
    // 关键判据：点击点必须在**标题文字矩形之外** —— 这才是业主说的"点框框"，
    // 而不是"点标题那几个字"。修好之后整卡命中区都是链接，所以不能再靠
    // "命中的是谁"来区分，只能靠"点在哪"。
    assert.equal(
      center.inTitleBox,
      false,
      `点击点必须落在标题文字之外，否则证明不了"整卡可点"：${JSON.stringify(center)}`,
    )

    // ⚠️ 必须用 realClick（真实鼠标事件）：卡片本身不是链接，
    // 命中区是标题链接铺满卡片的伪元素 —— 合成事件绕过命中测试，测不出这件事。
    await browser.realClick(`[data-testid="resource-card"][data-resource-id="${resourceId}"]`)
    await browser.waitFor(
      `location.pathname === '/resources/${resourceId}'`,
      15000,
      '进入资源详情',
    )
    assert.equal(await browser.url(), `/resources/${resourceId}`)
  })

  test('点标题仍然能打开（原有行为不能坏）', async () => {
    await login('card_teacher', 'CardTeacherPass!1', '框框老师')
    await browser.goto(`${BROWSE_URL}`)
    await browser.waitFor(
      `!!document.querySelector('[data-testid="resource-card"][data-resource-id="${resourceId}"]')`,
      20000,
      '资源卡片',
    )
    await browser.realClick(`[data-testid="resource-card"][data-resource-id="${resourceId}"] [data-testid="resource-card-title"]`)
    await browser.waitFor(`location.pathname === '/resources/${resourceId}'`, 15000, '进入资源详情')
    assert.equal(await browser.url(), `/resources/${resourceId}`)
  })
})

describe('② 卡片里的按钮不能被整卡链接吞掉', () => {
  test('「我的资源」里点「提交审核」→ 触发按钮自己的动作，不跳详情页', async () => {
    await login('card_teacher', 'CardTeacherPass!1', '框框老师')
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(
      `!!document.querySelector('[data-testid="my-resource-card"][data-resource-id="${draftId}"]')`,
      20000,
      '我的资源卡片',
    )
    const before = await browser.url()

    // 真实点击按钮：如果按钮被整卡链接盖住，用户点它就跳详情页了 —— 只有真实命中测试能发现
    await browser.realClick(`[data-testid="my-resource-card"][data-resource-id="${draftId}"] [data-testid="my-resource-submit"]`)

    /*
      这条草稿**没有文件**，所以服务端会按业务规则拒绝提交并给出提示
      （`请先上传至少一个文件。`）—— 那正是"按钮自己的动作真的跑了"的证据：
      如果点击被整卡链接吞掉，我们看到的会是详情页，而不是这句提示。
      （"有文件时能提交成功"由 `browser.stage7.test.mjs` 用真实上传流程覆盖。）
    */
    await browser.waitFor(
      `document.body.innerText.includes('请先上传至少一个文件')`,
      20000,
      '按钮自己的动作结果（无文件被拒的提示）',
    )
    assert.equal(
      await browser.url(),
      before,
      `点按钮不该发生导航（被整卡链接吞掉就会跳详情页）：${before} → ${await browser.url()}`,
    )
  })

  test('卡片空白处仍然可点（按钮之外的地方没有被按钮挡住）', async () => {
    await login('card_teacher', 'CardTeacherPass!1', '框框老师')
    await browser.goto(`${BROWSE_URL}`)
    await browser.waitFor(
      `!!document.querySelector('[data-testid="resource-card"][data-resource-id="${resourceId}"]')`,
      20000,
      '资源卡片',
    )
    await browser.realClick(`[data-testid="resource-card"][data-resource-id="${resourceId}"]`)
    await browser.waitFor(`location.pathname === '/resources/${resourceId}'`, 15000, '进入资源详情')
  })
})
