/**
 * tests/integration/browser.stage13b.test.mjs —— Stage 13B 的新行为验收（真实 Chrome）
 * ============================================================================
 * 只测**本轮改动的那些行为**（其余文件类型矩阵已由 browser.stage10 覆盖，不重复）：
 *
 *   ① 侧边栏箭头：活动根目录**可以收起**、可以再展开、连点多次；
 *      深层 URL 进入时祖先自动展开；收起当前活动分支后**不会**被自动重新展开。
 *   ② 上传可见性：公开列表仍只列已发布；**本人**在目录页能看到自己的未发布资源
 *      （带状态标签），**别人**看不到那块区域，接口层也只返回自己的。
 *   ③ 文件名可点：可预览的类型打开预览、Office/ZIP 直接下载。
 *   ④ 预览的失败路径：对象真的不存在时，**必须报错**，不许"假预览成功"。
 *
 * 断言的对象是浏览器里**实际渲染出来的东西**（aria-expanded、子节点数量、
 * 预览里真的出现的内容、下载到的字节），不是"点了按钮没报错"。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEST_BASE,
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
  testStorageDir,
  withSql,
} from '../helpers/harness.mjs'
import { launchBrowser } from '../helpers/browser.mjs'
import { pdfBytes } from '../helpers/upload.mjs'

const WORK = mkdtempSync(join(tmpdir(), 'stage13b-'))
const FILES_DIR = join(WORK, 'files')
const DOWNLOAD_DIR = join(WORK, 'downloads')

const ADMIN = { username: 'b13_admin', password: 'B13AdminPass!2026' }
const TEACHER_A = { username: 'b13_teach_a', password: 'B13TeachA!2026' }
const TEACHER_B = { username: 'b13_teach_b', password: 'B13TeachB!2026' }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 造真的测试文件（本用例只需要三类：可预览的、与不可预览的）。 */
const FIXTURES = {
  pdf: { name: '阶段13B预览.pdf', previewable: true },
  png: { name: '阶段13B图片.png', previewable: true },
  txt: { name: '阶段13B文本.txt', previewable: true },
  zip: { name: '阶段13B压缩包.zip', previewable: false },
}

let browser
let storageDir
const ids = {}

before(async () => {
  mkdirSync(FILES_DIR, { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })

  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8Dwn4GBgYGRAQoAAB0hAwH8g0m6AAAAAElFTkSuQmCC',
    'base64',
  )
  const txtBytes = Buffer.from('阶段 13B 的纯文本内容\n第二行：用于验证 TXT 真的按文本渲染。\n', 'utf8')
  // ZIP 夹具与 browser.stage10 同一做法（合法 PK 头 + 文本负载）
  const zipBytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
    Buffer.from('stage13b zip fixture\n'.repeat(8)),
  ])
  FIXTURES.pdf.bytes = pdfBytes('stage13b-preview')
  FIXTURES.png.bytes = pngBytes
  FIXTURES.txt.bytes = txtBytes
  FIXTURES.zip.bytes = zipBytes
  for (const f of Object.values(FIXTURES)) {
    f.sha256 = sha256(f.bytes)
    f.path = join(FILES_DIR, f.name)
    writeFileSync(f.path, f.bytes)
  }

  await resetDatabase()
  await createAdmin(ADMIN.username, ADMIN.password)
  // 存储用本地 provider：走的是**同一套** 申请→PUT→登记 链路（真字节、真 sha256），
  // 只是对象落在临时目录里 —— 于是"对象不存在"这类故障可以**真的造出来**（见 §④）。
  // startServer 的默认存储就是 local provider + 一个临时目录（harness 负责创建）。
  // 不要自己传 STORAGE_LOCAL_DIR：`testStorageDir()` 要求服务已经起过，否则它会抛错。
  await startServer()
  storageDir = testStorageDir()

  const adminClient = client()
  await adminClient.login(ADMIN.username, ADMIN.password)
  const lessonDir = await directoryIdByPath('education/pre-k/virtue/lesson')
  ids.lessonDir = lessonDir
  ids.lessonPath = 'education/pre-k/virtue/lesson'
  const docsDir = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.docsDir = docsDir
  ids.docsPath = 'education/pre-k/virtue/resources'

  for (const t of [TEACHER_A, TEACHER_B]) {
    await createTeacher(t.username, t.password, [
      { permission: 'resource.view', directoryId: lessonDir },
      { permission: 'resource.create', directoryId: lessonDir },
      { permission: 'resource.update.own', directoryId: lessonDir },
      { permission: 'resource.download', directoryId: lessonDir },
      { permission: 'resource.submit', directoryId: lessonDir },
      { permission: 'resource.view', directoryId: docsDir },
      { permission: 'resource.create', directoryId: docsDir },
      { permission: 'resource.update.own', directoryId: docsDir },
      { permission: 'resource.download', directoryId: docsDir },
    ])
  }

  browser = await launchBrowser()
  await browser.enableDownloads(DOWNLOAD_DIR)
  await browser.startProblemWatch()
})

