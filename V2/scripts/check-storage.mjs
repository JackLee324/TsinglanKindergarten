/**
 * scripts/check-storage.mjs —— 部署自检：存储到底配好没有
 * ============================================================================
 * 上线前跑一次，比"第一个老师上传失败之后才发现"便宜得多。
 * 三件事：配置齐不齐、桶连不连得上、桶的 CORS 是不是通配符。
 *
 * 它**不会**打印任何凭据（§21）。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const { S3Client, GetBucketCorsCommand } = require('@aws-sdk/client-s3')
const { loadConfig } = require(join(ROOT, 'dist/server/config.js'))
const { S3StorageProvider, corsPolicyHasWildcard } = require(join(ROOT, 'dist/server/storage/s3.provider.js'))
const { LocalStorageProvider } = require(join(ROOT, 'dist/server/storage/local.provider.js'))

const config = loadConfig()
const provider = config.storage.provider === 's3' ? new S3StorageProvider() : new LocalStorageProvider()
const health = await provider.health()

console.log(`驱动：${health.provider}`)
console.log(`已配置：${health.configured ? '是' : '否'}`)
console.log(`可访问：${health.reachable ? '是' : '否'}`)
console.log(`说明：${health.detail}`)

let bad = !health.configured || !health.reachable

if (config.storage.provider === 's3' && health.reachable) {
  const client = new S3Client({
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    forcePathStyle: config.storage.forcePathStyle,
    credentials: { accessKeyId: config.storage.accessKey, secretAccessKey: config.storage.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  try {
    const cors = await client.send(new GetBucketCorsCommand({ Bucket: config.storage.bucket }))
    if (corsPolicyHasWildcard(cors)) {
      console.error('✖ 桶的 CORS 里出现了通配符 origin —— 浏览器直传不需要把门开到最大。')
      bad = true
    } else {
      console.log(`CORS：${(cors.CORSRules ?? []).flatMap((r) => r.AllowedOrigins ?? []).join(', ') || '（空）'}`)
    }
  } catch (error) {
    if (error.name === 'NoSuchCORSConfiguration') {
      console.error('✖ 桶上还没有 CORS 配置 —— 浏览器直传会被浏览器拦掉。')
      console.error('  运行：V2_PUBLIC_ORIGIN=https://你的域名 node scripts/configure-bucket-cors.mjs')
      bad = true
    } else {
      console.error(`✖ 读 CORS 失败：${error.message}`)
      bad = true
    }
  }
}

process.exitCode = bad ? 1 : 0
