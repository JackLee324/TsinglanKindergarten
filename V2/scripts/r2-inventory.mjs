#!/usr/bin/env node
/**
 * scripts/r2-inventory.mjs —— **只读**的对象存储清单（业主 Stage 13C §3 + 13C.1 加固）
 * ============================================================================
 * 为什么需要它：V1 的数据库里 `resource_files = 0` **不能**推断"线上桶里没有东西"。
 * 数据库记录与桶里的对象是两套事实；正式切换前必须**真的列一次桶**，
 * 才能说清"有没有需要迁移的文件"，而且这一步在拿到清单之前
 * **严禁删除或覆盖任何生产对象**（业主明确要求）。
 *
 * 安全边界（写进代码，不靠人工小心）：
 *   · **只读**：唯一会调用的接口是 `ListObjectsV2` / `HeadBucket`。
 *     没有 PutObject / DeleteObject / CopyObject —— 由
 *     `tests/unit/r2-inventory-safety.test.mjs` **静态扫描源码**盯着；
 *   · **默认只允许 HTTPS**（Stage 13C.1 §一）：本工具会带只读凭证发请求，
 *     `http://` 默认一律拒绝；本地 S3 兼容模拟器要明文必须显式 `--allow-http-local`，
 *     且端点必须是本机地址（远端 HTTP 永远拒绝）；
 *   · **缺配置就退出**：不猜默认桶、不猜 endpoint（猜错桶 = 已经越界）；
 *   · **凭证只从环境变量读**，不接受命令行参数（不进 shell 历史），且**永不回显**：
 *     输出里只有 endpoint 主机、桶名、对象数、总字节数、前缀分布；
 *   · **不覆写任何已有产物**：`--out` 指向已存在的文件时拒绝（除非显式 `--force`）；
 *   · **完整性必须可辨**（Stage 13C.1 §三 + 13C.2 §一/§二）：
 *     - **只要用了 `--max`，产物一律 `complete=false`**（哪怕对象数没到上限、哪怕是空桶）——
 *       "这次刚好没截断"不能自证完整；`usableForProductionComparison=false`，
 *       这种产物**不能**用于正式对账，也不能作为 G5 的通过证据；
 *     - `--max` **只接受正整数**：`--max 0` / 负数 / 小数 / 非数字 / 缺少数值一律
 *       退出码 2（**参数解析失败绝不回退成"全量"**）—— 判据是"参数有没有出现"，
 *       不是"数值是不是 0"；
 *     - **控制台导出默认不完整**：格式正确 ≠ 已证明全量。要用它做正式对账，
 *       必须 `--expect-count <控制台显示的对象数> --expect-source <来源>`，
 *       且工具会把预期数量与解析结果**核对一致**才标 `complete=true`；
 *     - 文件自带 `IsTruncated: true` / 下一页令牌 / 与自身总数不符 → **直接失败**；
 *     - 产物里把「操作者声明」与「工具验证」分开记录（`declaredBy` / `verification`）。
 *   · **对比前先核范围**：桶 / 前缀 / endpoint 主机不一致、或任一份不完整 → 直接拒绝，
 *     不输出"看起来有效"的差异结论；
 *   · `--from-console <json|csv>` 允许**完全不连网**：用 R2 控制台导出的清单
 *     （**优先完整 JSON**；CSV 走 RFC 4180 解析，坏行会明确报错而不是被跳过）。
 *
 * 用法（本机，凭证走环境变量）：
 *   R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
 *   R2_BUCKET=tsinglan-curriculum \
 *   R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *   node scripts/r2-inventory.mjs --out .migration/r2-inventory.json
 *
 *   node scripts/r2-inventory.mjs --from-console ./r2-objects.json --bucket tsinglan-curriculum \
 *     --expect-count 1234 --expect-source "R2 控制台对象数" --storage-id cf-account-tsinglan \
 *     --out .migration/r2-inventory.json
 *   node scripts/r2-inventory.mjs --from-console ./r2-objects-2.json --bucket tsinglan-curriculum \
 *     --compare .migration/r2-inventory.json
 *
 * 退出码：0 成功 / 2 缺配置或参数不合法（含"默认拒绝 http"）
 *         3 列举失败 / 4 产物已存在（未给 --force）
 *         5 对比发现对象消失（**要人来判断，不能静默通过**）
 *         6 对比里有不完整 / 字段自相矛盾 / 来源身份无法确认的清单（拒绝对比）
 *         7 对比范围不同、或存储身份不同（拒绝对比）
 *         8 清单来源解析失败（CSV/JSON 坏行、缺 key、非法 size、分页未走完等）
 *         9 预期数量与实际解析结果不一致（不产出可对账的完整清单）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { InventorySourceError, parseConsoleExport } from './lib/inventory-source.mjs'
import {
  applyPrefixFilter,
  assertArtifactSelfConsistent,
  assertComparable,
  buildInventoryArtifact,
  buildStorageIdentity,
  decideCompleteness,
  resolveR2Config,
  summarizeObjects,
} from './lib/r2-target.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

function fail(message, code = 2) {
  console.error(`✖ ${message}`)
  process.exit(code)
}

/**
 * 严格解析一个"正整数"参数。
 *
 * ⚠️ 为什么不能写 `Number(arg('max','0')) || 0`：`--max 0`、`--max abc`、`--max`(
 * 缺少数值) 都会被静默变成 0，而完整性保护判的是 `MAX > 0` —— 于是
 * **显式传了 `--max` 却走全量分支、产出 `complete=true`**，直接绕过门禁。
 * 所以这里区分"没传"与"传了但无效"，后者一律报错退出。
 */
