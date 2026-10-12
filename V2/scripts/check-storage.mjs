/**
 * scripts/check-storage.mjs —— 部署自检：存储到底配好没有
 * ============================================================================
 * 上线前跑一次，比"第一个老师上传失败之后才发现"便宜得多。
 *
 * 检查五件事：
 *   1. 配置齐不齐；
 *   2. 桶连不连得上；
 *   3. 桶的 CORS 里有没有通配符 origin；
 *   4. **当前实际部署的 Origin 在不在允许列表里**（← 2026-10-12 故障补的）；
 *   5. 浏览器直传需要的 AllowedMethods / AllowedHeaders 齐不齐。
 *
 * 第 4 条是本脚本与从前最大的区别：期望 Origin **必须由操作者给出**。
 * 脚本不读 `V2_PUBLIC_ORIGIN`、也不拿桶里已有的配置反推自己 ——
 * 两边同时停在旧域名时那种比对会一致地"通过"，而那正是这次故障的形状。
 * 没有给期望 Origin 时，脚本报 BLOCKED 并以退出码 2 结束，**不会静默判过**。
 *
 * 它**只读**：只 GetBucketCors，不写 CORS、不碰任何对象、不改环境变量。
 * 配置修复是另一件事，见 `scripts/configure-bucket-cors.mjs`（需单独授权）。
 *
 * 它**不会**打印任何凭据（§21）。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateBucketCors, normalizeOriginList } from './lib/cors-drift.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const { S3Client, GetBucketCorsCommand } = require('@aws-sdk/client-s3')
const { loadConfig } = require(join(ROOT, 'dist/server/config.js'))
const { S3StorageProvider } = require(join(ROOT, 'dist/server/storage/s3.provider.js'))
const { LocalStorageProvider } = require(join(ROOT, 'dist/server/storage/local.provider.js'))

/** 退出码：0 通过 · 1 检查未通过 · 2 BLOCKED（缺输入，无法判断）。 */
const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_BLOCKED = 2

/**
 * 解析命令行。
 *
 * `--base` 收的是**部署地址**（`verify.mjs --base` 用的是同一个含义），
 * 它的 Origin 会被取出来当期望值；`--expected-origin` 收 origin 本身。
 * 两个都可以重复，也支持逗号分隔。
 */
function parseArgs(argv) {
  const expected = []
  const bases = []
  const unknown = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const takeValue = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return null
      i += 1
      return value
    }
    if (arg === '--expected-origin') {
      const value = takeValue()
      if (value === null) unknown.push(arg)
      else expected.push(...value.split(','))
    } else if (arg === '--base') {
      const value = takeValue()
      if (value === null) unknown.push(arg)
      else bases.push(...value.split(','))
    } else if (arg === '--help' || arg === '-h') {
      unknown.push(arg)
    } else {
      unknown.push(arg)
    }
  }
  return { expected, bases, unknown }
}

const { expected: expectedArgs, bases, unknown } = parseArgs(process.argv.slice(2))

if (unknown.length > 0 && !unknown.includes('--help') && !unknown.includes('-h')) {
  console.error(`✖ 无法识别的参数：${unknown.join(' ')}`)
  console.error('  用法：node scripts/check-storage.mjs --base https://你的部署域名')
  console.error('        node scripts/check-storage.mjs --expected-origin https://你的域名')
  process.exit(EXIT_FAILED)
}

if (unknown.includes('--help') || unknown.includes('-h')) {
  console.log('用法：node scripts/check-storage.mjs --base https://你的部署域名')
  console.log('      node scripts/check-storage.mjs --expected-origin https://你的域名 [--expected-origin ...]')
  console.log('')
  console.log('  --base             部署地址；取它的 Origin 作为期望值（与 verify.mjs --base 同义）')
  console.log('  --expected-origin  直接给 Origin；可重复或逗号分隔')
  console.log('')
  console.log('两个都不给 → BLOCKED（退出码 2）。期望 Origin 必须显式给出：')
  console.log('从桶里读、或用 V2_PUBLIC_ORIGIN 反推，都无法发现"两边都停在旧域名"。')
  process.exit(EXIT_OK)
}

const config = loadConfig()
const provider = config.storage.provider === 's3' ? new S3StorageProvider() : new LocalStorageProvider()
const health = await provider.health()

console.log(`驱动：${health.provider}`)
console.log(`已配置：${health.configured ? '是' : '否'}`)
console.log(`可访问：${health.reachable ? '是' : '否'}`)
console.log(`说明：${health.detail}`)

