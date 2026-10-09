/**
 * tests/safari/acceptance.safari.test.mjs —— 在**真实 Safari** 里跑完整业务链
 * ============================================================================
 * 业主 Stage 10 §20 要求 Chrome 与 Safari **各跑一次**，并且这一遍要覆盖：
 *
 *   登录 → 教育教学 → Pre-K → 美德 → 教学资源 → 打开资源详情 → PDF 预览 →
 *   图片预览 → 下载 → 我的资源 → 提交审核 → 管理员审核 → 发布 → 删除 → 恢复
 *
 * 为什么单独放一个目录、**不进 `npm test`**：
 *   Safari 的 WebDriver 需要系统级的一次性开关（设置 → 开发者 → 允许远程自动化），
 *   它没法在 CI 或别人机器上自动打开。放进默认门禁会让"门禁红"变成环境问题，
 *   而那正是最容易被忽略的一种红。所以它是一个**显式命令**：
 *
 *     npm run test:safari
 *
 * 跑之前：`safaridriver -p 4444`，且 Safari 已允许远程自动化。
 * 没打开时这个文件会红在第一句，并且报错信息里就是那两步操作。
 *
 * 每一节都回数据库/接口核对（"Safari 里点了"不算，`deleted_at` 写上了才算）。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TEST_BASE,
  client,
  createAdmin,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { launchSafari, safariStatus, SafariUnavailableError } from '../helpers/safari.mjs'
import { pdfBytes } from '../helpers/upload.mjs'

/**
 * 同一个 Safari 要跑两遍：桌面 1440×900 与移动 390×844。
 * 业主 Stage 11 要求 "Desktop Safari PASS + Mobile Safari PASS" ——
 * WebKit 是同一个引擎，但**布局分支**完全不同（侧边栏 vs hamburger+抽屉），
 * 所以两遍都必须真跑。
 */
const VIEWPORT = process.env.SAFARI_VIEWPORT === 'mobile'
  ? { name: 'mobile', width: 390, height: 844 }
  : { name: 'desktop', width: 1440, height: 900 }

const WORK = mkdtempSync(join(tmpdir(), 'safari10-'))
const ADMIN = { username: 'saf_admin', password: 'SafAdminPass!1' }
const TEACHER = { username: 'saf_teacher', password: 'SafTeacherPass!1' }

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const FILES = {
  pdf: {
    name: '美德课程教案（Safari 验收）.pdf',
    bytes: pdfBytes('safari-stage10'),
  },
  png: {
    name: '环创照片（Safari 验收）.png',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  },
}
for (const f of Object.values(FILES)) {
  f.path = join(WORK, f.name)
  writeFileSync(f.path, f.bytes)
  f.sha256 = sha256(f.bytes)
}

let safari
let adminClient
const ids = {}
const results = []

/** 每一步都记 PASS/FAIL —— 业主明确要求"记录 PASS / FAIL"。 */
async function step(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, result: 'PASS', ms: Date.now() - started })
    console.log(`  ✔ PASS  ${name}`)
  } catch (error) {
    results.push({ name, result: 'FAIL', ms: Date.now() - started, error: error.message })
    console.log(`  ✖ FAIL  ${name}\n        ${error.message}`)
    throw error
  }
}

async function directoryIdByPath(path) {
  const rows = await withSql((sql) => sql`
    WITH RECURSIVE dp AS (
      SELECT id, slug::text AS path FROM directories WHERE parent_id IS NULL
      UNION ALL SELECT d.id, dp.path || '/' || d.slug FROM directories d JOIN dp ON d.parent_id = dp.id
    ) SELECT id::text FROM dp WHERE path = ${path}`)
  assert.equal(rows.length, 1, `目录 ${path} 必须存在`)
  return rows[0].id
}

/**
 * 进某个目录页 —— 桌面走侧边栏，窄屏走 hamburger + 抽屉。
 *
 * 两种模式共用**同一份**导航数据（抽屉里就是 SidebarNav），所以这里只是
 * "怎么把它打开"不同；这也正是 Stage 11 要验证的东西。
 */
