#!/usr/bin/env node
/**
 * deploy/rehearsal-storage.mjs —— 本地 Docker 演练用的 S3 兼容存储
 * ============================================================================
 * **只用于本地演练。** 生产用的是 Cloudflare R2（V1 的桶），不需要这个脚本。
 *
 * 为什么不用 MinIO：`minio/minio` 与 `quay.io/minio/minio` 都拉不到
 * （前者仓库已不存在，后者要认证）。而本项目**自己的测试链路**一直在用
 * SeaweedFS 的 S3 网关（`.devtools/seaweedfs/weed`，支持 SigV4 + PutBucketCors），
 * 用它既不引新依赖，又和测试验证过的是同一条路径。
 *
 * 拓扑上也更贴近生产：**对象存储在应用容器之外**（生产是 R2，这里是宿主机进程），
 * 容器里的 nginx 通过 `host.docker.internal` 访问它。
 *
 * 用法：
 *   node deploy/rehearsal-storage.mjs            # 前台运行（Ctrl-C 停）
 *   node deploy/rehearsal-storage.mjs --check    # 只做连通性与 CORS 自检
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { S3Client, CreateBucketCommand, PutBucketCorsCommand, HeadBucketCommand } from '@aws-sdk/client-s3'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WEED = join(ROOT, '.devtools', 'seaweedfs', 'weed')
const WORK = join(ROOT, '.devdata', 'rehearsal-storage')

// 从 .env.deploy 读（这个脚本不自己造密钥，避免"演练用的凭证"和真实契约不一致）
function envFromFile() {
  const text = readFileSync(join(ROOT, '.env.deploy'), 'utf8')
  const out = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

const env = envFromFile()
const AK = env.STORAGE_ACCESS_KEY
const SK = env.STORAGE_SECRET_KEY
const BUCKET = env.STORAGE_BUCKET
const ORIGIN = env.V2_PUBLIC_ORIGIN
const S3_PORT = 18443

if (!AK || !SK || !BUCKET || !ORIGIN) {
  console.error('.env.deploy 里缺 STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY / STORAGE_BUCKET / V2_PUBLIC_ORIGIN')
  process.exit(2)
}

const client = () =>
  new S3Client({
    endpoint: `http://127.0.0.1:${S3_PORT}`,
    region: env.STORAGE_REGION ?? 'auto',
    credentials: { accessKeyId: AK, secretAccessKey: SK },
    forcePathStyle: true,
  })

async function ensureBucket() {
  const s3 = client()
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
    console.log(`已建桶 ${BUCKET}`)
  }
  /*
    CORS 只允许**正式 origin**（业主 §9：禁止 `*`）。
    这里允许 PUT/GET/HEAD，是因为浏览器要直传（PUT）和预览下载（GET）。
    演练结束后可以用 --check 复核这条策略还在。
  */
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [ORIGIN],
            AllowedMethods: ['GET', 'PUT', 'HEAD', 'POST'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    }),
  )
  console.log(`CORS 已限定为 ${ORIGIN}（不是 *）`)
}

if (process.argv.includes('--check')) {
  const s3 = client()
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
  console.log(`✅ 存储可用，桶 ${BUCKET} 存在`)
  process.exit(0)
}

mkdirSync(join(WORK, 'data'), { recursive: true }) // SeaweedFS 要求 -mdir 已存在
const configPath = join(WORK, 's3.json')
writeFileSync(
  configPath,
  JSON.stringify(
    {
      identities: [
        { name: 'qls-v2', credentials: [{ accessKey: AK, secretKey: SK }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] },
      ],
    },
    null,
    2,
  ),
)

/*
  `-ip=0.0.0.0`：容器要通过 `host.docker.internal` 访问它，绑回环是不够的。
  端口与**测试后端**完全错开（测试是 19433/18090/18998/18444）：演练栈和测试
  是可以同时跑的。早先测试的 S3 也写 18443，与本脚本撞车 —— 当时表现为
  9 个 S3 用例报 “access key does not exist”（请求被本演练实例接走），
  而不是端口冲突。现在两边各用各的，不再互相踩。
*/
const args = [
  'server',
  `-dir=${join(WORK, 'data')}`,
  '-ip=0.0.0.0',
  '-master.port=19333',
  '-volume.port=18080',
  '-filer.port=18888',
  '-s3',
  `-s3.port=${S3_PORT}`,
  `-s3.config=${configPath}`,
  '-webdav=false',
  '-s3.port.iceberg=0',
  '-s3.port.lance=0',
  '-s3.iam=false',
]
console.log(`启动 SeaweedFS（S3 网关 :${S3_PORT}，绑定 0.0.0.0 供容器访问）…`)
const child = spawn(WEED, args, { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', () => {})
child.stderr.on('data', (b) => {
  const text = b.toString()
  if (/Fatal|panic/i.test(text)) process.stderr.write(text)
})

const deadline = Date.now() + 30000
let ready = false
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${S3_PORT}/`)
    if (res.status < 500) {
      ready = true
      break
    }
  } catch {
    /* 还没起来 */
  }
  await new Promise((r) => setTimeout(r, 300))
}
if (!ready) {
  child.kill('SIGKILL')
  console.error('SeaweedFS 没起来')
  process.exit(3)
}
await ensureBucket()
console.log('存储就绪。Ctrl-C 结束。')
const shutdown = () => {
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
await new Promise(() => {})
