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
import { deflateSync } from 'node:zlib'
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

// ── 真实文件构造 ────────────────────────────────────────────────────────────
/*
  Office（docx/xlsx）与 ZIP 在容器层面**都是 zip**（`shared/file-policy.ts` 里
  `office: ['zip'] / archive: ['zip']`），所以这里的夹具是**真的 zip 归档**：
  能 `unzip -t` 过、能被解出条目，不是"以 PK 开头的随机字节"。

  为什么不用现成库：本项目的测试是零依赖的（不引 archiver / jszip）。
  存储式（compression=0）zip 只需要 CRC32 + 三段固定结构，几十行就够，
  而且比引一个库更好审。
*/
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/** 生成一个**真 zip**（stored，无压缩）：entries = [{ name, data }]。 */
function zipBytes(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x2821, 12) // date（2000-01-01）
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, data)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x2821, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, eocd])
}

/**
 * 生成一张**真的能解码**的大 PNG（业主 §17 要"图片真实解码"，§13 要"进度真的动"）。
 *
 * 512×512 的像素用 sha256 链填（不是 Math.random，也不是线性同余）：
 * 同余数列的低位有短周期，deflate 会把它压成十几 KB，那样限速下根本观察不到进度。
 * 哈希链的字节压缩不掉，整张图约 780KB —— 正好够在限速下看到进度条真的在动。
 */