after(async () => {
  // ⚠️ 必须 try/finally：只要 browser.close() 抛一次，stopServer() 就会被跳过，
  // 于是 3311 上留下一个孤儿服务，**下一次运行会在 before 钩子上撞端口**，
  // 表现为一组测试全部 "cancelledByParent"（我第一次就是这么把自己绊倒的）。
  try {
    if (browser) await browser.close()
  } finally {
    await stopServer()
    rmSync(WORK, { recursive: true, force: true })
  }
})

async function login(username, password) {
  await browser.goto(`${TEST_BASE}/`)
  await browser.waitFor(
    `!!document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="header"]')`,
    25000,
    '就绪',
  )
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor(`!!document.querySelector('[data-testid="login-page"]')`, 20000, '退出')
  }
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor(`!!document.querySelector('[data-testid="header"]')`, 25000, '登录成功')
}

/** 直接走接口上传（比 UI 快、也更稳），唯一的差别只是没有点对话框。 */
async function uploadViaApi(c, { directoryId, title, fixture }) {
  const created = await c.post('/api/resources', { directoryId, title })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  const ticket = await c.post(`/api/resources/${created.data.id}/files/upload-url`, {
    fileName: fixture.name,
    mimeType: fixture.name.endsWith('.pdf')
      ? 'application/pdf'
      : fixture.name.endsWith('.png')
        ? 'image/png'
        : fixture.name.endsWith('.txt')
          ? 'text/plain'
          : 'application/zip',
    size: fixture.bytes.length,
    sha256: fixture.sha256,
  })
  assert.equal(ticket.status, 201, JSON.stringify(ticket.data))
  // 本地 provider 签出来的是**相对**地址（`/api/storage/local?...`），
  // 浏览器里会自动按页面 origin 解析；Node 里必须自己拼上 base。
  const uploadUrl = String(ticket.data.uploadUrl).startsWith('/')
    ? `${TEST_BASE}${ticket.data.uploadUrl}`
    : ticket.data.uploadUrl
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: ticket.data.headers ?? {},
    body: fixture.bytes,
  })
  assert.ok(put.status >= 200 && put.status < 300, `PUT 必须成功，实际 ${put.status}`)
  const registered = await c.post(`/api/resources/${created.data.id}/files/register`, {
    uploadId: ticket.data.uploadId,
  })
  assert.equal(registered.status, 201, `登记必须成功：${JSON.stringify(registered.data)}`)
  return { resourceId: created.data.id, fileId: registered.data.id }
}

