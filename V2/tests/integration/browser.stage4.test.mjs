/**
 * tests/integration/browser.stage4.test.mjs —— V2 阶段 4 的真实浏览器验收
 * ============================================================================
 * 这一份测的是「**Directory API → React → UI** 真的是数据驱动」。
 *
 * 为什么必须是浏览器：
 *   · 「管理员新增一级栏目『活动』→ 侧边栏自动出现」这条验收，本质是
 *     "React 有没有按数据渲染"。任何接口级断言都绕开了它 —— 接口全绿而界面写死，
 *     正是 V1 那个"改名后某处不同步"的成因。
 *   · 定位一律用**稳定标识**（`data-directory-id` / `data-directory-slug` /
 *     `data-testid`），不用"页面文字包含"。文案可以被管理员改（比如把「美德」
 *     改成「美德课程」），slug 不会。
 *
 * ⚠️ 所有读取都经过 `waitFor*`（见 tests/helpers/browser.mjs 的说明）：
 * V1 就是因为"读之前没有等待"而在门禁里偶发假红。
 */
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
} from '../helpers/harness.mjs'
import { launchBrowser } from '../helpers/browser.mjs'

let browser
let admin
let teacherId

/** 展开侧边栏直到某个路径可见（祖先链逐级展开）—— 真实的点击，不是直跳 URL。 */
async function expandSidebarTo(path) {
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
}

/**
 * 以某个账号登录。
 *
 * ⚠️ 必须先确保已退出：登录页在"已经登录"时会**重定向到 /**，
 * 于是"等登录页出现"会一直等不到 —— 失败信息看起来像"登录页坏了"，
 * 实际是上一个用例留下的会话。测试里切换账号是很常见的动作，
 * 所以这个前置条件放在这里，而不是让每个用例自己记得先退出。
 */
async function login(username, password) {
  await ensureLoggedOut()
  await browser.goto(`${TEST_BASE}/login`)
  await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '登录页出现')
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 15000, `登录 ${username} 后进入应用外壳`)
}

/** 无论当前是什么状态，都回到"未登录"。 */
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

async function logout() {
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '退出后回到登录页')
  }
}

/**
 * 在管理树里展开某个节点所在的行。
 *
 * 折叠的行**不会被渲染**，所以"断言子行存在"之前必须先展开父行 ——
 * 第一次跑的时候我漏了这一步，失败信息是"没等到子行"，
 * 而真实原因是它根本没渲染（页面文字里其实已经有"1 个子目录"）。
 */
async function expandManageRow(slug) {
  const row = `[data-testid="manage-row"][data-directory-slug="${slug}"]`
  await browser.waitFor(`!!document.querySelector('${row}')`, 15000, `管理树里出现 ${slug}`)
  const toggle = `${row} [data-testid="manage-row-toggle"]`
  // 叶子节点没有展开箭头（它是"暂时没有子节点"，不是"永远不能有"），
  // 所以这里要**等箭头出现**再点，而不是看一眼没有就跳过 ——
  // "刚建完第一个子目录"正是那种情况：刷新完成后箭头才存在。
  try {
    await browser.waitFor(`!!document.querySelector('${toggle}')`, 10000, `${slug} 的展开箭头出现`)
  } catch {
    return
  }
  const expanded = await browser.attr(toggle, 'aria-expanded')
  if (expanded !== 'true') await browser.click(toggle)
  await browser.waitFor(
    `document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true'`,
    10000,
    `${slug} 已展开`,
  )
}

before(async () => {
  await resetDatabase()
  await createAdmin('stage4_admin', 'Stage4AdminPass!1')
  // 教师的授权放在整个「教育教学」+「教师成长」上：他要能浏览，
  // 但**没有** directory.manage，因此不该看到任何管理入口。
  const education = await directoryIdByPath('education')
  const growth = await directoryIdByPath('growth')
  const teacher = await createTeacher(
    'stage4_teacher',
    'Stage4TeacherPass!1',
    [
      { permission: 'resource.view', directoryId: education },
      { permission: 'resource.view', directoryId: growth },
    ],
    '阶段四老师',
  )
  teacherId = teacher.id
  await startServer()
  admin = client()
  await admin.login('stage4_admin', 'Stage4AdminPass!1')
  browser = await launchBrowser()
})
after(async () => {
  if (browser) await browser.close()
  await stopServer()
})

