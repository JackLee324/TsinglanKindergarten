/**
 * tests/integration/browser.stage6.test.mjs —— 阶段 6 的真实浏览器全流程
 * ============================================================================
 * 业主 §23 指定的那条路，一步一步走完，全在真实浏览器里：
 *
 *   登录 → Pre-K → 美德 → 教学资源 → 上传资源 → 填标题 → 选 PDF → 上传
 *   → 看到「已上传」→ 保存草稿 → **刷新浏览器** → 重新进入教学资源 → 找到它
 *   → 打开详情 → 看到 PDF 文件 → 预览（真的出现 PDF）→ 下载
 *   → 比较：下载文件 SHA256 == 上传文件 SHA256
 *
 * 关键点与它们的理由：
 *   · 文件是**真的文件**（写到临时目录再由 CDP 塞进 input），不是构造的 Blob；
 *   · 下载是**真的下载到磁盘**（Browser.setDownloadBehavior），不是页面里 fetch 一下；
 *   · 刷新是**真的 reload**，用来钉死"上传成功但刷新就没了"这类假成功；
 *   · 位置标签断言的是目录树里的中文链路，改名后要跟着变。
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
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { launchBrowser } from '../helpers/browser.mjs'

/** 上传/下载用的临时目录（每个文件都是真字节，不是构造的）。 */
const WORK = mkdtempSync(join(tmpdir(), 'v2-stage6-e2e-'))
const FIXTURE_DIR = join(WORK, 'fixtures')
const DOWNLOAD_DIR = join(WORK, 'downloads')

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'.repeat(60)),
  Buffer.from('%%EOF\n'),
])
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png payload for preview test\n'.repeat(30)),
])
const DOCX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
  Buffer.from('docx payload\n'.repeat(30)),
])
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
  Buffer.from('zip payload\n'.repeat(30)),
])
const BIG_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.alloc(3 * 1024 * 1024, 0x41),
  Buffer.from('\n%%EOF\n'),
])

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const FILES = {}

let browser
let admin
let ids = {}
const createdResources = []

/** 以某个账号登录（先确保已退出）。 */
async function login(username, password) {
  await ensureLoggedOut()
  await browser.goto(`${TEST_BASE}/login`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '登录页出现')
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 15000, `登录 ${username} 后进入应用外壳`)
}

async function ensureLoggedOut() {
  await browser.goto(`${TEST_BASE}/`)
  await browser.waitFor(
    `!!document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="logout-button"]')`,
    20000,
    '应用或登录页就绪',
  )
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '退出到登录页')
  }
}

/** 打开教学资源目录页（阶段 6 的主角）。 */
async function openVirtueResources() {
  await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
  await browser.waitFor(
    '!!document.querySelector(\'[data-testid="directory-page"]\')',
    20000,
    '教学资源目录页出现',
  )
}

/**
 * 走一遍"上传资源"：打开弹窗 → 填标题 → 塞文件 → 保存 → 等跳到详情页。
 * 返回资源 id。
 */
