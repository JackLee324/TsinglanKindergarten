/**
 * tests/production/stage15-ai-live.test.mjs
 *   —— **线上部署环境**的 AI 助手验收（真实 DeepSeek 模型 + 真实浏览器）
 * ============================================================================
 * 为什么这一份必须存在（而不是只跑本地那套）：
 *   本地的 `ai-chat-api.test.mjs` / `browser.stage15-ai-panel.test.mjs` 用的是
 *   **假模型服务器**，它们证明"链路与权限正确"，但证明不了：
 *     · 真实 DeepSeek 端点在部署环境里通不通（域名、TLS、出口网络、密钥是否有效）；
 *     · 环境变量在部署环境里真的被读到了（模型名、限流、索引开关）；
 *     · 线上静态资源与接口是同一个版本（前端能否真的调通后端）。
 *   业主 §四 明确要求"使用真实 API 请求，没有固定回复、没有伪造成功状态"。
 *
 * ⚠️ 这一份**只读**（唯一写入是 AI 自己的会话/消息/用量/审计表）：
 *    不建资源、不传文件、不改权限，因此可以反复跑。
 *
 * 用法：
 *   STAGE15_LIVE_BASE_URL=https://tsinglan.zeabur.app \
 *   STAGE15_LIVE_ADMIN_USER=TsinglanAdmin \
 *   STAGE15_LIVE_ADMIN_PASSWORD=… \
 *   node --test tests/production/stage15-ai-live.test.mjs
 *
 * 放在 `tests/production/`：需要**一个已部署的环境**，`npm test` 的 glob
 * （`tests/integration/*`）不会带上它。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser } from '../helpers/browser.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASE = (process.env.STAGE15_LIVE_BASE_URL ?? '').replace(/\/+$/, '')
const ADMIN_USER = process.env.STAGE15_LIVE_ADMIN_USER ?? ''
const ADMIN_PASSWORD = process.env.STAGE15_LIVE_ADMIN_PASSWORD ?? ''
const SHOTS = join(ROOT, 'deploy', 'logs', 'stage15-live')

/** 一定能在线上命中的问题（站规片段对所有登录用户可见）。 */
const QUESTION = '上传完资源以后，为什么别人看不到？'

if (BASE === '' || ADMIN_USER === '' || ADMIN_PASSWORD === '') {
  throw new Error('需要 STAGE15_LIVE_BASE_URL / STAGE15_LIVE_ADMIN_USER / STAGE15_LIVE_ADMIN_PASSWORD')
}

let browser

/** 存一张截图（有疑义时人工复核用；落在 gitignored 的 deploy/logs 下）。 */
async function shot(name) {
  mkdirSync(SHOTS, { recursive: true })
  const { data } = await browser.session.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
}

async function login() {
  await browser.goto(`${BASE}/login`)
  if (await browser.exists('[data-testid="login-username"]')) {
    await browser.fill('[data-testid="login-username"]', ADMIN_USER)
    await browser.fill('[data-testid="login-password"]', ADMIN_PASSWORD)
    await browser.click('[data-testid="login-submit"]')
  }
  await browser.waitFor('!!document.querySelector(\'[data-testid="app-layout"]\')', 30000, '应用外壳')
}

async function openPanel() {
  await browser.goto(`${BASE}/`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="nav-ai"]\')', 20000, 'AI 入口')
  await browser.realClick('[data-testid="nav-ai"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="ai-panel"]\')', 15000, 'AI 面板')
}

before(async () => {
  browser = await launchBrowser({ headless: true })
  await login()
})

after(async () => {
  if (browser !== undefined) await browser.close()
})