// ===========================================================================
// 第一 / 第二阶段：Shell、登录、目录树显示
// ===========================================================================
describe('第一阶段：Shell（登录 → 页面 → 退出）', () => {
  test('1. 登录进入应用外壳，侧边栏与顶栏都在', async () => {
    await login('stage4_admin', 'Stage4AdminPass!1')
    assert.equal(await browser.exists('[data-testid="sidebar"]'), true)
    assert.equal(await browser.exists('[data-testid="header"]'), true)
    assert.equal(await browser.url(), '/')
  })

  test('退出后回到登录页，并且侧边栏消失', async () => {
    await logout()
    assert.equal(await browser.exists('[data-testid="sidebar"]'), false)
    await login('stage4_admin', 'Stage4AdminPass!1')
  })

  test('未登录时直接访问深层地址会被送去登录页（不是白屏）', async () => {
    await logout()
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="login-page"]\')', 15000, '未登录访问深层地址 → 登录页')
    await login('stage4_admin', 'Stage4AdminPass!1')
  })
})

describe('第二阶段：目录树完全由 API 驱动', () => {
  test('2. 侧边栏的一级栏目 = 接口返回的 roots（不是写死的数组）', async () => {
    const apiRoots = await admin.get('/api/directories/tree')
    const expected = apiRoots.data.roots.map((r) => r.slug)

    const slugs = await browser.allAttrs('[data-testid="sidebar-node"]', 'data-directory-slug')
    // 侧边栏此刻只展开了根层级，因此顶层节点就是全部 roots
    for (const slug of expected) {
      assert.ok(slugs.includes(slug), `侧边栏缺少一级栏目 ${slug}（实际 ${JSON.stringify(slugs.slice(0, 12))}）`)
    }
    assert.deepEqual(slugs.slice(0, expected.length), expected, '顺序也必须与接口一致')
  })

  test('首页的根卡片同样来自接口', async () => {
    const apiRoots = await admin.get('/api/directories/tree')
    const cards = await browser.allAttrs('[data-testid="home-root-card"]', 'data-directory-slug')
    assert.deepEqual(cards, apiRoots.data.roots.map((r) => r.slug))
  })

  test('源码里没有任何写死的目录数组（结构性证明）', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join, relative } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    // ⚠️ 必须用 fileURLToPath：`new URL(...).pathname` 会把路径里的中文
    // （本仓库路径含「幼儿园」）百分号编码，于是 readdirSync 直接 ENOENT。
    const root = fileURLToPath(new URL('../../client/src', import.meta.url))
    const files = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry)) files.push(full)
      }
    }
    walk(root)

    const banned = ['美德', '蒙台梭利', 'Pre-K', 'pre-k', 'virtue', 'montessori', 'growth', 'l1']
    const offenders = []
    for (const file of files) {
      const rel = relative(root, file)
      // 图标映射表允许按 slug 匹配外观；它不产生任何导航行为
      if (rel.endsWith(join('directory', 'DirectoryBrowser.tsx'))) continue
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      for (const name of banned) {
        if (code.includes(`'${name}'`) || code.includes(`"${name}"`)) {
          offenders.push(`${rel}: ${name}`)
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `前端出现了写死的目录名：\n  ${offenders.join('\n  ')}\n` +
        '目录只有一个真相（数据库），前端的任何目录名都只能来自接口。',
    )
  })
})

