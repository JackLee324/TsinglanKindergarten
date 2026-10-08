/**
 * tests/production/browser.stage12-migrated-resource.test.mjs
 * ============================================================================
 * 业主 Stage 12B §3 指定的回归：**迁移过来的资源，老师在目录里必须真的看得到。**
 *
 * 这条测试的来历（值得写下来，因为它只会在"新库"形态下暴露）：
 *
 *   阶段 9 的导入在**新建**目录节点时把 `allow_files` 写死成 `false`，
 *   而 V2 的目录浏览页只在 `allowFiles = true` 的节点渲染资源列表
 *   （`DirectoryBrowsePage`: `{target.node.allowFiles && <ResourceList …/>}`），
 *   上传接口同样要求目标目录 `allow_files = true`。
 *   于是：**资源迁进来了、`?directoryId=` 也查得到，但目录页不列、上传被拒。**
 *
 *   为什么阶段 9 没发现：那次预演的目标库**已经有 V2 的种子树**
 *   （日志是"匹配 69，需新建 0"），所以导入从没执行过"新建节点"这条分支。
 *   生产的新库要新建全部 69 个节点 —— 一写死就全站看不到资源。
 *
 * 它对着**已部署的环境**跑（与 production-browser.test.mjs 同一套约定），
 * 所以既能打在本地 Docker 演练栈上，也能打在 Zeabur 的正式域名上：
 *
 *   MIGRATED_BASE_URL=https://v2.localhost:8443 MIGRATED_INSECURE_TLS=1 \
 *   MIGRATED_ADMIN_USER=… MIGRATED_ADMIN_PASSWORD=… \
 *   node --test tests/production/browser.stage12-migrated-resource.test.mjs
 *
 * ⚠️ 放在 `tests/production/` 而不是 `tests/integration/`：它需要**一个已部署的环境**，
 *    没有环境时它应当"不参与"而不是"红着"或"假装跳过"。`npm test` 的 glob 是
 *    `tests/integration/*`，所以这里不会被顺带跑起来 —— 与 `tests/safari/` 同一个道理。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser } from '../helpers/browser.mjs'

const BASE = (process.env.MIGRATED_BASE_URL ?? '').replace(/\/+$/, '')
const INSECURE = process.env.MIGRATED_INSECURE_TLS === '1'
const ADMIN_USER = process.env.MIGRATED_ADMIN_USER ?? ''
const ADMIN_PASSWORD = process.env.MIGRATED_ADMIN_PASSWORD ?? ''
const WORK = mkdtempSync(join(tmpdir(), 'v2-migrated-'))

let browser

before(async () => {
  if (BASE === '') throw new Error('需要 MIGRATED_BASE_URL（对着已部署的环境跑）')
  browser = await launchBrowser({ headless: true, extraArgs: INSECURE ? ['--ignore-certificate-errors'] : [] })
  await browser.enableDownloads(join(WORK, 'downloads'))
  await browser.startProblemWatch()
})

after(async () => {
  if (browser) await browser.close()
  rmSync(WORK, { recursive: true, force: true })
})

async function loginAs(username, password) {
  await browser.goto(`${BASE}/`)
  await browser.waitFor(
    `!!document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="logout-button"]')`,
    25000,
    '应用或登录页就绪',
  )
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 20000, '退出')
  }
  await browser.goto(`${BASE}/login`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 25000, '登录页')
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="header"]\')', 30000, `登录 ${username}`)
}

describe('Stage 12B：迁移资源在目录里必须真的看得到', () => {
  test('目录页必须渲染资源列表，并列出一条迁移过来的真实资源', async () => {
    await loginAs(ADMIN_USER, ADMIN_PASSWORD)

    // ① 接口是"真值"：找出**确实有资源**的那个目录路径（不是随便挑一个资料夹）
    const listed = JSON.parse(
      await browser.session.eval(
        `fetch('/api/resources?page=1&pageSize=200',{credentials:'same-origin'}).then(r=>r.json()).then(j=>JSON.stringify(j))`,
      ),
    )
    assert.equal((listed.total ?? 0) > 0, true, '迁移之后应当有资源')
    const byPath = new Map()
    for (const r of listed.items ?? []) byPath.set(r.directoryPath, (byPath.get(r.directoryPath) ?? 0) + 1)
    const [targetPath, apiCount] = [...byPath.entries()].sort((a, b) => b[1] - a[1])[0]
    assert.ok(targetPath, '至少要有一条带目录路径的资源')

    // ② 该目录节点必须 allowFiles=true（否则浏览页根本不渲染列表 —— 这就是原缺陷）
    const tree = JSON.parse(
      await browser.session.eval(
        `fetch('/api/directories/tree',{credentials:'same-origin'}).then(r=>r.json()).then(j=>JSON.stringify(j))`,
      ),
    )
    const flat = []
    const walk = (n, p) => {
      const path = p === '' ? n.slug : `${p}/${n.slug}`
      flat.push({ id: n.id, path, allowFiles: n.allowFiles, name: n.name })
      for (const c of n.children ?? []) walk(c, path)
    }
    for (const r of tree.roots ?? []) walk(r, '')
    const node = flat.find((f) => f.path === targetPath)
    assert.ok(node, `目录树里应当有 ${targetPath}`)
    assert.equal(
      node.allowFiles,
      true,
      `目录「${node.name}」的 allowFiles 必须是 true —— 否则浏览页不渲染资源列表、上传也会被拒，` +
        '资源迁进来了老师也看不到（Stage 12B 修的就是这条）',
    )

    // ③ 打开这个目录页：资源列表必须真的渲染出来，并列出资源
    await browser.goto(`${BASE}/directory/${targetPath}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 25000, '目录页')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list"]\')', 25000, '资源列表渲染')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-card-title"]\')', 25000, '资源卡片')
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.length > 0, true, `目录 ${targetPath} 的页面上应当列出资源，实际 0 条`)
    const pageTotal = Number(String(await browser.text('[data-testid="resource-total"]')).replace(/\D/g, '') || '0')
    assert.equal(pageTotal, apiCount, `页面显示 ${pageTotal} 条、接口说 ${apiCount} 条 —— 必须一致`)
    console.log(`    ✅ ${targetPath}：页面列出 ${titles.length} 条，接口 ${apiCount} 条`)

    // ④ 目录里能上传（allow_files 也决定这件事）：按钮必须在
    assert.equal(
      await browser.exists('[data-testid="directory-upload"]'),
      true,
      '能放资源的目录必须给出「上传资源」入口（allow_files 的另一半影响）',
    )
  })

  test('教师被授权之后同样看得到（生产切换必须做的权限初始化）', async () => {
    await loginAs(ADMIN_USER, ADMIN_PASSWORD)

    const users = JSON.parse(
      await browser.session.eval(
        `fetch('/api/users?page=1&pageSize=100',{credentials:'same-origin'}).then(r=>r.json()).then(j=>JSON.stringify(j))`,
      ),
    )
    const teacher = (users.items ?? []).find((u) => u.role === 'TEACHER' && u.status === 'active')
    assert.ok(teacher, '迁移之后应当有启用的教师账号')

    const tree = JSON.parse(
      await browser.session.eval(
        `fetch('/api/directories/tree',{credentials:'same-origin'}).then(r=>r.json()).then(j=>JSON.stringify(j))`,
      ),
    )
    const flat = []
    const walk = (n, p) => {
      const path = p === '' ? n.slug : `${p}/${n.slug}`
      flat.push({ id: n.id, path, allowFiles: n.allowFiles, name: n.name })
      for (const c of n.children ?? []) walk(c, path)
    }
    for (const r of tree.roots ?? []) walk(r, '')
    // 选一个**真的装着资源**的资料夹（接口为准），授权给这位老师
    const listed = JSON.parse(
      await browser.session.eval(
        `fetch('/api/resources?page=1&pageSize=200',{credentials:'same-origin'}).then(r=>r.json()).then(j=>JSON.stringify(j))`,
      ),
    )
    const paths = new Set((listed.items ?? []).map((r) => r.directoryPath))
    const folder = flat.find((f) => f.allowFiles && paths.has(f.path))
    assert.ok(folder, '应当有一个装着资源的可放资源目录')

    // 界面上的"权限"入口 → 直接调同一个接口（界面按钮的用例在 stage8/stage10 已覆盖）
    const grant = JSON.parse(
      await browser.session.eval(`(async () => {
        const csrf = (document.cookie.match(/v2_csrf=([^;]+)/) || [])[1] ?? ''
        const res = await fetch('/api/users/${teacher.id}/permissions', {
          method: 'PUT', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-v2-csrf': csrf },
          body: JSON.stringify({ permissions: [
            { permission: 'resource.view', directoryId: '${folder.id}' },
            { permission: 'resource.download', directoryId: '${folder.id}' },
          ] }),
        })
        return JSON.stringify({ status: res.status })
      })()`),
    )
    assert.equal(grant.status, 200, `授权必须成功（生产切换要做 PRODUCTION_PERMISSION_BOOTSTRAP）：${JSON.stringify(grant)}`)
    console.log(`    ✅ 已给 ${teacher.username} 开放 ${folder.path}`)

    // 授权之后，该目录在管理员视角同样要列出资源（教师视角由集成用例覆盖：
    // 迁移过来的账号口令不在我们手里，不能拿它假装登录）
    await browser.goto(`${BASE}/directory/${folder.path}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list"]\')', 25000, '资源列表')
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.length > 0, true, `授权后目录 ${folder.path} 应当列出资源`)
    console.log(`    ✅ ${folder.path} 列出 ${titles.length} 条`)
  })
})
