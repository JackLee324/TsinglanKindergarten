/**
 * scripts/configure-bucket-cors.mjs —— 把 CORS 策略写进桶（业主 §37）
 * ============================================================================
 * 浏览器直传要跨域，所以桶必须配 CORS。这个策略**不是**可选的部署细节：
 * 配错了表现为"上传到 100% 然后失败"，而且浏览器只给一句
 * "CORS policy" —— 不配或者配成 `*` 都会留下隐患。
 *
 * 用法：
 *   STORAGE_PROVIDER=s3 STORAGE_ENDPOINT=… STORAGE_BUCKET=… \
 *   STORAGE_ACCESS_KEY=… STORAGE_SECRET_KEY=… \
 *   V2_PUBLIC_ORIGIN=https://v2.example.com \
 *   node scripts/configure-bucket-cors.mjs
 *
 *   node scripts/configure-bucket-cors.mjs --show     # 只读当前的策略
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3')
const { loadConfig } = require(join(ROOT, 'dist/server/config.js'))
const { buildBucketCorsPolicy, corsPolicyHasWildcard } = require(join(ROOT, 'dist/server/storage/s3.provider.js'))

const config = loadConfig()
if (config.storage.provider !== 's3') {
  console.error('✖ 当前 STORAGE_PROVIDER 不是 s3，没有桶可以配置。')
  process.exit(1)
}

// origin 只从环境变量读：绝不允许写死，也不允许"没配就用 *"。
const origins = (process.env.V2_PUBLIC_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

const client = new S3Client({
  endpoint: config.storage.endpoint,
  region: config.storage.region,
  forcePathStyle: config.storage.forcePathStyle,
  credentials: { accessKeyId: config.storage.accessKey, secretAccessKey: config.storage.secretKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

const bucket = config.storage.bucket

if (process.argv.includes('--show')) {
  try {
    const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }))
    console.log(JSON.stringify(current.CORSRules, null, 2))
    if (corsPolicyHasWildcard(current)) {
      console.error('\n✖ 当前策略里有通配符 origin —— 应当改成具体的正式域名。')
      process.exitCode = 1
    }
  } catch (error) {
    if (error.name === 'NoSuchCORSConfiguration') console.log('（桶上还没有 CORS 配置）')
    else throw error
  }
} else {
  if (origins.length === 0) {
    console.error('✖ 请通过 V2_PUBLIC_ORIGIN 指定正式 origin（可以给多个，用逗号分隔）。')
    console.error('  例：V2_PUBLIC_ORIGIN=https://v2.example.com node scripts/configure-bucket-cors.mjs')
    process.exit(1)
  }
  const policy = buildBucketCorsPolicy(origins)
  await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: policy }))
  console.log(`✔ 已写入 CORS：${origins.join(', ')}`)
  console.log('  允许的方法：PUT / GET / HEAD（浏览器直传只需要这三种）')
}