// ===========================================================================
// 第三阶段：浏览体验（教育教学 → Pre-K → 美德 → 四个资料夹）
// ===========================================================================
describe('第三阶段：浏览体验（点击进入，逐级）', () => {
  test('3+4+5. 教育教学 → Pre-K → 美德 → 四个资料夹，全部靠点击', async () => {
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 15000, '外壳就绪')

    // 侧边栏点「教育教学」
    await expandSidebarTo('education')
    await browser.click('[data-nav="/directory/education"]')
    await browser.waitFor('location.pathname === "/directory/education"', 10000, '进入 教育教学')
    await browser.waitForText('[data-testid="directory-title"]', '教育教学')

    // 卡片里点「Pre-K」
    await browser.waitFor('!!document.querySelector(\'[data-directory-slug="pre-k"]\')', 10000, 'Pre-K 卡片出现')
    await browser.click('[data-directory-slug="pre-k"]')
    await browser.waitFor('location.pathname === "/directory/education/pre-k"', 10000, '进入 Pre-K')
    await browser.waitForText('[data-testid="directory-title"]', 'Pre-K')

    // Pre-K 下四个科目
    const subjects = await browser.allAttrs('[data-testid="directory-card"]', 'data-directory-slug')
    assert.deepEqual(subjects, ['virtue', 'montessori', 'pe', 'english'], 'Pre-K 下应是四个科目')

    // 点「美德」
    await browser.click('[data-directory-slug="virtue"]')
    await browser.waitFor('location.pathname === "/directory/education/pre-k/virtue"', 10000, '进入 美德')
    await browser.waitForText('[data-testid="directory-title"]', '美德')

    // 四个资料夹
    const folders = await browser.allAttrs('[data-testid="directory-card"]', 'data-directory-slug')
    assert.deepEqual(folders, ['outline', 'lesson', 'resources', 'assessment'])
    const folderNames = await browser.session.eval(
      `JSON.stringify([...document.querySelectorAll('[data-testid="directory-card-name"]')].map((e) => e.innerText.trim()))`,
    )
    assert.deepEqual(JSON.parse(folderNames), ['课程大纲', '教学详案', '教学资源', '考核评估'])

    // 面包屑是完整链路（祖先链来自 parentId，不是 slug 前缀推断）
    const crumbs = await browser.allAttrs('[data-testid="breadcrumb"] [data-directory-slug]', 'data-directory-slug')
    assert.deepEqual(crumbs, ['education', 'pre-k', 'virtue'])
    assert.equal(await browser.text('[data-testid="breadcrumb-current"]'), '美德')
  })

  test('深层地址可以直接打开（刷新后仍在同一个节点）', async () => {
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue/resources`)
    await browser.waitForText('[data-testid="breadcrumb-current"]', '教学资源')
    await browser.reload()
    await browser.waitForText('[data-testid="breadcrumb-current"]', '教学资源')
  })

  test('不存在的路径：回退到最近可解析的祖先并给出提示，不白屏也不 404', async () => {
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/not-a-real-node`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-notice"]\')', 10000, '出现回退提示')
    assert.equal(await browser.text('[data-testid="directory-title"]'), 'Pre-K')
    assert.equal(await browser.exists('[data-testid="directory-card"]'), true, '仍然渲染出可用的内容')
  })
})

// ===========================================================================
// 第四阶段：教师成长是一等入口
// ===========================================================================
describe('第四阶段：教师成长（与教育教学同级）', () => {
  test('6+7+8+9. 教师成长 → L1 → 安全施教规范 → 应急预案 → 传染病识别与防治', async () => {
    await browser.goto(`${TEST_BASE}/`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 15000, '外壳就绪')

    // 「教师成长」和「教育教学」是**同级**的一等栏目 —— 都在 roots 里
    const roots = await browser.allAttrs('[data-testid="home-root-card"]', 'data-directory-slug')
    assert.deepEqual(roots, ['education', 'growth'])

    await expandSidebarTo('growth')
    await browser.click('[data-nav="/directory/growth"]')
    await browser.waitForText('[data-testid="directory-title"]', '教师成长')

    await browser.click('[data-directory-slug="l1"]')
    await browser.waitForText('[data-testid="directory-title"]', 'L1 基础规范')

    await browser.click('[data-directory-slug="safety"]')
    await browser.waitForText('[data-testid="directory-title"]', '安全施教规范')

    await browser.click('[data-directory-slug="plan"]')
    await browser.waitForText('[data-testid="directory-title"]', '应急预案')

    await browser.click('[data-directory-slug="disease"]')
    await browser.waitForText('[data-testid="directory-title"]', '传染病识别与防治')

    assert.equal(
      await browser.url(),
      '/directory/growth/l1/safety/plan/disease',
      '深层地址完全由目录 slug 推导',
    )

    // 刷新后仍在同一节点（树来自数据库，不是内存里的假象）
    await browser.reload()
    await browser.waitForText('[data-testid="breadcrumb-current"]', '传染病识别与防治')
  })
})

