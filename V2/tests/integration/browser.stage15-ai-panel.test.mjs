/**
 * tests/integration/browser.stage15-ai-panel.test.mjs
 *   —— AI 助手的**浏览器验收**（业主 Stage 15 §三/§七：有入口、能点、真的能用）
 * ============================================================================
 * 为什么接口测试（`ai-chat-api.test.mjs`，17 条全绿）还不够：
 * 它证明"接口能答、权限不漏"，但证明不了**老师真的点得到、看得懂、点得动**。
 * 业主的验收口径是"UI 有入口 + 用户可点击 + 刷新后还在 + 浏览器真实通过"，
 * 所以这一份用**真实 Chrome**（CDP）从登录开始走一遍：
 *
 *   ① 入口：侧边栏「AI 助手」与顶栏按钮都在，点得开；
 *   ② 提问：输入框打字 → 发送 → **加载中** → 回答出现（回答文字来自真实 HTTP 响应）；
 *   ③ 引用：回答里与下方「参考来源」都有可点链接，点进去**真的到了那条资源详情页**；
 *   ④ 多轮 + 历史会话（新建 / 切换 / 删除）；
 *   ⑤ 取消：**真的把请求断掉**（服务端据此中止上游），界面回到可用状态，可以重试；
 *   ⑥ 供应商报错 → 看得懂的提示 + 「重试」真的能恢复；
 *   ⑦ 无依据：明确说"没找到"，且不假装引用了什么；
 *   ⑧ 移动端（390×844）：面板**全屏**，宽度与视口一致，能从汉堡菜单打开；
 *   ⑨ 未配置密钥：面板说清原因、输入框禁用，而**网站其它页面照常可用**。
 *
 * 定位一律用 `data-testid`；点击一律用 `realClick()`（CDP 真实鼠标事件，走命中测试）——
 * 合成事件测不出"被别的层盖住"这类缺陷，而抽屉恰恰是叠在页面上的。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEST_BASE,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
} from '../helpers/harness.mjs'
import { purgeResources } from '../helpers/resource-fixture.mjs'
import {
  enqueueResource,
  makeResourceWithFile,
  purgeAiRows,
  startMockProvider,
  waitForJobsSettled,
} from '../helpers/ai-fixture.mjs'
import { launchBrowser } from '../helpers/browser.mjs'

const MODEL = 'deepseek-flash'
const FAKE_KEY = 'sk-fake-for-tests-do-not-log'

/** 只出现在"可见"那份文件里的关键词（中文长问句走二元组检索，短词也能命中）。 */
const KW_VISIBLE = '蓝莓藤蔓主题'
const KW_DRAFT = '尚未公开的草稿内容'
const DRAFT_TITLE = '乙的草稿'
const TEACHER = { username: 'ai_ui_teacher', password: 'AiUiPass!1', name: '界面甲老师' }

let storageDir
let mock
let browser
let visibleResourceId
const probes = []

/** 用**界面**登录（不绕过前端，Cookie 与 CSRF 都走真实链路）。 */
async function login(username, password, expectedName) {
  await browser.goto(`${TEST_BASE}/login`)
  if (await browser.exists('[data-testid="login-username"]')) {
    await browser.fill('[data-testid="login-username"]', username)
    await browser.fill('[data-testid="login-password"]', password)
    await browser.click('[data-testid="login-submit"]')
  }
  await browser.waitFor('!!document.querySelector(\'[data-testid="app-layout"]\')', 20000, '应用外壳')
  await browser.waitFor(
    `document.body.innerText.includes(${JSON.stringify(expectedName)})`,
    15000,
    `身份是 ${expectedName}`,
  )
}

/** 打开面板（先回首页，保证入口一定在）。 */
async function openPanel() {
  await browser.goto(`${TEST_BASE}/`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="nav-ai"]\')', 15000, '侧边栏 AI 入口')
  await browser.realClick('[data-testid="nav-ai"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="ai-panel"]\')', 10000, 'AI 面板')
}