function readPositiveIntArg(name) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return { present: false, value: null, invalid: null }
  const raw = process.argv[i + 1]
  if (raw === undefined || raw.startsWith('--')) {
    return { present: true, value: null, invalid: `--${name} 后面缺少数值` }
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    return { present: true, value: null, invalid: `--${name} 只接受正整数（实际给了 "${raw}"）` }
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    return { present: true, value: null, invalid: `--${name} 数值过大（"${raw}"）` }
  }
  return { present: true, value, invalid: null }
}

const OUT = arg('out', null)
const CONSOLE_FILE = arg('from-console', null)
const COMPARE = arg('compare', null)
const BUCKET_ARG = arg('bucket', null)
/** 存储身份标签：控制台导出用它"确认自己是哪个存储"；实时列举用它给自己起可读的名字。 */
const STORAGE_ID = arg('storage-id', null)
const PREFIX = arg('prefix', '')
const maxArg = readPositiveIntArg('max')
if (maxArg.invalid !== null) {
  // 不产出任何产物、不连任何存储：参数无效就是无效，绝不"退化成全量"。
  fail(`${maxArg.invalid}。\n    提示：--max 只用于抽样调试；正式对账请**不要**传 --max。`)
}
const MAX_USED = maxArg.present
const MAX = maxArg.value ?? 0
/** 控制台导出的**预期对象数**：必须来自控制台/独立核验来源，脚本不自行推导。 */
const EXPECT_COUNT_RAW = arg('expect-count', null)
const EXPECT_SOURCE = arg('expect-source', null)
const EXPECT_COUNT = EXPECT_COUNT_RAW === null ? null : Number(EXPECT_COUNT_RAW)
/** 仅本地模拟器：显式允许**指向本机**的 http（远端 http 仍然拒绝）。 */
const ALLOW_HTTP_LOCAL = has('allow-http-local')

if (EXPECT_COUNT !== null) {
  if (!Number.isInteger(EXPECT_COUNT) || EXPECT_COUNT < 0) {
    fail(`--expect-count 必须是非负整数（实际给了 "${EXPECT_COUNT_RAW}"）。`)
  }
  if (EXPECT_SOURCE === null || String(EXPECT_SOURCE).trim() === '') {
    fail(
      '--expect-count 必须同时给 --expect-source（例如 "R2 控制台对象数 2026-10-10 15:04"）：\n' +
        '    数字是从哪来的必须写进产物 —— 否则它只是一句无法追溯的口头声明。',
    )
  }
  if (CONSOLE_FILE === null) {
    fail('--expect-count 只用于 --from-console（实时列举的完整性由"走完全部分页"自证，不需要人工数字）。')
  }
}
if (MAX_USED && COMPARE !== null) {
  fail(
    '--max（抽样）与 --compare（对账）不能一起用：抽样清单不能被当作全量清单去判断"对象是否消失"。\n' +
      '    需要对比就先跑一次全量（不加 --max）。',
  )
}

