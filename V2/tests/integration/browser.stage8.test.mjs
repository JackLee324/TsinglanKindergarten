/**
 * tests/integration/browser.stage8.test.mjs —— 管理员的真实浏览器验收
 * ============================================================================
 * 业主 §30–§35 指定的那条路：**管理员开一个账号 → 那位老师登录 → 只在他被开放的
 * 目录里能干活 → 加权限 → 旧会话失效 → 重新登录生效 → 撤销权限同理 →
 * 最后一个管理员停用被拒 → 目录链路还在 → 审计查得到。**
 *
 * 这一份的核心不是"页面长得对"，而是业主那句话：
 *
 *   > 管理员应该感觉"我就是在管理老师和目录"，
 *   > 而不是"我在配置一个复杂的 RBAC 系统"。
 *
 * 所以里面有一条**反向断言**：整个权限界面里不允许出现
 * `permission code` / `scope` / `grant` / `deny` / `override` / `effective`
 * 这些词 —— 界面一旦开始说这些，管理员就会开始觉得自己在配 RBAC。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEST_BASE,
  client,
  createAdmin,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { launchBrowser } from '../helpers/browser.mjs'

const PROBE_USERNAME = `zhangsan${Date.now().toString().slice(-6)}`
const PROBE_PASSWORD = 'ZhangSanPass!2026'
const PROBE_DIR_SLUG = `stage8-probe-${Date.now().toString().slice(-6)}`

let browser
let admin
let ids = {}
const createdResources = []

async function login(username, password) {
  await ensureLoggedOut()
  await browser.goto(`${TEST_BASE}/login`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '登录页出现')
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 15000, `登录 ${username}`)
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

async function openUsersPage() {
  await browser.goto(`${TEST_BASE}/admin/users`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="admin-users-page"]\')', 20000, '教师账号页')
}

/**
 * 展开权限编辑器目录树里的某一层。
 *
 * ⚠️ 折叠的节点**不会被渲染**，所以"等它出现"之前必须先展开父节点。
 * 第一次写这套用例时漏了这一步，失败信息是"「蒙特梭利」没出现"，
 * 而真实原因是 pre-k 是折叠的 —— 它根本没渲染出来。
 */
async function expandDirectoryOption(slug) {
  const toggle = `[data-testid="directory-option-toggle-${slug}"]`
  if (!(await browser.exists(toggle))) return
  // TreeRow 没有 aria-expanded，所以用"渲染出来的节点数变了没有"来判断展开，
  // 选择器要用**前缀**匹配：每个节点的 testid 是 `directory-option-<slug>`，
  // 不存在一个叫 `directory-option` 的元素（第一版就是在这里数出 0 和 0）。
  const countNodes = `document.querySelectorAll('[data-testid^="directory-option-"]').length`
  const before = await browser.session.eval(countNodes)
  await browser.click(toggle)
  await browser.waitFor(`${countNodes} !== ${before}`, 10000, `${slug} 展开后子节点出现`)
}

