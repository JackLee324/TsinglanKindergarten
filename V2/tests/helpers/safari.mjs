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
    throw error
  }
}

export class SafariSession {
  constructor(sessionId) {
    this.sessionId = sessionId
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

  /** 截图（PNG base64）—— 留证据用。 */
  async screenshot() {
    return this.#cmd('GET', '/screenshot')
  }

  async quit() {
    await wd('DELETE', `/session/${this.sessionId}`)
  }
}
