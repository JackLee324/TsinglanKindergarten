#!/usr/bin/env node
/**
 * scripts/export-v1-production.mjs —— 从**生产 V1** 导出一份只读数据快照
 * ============================================================================
 * 为什么需要它：V2 的正式生产迁移**只认**一份冻结的生产快照。
 * 拿本机那份"生产等价"数据去导入生产是不允许的 —— 那是在赌
 * "本机 348 条 == 生产真实数据"。
 *
 * 所以：先导出（本脚本）→ 记 sha256 → 与本地等价数据逐项交叉核对 →
 * 写 `docs/V1_PRODUCTION_SOURCE_FREEZE.md` → 只有全部一致才允许迁移。
 *
 * 这个脚本**只读业务数据**：
 *   1. GET  /                      （取 CSRF cookie）
 *   2. POST /api/auth/login        （口令）
 *   3. POST /api/auth/mfa/verify   （TOTP 第二因子）
 *   4. POST /api/admin/data-export （全量逻辑导出，服务端只 SELECT）
 * 唯一被写的东西是服务端自己的审计行 `data_export`（这是它的设计，
 * 每一次导出都必须留痕），业务表一个字节都不改。
 *
 * 用法：
 *   node scripts/export-v1-production.mjs --confirm-production
 *     [--base https://…]                覆盖凭据文件里的 base
 *     [--credentials ../credentials/prod-super-admin.json]
 *     [--out-dir .migration/prod-exports]
 *
 * 凭据文件（gitignored）里需要：username / password / totpSecret。
 * 脚本**从不打印**口令、TOTP 密钥、会话 cookie 或 CSRF token。
 */
import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── 参数 ────────────────────────────────────────────────────────────────────
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

if (has('help') || process.argv.length <= 2) {
  console.log(
    '用法：node scripts/export-v1-production.mjs --confirm-production [--base URL] [--out-dir DIR]\n' +
      '      node scripts/export-v1-production.mjs --selftest   （只验 TOTP 实现，不碰生产）',
  )
  process.exit(process.argv.length <= 2 ? 1 : 0)
}
// `--selftest` 必须在"确认生产"这道闸之前处理：它不连生产，也不读凭据。
const SELFTEST_ONLY = has('selftest')
if (!SELFTEST_ONLY && !has('confirm-production')) {
  console.error(
    '这是在**生产**上取快照，必须显式确认：\n' +
      '  node scripts/export-v1-production.mjs --confirm-production\n' +
      '（只读业务数据；服务端仍会写一条 data_export 审计，这是它的设计。）',
  )
  process.exit(2)
}

const credentialsPath = resolve(
  ROOT,
  arg('credentials', '../credentials/prod-super-admin.json'),
)
const creds = SELFTEST_ONLY ? {} : JSON.parse(readFileSync(credentialsPath, 'utf8'))
const BASE = SELFTEST_ONLY ? 'http://selftest.invalid' : (arg('base', creds.base) ?? '').replace(/\/+$/, '')
if (!SELFTEST_ONLY) {
  if (BASE === '') throw new Error('缺少 base（凭据文件里没有 base，也没有 --base）')
  for (const key of ['username', 'password', 'totpSecret']) {
    if (typeof creds[key] !== 'string' || creds[key] === '') {
      throw new Error(`凭据文件缺少 ${key}：${credentialsPath}`)
    }
  }
}
const OUT_DIR = resolve(ROOT, arg('out-dir', '.migration/prod-exports'))

// ── TOTP（RFC 6238：SHA-1 / 6 位 / 30 秒）────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function base32Decode(input) {
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx === -1) throw new Error('TOTP 密钥不是合法 base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function totp(secret, at = Date.now()) {
  const counter = Math.floor(at / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff)
  return String(code % 1_000_000).padStart(6, '0')
}

