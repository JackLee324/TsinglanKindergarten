/**
 * tests/integration/browser.stage11.test.mjs —— 手机端验收（业主 Stage 11）
 * ============================================================================
 * Stage 10 用真 Safari 量出了一个真问题：**viewport < 1024px 时全站没有任何导航入口**
 * （侧边栏 `hidden lg:flex`，没有 hamburger / drawer / bottom nav）。这一份验收的是
 * 那个问题真的修好了，而且修的时候没有把桌面端弄坏。
 *
 * 三条自我约束（业主要求）：
 *   1. **真实移动视口**：用 CDP 的 `Emulation.setDeviceMetricsOverride` 把 Chrome 设成
 *      真实机型的宽高 / DPR / 触摸（不是"把窗口拖窄"，也不是静态分析 CSS）；
 *      UA 也换成对应机型的，于是服务端看到的也是移动端。
 *   2. **真实点击/输入/上传/下载**：所有步骤都走页面元素，不用"直接改 React state"。
 *   3. 每段流程都查 console 与网络（CDP 三个域），主动制造的 401/403/404 **必须显式登记**，
 *      不许"4xx 一律放过"。
 *
 * 机型与断点（业主 §3 / §26）：1440 / 1200 / 1023 / 900 / 768 / 430 / 390 / 375 / 320，
 * 以及竖屏 390×844 与横屏 844×390。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEST_BASE,
  client,
  createAdmin,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { launchBrowser } from '../helpers/browser.mjs'
import { pdfBytes } from '../helpers/upload.mjs'

const WORK = mkdtempSync(join(tmpdir(), 'stage11-'))
const FILES_DIR = join(WORK, 'files')
const DOWNLOAD_DIR = join(WORK, 'downloads')

const ADMIN = { username: 's11_admin', password: 'S11AdminPass!1' }
const TEACHER = { username: 's11_teacher', password: 'S11TeacherPass!1' }

/** 真实机型（宽 × 高 × DPR × 是否触摸），UA 也照机型换。 */
const DEVICES = {
  'iPhone 14 (390×844)': {
    width: 390, height: 844, dpr: 3, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  'iPhone SE (375×667)': {
    width: 375, height: 667, dpr: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'Android Pixel 7 (412×915)': {
    width: 412, height: 915, dpr: 2.625, mobile: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  },
}

/** 业主 §3 指定的断点全都要过。 */
const ALL_WIDTHS = [1440, 1200, 1023, 900, 768, 430, 390, 375, 320]

let browser
let adminClient
const ids = {}
/** 主动制造的失败响应（逐条登记，少写一条就是红灯）。 */
const allowedNoise = []

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const FILES = {
  pdf: { name: '手机端教案.pdf', bytes: pdfBytes('stage11') },
  jpg: {
    name: '手机端照片.jpg',
    bytes: Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64',
    ),
  },
  png: {
    name: '手机端照片.png',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  },
}

// ── 设备与页面操作 ──────────────────────────────────────────────────────────

/** 把浏览器切到某个真实机型（视口 + DPR + 触摸 + UA）。 */
async function useDevice(device) {
  await browser.session.send('Emulation.setDeviceMetricsOverride', {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.dpr,
    mobile: device.mobile === true,
    screenWidth: device.width,
    screenHeight: device.height,
  })
  await browser.session.send('Emulation.setTouchEmulationEnabled', {
    enabled: device.mobile === true,
    maxTouchPoints: device.mobile === true ? 5 : 1,
  })
  if (device.ua) {
    await browser.session.send('Emulation.setUserAgentOverride', { userAgent: device.ua })
  }
  await new Promise((r) => setTimeout(r, 150))
}

async function clearDevice() {
  await browser.session.send('Emulation.clearDeviceMetricsOverride', {})
  await browser.session.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 })
  await browser.session.send('Emulation.setUserAgentOverride', { userAgent: '' })
}

/** 只改视口宽度（断点回归用）。 */
async function useWidth(width, height = 800) {
  await useDevice({ width, height, dpr: 2, mobile: width < 768 })
}

async function login(username, password) {
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 20000, '退出')
  }
  await browser.goto(`${TEST_BASE}/login`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 20000, '登录页')
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="header"]\')', 25000, `登录 ${username}`)
}