// ===========================================================================
// 第五阶段：动态目录（业主的核心验收）
// ===========================================================================
describe('第五阶段：管理员新增目录，前端零改动', () => {
  test('12+13+17. 新增一级栏目「活动」→ 刷新 → 侧边栏出现；再建子目录 → 刷新 → 仍在', async () => {
    await browser.goto(`${TEST_BASE}/directory/manage`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-manage-page"]\')', 15000, '进入目录管理')

    // ① 新增一级栏目「活动」
    await browser.click('[data-testid="manage-add-root"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-create-dialog"]\')', 10000, '新增一级栏目弹窗')
    await browser.fill('[data-testid="manage-create-name"]', '活动')
    await browser.fill('[data-testid="manage-create-name-en"]', 'Activities')
    await browser.fill('[data-testid="manage-create-slug"]', 'activities')
    await browser.click('[data-testid="manage-create-submit"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="activities"]\')',
      15000,
      '「活动」出现在管理树里',
    )

    // 刷新 → 侧边栏自动出现「活动」（这一步是验收的核心：没有改任何代码）
    await browser.reload()
    await browser.waitFor('!!document.querySelector(\'[data-testid="sidebar"]\')', 15000, '刷新后外壳就绪')
    await browser.waitFor(
      '!!document.querySelector(\'[data-nav="/directory/activities"]\')',
      15000,
      '侧边栏出现「活动」',
    )
    assert.equal(await browser.text('[data-nav="/directory/activities"]'), '活动')

    // ② 在「活动」下新增子目录「2027 春季活动」
    await browser.goto(`${TEST_BASE}/directory/manage`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="activities"]\')', 15000, '管理树就绪')
    await expandManageRow('activities')
    await browser.click('[data-testid="manage-row"][data-directory-slug="activities"] [data-testid="manage-add-child"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-create-dialog"]\')', 10000, '新增子目录弹窗')
    await browser.fill('[data-testid="manage-create-name"]', '2027 春季活动')
    await browser.fill('[data-testid="manage-create-name-en"]', 'Spring 2027')
    await browser.fill('[data-testid="manage-create-slug"]', 'spring-2027')
    await browser.click('[data-testid="manage-create-submit"]')
    // 新行在折叠的父行下面，所以先展开再断言
    await expandManageRow('activities')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="spring-2027"]\')',
      15000,
      '2027 春季活动出现在管理树里',
    )

    // 刷新 → 仍在，并且可以从界面点进去
    await browser.goto(`${TEST_BASE}/directory/activities`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="directory-browser"]\')', 15000, '活动页就绪')
    await browser.waitFor('!!document.querySelector(\'[data-directory-slug="spring-2027"]\')', 10000, '子目录卡片出现')
    await browser.reload()
    await browser.waitFor('!!document.querySelector(\'[data-directory-slug="spring-2027"]\')', 15000, '刷新后子目录仍在')

    // ③ 再新增「春游」
    await browser.goto(`${TEST_BASE}/directory/manage`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="activities"]\')', 15000, '管理树就绪')
    // 需要先展开 activities 才能看到 spring-2027 那一行
    await expandManageRow('activities')
    await expandManageRow('spring-2027')
    await browser.click('[data-testid="manage-row"][data-directory-slug="spring-2027"] [data-testid="manage-add-child"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-create-dialog"]\')', 10000, '新增子目录弹窗')
    await browser.fill('[data-testid="manage-create-name"]', '春游')
    await browser.fill('[data-testid="manage-create-name-en"]', 'Spring Outing')
    await browser.fill('[data-testid="manage-create-slug"]', 'spring-outing')
    await browser.click('[data-testid="manage-create-submit"]')
    await expandManageRow('spring-2027')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="spring-outing"]\')',
      15000,
      '春游出现在管理树里',
    )

    // 刷新 → 三级链路完整可点
    await browser.goto(`${TEST_BASE}/directory/activities/spring-2027`)
    await browser.waitFor('!!document.querySelector(\'[data-directory-slug="spring-outing"]\')', 15000, '春游卡片出现')
    await browser.reload()
    await browser.waitForText('[data-testid="breadcrumb-current"]', '2027 春季活动')
    assert.equal(await browser.exists('[data-directory-slug="spring-outing"]'), true, '刷新后春游仍在')

    // 点击进入：三级地址完全由 slug 推导
    await browser.click('[data-directory-slug="spring-outing"]')
    await browser.waitFor('location.pathname === "/directory/activities/spring-2027/spring-outing"', 10000, '进入 春游')
    await browser.waitForText('[data-testid="directory-title"]', '春游')
  })
})

