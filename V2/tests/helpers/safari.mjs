/**
 * tests/helpers/safari.mjs —— Safari 的 WebDriver 客户端（零依赖）
 * ============================================================================
 * 业主 Stage 10 §20 要求"Chrome desktop / Safari desktop 各跑一次"。
 *
 * Chrome 那条路走的是 CDP（`browser.mjs`）；Safari 不支持 CDP，
 * 它只认 W3C WebDriver（`safaridriver`，macOS 自带）。所以这里用最朴素的
 * HTTP + JSON 实现一遍所需的那几个命令 —— 为了一个验收脚本引入 Playwright
 * 不划算，而且会让"测试依赖"变成一个新包袱。
 *
 * ⚠️ 前提：Safari 里要打开 **设置 → 开发者 → 允许远程自动化**。
 * 这是系统级的一次性开关（`safaridriver --enable` 还要管理员密码），
 * 自动化**无法**替你打开。没打开时这里会抛一句能照做的话，而不是一个
 * 看不懂的英文错误。
 */
const BASE = process.env.SAFARI_DRIVER_URL ?? 'http://127.0.0.1:4444'

export class SafariUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SafariUnavailableError'
  }
}

async function wd(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (json.value && json.value.error) {
    throw new SafariUnavailableError(`${json.value.error}: ${json.value.message}`)
  }
  return json.value
}

/** safaridriver 在不在、能不能建会话。 */
export async function safariStatus() {
  try {
    const status = await wd('GET', '/status')
    return { driver: true, ready: status?.ready === true }
  } catch (error) {
    return { driver: false, ready: false, error: error.message }
  }
}

const ALLOW_REMOTE_AUTOMATION_HELP =
  'Safari 需要一次性打开「允许远程自动化」：\n' +
  '  1) Safari → 设置 → 开发者 → 勾选「允许远程自动化」\n' +
  '     （没有「开发者」菜单：Safari → 设置 → 高级 → 勾选「显示网页开发者功能」）\n' +
  '  2) 再跑一次：npm run verify:safari\n' +
  '  若仍失败，可执行 `safaridriver --enable`（需要管理员密码）。'

export async function launchSafari() {
  const status = await safariStatus()
  if (!status.driver) {
    throw new SafariUnavailableError(
      `连不上 safaridriver（${BASE}）。先在一个终端里运行：safaridriver -p 4444\n${ALLOW_REMOTE_AUTOMATION_HELP}`,
    )
  }
  try {
    const session = await wd('POST', '/session', {
      capabilities: { alwaysMatch: { browserName: 'safari' } },
    })
    return new SafariSession(session.sessionId)
  } catch (error) {
    if (String(error.message).includes('Allow remote automation')) {
      throw new SafariUnavailableError(ALLOW_REMOTE_AUTOMATION_HELP)
    }
    /*
      这一类失败**不是**「允许远程自动化」没开，而是 Safari 本身没在跑 /
      被上一次自动化留在一个坏状态里。safaridriver 会一直等到超时
      （约 30 秒），报"timed out while connecting to a Safari instance"。
      给一个能照做的下一步，而不是让人去猜（阶段 11 真的遇到过：
      safaridriver 在跑、Safari 没在跑，两个视口都建不出会话）。
    */
    if (String(error.message).includes('timed out while connecting to a Safari instance')) {
      throw new SafariUnavailableError(
        'safaridriver 在跑，但 Safari 起不来（自动化会话超时）。\n' +
          '  先执行一次：open -a Safari\n' +
          '  然后重跑：npm run test:safari\n' +
          '  （「允许远程自动化」是一次性开关，不受这一步影响。）',
      )
    }
    throw error
  }
}

export class SafariSession {
  constructor(sessionId) {
    this.sessionId = sessionId
    /**
     * 哪些点击是"WebDriver 说点不动、改用页面内 click 完成"的。
     *
     * 记录下来是为了**诚实**：页面内 click 仍然是 Safari 自己派发的真实点击，
     * 但它不走命中测试（也就是说"被浮层挡住"这类问题它发现不了）。
     * 验收报告里会把这些元素列出来，而不是让它们悄悄混过去。
     */
    this.fallbackClicks = []
  }