/** 在面板里问一句并等回答（回答落地判据：出现助手消息且没有"加载中"）。 */
async function ask(text) {
  await browser.fill('[data-testid="ai-input"]', text)
  await browser.realClick('[data-testid="ai-send"]')
  await browser.waitFor(
    `document.querySelectorAll('[data-testid="ai-loading"]').length === 0 &&
     document.querySelectorAll('[data-testid="ai-message-assistant"]').length > 0`,
    30000,
    `「${text}」的回答`,
  )
}

before(async () => {
  await resetDatabase()
  storageDir = mkdtempSync(join(tmpdir(), 'v2-ai-ui-storage-'))
  const preK = await directoryIdByPath('education/pre-k')
  const owner = await createTeacher(
    'ai_ui_owner',
    'AiUiOwnerPass!1',
    [{ permission: 'resource.view', directoryId: await directoryIdByPath('education') }],
    '资料乙老师',
  )
  await createTeacher(
    TEACHER.username,
    TEACHER.password,
    [
      { permission: 'resource.view', directoryId: preK },
      { permission: 'resource.create', directoryId: preK },
    ],
    TEACHER.name,
  )

  const preKResources = await directoryIdByPath('education/pre-k/virtue/resources')
  const visible = await makeResourceWithFile({
    storageDir,
    directoryId: preKResources,
    uploaderId: owner.id,
    title: '主题教学素材（公开）',
    status: 'PUBLISHED',
    fileName: 'public.txt',
    text: `${KW_VISIBLE}：用藤蔓做拼贴，观察颜色变化，适合 Pre-K 的感官活动。`,
  })
  visibleResourceId = visible.resourceId
  probes.push(visible.resourceId)

  // 另一条只有上传者能看的草稿：用来验证"问它也是"没找到""不会越权
  const draft = await makeResourceWithFile({
    storageDir,
    directoryId: preKResources,
    uploaderId: owner.id,
    title: DRAFT_TITLE,
    status: 'DRAFT',
    fileName: 'draft.txt',
    text: `${KW_DRAFT}：这条还没提交审核。`,
  })
  probes.push(draft.resourceId)

  mock = await startMockProvider({ model: MODEL })
  await startServer({
    env: {
      STORAGE_LOCAL_DIR: storageDir,
      AI_API_KEY: FAKE_KEY,
      AI_BASE_URL: mock.url,
      AI_MODEL: MODEL,
      AI_INDEX_INTERVAL_MS: '800',
      AI_INDEX_BATCH: '20',
      AI_RATE_LIMIT_PER_MIN: '120',
      AI_MAX_CONCURRENT: '4',
      AI_TOP_K: '5',
    },
  })
  for (const [resourceId, fileId] of [
    [visible.resourceId, visible.fileId],
    [draft.resourceId, draft.fileId],
  ]) {
    await enqueueResource(resourceId, fileId)
  }
  await waitForJobsSettled()

  browser = await launchBrowser({ headless: true })
  await login(TEACHER.username, TEACHER.password, TEACHER.name)
})

after(async () => {
  if (browser !== undefined) await browser.close()
  await stopServer()
  if (mock !== undefined) await mock.close()
  if (storageDir !== undefined) rmSync(storageDir, { recursive: true, force: true })
  await purgeAiRows()
  await purgeResources(probes)
})