let bad = !health.configured || !health.reachable

// 本地驱动没有桶，也就没有 CORS 这回事。
if (config.storage.provider !== 's3') {
  console.log('CORS：不适用（当前驱动不是 s3）')
  process.exitCode = bad ? EXIT_FAILED : EXIT_OK
} else if (!health.reachable) {
  // 桶都连不上，CORS 无从谈起 —— 不再假装检查过。
  console.error('✖ 读不到桶的 CORS：存储不可访问。')
  process.exitCode = EXIT_FAILED
} else {
  const client = new S3Client({
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: { accessKeyId: config.storage.accessKey, secretAccessKey: config.storage.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })

  let policy = null
  let corsReadable = true
  try {
    policy = await client.send(new GetBucketCorsCommand({ Bucket: config.storage.bucket }))
  } catch (error) {
    corsReadable = false
    bad = true
    if (error.name === 'NoSuchCORSConfiguration') {
      console.error('✖ 桶上还没有 CORS 配置 —— 浏览器直传会被浏览器拦掉。')
      console.error('  修复（需单独授权）：V2_PUBLIC_ORIGIN=https://你的域名 node scripts/configure-bucket-cors.mjs')
    } else {
      console.error(`✖ 读 CORS 失败：${error.message}`)
    }
  }

  if (corsReadable) {
    const listed = (policy.CORSRules ?? [])
      .flatMap((rule) => rule.AllowedOrigins ?? [])
      .map((o) => String(o).trim())
      .filter((o) => o !== '')
    console.log(`CORS：${listed.join(', ') || '（空）'}`)

    // ── 期望 Origin：只认操作者给的输入 ──────────────────────────────────
    const { origins: fromBases, invalid: invalidBases } = normalizeOriginList(bases)
    const { origins: fromArgs, invalid: invalidExpected } = normalizeOriginList(expectedArgs)
    const expected = [...new Set([...fromBases, ...fromArgs])]

    for (const value of invalidBases) {
      console.error(`✖ --base 不是合法的 http(s) 地址：${value}`)
      bad = true
    }
    for (const value of invalidExpected) {
      console.error(`✖ --expected-origin 不是合法的 http(s) Origin：${value}`)
      bad = true
    }

    if (expected.length === 0) {
      // 关键：没有期望值就**不能判过**。从前这里会拿桶里的配置自证清白，
      // 于是"两个域名都停在旧的"这种情况永远检查不出来。
      console.error('')
      console.error('⏭ BLOCKED：没有提供期望 Origin，无法判断 CORS 是否与当前部署一致。')
      console.error('  本检查不从桶里读、也不用 V2_PUBLIC_ORIGIN 当期望值 ——')
      console.error('  两边同时停在旧域名时那种比对会一致地"通过"，正是 2026-10-12 故障的形状。')
      console.error('  用法：--base https://你的部署域名   或   --expected-origin https://你的域名')
      process.exitCode = EXIT_BLOCKED
    } else {
      console.log(`期望 Origin：${expected.join(', ')}${fromBases.length > 0 ? '（来自 --base）' : ''}`)

      const result = evaluateBucketCors(policy, expected)
      for (const problem of result.problems) console.error(`✖ ${problem}`)

      if (result.unauthorizedOrigins.length > 0) {
        // 只报告，不判失败：这些可能是别的环境仍在用的来源，
        // 擅自判失败会逼人删掉还在用的东西。
        console.log('')
        console.log(`ℹ 允许列表里还有这些来源：${result.unauthorizedOrigins.join(', ')}`)
        console.log('  不在本次期望范围内 —— 请核实是否仍在使用；确认无用后再单独授权移除。')
      }

      if (result.problems.length > 0) {
        bad = true
        console.error('')
        console.error('  修复（需单独授权，本脚本不会自己改）：')
        console.error(
          `    V2_PUBLIC_ORIGIN=${expected.join(',')} node scripts/configure-bucket-cors.mjs`,
        )
        console.error('  改完再跑一次本检查。')
      } else if (!bad) {
        console.log(`✅ CORS 与当前部署一致（Origin / AllowedMethods / AllowedHeaders 均符合）`)
      }

      process.exitCode = bad ? EXIT_FAILED : EXIT_OK
    }
  } else {
    process.exitCode = EXIT_FAILED
  }
}

// 上一段可能已经设过 BLOCKED(2)，这里只在还没定且确实失败时兜底成 1。
if (process.exitCode === undefined) process.exitCode = bad ? EXIT_FAILED : EXIT_OK