/**
 * 自检：RFC 6238 的官方测试向量（secret = ASCII "12345678901234567890"，
 * SHA-1 输出 8 位，这里取后 6 位）。
 *
 * 为什么必须有：生产上 MFA 只有 5 次机会，**不该拿它来试我的 OTP 实现**。
 * 先在本地把向量跑对，再去碰生产。
 */
function selftestTotp() {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ]
  const bad = []
  for (const [t, expected] of vectors) {
    const got = totp(secret, t * 1000)
    if (got !== expected) bad.push(`T=${t}：期望 ${expected}，实际 ${got}`)
  }
  if (bad.length > 0) {
    console.error('❌ TOTP 自检失败：')
    for (const b of bad) console.error(`   - ${b}`)
    process.exit(4)
  }
  console.log(`✅ TOTP 自检通过（${vectors.length} 组 RFC 6238 向量）`)
}

if (SELFTEST_ONLY) {
  selftestTotp()
  process.exit(0)
}

// ── HTTP（手动管 cookie：fetch 不替我们存）──────────────────────────────────
const jar = new Map()
function cookiesFrom(res) {
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const c of setCookie) {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

async function call(method, path, { body, csrf = true } = {}) {
  const headers = { cookie: cookieHeader(), 'user-agent': 'v2-production-export/1.0' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (csrf) {
    const token = jar.get('suda-csrf-token')
    if (token === undefined) throw new Error('没有拿到 CSRF cookie（先 GET /）')
    headers['x-suda-csrf-token'] = token
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  cookiesFrom(res)
  return res
}

const beijing = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (UTC+8)'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ── 主流程 ──────────────────────────────────────────────────────────────────
const t0 = Date.now()
console.log(`生产 V1：${BASE}`)
console.log(`凭据文件：${credentialsPath}（口令与 TOTP 密钥不会打印）`)

const home = await call('GET', '/', { csrf: false })
if (!home.ok) throw new Error(`GET / 失败：HTTP ${home.status}`)
console.log(`① 取到 CSRF cookie：${home.ok ? 'OK' : '失败'}`)

const login = await call('POST', '/api/auth/login', {
  body: { username: creds.username, password: creds.password },
})
if (login.status === 401 || login.status === 403) {
  throw new Error(
    `登录被拒（HTTP ${login.status}）。可能是口令已改或登录限流；` +
      '请先用浏览器确认能登录，再更新凭据文件。',
  )
}
if (!login.ok) throw new Error(`登录失败：HTTP ${login.status} ${(await login.text()).slice(0, 200)}`)
const loginBody = await login.json()
console.log(`② 口令通过（mfaRequired=${loginBody.mfaRequired}）`)

if (loginBody.mfaRequired === true) {
  /*
    允许一点时钟漂移：先试当前时间窗，再试 +1 / −1 窗。
    生产上 MFA 只有 5 次机会，所以这里最多用 3 次 —— 而且算法本身已经用
    RFC 6238 向量在本地证明过（--selftest），不是拿生产当试验场。
  */
  const offsets = [0, 30_000, -30_000]
  let ok = false
  for (const [index, offset] of offsets.entries()) {
    const verify = await call('POST', '/api/auth/mfa/verify', {
      body: { challengeToken: loginBody.challengeToken, code: totp(creds.totpSecret, Date.now() + offset) },
    })
    if (verify.ok) {
      ok = true
      console.log(`③ TOTP 通过（会话已建立${offset === 0 ? '' : `，用了 ${offset / 1000}s 偏移的时间窗`}）`)
      break
    }
    const text = (await verify.text()).slice(0, 200)
    if (index === offsets.length - 1) throw new Error(`MFA 校验失败：HTTP ${verify.status} ${text}`)
    console.warn(`   TOTP 第 ${index + 1} 次未通过（HTTP ${verify.status}），换相邻时间窗重试…`)
  }
  if (!ok) throw new Error('MFA 校验未能建立会话')
} else {
  console.log('③ 该账号未开启 MFA（生产上不应如此，请核实）')
}

const startedAt = new Date()
console.log('④ 正在导出全量逻辑快照（服务端只 SELECT）…')
const exportRes = await call('POST', '/api/admin/data-export', { body: {} })
if (!exportRes.ok) {
  throw new Error(`导出失败：HTTP ${exportRes.status} ${(await exportRes.text()).slice(0, 300)}`)
}
const ndjson = Buffer.from(await exportRes.arrayBuffer())
const finishedAt = new Date()

// ── 落盘 ────────────────────────────────────────────────────────────────────
const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
mkdirSync(OUT_DIR, { recursive: true })
const name = `prod-export-${stamp}`
const ndjsonPath = join(OUT_DIR, `${name}.ndjson`)
const shaPath = join(OUT_DIR, `${name}.sha256`)
const digest = sha256(ndjson)
writeFileSync(ndjsonPath, ndjson)
// sha256sum 的格式（`<hash>  <文件名>`），这样 `shasum -a 256 -c` 能直接校验
writeFileSync(shaPath, `${digest}  ${name}.ndjson\n`)

// ── 解析并自校验（table 行 / footer / 实际行数 三者必须一致）──────────────
const lines = ndjson.toString('utf8').split('\n').filter((l) => l.trim() !== '')
let header = null
let footer = null
const counts = {}
const tableLines = {}
let rowLines = 0
for (const line of lines) {
  const obj = JSON.parse(line)
  if (obj.kind === 'header') header = obj
  else if (obj.kind === 'footer') footer = obj
  else if (obj.kind === 'table') tableLines[obj.table] = true
  else if (obj.kind === 'row') {
    rowLines += 1
    counts[obj.table] = (counts[obj.table] ?? 0) + 1
  }
}
const footerCounts = footer?.counts ?? {}
const mismatches = []
for (const [table, n] of Object.entries(footerCounts)) {
  if ((counts[table] ?? 0) !== n) mismatches.push(`${table}: footer=${n} 实际=${counts[table] ?? 0}`)
}
for (const [table, n] of Object.entries(counts)) {
  if (footerCounts[table] === undefined) mismatches.push(`${table}: 实际=${n} 但 footer 里没有`)
}
if (footer === null) mismatches.push('没有 footer 行')
if (header === null) mismatches.push('没有 header 行')

const evidence = {
  base: BASE,
  credentialsFile: credentialsPath,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  startedAtBeijing: beijing(),
  elapsedMs: Date.now() - t0,
  ndjson: { file: ndjsonPath, bytes: ndjson.length, sha256: digest },
  sha256File: shaPath,
  exportHeader: header,
  footerCounts,
  parsedCounts: counts,
  selfCheck: { rowLines, tables: Object.keys(tableLines).length, mismatches },
}
const evidencePath = join(OUT_DIR, `${name}.evidence.json`)
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

// ── 报告（终端）─────────────────────────────────────────────────────────────
console.log()
console.log(`导出文件：${ndjsonPath}`)
console.log(`sha256  ：${digest}`)
console.log(`字节数  ：${ndjson.length}`)
console.log(`证据文件：${evidencePath}`)
console.log()
console.log('各表行数（footer 口径）：')
for (const [table, n] of Object.entries(footerCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${table.padEnd(28)} ${String(n).padStart(7)}`)
}
console.log()
if (mismatches.length > 0) {
  console.error('❌ 自校验失败（table 行 / footer / 实际解析行数不一致）：')
  for (const m of mismatches) console.error(`   - ${m}`)
  process.exit(3)
}
console.log(`✅ 自校验通过：${Object.keys(tableLines).length} 张表 / ${rowLines} 行，三处口径一致`)
console.log()
console.log('下一步（不要直接迁移）：')
console.log('  node scripts/crosscheck-v1-production.mjs --snapshot ' + ndjsonPath)
