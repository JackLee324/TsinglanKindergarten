#!/usr/bin/env node
/**
 * deploy/rehearsal-tls.mjs —— 生成本地演练用的**开发 CA + 站点证书**
 * ============================================================================
 * 为什么需要它：演练环境的自签证书**不能**被浏览器信任，于是会出现两个后果 ——
 *   1. 地址栏一直显示"不安全"；
 *   2. 更麻烦的是**跨域直传**：上传的字节是浏览器直传到**另一个 origin**
 *      （`s3.localhost`）的，那个 origin 的证书要**各自**信任；被 TLS 拦下时
 *      跨域子请求**不会弹警告页**，只让 `fetch` 抛错，界面显示成"网络中断"。
 *      （2026-10-09 实际踩到过，见 docs/UPLOAD_STORAGE_FIX_REPORT.md §8。）
 *
 * 做法：生成一个**本地开发 CA**，用它签发覆盖两个 host 的叶子证书；
 * 你把这个 CA 加入 macOS 信任库一次，之后所有浏览器都不再报警告。
 * 生产（Zeabur + R2）**不需要**这些：那里的证书由受信任 CA 签发。
 *
 * 用法：
 *   node deploy/rehearsal-tls.mjs            # 生成（已存在则拒绝覆盖，防误换 CA）
 *   node deploy/rehearsal-tls.mjs --force    # 重新生成（会让已安装的旧 CA 失效）
 *
 * 产物（deploy/tls/，全部 gitignored）：
 *   ca.pem        开发 CA 证书      —— 要加入信任库的就是它
 *   ca-key.pem    CA 私钥（0600）   —— 只留在本机，别外传
 *   privkey.pem   叶子私钥（0600）
 *   fullchain.pem 叶子证书 + CA 证书（nginx 用）
 *
 * 为什么用 openssl 命令行而不是纯 Node：Node 没有签发 X.509 的内置 API，
 * 而 openssl 是 macOS/Linux 都有的标准工具，命令都在下面，谁都看得见。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TLS_DIR = join(ROOT, 'deploy', 'tls')
const FORCE = process.argv.includes('--force')

/** 演练要覆盖的主机名：应用 + 对象存储（+ 本机回环，方便直接用 IP 访问）。 */
const HOSTS = ['v2.localhost', 's3.localhost', 'localhost']
const IPS = ['127.0.0.1']

const CA_CRT = join(TLS_DIR, 'ca.pem')
const CA_KEY = join(TLS_DIR, 'ca-key.pem')
const LEAF_KEY = join(TLS_DIR, 'privkey.pem')
const LEAF_CRT = join(TLS_DIR, 'fullchain.pem')

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

mkdirSync(TLS_DIR, { recursive: true })

if (existsSync(CA_CRT) && !FORCE) {
  console.error(
    `已存在 ${CA_CRT} —— 不覆盖。\n` +
      '  · 想继续用现有的：直接按下面提示把它加入信任库即可；\n' +
      '  · 确实要换一张新 CA：加 --force（换完**必须**重新在信任库里删掉旧的、装上新的）。',
  )
  console.error(trustInstructions())
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'qls-tls-'))
try {
  // ── CA ───────────────────────────────────────────────────────────────────
  const caCnf = join(work, 'ca.cnf')
  writeFileSync(
    caCnf,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = v3_ca',
      'prompt = no',
      '[dn]',
      'CN = QLS V2 Rehearsal Dev CA',
      'O = QLS V2 rehearsal (dev only)',
      '[v3_ca]',
      'basicConstraints = critical, CA:TRUE',
      'keyUsage = critical, keyCertSign, cRLSign',
      'subjectKeyIdentifier = hash',
      '',
    ].join('\n'),
  )
  sh('openssl', ['genrsa', '-out', CA_KEY, '4096'])
  sh('openssl', ['req', '-x509', '-new', '-key', CA_KEY, '-sha256', '-days', '3650', '-config', caCnf, '-out', CA_CRT])

  // ── 叶子证书（SAN 覆盖两个 host + 回环）──────────────────────────────────
  const leafKeyTmp = join(work, 'leaf.key')
  const csr = join(work, 'leaf.csr')
  const leafCnf = join(work, 'leaf.cnf')
  writeFileSync(
    leafCnf,
    [
      '[v3_leaf]',
      'basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectKeyIdentifier = hash',
      `subjectAltName = ${[...HOSTS.map((h) => `DNS:${h}`), ...IPS.map((i) => `IP:${i}`)].join(', ')}`,
      '',
    ].join('\n'),
  )
  const subj = `/CN=${HOSTS[0]}/O=QLS V2 rehearsal`
  sh('openssl', ['genrsa', '-out', leafKeyTmp, '2048'])
  sh('openssl', ['req', '-new', '-key', leafKeyTmp, '-subj', subj, '-out', csr])
  // 397 天：即使将来某些浏览器策略收紧（对公开 CA 的 398 天上限），也不会踩线
  sh('openssl', [
    'x509', '-req', '-in', csr, '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial',
    '-out', join(work, 'leaf.pem'), '-days', '397', '-sha256', '-extfile', leafCnf, '-extensions', 'v3_leaf',
  ])

  writeFileSync(LEAF_CRT, `${readFileSync(join(work, 'leaf.pem'), 'utf8')}${readFileSync(CA_CRT, 'utf8')}`)
  writeFileSync(LEAF_KEY, readFileSync(leafKeyTmp))
  chmodSync(LEAF_KEY, 0o600)
  chmodSync(CA_KEY, 0o600)
  chmodSync(CA_CRT, 0o644)
  chmodSync(LEAF_CRT, 0o644)

  // ── 自检：链能不能验过、主机名对不对 ─────────────────────────────────────
  sh('openssl', ['verify', '-CAfile', CA_CRT, join(work, 'leaf.pem')])
  const san = sh('openssl', ['x509', '-in', LEAF_CRT, '-noout', '-text']).match(/Subject Alternative Name:[\s\S]*?\n\s*\n/)
  console.log('✔ 已生成开发 CA 与站点证书（链校验通过）')
  console.log(`  CA      ${CA_CRT}`)
  console.log(`  叶子    ${LEAF_CRT}`)
  console.log(`  私钥    ${LEAF_KEY} / ${CA_KEY}（0600，已被 .gitignore 挡住）`)
  console.log(`  SAN     ${san ? san[0].split('\n').filter((l) => l.includes('DNS') || l.includes('IP')).join(' ').trim() : '(未解析)'}`)
  console.log('\n' + trustInstructions())
} finally {
  rmSync(work, { recursive: true, force: true })
}

function trustInstructions() {
  return [
    '接下来（只需要做一次）：把开发 CA 加入 macOS 信任库 —— 请你自己在终端执行，',
    '这条命令需要你的管理员口令，我不会索取：',
    '',
    `  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CA_CRT}`,
    '',
    '验证是否生效（应输出 "certificate verification successful"）：',
    '',
    `  security verify-cert -c ${LEAF_CRT} -p ssl -s v2.localhost`,
    '',
    '然后重启演练栈让新证书生效：',
    '',
    '  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"',
    '  docker compose --env-file .env.deploy -f docker-compose.yml -f docker-compose.rehearsal.yml up -d',
    '',
    '之后浏览器地址栏不再有警告；上传的跨域直传（`s3.localhost`）也不会再被 TLS 拦下。',
  ].join('\n')
}