describe('① 入口与打开方式', () => {
  test('侧边栏与顶栏都有入口，点开的是同一个抽屉', async () => {
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="nav-ai"]\')', 15000, '侧边栏入口')
    assert.equal(
      await browser.text('[data-testid="nav-ai-label"]'),
      'AI 助手',
      '侧边栏入口的文字',
    )
    assert.equal(await browser.exists('[data-testid="header-ai-button"]'), true, '顶栏也应当有入口')

    // 侧边栏入口（真实鼠标点击）
    await browser.realClick('[data-testid="nav-ai"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-panel"]\')', 10000, 'AI 面板')
    assert.equal(await browser.attr('[data-testid="ai-panel"]', 'data-ai-mode'), 'drawer', '桌面端是右侧抽屉')
    await browser.waitForText('[data-testid="ai-model"]', `模型：${MODEL}`, 10000)

    // 关闭后从顶栏按钮也能打开（两个入口是同一个 open()）
    await browser.realClick('[data-testid="ai-close"]')
    await browser.waitFor('!document.querySelector(\'[data-testid="ai-panel"]\')', 5000, '面板关闭')
    await browser.realClick('[data-testid="header-ai-button"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-panel"]\')', 10000, '顶栏打开面板')
  })

  test('抽屉真的盖在页面上（面板可视、尺寸正常）', async () => {
    const box = JSON.parse(
      await browser.session.eval(`(() => {
        const el = document.querySelector('[data-testid="ai-panel"]')
        const r = el.getBoundingClientRect()
        const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return JSON.stringify({
          right: Math.round(window.innerWidth - r.right),
          width: Math.round(r.width),
          height: Math.round(r.height),
          inside: !!(mid && mid.closest('[data-testid="ai-panel"]')),
          viewport: { w: window.innerWidth, h: window.innerHeight },
        })
      })()`),
    )
    assert.equal(box.right, 0, `抽屉应当贴右边：${JSON.stringify(box)}`)
    assert.equal(box.height, box.viewport.h, '抽屉应当铺满高度')
    assert.equal(box.inside, true, '面板中心必须真的在面板上（没被别的层盖住）')
  })
})

