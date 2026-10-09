/**
 * scripts/lib/r2-target.mjs —— 只读对象存储清单的**配置解析**（唯一一份）
 * ============================================================================
 * 业主 Stage 13C §3：正式切换前必须拿到 R2 的**对象清单**，明确文件迁移范围；
 * 在核实以前**不删除、不覆盖任何生产对象**。
 *
 * 于是这个工具的第一条规则是"只读"：它只有一个 List 动作，没有任何写/删动作
 * （由 `tests/unit/r2-inventory-safety.test.mjs` 静态盯着，不是靠自觉）。
 *
 * 第二条规则与交接脚本同源：**缺配置就退出，不猜任何默认桶**。
 * 猜错桶的后果是"对着生产桶做了一次看起来无害的列举"，但那已经越界了。
 *
 * 第三条规则（业主 Stage 13C.1 §一）：**默认只允许 HTTPS**。
 * 这个工具会拿 Access Key / Secret Key 去发请求 —— 允许 `http://` 就等于允许
 * 把生产凭证明文发到某个地址上。本地模拟器（自建的 S3 兼容服务）如果确实需要明文，
 * 必须**显式**开 `allowInsecureLocal`，而且目标必须是本机地址；远端 HTTP 一律拒绝。
 *
 * 第四条：**凭证只从环境变量读**，不接受命令行参数（不进 shell 历史），
 * 且**永不回显** —— 打印的只有 endpoint 主机、桶名、对象数、总字节数。
 */

const REQUIRED = [
  ['R2_ENDPOINT', '对象存储端点，例如 https://<accountid>.r2.cloudflarestorage.com'],
  ['R2_BUCKET', '要列清单的桶名'],
  ['R2_ACCESS_KEY_ID', '只读 Access Key（不要用可写的）'],
  ['R2_SECRET_ACCESS_KEY', '只读 Secret Key'],
]

/**
 * 判定"本机地址"。`--allow-http-local` 只对这些主机生效。
 *
 * 注意 `0.0.0.0` **不**算：它是"监听所有网卡"的写法，作为**客户端目标**没有意义，
 * 而且很容易被 DNS/代理解释成别的东西。宁可让本地模拟器写 `127.0.0.1`。
 */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{allowInsecureLocal?: boolean}} [options] 只有显式开启时，才允许指向**本机**的 http
 * @returns {{ok: true, endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string,
 *            redactedEndpoint: string, insecureLocal: boolean}
 *          | {ok: false, reason: string}}
 */
export function resolveR2Config(env, { allowInsecureLocal = false } = {}) {
  const missing = REQUIRED.filter(([name]) => String(env?.[name] ?? '').trim() === '')
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        '缺少对象存储配置（只要求只读凭证，且**只从环境变量读**，不要写进命令行）：\n' +
        missing.map(([name, why]) => `      ${name}    # ${why}`).join('\n') +
        '\n    提示：也可以用 `--from-console <清单文件>` 直接喂入 R2 控制台导出的对象清单，完全不连网。',
    }
  }

  const endpoint = String(env.R2_ENDPOINT).trim()
  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    return { ok: false, reason: 'R2_ENDPOINT 不是合法的 URL（内容已隐去）。' }
  }

  /*
    端点协议：**先判协议、再判主机**。
    顺序反了会把"远端 http"说成"协议不支持"，操作者照着改还是错的。
  */
  let insecureLocal = false
  if (parsed.protocol === 'https:') {
    insecureLocal = false
  } else if (parsed.protocol === 'http:') {
    if (!allowInsecureLocal) {
      return {
        ok: false,
        reason:
          'R2_ENDPOINT 必须是 https://（清单会带只读凭证去请求，明文 HTTP 等于让凭证裸奔）。\n' +
          '    本地 S3 兼容模拟器确实需要 http 时，显式加 `--allow-http-local`，' +
          '并且端点必须指向本机（127.0.0.1 / ::1 / localhost）。',
      }
    }
    if (!isLoopbackHost(parsed.hostname)) {
      return {
        ok: false,
        reason:
          `--allow-http-local 只允许**本机**地址，而 R2_ENDPOINT 指向的是 ${parsed.hostname} —— 拒绝。\n` +
          '    远端 HTTP 端点在任何情况下都不接受（要连远端就上 https）。',
      }
    }
    insecureLocal = true
  } else {
    return { ok: false, reason: `R2_ENDPOINT 必须是 http(s) 地址（实际协议：${parsed.protocol}）。` }
  }

  const bucket = String(env.R2_BUCKET).trim()
  if (bucket === '') return { ok: false, reason: 'R2_BUCKET 是空白 —— 不猜要列哪个桶。' }

  return {
    ok: true,
    endpoint,
    bucket,
    accessKeyId: String(env.R2_ACCESS_KEY_ID).trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim(),
    redactedEndpoint: parsed.host,
    insecureLocal,
  }
}