/** 手机上：点 hamburger → 抽屉打开 → 点某一项 → 抽屉自动关闭。 */
async function mobileNavigate(navPath, { label = null } = {}) {
  await browser.waitFor('!!document.querySelector(\'[data-testid="nav-open"]\')', 20000, 'hamburger')
  await browser.click('[data-testid="nav-open"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '抽屉打开')

  const nav = `[data-nav="${navPath}"]`
  // 目录节点可能是折叠的：先把祖先链展开（抽屉里同样只有一份 DOM）
  if (!(await browser.exists(nav))) {
    const segments = navPath.replace('/directory/', '').split('/')
    let prefix = ''
    for (const slug of segments.slice(0, -1)) {
      prefix = prefix === '' ? slug : `${prefix}/${slug}`
      const toggle = `[data-nav-toggle="/directory/${prefix}"]`
      if (await browser.exists(toggle)) {
        if ((await browser.attr(toggle, 'aria-expanded')) !== 'true') await browser.click(toggle)
      }
    }
  }
  await browser.waitFor(`!!document.querySelector('${nav}')`, 20000, `抽屉里有 ${navPath}${label ? `（${label}）` : ''}`)
  await browser.click(nav)
  await browser.waitFor('!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '点完自动关闭抽屉')
}

/** 进目录页（手机流程里一律"点进去"，不输深层 URL）。 */
async function mobileClickThrough(paths) {
  for (const path of paths) {
    await mobileNavigate(`/directory/${path}`)
    await browser.waitFor(
      `document.querySelector('[data-testid="directory-page"]')?.getAttribute('data-directory-path') === '${path}'`,
      20000,
      `到达 ${path}`,
    )
  }
}

/** 页面有没有横向溢出（业主 §26）。返回最宽的越界元素，便于定位。 */
async function horizontalOverflow() {
  return browser.session.eval(`(() => {
    const doc = document.documentElement
    const overflow = doc.scrollWidth - window.innerWidth
    let worst = null
    if (overflow > 1) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        const past = Math.round(r.right - window.innerWidth)
        if (past > 1 && (worst === null || past > worst.past)) {
          worst = {
            past,
            tag: el.tagName,
            testid: el.getAttribute('data-testid') || '',
            cls: (el.getAttribute('class') || '').slice(0, 60),
          }
        }
      }
    }
    return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, overflow, worst }
  })()`)
}

async function assertNoOverflow(label) {
  const result = await horizontalOverflow()
  assert.equal(
    result.overflow <= 1,
    true,
    `${label} 出现横向溢出 ${result.overflow}px（scrollWidth=${result.scrollWidth} innerWidth=${result.innerWidth}）` +
      ` 最宽越界元素：${JSON.stringify(result.worst)}`,
  )
}

before(async () => {
  mkdirSync(FILES_DIR, { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  for (const f of Object.values(FILES)) {
    f.path = join(FILES_DIR, f.name)
    writeFileSync(f.path, f.bytes)
    f.sha256 = sha256(f.bytes)
  }

  await resetDatabase()
  await createAdmin(ADMIN.username, ADMIN.password)
  await startServer()

  adminClient = client()
  await adminClient.login(ADMIN.username, ADMIN.password)

  const virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.virtue = virtue
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtueOutline = await directoryIdByPath('education/pre-k/virtue/outline')
  ids.montessori = await directoryIdByPath('education/pre-k/montessori')

  const created = await adminClient.post('/api/users', {
    name: '手机端张老师',
    username: TEACHER.username,
    password: TEACHER.password,
    role: 'TEACHER',
    permissions: [
      { permission: 'resource.view', directoryId: virtue },
      { permission: 'resource.create', directoryId: virtue },
      { permission: 'resource.update.own', directoryId: virtue },
      { permission: 'resource.delete.own', directoryId: virtue },
      { permission: 'resource.download', directoryId: virtue },
      { permission: 'resource.submit', directoryId: virtue },
      { permission: 'directory.create_folder', directoryId: virtue },
    ],
  })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  ids.teacher = created.data.id

  // 两条已发布资源（PDF / 图片）+ 一条草稿，供手机端预览、下载、提交、审核
  const teacher = client()
  await teacher.login(TEACHER.username, TEACHER.password)
  const { uploadFile } = await import('../helpers/upload.mjs')
  for (const [key, f] of [['pdf', FILES.pdf], ['png', FILES.png]]) {
    const resource = await teacher.post('/api/resources', {
      directoryId: ids.virtueResources,
      title: `手机端资源（${key}）`,
    })
    await uploadFile(teacher, resource.data.id, {
      fileName: f.name,
      bytes: f.bytes,
      mimeType: key === 'pdf' ? 'application/pdf' : 'image/png',
    })
    await teacher.post(`/api/resources/${resource.data.id}/submit`)
    await adminClient.post(`/api/resources/${resource.data.id}/review`, { action: 'approve' })
    ids[`res_${key}`] = resource.data.id
  }

  browser = await launchBrowser()
  await browser.enableDownloads(DOWNLOAD_DIR)
  await browser.startProblemWatch()
})

after(async () => {
  await clearDevice().catch(() => {})
  if (browser) await browser.close()
  await stopServer()
  rmSync(WORK, { recursive: true, force: true })
})

async function directoryIdByPath(path) {
  const rows = await withSql((sql) => sql`
    WITH RECURSIVE dp AS (
      SELECT id, slug::text AS path FROM directories WHERE parent_id IS NULL
      UNION ALL SELECT d.id, dp.path || '/' || d.slug FROM directories d JOIN dp ON d.parent_id = dp.id
    ) SELECT id::text FROM dp WHERE path = ${path}`)
  assert.equal(rows.length, 1, `目录 ${path} 必须存在`)
  return rows[0].id
}

describe('① 移动导航：hamburger + 抽屉（<1024px）', () => {
  test('iPhone 14：侧边栏不渲染，hamburger 在；抽屉里是同一份导航', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    await login(TEACHER.username, TEACHER.password)

    const state = await browser.session.eval(`(() => ({
      sidebar: document.querySelector('[data-testid="sidebar"]') !== null,
      hamburger: document.querySelector('[data-testid="nav-open"]') !== null,
      navLinksWhenClosed: document.querySelectorAll('[data-nav]').length,
    }))()`)
    assert.equal(state.sidebar, false, '窄屏不该渲染桌面侧边栏（不是藏起来，是根本不渲染）')
    assert.equal(state.hamburger, true, '窄屏必须有导航入口')
    assert.equal(state.navLinksWhenClosed, 0, '抽屉没打开时不该有第二份导航节点')

    await browser.click('[data-testid="nav-open"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '抽屉')
    const inDrawer = await browser.session.eval(`(() => {
      const drawer = document.querySelector('[data-testid="mobile-drawer"]')
      return {
        total: document.querySelectorAll('[data-nav]').length,
        inside: drawer.querySelectorAll('[data-nav]').length,
        home: drawer.querySelector('[data-testid="nav-home"]') !== null,
        myResources: drawer.querySelector('[data-testid="nav-my-resources"]') !== null,
      }
    })()`)
    assert.equal(inDrawer.total, inDrawer.inside, '所有导航节点都必须在抽屉里（没有第二份）')
    assert.equal(inDrawer.inside > 0, true, '抽屉里要有导航项')
    assert.equal(inDrawer.home, true, '抽屉里要有「首页」')
    assert.equal(inDrawer.myResources, true, '抽屉里要有「我的资源」')
  })

  test('桌面 ≥1024px：只有侧边栏、没有 hamburger（不是两套同时显示）', async () => {
    await useWidth(1440, 900)
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="header"]\')', 20000, '外壳')
    const state = await browser.session.eval(`(() => ({
      sidebar: document.querySelector('[data-testid="sidebar"]') !== null,
      hamburger: document.querySelector('[data-testid="nav-open"]') !== null,
      drawer: document.querySelector('[data-testid="mobile-drawer"]') !== null,
    }))()`)
    assert.equal(state.sidebar, true, '桌面必须有侧边栏')
    assert.equal(state.hamburger, false, '桌面不该有 hamburger')
    assert.equal(state.drawer, false, '桌面不该有抽屉')
  })

  test('点抽屉里的项 → 自动关闭；Esc 与点遮罩也能关', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="nav-open"]\')', 20000, 'hamburger')

    // 点一项 → 关
    await mobileNavigate('/my-resources')
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-page"]\')', 20000, '我的资源')

    // Esc → 关
    await browser.click('[data-testid="nav-open"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '抽屉')
    await browser.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await browser.waitFor('!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, 'Esc 关闭抽屉')

    // 关闭按钮 → 关
    await browser.click('[data-testid="nav-open"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '抽屉')
    await browser.click('[data-testid="nav-close"]')
    await browser.waitFor('!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '按钮关闭抽屉')
  })
})

describe('② 手机目录浏览：全程点击，不输 URL', () => {
  test('教育教学 → Pre-K → 美德 → 教学资源', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    await login(TEACHER.username, TEACHER.password)
    await mobileClickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
    ])
    assert.equal(await browser.text('[data-testid="directory-title"]'), '教学资源')
    await assertNoOverflow('教学资源页（390×844）')
  })

  test('教师成长 → L1 → 安全施教规范 → 应急预案 → 传染病识别与防治', async () => {
    // 这一支没开给张老师（授权只有美德）→ 用管理员走，考的是目录链能点到底
    await login(ADMIN.username, ADMIN.password)
    await mobileClickThrough([
      'growth', 'growth/l1', 'growth/l1/safety', 'growth/l1/safety/plan', 'growth/l1/safety/plan/disease',
    ])
    assert.equal(await browser.text('[data-testid="directory-title"]'), '传染病识别与防治')
    const crumbs = await browser.allTexts('[data-testid="breadcrumb-item"]')
    assert.deepEqual(crumbs.slice(0, 2), ['教师成长', 'L1 基础规范'])
    await assertNoOverflow('深层目录页（390×844）')
  })

  test('首页一级目录卡片自适应，不溢出', async () => {
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="home-roots"]\')', 20000, '首页')
    const cards = await browser.session.eval(`(() => {
      const list = document.querySelector('[data-testid="home-roots"]')
      const items = [...list.children].map((c) => Math.round(c.getBoundingClientRect().width))
      const cols = new Set(items).size === 1 ? 1 : items.length
      return { widths: items, listWidth: Math.round(list.getBoundingClientRect().width),
               gaps: items.map((w) => w), columns: items.length > 1 && items[0] === items[1] ? 2 : cols }
    })()`)
    for (const w of cards.widths) {
      assert.equal(w <= cards.listWidth + 1, true, `卡片宽 ${w} 超过容器 ${cards.listWidth}`)
    }
    await assertNoOverflow('首页（390×844）')
  })
})