describe('② 提问、引用链接与多轮', () => {
  test('建议问题可点，点了就有回答', async () => {
    await openPanel()
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-suggestions"]\')', 10000, '建议问题')
    const suggestions = await browser.allTexts('[data-testid="ai-suggestion"]')
    assert.equal(suggestions.length > 0, true, '建议问题来自服务端，界面不写死')

    await browser.realClick('[data-testid="ai-suggestion"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-message-assistant"]').length > 0 &&
       document.querySelectorAll('[data-testid="ai-loading"]').length === 0`,
      30000,
      '建议问题的回答',
    )
    const answer = await browser.text('[data-testid="ai-answer"]')
    assert.match(answer, /站内资料/, `回答应当渲染出来：${answer}`)
    assert.equal(await browser.exists('[data-testid="ai-message-user"]'), true, '提问也要显示在对话里')
  })

  test('问到站内资料时：引用是**可点的站内链接**，点进去真的到资源详情页', async () => {
    await ask(KW_VISIBLE)
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-citations"]\')', 15000, '参考来源')
    const links = await browser.allAttrs('[data-testid="ai-citation"]', 'data-resource-id')
    assert.equal(
      links.includes(visibleResourceId),
      true,
      `参考来源里应当有那条公开资源：${JSON.stringify(links)}`,
    )
    // 回答里的 [1] 也是链接（不是纯文字）
    assert.equal(await browser.exists('[data-testid="ai-citation-link"]'), true, '回答里的 [1] 应当可点')

    await browser.realClick(`[data-testid="ai-citation"][data-resource-id="${visibleResourceId}"]`)
    await browser.waitFor(
      `location.pathname === '/resources/${visibleResourceId}'`,
      15000,
      '跳到资源详情页',
    )
    // 详情页真的渲染出了标题（不是 404 页）
    await browser.waitFor(
      `document.body.innerText.includes('主题教学素材（公开）')`,
      15000,
      '详情页标题',
    )
    await openPanel()
  })

  test('多轮：同一段对话里两次提问都在，刷新整页之后还能翻回来', async () => {
    await openPanel()
    // 两个不同的问题，都命中站内资料 → 都被记进**同一段**对话
    await ask(KW_VISIBLE)
    await ask('上传文件有哪些步骤？')
    const userMessages = await browser.count('[data-testid="ai-message-user"]')
    assert.equal(userMessages, 2, `两次提问都应当出现在对话里：${userMessages}`)
    assert.equal(
      await browser.count('[data-testid="ai-message-assistant"]'),
      2,
      '两轮都要有回答',
    )

    // 服务端确实把两轮记在同一段会话里：历史列表里那一条就是"当前会话"
    await browser.realClick('[data-testid="ai-history-toggle"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-conversation"]').length >= 1`,
      15000,
      '历史里有刚问过的会话',
    )
    const activeCount = await browser.count('[data-testid="ai-conversation"][data-active="true"]')
    assert.equal(activeCount, 1, '当前会话应当在历史里被标为活动的那一条')

    /*
      最强的"刷新后还在"：**整页重新加载**（面板状态全丢），
      再从历史里点回那段会话 —— 消息必须回来（它们是从数据库读的）。
    */
    await openPanel()
    await browser.realClick('[data-testid="ai-history-toggle"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-conversations"]\')', 10000, '历史列表')
    assert.equal(
      await browser.count('[data-testid="ai-message-user"]'),
      0,
      '整页刷新后面板从空态开始（这时还没选会话）',
    )
    await browser.realClick('[data-testid="ai-conversation"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-message-user"]').length === 2`,
      15000,
      '刷新后从历史里读回两轮对话',
    )
    assert.match(await browser.text('[data-testid="ai-answer"]'), /站内资料/)

    // 新对话：回到空态并且能重新开始
    await browser.realClick('[data-testid="ai-new"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-message-user"]').length === 0`,
      10000,
      '新对话已清空',
    )
    assert.equal(await browser.exists('[data-testid="ai-suggestions"]'), true, '新对话回到空态')
  })

  test('删除会话：列表里真的少一条，整页刷新后依然不在', async () => {
    await openPanel()
    await browser.realClick('[data-testid="ai-history-toggle"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-conversations"]\')', 10000, '历史列表')
    // 列表是异步拉回来的：等它真的有内容再数（不是放宽断言，是等数据到位）
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-conversation"]').length >= 1`,
      15000,
      '历史里有会话',
    )
    const before = await browser.count('[data-testid="ai-conversation"]')
    assert.equal(before >= 1, true, `删除前应当有会话：${before}`)

    await browser.realClick('[data-testid="ai-conversation-delete"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-conversation"]').length === ${before - 1}`,
      10000,
      '会话被删除（列表里少一条）',
    )
    assert.equal(
      await browser.count('[data-testid="ai-message-user"]'),
      0,
      '删掉的正是当前会话 → 对话区应当清空',
    )

    // 整页刷新之后仍然没有（删除是落库的，不是前端假象）
    await openPanel()
    await browser.realClick('[data-testid="ai-history-toggle"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-conversation"]').length === ${before - 1}`,
      15000,
      '整页刷新后历史里的数量与删除后一致',
    )
    assert.equal(
      await browser.count('[data-testid="ai-conversation"]'),
      before - 1,
      '整页刷新后删除依然生效',
    )
  })

  test('没有依据时：明确说"没找到"，且不给假引用', async () => {
    await browser.realClick('[data-testid="ai-new"]')
    await ask(KW_DRAFT)
    const answer = await browser.text('[data-testid="ai-answer"]')
    assert.match(answer, /没有找到/, `应当明确说没找到：${answer}`)
    assert.equal(await browser.exists('[data-testid="ai-no-evidence-note"]'), true, '要说清"没有调用模型"')
    assert.equal(
      await browser.exists('[data-testid="ai-citations"]'),
      false,
      '没有依据时不该出现参考来源',
    )
    assert.doesNotMatch(answer, new RegExp(DRAFT_TITLE), '别人的草稿标题绝不能出现在回答里')
  })
})