// ===========================================================================
// 第六阶段：改名同步（四处的名字一起变，slug 不变）
// ===========================================================================
describe('第六阶段：改中文名 → 侧边栏 / 卡片 / 面包屑 / 标题全同步，slug 不变', () => {
  test('14+18. 美德 → 美德课程：四处同步，地址仍然是 virtue', async () => {
    const virtueId = await directoryIdByPath('education/pre-k/virtue')

    await browser.goto(`${TEST_BASE}/directory/manage`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="education"]\')', 15000, '管理树就绪')
    // 展开到 美德 那一行
    for (const slug of ['education', 'pre-k']) await expandManageRow(slug)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="virtue"]\')', 10000, '看到美德行')

    await browser.click('[data-testid="manage-row"][data-directory-slug="virtue"] [data-testid="manage-edit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-edit-dialog"]\')', 10000, '编辑弹窗出现')
    await browser.fill('[data-testid="manage-name-input"]', '美德课程')
    await browser.click('[data-testid="manage-save"]')
    await browser.waitFor(
      '[...document.querySelectorAll(\'[data-testid="manage-row-name"]\')].some((e) => e.innerText.trim() === "美德课程")',
      15000,
      '管理页出现「美德课程」',
    )
    // 管理页自己先同步（这是第三处）
    assert.equal(
      await browser.attr('[data-testid="manage-row"][data-directory-slug="virtue"]', 'data-directory-id'),
      virtueId,
      'id 不因改名而改变',
    )

    // 刷新，然后验证其余三处
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue`)
    await browser.waitForText('[data-testid="breadcrumb-current"]', '美德课程')
    assert.equal(await browser.url(), '/directory/education/pre-k/virtue', '⑤ 地址（slug）不变')

    // ① 侧边栏
    await expandSidebarTo('education/pre-k/virtue')
    assert.equal(await browser.text('[data-nav="/directory/education/pre-k/virtue"]'), '美德课程')

    // ② Pre-K 页面上的卡片
    await browser.goto(`${TEST_BASE}/directory/education/pre-k`)
    await browser.waitFor('!!document.querySelector(\'[data-directory-slug="virtue"]\')', 15000, 'Pre-K 页就绪')
    assert.equal(
      await browser.text('[data-directory-slug="virtue"] [data-testid="directory-card-name"]'),
      '美德课程',
    )

    // ③ 目录标题
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue`)
    await browser.waitForText('[data-testid="directory-title"]', '美德课程')

    // 改回去，避免影响后面的用例
    const back = await admin.patch(`/api/directories/${virtueId}`, { name: '美德' })
    assert.equal(back.status, 200)
  })

  test('15+16. 改英文名与描述：落库并在界面上显示', async () => {
    const virtueId = await directoryIdByPath('education/pre-k/virtue')
    await browser.goto(`${TEST_BASE}/directory/manage`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="education"]\')', 15000, '管理树就绪')
    for (const slug of ['education', 'pre-k']) await expandManageRow(slug)
    await browser.click('[data-testid="manage-row"][data-directory-slug="virtue"] [data-testid="manage-edit"]')
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-edit-dialog"]\')', 10000, '编辑弹窗出现')
    await browser.fill('[data-testid="manage-name-en-input"]', 'Virtue Course')
    await browser.fill('[data-testid="manage-description-input"]', '美德课程说明（阶段四验收）')
    await browser.click('[data-testid="manage-save"]')

    // 管理页显示英文名
    await browser.waitFor(
      '[...document.querySelectorAll(\'[data-testid="manage-row-name-en"]\')].some((e) => e.innerText.trim() === "Virtue Course")',
      15000,
      '管理页出现英文名',
    )

    // 浏览页显示描述
    await browser.goto(`${TEST_BASE}/directory/education/pre-k/virtue`)
    await browser.waitForText('[data-testid="directory-description"]', '美德课程说明（阶段四验收）')

    // 落库确认
    const node = await admin.get(`/api/directories/${virtueId}`)
    assert.equal(node.data.nameEn, 'Virtue Course')
    assert.equal(node.data.description, '美德课程说明（阶段四验收）')
    assert.equal(node.data.slug, 'virtue', 'slug 不变')

    await admin.patch(`/api/directories/${virtueId}`, { nameEn: 'Virtue', description: null })
  })
})