// ── ① 取清单：控制台导出（离线）或只读列举 ─────────────────────────────────
let objects
let source
let scope
let truncatedByMax = false
let identity = null

if (CONSOLE_FILE !== null) {
  /*
    控制台导出里没有 endpoint 信息，也看不出"导的是哪个桶" —— 而桶/前缀正是
    对比时唯一能证明"两份清单说的是同一个集合"的东西。所以这里要求显式声明。
  */
  if (BUCKET_ARG === null) {
    fail(
      '用 --from-console 时必须同时声明 --bucket <桶名>：\n' +
        '    导出文件里没有桶信息，而"对比两份清单"的前提就是它们说的是同一个桶/同一个前缀。',
    )
  }
  let parsed
  try {
    parsed = parseConsoleExport(readFileSync(resolve(ROOT, CONSOLE_FILE), 'utf8'), { label: CONSOLE_FILE })
  } catch (error) {
    if (error instanceof InventorySourceError) fail(`清单来源解析失败（${CONSOLE_FILE}）：${error.message}`, 8)
    fail(`读不到清单文件 ${CONSOLE_FILE}：${error?.message ?? error}`, 8)
  }
  const parsedObjects = parsed.objects
  const filtered = applyPrefixFilter(parsedObjects, PREFIX)
  objects = filtered
  source = `控制台导出 ${CONSOLE_FILE}（未连网，格式 ${parsed.format}）`
  scope = {
    method: 'console-export',
    endpointHost: null,
    bucket: BUCKET_ARG,
    prefix: PREFIX,
    prefixFilterApplied: PREFIX !== '',
  }
  /*
    控制台导出**没有**端点/账号信息 → 身份只能是"未知"或"操作者声明"。
    绝不猜（业主 Stage 13C.3 §B 3）。
  */
  identity = buildStorageIdentity({ method: 'console-export', endpointHost: null, declaredId: STORAGE_ID })
  if (identity.kind === 'unknown') {
    console.log(
      '  ⓘ 存储身份：未知（控制台导出不含账号/端点）。要与实时清单对比，请两次都加 `--storage-id <标签>`。',
    )
  } else {
    console.log(`  存储身份：操作者声明 "${identity.declaredId}"（可审计的对齐方式）`)
  }
  console.log(`  控制台导出：${parsed.format.toUpperCase()}，解析出 ${parsedObjects.length} 个对象`)
  if (PREFIX !== '') {
    console.log(`  前缀过滤："${PREFIX}" → 保留 ${filtered.length} 个（元数据与实际集合一致）`)
    if (filtered.length === 0) {
      fail(
        `声明的前缀 "${PREFIX}" 在导出里没有任何对象 —— 拒绝产出一份空清单（它会被误读成"这个前缀下没有文件"）。`,
      )
    }
    if (filtered.length === parsedObjects.length) {
      console.log('  ⓘ 说明：导出里的对象**全部**落在该前缀下 —— 这份导出本身可能就是一个前缀导出。')
    }
  } else if (parsedObjects.length > 0) {
    /*
      "看起来像子集"只是一句提醒，不是结论：没有 `--prefix` 时我们**无法**证明
      这份导出覆盖的是整桶。产物里仍然按"整桶"记录，而完整性由 --expect-count 决定。
    */
    const firstSegments = new Set(parsedObjects.map((o) => (o.key.includes('/') ? o.key.split('/')[0] : '(根目录)')))
    if (firstSegments.size === 1) {
      const only = [...firstSegments][0]
      console.log(
        `  ⓘ 提示：导出里的对象全部在 "${only}" 下 —— 如果它其实是一个前缀导出，请用 --prefix 声明范围，` +
          '否则元数据会把它说成整桶清单。',
      )
    }
  }
  if (MAX_USED) {
    if (objects.length > MAX) objects = objects.slice(0, MAX)
    /* 业主 Stage 13C.2 §一：**只要给了 --max 就不完整**，哪怕这次没截到、哪怕是空桶。 */
    truncatedByMax = true
  }

  // 预期数量核对：不一致**直接失败**，不产出可用于正式对账的完整清单。
  if (EXPECT_COUNT !== null && EXPECT_COUNT !== objects.length) {
    fail(
      `预期对象数与实际解析结果不一致：--expect-count ${EXPECT_COUNT}，解析出 ${objects.length}` +
        `${PREFIX === '' ? '（整桶）' : `（前缀 "${PREFIX}"）`}。\n` +
        '    不一致说明导出不完整或范围声明不对 —— 拒绝产出清单；请重新导出或核对 --prefix/--expect-count。',
      9,
    )
  }
} else {
  const config = resolveR2Config(process.env, { allowInsecureLocal: ALLOW_HTTP_LOCAL })
  if (!config.ok) fail(config.reason)
  if (config.insecureLocal) {
    console.warn(
      '⚠ 正在用 **http** 连接本机端点（--allow-http-local）。只读凭证会明文发送 —— 仅限本机模拟器，绝不要对生产使用。',
    )
  }
  try {
    const client = new S3Client({
      region: 'auto',
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    })
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
    objects = []
    let token
    let stoppedByMax = false
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          ...(PREFIX === '' ? {} : { Prefix: PREFIX }),
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      )
      for (const item of page.Contents ?? []) {
        objects.push({
          key: String(item.Key ?? ''),
          size: Number(item.Size ?? 0),
          lastModified:
            item.LastModified instanceof Date ? item.LastModified.toISOString() : String(item.LastModified ?? ''),
          etag: String(item.ETag ?? '').replaceAll('"', ''),
        })
        if (MAX_USED && objects.length >= MAX) {
          stoppedByMax = true
          break
        }
      }
      if (stoppedByMax) break
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined
    } while (token !== undefined)
    /*
      完整性判据只有一条：**把所有分页都走完了**，而且**没有用 --max**。
      业主 Stage 13C.2 §一：只要传了 `--max`，无论有没有触顶（空桶也一样），
      一律不完整 —— "这次刚好没截断"不能自证完整。
    */
    truncatedByMax = MAX_USED
    void stoppedByMax
  } catch (error) {
    fail(`列举对象失败：${error?.message ?? error}（endpoint=${config.redactedEndpoint} bucket=${config.bucket}）`, 3)
  }
  source = `ListObjectsV2 endpoint=${config.redactedEndpoint} bucket=${config.bucket}${PREFIX === '' ? '' : ` prefix=${PREFIX}`}`
  // 实时列举的 Prefix 由 S3 服务端执行（ListObjectsV2 的 Prefix 参数），所以集合本身就是该前缀的
  scope = {
    method: 'api-list',
    endpointHost: config.redactedEndpoint,
    bucket: config.bucket,
    prefix: PREFIX,
    prefixFilterApplied: PREFIX !== '',
  }
  /*
    身份 = `sha256(endpointHost|accessKeyId)` 的**指纹**（截断）—— 能唯一标识
    "哪个账号的哪个端点"，但不落 Access Key / Secret 原文。
  */
  identity = buildStorageIdentity({
    method: 'api-list',
    endpointHost: config.redactedEndpoint,
    accessKeyId: config.accessKeyId,
    declaredId: STORAGE_ID,
  })
  console.log(`  存储身份：${identity.fingerprint}${identity.declaredId === null ? '' : `（--storage-id "${identity.declaredId}"）`}`)
}