describe('③ 加载中、取消、失败重试', () => {
  test('慢回答：出现"正在查阅站内资料"，点取消后**真的中止**，还能重试成功', async () => {
    mock.setDelay(4000)
    try {
      await browser.realClick('[data-testid="ai-new"]')
      await browser.fill('[data-testid="ai-input"]', KW_VISIBLE)
      await browser.realClick('[data-testid="ai-send"]')
      await browser.waitFor('!!document.querySelector(\'[data-testid="ai-loading"]\')', 5000, '加载中状态')
      assert.equal(await browser.exists('[data-testid="ai-cancel"]'), true, '加载中应当能取消')

      const abortedBefore = mock.abortedCount()
      await browser.realClick('[data-testid="ai-cancel"]')
      await browser.waitFor(
        `document.querySelectorAll('[data-testid="ai-loading"]').length === 0`,
        5000,
        '取消后不再显示加载中',
      )
      /*
        取消必须**真的断开连接**（服务端据此中止上游请求）。
        只断言"界面不转了"是不够的：界面停了、连接还在，模型那边照样在算 ——
        而用户点取消的本意是止损。这里等的是假供应商真的观察到客户端断开。
      */
      const abortDeadline = Date.now() + 5000
      while (mock.abortedCount() === abortedBefore && Date.now() < abortDeadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.equal(
        mock.abortedCount() > abortedBefore,
        true,
        '取消后服务端应当断开对模型的请求（假供应商要能观察到连接被中断）',
      )
      // 取消后**没有**伪造一条回答
      assert.equal(
        await browser.count('[data-testid="ai-message-assistant"]'),
        0,
        '取消后不该出现助手回答',
      )
      assert.equal(await browser.exists('[data-testid="ai-error"]'), true, '应当提示已取消')
      assert.match(await browser.text('[data-testid="ai-error"]'), /取消/)
      assert.equal(await browser.exists('[data-testid="ai-retry"]'), true, '应当提供重试')
      // 取消之后输入区仍然可用（不是卡死状态）
      assert.equal(await browser.exists('[data-testid="ai-send"]'), true, '取消后可以继续提问')
    } finally {
      mock.setDelay(0)
    }

    // 重试：这次供应商会正常回答
    await browser.realClick('[data-testid="ai-retry"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-loading"]').length === 0 &&
       document.querySelectorAll('[data-testid="ai-message-assistant"]').length > 0`,
      30000,
      '重试后拿到回答',
    )
    assert.match(await browser.text('[data-testid="ai-answer"]'), /站内资料/)
  })

  test('供应商报错：提示可读 + 重试能恢复（不是"请求失败"四个字）', async () => {
    mock.setMode('error')
    try {
      await browser.realClick('[data-testid="ai-new"]')
      await browser.fill('[data-testid="ai-input"]', KW_VISIBLE)
      await browser.realClick('[data-testid="ai-send"]')
      await browser.waitFor('!!document.querySelector(\'[data-testid="ai-error"]\')', 20000, '错误提示')
      const text = await browser.text('[data-testid="ai-error"]')
      assert.doesNotMatch(text, /供应商内部细节不该被透出/, '供应商原始报文不该透到界面')
      assert.doesNotMatch(text, /INTERNAL_ERROR|500/, `不该把 500 甩给用户：${text}`)
    } finally {
      mock.setMode('answer')
    }
    await browser.realClick('[data-testid="ai-retry"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-message-assistant"]').length > 0`,
      30000,
      '重试成功',
    )
  })
})