/** 侧边栏某个节点的当前展开状态（直接读 DOM，不看内部 state）。 */
async function navState(url) {
  // `data-nav-toggle` / `data-nav-children` 用的是 **directoryUrl(path)** 的值，
  // 也就是带前缀的完整地址（如 `/growth`、`/directory/education`），不是裸 slug。

  return browser.session.eval(`(() => {
    const btn = document.querySelector('[data-nav-toggle="${url}"]')
    const children = document.querySelector('[data-nav-children="${url}"]')
    return {
      hasToggle: btn !== null,
      expanded: btn ? btn.getAttribute('aria-expanded') === 'true' : null,
      childCount: children ? children.children.length : 0,
      rendered: children !== null,
    }
  })()`)
}

describe('① 侧边栏展开/收起（业主 Stage 13B §3）', () => {
  test('活动根目录「教师成长」：能收起、能再展开、连点多次都对', async () => {
    // 用**管理员**：导航用例要看整棵树的结构（普通教师只被授权了部分分支，
    // 看不到「教师成长」就无从点它的箭头）。收起/展开是纯前端行为，与身份无关。
    await login(ADMIN.username, ADMIN.password)
    // 站在「教师成长」这一支里 —— 旧代码正是在这个状态下点箭头没反应
    await browser.goto(`${TEST_BASE}/directory/growth/l1/safety`)
    await browser.waitFor(`!!document.querySelector('[data-nav-toggle="/directory/growth"]')`, 25000, '导航就绪')

    const initial = await navState('/directory/growth')
    assert.equal(initial.expanded, true, `进入该分支后应当自动展开：${JSON.stringify(initial)}`)
    assert.ok(initial.childCount > 0, '展开后必须真的有子节点渲染出来')

    // 收起：aria-expanded 必须变 false，而且子节点**真的从 DOM 里消失**
    await browser.click('[data-nav-toggle="/directory/growth"]')
    await browser.waitFor(
      `document.querySelector('[data-nav-toggle="/directory/growth"]').getAttribute('aria-expanded') === 'false'`,
      10000,
      '箭头收起了活动分支',
    )
    const collapsed = await navState('/directory/growth')
    assert.equal(collapsed.rendered, false, `收起后子节点必须消失：${JSON.stringify(collapsed)}`)

    // 再展开
    await browser.click('[data-nav-toggle="/directory/growth"]')
    await browser.waitFor(
      `document.querySelector('[data-nav-toggle="/directory/growth"]').getAttribute('aria-expanded') === 'true'`,
      10000,
      '再次展开',
    )
    assert.ok((await navState('/directory/growth')).childCount > 0, '再次展开后子节点回来了')

    // 连点多次：奇数次要收起、偶数次要展开（不累计错乱）
    for (let i = 0; i < 5; i += 1) {
      await browser.click('[data-nav-toggle="/directory/growth"]')
      await new Promise((r) => setTimeout(r, 250))
    }
    const afterOdd = await navState('/directory/growth')
    assert.equal(afterOdd.expanded, false, `连点 5 次（奇数次）应当收起：${JSON.stringify(afterOdd)}`)
    await browser.click('[data-nav-toggle="/directory/growth"]')
    await browser.waitFor(
      `document.querySelector('[data-nav-toggle="/directory/growth"]').getAttribute('aria-expanded') === 'true'`,
      10000,
      '第 6 次点击后展开',
    )
  })

  test('收起之后**不会**因为"当前就在这里"被自动重新展开', async () => {
    // 上一条最后是展开状态；这里再收起，然后做一次"不改变活动状态"的动作（等一会儿/重新读 DOM）
    await browser.click('[data-nav-toggle="/directory/growth"]')
    await new Promise((r) => setTimeout(r, 600))
    const state = await navState('/directory/growth')
    assert.equal(state.expanded, false, `用户收起后必须保持收起：${JSON.stringify(state)}`)
    // 页面仍停在原来的深层地址（收起只是 UI，不导航）
    assert.match(await browser.url(), /\/directory\/growth\/l1\/safety/, '收起不能把用户导航走')
  })

  test('点箭头不会导航；点名字仍然导航，并且会重新自动展开祖先', async () => {
    const before = await browser.url()
    await browser.click('[data-nav-toggle="/directory/growth"]')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await browser.url(), before, '点箭头只切换展开，不导航')
    assert.equal((await navState('/directory/growth')).expanded, true, '展开成功')

    // 点到别的分支 → 该分支自动展开、旧的收起状态不跟着跑
    await browser.click('[data-nav="/directory/education"]')
    await browser.waitFor(`!!document.querySelector('[data-nav-children="/directory/education"]')`, 10000, '教育教学展开')
    const education = await navState('/directory/education')
    assert.equal(education.expanded, true, `导航到另一支后它应自动展开：${JSON.stringify(education)}`)
    assert.ok(education.childCount > 0, '教育教学下要真的渲染出子节点')
  })

  test('深层 URL 直接进入：祖先链自动展开到当前节点', async () => {
    await browser.goto(`${TEST_BASE}/directory/growth/l1/safety/plan/disease`)
    await browser.waitFor(`!!document.querySelector('[data-nav-toggle="/directory/growth"]')`, 25000, '导航')
    for (const url of ['/directory/growth', '/directory/growth/l1']) {
      const st = await navState(url)
      assert.equal(st.expanded, true, `${url} 应当在祖先链上自动展开：${JSON.stringify(st)}`)
      assert.ok(st.childCount > 0, `${url} 的子节点要渲染出来`)
    }
  })

  test('没有子节点的目录不渲染展开箭头', async () => {
    const noToggle = await browser.session.eval(`(() => {
      const rows = [...document.querySelectorAll('[data-nav-row]')]
      // 找一个没有 toggle 的行（叶子节点）
      const leaf = rows.find((r) => !r.querySelector('[data-testid="sidebar-toggle"]'))
      return leaf ? leaf.getAttribute('data-nav-row') : null
    })()`)
    assert.ok(noToggle !== null, '侧边栏里应当存在叶子节点（没有 toggle）')
  })
})