objects = objects.filter((o) => o.key !== '')
const summary = summarizeObjects(objects)
const completeness = {
  ...decideCompleteness({
    source: scope.method === 'console-export' ? 'console-export' : 'api-list',
    usedMax: MAX_USED,
    expectCount: EXPECT_COUNT,
    observedCount: objects.length,
  }),
  expectSource: EXPECT_COUNT === null ? null : String(EXPECT_SOURCE),
}
void truncatedByMax

console.log('对象存储清单（**只读**，没有任何写/删动作）')
console.log(`  来源：${source}`)
console.log(`  范围：bucket=${scope.bucket ?? '(未声明)'} prefix="${scope.prefix}" method=${scope.method}`)
console.log(`  对象数：${summary.count}`)
console.log(`  总字节：${summary.totalBytes}`)
console.log(
  `  完整性：${completeness.complete ? '完整（可用于正式对账）' : '★ 不完整（抽样/截断）—— 不可用于正式对账'}` +
    `（reason=${completeness.reason}）`,
)
if (!completeness.complete) {
  if (completeness.reason === 'truncated-by-max') {
    console.warn(
      '⚠ 用了 --max：这份清单是**抽样**，不是桶的全貌（哪怕这次没截到上限也一样）。\n' +
        '  它不能用来判断"某个对象是否消失"，也不能作为 G5（R2 对象清单）的通过证据。',
    )
  } else if (completeness.reason === 'console-export-unverified') {
    console.warn(
      '⚠ 控制台导出只证明"文件格式有效"，**不证明**它覆盖了整个桶/前缀。\n' +
        '  要用于正式对账，请补 `--expect-count <控制台显示的对象数> --expect-source <来源>`，\n' +
        '  让工具把预期数量与实际解析结果核对一遍（那时才会标 complete=true）。',
    )
  }
  console.warn(`  ${completeness.explanation ?? ''}`)
}
if (summary.prefixes.length > 0) {
  console.log('  前缀分布（前 10）：')
  for (const p of summary.prefixes.slice(0, 10)) console.log(`    ${p.prefix}  ${p.count} 个`)
}