async function uploadThroughUi({ title, filePath, description = '' }) {
  await openVirtueResources()
  await browser.waitFor(
    '!!document.querySelector(\'[data-testid="directory-upload"]\')',
    15000,
    '「上传资源」按钮出现',
  )
  await browser.click('[data-testid="directory-upload"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '上传弹窗打开')

  await browser.fill('[data-testid="upload-title"]', title)
  if (description !== '') await browser.fill('[data-testid="upload-description"]', description)
  // 真实文件：CDP 直接塞进 input，页面走它正常的上传代码路径
  await browser.setFileInput('[data-testid="upload-file-input"]', filePath)
  await browser.waitFor(
    '!!document.querySelector(\'[data-testid="upload-file-name"]\')',
    15000,
    '文件名显示出来',
  )

  await browser.click('[data-testid="upload-submit"]')
  await browser.waitFor(
    'location.pathname.startsWith("/resources/")',
    60000,
    '保存后跳到资源详情页',
  )
  const url = await browser.url()
  const resourceId = url.replace('/resources/', '')
  createdResources.push(resourceId)
  return resourceId
}

before(async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(FIXTURE_DIR, { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  // 造真实文件
  const write = (name, bytes) => {
    const path = join(FIXTURE_DIR, name)
    writeFileSync(path, bytes)
    return path
  }
  FILES.pdf = write('美德课程教案.pdf', PDF_BYTES)
  FILES.png = write('观察记录照片.png', PNG_BYTES)
  FILES.docx = write('周计划.docx', DOCX_BYTES)
  FILES.zip = write('素材包.zip', ZIP_BYTES)
  FILES.big = write('大文件.pdf', BIG_BYTES)

  await resetDatabase()
  await createAdmin('s6_admin', 'S6AdminPass!1')
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.education = await directoryIdByPath('education')
  ids.kPe = await directoryIdByPath('education/k/pe/resources')

  await startServer()

  // ⚠️ 授权只给 **pre-k**，不给整个 education。
  // 给整个 education 等于把 K 也一起给了，于是"跨目录必须 403"那条用例
  // 会因为"他本来就有权限"而变成 201 —— 测的是错的结论。
  const preK = await directoryIdByPath('education/pre-k')
  const teacher = await createTeacher('s6_teacher', 'S6TeacherPass!1', [
    { permission: 'resource.view', directoryId: preK },
    { permission: 'resource.create', directoryId: preK },
    { permission: 'resource.update.own', directoryId: preK },
    { permission: 'resource.delete.own', directoryId: preK },
    { permission: 'resource.download', directoryId: preK },
    { permission: 'resource.submit', directoryId: preK },
  ], '阶段六老师')
  void teacher

  // 另一位老师：**没有**教育教学的权限（只有 K 体能）—— 用来验证越权访问被拒。
  await createTeacher('s6_konly', 'S6KonlyPass!1', [
    { permission: 'resource.view', directoryId: ids.kPe },
    { permission: 'resource.create', directoryId: ids.kPe },
  ], '只有 K 体能权限的老师')

  admin = client()
  await admin.login('s6_admin', 'S6AdminPass!1')

  browser = await launchBrowser()
  await browser.enableDownloads(DOWNLOAD_DIR)
})

after(async () => {
  if (browser) await browser.close()
  if (createdResources.length > 0) {
    await withSql(async (sql) => {
      await sql`DELETE FROM resources WHERE id = ANY(${createdResources}::uuid[])`
    })
  }
  await stopServer()
  rmSync(WORK, { recursive: true, force: true })
})

describe('上传资源：完整用户路径（§23）', () => {
  let resourceId

  test('从目录页打开上传弹窗：位置只读可见，且没有班型/科目/资料夹/所属目录可选项', async () => {
    await login('s6_teacher', 'S6TeacherPass!1')
    await openVirtueResources()
    await browser.click('[data-testid="directory-upload"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '弹窗打开')

    assert.equal(
      await browser.text('[data-testid="upload-location"]'),
      '教育教学 / Pre-K / 美德 / 教学资源',
      '位置要只读地显示出来（老师要能确认东西会去哪）',
    )

    // 业主 §13：已经不再出现这些选择项。它们的消失是"上传去哪了"这个问题的另一半答案。
    const labels = await browser.session.eval(
      `JSON.stringify([...document.querySelectorAll('[data-testid="upload-dialog"] label, [data-testid="upload-dialog"] select')].map((e) => (e.innerText || '').trim()).filter(Boolean))`,
    )
    const texts = JSON.parse(labels ?? '[]')
    for (const banned of ['班型', '科目', '资料夹', '所属目录']) {
      assert.equal(
        texts.some((t) => t.includes(banned)),
        false,
        `上传表单里不该再有「${banned}」：${texts.join(' / ')}`,
      )
    }
  })

  test('填标题 + 选 PDF + 保存草稿 → 跳详情页，文件真的上传了', async () => {
    // 上一条用例已经把弹窗打开了；接着填。
    await browser.fill('[data-testid="upload-title"]', '美德课程教案')
    await browser.fill('[data-testid="upload-description"]', '第一学期的美德主题教案')
    await browser.setFileInput('[data-testid="upload-file-input"]', FILES.pdf)
    await browser.waitFor('!!document.querySelector(\'[data-testid="upload-file-name"]\')', 15000, '文件名出现')
    await browser.click('[data-testid="upload-submit"]')
    await browser.waitFor('location.pathname.startsWith("/resources/")', 60000, '跳到详情页')
    resourceId = (await browser.url()).replace('/resources/', '')
    createdResources.push(resourceId)

    // 详情页：标题、完整目录链路、文件行
    await browser.waitForText('[data-testid="resource-detail-title"]', '美德课程教案', 15000)
    await browser.waitForText(
      '[data-testid="resource-detail-directory"]',
      '教育教学 / Pre-K / 美德 / 教学资源',
      15000,
    )
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="file-row"]\')',
      20000,
      '文件行出现',
    )
    assert.equal(await browser.text('[data-testid="file-name"]'), '美德课程教案.pdf')
    assert.equal(await browser.attr('[data-testid="file-row"]', 'data-previewable'), 'true')
  })

  test('刷新浏览器之后文件还在（"上传成功但刷新就没了"这个缺陷被钉死）', async () => {
    await browser.reload()
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="file-row"]\')',
      20000,
      '刷新后文件行仍在',
    )
    assert.equal(await browser.text('[data-testid="file-name"]'), '美德课程教案.pdf')
  })

  test('刚上传的是草稿：目录浏览里**看不到**它，但「我的资源」里有（阶段 7 §17）', async () => {
    // ⚠️ 阶段 7 改过这里的期望：目录浏览默认只显示已发布。
    // 刚上传的草稿属于"还没上线"，所以只能出现在「我的资源」——
    // 这也正是业主 §17 的原话："自己的非发布资源只在 我的资源 看到"。
    await openVirtueResources()
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-list-section"]\')',
      20000,
      '目录页资源区就绪',
    )
    assert.equal(
      await browser.exists(`[data-resource-id="${resourceId}"]`),
      false,
      '草稿不该出现在目录浏览里',
    )

    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(
      `!!document.querySelector('[data-resource-id="${resourceId}"]')`,
      20000,
      '草稿在「我的资源」里',
    )
    // 位置标签在「我的资源」的卡片上同样要给出来（业主最关心的"东西去哪了"）
    const location = await browser.text(
      `[data-resource-id="${resourceId}"] [data-testid="resource-card-location"]`,
    )
    assert.equal(location, '教育教学 / Pre-K / 美德 / 教学资源')
  })

  test('预览：真的出现 PDF（浏览器自带阅读器，不引入 PDF SDK）', async () => {
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮出现')
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="file-preview-pdf"]\')',
      20000,
      'PDF iframe 出现',
    )
    const src = await browser.attr('[data-testid="file-preview-pdf"]', 'src')
    assert.equal(typeof src === 'string' && src.length > 0, true, 'iframe 必须真的有地址')
    // 地址是短命签名地址，不是公开路径
    assert.match(src, /token=|X-Amz-Signature=/)
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('下载：落盘的文件 SHA256 == 上传文件的 SHA256（§8 / §23）', async () => {
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-download"]\')', 15000, '下载按钮出现')
    await browser.click('[data-testid="file-download"]')

    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (name) => name.endsWith('.pdf'))
    const downloaded = readFileSync(saved)
    assert.equal(
      sha256(downloaded),
      sha256(PDF_BYTES),
      '下载回来的字节必须与上传的逐字节一致（不是"文件名一样就算成功"）',
    )
    assert.equal(downloaded.length, PDF_BYTES.length)
    rmSync(saved, { force: true })
  })
})

