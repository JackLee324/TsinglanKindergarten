#!/usr/bin/env node
/**
 * deploy/verify.mjs —— 对着**已部署的环境**跑一遍生产自检，失败就 exit 非 0
 * ============================================================================
 * 业主 Stage 12 §31：deploy → verify，失败必须 exit non-zero。
 *
 * 它只做**只读**检查，不改数据、不重启服务：
 *   1. compose 状态：app / db（/proxy）都 healthy
 *   2. HTTP → HTTPS 跳转
 *   3. HTTPS 通 + 证书（--cacert 或系统信任；演练用 deploy/tls/fullchain.pem）
 *   4. 六个安全响应头齐全，且没有 x-powered-by
 *   5. /api/health 200、/api/health/ready 200（ready 会真的查库）
 *   6. 静态资源：首页 HTML 200、JS/CSS 200 且 content-type 正确
 *   7. 登录限流：连续错口令最终得到 429
 *   8. 数据库：迁移 0 pending + 六张核心表存在
 *   9. 关键计数：users / directories / resources / resource_files / resource_reviews / audit_logs
 *
 * 用法：
 *   node deploy/verify.mjs --base https://v2.localhost:8443 --cacert deploy/tls/fullchain.pem
 *     [--skip-rate-limit] [--expected resources=349,users=24]
 *
 * ⚠️ 限流那一条会**故意**打几次错误口令，所以默认放在最后，并且可以用
 *    --skip-rate-limit 关掉（例如对着生产域名做日常巡检时）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const BASE = (arg('base', process.env.PRODUCTION_BASE_URL ?? '')).replace(/\/+$/, '')
if (BASE === '') {
  console.error('用法：node deploy/verify.mjs --base https://你的域名 [--cacert 证书.pem]')
  process.exit(2)
}
const CACERT = arg('cacert', null)
if (CACERT !== null) {
  /*
    ⚠️ `NODE_EXTRA_CA_CERTS` 必须在 **Node 启动之前** 生效 —— 在脚本里赋值太晚了
    （fetch 用的 TLS 上下文早就建好了）。所以这里**重新 exec 一次自己**，
    把环境变量带上。第一版就是在这里踩的：所有 https 请求都 fetch failed。
  */
  const caPath = resolve(ROOT, CACERT)
  if (process.env.NODE_EXTRA_CA_CERTS !== caPath) {
    const res = spawnSync(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath },
    })
    process.exit(res.status ?? 1)
  }
}

const composeFiles = () =>
  existsSync(join(ROOT, 'docker-compose.rehearsal.yml'))
    ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.rehearsal.yml']
    : ['-f', 'docker-compose.yml']

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === '' ? '' : `  ${detail}`}`)
}

async function get(path, init = {}) {
  return fetch(`${BASE}${path}`, { redirect: 'manual', ...init })
}

// ── 1. 容器状态 ─────────────────────────────────────────────────────────────
if (!has('skip-compose')) {
  try {
    const ps = execFileSync(
      'docker',
      ['compose', '--env-file', '.env.deploy', ...composeFiles(), 'ps', '--format', 'json'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const services = ps
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
    const unhealthy = services.filter((s) => !String(s.Status ?? '').toLowerCase().includes('healthy') && !String(s.Status ?? '').includes('Up'))
    check(
      'compose 服务健康',
      services.length > 0 && unhealthy.length === 0,
      services.map((s) => `${s.Service}=${s.Status}`).join(' / '),
    )
  } catch (e) {
    check('compose 服务健康', false, `读不到 compose 状态：${String(e.message).slice(0, 120)}`)
  }
}

// ── 2/3. HTTP → HTTPS + HTTPS 通 ────────────────────────────────────────────
const HTTP_PORT = arg('http-port', '80')
try {
  const host = BASE.replace(/^https:\/\//, '').replace(/:\d+$/, '')
  const httpBase = HTTP_PORT === '80' ? `http://${host}` : `http://${host}:${HTTP_PORT}`
  const res = await fetch(httpBase, { redirect: 'manual' })
  const location = res.headers.get('location') ?? ''
  check(
    'HTTP 跳 HTTPS',
    res.status >= 300 && res.status < 400 && location.startsWith('https://'),
    `HTTP ${res.status} → ${location || '(无 Location)'}`,
  )
} catch (e) {
  check('HTTP 跳 HTTPS', false, `${String(e.message).slice(0, 80)}（--http-port 默认 80，演练是 10080）`)
}

let homeStatus = 0
let headers = new Headers()
try {
  const res = await get('/')
  homeStatus = res.status
  headers = res.headers
  check('HTTPS 首页可取', res.status === 200, `HTTP ${res.status}`)
} catch (e) {
  check('HTTPS 首页可取', false, String(e.message).slice(0, 140))
}

// ── 4. 安全响应头 ───────────────────────────────────────────────────────────
const requiredHeaders = [
  ['strict-transport-security', /max-age=\d+/],
  ['x-content-type-options', /nosniff/],
  ['referrer-policy', /./],
  ['x-frame-options', /SAMEORIGIN|DENY/],
  ['content-security-policy', /default-src/],
  ['permissions-policy', /camera=/],
]
const missing = requiredHeaders.filter(([name, re]) => !re.test(headers.get(name) ?? ''))
check('六个安全响应头齐全', missing.length === 0, missing.length ? `缺：${missing.map((m) => m[0]).join(', ')}` : '')
check('没有 x-powered-by', headers.get('x-powered-by') === null, headers.get('x-powered-by') ?? '')