describe('④ 移动端：全屏面板', () => {
  const DEVICE = {
    width: 390,
    height: 844,
    dpr: 3,
    mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  }

  before(async () => {
    await browser.session.send('Emulation.setDeviceMetricsOverride', {
      width: DEVICE.width,
      height: DEVICE.height,
      deviceScaleFactor: DEVICE.dpr,
      mobile: true,
      screenWidth: DEVICE.width,
      screenHeight: DEVICE.height,
    })
    await browser.session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await browser.session.send('Emulation.setUserAgentOverride', { userAgent: DEVICE.ua })
  })

  after(async () => {
    await browser.session.send('Emulation.clearDeviceMetricsOverride', {})
    await browser.session.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 })
    await browser.session.send('Emulation.setUserAgentOverride', { userAgent: '' })
  })

  test('从汉堡菜单打开（侧边栏在窄屏不渲染），面板铺满整屏', async () => {
    await browser.goto(`${TEST_BASE}/`)
    assert.equal(
      await browser.exists('[data-testid="sidebar"]'),
      false,
      '窄屏下桌面侧边栏不该渲染（同一时刻只有一套导航）',
    )
    // 汉堡菜单 → 抽屉 → AI 助手
    await browser.realClick('[data-testid="nav-open"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="nav-ai"]\')', 10000, '移动端导航里的 AI 入口')
    await browser.realClick('[data-testid="nav-ai"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-panel"]\')', 10000, 'AI 面板')

    const box = JSON.parse(
      await browser.session.eval(`(() => {
        const el = document.querySelector('[data-testid="ai-panel"]')
        const r = el.getBoundingClientRect()
        return JSON.stringify({
          mode: el.getAttribute('data-ai-mode'),
          width: Math.round(r.width),
          height: Math.round(r.height),
          left: Math.round(r.left),
          top: Math.round(r.top),
          vw: window.innerWidth,
          vh: window.innerHeight,
          inputVisible: !!document.querySelector('[data-testid="ai-input"]'),
        })
      })()`),
    )
    assert.equal(box.mode, 'fullscreen', '窄屏必须是全屏面板')
    assert.equal(box.width, box.vw, `宽度应当铺满视口：${JSON.stringify(box)}`)
    assert.equal(box.height, box.vh, `高度应当铺满视口：${JSON.stringify(box)}`)
    assert.equal(box.left, 0)
    assert.equal(box.top, 0)
    assert.equal(box.inputVisible, true, '全屏面板上输入框要在')

    // 手机上真的能问一句（点发送按钮，触摸环境下命中区够大）
    await ask(KW_VISIBLE)
    const size = JSON.parse(
      await browser.session.eval(`(() => {
        const el = document.querySelector('[data-testid="ai-send"]')
        const r = el.getBoundingClientRect()
        return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) })
      })()`),
    )
    assert.equal(size.h >= 40, true, `发送按钮高度应当 ≥40px（手机上要好点）：${JSON.stringify(size)}`)
  })
})

describe('⑤ 未配置密钥：说清原因，网站其它功能不受影响', () => {
  before(async () => {
    await browser.session.send('Emulation.clearDeviceMetricsOverride', {})
    await browser.session.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 })
    await browser.session.send('Emulation.setUserAgentOverride', { userAgent: '' })
    await stopServer()
    await startServer({ env: { STORAGE_LOCAL_DIR: storageDir, AI_API_KEY: '' } })
  })

  test('面板显示"未启用 + 缺少哪个变量"，输入框禁用', async () => {
    await openPanel()
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-disabled-notice"]\')', 10000, '未启用提示')
    const notice = await browser.text('[data-testid="ai-disabled-notice"]')
    assert.match(notice, /AI_API_KEY/, `要说清缺哪个变量：${notice}`)
    assert.equal(
      await browser.exists('[data-testid="ai-input"][disabled]'),
      true,
      '输入框应当禁用（disabled 属性）',
    )
    assert.equal(
      await browser.session.eval(
        `document.querySelector('[data-testid="ai-input"]').disabled === true`,
      ),
      true,
      '输入框的 DOM 属性 disabled 必须为真',
    )
    assert.equal(
      await browser.exists('[data-testid="ai-suggestions"]'),
      false,
      '未启用时不该显示建议问题（点了必然失败）',
    )
    assert.equal(await browser.exists('[data-testid="ai-send"]'), true, '发送按钮仍在（但被禁用）')
  })

  test('同一个浏览器里，目录页照常打开（AI 缺失不影响其它功能）', async () => {
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor(
      `document.body.innerText.includes('主题教学素材（公开）')`,
      20000,
      '目录页仍然列出资源',
    )
    assert.equal(
      await browser.exists('[data-testid="resource-card"]'),
      true,
      '资源卡片照常显示 —— AI 不可用不该影响业务页面',
    )
  })
})
