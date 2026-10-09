/**
 * scripts/lib/db-target.mjs —— 运维脚本的**数据库目标解析**（唯一一份）
 * ============================================================================
 * 业主 Stage 13C §4 的要求，原话是：交接脚本在没有 `DATABASE_URL` 时会回退到
 * 本地开发库地址 —— "虽然不会自动连接生产数据库，但对一个执行最高权限交接的
 * 运维脚本来说，容易让操作者误以为自己正在操作目标环境"。
 *
 * 所以这里的规则是**硬**的：
 *
 *   1. **没有 `DATABASE_URL` 就不解析出任何目标** —— 调用方必须立刻退出，
 *      不做任何数据库操作。运维脚本**不接受**任何默认库。
 *   2. 目标必须能打印成**脱敏**形式：`postgresql://user@host:port/dbname`。
 *      口令永远不进日志、不进报告、不进终端回显。
 *   3. 明确告诉操作者这个目标是**本机**还是**远端** —— "我以为在跑本机"
 *      和"我以为在跑生产"都是危险的误解，脚本要主动消除它。
 *
 * 为什么单独成文件：这段逻辑要能被单元测试直接调用（见
 * `tests/unit/db-target.test.mjs`），而不是只能靠"跑一次脚本看看"。
 * 它**不**读 `process.env`，环境由调用方传入 —— 可测、可复用、不产生隐式状态。
 */

/** 判定"本机"的主机名（这些名字只可能指向开发机 / 容器自身）。 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/**
 * 把一个连接串脱敏成可安全打印的形式。
 *
 * 只保留 `user@host:port/dbname`：
 *   · 口令丢掉（`postgresql://u:p@h/d` → `postgresql://u@h/d`）；
 *   · 查询串丢掉（`?sslmode=require&password=…` 这类参数里也可能带敏感值，
 *     而且运维时真正要看的是"哪个库"，不是连接参数）。
 *
 * @param {string} url
 * @returns {string} 脱敏后的目标（**绝不含口令**）
 */
export function redactDatabaseUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    // 连解析都失败时**不要**把原串回显出来 —— 它可能带着口令。
    return '(无法解析的 DATABASE_URL：已隐去)'
  }
  const user = parsed.username === '' ? '' : `${decodeURIComponent(parsed.username)}@`
  const host = parsed.hostname === '' ? '(未指定主机)' : parsed.hostname
  const port = parsed.port === '' ? '' : `:${parsed.port}`
  const db = parsed.pathname.replace(/^\//, '')
  return `${parsed.protocol}//${user}${host}${port}/${db}`
}

/**
 * 解析运维脚本要操作的数据库目标。
 *
 * @param {Record<string, string | undefined>} env 环境变量（调用方传入，默认不读全局）
 * @returns {{ok: true, url: string, redacted: string, local: boolean, database: string, host: string}
 *          | {ok: false, reason: string}}
 */
export function resolveDatabaseTarget(env) {
  const raw = env?.DATABASE_URL ?? ''
  if (String(raw).trim() === '') {
    return {
      ok: false,
      reason:
        '没有设置 DATABASE_URL —— 运维脚本不接受任何默认库（尤其是本机开发库）：\n' +
        '    误以为"跑的是本机"或"跑的是生产"都会造成不可逆的后果。\n' +
        '    请显式给出目标，例如：\n' +
        '      DATABASE_URL=postgresql://用户@主机:5432/库名 …（口令走 .env / 密钥管理，不要写进命令行历史）',
    }
  }
  const url = String(raw).trim()
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'DATABASE_URL 不是合法的连接串（已隐去内容）。' }
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    return { ok: false, reason: `DATABASE_URL 必须是以 postgres:// 或 postgresql:// 开头的连接串（实际协议：${parsed.protocol}）。` }
  }
  const database = parsed.pathname.replace(/^\//, '')
  if (database === '') {
    return { ok: false, reason: 'DATABASE_URL 里没有库名 —— 不敢猜你要操作哪个库。' }
  }
  return {
    ok: true,
    url,
    redacted: redactDatabaseUrl(url),
    local: LOCAL_HOSTS.has(parsed.hostname.toLowerCase()),
    database,
    host: parsed.hostname,
  }
}

/**
 * 打印目标（供运维脚本在**任何写操作之前**调用）。
 *
 * 输出里没有口令；远端目标额外给一句提醒 —— 最高权限的交接动作值得多看一眼。
 *
 * @param {{redacted: string, local: boolean}} target
 * @param {(line: string) => void} [write]
 */
export function announceDatabaseTarget(target, write = (line) => console.log(line)) {
  write(`  目标数据库：${target.redacted}`)
  write(`  环境判定：${target.local ? '本机（开发/演练栈）' : '★ 非本机（远端/生产候选）—— 请再次确认这是你要操作的库'}`)
}