  async #cmd(method, path, body) {
    return wd(method, `/session/${this.sessionId}${path}`, body)
  }

  async goto(url) {
    await this.#cmd('POST', '/url', { url })
  }

  async find(selector) {
    const el = await this.#cmd('POST', '/element', { using: 'css selector', value: selector })
    const key = Object.keys(el)[0]
    return el[key]
  }

  async findMany(selector) {
    const els = await this.#cmd('POST', '/elements', { using: 'css selector', value: selector })
    return els.map((e) => e[Object.keys(e)[0]])
  }

  async click(selector) {
    const id = await this.find(selector)
    await this.#cmd('POST', `/element/${id}/click`, {})
  }

  async type(selector, text) {
    const id = await this.find(selector)
    await this.#cmd('POST', `/element/${id}/value`, { text })
  }

  /**
   * 往 `<input type="file">` 里塞一个真实文件。
   *
   * W3C WebDriver 对文件输入框的规定就是"把**绝对路径**当按键发过去"，
   * Safari 也照这个实现 —— 于是这一步走的是 Safari 自己的文件选择逻辑，
   * 不是我们在页面里造一个 File 对象（那样测不到真实上传路径）。
   */
  async setFileInput(selector, absolutePath) {
    const id = await this.find(selector)
    await this.#cmd('POST', `/element/${id}/value`, { text: absolutePath })
  }

  /** 在页面里跑一段脚本（`/execute/sync`）。参数按 W3C 约定用 `arguments[n]` 取。 */
  async executeScript(script, args = []) {
    return this.#cmd('POST', '/execute/sync', { script, args })
  }

  /**
   * 点击：先滚进视口，再交给 WebDriver 点。
   *
   * 为什么需要"先滚动"：Safari 的 WebDriver 会拒绝点击不在视口里、
   * 或被判定不可交互的元素（`element not interactable`）——
   * 侧边栏里靠下的节点、被卡片盖住的按钮都会撞上它。
   *
   * 万一还是点不动，就退回**页面内 click**：那仍然是 Safari 自己派发的真实点击，
   * 只是跳过了命中测试。走这条路会被记进 `fallbackClicks`，验收报告里如实列出。
   */
  async clickRobust(selector) {
    const id = await this.find(selector)
    const ref = { 'element-6066-11e4-a52e-4f735466cecf': id }
    await this.#cmd('POST', '/execute/sync', {
      script: `arguments[0].scrollIntoView({ block: 'center', inline: 'center' }); return true`,
      args: [ref],
    }).catch(() => {})
    try {
      await this.#cmd('POST', `/element/${id}/click`, {})
      return 'webdriver'
    } catch (error) {
      const done = await this.executeScript(
        `const el = document.querySelector(arguments[0])
         if (!el) return false
         el.scrollIntoView({ block: 'center', inline: 'center' })
         el.click()
         return true`,
        [selector],
      ).catch(() => false)
      if (!done) throw error
      /*
        WebDriver 说"点不动"时，还要回答一个问题：**那是不是真的点不动？**

        用 Safari 自己的命中测试（`elementFromPoint`）在那个元素的正中心取样：
        如果最顶上的元素就是它（或它的子元素），那说明"人点得到"，
        WebDriver 的拒绝只是驱动层的严格判定；反之就可能是真问题
        （被浮层盖住 / 尺寸为 0 / 在视口外），那种情况必须报出来。
      */
      const hit = await this.executeScript(
        `const el = document.querySelector(arguments[0])
         if (!el) return { hitTest: 'no-element' }
         const r = el.getBoundingClientRect()
         const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
         return {
           hitTest: top && (top === el || el.contains(top) || top.contains(el)) ? 'ok' : 'blocked',
           top: top ? top.tagName : null,
           w: Math.round(r.width),
           h: Math.round(r.height),
         }`,
        [selector],
      ).catch(() => ({ hitTest: 'unknown' }))
      this.fallbackClicks.push({ selector, reason: error.message, ...hit })
      return 'in-page'
    }
  }

  /**
   * 轮询直到条件成立（Safari 这边没有 CDP 的等待原语，自己写一个）。
   *
   * `fn` 抛错按"还没好"处理：轮询期间元素本来就可能还不存在，
   * 而 `attr()` / `text()` 在元素缺失时是**抛错**的 ——
   * 第一版没兜住这个，于是"等页面出现"变成了"第一个 250ms 就炸"。
   */
  async waitUntil(fn, { timeoutMs = 20000, label = '条件', intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const value = await fn()
        if (value) return value
      } catch {
        // 还没出现/还不能读 → 继续等
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
  }

  /** 等某个选择器出现。 */
  async waitFor(selector, timeoutMs = 20000, label = selector) {
    await this.waitUntil(() => this.exists(selector), { timeoutMs, label })
  }

  async text(selector) {
    const id = await this.find(selector)
    return this.#cmd('GET', `/element/${id}/text`)
  }

  async attr(selector, name) {
    const id = await this.find(selector)
    return this.#cmd('GET', `/element/${id}/attribute/${name}`)
  }

  async exists(selector) {
    return (await this.findMany(selector)).length > 0
  }

  async url() {
    return this.#cmd('GET', '/url')
  }

  /**
   * 设窗口尺寸。
   *
   * ⚠️ 这不是可有可无的装饰：V2 的侧边栏是 `hidden … lg:flex`，
   * 视口窄于 1024px 时它**根本不渲染**，而眼下又**没有**汉堡菜单或底部导航
   * （见 docs/STAGE10_ACCEPTANCE.md 的"发现"一节）。
   * 所以"桌面端 Safari 验收"必须先把窗口设成桌面宽度 ——
   * 否则测出来的 0×0 是视口问题，不是业务问题。
   */
  async setWindowRect({ width, height }) {
    return this.#cmd('POST', '/window/rect', { width, height })
  }

  async windowRect() {
    return this.#cmd('GET', '/window/rect')
  }

  /** 截图（PNG base64）—— 留证据用。 */
  async screenshot() {
    return this.#cmd('GET', '/screenshot')
  }

  async quit() {
    await wd('DELETE', `/session/${this.sessionId}`)
  }
}