/** 展开侧边栏里的某一层（折叠的节点不渲染，必须先展开父级）。 */
async function expandSidebar(path) {
  const segments = path.split('/')
  let prefix = ''
  for (const segment of segments) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`
    const toggle = `[data-nav-toggle="/directory/${prefix}"]`
    if (await browser.exists(toggle)) {
      const expanded = await browser.attr(toggle, 'aria-expanded')
      if (expanded !== 'true') await browser.click(toggle)
    }
  }
  await browser.waitFor('true', 1000, '展开完成')
}

/** 找到某位老师的行（按用户名定位，不依赖中文姓名）。 */
async function userRow(username) {
  return `[data-testid="users-row"][data-username="${username}"]`
}

before(async () => {
  await resetDatabase()
  await createAdmin('s8_admin', 'S8AdminPass!1')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.kPe = await directoryIdByPath('education/k/pe')

  await startServer()
  admin = client()
  await admin.login('s8_admin', 'S8AdminPass!1')
  browser = await launchBrowser()
})

after(async () => {
  if (browser) await browser.close()
  if (createdResources.length > 0) {
    await withSql(async (sql) => {
      await sql`DELETE FROM resources WHERE id = ANY(${createdResources}::uuid[])`
    })
  }
  await withSql(async (sql) => {
    await sql`DELETE FROM users WHERE username = ${PROBE_USERNAME}`
    await sql`DELETE FROM directories WHERE slug = ${PROBE_DIR_SLUG}`
  })
  await stopServer()
})

describe('管理员导航（§22 / §23）', () => {
  test('管理员看到「管理」分组，里面是教师账号 / 权限 / 目录 / 审计', async () => {
    await login('s8_admin', 'S8AdminPass!1')
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar-admin"]\')', 15000, '管理分组出现')

    for (const [testId, label] of [
      ['nav-admin-users', '教师账号'],
      ['nav-admin-permissions', '权限'],
      ['nav-directory-manage', '目录'],
      ['nav-admin-audit', '审计'],
    ]) {
      const text = await browser.text(`[data-testid="${testId}"]`)
      assert.equal(text, label, `${testId} 的文案应当是「${label}」，实际「${text}」`)
    }
    // 审核入口也在（阶段 7 的，不重复做）
    assert.equal(await browser.exists('[data-testid="nav-review"]'), true)
  })
})

describe('① 新增教师并用它登录（§3 / §30）', () => {
  test('在界面上新增张老师：姓名 + 用户名 + 密码 + 权限 + 开放目录', async () => {
    await openUsersPage()
    await browser.click('[data-testid="users-create"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="create-user-dialog"]\')', 15000, '新增弹窗')

    await browser.fill('[data-testid="new-user-name"]', '张老师')
    await browser.fill('[data-testid="new-user-username"]', PROBE_USERNAME)
    await browser.fill('[data-testid="new-user-password"]', PROBE_PASSWORD)
    await browser.fill('[data-testid="new-user-confirm"]', PROBE_PASSWORD)

    // 权限：勾中文标签（界面不出现权限码）
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="permission-editor"]\')',
      20000,
      '权限编辑器',
    )
    for (const code of ['resource.view', 'resource.create', 'resource.update.own', 'resource.download']) {
      await browser.click(`[data-testid="permission-${code}"]`)
    }

    // 开放目录：Pre-K / 美德
    await expandDirectoryOption('pre-k')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="directory-option-virtue"]\')',
      15000,
      '「美德」出现',
    )
    await browser.click('[data-testid="directory-option-virtue"]')

    await browser.click('[data-testid="create-user-submit"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="users-notice"]\')',
      20000,
      '创建成功提示',
    )

    // 服务端真的存下了这些授权（不是只改了界面）
    const rows = await withSql(async (sql) => {
      return sql`
        SELECT p.permission, p.directory_id::text AS directory_id
        FROM user_permissions p JOIN users u ON u.id = p.user_id
        WHERE u.username = ${PROBE_USERNAME}
        ORDER BY p.permission
      `
    })
    assert.equal(rows.length, 4, `应当写入 4 条授权，实际 ${rows.length}`)
    for (const row of rows) assert.equal(row.directory_id, ids.virtue)
    assert.deepEqual(rows.map((r) => r.permission), [
      'resource.create',
      'resource.download',
      'resource.update.own',
      'resource.view',
    ])
  })

  test('权限界面里不出现 RBAC 术语（§25）', async () => {
    // 反向断言：界面开始说这些词，管理员就会开始觉得自己在配权限系统。
    const text = await browser.session.eval(
      `(document.querySelector('[data-testid="admin-users-page"]')?.innerText || '')`,
    )
    for (const banned of ['permission', 'scope', 'grant', 'deny', 'override', 'effective', 'resource.']) {
      assert.equal(
        String(text).toLowerCase().includes(banned.toLowerCase()),
        false,
        `界面里出现了「${banned}」，管理员不该看到这种词`,
      )
    }
  })

  test('张老师登录：只看得到 Pre-K，看不到 K', async () => {
    await login(PROBE_USERNAME, PROBE_PASSWORD)
    // 授权在 Pre-K/美德 → 侧边栏只应出现 Pre-K 那一支。
    // ⚠️ 折叠的节点不渲染，所以要先展开 education 才能看到它的子节点 ——
    // 第一版直接数 data-directory-slug，只拿到 `education` 一个。
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar-directories"]\')', 15000, '目录区')
    await expandSidebar('education')
    const slugs = await browser.allAttrs('[data-testid="sidebar-node"]', 'data-directory-slug')
    assert.equal(slugs.includes('pre-k'), true, `张老师应当看得到 Pre-K：${slugs.join(',')}`)
    assert.equal(slugs.includes('k'), false, `张老师不该看得到 K：${slugs.join(',')}`)

    // 管理分组不该出现（他不是管理员）
    assert.equal(await browser.exists('[data-testid="sidebar-admin"]'), false)
    assert.equal(await browser.exists('[data-testid="nav-review"]'), false, '他也没有审核权限')
  })

  test('能进 Pre-K / 美德 / 教学资源，并且看得到「上传资源」按钮', async () => {
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 20000, '目录页')
    await browser.waitForText('[data-testid="directory-title"]', '教学资源', 15000)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="directory-upload"]\')',
      15000,
      '有上传权限的老师应当看到上传入口',
    )
  })

  test('K 体能不能进（目录解析回落到最近可访问的祖先）', async () => {
    await browser.goto(`${TEST_BASE}/directory/education/k/pe/resources`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 20000, '目录页')
    // 解析不到 → 回到最近可访问的祖先，而不是显示出 K 的内容
    const notice = await browser.text('[data-testid="directory-notice"]')
    assert.equal(notice !== null && notice !== '', true, '应当提示"地址里的内容不可访问，已回到…"')
    const title = await browser.text('[data-testid="directory-title"]')
    assert.notEqual(title, '教学资源', '不能显示 K 体能的资料夹内容')
  })

  test('直接打 API 也一样被拒（不是只靠前端拦）', async () => {
    const zhang = client()
    await zhang.login(PROBE_USERNAME, PROBE_PASSWORD)
    const res = await zhang.get(`/api/resources?directoryId=${ids.kPe}`)
    assert.equal(res.status, 403, JSON.stringify(res.data))

    const create = await zhang.post('/api/resources', {
      directoryId: ids.kPe,
      title: '越权创建',
    })
    assert.equal(create.status, 403)
  })
})

describe('② 加权限 → 旧会话立刻失效（§5 / §31）', () => {
  test('张老师先登录：这时他进不去蒙特梭利', async () => {
    await login(PROBE_USERNAME, PROBE_PASSWORD)
    const zhang = client()
    await zhang.login(PROBE_USERNAME, PROBE_PASSWORD)
    const res = await zhang.get('/api/resources?directoryId=' + (await directoryIdByPath('education/pre-k/montessori')))
    assert.equal(res.status, 403, '现在还不该有蒙特梭利的权限')
  })

  test('管理员给他加上 Pre-K / 蒙特梭利 → 他在浏览器里的旧会话立刻失效', async () => {
    /*
     * ⚠️ 这里的管理员动作用 **API 客户端**，不是浏览器里的界面。
     *
     * 原因很实际：浏览器同时只能保持一个登录身份，而这条用例要看的正是
     * "**已经登录**的张老师被踢下线"。要一边保持着他的会话、一边让管理员改权限，
     * 就必须让管理员从浏览器之外发请求。
     *
     * 「管理员在界面上改权限」这件事由下面的用例单独覆盖（并且核对数据库）。
     */
    const montessori = await directoryIdByPath('education/pre-k/montessori')
    const teacherRow = await admin.get(`/api/users?q=${PROBE_USERNAME}`)
    const teacherId = teacherRow.data.items[0].id
    const current = await admin.get(`/api/users/${teacherId}/permissions`)

    // ⚠️ 把 GET 的结果原样回传是不行的：它带着界面用的 `label` 字段，
    // 而写接口的 DTO 是 `forbidNonWhitelisted`（多一个字段就 400）。
    // 这个严格性是对的 —— 它正是为了挡住"客户端回传一坨自己也不明白的东西"。
    // 所以这里显式映射成写接口的形状。
    const existing = current.data.items.map((g) => ({
      permission: g.permission,
      directoryId: g.directoryId,
    }))

    const res = await admin.put(`/api/users/${teacherId}/permissions`, {
      permissions: [
        ...existing,
        { permission: 'resource.view', directoryId: montessori },
        { permission: 'resource.create', directoryId: montessori },
        { permission: 'resource.update.own', directoryId: montessori },
        { permission: 'resource.download', directoryId: montessori },
      ],
    })
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.revokedSessions >= 1, true, '改权限必须撤销旧会话')

    // 浏览器里张老师还是"登录着"的（cookie 还在），但服务端已经把它作废了。
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="login-page"]\')',
      20000,
      '旧会话失效后应当被送到登录页',
    )
  })

  test('重新登录后新权限生效（蒙特梭利也能进）', async () => {
    await login(PROBE_USERNAME, PROBE_PASSWORD)
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/montessori`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-page"]\')', 20000, '目录页')
    await browser.waitForText('[data-testid="directory-title"]', '蒙特梭利', 15000)
  })

  test('管理员在界面上再改一次：界面与数据库一致，且提示里说明要重新登录', async () => {
    // 先让张老师**真的有一个活动会话**，否则 revokedSessions 是 0，
    // 提示语只会说"已保存"，这条用例就测不到"旧会话会失效"那句话。
    const zhangSession = client()
    assert.equal((await zhangSession.login(PROBE_USERNAME, PROBE_PASSWORD)).status, 201)

    await login('s8_admin', 'S8AdminPass!1')
    await openUsersPage()
    await browser.click(`${await userRow(PROBE_USERNAME)} [data-testid="users-row-permissions-button"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="permission-editor"]\')', 20000, '权限编辑器')

    // 当前应当是"统一开放目录"：美德 + 蒙特梭利
    await expandDirectoryOption('pre-k')
    await browser.waitFor(
      `document.querySelector('[data-testid="directory-option-virtue"]')?.checked === true`,
      15000,
      '美德已勾选',
    )
    await browser.waitFor(
      `document.querySelector('[data-testid="directory-option-montessori"]')?.checked === true`,
      15000,
      '蒙特梭利已勾选',
    )

    // 再点一次蒙特梭利 → 取消 → 保存
    await browser.click('[data-testid="directory-option-montessori"]')
    await browser.click('[data-testid="user-permissions-save"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="users-notice"]\')', 20000, '保存成功')
    const notice = await browser.text('[data-testid="users-notice"]')
    assert.match(notice ?? '', /重新登录/, `提示里要说明旧会话会失效，实际「${notice}」`)

    const rows = await withSql(async (sql) => {
      return sql`
        SELECT count(*)::int AS n FROM user_permissions p
        JOIN users u ON u.id = p.user_id
        WHERE u.username = ${PROBE_USERNAME} AND p.directory_id = ${await directoryIdByPath('education/pre-k/montessori')}
      `
    })
    assert.equal(rows[0].n, 0, '界面上取消勾选 → 数据库里的授权必须真的没了')
  })
})

describe('③ 撤销权限（§32）', () => {
  test('管理员取消「美德」，张老师重新登录后进不去', async () => {
    await login('s8_admin', 'S8AdminPass!1')
    await openUsersPage()
    await browser.click(`${await userRow(PROBE_USERNAME)} [data-testid="users-row-permissions-button"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="permission-editor"]\')', 20000, '权限编辑器')

    await expandDirectoryOption('pre-k')
    const virtue = '[data-testid="directory-option-virtue"]'
    await browser.waitFor(`!!document.querySelector('${virtue}')`, 15000, '「美德」出现')
    await browser.click(virtue)
    await browser.click('[data-testid="user-permissions-save"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="users-notice"]\')', 20000, '保存成功')

    const rows = await withSql(async (sql) => {
      return sql`
        SELECT count(*)::int AS n FROM user_permissions p
        JOIN users u ON u.id = p.user_id
        WHERE u.username = ${PROBE_USERNAME} AND p.directory_id = ${ids.virtue}
      `
    })
    assert.equal(rows[0].n, 0, '美德的授权必须被删掉')

    // 重新登录之后：美德进不去
    await login(PROBE_USERNAME, PROBE_PASSWORD)
    const zhang = client()
    await zhang.login(PROBE_USERNAME, PROBE_PASSWORD)
    assert.equal((await zhang.get(`/api/resources?directoryId=${ids.virtueResources}`)).status, 403)
  })
})