/**
 * 把一层"清单对象"压成给人看的摘要（键前缀分布 + 总量）。
 * @param {{key: string, size: number}[]} objects
 */
export function summarizeObjects(objects) {
  const byPrefix = new Map()
  let totalBytes = 0
  for (const o of objects) {
    totalBytes += Number(o.size ?? 0)
    const top = o.key.includes('/') ? o.key.split('/')[0] : '(根目录)'
    byPrefix.set(top, (byPrefix.get(top) ?? 0) + 1)
  }
  const prefixes = [...byPrefix.entries()]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count)
  return { count: objects.length, totalBytes, prefixes }
}

/**
 * 按 S3 的**字面前缀语义**过滤对象（`key.startsWith(prefix)`）。
 *
 * 业主 Stage 13C.2 §三：`--from-console` 以前只把 Prefix 写进元数据，**没有**真的过滤 ——
 * 于是"整桶导出 + 声明 `--prefix uploads/`"会产出一份元数据说 `uploads/`、
 * 内容却是整桶的清单，再拿去对比就会报出误导性的新增/消失。
 * 元数据必须描述**真实的对象集合**，所以过滤要真的做。
 *
 * @param {{key: string}[]} objects
 * @param {string} prefix 空串 = 不过滤（整桶）
 */
export function applyPrefixFilter(objects, prefix) {
  const p = String(prefix ?? '')
  return p === '' ? objects : objects.filter((o) => o.key.startsWith(p))
}

/**
 * 完整性判定（纯函数）。
 *
 * 规则（业主 Stage 13C.2 §一 / §二，两处都写死在这里，两个来源共用）：
 *   · **只要用了 `--max`** → 永远 `complete=false`（无论实际对象数是 0、刚好等于上限、
 *     还是少于上限）。"这次刚好没截断"不能自证完整；
 *   · 控制台导出**默认不完整**：格式正确 ≠ 已证明全量。
 *     只有操作者给出预期数量（来自控制台或独立核验来源）**且与解析结果一致**，
 *     才允许 `complete=true`；否则一律 `complete=false`；
 *   · 实时列举：走完全部分页才是完整。
 *
 * 返回里同时记录"谁声明的、工具验证了什么"，便于报告里区分
 * **操作者确认** 与 **工具独立验证**（业主明确要求这两者不能混为一谈）。
 *
 * @param {{source: 'api-list' | 'console-export', usedMax: boolean, expectCount: number | null,
 *          observedCount: number}} input
 */
export function decideCompleteness({ source, usedMax, expectCount, observedCount }) {
  const base = {
    expectedCount: expectCount ?? null,
    observedCount,
    declaredBy: expectCount === null ? null : 'operator:--expect-count',
  }
  if (usedMax) {
    return {
      complete: false,
      reason: 'truncated-by-max',
      verification: 'none',
      ...base,
      explanation: '使用了 --max（抽样）：无论是否触顶，都不构成"已证明全量"。',
    }
  }
  if (source === 'console-export') {
    if (expectCount === null) {
      return {
        complete: false,
        reason: 'console-export-unverified',
        verification: 'none',
        ...base,
        explanation:
          '控制台导出只证明"文件格式有效"，不证明"覆盖了整个桶/前缀"。' +
          '要用它做正式对账，必须给出 `--expect-count <控制台显示的对象数> --expect-source <来源>`。',
      }
    }
    if (expectCount !== observedCount) {
      // 调用方会把它变成硬失败；这里仍然返回可判定的结果，避免静默通过。
      return {
        complete: false,
        reason: 'expect-count-mismatch',
        verification: 'tool-verified-mismatch',
        ...base,
        explanation: `预期 ${expectCount} 个，实际解析出 ${observedCount} 个 —— 不一致。`,
      }
    }
    return {
      complete: true,
      reason: 'console-export-count-verified',
      verification: 'tool-verified-count-match',
      ...base,
      explanation: `操作者声明的数量与解析结果一致（${observedCount} 个）—— 数量核对通过。`,
    }
  }
  return {
    complete: true,
    reason: 'listed-all-pages',
    verification: 'tool-listed-all-pages',
    ...base,
    explanation: '分页全部走完（未使用 --max）。',
  }
}