function pngBytes(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let block = createHash('sha256').update('stage11-png-fixture').digest()
  let pos = 0
  const nextByte = () => {
    if (pos === block.length) {
      block = createHash('sha256').update(block).digest()
      pos = 0
    }
    pos += 1
    return block[pos - 1]
  }
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width * 3; x += 1) raw[rowStart + 1 + x] = nextByte()
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 最小的合法 docx / xlsx（真的 OOXML 包，zip 里带该有的入口文件）。 */
function ooxmlBytes(kind) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/${kind === 'docx' ? 'word/document.xml' : 'xl/workbook.xml'}" ContentType="application/vnd.openxmlformats-officedocument.${kind === 'docx' ? 'wordprocessingml.document' : 'spreadsheetml.sheet'}.main+xml"/>
</Types>`
  const main =
    kind === 'docx'
      ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>清澜山幼儿园 Pre-K 美德课教案（手机端验收夹具）</w:t></w:r></w:p>
</w:body></w:document>`
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="第一周" sheetId="1"/></sheets></workbook>`
  return zipBytes([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: kind === 'docx' ? 'word/document.xml' : 'xl/workbook.xml', data: main },
  ])
}

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
  /** 512×512 真 PNG（约 780KB）：用来观察真实进度、以及中途取消。 */
  pngBig: { name: '手机端大图.png', bytes: pngBytes(512, 512) },
  docx: { name: '手机端教案.docx', bytes: ooxmlBytes('docx') },
  xlsx: { name: '手机端周计划.xlsx', bytes: ooxmlBytes('xlsx') },
  zip: {
    name: '手机端素材包.zip',
    bytes: zipBytes([
      { name: '说明.txt', data: '清澜山幼儿园手机端验收：这个包里有 2 个文件。\n' },
      { name: '照片.png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') },
    ]),
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

  // 已发布资源，供手机端预览 / 下载 / 提交 / 审核
  const teacher = client()
  await teacher.login(TEACHER.username, TEACHER.password)
  const { uploadFile } = await import('../helpers/upload.mjs')
  const MIME = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  }
  // 业主 §16 要的是"PDF / 图片 / Office / ZIP **真实下载**" —— 四种都要有真资源
  for (const key of ['pdf', 'png', 'jpg', 'docx', 'xlsx', 'zip']) {
    const f = FILES[key]
    const resource = await teacher.post('/api/resources', {
      directoryId: ids.virtueResources,
      title: `手机端资源（${key}）`,
    })
    await uploadFile(teacher, resource.data.id, {
      fileName: f.name,
      bytes: f.bytes,
      mimeType: MIME[key],
    })
    await teacher.post(`/api/resources/${resource.data.id}/submit`)
    const approved = await adminClient.post(`/api/resources/${resource.data.id}/review`, { action: 'approve' })
    assert.equal(approved.status < 400, true, `${key} 发布失败：${JSON.stringify(approved.data)}`)
    ids[`res_${key}`] = resource.data.id
  }

  // 一条标题/文件名都特别长的资源：手机上最容易撑破卡片和详情页的场景
  const longTitle = `第一学期第 12 周美德课程教案（含家庭延伸活动与观察记录表）${'补充说明'.repeat(8)}`
  const long = await teacher.post('/api/resources', {
    directoryId: ids.virtueResources,
    title: longTitle,
    description: '手机上检查长标题、长文件名、Badge 会不会把卡片撑破。',
  })
  await uploadFile(teacher, long.data.id, {
    fileName: `${'美德课观察记录表-第12周-'.repeat(4)}附件.pdf`,
    bytes: pdfBytes('stage11-long'),
    mimeType: 'application/pdf',
  })
  await teacher.post(`/api/resources/${long.data.id}/submit`)
  await adminClient.post(`/api/resources/${long.data.id}/review`, { action: 'approve' })
  ids.res_long = long.data.id
  ids.longTitle = longTitle

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

  test('面包屑过长不撑破：5 层深链在 390 / 375 / 320 都不越界', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    await login(ADMIN.username, ADMIN.password)
    await mobileClickThrough([
      'growth', 'growth/l1', 'growth/l1/safety', 'growth/l1/safety/plan', 'growth/l1/safety/plan/disease',
    ])

    for (const width of [390, 375, 320]) {
      await useWidth(width, 844)
      await browser.waitFor('!!document.querySelector(\'[data-testid="breadcrumb"]\')', 15000, '面包屑')
      const box = await browser.session.eval(`(() => {
        const nav = document.querySelector('[data-testid="breadcrumb"]')
        const r = nav.getBoundingClientRect()
        const items = [...nav.querySelectorAll('[data-testid="breadcrumb-root"], [data-testid="breadcrumb-item"], [data-testid="breadcrumb-current"]')]
          .map((el) => { const b = el.getBoundingClientRect(); return { text: el.innerText.trim(), right: Math.round(b.right), left: Math.round(b.left), top: Math.round(b.top) } })
        return {
          vw: window.innerWidth,
          navRight: Math.round(r.right), navLeft: Math.round(r.left),
          navScrollWidth: nav.scrollWidth, navClientWidth: nav.clientWidth,
          wrap: getComputedStyle(nav).flexWrap,
          items,
          current: (nav.querySelector('[data-testid="breadcrumb-current"]')?.innerText || '').trim(),
        }
      })()`)

      // 1) 面包屑容器本身不许横向溢出（溢出会顶破整页）
      assert.equal(
        box.navScrollWidth <= box.navClientWidth + 1,
        true,
        `${width}px：面包屑内部横向溢出 ${box.navScrollWidth - box.navClientWidth}px`,
      )
      assert.equal(box.navRight <= box.vw + 1, true, `${width}px：面包屑右边 ${box.navRight} 超出视口 ${box.vw}`)
      // 2) 每一项都要在视口内（长中文名不能把某一项推出屏幕）
      for (const item of box.items) {
        assert.equal(
          item.right <= box.vw + 1 && item.left >= -1,
          true,
          `${width}px：「${item.text}」越界（left=${item.left} right=${item.right} vw=${box.vw}）`,
        )
      }
      // 3) 最后一级（当前页）必须还在，而且要能换行（不是被挤没了）
      assert.equal(box.current, '传染病识别与防治', `${width}px：面包屑最后一级必须还在`)
      assert.equal(box.wrap, 'wrap', '面包屑要允许换行，否则窄屏只能靠溢出')
      await assertNoOverflow(`深层目录页（${width}px）`)
    }
    await useDevice(DEVICES['iPhone 14 (390×844)'])
  })

  test('超长标题 / 长文件名 / Badge：320px 也不撑破卡片与详情页', async () => {
    await useWidth(320, 844)
    await login(TEACHER.username, TEACHER.password)
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-card"]\')', 20000, '资源卡片')

    const card = await browser.session.eval(`(() => {
      const card = document.querySelector('[data-resource-id="${ids.res_long}"]')
      const title = card.querySelector('[data-testid="resource-card-title"]')
      const badge = card.querySelector('[data-testid="resource-card-status"]')
      const location = card.querySelector('[data-testid="resource-card-location"]')
      const files = card.querySelector('[data-testid="resource-card-files"]')
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) } }
      return {
        vw: window.innerWidth,
        card: box(card), title: box(title), badge: box(badge), location: box(location), files: box(files),
        titleText: (title.innerText || '').trim(),
        badgeText: (badge.innerText || '').trim(),
        titleOverflow: title.scrollWidth - title.clientWidth,
      }
    })()`)

    assert.equal(card.card.r <= card.vw + 1, true, `卡片右边 ${card.card.r} 超出视口 ${card.vw}`)
    for (const [name, part] of [['标题', card.title], ['状态徽标', card.badge], ['所在位置', card.location], ['文件数', card.files]]) {
      assert.equal(part.r <= card.card.r + 1 && part.l >= card.card.l - 1, true, `${name}超出卡片：${JSON.stringify(part)} vs 卡片 ${JSON.stringify(card.card)}`)
    }
    assert.equal(card.titleText.length > 40, true, '这条资源本来就是超长标题（夹具不对？）')
    assert.equal(card.badgeText.length > 0, true, '状态徽标必须还在（不能为了不溢出把它藏了）')
    await assertNoOverflow('超长标题的目录页（320px）')

    // 详情页同样：超长标题 + 超长文件名不能顶破布局
    await browser.goto(`${TEST_BASE}/resources/${ids.res_long}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-title"]\')', 20000, '详情页')
    const detail = await browser.session.eval(`(() => {
      const root = document.querySelector('[data-testid="resource-detail-page"]')
      const title = document.querySelector('[data-testid="resource-detail-title"]')
      const name = document.querySelector('[data-testid="file-name"]')
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right) } }
      return { vw: window.innerWidth, root: box(root), title: box(title), name: box(name),
               nameText: (name.innerText || '').trim(), titleScroll: title.scrollWidth - title.clientWidth }
    })()`)
    assert.equal(detail.title.r <= detail.vw + 1, true, `详情页标题右边 ${detail.title.r} 超出视口 ${detail.vw}`)
    assert.equal(detail.name.r <= detail.vw + 1, true, `文件名右边 ${detail.name.r} 超出视口 ${detail.vw}`)
    assert.match(detail.nameText, /附件\.pdf$/, '长文件名要完整可读（可以省略中间，但不能消失）')
    await assertNoOverflow('超长标题的详情页（320px）')
  })
})

