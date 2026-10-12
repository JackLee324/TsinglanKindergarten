/**
 * scripts/lib/cors-drift.mjs —— 桶 CORS 与「当前实际部署域名」的一致性规则
 * ============================================================================
 * 为什么需要它（2026-10-12 的真实故障）：
 *
 *   教师平台换了域名（`tsinglan.zeabur.app` → `tsinglanteachers.zeabur.app`），
 *   但 R2 桶 `tsinglan2` 的 CORS 还停在旧域名上。浏览器直传的预检因此返回 403，
 *   老师看到的是「网络中断，上传没有完成」。
 *
 *   当时的 `check-storage.mjs` **看不出来**：它只检查 CORS 里有没有通配符，
 *   而一个"过期的具体域名"既不是通配符、也不为空，于是自检报「正常」。
 *   故障就这样静默潜伏到第一个老师上传失败。
 *
 * 所以这里补的是**另一类判断**：桶上放行的 origin 里，
 * 有没有**当前实际在用的那个**。
 *
 * ⚠️ 判断的输入绝不能来自被检查的那份配置本身：
 *   拿 `V2_PUBLIC_ORIGIN`（或直接读桶里的 CORS）当"期望值"去比对，
 *   两边同时停在旧域名时会一致地"通过" —— 那正是这次故障的形状。
 *   期望 Origin 必须由操作者显式给出（`--base` / `--expected-origin`）。
 */

/**
 * 浏览器直传需要的方法。
 *
 * `PUT` 是上传本身；`GET` / `HEAD` 是预览与下载 —— 桶上少一个，
 * 对应操作就会在浏览器里被 CORS 拦掉，而不是在服务端报错。
 */
export const REQUIRED_METHODS = ['PUT', 'GET', 'HEAD']

/**
 * 预签名 PUT / GET 会带的请求头。
 *
 * 这几个与 `buildBucketCorsPolicy()` 写进桶的那份列表是同一组：
 * 少放行一个，浏览器预检就会因为 `Access-Control-Request-Headers` 里的
 * 某一项没被允许而整体失败。
 */
export const REQUIRED_ALLOWED_HEADERS = [
  'content-type',
  'x-amz-checksum-sha256',
  'x-amz-date',
  'authorization',
]

/**
 * 把一个输入规范化成 **Origin**（`scheme://host[:port]`）。
 *
 * 输入可以是 origin 本身，也可以是任意 URL —— `--base` 给的就是部署地址
 * （可能带路径，比如 `https://x.zeabur.app/login`）。
 *
 * 按 Origin 语义处理：
 *   · 协议与主机大小写归一（`HTTPS://A.COM` 与 `https://a.com` 同源）；
 *   · 丢弃 path / query / hash —— 它们不参与同源判定，
 *     所以末尾带不带 `/`、是不是 `/login` 都不改变 Origin；
 *   · 默认端口省略（`https://a.com:443` 就是 `https://a.com`，这是同一个 Origin）；
 *   · **不同协议 / 不同主机 / 不同（非默认）端口仍然不同** —— 不做任何宽松化。
 *
 * 返回规范化后的 origin 字符串；不是合法的 http(s) 地址时返回 `null`。
 */
export function normalizeOrigin(input) {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw === '') return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // CORS 只对 http(s) 有意义；`*` 这类通配符也在这里被挡掉（URL 解析就会失败）。
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname === '') return null
  // `URL.origin` 正好就是我们要的语义：小写化、省略默认端口、丢掉 path。
  return url.origin
}

/** 把一批输入规范化、去重、排序；顺带把不合法的挑出来（让调用方能报清楚）。 */
export function normalizeOriginList(inputs) {
  const origins = []
  const invalid = []
  for (const input of inputs) {
    const origin = normalizeOrigin(input)
    if (origin === null) invalid.push(typeof input === 'string' ? input.trim() : String(input))
    else if (!origins.includes(origin)) origins.push(origin)
  }
  return { origins, invalid }
}

/**
 * 评估桶的 CORS 策略是否与期望 Origin 一致。
 *
 * 只做判断，不改任何东西，也不抛异常 —— 调用方（检查脚本）负责把
 * `problems` 打印出来并以非零退出码结束。
 *
 * `unauthorizedOrigins` 单独返回：桶上出现期望之外的 origin（多半是历史域名）
 * 是**需要核实**的信号，但不是本检查的失败条件 ——
 * 它可能仍被某个还在用的环境依赖，擅自判失败会逼人删掉还在用的来源。
 */
export function evaluateBucketCors(policy, expectedOrigins) {
  const expected = [...new Set((expectedOrigins ?? []).map(normalizeOrigin).filter((o) => o !== null))]
  const rules = Array.isArray(policy?.CORSRules) ? policy.CORSRules : []

  const allowedOrigins = []
  const allowedMethods = new Set()
  const allowedHeaders = new Set()
  let wildcard = false

  for (const rule of rules) {
    for (const origin of rule?.AllowedOrigins ?? []) {
      const value = String(origin).trim()
      if (value === '*') wildcard = true
      else if (value !== '') allowedOrigins.push(value)
    }
    for (const method of rule?.AllowedMethods ?? []) {
      allowedMethods.add(String(method).trim().toUpperCase())
    }
    for (const header of rule?.AllowedHeaders ?? []) {
      allowedHeaders.add(String(header).trim().toLowerCase())
    }
  }

  const normalizedAllowed = [...new Set(allowedOrigins.map(normalizeOrigin).filter((o) => o !== null))]

  // 期望的 Origin **必须真的出现在允许列表里**。列表里有旧域名不代表新域名已授权。
  const missingOrigins = expected.filter((o) => !normalizedAllowed.includes(o))
  const unauthorizedOrigins = [...new Set(allowedOrigins)].filter((raw) => {
    const normalized = normalizeOrigin(raw)
    return normalized === null || !expected.includes(normalized)
  })
  const missingMethods = REQUIRED_METHODS.filter((m) => !allowedMethods.has(m))
  const missingHeaders = REQUIRED_ALLOWED_HEADERS.filter((h) => !allowedHeaders.has(h))

  const problems = []
  if (rules.length === 0) {
    problems.push('桶上没有任何 CORS 规则 —— 浏览器直传会被预检拦掉。')
  }
  if (wildcard) {
    problems.push('CORS 里出现了通配符 `*` —— 浏览器直传不需要把门开到最大。')
  }
  if (missingOrigins.length > 0) {
    problems.push(
      `当前实际部署的 Origin 不在允许列表里：${missingOrigins.join(', ')}` +
        '（允许列表里的旧域名不能代表新域名已授权）。',
    )
  }
  if (missingMethods.length > 0) {
    problems.push(`AllowedMethods 缺少：${missingMethods.join(', ')}（浏览器直传与预览/下载要用）。`)
  }
  if (missingHeaders.length > 0) {
    problems.push(`AllowedHeaders 缺少：${missingHeaders.join(', ')}（预检会因这些头没被允许而整体失败）。`)
  }

  return {
    ok: problems.length === 0,
    expected,
    wildcard,
    allowedOrigins,
    normalizedAllowed,
    missingOrigins,
    unauthorizedOrigins,
    missingMethods,
    missingHeaders,
    problems,
  }
}