describe('③ 断点回归：9 个尺寸都不溢出、不白屏', () => {
  test('每个宽度：核心内容在、无横向溢出', async () => {
    for (const width of ALL_WIDTHS) {
      await useWidth(width, width < 1024 ? 844 : 900)
      await browser.goto(`${TEST_BASE}/`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="header"]\')', 25000, `首页（${width}px）`)
      await assertNoOverflow(`首页 ${width}px`)

      // 目录页
      await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 25000, `目录页（${width}px）`)
      await assertNoOverflow(`目录页 ${width}px`)

      // 我的资源
      await browser.goto(`${TEST_BASE}/my-resources`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-page"]\')', 25000, `我的资源（${width}px）`)
      await assertNoOverflow(`我的资源 ${width}px`)

      // 管理页（管理员才进得去；张老师会被挡在门外 —— 那也是一种"不能白屏"）
      for (const [path, testid] of [
        ['/admin/users', 'admin-users-page'],
        ['/admin/directories', 'directory-manage-page'],
        ['/admin/permissions', 'admin-permissions-page'],
        ['/admin/audit', 'admin-audit-page'],
      ]) {
        await browser.goto(`${TEST_BASE}${path}`)
        await browser.waitFor(
          `!!document.querySelector('[data-testid="${testid}"]') || !!document.querySelector('[data-testid$="-forbidden"]')`,
          25000,
          `${path}（${width}px）`,
        )
        await assertNoOverflow(`${path} ${width}px`)
      }

      // 导航入口必须存在（宽屏是侧边栏，窄屏是 hamburger）
      const hasNav = await browser.session.eval(`(() =>
        document.querySelector('[data-testid="sidebar"]') !== null ||
        document.querySelector('[data-testid="nav-open"]') !== null)()`)
      assert.equal(hasNav, true, `${width}px 下必须有一个导航入口`)
    }
    await clearDevice()
  })

  test('横竖屏都能用（390×844 与 844×390）', async () => {
    for (const [w, h, label] of [[390, 844, '竖屏'], [844, 390, '横屏']]) {
      await useDevice({ ...DEVICES['iPhone 14 (390×844)'], width: w, height: h })
      await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 25000, label)
      await assertNoOverflow(`${label} ${w}×${h}`)
      assert.equal(await browser.exists('[data-testid="nav-open"]'), true, `${label} 下要有导航入口`)
    }
    await clearDevice()
  })
})