describe('② 上传后的可见性（业主 Stage 13B §4）', () => {
  test('上传草稿后：公开列表为空，本人目录页能看到自己的未发布资源', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)
    const { resourceId } = await uploadViaApi(teacher, {
      directoryId: ids.lessonDir,
      title: '13B 我的草稿',
      fixture: FIXTURES.pdf,
    })
    ids.draft = resourceId

    // 接口层：公开列表（无 onlyMine）对这位老师也不含它
    const publicList = await teacher.get(`/api/resources?directoryId=${ids.lessonDir}&status=PUBLISHED`)
    assert.equal(
      publicList.data.items.some((r) => r.id === resourceId),
      false,
      '未发布的资源不能出现在公开列表里',
    )
    // 接口层：onlyMine 能拿到（而且在同一个目录下）
    const mineList = await teacher.get(`/api/resources?directoryId=${ids.lessonDir}&onlyMine=true`)
    assert.equal(
      mineList.data.items.some((r) => r.id === resourceId),
      true,
      `onlyMine 应当包含自己的草稿：${JSON.stringify(mineList.data.items.map((r) => r.title))}`,
    )

    // 浏览器：**必须以上传者本人登录**再看目录页 —— 接口客户端（teacher）和
    // 浏览器会话是两个身份，上一段①用的是管理员，不切换的话这里看到的是管理员的
    // 视角（他自己没传东西，自然没有"我的未发布资源"）。
    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/directory/${ids.lessonPath}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="my-unpublished-section"]')`, 25000, '未发布区域')
    const shown = await browser.session.eval(`(() => ({
      titles: [...document.querySelectorAll('[data-testid="my-unpublished-card"] [data-testid="resource-card-title"]')].map((e) => e.innerText.trim()),
      statuses: [...document.querySelectorAll('[data-testid="my-unpublished-card"] [data-testid="resource-card-status"]')].map((e) => e.innerText.trim()),
    }))()`)
    assert.ok(shown.titles.includes('13B 我的草稿'), `本人应看得到自己的草稿：${JSON.stringify(shown)}`)
    assert.ok(shown.statuses.every((s) => s === '草稿'), `状态标签要如实：${JSON.stringify(shown)}`)

    // 公开区域仍然是空的（这个目录里没有已发布资源）
    assert.equal(
      await browser.exists('[data-testid="resource-list-empty"]'),
      true,
      '公开列表应当仍是空的（未发布不对外）',
    )
  })

  test('别的老师在同一目录：公开列表空，且**看不到**那块未发布区域', async () => {
    await login(TEACHER_B.username, TEACHER_B.password)
    await browser.goto(`${TEST_BASE}/directory/${ids.lessonPath}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="resource-list-empty"]')`, 25000, '公开列表空')
    assert.equal(
      await browser.exists('[data-testid="my-unpublished-section"]'),
      false,
      '别人的未发布资源不能出现在我的目录页上',
    )

    // 接口层同样的边界：onlyMine 是**服务端**按 uploader_id 过滤的
    const other = client()
    await other.login(TEACHER_B.username, TEACHER_B.password)
    const list = await other.get(`/api/resources?directoryId=${ids.lessonDir}&onlyMine=true`)
    assert.equal(
      list.data.items.some((r) => r.id === ids.draft),
      false,
      `onlyMine 不能返回别人的草稿：${JSON.stringify(list.data.items.map((r) => r.title))}`,
    )
    // 连单条详情也够不到（状态不可见）
    const detail = await other.get(`/api/resources/${ids.draft}`)
    assert.equal(detail.status, 403, `别人的草稿详情应当 403：${detail.status}`)
  })

  test('发布之后：公开列表里所有人都能看到', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)
    await teacher.post(`/api/resources/${ids.draft}/submit`)
    const adminClient = client()
    await adminClient.login(ADMIN.username, ADMIN.password)
    const approved = await adminClient.post(`/api/resources/${ids.draft}/review`, { action: 'approve' })
    assert.equal(approved.status, 201, JSON.stringify(approved.data))

    await login(TEACHER_B.username, TEACHER_B.password)
    await browser.goto(`${TEST_BASE}/directory/${ids.lessonPath}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="resource-card"]')`, 25000, '公开列表有内容')
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.ok(titles.includes('13B 我的草稿'), `发布后别人也应当看得到：${JSON.stringify(titles)}`)
  })
})