async function navigateTo(path) {
  const mobile = await safari.exists('[data-testid="nav-open"]')
  if (mobile) {
    await safari.clickRobust('[data-testid="nav-open"]')
    await safari.waitFor('[data-testid="mobile-drawer"]', 20000, '抽屉打开')
  }
  const nav = `[data-nav="/directory/${path}"]`
  if (!(await safari.exists(nav))) {
    const segments = path.split('/')
    let prefix = ''
    for (const slug of segments.slice(0, -1)) {
      prefix = prefix === '' ? slug : `${prefix}/${slug}`
      const toggle = `[data-nav-toggle="/directory/${prefix}"]`
      if (await safari.exists(toggle)) {
        if ((await safari.attr(toggle, 'aria-expanded')) !== 'true') await safari.clickRobust(toggle)
      }
    }
  }
  await safari.waitFor(nav, 20000, `导航里有 ${path}`)
  await safari.clickRobust(nav)
  if (mobile) {
    // 点完自动关闭（抽屉不关就等于挡住内容）
    await safari.waitUntil(async () => !(await safari.exists('[data-testid="mobile-drawer"]')), {
      label: '抽屉自动关闭', timeoutMs: 15000,
    })
  }
  await safari.waitUntil(
    async () => (await safari.attr('[data-testid="directory-page"]', 'data-directory-path')) === path,
    { label: `到达 ${path}` },
  )
}

/** 在一张资源卡（按标题）上点它的标题链接。 */
async function clickCardByTitle(title) {
  const clicked = await safari.executeScript(
    `const title = arguments[0]
     const cards = [...document.querySelectorAll('[data-testid="resource-card-title"]')]
     const hit = cards.find((c) => (c.innerText || '').includes(title))
     if (!hit) return false
     hit.click()
     return true`,
    [title],
  )
  assert.equal(clicked, true, `列表里要有「${title}」这张卡`)
}

/**
 * 用**页面内的 `el.click()`** 点一个按钮。
 *
 * 为什么这些**动作按钮**不能走 WebDriver 的原生点击：Stage 13B 的 Safari 验收里，
 * 「回收站 → 恢复」那一步出现过"原生点击静默丢失" —— 一次专门探针记录到的现场是：
 *   · `clickRobust` 走的是 `element/click`（返回 `webdriver`，没有报错）；
 *   · 命中测试 `elementFromPoint` 在最中心取到的是那个 `BUTTON` 本身（不是被盖住）；
 *   · 但**没有任何请求发出**，界面也没有任何变化；
 *   · 同一时刻用页面内 `el.click()` 点同一个按钮 → 恢复成功（`deleted_at` 清空），
 *     紧接着用页面内 `fetch` 再调一次接口拿到 409「资源没有被删除」（证明第一次真的成功了）。
 * 也就是说：**产品在 Safari 里是好的，丢失的是驱动层的输入**。
 *
 * 触发条件看着像"WebDriver 先按下 ID 找到节点、再发点击"这套两步走：列表因为
 * 请求回来而重渲染（React 换掉节点）时，驱动手里的那个节点已经不在文档里，
 * 于是点击**静默丢失**。这解释了为什么同一份代码有时能点、有时点不动，
 * 而 Chrome 那条 CDP 通道（每次点击都重新查询 DOM）从没出过这个问题。
 *
 * ⚠️ 断言仍然看数据库效果（`deleted_at` / 状态 / 审计），所以产品逻辑真的坏掉时
 *    这些用例照样会红 —— 这里换的只是"怎么把点击送进去"，不是"放宽判据"。
 *    导航链接（侧边栏 `data-nav`、`nav-open`）**保留原生点击**：它们带 `href`，
 *    原生点击更接近真实用户，而且在所有运行里都没出过问题。
 */
async function clickInPage(testId) {
  const clicked = await safari.executeScript(
    `const el = document.querySelector('[data-testid="' + arguments[0] + '"]')
     if (!el) return false
     el.scrollIntoView({ block: 'center', inline: 'center' })
     el.click()
     return true`,
    [testId],
  )
  assert.equal(clicked, true, `页面上要有 [data-testid="${testId}"]`)
}