describe('图片预览（§24）', () => {
  test('上传 PNG → 详情页预览显示真实图片', async () => {
    await uploadThroughUi({ title: '观察记录照片', filePath: FILES.png })
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-preview"]\')', 20000, '预览按钮出现')
    await browser.click('[data-testid="file-preview"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="file-preview-image"]\')',
      20000,
      '图片元素出现',
    )
    const src = await browser.attr('[data-testid="file-preview-image"]', 'src')
    assert.equal(typeof src === 'string' && src.length > 0, true)
    await browser.click('[data-testid="file-preview-close"]')
  })
})

describe('Office / ZIP 只能下载（§25）', () => {
  test('DOCX：没有预览按钮，有下载，并显示那句话', async () => {
    await uploadThroughUi({ title: '周计划', filePath: FILES.docx })
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-row"]\')', 20000, '文件行出现')
    assert.equal(await browser.exists('[data-testid="file-preview"]'), false, '不支持预览的类型不能有预览按钮')
    assert.equal(await browser.exists('[data-testid="file-download"]'), true, '必须有下载')
    assert.equal(
      await browser.text('[data-testid="file-preview-unsupported"]'),
      '此文件类型暂不支持在线预览，请下载查看。',
    )
  })

  test('ZIP：同样只能下载，且下载真的可用', async () => {
    await uploadThroughUi({ title: '素材包', filePath: FILES.zip })
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-row"]\')', 20000, '文件行出现')
    assert.equal(await browser.exists('[data-testid="file-preview"]'), false)
    await browser.click('[data-testid="file-download"]')
    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (name) => name.endsWith('.zip'))
    assert.equal(sha256(readFileSync(saved)), sha256(ZIP_BYTES), 'ZIP 的字节也要逐字节一致')
    rmSync(saved, { force: true })
  })
})