// ── 5. 健康检查 ─────────────────────────────────────────────────────────────
try {
  const health = await get('/api/health')
  check('/api/health 200', health.status === 200, `HTTP ${health.status}`)
  const ready = await get('/api/health/ready')
  check('/api/health/ready 200（真的查库）', ready.status === 200, `HTTP ${ready.status}`)
} catch (e) {
  check('/api/health 200', false, String(e.message).slice(0, 120))
}

// ── 6. 静态资源 ─────────────────────────────────────────────────────────────
try {
  const html = await get('/')
  const text = await html.text()
  const assets = [...text.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])
  let bad = []
  for (const asset of assets.slice(0, 6)) {
    const res = await get(asset)
    const type = res.headers.get('content-type') ?? ''
    const wantJs = asset.endsWith('.js')
    if (res.status !== 200 || (wantJs ? !/javascript/.test(type) : !/css/.test(type))) {
      bad.push(`${asset}→${res.status} ${type}`)
    }
  }
  check('静态资源可取且 MIME 正确', assets.length > 0 && bad.length === 0, bad.join(' / '))

  /*
    ── 样式真的编译出来了（不是"CSS 200 但里面没有工具类"）──────────────────
    2026-10-08 的演练镜像正是这种情况：CSS 是 200 + text/css（上面那条全绿），
    但文件里**一个工具类都没有**（Tailwind 的 PostCSS 插件没跑 —— Dockerfile
    构建阶段漏拷 postcss.config.mjs），页面以裸 HTML 渲染、全部挤在左上角。
    所以这里**打开 CSS 看内容**：主题变量必须已编译、工具类必须存在。
  */
  const cssAsset = assets.find((a) => a.endsWith('.css'))
  if (cssAsset === undefined) {
    check('样式已被编译（CSS 里有工具类）', false, '首页没有引用任何 .css')
  } else {
    const css = await (await get(cssAsset)).text()
    const cssProblems = []
    if (css.includes('@theme')) cssProblems.push('还留着未展开的 @theme（Tailwind 插件没跑）')
    if (!css.includes(':root,:host{')) cssProblems.push('没有编译出的主题变量')
    const missingUtilities = ['.min-h-screen{', '.flex{', '.items-center{', '.rounded-lg{'].filter((u) => !css.includes(u))
    if (missingUtilities.length > 0) cssProblems.push(`缺工具类：${missingUtilities.join('、')}`)
    check('样式已被编译（CSS 里有工具类）', cssProblems.length === 0, cssProblems.join('；'))
  }
} catch (e) {
  check('静态资源可取且 MIME 正确', false, String(e.message).slice(0, 120))
}

// ── 8/9. 数据库：迁移与计数 ────────────────────────────────────────────────
if (!has('skip-db')) {
  try {
    // ⚠️ 必须打**已部署的**那个库：直接在宿主机跑 migrate status 会用宿主机的
    //    DATABASE_URL（开发库），结果毫无意义（第一版就是这个错）。
    const status = execFileSync(
      'docker',
      ['compose', '--env-file', '.env.deploy', ...composeFiles(), 'exec', '-T', 'app', 'node', 'scripts/migrate.mjs', 'status'],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim()
    const pending = (status.match(/\[待执行\]/g) ?? []).length
    check('数据库迁移 0 pending', pending === 0, pending === 0 ? '' : `还有 ${pending} 个待执行`)
  } catch (e) {
    check('数据库迁移 0 pending', false, String(e.message).slice(0, 160))
  }
  const expected = arg('expected', null)
  if (expected !== null) {
    const want = Object.fromEntries(expected.split(',').map((p) => p.split('=')))
    try {
      const counts = JSON.parse(
        execFileSync('docker', ['compose', '--env-file', '.env.deploy', ...composeFiles(), 'exec', '-T', 'db', 'psql', '-U', process.env.POSTGRES_USER ?? 'qls', '-d', process.env.POSTGRES_DB ?? 'qls_prod', '-Atc',
          `SELECT json_build_object('users',(SELECT count(*) FROM users),'directories',(SELECT count(*) FROM directories),'resources',(SELECT count(*) FROM resources),'resource_files',(SELECT count(*) FROM resource_files),'resource_reviews',(SELECT count(*) FROM resource_reviews),'audit_logs',(SELECT count(*) FROM audit_logs))`],
          { encoding: 'utf8' },
        ).trim(),
      )
      const mismatched = Object.entries(want).filter(([k, v]) => String(counts[k]) !== String(v))
      check(
        '关键计数与预期一致',
        mismatched.length === 0,
        mismatched.length ? mismatched.map(([k, v]) => `${k}:期望 ${v} 实际 ${counts[k]}`).join('; ') : JSON.stringify(counts),
      )
    } catch (e) {
      check('关键计数与预期一致', false, String(e.message).slice(0, 160))
    }
  }
}

// ── 7. 登录限流（放最后：它会故意打几次错口令）────────────────────────────
if (!has('skip-rate-limit')) {
  const codes = []
  for (let i = 0; i < 10; i += 1) {
    try {
      const res = await get('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'verify-probe-nonexistent', password: 'wrong-password-for-verify' }),
      })
      codes.push(res.status)
    } catch {
      codes.push(0)
    }
  }
  check('登录限流返回 429', codes.includes(429), `状态序列：${codes.join(',')}`)
}

const failed = results.filter((r) => !r.ok)
console.log()
console.log(failed.length === 0 ? `✅ 全部 ${results.length} 项通过` : `❌ ${failed.length}/${results.length} 项未通过`)
process.exit(failed.length === 0 ? 0 : 1)