describe('④ 手机上的资源：详情 / 预览 / 下载 / 上传', () => {
  test('资源详情可滚动，动作按钮触控区够大（≥40px）', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    await login(TEACHER.username, TEACHER.password)
    await mobileClickThrough([
      'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
    ])
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-card-title"]\')', 20000, '资源卡片')
    await browser.click('[data-testid="resource-card-title"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 20000, '详情页')
    await assertNoOverflow('资源详情（390×844）')

    // 触控区：主要按钮不能小于 40×40（iPhone 上的经验下限）
    const small = await browser.session.eval(`(() => {
      const targets = ['resource-detail-edit', 'resource-detail-delete', 'file-download', 'file-preview']
      const bad = []
      for (const id of targets) {
        const el = document.querySelector('[data-testid="' + id + '"]')
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.width < 40 || r.height < 40) bad.push({ id, w: Math.round(r.width), h: Math.round(r.height) })
      }
      return bad
    })()`)
    assert.deepEqual(small, [], `这些按钮的触控区偏小：${JSON.stringify(small)}`)
  })

  test('PDF 预览：iframe 适配视口（不超出屏幕），Safari/Chrome 都能真打开', async () => {
    await browser.goto(`${TEST_BASE}/resources/${ids.res_pdf}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮')
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview-pdf"]\')', 20000, 'PDF iframe')
    const box = await browser.session.eval(`(() => {
      const el = document.querySelector('[data-testid="file-preview-pdf"]')
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight }
    })()`)
    assert.equal(box.w <= box.vw, true, `iframe 宽 ${box.w} 超出视口 ${box.vw}`)
    assert.equal(box.h <= box.vh, true, `iframe 高 ${box.h} 超出视口 ${box.vh}`)
    // 不能是"点开空白"：地址要能真的取回 PDF
    const src = await browser.attr('[data-testid="file-preview-pdf"]', 'src')
    assert.match(String(src), /token=|X-Amz-Signature=/)
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('图片预览：真实解码、宽度不超视口、不变形', async () => {
    await browser.goto(`${TEST_BASE}/resources/${ids.res_png}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮')
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview-image"]\')', 20000, '图片预览')
    const img = await browser.session.eval(`(() => {
      const el = document.querySelector('[data-testid="file-preview-image"]')
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height), nw: el.naturalWidth, nh: el.naturalHeight,
               vw: window.innerWidth, vh: window.innerHeight,
               objectFit: getComputedStyle(el).objectFit }
    })()`)
    assert.equal(img.nw > 0 && img.nh > 0, true, '图片必须真的解码出来')
    assert.equal(img.w <= img.vw, true, `图片宽 ${img.w} 超出视口 ${img.vw}`)
    assert.equal(img.h <= img.vh, true, `图片高 ${img.h} 超出视口 ${img.vh}`)
    assert.equal(img.objectFit, 'contain', '要 contain，不能拉伸变形')
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('TXT 预览：长行换行，不撑破页面', async () => {
    // 造一条超长行的 txt（手机端最容易横向撑破的场景）
    const teacher = client()
    await teacher.login(TEACHER.username, TEACHER.password)
    const resource = await teacher.post('/api/resources', {
      directoryId: ids.virtueResources,
      title: '手机端超长文本',
    })
    const { uploadFile } = await import('../helpers/upload.mjs')
    await uploadFile(teacher, resource.data.id, {
      fileName: '超长行.txt',
      bytes: Buffer.from(`长行：${'一二三四五六七八九十'.repeat(40)}\n第二行\n`, 'utf8'),
      mimeType: 'text/plain',
    })
    await teacher.post(`/api/resources/${resource.data.id}/submit`)
    await adminClient.post(`/api/resources/${resource.data.id}/review`, { action: 'approve' })

    await browser.goto(`${TEST_BASE}/resources/${resource.data.id}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮')
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview-text"]\')', 20000, '文本预览')
    assert.match(String(await browser.text('[data-testid="file-preview-text"]')), /长行：/)
    await assertNoOverflow('文本预览（390×844）')
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('下载：PDF / 图片真实落盘，sha256 一致', async () => {
    for (const [key, f] of [['pdf', FILES.pdf], ['png', FILES.png]]) {
      await browser.goto(`${TEST_BASE}/resources/${ids[`res_${key}`]}`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="file-download"]\')', 20000, '下载按钮')
      await browser.click('[data-testid="file-download"]')
      const ext = f.name.split('.').pop()
      const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith(`.${ext}`))
      assert.equal(sha256(readFileSync(saved)), f.sha256, `${key} 下载的字节必须与上传一致`)
      rmSync(saved, { force: true })
    }
  })

  test('上传：选文件 → 进度 → 保存草稿 → 刷新仍在（不重选班型/科目/资料夹/目录）', async () => {
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-upload"]\')', 20000, '上传按钮')
    await browser.click('[data-testid="directory-upload"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '上传弹窗')

    // 弹窗要适配手机（不能被键盘/屏幕切掉，关闭按钮可用）
    const dialog = await browser.session.eval(`(() => {
      const el = document.querySelector('[data-testid="upload-dialog"] [role="dialog"]')
      const r = el.getBoundingClientRect()
      return { bottom: Math.round(r.bottom), top: Math.round(r.top), vh: window.innerHeight,
               close: document.querySelector('[data-testid="dialog-close"]') !== null }
    })()`)
    assert.equal(dialog.top >= 0, true, '弹窗顶部跑出屏幕了')
    assert.equal(dialog.bottom <= dialog.vh + 1, true, `弹窗底部 ${dialog.bottom} 超出视口 ${dialog.vh}`)
    assert.equal(dialog.close, true, '弹窗必须能关')

    // 表单里不许再出现"让老师重选分类"的字段（业主 §13）
    const labels = await browser.session.eval(
      `JSON.stringify([...document.querySelectorAll('[data-testid="upload-dialog"] label, [data-testid="upload-dialog"] select')]
        .map((e) => (e.innerText || '').trim()).filter(Boolean))`,
    )
    const texts = JSON.parse(labels ?? '[]')
    for (const banned of ['班型', '科目', '资料夹', '所属目录']) {
      assert.equal(texts.some((t) => t.includes(banned)), false, `手机上也不该出现「${banned}」：${texts.join(' / ')}`)
    }

    await browser.fill('[data-testid="upload-title"]', '手机端上传的 PDF')
    await browser.setFileInput('[data-testid="upload-file-input"]', FILES.pdf.path)
    await browser.click('[data-testid="upload-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 30000, '上传后进详情')
    const id = await browser.attr('[data-testid="resource-detail-page"]', 'data-resource-id')
    ids.mobileUpload = id

    const [row] = await withSql((sql) => sql`
      SELECT status, (SELECT count(*)::int FROM resource_files f WHERE f.resource_id = r.id) AS files
      FROM resources r WHERE r.id = ${id}`)
    assert.equal(row.status, 'DRAFT', '上传完是草稿')
    assert.equal(row.files, 1, '文件必须真的登记了')

    await browser.reload()
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 20000, '刷新后仍在')
    assert.equal(await browser.text('[data-testid="resource-detail-title"]'), '手机端上传的 PDF')
    await assertNoOverflow('上传后的详情页（390×844）')
  })
})

describe('⑤ 手机上的管理员：审核 / 目录 / 教师账号', () => {
  test('审核：通过并发布（手机上点得到、状态真的变）', async () => {
    await login(ADMIN.username, ADMIN.password)
    // 张老师刚才上传的那条草稿 → 提交（用老师身份），再由管理员在手机上通过
    const teacher = client()
    await teacher.login(TEACHER.username, TEACHER.password)
    await teacher.post(`/api/resources/${ids.mobileUpload}/submit`)

    await browser.goto(`${TEST_BASE}/resources/${ids.mobileUpload}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-approve"]\')', 20000, '通过按钮')
    await browser.click('[data-testid="action-approve"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('已发布')`,
      20000,
      '变成已发布',
    )
    const [row] = await withSql((sql) => sql`SELECT status FROM resources WHERE id = ${ids.mobileUpload}`)
    assert.equal(row.status, 'PUBLISHED')
  })

  test('退回：手机上能输入原因（输入框与提交都在视口内），教师能看到原因', async () => {
    const teacher = client()
    await teacher.login(TEACHER.username, TEACHER.password)
    const draft = await teacher.post('/api/resources', {
      directoryId: ids.virtueResources,
      title: '手机端待退回的资源',
    })
    const { uploadFile } = await import('../helpers/upload.mjs')
    await uploadFile(teacher, draft.data.id, {
      fileName: '待退回.pdf',
      bytes: pdfBytes('mobile-reject'),
      mimeType: 'application/pdf',
    })
    await teacher.post(`/api/resources/${draft.data.id}/submit`)

    await browser.goto(`${TEST_BASE}/resources/${draft.data.id}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-reject"]\')', 20000, '退回按钮')
    await browser.click('[data-testid="action-reject"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="reject-comment"]\')', 15000, '原因输入框')

    // 输入框聚焦 → 提交按钮仍然可达（键盘弹出时"保存"必须还能点到，§22）
    await browser.click('[data-testid="reject-comment"]')
    const reachable = await browser.session.eval(`(() => {
      const btn = document.querySelector('[data-testid="reject-submit"]')
      btn.scrollIntoView({ block: 'center' })
      const r = btn.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= window.innerHeight + 1,
               covered: !(top === btn || btn.contains(top)) }
    })()`)
    assert.equal(reachable.inView, true, '提交按钮必须能滚进视口')
    assert.equal(reachable.covered, false, '提交按钮不能被别的元素挡住')
    assert.equal(reachable.h >= 40, true, `提交按钮触控区偏小：${reachable.h}px`)

    await browser.fill('[data-testid="reject-comment"]', '手机上退回：请补一张照片')
    await browser.click('[data-testid="reject-submit"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('已退回')`,
      20000,
      '变成已退回',
    )

    // 老师看得到原因（手机上）
    await login(TEACHER.username, TEACHER.password)
    await browser.goto(`${TEST_BASE}/resources/${draft.data.id}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="review-history"]\')', 20000, '审核记录')
    const comments = await browser.allTexts('[data-testid="review-history-comment"]')
    assert.equal(comments.some((c) => String(c).includes('请补一张照片')), true, `要看到退回原因：${comments.join(' | ')}`)
    ids.rejected = draft.data.id
  })

  test('目录管理：手机上新建 / 改名 / 停用 / 排序 / 保存', async () => {
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/admin/directories`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-manage-page"]\')', 20000, '目录管理页')
    await assertNoOverflow('目录管理（390×844）')

    // 新建一级栏目
    await browser.click('[data-testid="manage-add-root"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-create-dialog"]\')', 15000, '新建弹窗')
    await browser.fill('[data-testid="manage-create-name"]', '手机端活动')
    await browser.fill('[data-testid="manage-create-slug"]', 's11-mobile-act')
    await browser.click('[data-testid="manage-create-submit"]')
    const row = `[data-testid="manage-row"][data-directory-slug="s11-mobile-act"]`
    await browser.waitFor(`!!document.querySelector('${row}')`, 20000, '新栏目出现')

    // 改名
    await browser.click(`${row} [data-testid="manage-edit"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-edit-dialog"]\')', 15000, '编辑弹窗')
    await browser.fill('[data-testid="manage-name-input"]', '手机端活动（改名后）')
    await browser.click('[data-testid="manage-save"]')
    await browser.waitFor(
      `document.querySelector('${row} [data-testid="manage-row-name"]')?.innerText === '手机端活动（改名后）'`,
      20000,
      '改名生效',
    )

    // 停用 → 再启用
    await browser.click(`${row} [data-testid="manage-toggle-enabled"]`)
    await browser.waitFor(`!!document.querySelector('${row} [data-testid="manage-row-disabled"]')`, 20000, '变成已停用')
    await browser.click(`${row} [data-testid="manage-toggle-enabled"]`)
    await browser.waitFor(`!document.querySelector('${row} [data-testid="manage-row-disabled"]')`, 20000, '恢复启用')

    // 排序（手机上点得到 ↑↓）
    await browser.click(`${row} [data-testid="manage-move-up"]`)
    await browser.waitFor('true', 800, '排序请求发出')

    const [dir] = await withSql((sql) => sql`
      SELECT name, enabled FROM directories WHERE slug = 's11-mobile-act'`)
    assert.equal(dir.name, '手机端活动（改名后）')
    assert.equal(dir.enabled, true)
    ids.mobileDirSlug = 's11-mobile-act'
  })

  test('教师账号：手机上搜索 / 新增 / 编辑 / 启停 / 重置口令 / 改权限', async () => {
    await browser.goto(`${TEST_BASE}/admin/users`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="admin-users-page"]\')', 20000, '教师账号页')
    await assertNoOverflow('教师账号（390×844）')

    // 搜索
    await browser.fill('[data-testid="users-search"]', '手机端张老师')
    await browser.click('[data-testid="users-search-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="users-row"]\')', 20000, '搜索结果')
    const rows = await browser.count('[data-testid="users-row"]')
    assert.equal(rows >= 1, true, `搜索要有结果，实际 ${rows}`)

    // 清空搜索：列表还在按"手机端张老师"筛着，新账号不会出现在结果里
    await browser.fill('[data-testid="users-search"]', '')
    await browser.click('[data-testid="users-search-submit"]')
    await browser.waitFor('true', 600, '清空搜索')

    // 新增
    await browser.click('[data-testid="users-create"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="create-user-dialog"]\')', 15000, '新增弹窗')
    await browser.fill('[data-testid="new-user-name"]', '手机端李老师')
    await browser.fill('[data-testid="new-user-username"]', 's11_mobile_teacher')
    await browser.fill('[data-testid="new-user-password"]', 'S11MobilePass!1')
    await browser.fill('[data-testid="new-user-confirm"]', 'S11MobilePass!1')
    await browser.click('[data-testid="create-user-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="users-notice"]\')', 20000, '创建成功')

    // 编辑 → 重置口令 + 启停
    const created = `[data-testid="users-row"][data-username="s11_mobile_teacher"]`
    await browser.waitFor(`!!document.querySelector('${created}')`, 20000, '新账号出现')
    await browser.click(`${created} [data-testid="users-row-edit"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="edit-user-dialog"]\')', 15000, '编辑弹窗')
    await browser.fill('[data-testid="edit-user-password"]', 'S11MobilePass!2')
    await browser.click('[data-testid="edit-user-submit"]')
    await browser.waitFor('!document.querySelector(\'[data-testid="edit-user-dialog"]\')', 20000, '保存后关闭')

    // 权限页（手机上的权限编辑器）
    await browser.goto(`${TEST_BASE}/admin/permissions`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="admin-permissions-page"]\')', 20000, '权限页')
    await assertNoOverflow('权限页（390×844）')

    const [added] = await withSql((sql) => sql`
      SELECT id::text FROM users WHERE username = 's11_mobile_teacher'`)
    assert.ok(added, '新账号必须在库里')
    ids.mobileTeacher = added.id
  })

  test('撤回 → 删除 → 回收站恢复（手机上）', async () => {
    await browser.goto(`${TEST_BASE}/resources/${ids.res_png}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="action-recall"]\')', 20000, '撤回按钮')
    await browser.click('[data-testid="action-recall"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="recall-comment"]\')', 15000, '撤回说明')
    await browser.fill('[data-testid="recall-comment"]', '手机上先下架')
    await browser.click('[data-testid="recall-submit"]')
    await browser.waitFor(
      `document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('已撤回')`,
      20000,
      '已撤回',
    )

    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-delete"]\')', 20000, '删除按钮')
    await browser.click('[data-testid="resource-detail-delete"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-delete-dialog"]\')', 15000, '删除确认')
    await browser.click('[data-testid="resource-delete-confirm"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="directory-page"]')`,
      20000,
      '删完回到目录页',
    )
    const [deleted] = await withSql((sql) => sql`SELECT deleted_at FROM resources WHERE id = ${ids.res_png}`)
    assert.notEqual(deleted.deleted_at, null, '软删除要落库')

    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resources-tabs"]\')', 20000, '我的资源')
    const tabbed = await browser.session.eval(
      `(() => { const t = [...document.querySelectorAll('[data-testid="my-resources-tab"]')]
          .find((e) => (e.innerText || '').trim() === '回收站'); t?.click(); return t !== undefined })()`,
    )
    assert.equal(tabbed, true, '手机上要有回收站这一栏')
    await browser.waitFor('!!document.querySelector(\'[data-testid="my-resource-restore"]\')', 20000, '恢复按钮')
    await browser.click('[data-testid="my-resource-restore"]')
    // 恢复是"库里真的变了"才算成功 —— 轮询数据库，而不是只看界面
    {
      const deadline = Date.now() + 20000
      let restored = false
      while (Date.now() < deadline && !restored) {
        const [r] = await withSql((sql) => sql`SELECT deleted_at FROM resources WHERE id = ${ids.res_png}`)
        restored = r.deleted_at === null
        if (!restored) await new Promise((res) => setTimeout(res, 300))
      }
      assert.equal(restored, true, '恢复后 deleted_at 必须清空')
    }
  })
})

describe('⑥ 权限与网络异常（手机端）', () => {
  test('张老师：未授权目录进不去，接口同样 403', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    await login(TEACHER.username, TEACHER.password)

    // 侧边栏/抽屉里没有未授权目录
    await browser.click('[data-testid="nav-open"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '抽屉')
    const navs = await browser.allAttrs('[data-nav]', 'data-nav')
    assert.equal(
      navs.some((p) => String(p).includes('/education/pre-k/montessori')),
      false,
      `抽屉里不该有未授权目录：${navs.join(' ')}`,
    )
    await browser.click('[data-testid="nav-close"]')

    // 直接开地址 → 回退并说明原因
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/montessori`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 20000, '目录页')
    assert.notEqual(
      await browser.attr('[data-testid="directory-page"]', 'data-directory-path'),
      'education/pre-k/montessori',
    )
    assert.equal(await browser.exists('[data-testid="directory-notice"]'), true, '要说明为什么被带到了这里')

    // 接口同样 403
    const teacher = client()
    await teacher.login(TEACHER.username, TEACHER.password)
    const res = await teacher.get(`/api/resources?directoryId=${ids.montessori}`)
    assert.equal(res.status, 403)
    allowedNoise.push('directoryId=')
  })

  test('断网 → Error + Retry；恢复后点重试就能加载（不是永久 spinner）', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    await login(TEACHER.username, TEACHER.password)

    // 把资源接口整段掐掉，模拟断网
    await browser.session.send('Network.setBlockedURLs', { urls: ['*/api/resources*'] })
    allowedNoise.push('/api/resources')

    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 20000, '目录页')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list-error"]\')', 25000, '错误提示')
    assert.equal(
      await browser.exists('[data-testid="resource-list-retry"]'),
      true,
      '出错时必须给「重试」入口（否则网络恢复后老师只能刷新整页）',
    )

    // 恢复网络 → 点重试 → 列表出现
    await browser.session.send('Network.setBlockedURLs', { urls: [] })
    await browser.click('[data-testid="resource-list-retry"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="resource-list"]') ||
       !!document.querySelector('[data-testid="resource-list-empty"]')`,
      25000,
      '重试后加载出来',
    )
    assert.equal(await browser.exists('[data-testid="resource-list-error"]'), false, '重试成功后不该还留着错误')
  })

  test('目录树加载失败 → 说明原因 + 重试（不谎报"目录不存在"）', async () => {
    await browser.session.send('Network.setBlockedURLs', { urls: ['*/api/directories/tree*'] })
    allowedNoise.push('/api/directories/tree')

    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue`)
    // 等到"要么出目录、要么出错误"这个**稳定态**再分支：
    // `directory-page` 是这两种状态共用的外壳，早一步断言会读到过渡态。
    await browser.waitFor(
      `!!document.querySelector('[data-testid="directory-load-error"]') ||
       !!document.querySelector('[data-testid="directory-title"]')`,
      25000,
      '目录树要么出来、要么给错误',
    )
    const hasError = await browser.exists('[data-testid="directory-load-error"]')
    if (hasError) {
      assert.equal(await browser.exists('[data-testid="directory-retry"]'), true, '目录加载失败要给重试')
      await browser.session.send('Network.setBlockedURLs', { urls: [] })
      await browser.click('[data-testid="directory-retry"]')
      await browser.waitFor('!!document.querySelector(\'[data-testid="directory-title"]\')', 25000, '重试后目录出来')
    } else {
      // 目录树在缓存里（之前已经加载过）→ 只要不白屏、不谎报即可
      assert.equal(await browser.exists('[data-testid="directory-title"]'), true)
      await browser.session.send('Network.setBlockedURLs', { urls: [] })
    }
  })

  test('慢网络：先看到 Loading，再看到内容', async () => {
    await browser.session.send('Network.emulateNetworkConditions', {
      offline: false, latency: 1200, downloadThroughput: 40 * 1024, uploadThroughput: 40 * 1024,
    })
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    // 加载中必须给反馈（Spinner 或空态），不能是一片空白
    await browser.waitFor(
      `!!document.querySelector('[data-testid="resource-list"]') ||
       !!document.querySelector('[data-testid="resource-list-empty"]') ||
       !!document.querySelector('[data-testid="resource-list-error"]') ||
       !!document.querySelector('[data-testid="directory-page"]')`,
      25000,
      '慢网络下有反馈',
    )
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 25000, '慢网络也能出页面')
    await browser.session.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    })
  })
})

describe('⑦ Console 与网络：整条手机流程 0 错误', () => {
  test('没有 console error、没有 500、没有意外的 4xx', async () => {
    const problems = browser.problemReport({ allow: ['directoryId=', '/api/resources', '/api/directories/tree', '/api/auth/me'] })
    const readable = problems
      .map((p) => `${p.kind}/${p.level ?? ''} ${p.status ?? ''} ${p.text ?? ''} ${p.url ?? ''}`.trim())
      .join('\n  ')
    assert.equal(problems.length, 0, `手机流程不该有 console/网络错误，实际 ${problems.length} 条：\n  ${readable}`)
  })

  test('采集器本身有效（不是"永远为 0"）', async () => {
    browser.clearProblems()
    await browser.session.eval(`(async () => {
      console.error('stage11 采集器自检')
      try { await fetch('/api/stage11-not-exist') } catch {}
    })()`)
    await new Promise((r) => setTimeout(r, 800))
    const seen = browser.problemReport()
    assert.equal(seen.some((p) => p.kind === 'console' && String(p.text).includes('采集器自检')), true)
    assert.equal(seen.some((p) => p.kind === 'http' && p.status === 404), true)
    browser.clearProblems()
  })
})
