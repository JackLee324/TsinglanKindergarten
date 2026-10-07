/**
 * scripts/verify-safari.mjs —— 在**真实 Safari** 里跑一遍关键业务路径
 * ============================================================================
 *   # 1) 先让 Chrome 那套把服务跑起来（或你自己跑 npm run dev / 已部署的地址）
 *   # 2) safaridriver -p 4444
 *   # 3) node scripts/verify-safari.mjs --base http://127.0.0.1:3311 \
 *   #      --user s10_teacher_a --password 'S10TeacherA!1'
 *
 * 它**不是** Stage 10 那 42 条验收的替代品（那是 CDP 跑的），
 * 而是业主 §20 要求的"第二个引擎再走一遍"：
 *
 *   登录 → 教育教学 → Pre-K → 美德 → 教学资源 → 打开一条资源 → 详情页
 *
 * 之所以用 Safari 而不是"再跑一遍 Chrome"：Safari 与 Chromium 在
 * `SameSite` Cookie、`HttpOnly`、fetch 缓存、PDF 内联预览上都有差异，
 * 而这些差异**只会在另一种引擎上暴露**。
 *
 * ⚠️ 前提：Safari → 设置 → 开发者 → 允许远程自动化（一次性、需要人点）。
 * 没打开时本脚本以退出码 2 结束并打印照做即可的说明 —— 它不会假装通过。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchSafari, SafariUnavailableError } from '../tests/helpers/safari.mjs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const base = String(arg('base') ?? process.env.SAFARI_BASE ?? 'http://127.0.0.1:3311').replace(/\/$/, '')
const username = arg('user')
const password = arg('pass')
const shotPath = arg('shot')

if (username === true || password === true || username === null || password === null) {
  console.error('用法：node scripts/verify-safari.mjs --base <URL> --user <用户名> --pass <口令> [--shot 截图.png]')
  process.exit(2)
}

const steps = []
const step = async (name, fn) => {
  const started = Date.now()
  await fn()
  steps.push({ name, ms: Date.now() - started })
  console.log(`  ✔ ${name}`)
}

let session
try {
  session = await launchSafari()
} catch (error) {
  if (error instanceof SafariUnavailableError) {
    console.error(`\n✖ Safari 这一遍**没有跑**（UNVERIFIED）\n\n${error.message}\n`)
    process.exit(2)
  }
  throw error
}

try {
  console.log(`Safari 关键路径验收 → ${base}`)

  await step('打开登录页', async () => {
    await session.goto(`${base}/login`)
    for (let i = 0; i < 40 && !(await session.exists('[data-testid="login-page"]')); i += 1) {
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!(await session.exists('[data-testid="login-page"]'))) throw new Error('登录页没出现')
  })

  await step('用真实账号登录', async () => {
    await session.type('[data-testid="login-username"]', String(username))
    await session.type('[data-testid="login-password"]', String(password))
    await session.click('[data-testid="login-submit"]')
    for (let i = 0; i < 60 && !(await session.exists('[data-testid="sidebar"]')); i += 1) {
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!(await session.exists('[data-testid="sidebar"]'))) throw new Error('登录之后没有进入应用外壳')
  })

  await step('教育教学 → Pre-K → 美德 → 教学资源（全靠点击）', async () => {
    for (const path of [
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
    ]) {
      const nav = `[data-nav="/directory/${path}"]`
      if (!(await session.exists(nav))) {
        const parent = path.split('/').slice(0, -1).join('/')
        const toggle = `[data-nav-toggle="/directory/${parent}"]`
        if (await session.exists(toggle)) {
          if ((await session.attr(toggle, 'aria-expanded')) !== 'true') await session.click(toggle)
        }
      }
      for (let i = 0; i < 40 && !(await session.exists(nav)); i += 1) {
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!(await session.exists(nav))) throw new Error(`侧边栏里点不到 ${path}`)
      await session.click(nav)
      for (let i = 0; i < 40 && !(await session.exists('[data-testid="directory-page"]')); i += 1) {
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    const title = await session.text('[data-testid="directory-title"]')
    if (title !== '教学资源') throw new Error(`目录标题不对：${title}`)
  })

  await step('资源列表渲染（或有据可查的空状态）', async () => {
    for (let i = 0; i < 60; i += 1) {
      if (await session.exists('[data-testid="resource-list"]')) return
      if (await session.exists('[data-testid="resource-list-empty"]')) return
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('既没有资源列表，也没有空状态')
  })

  await step('打开一条资源 → 详情页', async () => {
    if (!(await session.exists('[data-testid="resource-card-title"]'))) {
      console.log('  （这个目录是空的，跳过"打开资源"这一步）')
      return
    }
    await session.click('[data-testid="resource-card-title"]')
    for (let i = 0; i < 60 && !(await session.exists('[data-testid="resource-detail-page"]')); i += 1) {
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!(await session.exists('[data-testid="resource-detail-page"]'))) throw new Error('详情页没打开')
    const title = await session.text('[data-testid="resource-detail-title"]')
    if (!title) throw new Error('详情页没有标题')
    console.log(`    资源：${title}`)
  })

  if (typeof shotPath === 'string') {
    const image = await session.screenshot()
    writeFileSync(join(process.cwd(), shotPath), Buffer.from(image, 'base64'))
    console.log(`  截图：${shotPath}`)
  }

  console.log(`\n✔ Safari 关键路径通过（${steps.length} 步）`)
} finally {
  await session.quit().catch(() => {})
}