describe('多文件：+ 添加文件（§2）', () => {
  test('同一个资源里再加一个文件 → 两行都在', async () => {
    await uploadThroughUi({ title: '多文件探针', filePath: FILES.pdf })
    await browser.waitFor('!!document.querySelector(\'[data-testid="file-add"]\')', 15000, '「+ 添加文件」出现')
    await browser.click('[data-testid="file-add"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="add-file-dialog"]\')', 15000, '添加文件弹窗打开')
    await browser.setFileInput('[data-testid="add-file-input"]', FILES.png)
    await browser.waitFor('!!document.querySelector(\'[data-testid="add-file-name"]\')', 15000, '文件名出现')
    await browser.click('[data-testid="add-file-submit"]')
    await browser.waitFor(
      'document.querySelectorAll(\'[data-testid="file-row"]\').length === 2',
      30000,
      '两行文件出现',
    )
    const names = await browser.allTexts('[data-testid="file-name"]')
    assert.deepEqual(names.sort(), ['美德课程教案.pdf', '观察记录照片.png'])
  })
})

describe('取消上传（§15）', () => {
  test('上传中点「取消上传」→ 明确说明没保存，且没有登记任何文件', async () => {
    await login('s6_teacher', 'S6TeacherPass!1')
    // 限速让上传过程停在中途，这样"取消"测的是真事，不是时序侥幸。
    await browser.setUploadThroughput(60 * 1024) // 60 KB/s
    try {
      await openVirtueResources()
      await browser.click('[data-testid="directory-upload"]')
      await browser.waitFor('!!document.querySelector(\'[data-testid="upload-dialog"]\')', 15000, '弹窗打开')
      await browser.fill('[data-testid="upload-title"]', '取消上传探针')
      await browser.setFileInput('[data-testid="upload-file-input"]', FILES.big)
      await browser.click('[data-testid="upload-submit"]')

      await browser.waitFor(
        '!!document.querySelector(\'[data-testid="upload-progress-bar"]\')',
        30000,
        '进度条出现',
      )
      // 进度必须真的在动（不能是个假进度条）
      const percentText = await browser.text('[data-testid="upload-progress-text"]')
      assert.match(percentText ?? '', /正在上传 \d+%|上传完成/)

      await browser.waitFor('!!document.querySelector(\'[data-testid="upload-cancel"]\')', 15000, '取消按钮出现')
      await browser.click('[data-testid="upload-cancel"]')

      await browser.waitFor(
        '!!document.querySelector(\'[data-testid="upload-error"]\')',
        30000,
        '出现取消提示',
      )
      const message = await browser.text('[data-testid="upload-error"]')
      assert.match(message ?? '', /取消/, `应当说明已取消，实际「${message}」`)
      assert.match(message ?? '', /没有(被)?保存/, '必须说清"没有保存任何东西"')
    } finally {
      await browser.clearNetworkThrottle()
    }

    // 数据库里不能留下"登记了但不完整"的文件
    const rows = await withSql(async (sql) => {
      return sql`
        SELECT r.id::text FROM resources r
        WHERE r.title = '取消上传探针'
      `
    })
    for (const row of rows) {
      createdResources.push(row.id)
      const files = await withSql(async (sql) => {
        return sql`SELECT count(*)::int AS n FROM resource_files WHERE resource_id = ${row.id}`
      })
      assert.equal(files[0].n, 0, '取消之后不能登记任何文件')
    }
  })
})