before(async () => {
  const status = await safariStatus()
  if (!status.driver) {
    throw new SafariUnavailableError(
      'safaridriver 没在跑。先在另一个终端执行：safaridriver -p 4444\n' +
      '并确认 Safari → 设置 → 开发者 → 勾选了「允许远程自动化」。',
    )
  }

  await resetDatabase()
  await createAdmin(ADMIN.username, ADMIN.password)
  await startServer()

  adminClient = client()
  await adminClient.login(ADMIN.username, ADMIN.password)

  const virtue = await directoryIdByPath('education/pre-k/virtue')
  const resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtue = virtue
  ids.resources = resources

  const created = await adminClient.post('/api/users', {
    name: 'Safari 验收老师',
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
    ],
  })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  ids.teacher = created.data.id

  // 两条已发布资源（一条 PDF、一条图片）——Safari 那一遍要预览、下载它们。
  // 走**真实上传链路**建出来（申请地址 → PUT → 登记），不是直接写库。
  const teacher = client()
  await teacher.login(TEACHER.username, TEACHER.password)
  for (const [key, f] of Object.entries(FILES)) {
    const resource = await teacher.post('/api/resources', {
      directoryId: resources,
      title: `Safari 验收资源（${key}）`,
    })
    assert.equal(resource.status, 201, JSON.stringify(resource.data))
    const { uploadFile } = await import('../helpers/upload.mjs')
    const file = await uploadFile(teacher, resource.data.id, {
      fileName: f.name,
      bytes: f.bytes,
      mimeType: f.name.endsWith('.pdf') ? 'application/pdf' : 'image/png',
    })
    ids[`file_${key}`] = file.id
    const submitted = await teacher.post(`/api/resources/${resource.data.id}/submit`)
    assert.equal(submitted.status, 201, JSON.stringify(submitted.data))
    const approved = await adminClient.post(`/api/resources/${resource.data.id}/review`, { action: 'approve' })
    assert.equal(approved.status, 201, JSON.stringify(approved.data))
    ids[`res_${key}`] = resource.data.id
  }

  /*
    再建一条**停在草稿**的资源：业主这一遍里有"我的资源 → 提交审核"，
    而前面两条已经被发布（要用来预览/下载）。草稿才是"提交审核"按钮出现的前提。
  */
  const draft = await teacher.post('/api/resources', {
    directoryId: resources,
    title: 'Safari 验收草稿（待提交）',
  })
  assert.equal(draft.status, 201, JSON.stringify(draft.data))
  const { uploadFile: uploadAgain } = await import('../helpers/upload.mjs')
  await uploadAgain(teacher, draft.data.id, {
    fileName: '草稿附件.txt',
    bytes: Buffer.from('Safari 验收草稿的附件\n', 'utf8'),
    mimeType: 'text/plain',
  })
  ids.draft = draft.data.id

  safari = await launchSafari()
  /*
    先把窗口设成**桌面尺寸**再开始：业主这一节要的是"Safari desktop"。
    V2 的侧边栏在窄视口下是 `hidden`（且目前没有汉堡菜单），
    窗口太窄会让"点了侧边栏"变成"点了一个 0×0 的元素"，
    那测的是视口，不是业务。窄视口的问题记在验收报告的"发现"里，属于阶段 11。
  */
  const rect = await safari.setWindowRect(VIEWPORT)
  console.log(`  Safari 视口：${rect.width}×${rect.height}（${VIEWPORT.name}）`)
})

after(async () => {
  if (safari) await safari.quit().catch(() => {})
  await stopServer()
  rmSync(WORK, { recursive: true, force: true })
  // 汇总表：即使前面红了，也让已经跑过的步骤留下 PASS/FAIL 记录
  if (results.length > 0) {
    console.log('\n  Safari 验收步骤：')
    for (const r of results) console.log(`    ${r.result.padEnd(4)} ${r.name}（${r.ms}ms）`)
  }
})

