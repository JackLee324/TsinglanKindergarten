/**
 * scripts/fetch-storage-backend.mjs —— 取回**真实的** S3 兼容后端（SeaweedFS）
 * ============================================================================
 * 为什么需要一个真后端，而不是 mock：
 *
 * 阶段 6 的核心承诺是"浏览器拿 presigned URL 直传对象存储，服务端再校验对象真的存在"。
 * 这条链路上最容易出错、也最不能靠 mock 证明的东西是 **AWS SigV4 签名** ——
 * 签名错了在 mock 里永远测不出来（mock 通常不验签），上线才会 403。
 * 所以测试必须打到一个**独立实现**的 S3 服务上：它自己会验签，
 * 签名错了 / 过期了 / 篡改了 object key，都会被真正的服务拒绝。
 *
 * 为什么是 SeaweedFS：
 *   · 它有真正的 S3 API 网关，并且强制 SigV4（用 `-s3.config` 配 accessKey/secretKey）；
 *   · 单个 Go 二进制，macOS / Linux 都直接跑，不需要 Docker。
 *   （MinIO 的开源服务端已归档、官方不再分发，所以不能用它。）
 *
 * 本脚本是**幂等**的：已经有了就直接退出，不会每次测试都重新下载。
 * 二进制放在 `.devtools/`（已 gitignore），不进仓库。
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEVTOOLS = join(ROOT, '.devtools')
const TARGET_DIR = join(DEVTOOLS, 'seaweedfs')
const BINARY = join(TARGET_DIR, 'weed')

/** 固定的版本：测试要可复现，不能"今天拉到什么就是什么"。 */
const VERSION = '4.48'
const PLATFORM = (() => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  return `${os}_${arch}`
})()
// 资产名就是平台名，没有前缀（`darwin_arm64.tar.gz`）。
// 第一版写成 `seaweedfs_${PLATFORM}.tar.gz` → 404，猜名字是错的，要看 release 资产列表。
const ARCHIVE = `${PLATFORM}.tar.gz`
const BASE = `https://github.com/seaweedfs/seaweedfs/releases/download/${VERSION}`
const URL = `${BASE}/${ARCHIVE}`
const MD5_URL = `${URL}.md5`

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}：${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function alreadyInstalled() {
  if (!existsSync(BINARY)) return false
  try {
    const out = execFileSync(BINARY, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return /\d+\.\d+/.test(out)
  } catch {
    return false
  }
}

async function main() {
  const force = process.argv.includes('--force')
  if (!force && alreadyInstalled()) {
    console.log(`✔ S3 测试后端已就绪：${BINARY}`)
    return
  }

  mkdirSync(TARGET_DIR, { recursive: true })
  console.log(`> 下载 SeaweedFS ${VERSION}（${PLATFORM}）…`)
  const archive = await download(URL)

  // 官方随每个 asset 发布 .md5。它挡不住恶意镜像，但能挡住下载损坏 ——
  // 一个截断的 tar.gz 会在解压时报出很难懂的错误。
  try {
    const md5 = (await download(MD5_URL)).toString('utf8').trim().split(/\s+/)[0].toLowerCase()
    const actual = createHash('md5').update(archive).digest('hex')
    if (md5 !== actual) {
      throw new Error(`校验和不符：期望 ${md5}，实际 ${actual}`)
    }
    console.log('  ✔ md5 校验通过')
  } catch (error) {
    if (String(error.message).includes('校验和不符')) throw error
    console.log(`  ⚠ 拿不到官方 md5（${error.message}），跳过校验`)
  }

  const tarball = join(TARGET_DIR, ARCHIVE)
  writeFileSync(tarball, archive)
  // 用系统 tar 解包：Node 没有内置 tar，而这个脚本本来就不是零依赖场景。
  execFileSync('tar', ['-xzf', ARCHIVE, 'weed'], { cwd: TARGET_DIR, stdio: 'inherit' })
  rmSync(tarball, { force: true })
  chmodSync(BINARY, 0o755)

  const version = execFileSync(BINARY, ['version'], { encoding: 'utf8' })
  if (!/\d+\.\d+/.test(version)) {
    throw new Error(`拿到的二进制跑不起来：${version}`)
  }
  writeFileSync(join(TARGET_DIR, 'VERSION'), `${VERSION}\n`)
  console.log(`✔ S3 测试后端已安装：${BINARY}`)
  console.log(`  ${version.trim().split('\n')[0]}`)
}

main().catch((error) => {
  console.error(`\n✖ 无法准备 S3 测试后端：${error.message}`)
  console.error(`  手工下载：${URL} → 解出 weed 放到 ${TARGET_DIR}/`)
  console.error('  （阶段 6 的对象存储集成测试打的是真后端，没有它就不能算通过。）')
  process.exit(1)
})

export { BINARY, TARGET_DIR, VERSION }