// ── ② 对比（先核范围与完整性，再算差异） ────────────────────────────────────
let compareResult = null
if (COMPARE !== null) {
  let previous
  try {
    previous = JSON.parse(readFileSync(resolve(ROOT, COMPARE), 'utf8'))
  } catch (error) {
    fail(`读不到前一份清单 ${COMPARE}：${error?.message ?? error}`, 6)
  }
  /*
    当前清单同样要自洽（业主 Stage 13C.3 §C）：用与"前一份"**同一套**判据，
    避免"上游松、下游严"这种两头都不算错、合起来能放过的缝。
  */
  const currentArtifact = buildInventoryArtifact({ source, objects, scope, completeness, identity })
  const currentConsistent = assertArtifactSelfConsistent(currentArtifact)
  if (!currentConsistent.ok) {
    fail(`当前清单不能用于对账：${currentConsistent.reason}。`, 6)
  }
  const comparable = assertComparable(previous, {
    complete: completeness.complete,
    scope,
    storageIdentity: identity,
  })
  if (!comparable.ok) {
    /*
      退出码按 kind 选，不靠正则猜：
        7 = 范围不同或**存储身份不同**（"这两份说的不是同一个集合"）；
        6 = 其余（不是本工具产物 / 字段自相矛盾 / 不完整 / **身份无法确认**）。
    */
    const code = comparable.kind === 'scope' || comparable.kind === 'identity-mismatch' ? 7 : 6
    fail(`拒绝对比：${comparable.reason}`, code)
  }

  const prevKeys = new Set((previous.objects ?? []).map((o) => o.key))
  const nowKeys = new Set(objects.map((o) => o.key))
  const missing = [...prevKeys].filter((k) => !nowKeys.has(k))
  const added = [...nowKeys].filter((k) => !prevKeys.has(k))
  compareResult = {
    comparedWith: COMPARE,
    previousGeneratedAt: previous.generatedAt ?? null,
    scopeChecked: { bucket: scope.bucket, prefix: scope.prefix, endpointHost: scope.endpointHost },
    missingCount: missing.length,
    addedCount: added.length,
    missingSample: missing.slice(0, 20),
    addedSample: added.slice(0, 20),
  }
  console.log(`  对比（${COMPARE}）：消失 ${missing.length} 个 / 新增 ${added.length} 个`)
  if (missing.length > 0) {
    console.error('  ⚠ 有对象消失了 —— 这必须由人来判断（是不是被谁删了？），工具不替你下结论。')
  }
}

// ── ③ 产物 ──────────────────────────────────────────────────────────────────
if (OUT !== null) {
  const outPath = resolve(ROOT, OUT)
  if (existsSync(outPath) && !has('force')) {
    fail(`产物已存在，拒绝覆盖：${OUT}（确认要覆盖时加 --force）`, 4)
  }
  mkdirSync(dirname(outPath), { recursive: true })
  // 产物由纯函数构造（见 lib/r2-target.mjs）：它的入参里没有凭证，
  // 所以"清单里混进 secret"这种事在结构上就不可能发生。
  const artifact = buildInventoryArtifact({ source, objects, compare: compareResult, scope, completeness, identity })
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  console.log(
    `  已写入：${OUT}（只含 key/size/etag/时间与完整性标记，不含任何凭证；complete=${artifact.complete}）`,
  )
}

if (compareResult !== null && compareResult.missingCount > 0) process.exit(5)