// ===========================================================================
// 第七 / 第十阶段：停用、启用、管理模式与权限边界
// ===========================================================================
describe('第七阶段：停用 / 启用，以及教师看不到管理操作', () => {
  test('10+11. 停用「英文」→ 教师看不到；重新启用 → 又可见', async () => {
    const englishId = await directoryIdByPath('education/pre-k/english')

    // 教师先确认能看到
    await login('stage4_teacher', 'Stage4TeacherPass!1')
    await browser.goto(`${TEST_BASE}/directory/education/pre-k`)
    await browser.waitFor('!!document.querySelector(\'[data-directory-slug="english"]\')', 15000, '教师看得到英文')

    // 管理员停用
    await logout()
    await login('stage4_admin', 'Stage4AdminPass!1')
    await browser.goto(`${TEST_BASE}/directory/manage`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="education"]\')', 15000, '管理树就绪')
    for (const slug of ['education', 'pre-k']) await expandManageRow(slug)
    await browser.click('[data-testid="manage-row"][data-directory-slug="english"] [data-testid="manage-toggle-enabled"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="english"] [data-testid="manage-row-disabled"]\')',
      15000,
      '管理页显示「已停用」',
    )

    // 教师看不到
    await logout()
    await login('stage4_teacher', 'Stage4TeacherPass!1')
    await browser.goto(`${TEST_BASE}/directory/education/pre-k`)
    await browser.waitFor('!!document.querySelector(\'[data-directory-slug="virtue"]\')', 15000, '教师页就绪')
    assert.equal(
      await browser.exists('[data-directory-slug="english"]'),
      false,
      '停用的节点不该出现在教师的浏览页里',
    )

    // 管理员重新启用
    await logout()
    await login('stage4_admin', 'Stage4AdminPass!1')
    await browser.goto(`${TEST_BASE}/directory/manage`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="education"]\')', 15000, '管理树就绪')
    for (const slug of ['education', 'pre-k']) await expandManageRow(slug)
    await browser.click('[data-testid="manage-row"][data-directory-slug="english"] [data-testid="manage-toggle-enabled"]')
    await browser.waitFor(
      '!document.querySelector(\'[data-testid="manage-row"][data-directory-slug="english"] [data-testid="manage-row-disabled"]\')',
      15000,
      '「已停用」标记消失',
    )
    const node = await admin.get(`/api/directories/${englishId}`)
    assert.equal(node.data.enabled, true)
  })

  test('19. 教师看不到「目录管理」入口，直接开地址也拿不到管理操作', async () => {
    await logout()
    await login('stage4_teacher', 'Stage4TeacherPass!1')

    // 侧边栏没有管理入口
    assert.equal(
      await browser.exists('[data-testid="nav-directory-manage"]'),
      false,
      '教师侧边栏不该有「目录管理」',
    )

    // 直接开地址：不出现任何管理按钮
    await browser.goto(`${TEST_BASE}/directory/manage`)
    await browser.waitFor('!!document.querySelector(\'[data-testid="manage-forbidden"]\')', 15000, '教师看到"没有权限"提示')
    assert.equal(await browser.exists('[data-testid="manage-edit"]'), false)
    assert.equal(await browser.exists('[data-testid="manage-delete"]'), false)
    assert.equal(await browser.exists('[data-testid="manage-add-root"]'), false)

    // 而且**接口也会拒绝**（界面隐藏按钮不等于后端允许）
    const teacher = client()
    await teacher.login('stage4_teacher', 'Stage4TeacherPass!1')
    const res = await teacher.post('/api/directories', {
      name: '教师偷建',
      slug: 'teacher-smuggled',
      type: 'ROOT',
    })
    assert.equal(res.status, 403, `接口必须拒绝，实际 ${res.status}`)
    void teacherId

    await logout()
    await login('stage4_admin', 'Stage4AdminPass!1')
  })
})

// ===========================================================================
// 第九阶段：界面上不出现内部概念
// ===========================================================================
describe('第九阶段：教师界面不出现 RBAC / scope / grant / deny 之类的内部概念', () => {
  test('管理页与浏览页的可见文字里没有内部术语', async () => {
    const banned = [
      'permission',
      'scope',
      'grant',
      'deny',
      'override',
      'role ceiling',
      'permission version',
      'rbac',
      'folderType',
      'folder_type',
      'presign',
      'storage key',
      'storageKey',
    ]
    for (const path of ['/', '/directory/education', '/directory/manage']) {
      await browser.goto(`${TEST_BASE}${path}`)
      await browser.waitFor('!!document.querySelector(\'[data-testid="main"]\')', 15000, `页面 ${path} 就绪`)
      const text = (await browser.snapshot()).text.toLowerCase()
      for (const word of banned) {
        assert.ok(
          !text.includes(word.toLowerCase()),
          `页面 ${path} 上出现了内部术语「${word}」`,
        )
      }
    }
  })
})