describe('③ 文件名与预览/下载（业主 Stage 13B §5.1）', () => {
  test('PNG：点**文件名**就能打开预览，而且图片真的解码显示（不是坏图）', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)
    const { resourceId, fileId } = await uploadViaApi(teacher, {
      directoryId: ids.lessonDir,
      title: '13B 文件名点击',
      fixture: FIXTURES.png,
    })
    ids.clickable = { resourceId, fileId }

    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="file-row"]')`, 25000, '文件行')
    const nameText = await browser.text('[data-testid="file-name"]')
    assert.equal(nameText, FIXTURES.png.name)
    // 文件名本身是**可点的**（不是纯文本）
    const clickable = await browser.session.eval(`(() => {
      const el = document.querySelector('[data-testid="file-name"]')
      return { tag: el.tagName, isButton: el.tagName === 'BUTTON' || !!el.closest('button') }
    })()`)
    assert.equal(clickable.isButton, true, `文件名应当是按钮：${JSON.stringify(clickable)}`)

    await browser.click('[data-testid="file-name"]')
    await browser.waitFor(`!!document.querySelector('[data-testid="file-preview-image"]')`, 20000, '图片预览')
    // 关键：图片**真的解码成功**（naturalWidth > 0 才算）；只看 <img> 存在会漏掉坏图。
    // 注意 `browser.waitFor` 不返回布尔值（超时会抛），所以断言要用 session.eval 取值。
    const loaded = await browser.session.eval(
      `(() => { const img = document.querySelector('[data-testid="file-preview-image"]'); return !!img && img.complete && img.naturalWidth > 0 })()`,
    )
    assert.equal(loaded, true, '图片必须真的显示出来，而不是坏图')
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('TXT：文件名点击 → 预览里出现**真实文件内容**', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)
    const { resourceId } = await uploadViaApi(teacher, {
      directoryId: ids.lessonDir,
      title: '13B 文本预览',
      fixture: FIXTURES.txt,
    })
    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="file-name"]')`, 25000, '文件名')
    await browser.click('[data-testid="file-name"]')
    await browser.waitFor(`!!document.querySelector('[data-testid="file-preview-text"]')`, 20000, '文本预览')
    const text = await browser.text('[data-testid="file-preview-text"]')
    assert.match(text, /阶段 13B 的纯文本内容/, `预览里应当是文件真实内容：${text.slice(0, 80)}`)
    assert.match(text, /第二行/, '多行内容都要在')
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('ZIP：文件名点击 → **直接下载**，字节与源文件一致；没有预览按钮', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)
    const { resourceId } = await uploadViaApi(teacher, {
      directoryId: ids.lessonDir,
      title: '13B 压缩包下载',
      fixture: FIXTURES.zip,
    })
    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="file-row"]')`, 25000, '文件行')

    // 不可预览的类型：不渲染预览按钮，显示"不支持在线预览"的话
    assert.equal(await browser.exists('[data-testid="file-preview"]'), false, 'ZIP 不该有预览按钮')
    assert.equal(await browser.exists('[data-testid="file-preview-unsupported"]'), true, '要说明不支持预览')

    // 点**文件名**触发下载（ZIP 不支持预览 → 文件名就是"下载"入口）
    await browser.click('[data-testid="file-name"]')
    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith('.zip'), 30000)
    const bytes = readFileSync(saved)
    assert.equal(bytes.length, FIXTURES.zip.bytes.length, '下载字节数要一致')
    assert.equal(sha256(bytes), FIXTURES.zip.sha256, '下载内容的 sha256 必须与源文件一致')
    rmSync(saved, { force: true })
  })
})