/**
 * 构造清单产物（纯函数，凭证**不可能**混进来：它的入参里根本没有凭证）。
 *
 * 完整性是这里的头等事（业主 Stage 13C.1 §三）：
 *   · `complete=true` 只可能来自"把所有分页都走完了"这一种情形；
 *   · 任何被 `--max` 截断的产物都必须是 `complete=false`，并**明确标注不可用于正式对账** ——
 *     半个清单和全量清单在肉眼上完全一样，唯一能区分它们的就是这几个字段。
 *
 * @param {{generatedAt?: string, source: string, objects: any[], compare?: object | null,
 *          scope: {method: string, endpointHost: string | null, bucket: string | null, prefix: string},
 *          completeness: {complete: boolean, reason: string}}} input
 */
export function buildInventoryArtifact({ generatedAt, source, objects, compare = null, scope, completeness }) {
  const summary = summarizeObjects(objects)
  const complete = completeness?.complete === true
  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    readOnly: true,
    complete,
    completeness: {
      complete,
      reason: completeness?.reason ?? 'unknown',
      /** 正式对账（尤其是"对象是否消失"）只认完整清单。 */
      usableForProductionComparison: complete,
      /**
       * 把"操作者声明"与"工具验证"分开写：只写一个 `complete` 的话，
       * 报告里就分不清"数量核对通过了"和"有人口头说它是全量"。
       */
      verification: completeness?.verification ?? 'none',
      declaredBy: completeness?.declaredBy ?? null,
      expectSource: completeness?.expectSource ?? null,
      expectedCount: completeness?.expectedCount ?? null,
      observedCount: completeness?.observedCount ?? null,
      explanation: completeness?.explanation ?? null,
    },
    scope: {
      method: scope?.method ?? 'unknown',
      endpointHost: scope?.endpointHost ?? null,
      bucket: scope?.bucket ?? null,
      prefix: scope?.prefix ?? '',
      /** 过滤是否真的作用在对象集合上（不是只写在元数据里）。 */
      prefixFilterApplied: scope?.prefixFilterApplied === true,
    },
    source,
    summary: { count: summary.count, totalBytes: summary.totalBytes, prefixes: summary.prefixes },
    compare,
    objects: objects.map((o) => ({
      key: o.key,
      size: Number(o.size ?? 0),
      lastModified: o.lastModified ?? '',
      etag: o.etag ?? '',
    })),
  }
}

/**
 * 对比两份清单**之前**的范围与完整性核对（业主 Stage 13C.1 §三）。
 *
 * 不满足时返回 `{ok:false, kind:'not-artifact'|'incomplete'|'scope', reason}`（退出码由调用方按 kind 选），
 * 满足时返回 `{ok: true}`。
 * 这里刻意**不**做"尽力而为的对比"：范围不同的两份清单算出来的差异是假结论，
 * 比"没有结论"危险得多 —— 它会让人以为某个生产对象被删了。
 *
 * @param {any} previous 前一份清单产物
 * @param {any} current 当前清单产物
 */
export function assertComparable(previous, current) {
  if (previous === null || typeof previous !== 'object' || !Array.isArray(previous.objects)) {
    return { ok: false, kind: 'not-artifact', reason: '前一份清单不是本工具产出的产物（缺少 objects 数组）—— 拒绝对比。' }
  }
  if (previous.readOnly !== true) {
    return { ok: false, kind: 'not-artifact', reason: '前一份清单没有 readOnly 标记 —— 不确定它是怎么来的，拒绝对比。' }
  }
  if (previous.complete !== true || current.complete !== true) {
    const which = previous.complete === true ? '当前' : '前一份'
    return {
      ok: false,
      kind: 'incomplete',
      reason:
        `${which}清单是**不完整的**（complete=false）—— 不完整清单不能用来判断"对象是否消失"；` +
        '请先跑一次全量列举（不要用 --max）。',
    }
  }
  const a = previous.scope ?? {}
  const b = current.scope ?? {}
  if (a.bucket !== b.bucket) {
    return {
      ok: false,
      kind: 'scope',
      reason: `两份清单的桶不一致（${a.bucket ?? '(未声明)'} vs ${b.bucket ?? '(未声明)'}）—— 拒绝对比。`,
    }
  }
  if ((a.prefix ?? '') !== (b.prefix ?? '')) {
    return {
      ok: false,
      kind: 'scope',
      reason: `两份清单的前缀不一致（"${a.prefix ?? ''}" vs "${b.prefix ?? ''}"）—— 集合范围不同，差异没有意义。`,
    }
  }
  if (
    a.endpointHost !== null &&
    a.endpointHost !== undefined &&
    b.endpointHost !== null &&
    b.endpointHost !== undefined &&
    a.endpointHost !== b.endpointHost
  ) {
    return {
      ok: false,
      kind: 'scope',
      reason: `两份清单的 endpoint 主机不一致（${a.endpointHost} vs ${b.endpointHost}）—— 不是同一个存储。`,
    }
  }
  return { ok: true }
}
