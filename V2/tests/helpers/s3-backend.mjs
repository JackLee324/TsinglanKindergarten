/**
 * tests/helpers/s3-backend.mjs —— 测试用的**真实** S3 兼容后端
 * ============================================================================
 * 阶段 6 的存储测试不打 mock。原因很直接：mock 通常**不验签**，
 * 而这一阶段最容易错、后果最重的一件事就是 SigV4 预签名 ——
 * 签名错了在 mock 里永远是绿的，上线第一个上传就 403。
 *
 * 所以这里起一个真的 S3 服务（SeaweedFS 的 S3 网关，二进制由
 * `scripts/fetch-storage-backend.mjs` 取回），它会：
 *   · 强制校验 SigV4（access key / secret key 配在 `-s3.config` 里）；
 *   · 对错误签名、过期签名、篡改 object key 一律 403；
 *   · 支持 PutBucketCors，于是我们可以真的验证 CORS 策略本身。
 *
 * 端口单独一套（不碰开发/测试用的其它端口），进程在 `stop()` 时真的收掉。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3'
import { ROOT, sleep } from './harness.mjs'

const WEED = join(ROOT, '.devtools', 'seaweedfs', 'weed')

/** 测试用的固定凭据（只存在于测试进程；生产凭据走环境变量，不进日志）。 */
export const S3_TEST_ACCESS_KEY = 'v2testaccesskey'
export const S3_TEST_SECRET_KEY = 'v2testsecretkey'

/**
 * 专用端口：避开开发 3300 / 测试 3311 / 手工探针 3320 / Vite 3400。
 *
 * ⚠️ `s3` 用的是 18444，**不是** 18443 —— 18443 是 `deploy/rehearsal-storage.mjs`
 * （线上演练栈的存储后端）的端口。两者**不能共用**：演练栈的 weed 还在跑时，
 * 测试自己的网关会 bind 失败，而请求会被**演练栈那个实例**接走，
 * 于是签名凭据对不上、报 “The access key ID you provided does not exist in our records.”
 * —— 看起来像签名写错了，其实是打到了别人的服务上（实测踩过：9 个 S3 用例全红）。
 */
const PORTS = {
  master: 19433,
  volume: 18090,
  filer: 18998,
  s3: 18444,
}

export const S3_TEST_ENDPOINT = `http://127.0.0.1:${PORTS.s3}`

export function s3TestClient(overrides = {}) {
  return new S3Client({
    endpoint: S3_TEST_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: S3_TEST_ACCESS_KEY,
      secretAccessKey: S3_TEST_SECRET_KEY,
    },
    // ⚠️ 必须关掉 SDK 的"默认校验和"。
    // 新版 SDK 会给每个请求注入 `x-amz-checksum-crc32`；预签名时 body 还不知道，
    // 于是 URL 里被写进**空 body 的 CRC32**，真上传时真服务端算出真实 CRC32 不符，
    // 直接 BadDigest 400。这个坑实测过（见 docs/STORAGE.md）。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...overrides,
  })
}

/**
 * 起一个 S3 后端并建好桶。
 * @returns {{endpoint:string, bucket:string, stop:()=>Promise<void>, dataDir:string}}
 */
/**
 * 端口必须先确认是空的。
 *
 * 与阶段 3 那次"旧服务占着测试端口 → 所有断言跑在旧代码上"是同一类事故，
 * 只是主角换成了存储后端。旧实例还在监听时，新的 weed 会
 * `bind: address already in use` 然后 Fatal 退出，而请求却会被**旧实例**接走 ——
 * 于是测试打的是一个上一轮的桶，看起来还全绿。
 */
async function assertPortsFree() {
  const busy = []
  for (const [name, port] of Object.entries(PORTS)) {
    const free = await isPortFreeEverywhere(port)
    if (!free) busy.push(`${name}(${port})`)
  }
  if (busy.length > 0) {
    throw new Error(
      `S3 测试后端要用的端口被占用：${busy.join('、')}。\n` +
        '  常见原因：上一次的 weed 没退干净（pkill -9 -f "weed server"），\n' +
        '  或者线上演练栈的存储后端还在跑（deploy/rehearsal-storage.mjs）。\n' +
        '  两者**不能同时**跑同一套端口 —— 否则请求会打到别人的实例上，\n' +
        '  表现为凭据对不上的 403，而不是端口冲突。',
    )
  }
}