describe('④ 未发布那一块的边界：已退回要出现、已撤回不许回来（Stage 13B §4）', () => {
  test('被退回 → 目录页那一块里带着「已退回」和退回意见', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)
    const { resourceId } = await uploadViaApi(teacher, {
      directoryId: ids.lessonDir,
      title: '13B 待退回',
      fixture: FIXTURES.pdf,
    })
    await teacher.post(`/api/resources/${resourceId}/submit`)

    const adminClient = client()
    await adminClient.login(ADMIN.username, ADMIN.password)
    const rejected = await adminClient.post(`/api/resources/${resourceId}/review`, {
      action: 'reject',
      comment: '请补充第 3 周的观察记录。',
    })
    assert.equal(rejected.status, 201, JSON.stringify(rejected.data))

    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/directory/${ids.lessonPath}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="my-unpublished-section"]')`, 25000, '未发布区域')
    const card = await browser.session.eval(`(() => {
      const el = document.querySelector('[data-resource-id="${resourceId}"]')
      if (!el) return null
      return {
        where: el.closest('[data-testid="my-unpublished-section"]') ? 'unpublished' : 'public',
        status: (el.querySelector('[data-testid="resource-card-status"]')?.innerText || '').trim(),
        comment: (el.querySelector('[data-testid="resource-card-review-comment"]')?.innerText || '').trim(),
      }
    })()`)
    assert.ok(card, '被退回的资源必须出现在目录页上（否则老师不知道要改什么）')
    assert.equal(card.where, 'unpublished', '它还没上线，只能在「我的未发布资源」里')
    assert.equal(card.status, '已退回', `状态要如实：${JSON.stringify(card)}`)
    assert.match(card.comment, /第 3 周的观察记录/, `退回意见要直接显示在卡片上：${JSON.stringify(card)}`)
  })

  test('发布之后从那一块消失、进入公开列表；撤回之后**两处都不在**（只在「我的资源」）', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)
    const { resourceId } = await uploadViaApi(teacher, {
      directoryId: ids.lessonDir,
      title: '13B 发布与撤回',
      fixture: FIXTURES.txt,
    })
    await teacher.post(`/api/resources/${resourceId}/submit`)
    const adminClient = client()
    await adminClient.login(ADMIN.username, ADMIN.password)
    await adminClient.post(`/api/resources/${resourceId}/review`, { action: 'approve' })

    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/directory/${ids.lessonPath}`)
    await browser.waitFor(`!!document.querySelector('[data-resource-id="${resourceId}"]')`, 25000, '发布后可见')
    const published = await browser.session.eval(`(() => {
      const el = document.querySelector('[data-resource-id="${resourceId}"]')
      return el.closest('[data-testid="my-unpublished-section"]') ? 'unpublished' : 'public'
    })()`)
    assert.equal(published, 'public', '发布之后应当出现在公开列表里，而不是留在那一块')

    // 撤回：老师主动把它从目录里拿回来
    const recalled = await teacher.post(`/api/resources/${resourceId}/recall`)
    assert.equal(recalled.status, 201, JSON.stringify(recalled.data))

    await browser.goto(`${TEST_BASE}/directory/${ids.lessonPath}`)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-list-section"]\')',
      25000,
      '目录页就绪',
    )
    assert.equal(
      await browser.exists(`[data-resource-id="${resourceId}"]`),
      false,
      '撤回是"把东西从目录里拿走"——目录页上任何地方都不该再有它（含那一块）',
    )

    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(`!!document.querySelector('[data-resource-id="${resourceId}"]')`, 25000, '我的资源里仍看得到')
    assert.equal(
      await browser.text(`[data-resource-id="${resourceId}"] [data-testid="my-resource-status"]`),
      '已撤回',
    )
  })
})

describe('⑤ 预览的失败路径：对象真的不存在时必须报错（不许假成功）', () => {
  test('TXT 的对象被删掉后：预览显示错误，而不是把错误页当内容渲染', async () => {
    const teacher = client()
    await teacher.login(TEACHER_A.username, TEACHER_A.password)
    const { resourceId, fileId } = await uploadViaApi(teacher, {
      directoryId: ids.lessonDir,
      title: '13B 对象缺失',
      fixture: FIXTURES.txt,
    })

    // 真的把对象从存储里删掉（本地 provider：删磁盘上的文件）—— 数据库记录**保持不变**
    const [row] = await withSql((sql) => sql`
      SELECT storage_key FROM resource_files WHERE id = ${fileId}`)
    const objectPath = join(storageDir, row.storage_key)
    rmSync(objectPath, { force: true })

    await login(TEACHER_A.username, TEACHER_A.password)
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="file-name"]')`, 25000, '文件名')
    await browser.click('[data-testid="file-name"]')
    // 必须出现**明确的错误**（而不是空白、也不是把 XML 错误页当文本显示）
    await browser.waitFor(`!!document.querySelector('[data-testid="file-preview-error"]')`, 25000, '预览错误提示')
    const message = await browser.text('[data-testid="file-preview-error"]')
    assert.match(message, /无法读取|失败|不存在|过期/, `错误信息要可读：${message}`)
    assert.equal(
      await browser.exists('[data-testid="file-preview-text"]'),
      false,
      '对象不存在时**不能**渲染出"内容"（那正是假成功）',
    )
    // 并且给得出「重新加载」这个动作
    assert.equal(await browser.exists('[data-testid="file-preview-retry"]'), true, '要有重试入口')
  })
})