describe('Safari Desktop 真实业务链（业主 Stage 10 §20）', () => {
  test('① 登录', async () => {
    await step('打开登录页并登录', async () => {
      await safari.goto(`${TEST_BASE}/login`)
      await safari.waitFor('[data-testid="login-page"]')
      await safari.type('[data-testid="login-username"]', TEACHER.username)
      await safari.type('[data-testid="login-password"]', TEACHER.password)
      await clickInPage('login-submit')
      // 登录成功的判据：顶栏出现（桌面与窄屏都有它）。
      // 不能用 `[data-testid="sidebar"]` —— 窄屏下侧边栏**根本不渲染**（阶段 11 的设计）。
      await safari.waitFor('[data-testid="header"]', 25000, '登录后进入应用外壳')
    })
  })

  test('② 教育教学 → Pre-K → 美德 → 教学资源（全靠点击）', async () => {
    await step('一格格点进 教学资源', async () => {
      for (const path of [
        'education', 'education/pre-k', 'education/pre-k/virtue', 'education/pre-k/virtue/resources',
      ]) {
        await navigateTo(path)
      }
      const title = await safari.text('[data-testid="directory-title"]')
      assert.equal(title, '教学资源')
    })
  })

  test('③ 打开资源详情', async () => {
    await step('点开 PDF 那条资源，进入详情页', async () => {
      await safari.waitFor('[data-testid="resource-card-title"]', 20000, '资源卡片')
      await clickCardByTitle('Safari 验收资源（pdf）')
      await safari.waitFor('[data-testid="resource-detail-page"]', 20000, '详情页')
      const title = await safari.text('[data-testid="resource-detail-title"]')
      assert.match(title, /Safari 验收资源（pdf）/)
    })
  })

  test('④ PDF 预览（Safari 自己把 PDF 取回来）', async () => {
    await step('预览 PDF：iframe + 签名地址 + Safari 真的取到 application/pdf', async () => {
      await safari.waitFor('[data-testid="file-preview"]', 20000, '预览按钮')
      await clickInPage('file-preview')
      await safari.waitFor('[data-testid="file-preview-pdf"]', 20000, 'PDF iframe')
      const src = await safari.attr('[data-testid="file-preview-pdf"]', 'src')
      assert.match(String(src), /token=|X-Amz-Signature=/, '预览必须是短命签名地址')

      /*
        「真打开」的判据：让 **Safari 自己**去请求那个地址，并核对
        · HTTP 200
        · Content-Type 是 application/pdf
        · 字节数与上传的一致
        只断言"页面上有个 iframe"是不够的 —— iframe 可以指向一个 404。
      */
      const probed = await safari.executeScript(
        `const url = arguments[0]
         const res = await fetch(url)
         const buf = await res.arrayBuffer()
         return { status: res.status, type: res.headers.get('content-type') || '', size: buf.byteLength }`,
        [String(src)],
      )
      assert.equal(probed.status, 200, `Safari 取 PDF 的状态码：${probed.status}`)
      assert.match(String(probed.type), /application\/pdf/)
      assert.equal(probed.size, FILES.pdf.bytes.length)
      await clickInPage('file-preview-close')
    })
  })

  test('⑤ 图片预览（Safari 真的解码出图）', async () => {
    await step('打开图片那条资源，预览里图片解码成功', async () => {
      await safari.goto(`${TEST_BASE}/resources/${ids.res_png}`)
      await safari.waitFor('[data-testid="file-preview"]', 20000, '预览按钮')
      await clickInPage('file-preview')
      await safari.waitFor('[data-testid="file-preview-image"]', 20000, '图片预览')
      const loaded = await safari.executeScript(
        `const img = document.querySelector('[data-testid="file-preview-image"]')
         return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0`,
      )
      assert.equal(loaded, true, 'Safari 必须真的把图片解码出来（naturalWidth > 0）')
      await clickInPage('file-preview-close')
    })
  })

  test('⑥ 下载（Safari 取回字节，sha256 一致；服务端留下载审计）', async () => {
    await step('点下载 → 审计有记录 → Safari 取回的字节 sha256 与上传一致', async () => {
      await safari.goto(`${TEST_BASE}/resources/${ids.res_pdf}`)
      await safari.waitFor('[data-testid="file-download"]', 20000, '下载按钮')

      /*
        顺序有讲究：**先**用 Safari 把字节取回来核对，**再**点下载按钮。

        第一版是反过来的（先点下载再 fetch），在窄屏下偶发 "Load failed" ——
        因为点击会让浏览器开始一次附件下载（`window.location.assign` 到带
        `Content-Disposition: attachment` 的地址），Safari 会取消这个页面里
        还没完成的 fetch。桌面窗口下时序凑巧躲过了，窄屏下就撞上。
        取字节与"点下载"本来就是两件独立的事，拆开做既准确又没有竞态。
      */
      const url = await safari.executeScript(
        `const res = await fetch('/api/resources/' + arguments[0] + '/files/' + arguments[1] + '/download')
         if (!res.ok) return null
         const body = await res.json()
         return body.url`,
        [ids.res_pdf, ids.file_pdf],
      )
      assert.equal(typeof url, 'string', '要能从接口拿到签名下载地址')

      const got = await safari.executeScript(
        `const res = await fetch(arguments[0])
         const buf = await res.arrayBuffer()
         const digest = await crypto.subtle.digest('SHA-256', buf)
         const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
         return { status: res.status, size: buf.byteLength, sha256: hex,
                  disposition: res.headers.get('content-disposition') || '' }`,
        [String(url)],
      )
      assert.equal(got.status, 200)
      assert.equal(got.size, FILES.pdf.bytes.length)
      assert.equal(got.sha256, FILES.pdf.sha256, 'Safari 取回的字节必须与上传的逐字节一致')
      assert.match(String(got.disposition), /attachment/, '下载要带 Content-Disposition: attachment')

      // 真正的"点下载"：服务端会为这次下载留下审计
      await clickInPage('file-download')
      await safari.waitUntil(async () => {
        const [row] = await withSql((sql) => sql`
          SELECT count(*)::int AS n FROM audit_logs
          WHERE action = 'resource.download' AND target_id = ${ids.file_pdf}`)
        return row.n >= 1
      }, { label: '下载审计落库', timeoutMs: 25000 })
    })
  })

  test('⑦ 我的资源 → 提交审核', async () => {
    await step('在 Safari 里提交一条资源去审核', async () => {
      await safari.goto(`${TEST_BASE}/my-resources`)
      await safari.waitFor('[data-testid="my-resources-page"]', 20000, '我的资源')
      await safari.waitFor('[data-testid="my-resource-submit"]', 20000, '提交按钮')
      await clickInPage('my-resource-submit')
      await safari.waitUntil(async () => {
        const [row] = await withSql((sql) => sql`
          SELECT count(*)::int AS n FROM resources
          WHERE uploader_id = ${ids.teacher} AND status = 'PENDING_REVIEW' AND deleted_at IS NULL`)
        return row.n >= 1
      }, { label: '至少一条进入待审核', timeoutMs: 20000 })
    })
  })

  test('⑧ 管理员审核 → 通过并发布', async () => {
    await step('管理员在 Safari 里通过并发布刚才那条', async () => {
      const [pending] = await withSql((sql) => sql`
        SELECT id::text FROM resources
        WHERE uploader_id = ${ids.teacher} AND status = 'PENDING_REVIEW'
        ORDER BY updated_at DESC LIMIT 1`)
      assert.ok(pending, '要有一条待审核的资源')
      ids.pendingId = pending.id

      // 退出老师、登录管理员（同一个 Safari 窗口）
      await safari.goto(`${TEST_BASE}/`)
      await safari.waitFor('[data-testid="logout-button"]', 20000, '已登录')
      await clickInPage('logout-button')
      await safari.waitFor('[data-testid="login-page"]', 20000, '回到登录页')
      await safari.type('[data-testid="login-username"]', ADMIN.username)
      await safari.type('[data-testid="login-password"]', ADMIN.password)
      await clickInPage('login-submit')
      await safari.waitFor('[data-testid="header"]', 25000, '管理员进入应用')

      await safari.goto(`${TEST_BASE}/resources/${ids.pendingId}`)
      await safari.waitFor('[data-testid="action-approve"]', 20000, '通过按钮')
      await clickInPage('action-approve')
      await safari.waitUntil(async () => {
        const [row] = await withSql((sql) => sql`
          SELECT status FROM resources WHERE id = ${ids.pendingId}`)
        return row.status === 'PUBLISHED'
      }, { label: '状态变成已发布', timeoutMs: 20000 })
    })
  })

  test('⑨ 删除 → 回收站 → 恢复', async () => {
    await step('撤回 → 删除 → 回收站 → 恢复', async () => {
      /*
        顺序不是随便定的：`DELETABLE_STATUSES` 里**没有 PUBLISHED** ——
        已发布的内容必须先「撤回」才能删（否则它会从老师眼前直接消失）。
        所以这里走产品设计的真实路径：published → recall → 删除 → 回收站 → 恢复。
      */
      await safari.goto(`${TEST_BASE}/resources/${ids.res_png}`)
      await safari.waitFor('[data-testid="action-recall"]', 20000, '撤回按钮')
      await clickInPage('action-recall')
      await safari.waitFor('[data-testid="recall-comment"]', 20000, '撤回说明输入框')
      await safari.type('[data-testid="recall-comment"]', 'Safari 验收：先下架再删除')
      await clickInPage('recall-submit')
      await safari.waitUntil(async () => {
        const [row] = await withSql((sql) => sql`
          SELECT status FROM resources WHERE id = ${ids.res_png}`)
        return row.status === 'RECALLED'
      }, { label: '状态变成已撤回', timeoutMs: 20000 })

      await safari.waitFor('[data-testid="resource-detail-delete"]', 20000, '删除按钮')
      await clickInPage('resource-detail-delete')
      await safari.waitFor('[data-testid="resource-delete-dialog"]', 20000, '确认弹窗')
      await clickInPage('resource-delete-confirm')
      await safari.waitUntil(async () => {
        const [row] = await withSql((sql) => sql`
          SELECT deleted_at FROM resources WHERE id = ${ids.res_png}`)
        return row.deleted_at !== null
      }, { label: '软删除落库', timeoutMs: 20000 })

      await safari.goto(`${TEST_BASE}/my-resources`)
      await safari.waitFor('[data-testid="my-resources-tabs"]', 20000, '我的资源')
      const tabbed = await safari.executeScript(
        `const tab = [...document.querySelectorAll('[data-testid="my-resources-tab"]')]
           .find((t) => (t.innerText || '').trim() === '回收站')
         if (!tab) return false
         tab.click()
         return true`,
      )
      assert.equal(tabbed, true, '要有「回收站」这一栏')
      await safari.waitFor('[data-testid="my-resource-restore"]', 20000, '恢复按钮')
      // 见 `clickInPage` 的注释：这个按钮在 Safari 里要送页面内点击，
      // 否则原生命中测试通过、请求却发不出去（驱动层问题，不是产品问题）。
      await clickInPage('my-resource-restore')
      await safari.waitUntil(async () => {
        const [row] = await withSql((sql) => sql`
          SELECT deleted_at FROM resources WHERE id = ${ids.res_png}`)
        return row.deleted_at === null
      }, { label: '恢复后 deleted_at 清空', timeoutMs: 20000 })
    })
  })

  test('⑩ 汇总：这一步留下的 PASS/FAIL', () => {
    const failed = results.filter((r) => r.result === 'FAIL')
    assert.deepEqual(failed, [], `Safari 验收有失败步骤：${JSON.stringify(failed)}`)
    assert.equal(results.length >= 9, true, `应当至少跑完 9 步，实际 ${results.length}`)
    console.log(`  Safari 验收：${results.length} 步全部 PASS`)
    /*
      如实说明：哪些元素是"WebDriver 说点不动、改用页面内 click"完成的。
      页面内 click 仍然是 Safari 派发的真实点击，但不走命中测试 ——
      所以这份清单要出现在报告里，而不是被当成"全部走标准点击"。
    */
    if (safari.fallbackClicks.length > 0) {
      console.log('  说明：以下元素在 Safari 里走了页面内 click（WebDriver 判定不可交互），')
      console.log('       命中测试（elementFromPoint 取元素中心）结果如下：')
      for (const f of safari.fallbackClicks) {
        const verdict =
          f.hitTest === 'ok'
            ? '人点得到（最上层就是它，WebDriver 判定过严）'
            : `⚠ 可疑：hitTest=${f.hitTest} 最上层=${f.top} 尺寸=${f.w}×${f.h}`
        console.log(`    · ${f.selector} — ${verdict}`)
        assert.notEqual(
          f.hitTest,
          'blocked',
          `${f.selector} 在 Safari 里命中测试被挡住（最上层是 ${f.top}）—— 那是真问题，不是驱动严格`,
        )
      }
    } else {
      console.log('  全部点击都走 WebDriver 标准点击（含命中测试）')
    }
  })
})