/**
 * 端口占用检测必须**同时**探 IPv4 和 IPv6。
 *
 * 只 `listen('127.0.0.1')` 是不够的：别的进程若绑的是 IPv6 通配 `*:port`
 * （SeaweedFS 就是这样），IPv4 这一侧仍然能 bind 成功 —— 检测就说"空闲"，
 * 而实际请求可能落到那个已经是别人的实例上。这一条正是上面那次 9 连红的成因，
 * 所以两个地址族都要探。
 */
function isPortFree(host, port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

async function isPortFreeEverywhere(port) {
  for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) {
    if (!(await isPortFree(host, port))) return false
  }
  return true
}

export async function startS3Backend({ bucket = `v2test-${randomUUID().slice(0, 8)}` } = {}) {
  await assertPortsFree()
  const workDir = join(ROOT, '.devdata', `s3backend-${randomUUID().slice(0, 8)}`)
  const dataDir = join(workDir, 'data')
  mkdirSync(dataDir, { recursive: true })

  const configPath = join(workDir, 's3.json')
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        identities: [
          {
            name: 'v2test',
            credentials: [
              { accessKey: S3_TEST_ACCESS_KEY, secretKey: S3_TEST_SECRET_KEY },
            ],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
        ],
      },
      null,
      2,
    ),
  )

  const args = [
    'server',
    `-dir=${dataDir}`,
    `-ip=127.0.0.1`,
    `-master.port=${PORTS.master}`,
    `-volume.port=${PORTS.volume}`,
    `-filer.port=${PORTS.filer}`,
    `-s3`,
    `-s3.port=${PORTS.s3}`,
    `-s3.config=${configPath}`,
    '-webdav=false',
    // SeaweedFS 4.x 起，`-s3` 还会顺带拉起一个 Iceberg REST Catalog（默认 8181 端口），
    // 它起不来会让整个进程 Fatal 退出。我们只要 S3 网关，所以显式关掉它。
    '-s3.port.iceberg=0',
    // …还有个 Lance Namespace 监听（默认 9101），同样会 Fatal 退出。一起关掉。
    '-s3.port.lance=0',
    '-s3.iam=false',
  ]
  const child = spawn(WEED, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (b) => (log += b.toString()))
  child.stderr.on('data', (b) => (log += b.toString()))

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      const deadline = Date.now() + 10000
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await sleep(50)
      }
    }
    rmSync(workDir, { recursive: true, force: true })
  }

  try {
    await waitForS3()
  } catch (error) {
    await stop()
    throw new Error(
      `S3 测试后端没能起来：${error.message}\n` +
        `  二进制：${WEED}（缺了就运行 \`npm run devtools:storage\`）\n` +
        `  关键日志：\n${fatalLines(log)}`,
    )
  }

  const client = s3TestClient()
  await client.send(new CreateBucketCommand({ Bucket: bucket }))

  return { endpoint: S3_TEST_ENDPOINT, bucket, stop, dataDir, log: () => log }
}

/** 从 weed 的日志里挑出真正说明问题的行（Fatal / panic / bind 失败）。 */
function fatalLines(log) {
  const lines = log
    .split('\n')
    .filter((l) => /Fatal|fatal|panic|bind: address already|listen tcp/.test(l))
    .slice(0, 6)
  return (lines.length > 0 ? lines : log.split('\n').slice(-8)).join('\n')
}

/**
 * 等待 S3 网关开始强制鉴权。
 *
 * ⚠️ 不能只等端口打开：SeaweedFS 的 master / volume / filer 会先起来，
 * S3 网关晚一步。**未加签名的请求收到 403** 才是"S3 网关已就绪并且真的在验签"的信号 ——
 * 这正是我们要测的那个东西。
 */
async function waitForS3() {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${S3_TEST_ENDPOINT}/`, { method: 'GET' })
      if (res.status === 403) return
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('等 S3 网关就绪超时（未签名请求没有返回 403）')
}
