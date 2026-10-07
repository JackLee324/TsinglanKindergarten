/**
 * tests/helpers/browser.mjs —— 零依赖的真实浏览器驱动（Chrome DevTools Protocol）
 * ============================================================================
 * 为什么要真的开一个浏览器：
 *   · 目录改名的验收是"侧边栏 / 卡片 / 面包屑都跟着变"。这三处**只有渲染之后**
 *     才存在，用 `fetch('/api/directories/tree')` 断言接口返回什么，证明不了界面。
 *   · 「管理员新增一级栏目 → 侧边栏自动出现」这条验收，本质就是"React 有没有
 *     真的按数据渲染"。任何接口级断言都绕开了它。
 *
 * 为什么不用 Playwright/Puppeteer：Node 22 自带 `fetch` 与 `WebSocket`，
 * CDP 本身就是个 WebSocket 上的 JSON-RPC。少两个重依赖，启动也更快。
 *
 * ⚠️ 一条硬规则：**等待，不要 sleep**。
 * V1 的 `verify-ia-consolidation.mjs:330` 就是因为"读之前没有等待"，
 * 在门禁里偶发两条假红（详见 V2/docs/V1_KNOWN_LIMITATIONS.md）。
 * 所以这里所有读取都走 `waitFor*`，并且失败信息里带上"当时页面长什么样"。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 极小的 CDP 客户端：一个页面对一个 WebSocket。 */
class Session {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
        else resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 30000)
    })
  }

  /** 在页面里跑一段表达式并把结果取回来（支持 Promise）。 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      const text =
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? '未知错误'
      throw new Error(`页面里抛错：${text}`)
    }
    return res.result.value
  }
}

export class Browser {
  constructor(process, session, profileDir) {
    this.process = process
    this.session = session
    this.profileDir = profileDir
  }

  /** 打开一个地址并等待 `readyState === 'complete'`。 */
  async goto(url) {
    await this.session.send('Page.navigate', { url })
    await this.waitFor(`document.readyState === 'complete'`, 20000, `打开 ${url}`)
  }

  /** 刷新（真实 reload，用来验证"刷新后仍然存在"）。 */
  async reload() {
    await this.session.send('Page.reload', { ignoreCache: true })
    await this.waitFor(`document.readyState === 'complete'`, 20000, '刷新页面')
  }

  async url() {
    return this.session.eval('location.pathname')
  }

  /** 读一个元素的**文字**。读不到就返回 null（由调用方的断言给出可读失败信息）。 */
  async text(selector) {
    return this.session.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      return el ? (el.innerText || el.textContent || '').trim() : null
    })()`)
  }

  async exists(selector) {
    return this.session.eval(`!!document.querySelector(${JSON.stringify(selector)})`)
  }

  async count(selector) {
    return this.session.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  }

  async attr(selector, name) {
    return this.session.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      return el ? el.getAttribute(${JSON.stringify(name)}) : null
    })()`)
  }

  async allAttrs(selector, name) {
    return this.session.eval(
      `JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.getAttribute(${JSON.stringify(name)})))`,
    ).then((json) => JSON.parse(json ?? '[]'))
  }

  /** 点击。用真实的 MouseEvent 序列，走 React 的事件系统。 */
  async click(selector) {
    const ok = await this.session.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      for (const type of ['mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, view: window }))
      }
      return true
    })()`)
    if (!ok) throw new Error(`点击失败：找不到 ${selector}`)
  }

  /**
   * 填输入框。
   *
   * ⚠️ 必须用**原型上的 value setter**：React 会劫持 input 的 value 属性，
   * 直接 `el.value = x` 不会触发 onChange，表单状态不会更新 ——
   * 表现是"填了但提交时是空的"，而测试如果只看 DOM 会以为填成功了。
   */
  async fill(selector, value) {
    const ok = await this.session.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    if (!ok) throw new Error(`填写失败：找不到 ${selector}`)
  }

  /**
   * 等待某个条件成立。`condition` 是在页面里求值的表达式。
   *
   * 失败时把"页面当时的样子"带进错误信息 —— 否则失败只剩"没等到"三个字，
   * 而原因可能是没渲染、渲染成空态、或者跳到了别的页面，三种的修法完全不同。
   */
  async waitFor(condition, timeoutMs = 10000, label = condition) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      try {
        last = await this.session.eval(`(() => { try { return !!(${condition}) } catch { return false } })()`)
        if (last === true) return
      } catch (error) {
        last = `求值失败：${error.message}`
      }
      await sleep(100)
    }
    const snapshot = await this.snapshot()
    throw new Error(
      `等待超时（${timeoutMs}ms）：${label}\n` +
        `  当时地址：${snapshot.pathname}\n` +
        `  页面文字：${snapshot.text.slice(0, 400)}\n` +
        `  最后取值：${String(last)}`,
    )
  }

  async waitForText(selector, expected, timeoutMs = 10000) {
    return this.waitFor(
      `(document.querySelector(${JSON.stringify(selector)})?.innerText || '').trim() === ${JSON.stringify(expected)}`,
      timeoutMs,
      `${selector} 的文字变成「${expected}」`,
    )
  }

  /** 页面快照，用于失败诊断。 */
  async snapshot() {
    return this.session.eval(`(() => ({
      pathname: location.pathname,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim(),
      cards: document.querySelectorAll('[data-testid="directory-card"]').length,
      hasSidebar: !!document.querySelector('[data-testid="sidebar"]'),
    }))()`)
  }

  async close() {
    try {
      this.session.ws.close()
    } catch {
      /* 已经关了 */
    }
    this.process.kill('SIGKILL')
    // 等进程真的退出，否则下一次启动的 profile 目录可能被占用
    await sleep(200)
    rmSync(this.profileDir, { recursive: true, force: true })
  }
}

/** 启动 Chrome 并连上一个页面。 */
export async function launchBrowser({ headless = true } = {}) {
  const chromePath = process.env.CHROME_BIN || CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!chromePath) throw new Error('找不到 Chrome / Chromium（可用 CHROME_BIN 指定）')

  const profileDir = mkdtempSync(join(tmpdir(), 'v2-chrome-'))
  const port = 9400 + Math.floor(Math.random() * 500)

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-gpu',
    '--window-size=1440,1000',
    'about:blank',
  ]
  if (headless) args.unshift('--headless=new')

  const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += String(d)))

  // 等 DevTools 端口起来
  const deadline = Date.now() + 20000
  let wsUrl = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) {
        wsUrl = page.webSocketDebuggerUrl
        break
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  if (!wsUrl) {
    child.kill('SIGKILL')
    throw new Error(`Chrome 的 DevTools 端口没起来：\n${stderr.slice(0, 800)}`)
  }

  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })

  const session = new Session(ws)
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  return new Browser(child, session, profileDir)
}