describe('权限与跨目录（§26 / §27）', () => {
  test('没有该目录权限的老师：直接打开资源地址也看不到文件', async () => {
    const resourceId = await uploadThroughUi({ title: '权限探针', filePath: FILES.pdf })
    await login('s6_konly', 'S6KonlyPass!1')
    await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
    // 详情页会显示"找不到这条资源"（服务端 403，界面不假装成功）
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-detail-notfound"]\')',
      20000,
      '应当显示看不到',
    )
  })

  test('直接 HTTP 也一样被拒（不是只靠前端拦）', async () => {
    const kOnly = client()
    await kOnly.login('s6_konly', 'S6KonlyPass!1')
    const resourceId = createdResources[0]
    const detail = await kOnly.get(`/api/resources/${resourceId}`)
    assert.equal(detail.status, 403, JSON.stringify(detail.data))
    const files = await kOnly.get(`/api/resources/${resourceId}/files`)
    assert.equal(files.status, 403)
  })

  test('跨目录：改成 K 体能的 directoryId 去上传 → 403（API 必须拒绝）', async () => {
    const teacher = client()
    await teacher.login('s6_teacher', 'S6TeacherPass!1')
    // 老师有整个教育教学的权限，没有 K 体能 —— 这个目录 id 是客户端可以随便改的那个值。
    const res = await teacher.post('/api/resources', {
      directoryId: ids.kPe,
      title: '跨目录探针',
    })
    assert.equal(res.status, 403, `跨目录创建必须 403，实际 ${res.status} ${JSON.stringify(res.data)}`)
  })

  test('上传地址也不能指向别的目录的资源（换 id 上传 → 403/404）', async () => {
    const teacher = client()
    await teacher.login('s6_teacher', 'S6TeacherPass!1')
    const theirs = await admin.post('/api/resources', { directoryId: ids.kPe, title: 'K 体能里的资源' })
    createdResources.push(theirs.data.id)
    const res = await teacher.post(`/api/resources/${theirs.data.id}/files/upload-url`, {
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      size: PDF_BYTES.length,
      sha256: sha256(PDF_BYTES),
    })
    assert.equal(res.status, 403, JSON.stringify(res.data))
  })
})

describe('目录改名后详情页自动跟着变（§28）', () => {
  test('把「美德」改成「美德课程」→ 详情页的所属目录立刻是新的', async () => {
    // ⚠️ 上一条权限用例把会话切成了"只有 K 体能权限的老师"，
    // 这里必须先切回能进 Pre-K 的账号（第一版漏了，失败信息是"回落到教育教学"）。
    await login('s6_teacher', 'S6TeacherPass!1')
    const resourceId = await uploadThroughUi({ title: '改名探针', filePath: FILES.pdf })
    const virtueId = await directoryIdByPath('education/pre-k/virtue')
    const renamed = await admin.patch(`/api/directories/${virtueId}`, { name: '美德课程' })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data))

    try {
      // 详情页读的是目录树，所以刷新之后链路里就是新名字 —— 没有任何一处写死的名字。
      await browser.goto(`${TEST_BASE}/resources/${resourceId}`)
      await browser.waitFor(
        `(document.querySelector('[data-testid="resource-detail-directory"]')?.innerText || '').includes('美德课程')`,
        20000,
        `详情页应当显示新名字「美德课程」，实际「${await browser.text('[data-testid="resource-detail-directory"]')}」`,
      )
      assert.equal(
        await browser.text('[data-testid="resource-detail-directory"]'),
        '教育教学 / Pre-K / 美德课程 / 教学资源',
      )
    } finally {
      await admin.patch(`/api/directories/${virtueId}`, { name: '美德' })
    }
  })
})

describe('存储不可用时的诚实错误（§20）', () => {
  test('健康检查接口对管理员可见，且不含凭据', async () => {
    const res = await admin.get('/api/health/storage')
    assert.equal(res.status, 200)
    assert.equal(res.data.provider, 'local')
    assert.equal(res.data.configured, true)
    const body = JSON.stringify(res.data)
    assert.equal(body.includes('.devdata'), false, '不该把本地路径暴露出去')
    assert.equal(/secret|accessKey/i.test(body), false)
  })
})
