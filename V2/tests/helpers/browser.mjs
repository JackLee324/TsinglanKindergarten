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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
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
    /** CDP 事件订阅（没有 id 的消息）。键是方法名，值是处理函数数组。 */
    this.listeners = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
        else resolve(msg.result)
        return
      }
      // 事件：`{ method, params }`。订阅者抛错不能影响页面继续跑。
      if (typeof msg.method === 'string' && this.listeners.has(msg.method)) {
        for (const handler of this.listeners.get(msg.method)) {
          try {
            handler(msg.params ?? {})
          } catch {
            // 采集器的异常不该让被测流程失败
          }
        }
      }
    })
  }

  /**
   * 订阅一个 CDP 事件。
   *
   * 返回一个**退订函数**：`goto` / `reload` 每次都订阅一次 load 事件，
   * 不退订的话监听器会随测试条数一路堆积（虽然不致命，但会越跑越慢）。
   */
  on(method, handler) {
    const list = this.listeners.get(method) ?? []
    list.push(handler)
    this.listeners.set(method, list)
    return () => {
      const now = this.listeners.get(method) ?? []
      this.listeners.set(method, now.filter((h) => h !== handler))
    }
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
  /**
   * 打开一个地址，**并确保接下来看到的 DOM 是新文档的**。
   *
   * ⚠️ 这里有一个很隐蔽的坑：只看 `document.readyState === 'complete'` 是不够的。
   * 当目标地址与当前地址相同时（测试里很常见 —— 上一条刚好停在同一个页面），
   * **旧文档本来就已经 complete**，这个条件立刻为真，于是下一行读到的是旧页面的 DOM。
   * 表现是"刚 waitFor 到按钮，点的时候就不见了"，而且只在机器忙的时候偶发。
   * （阶段 11 的整跑里，阶段 10 的目录管理页上真的踩到过一次，见
   * `docs/STAGE11_MOBILE.md`。）
   *
   * 所以这里等的是 **`Page.loadEventFired` 事件**：旧文档不会再触发它，
   * 只有新文档加载完才会来。事件等不到就明确报错，不静默继续。
   */
  async goto(url) {
    await this.#waitForNewDocument(() => this.session.send('Page.navigate', { url }), `打开 ${url}`)
  }

  /** 刷新（真实 reload，用来验证"刷新后仍然存在"）。 */
  async reload() {
    await this.#waitForNewDocument(
      () => this.session.send('Page.reload', { ignoreCache: true }),
      '刷新页面',
    )
  }

  /**
   * 执行一次导航动作，并等到**新文档**的 load 事件。
   *
   * 为什么要退订：`goto` 一次测试里会调用很多次，不退订监听器会一直堆积。
   */
  async #waitForNewDocument(navigate, label) {
    let fired = false
    const off = this.session.on('Page.loadEventFired', () => {
      fired = true
    })
    try {
      await navigate()
      const deadline = Date.now() + 20000
      while (!fired) {
        if (Date.now() > deadline) {
          throw new Error(`${label} 超时：20 秒内没有收到新文档的 load 事件`)
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      // load 之后 React 还要挂载：等到**外壳真的渲染出来**再交给测试。
      // 只等 `readyState === 'complete'` 是不够的 —— 那时的 DOM 还是空的，
      // 紧接着的 `exists(...)` 会得到 false（"权限树里没有美德"就是这么来的）。
      // 判据用"外壳或登录页二选一"：这两者在任何页面上必然有一个。
      await this.waitFor(
        `document.readyState === 'complete' && (
           !!document.querySelector('[data-testid="header"]') ||
           !!document.querySelector('[data-testid="login-page"]')
         )`,
        20000,
        label,
      )
    } finally {
      off()
    }
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

  /**
   * 读一批元素的**文字**。
   *
   * ⚠️ 不能用 `allAttrs(sel, 'innerText')` —— `innerText` 是 DOM 属性，
   * 不是 HTML 属性，`getAttribute('innerText')` 一律返回 null。
   * 第一版就是这么写的，表现是"断言里拿到一串 null"，
   * 失败信息完全看不出真实原因。
   */
  async allTexts(selector) {
    return this.session.eval(
      `JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => (e.innerText || e.textContent || '').trim()))`,
    ).then((json) => JSON.parse(json ?? '[]'))
  }

  /**
   * 点击。用真实的 MouseEvent 序列，走 React 的事件系统。
   *
   * ⚠️ **要先等元素出现**（默认最多 3 秒，每 50ms 看一眼）。
   * 单次 `querySelector` 直接点是一条真实的坑：SPA 在两个 await 之间会重渲染，
   * "刚 waitFor 到、下一行点的时候已经不在 DOM 里"是**偶发**的 ——
   * 它会让整条套件在机器繁忙时红一次，而且报错只说"找不到"，
   * 完全看不出页面当时到底长什么样（阶段 11 的整跑里就出现过一次）。
   *
   * 这里不改任何断言强度：等不到就照样抛，只是抛之前把**页面当时的真实状态**
   * （地址 / 是否被踢回登录页 / 是否显示无权访问 / 页面文字）一起打出来。
   */
  async click(selector, { timeout = 3000 } = {}) {
    const deadline = Date.now() + timeout
    for (;;) {
      const ok = await this.session.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        for (const type of ['mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, view: window }))
        }
        return true
      })()`)
      if (ok) return
      if (Date.now() >= deadline) {
        const state = await this.session.eval(`(() => ({
          href: location.pathname + location.search,
          title: (document.querySelector('[data-testid="page-title"]')?.innerText || '').trim(),
          login: document.querySelector('[data-testid="login-page"]') !== null,
          forbidden: !!document.querySelector('[data-testid$="-forbidden"]'),
          text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
        }))()`).catch(() => null)
        throw new Error(
          `点击失败：等了 ${timeout}ms 仍找不到 ${selector}` +
            (state === null
              ? ''
              : `\n  当时地址：${state.href}` +
                `\n  登录页：${state.login ? '是（被踢回登录）' : '否'}` +
                `\n  无权访问：${state.forbidden ? '是' : '否'}` +
                `\n  页面文字：${state.text}`),
        )
      }
      await new Promise((r) => setTimeout(r, 50))
    }
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


  /**
   * 选中一个 `<select>` 的某个 option。
   *
   * ⚠️ 必须用原型上的 value setter + change 事件：React 会劫持 select 的 value，
   * 直接 `el.value = x` 不会触发 onChange（和 fill() 里 input 的坑是同一个）。
   */
  async select(selector, value) {
    const ok = await this.session.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    if (!ok) throw new Error(`选择失败：找不到 ${selector}`)
  }

  /**
   * 往 `<input type="file">` 里塞一个真实文件（阶段 6 的上传验收要用）。
   *
   * 为什么必须走 CDP 而不是"点一下选择文件"：点它只会弹出操作系统的文件选择框，
   * 自动化永远点不到那个框。`DOM.setFileInputFiles` 是唯一能塞进**真实文件**
   * 并且触发 `change` 事件的方式 —— 于是页面走了它正常的上传代码路径。
   */
  async setFileInput(selector, filePath) {
    const doc = await this.session.send('DOM.getDocument', { depth: -1 })
    const found = await this.session.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    })
    if (!found.nodeId) throw new Error(`找不到文件输入框：${selector}`)
    await this.session.send('DOM.setFileInputFiles', {
      nodeId: found.nodeId,
      files: [filePath],
    })
  }

  /**
   * 让浏览器把下载**真的存到磁盘**上。
   *
   * 业主 §23 要求"比较下载文件的 SHA256 与上传的 SHA256" —— 只有真的落盘
   * 才算验证了下载；在页面里 fetch 一下再算哈希，测的是另一个东西。
   */
  async enableDownloads(downloadPath) {
    await this.session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath,
      eventsEnabled: true,
    })
  }

  /** 等某个文件出现在下载目录里（并等它不再增长，避免读到半个文件）。 */
  async waitForDownload(downloadPath, predicate, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    let last = -1
    let stable = 0
    while (Date.now() < deadline) {
      const files = existsSync(downloadPath) ? readdirSync(downloadPath) : []
      const target = files.find((f) => predicate(f) && !f.endsWith('.crdownload'))
      if (target !== undefined) {
        const size = statSync(join(downloadPath, target)).size
        if (size === last && size > 0) {
          stable += 1
          if (stable >= 2) return join(downloadPath, target)
        } else {
          stable = 0
        }
        last = size
      }
      await sleep(150)
    }
    const seen = existsSync(downloadPath) ? readdirSync(downloadPath) : []
    throw new Error(`等待下载超时（${timeoutMs}ms）。下载目录里有：${seen.join(', ') || '（空）'}`)
  }

  /**
   * 限速（用来测"上传中可以取消"）。
   *
   * 本地存储写得太快，几 MB 的文件一眨眼就传完了，取消按钮根本来不及点。
   * 用 CDP 把上行限到几十 KB/s，上传过程就变成一个可以稳定观察与打断的状态。
   */
  /**
   * 开始采集 **console 与网络**的问题（业主 Stage 10 §19）。
   *
   * 为什么必须用 CDP 事件而不是"页面里挂个 window.onerror"：
   *   · `window.onerror` 抓不到**资源 404**（script/link 加载失败不冒泡到它）；
   *   · 抓不到被浏览器吞掉的 CORS 失败（只有一个 console 提示）；
   *   · 也抓不到 500 的 API 响应（那不是 JS 异常）。
   * 所以三个域都要开：Runtime（console + 未捕获异常）、
   * Log（浏览器自己记的严重条目，含 CORS/混合内容）、Network（响应码与加载失败）。
   */
  async startProblemWatch() {
    this.problems = []
    const push = (entry) => this.problems.push(entry)

    this.session.on('Runtime.consoleAPICalled', (params) => {
      const level = params.type
      if (level !== 'error' && level !== 'warning' && level !== 'assert') return
      const text = (params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ')
      push({ kind: 'console', level, text })
    })
    this.session.on('Runtime.exceptionThrown', (params) => {
      const d = params.exceptionDetails ?? {}
      push({
        kind: 'exception',
        level: 'error',
        text: d.exception?.description ?? d.text ?? '未捕获异常',
      })
    })
    this.session.on('Log.entryAdded', (params) => {
      const e = params.entry ?? {}
      if (e.level !== 'error') return
      push({ kind: 'log', level: 'error', text: `${e.source}: ${e.text}`, url: e.url ?? null })
    })
    this.session.on('Network.responseReceived', (params) => {
      const r = params.response ?? {}
      if (r.status < 400) return
      push({ kind: 'http', level: 'error', status: r.status, url: r.url, mimeType: r.mimeType ?? '' })
    })
    this.session.on('Network.loadingFailed', (params) => {
      // 用户主动取消（比如离开页面）不算问题
      if (params.canceled === true) return
      if (params.blockedReason === 'inspector') return
      push({
        kind: 'network',
        level: 'error',
        text: params.errorText ?? '加载失败',
        url: params.requestId ?? null,
      })
    })

    await this.session.send('Runtime.enable')
    await this.session.send('Log.enable')
    await this.session.send('Network.enable')
  }

  /** 当前采集到的问题（可随时读，不清空）。 */
  watchedProblems() {
    return this.problems ?? []
  }

  /** 清空已采集的问题（每一段流程开始前调用，便于定位是哪一步出的问题）。 */
  clearProblems() {
    this.problems = []
  }

  /**
   * 只保留"真的算错"的那些。
   *
   * 刻意**不**把 warning 当失败：V2 自己也有一条 React 的 dev 提示之类的噪音，
   * 判据要是"有 warning 就红"，这条门禁第一天就会被关掉，那就等于没有。
   * HTTP 4xx/5xx 也一样：流程里**主动制造**的 401/403/404/409 是正常响应，
   * 由调用方用 `allow` 精确列出（例如 `['/api/auth/login']`），而不是在这里一刀切。
   * 这样"允许的失败"永远是显式的：少写一个就是红灯，而不是悄悄放过。
   */
  problemReport({ allow = [] } = {}) {
    const urlAllowed = (url) => (url ? allow.some((a) => String(url).includes(a)) : false)
    return this.watchedProblems().filter((p) => {
      if (p.kind === 'console' && p.level === 'warning') return false
      if (urlAllowed(p.url)) return false
      if (p.text !== undefined && urlAllowed(p.text)) return false
      return true
    })
  }

  async setUploadThroughput(bytesPerSecond) {
    await this.session.send('Network.enable')
    await this.session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: bytesPerSecond,
    })
  }

  /** 取消限速。 */
  async clearNetworkThrottle() {
    await this.session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
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
export async function launchBrowser({ headless = true, extraArgs = [] } = {}) {
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
    // 生产/演练用：把额外的 Chrome 参数交给调用方（例如演练环境的自签证书）
    ...extraArgs,
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

  /*
    同 harness 里的服务进程：管道的 stderr 会把 Node 的事件循环吊住 ——
    Chrome 要是没被关掉（比如 `after` 钩子里的断言先抛了），
    整个测试进程就永远不退出。这里 unref（stderr 照样收，只是不拦住退出），
    再挂一个 exit 兜底：无论如何都要把这个浏览器杀掉。
  */
  child.stderr.unref?.()
  child.unref?.()
  process.on('exit', () => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经没了 */
    }
  })

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
