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
 * 第三条规则：**凭证只从环境变量读**，不接受命令行参数（不进 shell 历史），
 * 而且**永不回显** —— 打印的只有 endpoint 主机、桶名、对象数、总字节数。
 */

const REQUIRED = [
  ['R2_ENDPOINT', '对象存储端点，例如 https://<accountid>.r2.cloudflarestorage.com'],
  ['R2_BUCKET', '要列清单的桶名'],
  ['R2_ACCESS_KEY_ID', '只读 Access Key（不要用可写的）'],
  ['R2_SECRET_ACCESS_KEY', '只读 Secret Key'],
]

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ok: true, endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string, redactedEndpoint: string}
 *          | {ok: false, reason: string}}
 */
export function resolveR2Config(env) {
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
  let host = endpoint
  try {
    const parsed = new URL(endpoint)
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, reason: `R2_ENDPOINT 必须是 http(s) 地址（实际协议：${parsed.protocol}）。` }
    }
    host = parsed.host
  } catch {
    return { ok: false, reason: 'R2_ENDPOINT 不是合法的 URL（内容已隐去）。' }
  }

  return {
    ok: true,
    endpoint,
    bucket: String(env.R2_BUCKET).trim(),
    accessKeyId: String(env.R2_ACCESS_KEY_ID).trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim(),
    redactedEndpoint: host,
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
 * 构造清单产物（纯函数，凭证**不可能**混进来：它的入参里根本没有凭证）。
 *
 * 单独抽出来的目的很实际：产物里"到底写了什么"是这条工具最重要的安全属性之一
 * （清单将来要进报告/进仓库），所以它必须能被单测**直接断言**，
 * 而不是只能靠"跑一次脚本再打开文件看"。
 *
 * @param {{generatedAt?: string, source: string, objects: {key: string, size: number, lastModified?: string, etag?: string}[],
 *          compare?: object | null}} input
 */
export function buildInventoryArtifact({ generatedAt, source, objects, compare = null }) {
  const summary = summarizeObjects(objects)
  return {
    generatedAt: generatedAt ?? new Date().toISOString(),
    readOnly: true,
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
