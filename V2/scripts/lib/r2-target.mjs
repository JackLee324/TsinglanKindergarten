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

import { createHash } from 'node:crypto'

const REQUIRED = [
  ['R2_ENDPOINT', '对象存储端点，例如 https://<accountid>.r2.cloudflarestorage.com'],
  ['R2_BUCKET', '要列清单的桶名'],
  ['R2_ACCESS_KEY_ID', '只读 Access Key（不要用可写的）'],
  ['R2_SECRET_ACCESS_KEY', '只读 Secret Key'],
]

/** 指纹格式：`sha256:` + 16 位十六进制（生成与校验共用同一份定义）。 */
export const STORAGE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{16}$/

/**
 * 存储身份的**自洽校验**（业主 Stage 13C.4）。
 *
 * 为什么不能只在 `assertComparable` 里看身份：产物是磁盘上的文件。
 * 如果只检查"身份能对上"，那么把一份 **API 清单**的身份块改成
 * `{kind:'operator-declared', declaredId:'随便一个标签'}`，比较逻辑就会转而
 * 走"标签相同即同一存储"那条路，**绕过指纹校验** —— 而那正是 13C.3 加指纹的用意。
 * 所以这里把"身份类型必须与来源匹配"钉死：
 *
 *   · `api-list` → 必须 `api-endpoint-fingerprint`，指纹格式合法，
 *     且 `storageIdentity.endpointHost === scope.endpointHost`；
 *     不许是 `operator-declared` / `unknown`（补 `declaredId` 也没用，指纹照样必须验）。
 *   · `console-export` → 只能 `operator-declared`（标签非空、指纹为空）
 *     或 `unknown`（指纹与标签都为空）——**不许伪装成 API 指纹清单**。
 *   · `unknown` 是"诚实的未知"，允许存在，但 `assertComparable` 会拒绝它参与比较。
 *
 * @param {any} artifact
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function assertStorageIdentityConsistent(artifact) {
  const identity = artifact.storageIdentity
  const method = artifact.scope?.method
  if (identity === null || typeof identity !== 'object') {
    return { ok: false, reason: '缺少 storageIdentity（无法确认清单来自哪个存储）' }
  }
  const { kind, fingerprint = null, declaredId = null, endpointHost = null } = identity
  if (!['api-endpoint-fingerprint', 'operator-declared', 'unknown'].includes(kind)) {
    return { ok: false, reason: `storageIdentity.kind 未知（${String(kind)}）` }
  }
  if (declaredId !== null && (typeof declaredId !== 'string' || declaredId.trim() === '')) {
    return { ok: false, reason: 'storageIdentity.declaredId 必须是非空字符串或 null' }
  }

  if (method === 'api-list') {
    if (kind !== 'api-endpoint-fingerprint') {
      return {
        ok: false,
        reason:
          `实时列举清单的身份类型必须是 api-endpoint-fingerprint，实际是 ${String(kind)}` +
          '（改类型 / 补 declaredId 都不能绕过指纹校验）',
      }
    }
    if (typeof fingerprint !== 'string' || !STORAGE_FINGERPRINT_PATTERN.test(fingerprint)) {
      return { ok: false, reason: `实时列举清单的指纹缺失或格式不合法（${String(fingerprint)}）` }
    }
    if (endpointHost !== artifact.scope?.endpointHost) {
      return {
        ok: false,
        reason:
          `身份里记录的端点（${String(endpointHost)}）与 scope.endpointHost（${String(artifact.scope?.endpointHost)}）不一致`,
      }
    }
    return { ok: true }
  }

  if (method === 'console-export') {
    if (kind === 'api-endpoint-fingerprint') {
      return {
        ok: false,
        reason: '控制台导出没有端点/账号信息，不能伪装成 api-endpoint-fingerprint（指纹只由实时列举生成）',
      }
    }
    if (kind === 'operator-declared') {
      if (declaredId === null) {
        return { ok: false, reason: 'operator-declared 身份必须带非空的 declaredId（--storage-id）' }
      }
      if (fingerprint !== null) {
        return { ok: false, reason: 'operator-declared 身份的指纹字段必须为空（控制台导出算不出指纹）' }
      }
      return { ok: true }
    }
    // unknown：必须是"真的未知"——不允许夹带标签或指纹
    if (declaredId !== null || fingerprint !== null) {
      return { ok: false, reason: 'unknown 身份必须保持未知（不得夹带 declaredId 或 fingerprint）' }
    }
    return { ok: true }
  }

  return { ok: false, reason: `scope.method 未知（${String(method)}），无法判断身份类型是否匹配` }
}

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
 * 清单的**存储身份**（业主 Stage 13C.3 §B）。
 *
 * 为什么不能只看桶名：桶名在 R2 里是**账号内唯一**，跨账号完全可以重名。
 * 一份控制台清单和一份实时 API 清单即使桶名、前缀都一样，也可能是
 * "同一个桶名的两个不同账号" —— 那样比出来的差异是彻头彻尾的假结论。
 *
 * 身份的三种形态（`kind`）：
 *   · `api-endpoint-fingerprint`：实时列举，能算出"端点 + 凭据身份"的**指纹**
 *     （`sha256(endpointHost|accessKeyId)` 截断）。Access Key 本身不是密钥，
 *     但仍然不落原文 —— 只落指纹，既能比对又不泄漏。
 *   · `operator-declared`：控制台导出没有 endpoint/账号信息，**只能**由操作者
 *     用 `--storage-id <标签>` 显式声明（例如 `cf-account-tsinglan`）。
 *   · `unknown`：两边都没有 → **拒绝比较**（不许拿桶名当身份）。
 *
 * `assertComparable` 的规则：
 *   · 两边都是 api 指纹 → 指纹必须相同；
 *   · 一边 API、一边控制台 → 要求 API 那份也带**相同**的 `--storage-id`
 *     （即操作者显式确认"这份实时清单和那份导出说的是同一个存储"）；
 *   · 两边都是控制台 → 两个 `--storage-id` 必须相同且非空；
 *   · 任何一边 unknown → 拒绝。
 *
 * @param {{method: string, endpointHost: string | null, accessKeyId?: string | null, declaredId?: string | null}} input
 */