describe('线上：AI 助手的真实链路', () => {
  test('① 部署环境读到了配置：模型名来自服务端、AI 处于可用状态', async () => {
    await openPanel()
    await browser.waitForText('[data-testid="ai-model"]', '模型：deepseek-flash', 20000)
    assert.equal(
      await browser.exists('[data-testid="ai-disabled-notice"]'),
      false,
      '线上应当已配置密钥：不该出现"未启用"提示',
    )
    await shot('01-desktop-open')
  })

  test('② 真实提问：拿到**真实模型**的回答与可点引用（不是固定回复）', async () => {
    await browser.fill('[data-testid="ai-input"]', QUESTION)
    await browser.realClick('[data-testid="ai-send"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-loading"]').length === 0 &&
       document.querySelectorAll('[data-testid="ai-message-assistant"]').length > 0`,
      90000,
      '真实模型回答',
    )
    const answer = await browser.text('[data-testid="ai-answer"]')
    assert.equal(answer.length > 80, true, `回答要有实质内容：${answer.slice(0, 120)}`)
    assert.match(answer, /草稿|发布|权限/, `回答应当基于站规内容：${answer.slice(0, 200)}`)
    assert.equal(await browser.exists('[data-testid="ai-citations"]'), true, '应当给出参考来源')
    assert.equal(
      await browser.exists('[data-testid="ai-message-user"]'),
      true,
      '提问也要显示在对话里',
    )
    await shot('02-desktop-answer')

    // 引用里至少有一条**可点的站内链接**（线上索引里既有站规也有真实资源）
    const links = await browser.count('[data-testid="ai-citation"]')
    const inline = await browser.count('[data-testid="ai-citation-link"]')
    assert.equal(links + inline > 0, true, `引用必须可点（参考来源 ${links} 条 / 行内 ${inline} 个）`)
  })

  test('③ 刷新整页之后，刚才那段对话还在（会话落库，不是只存在内存里）', async () => {
    await openPanel()
    await browser.realClick('[data-testid="ai-history-toggle"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-conversation"]').length >= 1`,
      20000,
      '线上历史里有会话',
    )
    await browser.realClick('[data-testid="ai-conversation"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="ai-message-assistant"]').length >= 1`,
      30000,
      '刷新后从历史读回对话',
    )
    assert.match(await browser.text('[data-testid="ai-answer"]'), /草稿|发布|权限/)
  })

  test('④ 移动端（390×844）：从汉堡菜单打开，面板全屏', async () => {
    await browser.session.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    })
    await browser.session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await browser.goto(`${BASE}/`)
    await browser.realClick('[data-testid="nav-open"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="nav-ai"]\')', 20000, '移动端 AI 入口')
    await browser.realClick('[data-testid="nav-ai"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="ai-panel"]\')', 15000, 'AI 面板')
    const box = JSON.parse(
      await browser.session.eval(`(() => {
        const el = document.querySelector('[data-testid="ai-panel"]')
        const r = el.getBoundingClientRect()
        return JSON.stringify({
          mode: el.getAttribute('data-ai-mode'),
          w: Math.round(r.width), h: Math.round(r.height),
          vw: window.innerWidth, vh: window.innerHeight,
        })
      })()`),
    )
    assert.equal(box.mode, 'fullscreen', '线上窄屏必须是全屏面板')
    assert.equal(box.w, box.vw, `宽度铺满：${JSON.stringify(box)}`)
    assert.equal(box.h, box.vh, `高度铺满：${JSON.stringify(box)}`)
    await shot('03-mobile-fullscreen')

    await browser.session.send('Emulation.clearDeviceMetricsOverride', {})
    await browser.session.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 })
  })

  test('⑤ 业务页面不受影响：目录页照常打开（AI 只是加了一层，没有动原有功能）', async () => {
    /*
      ⚠️ 不能写死 `/directory/education/pre-k`：**线上库是从 V1 迁过来的**，
      根节点 slug 是 `edu`，与本地 seed 树的 `education` 不同。
      所以这里点侧边栏里**真实存在的第一个目录**（地址由数据推导），
      这样脚本在演练库、线上库、本地库里都能跑。
    */
    await browser.goto(`${BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar-node"]\')', 20000, '侧边栏目录')
    const href = await browser.attr('[data-testid="sidebar-node"]', 'data-nav')
    assert.equal(typeof href === 'string' && href.startsWith('/directory/'), true, `目录地址：${href}`)

    await browser.realClick(`[data-testid="sidebar-node"][data-nav="${href}"]`)
    await browser.waitFor(
      `location.pathname === ${JSON.stringify(href)}`,
      20000,
      '进入目录页',
    )
    await browser.waitFor(
      `!document.body.innerText.includes('正在加载目录')`,
      25000,
      '目录加载完成',
    )
    const text = await browser.text('[data-testid="main"]')
    assert.equal(text.length > 20, true, `目录页要有内容：${text.slice(0, 80)}`)
    assert.equal(
      await browser.exists('[data-testid="main"]'),
      true,
      '主内容区仍在（AI 面板没有把页面结构改坏）',
    )
  })
})