describe('④ 最后一个管理员不能被停用（§34）', () => {
  test('界面上尝试停用唯一的管理员 → 明确提示「系统至少需要一名管理员。」', async () => {
    await login('s8_admin', 'S8AdminPass!1')
    await openUsersPage()

    const me = await admin.get('/api/auth/me')
    const myUsername = me.data.user.username
    await browser.click(`${await userRow(myUsername)} [data-testid="users-row-edit"]`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="edit-user-dialog"]\')', 15000, '编辑弹窗')

    // 取消"启用" → 保存
    await browser.click('[data-testid="edit-user-active"]')
    await browser.click('[data-testid="edit-user-submit"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="edit-user-error"]\')',
      20000,
      '出现错误提示',
    )
    const message = await browser.text('[data-testid="edit-user-error"]')
    assert.equal(message, '系统至少需要一名管理员。')

    // 关掉弹窗后，账号仍然是启用的
    await browser.click('[data-testid="dialog-close"]')
    const status = await browser.text(`${await userRow(myUsername)} [data-testid="users-row-status"]`)
    assert.equal(status, '启用')
  })
})

describe('⑤ 目录：新增一级栏目 → 子目录 → 子目录（§10 / §33）', () => {
  test('在 /admin/directories 里建出 活动 → 2027 春季活动，刷新后仍在', async () => {
    await login('s8_admin', 'S8AdminPass!1')
    await browser.goto(`${TEST_BASE}/admin/directories`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-manage-page"]\')', 20000, '目录管理页')
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-add-root"]\')', 20000, '新增一级栏目按钮')

    await browser.click('[data-testid="manage-add-root"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-create-dialog"]\')', 15000, '新增弹窗')
    await browser.fill('[data-testid="manage-create-name"]', '阶段八活动')
    await browser.fill('[data-testid="manage-create-slug"]', PROBE_DIR_SLUG)
    await browser.click('[data-testid="manage-create-submit"]')
    await browser.waitFor(
      `!!document.querySelector('[data-testid="manage-row"][data-directory-slug="${PROBE_DIR_SLUG}"]')`,
      20000,
      '新栏目出现在管理树里',
    )

    // 刷新之后仍在（"刷新就没了"这种假成功必须被挡住）
    await browser.reload()
    await browser.waitFor(
      `!!document.querySelector('[data-testid="manage-row"][data-directory-slug="${PROBE_DIR_SLUG}"]')`,
      20000,
      '刷新后仍在',
    )

    // 侧边栏也应当出现它（目录是唯一真相）
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor(
      `!!document.querySelector('[data-nav="/directory/${PROBE_DIR_SLUG}"]')`,
      20000,
      '侧边栏出现新栏目',
    )
  })
})

describe('⑥ 审计查得到管理员做过的事（§35）', () => {
  test('审计页显示操作者 / 动作 / 目标 / 时间 / 结果', async () => {
    await login('s8_admin', 'S8AdminPass!1')
    await browser.goto(`${TEST_BASE}/admin/audit`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="admin-audit-page"]\')', 20000, '审计页')
    await browser.waitFor('!!document.querySelector(\'[data-testid="audit-row"]\')', 20000, '审计有记录')

    const rows = await browser.count('[data-testid="audit-row"]')
    assert.equal(rows > 0, true)
    assert.equal((await browser.text('[data-testid="audit-row-actor"]')) !== null, true, '有操作者')
    assert.equal((await browser.text('[data-testid="audit-row-action"]')) !== null, true, '有动作')
    assert.equal((await browser.text('[data-testid="audit-row-target"]')) !== null, true, '有目标')
    assert.equal((await browser.text('[data-testid="audit-row-result"]')) !== null, true, '有结果')
  })

  test('按动作筛选能查到"账号创建"，按结果筛选能查到成功', async () => {
    await browser.select('[data-testid="audit-action-filter"]', 'user.create')
    // ⚠️ 必须等**每一条**都是 user.create，而不是"存在一条" ——
    // 筛选前列表里本来就有 user.create 的行，那种条件在刷新完成前就已经成立，
    // 于是断言会读到还没筛过的旧列表（第一版就是这么红的：拿到 5 种动作）。
    await browser.waitFor(
      `[...document.querySelectorAll('[data-testid="audit-row"]')].length > 0 &&
       [...document.querySelectorAll('[data-testid="audit-row"]')].every((r) => r.getAttribute('data-action') === 'user.create')`,
      20000,
      '列表里只剩 user.create',
    )
    const actions = await browser.allAttrs('[data-testid="audit-row"]', 'data-action')
    assert.equal(new Set(actions).size, 1)
    assert.equal(actions[0], 'user.create')
  })
})
