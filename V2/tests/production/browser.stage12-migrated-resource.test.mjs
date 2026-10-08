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

  // 业主 §1：逐步打印，不能只看最终结果
  const probe = await browser.session.eval(`(async () => {
    const cookieNames = document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean)
    const me = await fetch('/api/auth/me', { credentials: 'same-origin' })
    const meBody = await me.text()
    const list = await fetch('/api/resources?page=1&pageSize=1', { credentials: 'same-origin' })
    const listBody = await list.text()
    let total = null
    try { total = JSON.parse(listBody).total ?? null } catch {}
    return JSON.stringify({ url: location.pathname, cookieNames, meStatus: me.status,
                            meUser: (() => { try { return JSON.parse(meBody).user?.username ?? null } catch { return null } })(),
                            listStatus: list.status, total, listHead: listBody.slice(0, 120) })
  })()`)
  const info = JSON.parse(probe)
  console.log(`    · 地址 ${info.url}｜document.cookie: [${info.cookieNames.join(', ')}]`)
  console.log(`    · /api/auth/me → ${info.meStatus}（user=${info.meUser ?? 'null'}）`)
  console.log(`    · /api/resources → ${info.listStatus}（total=${info.total}）${info.listStatus !== 200 ? ' ' + info.listHead : ''}`)
}

describe('Stage 12B：登录与会话必须真的被证明过', () => {
  test('负向证明：错口令必须 401，对的口令才 200/201（测试不是"总是当登录成功"）', async () => {
    await browser.goto(`${BASE}/login`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 25000, '登录页')

    const attempt = async (username, password) =>
      JSON.parse(
        await browser.session.eval(`(async () => {
          const csrf = (document.cookie.match(/v2_csrf=([^;]+)/) || [])[1] ?? ''
          const res = await fetch('/api/auth/login', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-v2-csrf': csrf },
            body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)} }),
          })
          return JSON.stringify({ status: res.status })
        })()`),
      )

    const wrong = await attempt(ADMIN_USER, 'definitely-not-the-password')
    console.log(`    · 错误口令 → HTTP ${wrong.status}`)
    assert.equal(wrong.status, 401, `错误口令必须是 401（拿到 ${wrong.status} 说明这条测试证明不了任何事）`)

    const right = await attempt(ADMIN_USER, ADMIN_PASSWORD)
    console.log(`    · 正确口令 → HTTP ${right.status}`)
    assert.equal([200, 201].includes(right.status), true, `正确口令必须是 200/201（拿到 ${right.status}）`)
  })
})

describe('Stage 12B：迁移资源在目录里必须真的看得到', () => {
  test('目录页必须渲染资源列表，并列出一条迁移过来的真实资源', async () => {
    await loginAs(ADMIN_USER, ADMIN_PASSWORD)

    /*
      取"确实装着资源"的资料夹：
      用目录树自带的 `resourceCount`（接口自己算的），而不是 `?pageSize=200` ——
      后者超过接口上限会 400，解析出来没有 total，看起来像"迁移没数据"（本轮踩过）。
    */
    const tree = JSON.parse(
      await browser.session.eval(
        `fetch('/api/directories/tree',{credentials:'same-origin'}).then(r=>r.json()).then(j=>JSON.stringify(j))`,
      ),
    )
    const flat = []
    const walk = (n, p) => {
      const path = p === '' ? n.slug : `${p}/${n.slug}`
      flat.push({ id: n.id, path, name: n.name, allowFiles: n.allowFiles, resourceCount: n.resourceCount ?? 0, type: n.type })
      for (const c of n.children ?? []) walk(c, path)
    }
    for (const r of tree.roots ?? []) walk(r, '')
    const folders = flat.filter((f) => f.allowFiles && f.resourceCount > 0)
    assert.equal(
      folders.length > 0,
      true,
      `树里应当有装着资源的资料夹；实际 allowFiles 节点 ${flat.filter((f) => f.allowFiles).length} 个、` +
        `其中 resourceCount>0 的 0 个（这本身就说明资源没落在资料夹层）`,
    )
    const target = folders.sort((a, b) => b.resourceCount - a.resourceCount)[0]
    /*
      ⚠️ 不能用"树的 resourceCount"去判"Section 层有没有资源"：父节点的 resourceCount
      含**子树**，所以任何祖先都大于 0（第一版就是这么写错的）。
      Section 层是否真的为 0，用**接口按目录精确查**来判 —— 这才是同一口径。
    */
    const sectionOnly = flat
      .filter((f) => !f.allowFiles)
      .map((f) => f.id)
      .slice(0, 5)
    for (const id of sectionOnly) {
      const own = JSON.parse(
        await browser.session.eval(
          `fetch('/api/resources?page=1&pageSize=1&directoryId=${id}',{credentials:'same-origin'}).then(r=>r.json()).then(j=>JSON.stringify({total:j.total}))`,
        ),
      )
      assert.equal(own.total, 0, `导航节点 ${id} 自己不该直接挂资源（应当为 0，实际 ${own.total}）`)
    }

    // 打开这个目录页：资源列表必须真的渲染出来
    await browser.goto(`${BASE}/directory/${target.path}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 25000, '目录页')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list"]\')', 25000, '资源列表渲染')
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-card-title"]\')', 25000, '资源卡片')
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.length > 0, true, `目录 ${target.path} 的页面上应当列出资源，实际 0 条`)

    // 页面条数必须与接口自己算的 resourceCount 一致（防止渲染了却被前端过滤）
    const pageTotal = Number(String(await browser.text('[data-testid="resource-total"]')).replace(/\D/g, '') || '0')
    assert.equal(pageTotal, target.resourceCount, `页面显示 ${pageTotal} 条、接口说 ${target.resourceCount} 条 —— 必须一致`)
    console.log(`    ✅ ${target.path}（${target.name}）：页面列出 ${titles.length} 条，接口 ${target.resourceCount} 条`)

    // 能放资源的目录必须给出上传入口
    assert.equal(
      await browser.exists('[data-testid="directory-upload"]'),
      true,
      '能放资源的目录必须给出「上传资源」入口（allowFiles 的另一半影响）',
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
      flat.push({ id: n.id, path, name: n.name, allowFiles: n.allowFiles, resourceCount: n.resourceCount ?? 0 })
      for (const c of n.children ?? []) walk(c, path)
    }
    for (const r of tree.roots ?? []) walk(r, '')
    const folder = flat.filter((f) => f.allowFiles && f.resourceCount > 0).sort((a, b) => b.resourceCount - a.resourceCount)[0]
    assert.ok(folder, '应当有一个装着资源的可放资源目录')

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
    console.log(`    ✅ 已给 ${teacher.username} 开放 ${folder.path}（${folder.resourceCount} 条资源）`)

    // 授权之后该目录仍然正常列出资源（教师视角由集成用例覆盖：迁移来的口令不在我们手里，
    // 不能拿它假装登录）
    await browser.goto(`${BASE}/directory/${folder.path}`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="resource-list"]\')', 25000, '资源列表')
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.length > 0, true, `授权后目录 ${folder.path} 应当列出资源`)
    console.log(`    ✅ ${folder.path} 列出 ${titles.length} 条`)
  })
})