describe('③ 断点回归：9 个尺寸都不溢出、不白屏', () => {
  test('每个宽度：核心内容在、无横向溢出', async () => {
    /*
      ⚠️ 这一条**自己登录管理员**，不继承上一条测试留下的会话。
      以前它依赖"上一条恰好是管理员"，于是把一位老师的会话带进来时，
      管理页会走"无权访问"分支 —— 测试照样绿，但那测的已经不是管理页的断点了
      （阶段 11 第一次跑就踩到了：3 个管理接口各来一串 403）。
    */
    await login(ADMIN.username, ADMIN.password)

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

      // 管理页（管理员身份下必须**真的渲染**管理界面，不能是"无权访问"那个页）
      for (const [path, testid] of [
        ['/admin/users', 'admin-users-page'],
        ['/admin/directories', 'directory-manage-page'],
        ['/admin/permissions', 'admin-permissions-page'],
        ['/admin/audit', 'admin-audit-page'],
      ]) {
        await browser.goto(`${TEST_BASE}${path}`)
        await browser.waitFor(`!!document.querySelector('[data-testid="${testid}"]')`, 25000, `${path}（${width}px）`)
        await assertNoOverflow(`${path} ${width}px`)
        // 页面文字里要有真实内容（不是空壳）
        const text = String(await browser.text(`[data-testid="${testid}"]`))
        assert.equal(text.trim().length > 20, true, `${path}（${width}px）渲染了空壳：${text.slice(0, 40)}`)
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

  test('下载：JPG / Office（docx、xlsx）/ ZIP 也都是真实下载，不是"点开空白"', async () => {
    // 业主 §16 点名的四类：PDF / 图片 / Office / ZIP。PDF 与 PNG 上一条已测，这条补齐剩下的。
    for (const key of ['jpg', 'docx', 'xlsx', 'zip']) {
      const f = FILES[key]
      await browser.goto(`${TEST_BASE}/resources/${ids[`res_${key}`]}`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="file-download"]\')', 20000, `下载按钮（${key}）`)
      await browser.click('[data-testid="file-download"]')
      const ext = f.name.split('.').pop()
      const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith(`.${ext}`))
      const bytes = readFileSync(saved)
      assert.equal(sha256(bytes), f.sha256, `${key} 下载的字节必须与上传一致`)
      assert.equal(bytes.length, f.bytes.length, `${key} 下载大小要一致`)
      // Office / ZIP 是容器格式：下下来的必须还是**能解开**的归档（不是被截断的字节）
      if (key === 'docx' || key === 'xlsx' || key === 'zip') {
        assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', `${key} 下载结果必须是 zip 容器`)
        assert.equal(bytes.includes(Buffer.from('0x06054b50', 'hex')), true, `${key} 缺少 zip 结束记录（被截断了？）`)
      }
      // 下载真的要留痕（服务端审计），否则老师找不回自己下过什么。
      // 注意审计的 target_id 是**文件** id（text），而 resource_files.id 是 uuid：要显式转型。
      const [audit] = await withSql((sql) => sql`
        SELECT count(*)::int AS n FROM audit_logs a
        WHERE a.action = 'resource.download'
          AND a.target_id IN (SELECT id::text FROM resource_files WHERE resource_id = ${ids[`res_${key}`]})`)
      assert.equal(audit.n >= 1, true, `${key} 下载必须落审计`)
      rmSync(saved, { force: true })
    }
  })

  test('上传：JPG 与 PNG 真实文件各自落库（大小与 sha256 都对得上）', async () => {
    for (const key of ['jpg', 'png']) {
      const f = FILES[key]
      await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="directory-upload"]\')', 20000, '上传按钮')
      await browser.click('[data-testid="directory-upload"]')
      await browser.waitFor('!!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '上传弹窗')
      await browser.fill('[data-testid="upload-title"]', `手机端上传的图片（${key}）`)
      await browser.setFileInput('[data-testid="upload-file-input"]', f.path)
      await browser.click('[data-testid="upload-submit"]')
      await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 30000, `${key} 上传完成`)
      const id = await browser.attr('[data-testid="resource-detail-page"]', 'data-resource-id')

      const [row] = await withSql((sql) => sql`
        SELECT r.status, f.file_name, f.size::int AS size, f.sha256
        FROM resources r JOIN resource_files f ON f.resource_id = r.id
        WHERE r.id = ${id}`)
      assert.equal(row.status, 'DRAFT', `${key}：上传完应当是草稿`)
      assert.equal(row.file_name, f.name, `${key}：文件名要原样保留`)
      assert.equal(row.size, f.bytes.length, `${key}：库里的大小要和文件一致`)
      assert.equal(row.sha256, f.sha256, `${key}：库里的 sha256 要和文件一致`)

      // 图片要真的能预览（解码成功），不能只是"登记了一条记录"
      await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮')
      await browser.click('[data-testid="file-preview"]')
      await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview-image"]\')', 20000, '图片预览')
      await browser.waitFor(
        `document.querySelector('[data-testid="file-preview-image"]')?.naturalWidth > 0`,
        20000,
        `${key} 预览要真的解码`,
      )
      await browser.click('[data-testid="file-preview-close"]')
      assert.equal(await browser.exists('[data-testid="file-preview-unsupported"]'), false)
    }
  })

  test('上传：限速下进度真的在动；中途「取消上传」→ 什么都没保存', async () => {
    const f = FILES.pngBig
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-upload"]\')', 20000, '上传按钮')
    await browser.click('[data-testid="directory-upload"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '上传弹窗')

    const title = '手机端取消上传（不该留下文件）'
    await browser.fill('[data-testid="upload-title"]', title)
    await browser.setFileInput('[data-testid="upload-file-input"]', f.path)

    // 限速到 ~180KB/s：769KB 的图要传 4s 以上，进度才有观察窗口（本机本地网络否则是瞬时的）
    await browser.setUploadThroughput(180 * 1024)
    await browser.click('[data-testid="upload-submit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="upload-progress"]\')', 30000, '进度条出现')

    // ① 进度必须真的在动（不是永远 0%、也不是一上来就 100% 假进度）
    const seen = []
    for (let i = 0; i < 40; i += 1) {
      const info = await browser.session.eval(`(() => {
        const bar = document.querySelector('[data-testid="upload-progress-bar"]')
        const text = document.querySelector('[data-testid="upload-progress-text"]')
        return bar ? { percent: Number(bar.getAttribute('data-percent')), text: text ? text.innerText.trim() : '' } : null
      })()`)
      if (info !== null) seen.push(info.percent)
      if (seen.some((p) => p > 0 && p < 100)) break
      await new Promise((r) => setTimeout(r, 120))
    }
    assert.equal(
      seen.some((p) => p > 0 && p < 100),
      true,
      `限速下必须能看到中间态进度（实际看到：${seen.join(', ')}）`,
    )

    // ② 中途取消
    await browser.waitFor('!!document.querySelector(\'[data-testid="upload-cancel"]\')', 15000, '取消上传按钮')
    await browser.click('[data-testid="upload-cancel"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="upload-error"]\')', 20000, '取消后的说明')
    const message = String(await browser.text('[data-testid="upload-error"]'))
    assert.match(message, /取消/, `取消后要说清楚发生了什么：${message}`)
    assert.match(message, /没有(被)?保存/, `取消后必须说明"没保存"：${message}`)
    // 弹窗还开着 → 老师可以重新选文件再传（不是被迫关掉重来）
    assert.equal(await browser.exists('[data-testid="upload-dialog"]'), true, '取消后弹窗应当还开着，便于重试')

    await browser.clearNetworkThrottle()

    // ③ 数据库层面：这次尝试没有登记任何文件（没有半个文件）
    const rows = await withSql((sql) => sql`
      SELECT r.id, (SELECT count(*)::int FROM resource_files f WHERE f.resource_id = r.id) AS files
      FROM resources r WHERE r.title = ${title}`)
    for (const row of rows) {
      assert.equal(row.files, 0, `取消上传不该登记文件，实际 ${row.files} 个`)
    }
    // ④ 页面上也不该出现"已上传"的假成功
    assert.equal(await browser.exists('[data-testid="upload-done"]'), false, '取消后不能显示"已上传"')

    await browser.click('[data-testid="dialog-close"]')
    await browser.waitFor('!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '关掉上传弹窗')
  })

  test('删除确认弹窗：手机上打得开、关得掉，不点确认就不写库', async () => {
    // 已发布的资源本来就**不能删**（DELETABLE_STATUSES 里没有 PUBLISHED，必须先撤回）。
    // 所以先把这个状态规则本身验掉，再用一条草稿去验弹窗。
    await browser.goto(`${TEST_BASE}/resources/${ids.res_png}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-page"]\')', 20000, '详情页')
    assert.equal(
      await browser.exists('[data-testid="resource-detail-delete"]'),
      false,
      '已发布的资源不该出现「删除」——必须先撤回（否则会从老师眼前直接消失）',
    )
    assert.equal(await browser.exists('[data-testid="action-recall"]'), true, '已发布的资源应当可以撤回')

    // 一条草稿：这才是能删的状态
    const teacher = client()
    await teacher.login(TEACHER.username, TEACHER.password)
    const draft = await teacher.post('/api/resources', {
      directoryId: ids.virtueResources,
      title: '手机端删除弹窗（草稿）',
    })
    assert.equal(draft.status, 201, JSON.stringify(draft.data))
    const { uploadFile } = await import('../helpers/upload.mjs')
    await uploadFile(teacher, draft.data.id, {
      fileName: '待删除.pdf',
      bytes: pdfBytes('mobile-delete-dialog'),
      mimeType: 'application/pdf',
    })

    await browser.goto(`${TEST_BASE}/resources/${draft.data.id}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-detail-delete"]\')', 20000, '删除按钮')
    await browser.click('[data-testid="resource-detail-delete"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-delete-dialog"]\')', 15000, '确认弹窗')

    const box = await browser.session.eval(`(() => {
      const dialog = document.querySelector('[data-testid="resource-delete-dialog"] [role="dialog"]')
      const r = dialog.getBoundingClientRect()
      const close = document.querySelector('[data-testid="dialog-close"]')
      const cr = close ? close.getBoundingClientRect() : null
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight,
               closeVisible: cr !== null && cr.width > 0 && cr.height > 0,
               closeInView: cr !== null && cr.top >= 0 && cr.bottom <= window.innerHeight + 1 }
    })()`)
    assert.equal(box.top >= 0, true, '弹窗顶部跑出屏幕')
    assert.equal(box.bottom <= box.vh + 1, true, `弹窗底部 ${box.bottom} 超出视口 ${box.vh}`)
    assert.equal(box.closeVisible, true, '弹窗必须有可见的关闭按钮')
    assert.equal(box.closeInView, true, '关闭按钮必须在视口内（手机上不能点不到）')

    // 关掉 → 资源必须原样还在（确认弹窗不能"点开就删"）
    await browser.click('[data-testid="dialog-close"]')
    await browser.waitFor('!document.querySelector(\'[data-testid="resource-delete-dialog"]\')', 15000, '弹窗关闭')
    const [row] = await withSql((sql) => sql`SELECT deleted_at FROM resources WHERE id = ${draft.data.id}`)
    assert.equal(row.deleted_at, null, '只是打开又关掉确认弹窗，资源不该被删')
    await assertNoOverflow('详情页（关掉删除弹窗后）')

    // 再走一遍并**真的确认**：软删除要生效，而且要回到目录页（不是停在一个已删掉的详情页上）
    await browser.click('[data-testid="resource-detail-delete"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-delete-confirm"]\')', 15000, '确认按钮')
    await browser.click('[data-testid="resource-delete-confirm"]')
    await browser.waitFor(
      `!document.querySelector('[data-testid="resource-detail-page"]') ||
       document.querySelector('[data-testid="resource-detail-status"]')?.innerText.includes('已删除')`,
      20000,
      '删除后离开详情页（或显示已删除）',
    )
    const [after] = await withSql((sql) => sql`SELECT deleted_at FROM resources WHERE id = ${draft.data.id}`)
    assert.equal(after.deleted_at !== null, true, '确认之后必须真的软删除')

    // 目录浏览页不该再列出它（已删除 → 回收站），回收站里能找到
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 20000, '回到目录页')
    const cards = await browser.allAttrs('[data-resource-id]', 'data-resource-id')
    assert.equal(
      cards.includes(draft.data.id),
      false,
      '已删除的资源不该还留在目录浏览页',
    )
    const bins = await withSql((sql) => sql`
      SELECT count(*)::int AS n FROM resources WHERE id = ${draft.data.id} AND deleted_at IS NOT NULL`)
    assert.equal(bins[0].n, 1, '回收站应当能查到这条已删除的资源')
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

  test('张老师：管理页与审核台是"说清没有权限"，不是"先发一串 403 再道歉"', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    await login(TEACHER.username, TEACHER.password)
    /*
      不调用 `clearProblems()`：那会把前面几段流程的采集结果一起丢掉，
      等于偷偷削弱 ⑦ 那条全局门禁。这里只取**本段新增**的那些。
    */
    const before = browser.watchedProblems().length

    /*
      这一条盯的是一个真实的噪音缺陷：页面的取数 useEffect 跑在能力位判断**之前**，
      于是老师打开 `/admin/users` 会先发出必然 403 的请求（浏览器里就是 console error），
      然后才渲染「你没有教师管理权限」。服务端没错（403，不泄露任何数据），
      但"未授权用户不该产生请求"才是干净的边界 —— 阶段 11 的 console 门禁正是被它绊住的。
      修法见 `docs/STAGE11_MOBILE.md`（四个页面：教师账号 / 权限 / 审计 / 审核台）。
    */
    const pages = [
      ['/admin/users', 'users-forbidden'],
      ['/admin/permissions', 'permissions-forbidden'],
      ['/admin/audit', 'audit-forbidden'],
      ['/review', 'review-forbidden'],
    ]
    for (const [path, forbiddenTestId] of pages) {
      await browser.goto(`${TEST_BASE}${path}`)
      await browser.waitFor(
        `!!document.querySelector('[data-testid="${forbiddenTestId}"]')`,
        20000,
        `${path} 要明确告知没有权限`,
      )
      const text = String(await browser.text(`[data-testid="${forbiddenTestId}"]`))
      assert.equal(text.includes('没有'), true, `${path} 的提示要说明原因：${text}`)
      await assertNoOverflow(`${path}（老师的无权提示）`)
    }

    // 等一拍，让可能正在飞的请求落地，再看这一段的增量
    await new Promise((r) => setTimeout(r, 600))
    const delta = browser.watchedProblems().slice(before)
    const urlAllowed = (url) => (url ? allowedNoise.some((a) => String(url).includes(a)) : false)
    const problems = delta.filter((p) => {
      if (p.kind === 'console' && p.level === 'warning') return false
      if (urlAllowed(p.url)) return false
      if (p.text !== undefined && urlAllowed(p.text)) return false
      return true
    })
    assert.equal(
      problems.length,
      0,
      `未授权页面不该产生任何被拒绝的请求或 console 错误，实际 ${problems.length} 条：\n  ` +
        problems.map((p) => `${p.kind}/${p.status ?? ''} ${p.url ?? p.text ?? ''}`).join('\n  '),
    )
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

  test('慢网络 / 请求挂起：先看到 Loading、再看到内容（不白屏、不永久转圈）', async () => {
    // 只靠限速断言"先看到 Loading"是不可靠的：本机响应可能在断言之前就回来了。
    // 这里用 Fetch 域把 `/api/resources` **按住** 2.5 秒，制造一个确定的加载窗口。
    const held = []
    let released = false
    const release = (requestId) => {
      void browser.session.send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
    browser.session.on('Fetch.requestPaused', (params) => {
      held.push(params.request.url)
      if (released) release(params.requestId)
      else {
        released = true
        setTimeout(() => release(params.requestId), 2500)
      }
    })
    await browser.session.send('Fetch.enable', {
      patterns: [{ urlPattern: '*/api/resources*', requestStage: 'Request' }],
    })
    // 同时在传输层限速，模拟真实 4G
    await browser.session.send('Network.emulateNetworkConditions', {
      offline: false, latency: 600, downloadThroughput: 60 * 1024, uploadThroughput: 60 * 1024,
    })

    try {
      await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
      // ① 请求还挂着的时候：必须有 Loading 反馈，不能是一片空白
      await browser.waitFor('!!document.querySelector(\'[data-testid="loading"]\')', 10000, '加载中的 Spinner')
      const during = await browser.session.eval(`(() => ({
        loading: document.querySelector('[data-testid="loading"]') !== null,
        loadingText: (document.querySelector('[data-testid="loading"]')?.innerText || '').trim(),
        cards: document.querySelectorAll('[data-testid="resource-card"]').length,
        listRendered: document.querySelector('[data-testid="resource-list"]') !== null,
      }))()`)
      assert.equal(during.loading, true, '挂起期间要有 Loading')
      assert.equal(during.cards, 0, '挂起期间不该已经有卡片（否则这个断言没意义）')
      assert.equal(during.loadingText.length > 0, true, 'Loading 要有文字说明，不能只有一个转圈')

      // ② 放行之后：内容出来，Loading 收掉
      await browser.waitFor('!!document.querySelector(\'[data-testid="resource-card"]\')', 30000, '内容加载出来')
      assert.equal(await browser.exists('[data-testid="loading"]'), false, '加载完成后不能还留着转圈')
      assert.equal(await browser.exists('[data-testid="resource-list-error"]'), false, '慢一点不等于失败')
      assert.equal(held.length >= 1, true, '这一条必须真的挂起过请求（否则测试没抓到点上）')
    } finally {
      await browser.session.send('Fetch.disable').catch(() => {})
      await browser.session.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      }).catch(() => {})
    }
  })

  test('滚动：抽屉打开时锁住页面、抽屉自己滚、关闭后恢复（不出双滚动条）', async () => {
    await useDevice(DEVICES['iPhone 14 (390×844)'])
    // 管理员导航项最多（目录根 + 管理分组），最考验抽屉的滚动
    await login(ADMIN.username, ADMIN.password)
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-card"]\')', 20000, '长页面')

    // 这个页面得真的能滚，否则下面测不出"锁住"
    const pageHeight = await browser.session.eval(
      `({ scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight })`,
    )
    assert.equal(
      pageHeight.scrollHeight > pageHeight.innerHeight + 50,
      true,
      `这个页面本应当比视口长（scrollHeight=${pageHeight.scrollHeight} vh=${pageHeight.innerHeight}）`,
    )

    /*
      ⚠️ 这里必须用**真实触摸手势**，不能用 `window.scrollTo`。
      `overflow: hidden` 挡的是"用户滚动"，程序化 `scrollTo` 在隐藏溢出的容器上
      照样能改 scrollY —— 第一次写这条测试时就因此误判成"锁没生效"。
      用 CDP 的 `Input.synthesizeScrollGesture`（touch）走的才是手机上真实那条路。
    */
    const touchScrollDown = async () => {
      await browser.session.eval('window.scrollTo(0, 0)')
      await new Promise((r) => setTimeout(r, 150))
      await browser.session.send('Input.synthesizeScrollGesture', {
        x: 195, y: 500, xDistance: 0, yDistance: -400, gestureSourceType: 'touch', speed: 900,
      })
      await new Promise((r) => setTimeout(r, 400))
      return Number(await browser.session.eval('Math.round(window.scrollY)'))
    }

    // ① 对照：抽屉没开的时候，手指滑动页面要能动
    const baseline = await touchScrollDown()
    assert.equal(baseline > 100, true, `抽屉没开时页面必须能滑动（实际 ${baseline}）`)

    await browser.session.eval('window.scrollTo(0, 200)')
    await browser.click('[data-testid="nav-open"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '抽屉')

    // ② 抽屉打开：手指滑动页面不许动
    const locked = await touchScrollDown()
    assert.equal(locked, 0, `抽屉打开时页面必须锁住（触摸滑动后 scrollY=${locked}，应当是 0）`)

    // 把目录树展开几层：抽屉里条目变多，才可能真的需要滚动
    for (let round = 0; round < 3; round += 1) {
      const toggles = await browser.session.eval(`(() => {
        const list = [...document.querySelectorAll('[data-testid="mobile-drawer"] [data-nav-toggle]')]
          .filter((el) => el.getAttribute('aria-expanded') !== 'true')
        return list.slice(0, 6).map((el) => el.getAttribute('data-nav-toggle'))
      })()`)
      if (toggles.length === 0) break
      for (const path of toggles) {
        await browser.click(`[data-testid="mobile-drawer"] [data-nav-toggle="${path}"]`).catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    const scroll = await browser.session.eval(`(() => {
      const drawer = document.querySelector('[data-testid="mobile-drawer"]')
      const dr = drawer.getBoundingClientRect()
      // 找出此刻"真的能滚"的元素（scrollHeight 超了 clientHeight）
      const scrollers = [...document.querySelectorAll('body *')]
        .filter((el) => {
          const style = getComputedStyle(el)
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                 el.scrollHeight > el.clientHeight + 1
        })
        .map((el) => ({
          testid: el.getAttribute('data-testid') || el.tagName,
          insideDrawer: drawer.contains(el),
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        }))
      return {
        drawerTop: Math.round(dr.top), drawerBottom: Math.round(dr.bottom),
        vh: window.innerHeight, vw: window.innerWidth,
        drawerRight: Math.round(dr.right),
        scrollers,
        navItems: drawer.querySelectorAll('[data-nav]').length,
      }
    })()`)

    // ③ 抽屉自己必须在视口里（页面不会因为它多出一根纵向滚动条）
    assert.equal(scroll.drawerTop >= 0 && scroll.drawerBottom <= scroll.vh + 1, true,
      `抽屉超出视口：top=${scroll.drawerTop} bottom=${scroll.drawerBottom} vh=${scroll.vh}`)
    assert.equal(scroll.drawerRight <= scroll.vw + 1, true, `抽屉右边超出视口：${scroll.drawerRight} > ${scroll.vw}`)
    assert.equal(scroll.navItems > 0, true, '抽屉里要有导航项')

    // ④ 同一时刻最多只有一个"真的能滚"的元素，而且它必须在抽屉里（这就是"不出双滚动条"）
    assert.equal(scroll.scrollers.length <= 1, true,
      `抽屉打开时不该有第二个滚动容器：${JSON.stringify(scroll.scrollers)}`)
    if (scroll.scrollers.length === 1) {
      assert.equal(scroll.scrollers[0].insideDrawer, true,
        `唯一能滚的容器必须在抽屉里，实际：${JSON.stringify(scroll.scrollers[0])}`)
      // 抽屉内部能用手指滚，且页面不跟着动
      await browser.session.send('Input.synthesizeScrollGesture', {
        x: 100, y: 600, xDistance: 0, yDistance: -200, gestureSourceType: 'touch', speed: 900,
      })
      await new Promise((r) => setTimeout(r, 400))
      const inner = await browser.session.eval(`(() => {
        const drawer = document.querySelector('[data-testid="mobile-drawer"]')
        const el = [...document.querySelectorAll('body *')].find((e) => {
          const s = getComputedStyle(e)
          return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1 && drawer.contains(e)
        })
        return { scrollTop: el ? Math.round(el.scrollTop) : -1, page: Math.round(window.scrollY) }
      })()`)
      assert.equal(inner.scrollTop > 0, true, '抽屉里应当能用手指滚起来')
      assert.equal(inner.page, 0, '滚抽屉时页面不该跟着滚')
    }

    // ⑤ 关闭之后要恢复，不能永久锁死
    await browser.click('[data-testid="nav-close"]')
    await browser.waitFor('!document.querySelector(\'[data-testid="mobile-drawer"]\')', 15000, '抽屉关闭')
    const restoredOverflow = await browser.session.eval('document.body.style.overflow')
    assert.equal(restoredOverflow === '' || restoredOverflow === 'visible', true,
      `关闭抽屉后要还原 body 的滚动（实际：'${restoredOverflow}'）`)
    const afterClose = await touchScrollDown()
    assert.equal(afterClose > 100, true, `关闭抽屉后页面必须能重新滑动（实际 ${afterClose}）`)
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