export function buildStorageIdentity({ method, endpointHost, accessKeyId = null, declaredId = null }) {
  const declared = declaredId === null || String(declaredId).trim() === '' ? null : String(declaredId).trim()
  if (method === 'api-list' && endpointHost !== null && endpointHost !== undefined) {
    const seed = `${endpointHost}|${accessKeyId ?? ''}`
    const fingerprint = `sha256:${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`
    if (!STORAGE_FINGERPRINT_PATTERN.test(fingerprint)) {
      // 自检：生成与校验必须用同一个格式定义（改错会立刻炸，而不是悄悄放过）
      throw new Error(`内部错误：指纹格式与 STORAGE_FINGERPRINT_PATTERN 不一致（${fingerprint}）`)
    }
    return { kind: 'api-endpoint-fingerprint', fingerprint, declaredId: declared, endpointHost }
  }
  if (declared === null) {
    return { kind: 'unknown', fingerprint: null, declaredId: null, endpointHost: endpointHost ?? null }
  }
  return { kind: 'operator-declared', fingerprint: null, declaredId: declared, endpointHost: endpointHost ?? null }
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
export function buildInventoryArtifact({ generatedAt, source, objects, compare = null, scope, completeness, identity = null }) {
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
    /**
     * 存储身份：**没有它就不能比较**（业主 Stage 13C.3 §B）。
     * 只落指纹或操作者声明的标签，绝不落凭据原文。
     */
    storageIdentity: identity ?? { kind: 'unknown', fingerprint: null, declaredId: null, endpointHost: null },
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
 * 校验一份清单产物**自身是否自洽**（业主 Stage 13C.3 §C）。
 *
 * 为什么不能只看 `complete === true`：产物是磁盘上的文件，可能被手改过、
 * 可能是旧版本工具写的、也可能是两次运行拼起来的。只看一个字段就等于
 * "相信文件自己说自己没问题"。这里把**互相印证的字段**全部对一遍：
 *
 *   · `readOnly === true`（不是只读工具产出的东西不参与对账）；
 *   · `complete === true` 且 `completeness.complete === true`
 *     且 `completeness.usableForProductionComparison === true`；
 *   · `verification` 与来源匹配：`api-list` → `tool-listed-all-pages`；
 *     `console-export` → `tool-verified-count-match`；`reason` 也要对得上；
 *   · 控制台导出：`expectedCount === observedCount === objects.length` 且 `expectSource` 非空；
 *   · 实时列举：`verification` 必须表示"分页全部走完"（不接受 `none`）；
 *   · `summary.count === objects.length`；
 *   · `scope` 三要素齐备（`method` 已知、`bucket` 非空、`prefix` 是字符串）。
 *
 * 任何一条不成立 → 返回 `kind: 'not-artifact'` 或 `kind: 'inconsistent'`，
 * 调用方**必须拒绝比较**，而不是"补一下元数据再放行"。
 *
 * @param {any} artifact
 */
export function assertArtifactSelfConsistent(artifact) {
  if (artifact === null || typeof artifact !== 'object' || !Array.isArray(artifact.objects)) {
    return { ok: false, kind: 'not-artifact', reason: '缺少 objects 数组（不是本工具产出的清单）' }
  }
  if (artifact.readOnly !== true) {
    return { ok: false, kind: 'not-artifact', reason: '没有 readOnly 标记（不确定它是怎么来的）' }
  }
  const c = artifact.completeness ?? {}
  if (artifact.complete !== true) return { ok: false, kind: 'incomplete', reason: 'complete 不是 true' }
  if (c.complete !== true) return { ok: false, kind: 'inconsistent', reason: 'complete 与 completeness.complete 不一致' }
  if (c.usableForProductionComparison !== true) {
    return { ok: false, kind: 'inconsistent', reason: 'completeness.usableForProductionComparison 不是 true' }
  }
  const method = artifact.scope?.method
  const expected = method === 'api-list'
    ? { verification: 'tool-listed-all-pages', reason: 'listed-all-pages' }
    : method === 'console-export'
      ? { verification: 'tool-verified-count-match', reason: 'console-export-count-verified' }
      : null
  if (expected === null) {
    return { ok: false, kind: 'inconsistent', reason: `scope.method 未知（${String(method)}）` }
  }
  if (c.verification !== expected.verification) {
    return {
      ok: false,
      kind: 'inconsistent',
      reason: `verification=${String(c.verification)} 与来源 ${method} 的规则不符（应为 ${expected.verification}）`,
    }
  }
  if (c.reason !== expected.reason) {
    return { ok: false, kind: 'inconsistent', reason: `reason=${String(c.reason)} 与 verification 不自洽` }
  }
  if (method === 'console-export') {
    if (c.expectedCount !== artifact.objects.length || c.observedCount !== artifact.objects.length) {
      return {
        ok: false,
        kind: 'inconsistent',
        reason: `expectedCount/observedCount（${String(c.expectedCount)}/${String(c.observedCount)}）与 objects.length（${artifact.objects.length}）不一致`,
      }
    }
    if (typeof c.expectSource !== 'string' || c.expectSource.trim() === '') {
      return { ok: false, kind: 'inconsistent', reason: '控制台导出清单缺少 expectSource（数量从哪来的不可追溯）' }
    }
  }
  if (typeof artifact.summary?.count !== 'number' || artifact.summary.count !== artifact.objects.length) {
    return { ok: false, kind: 'inconsistent', reason: 'summary.count 与 objects.length 不一致' }
  }
  if (typeof artifact.scope?.bucket !== 'string' || artifact.scope.bucket.trim() === '') {
    return { ok: false, kind: 'inconsistent', reason: 'scope.bucket 缺失' }
  }
  if (typeof artifact.scope?.prefix !== 'string') {
    return { ok: false, kind: 'inconsistent', reason: 'scope.prefix 缺失' }
  }
  // 身份类型必须与来源匹配（业主 Stage 13C.4）：堵住"改身份类型绕过指纹校验"
  const identity = assertStorageIdentityConsistent(artifact)
  if (!identity.ok) {
    return { ok: false, kind: 'inconsistent', reason: identity.reason }
  }
  return { ok: true }
}

/**
 * 对比两份清单**之前**的核对（业主 Stage 13C.1 §三 + 13C.3 §B/§C）。
 *
 * 顺序是刻意的：**先自洽 → 再完整性 → 再范围 → 最后身份**。
 * 任何一步不过都直接拒绝，并且**不输出任何差异结论** ——
 * 范围/身份不同的两份清单算出来的"消失/新增"是假事故，比没有结论危险得多。
 *
 * 不满足时返回 `{ok:false, kind, reason}`，`kind` 决定退出码：
 *   `not-artifact` / `inconsistent` / `incomplete` → 6；
 *   `identity-unknown` → 6（"无法证明是同一个存储"）；`scope` / `identity-mismatch` → 7。
 *
 * @param {any} previous 前一份清单产物
 * @param {any} current 当前清单（至少含 complete/scope/storageIdentity）
 */
export function assertComparable(previous, current) {
  /*
    **两份都要完整自洽**（业主 Stage 13C.3 §C + 13C.4）。
    校验放在这个函数内部（而不是指望调用方先查一遍）：任何人拿到这两份清单
    调这个函数，得到的都是同一个结论；也不存在"上游松、下游严"的缝。
  */
  const prevConsistent = assertArtifactSelfConsistent(previous)
  if (!prevConsistent.ok) {
    return {
      ok: false,
      kind: prevConsistent.kind,
      reason: `前一份清单不可用于对账：${prevConsistent.reason}。`,
    }
  }
  const currentConsistent = assertArtifactSelfConsistent(current)
  if (!currentConsistent.ok) {
    return {
      ok: false,
      kind: currentConsistent.kind,
      reason: `当前清单不可用于对账：${currentConsistent.reason}。`,
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
  /*
    存储身份（业主 Stage 13C.3 §B）：**桶名相同不等于同一个存储** ——
    桶名只在账号内唯一，跨账号可以重名。所以这里要求身份能被证明：
      · 两边都是 API 指纹 → 指纹相同；
      · 一边 API、一边控制台 → API 那份必须带**同一个** `--storage-id`（操作者确认）；
      · 两边都是控制台 → 两个 `--storage-id` 相同且非空；
      · 任何一边 unknown → 拒绝（不许拿桶名当身份）。
  */
  const ia = previous.storageIdentity ?? { kind: 'unknown' }
  const ib = current.storageIdentity ?? { kind: 'unknown' }
  if (ia.kind === 'unknown' || ib.kind === 'unknown') {
    return {
      ok: false,
      kind: 'identity-unknown',
      reason:
        '有一份清单的**存储身份未知**（控制台导出不会自带账号/端点信息）—— 无法证明两份清单来自同一个存储，拒绝对比。\n' +
        '    要给控制台导出确认身份，请在两次运行时都加上 `--storage-id <标签>`（例如 `--storage-id cf-account-tsinglan`）。',
    }
  }
  if (ia.kind === 'api-endpoint-fingerprint' && ib.kind === 'api-endpoint-fingerprint') {
    if (ia.fingerprint !== ib.fingerprint) {
      return {
        ok: false,
        kind: 'identity-mismatch',
        reason: `两份清单的存储指纹不同（${ia.fingerprint} vs ${ib.fingerprint}）—— 不是同一个端点/账号。`,
      }
    }
  } else {
    // 至少一边是控制台导出：靠操作者声明的标签对齐
    const da = ia.declaredId
    const db = ib.declaredId
    if (da === null || db === null) {
      return {
        ok: false,
        kind: 'identity-unknown',
        reason:
          '控制台导出清单与实时清单要互相比较，必须两边都用 `--storage-id <标签>` 显式确认是同一个存储；' +
          '现在至少一边没给。',
      }
    }
    if (da !== db) {
      return {
        ok: false,
        kind: 'identity-mismatch',
        reason: `两份清单声明的存储身份不同（"${da}" vs "${db}"）—— 拒绝对比。`,
      }
    }
  }

  /*
    endpoint 主机作为**最后一道**补充检查（身份对得上、但落盘的主机名不同，
    说明有一份是在别的端点/代理上产出的）。放在身份之后，是为了让跨账号那种
    最危险的情形报出"不是同一个存储"，而不是一句听起来无害的"主机不一致"。
  */
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
