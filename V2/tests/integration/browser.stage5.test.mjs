/**
 * tests/integration/browser.stage5.test.mjs —— V2 阶段 5 的真实浏览器验收
 * ============================================================================
 * 阶段 5 的交付面是「资源」这一条链：**资源 API → React → 界面**。
 * 所以这一份全部在真实浏览器里跑，走真实的登录、点击、输入、翻页、刷新。
 *
 * 为什么接口全绿还不够：业主提的问题是「我上传以后到底去哪了」。
 * 那是一个**界面**问题 —— 接口返回了 `directoryPath`，但卡片上没有渲染出来，
 * 接口测试照样全绿。所以这里断言的是"卡片上能不能看见那行中文位置"。
 *
 * 定位一律用稳定标识（`data-resource-id` / `data-testid` / `data-tab-key`），
 * 不用"页面文字包含"—— 文案是可以被改的（把「美德」改成「美德课程」是合法操作）。
 *
 * ⚠️ 所有读取都经过 `waitFor*`（见 tests/helpers/browser.mjs）：
 * V1 的门禁就是因为"读之前没有等待"而偶发假红，这个教训不重复第二遍。
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
import { makeResource, makeResources, purgeResources } from '../helpers/resource-fixture.mjs'
import { launchBrowser } from '../helpers/browser.mjs'

/** 资源列表每页 12 条（`ResourceList` 的默认值）—— 造 15 条正好两页。 */
const PAGE_SIZE = 12
const PUBLISHED_COUNT = 15

/**
 * 浏览页里能看到的就是 **15 条已发布**。
 *
 * ⚠️ 阶段 7 改过一次：阶段 5/6 时浏览页会带上"我自己那份还没发布的草稿"，
 * 因为可见性规则是"已发布 ∪ 自己上传的"。业主 Stage 7 §17 明确要求
 * **目录浏览默认只显示已发布**，自己那份未发布的资源只在「我的资源」里管理。
 *
 * 于是"这条资源上线了吗"在界面上只有一个不会误解的答案：
 * 目录里看到 = 已发布；草稿/待审/已退回/已撤回只出现在「我的资源」。
 * 下面还有一条用例专门钉住"自己的草稿也不在浏览页里"。
 */
const VISIBLE_IN_BROWSE = PUBLISHED_COUNT

const BROWSE_URL = `${TEST_BASE}/directory/education/pre-k/virtue/resources`
const LESSON_URL = `${TEST_BASE}/directory/education/pre-k/virtue/lesson`

let browser
let admin
let ids = {}
const probes = []
/** 全部探针共用的关键词，用来把断言限定在本次造的数据里。 */
const KEYWORD = `界面探针${Date.now().toString().slice(-6)}`

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

/** 无论当前什么状态，都回到"未登录"。 */
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

/** 打开某个目录页，并等资源区渲染完成（不是"等了 1 秒"）。 */
async function openDirectory(url, expectCards = true) {
  await browser.goto(url)
  await browser.waitFor(
    '!!document.querySelector(\'[data-testid="directory-page"]\')',
    20000,
    `目录页出现：${url}`,
  )
  if (expectCards) {
    await browser.waitFor(
      'document.querySelectorAll(\'[data-testid="resource-list"] [data-resource-id]\').length > 0',
      20000,
      '资源卡片渲染出来',
    )
  }
}

/** 当前列表里的资源卡片数。 */
async function cardCount() {
  return browser.count('[data-testid="resource-list"] [data-resource-id]')
}

/** 在页面上找"禁止出现的按钮"：阶段 5 不允许有下载/预览/上传入口。 */
async function fakeActionButtons() {
  const json = await browser.session.eval(`JSON.stringify(
    [...document.querySelectorAll('button, a')]
      .map((el) => (el.innerText || '').trim())
      .filter((t) => /下载|预览|上传/.test(t))
  )`)
  return JSON.parse(json ?? '[]')
}

before(async () => {
  await resetDatabase()
  await createAdmin('stage5_admin', 'Stage5AdminPass!1')
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtueLesson = await directoryIdByPath('education/pre-k/virtue/lesson')
  const education = await directoryIdByPath('education')

  const teacherUser = await createTeacher('stage5_teacher', 'Stage5TeacherPass!1', [
    { permission: 'resource.view', directoryId: education },
    { permission: 'resource.update.own', directoryId: education },
  ], '阶段五老师')
  // 另一位老师：他的草稿不该出现在"我的资源"里，也不该出现在浏览页里。
  const otherUser = await createTeacher('stage5_other', 'Stage5OtherPass!1', [
    { permission: 'resource.view', directoryId: education },
  ], '另一位老师')

  await startServer()
  admin = client()
  await admin.login('stage5_admin', 'Stage5AdminPass!1')
  browser = await launchBrowser()

  probes.push(
    ...(await makeResources({
      directoryId: ids.virtueResources,
      uploaderId: teacherUser.id,
      count: PUBLISHED_COUNT,
      prefix: `${KEYWORD} 已发布`,
    })),
  )
  // 同名的东西放在**别的**目录：用来证明"搜索不跨出当前目录"。
  probes.push(await makeResource({
    directoryId: ids.virtueLesson,
    uploaderId: teacherUser.id,
    title: `${KEYWORD} 周次教案里的同名资源`,
    status: 'PUBLISHED',
  }))
  // 老师自己的草稿：浏览页看不到（未发布），「我的资源」看得到。
  probes.push(await makeResource({
    directoryId: ids.virtueResources,
    uploaderId: teacherUser.id,
    title: `${KEYWORD} 我的草稿`,
    status: 'DRAFT',
  }))
  // 别人的草稿：老师在任何地方都不该看到。
  probes.push(await makeResource({
    directoryId: ids.virtueResources,
    uploaderId: otherUser.id,
    title: `${KEYWORD} 别人的草稿`,
    status: 'DRAFT',
  }))
})
after(async () => {
  if (browser) await browser.close()
  const removed = await purgeResources(probes)
  assert.equal(removed, probes.length, '探针必须全部清掉（残留核对）')
  await stopServer()
})

describe('目录浏览页：资源卡片', () => {
  test('进资料夹目录能看到该目录的资源', async () => {
    await login('stage5_teacher', 'Stage5TeacherPass!1')
    await openDirectory(BROWSE_URL)
    const total = await browser.text('[data-testid="resource-total"]')
    assert.equal(
      total,
      `共 ${VISIBLE_IN_BROWSE} 条`,
      `总数应是"该目录下我可见的资源"（${PUBLISHED_COUNT} 条已发布 + 我自己的草稿）`,
    )
  })

  test('每张卡片都显示「资源所在位置」，且是完整的中文链路', async () => {
    // 业主的原始问题：「我上传以后到底去哪了」。
    // 所以位置不是"有个字段"，而是卡片上**渲染出来的一行完整中文**。
    const locations = await browser.allTexts('[data-testid="resource-card-location"]')
    assert.equal(locations.length > 0, true, '卡片上必须有位置标签')
    for (const text of locations) {
      assert.equal(
        (text ?? '').trim(),
        '教育教学 / Pre-K / 美德 / 教学资源',
        `位置标签应是完整中文链路，实际「${text}」`,
      )
    }
  })

  test('每张卡片的状态徽章与它的真实状态一致（草稿不能伪装成已发布）', async () => {
    // 浏览页每页 12 条，而可见的是 16 条 —— 所以这里只看**本页**，
    // 总数由页码文案那条用例负责（第一版在这里断言 16，红在"页"与"全集"混用）。
    const statuses = await browser.allAttrs('[data-testid="resource-card"]', 'data-resource-status')
    assert.equal(statuses.length, PAGE_SIZE)
    const badges = await browser.allTexts('[data-testid="resource-card-status"]')
    assert.equal(badges.length, statuses.length, '每张卡片都要有状态徽章')
    const label = { PUBLISHED: '已发布', DRAFT: '草稿' }
    for (let i = 0; i < statuses.length; i += 1) {
      assert.equal(label[statuses[i]], badges[i], `状态 ${statuses[i]} 的徽章文案应是「${label[statuses[i]]}」`)
    }
    // 阶段 7 §17：浏览页**只有**已发布。所以每一张卡片的徽章都必须是「已发布」。
    assert.deepEqual(
      [...new Set(statuses)],
      ['PUBLISHED'],
      `浏览页只该出现已发布，实际：${statuses.join('、')}`,
    )
  })

  test('卡片上没有下载 / 预览 / 上传按钮（阶段 5 不给假按钮）', async () => {
    await openDirectory(BROWSE_URL)
    const labels = await fakeActionButtons()
    assert.deepEqual(labels, [], `不该出现这些按钮：${labels.join('、')}`)
  })

  test('未发布的资源一律不在浏览页（别人的和自己的都不在，业主 §17）', async () => {
    await openDirectory(BROWSE_URL)
    // 目录下 15 条已发布 + 1 条自己的草稿 + 1 条别人的草稿。
    const total = await browser.text('[data-testid="resource-total"]')
    assert.equal(total, `共 ${VISIBLE_IN_BROWSE} 条`, '未发布的资源不该被列出来')
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(titles.some((t) => /别人的草稿/.test(t ?? '')), false, '别人的草稿泄露了')
    assert.equal(
      titles.some((t) => /我的草稿/.test(t ?? '')),
      false,
      '自己的草稿也不该出现在目录浏览里 —— 它在「我的资源」',
    )
    // 自己的草稿确实存在，只是在别处可见（证明不是"数据没造出来"）
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(
      `(document.querySelector('[data-testid="my-resources-list"]')?.innerText || '').includes('我的草稿')`,
      20000,
      '自己的草稿在「我的资源」里',
    )
    // 管理员接口侧能看到全部 —— 证明"少的那条"是按可见性过滤的，不是数据没造出来。
    const asAdmin = await admin.get(`/api/resources?directoryId=${ids.virtueResources}&pageSize=100`)
    const adminTitles = asAdmin.data.items.map((i) => i.title)
    assert.equal(adminTitles.some((t) => /别人的草稿/.test(t)), true, '管理员看得到别人那条草稿')
  })
})

describe('搜索', () => {
  test('搜索只在**当前目录**里生效，不会跨目录捞资源', async () => {
    await openDirectory(BROWSE_URL)
    await browser.fill('[data-testid="resource-search-input"]', '周次教案里的同名资源')
    await browser.click('[data-testid="resource-search-submit"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-list-empty"]\')',
      15000,
      '当前目录里没有匹配项 → 空态',
    )
    assert.equal(await cardCount(), 0)
  })

  test('搜到之后只剩匹配的卡片，且位置标签仍然在', async () => {
    await openDirectory(BROWSE_URL)
    await browser.fill('[data-testid="resource-search-input"]', '已发布 07')
    await browser.click('[data-testid="resource-search-submit"]')
    await browser.waitFor(
      'document.querySelectorAll(\'[data-testid="resource-list"] [data-resource-id]\').length === 1',
      15000,
      '搜索命中 1 条',
    )
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(/07/.test(titles[0] ?? ''), true, `命中的应是 07，实际「${titles[0]}」`)
    const location = await browser.text('[data-testid="resource-card-location"]')
    assert.equal(location, '教育教学 / Pre-K / 美德 / 教学资源')
  })

  test('搜索无结果时给出"没有找到"和清空入口，而不是空白页', async () => {
    await openDirectory(BROWSE_URL)
    await browser.fill('[data-testid="resource-search-input"]', `${KEYWORD} 根本不存在的关键词`)
    await browser.click('[data-testid="resource-search-submit"]')
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-search-clear-empty"]\')',
      15000,
      '空态里出现"清空搜索"按钮',
    )
  })

  test('清空搜索后回到完整列表', async () => {
    await openDirectory(BROWSE_URL)
    await browser.fill('[data-testid="resource-search-input"]', '已发布 07')
    await browser.click('[data-testid="resource-search-submit"]')
    await browser.waitFor(
      'document.querySelectorAll(\'[data-testid="resource-list"] [data-resource-id]\').length === 1',
      15000,
      '先搜到 1 条',
    )
    await browser.click('[data-testid="resource-search-clear"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="resource-list"] [data-resource-id]').length === ${PAGE_SIZE}`,
      15000,
      '回到第一页 12 条',
    )
  })
})

describe('分页', () => {
  test('第一页 12 条，页码文案来自服务端算出的总数', async () => {
    await openDirectory(BROWSE_URL)
    await browser.waitForText(
      '[data-testid="resource-page-info"]',
      `第 1 页 / 共 2 页 · 本页 ${PAGE_SIZE} 条`,
      15000,
    )
    assert.equal(await cardCount(), PAGE_SIZE)
  })

  test('「上一页」在第一页不可点（不是点了没反应）', async () => {
    const disabled = await browser.attr('[data-testid="resource-page-prev"]', 'disabled')
    assert.notEqual(disabled, null, '第一页的「上一页」必须被禁用')
  })

  test('点「下一页」→ 第 2 页只剩剩下的条目，且「下一页」变成禁用', async () => {
    const firstPageIds = await browser.allAttrs('[data-testid="resource-card"]', 'data-resource-id')
    await browser.click('[data-testid="resource-page-next"]')
    await browser.waitForText(
      '[data-testid="resource-page-info"]',
      `第 2 页 / 共 2 页 · 本页 ${VISIBLE_IN_BROWSE - PAGE_SIZE} 条`,
      15000,
    )
    const secondPageIds = await browser.allAttrs('[data-testid="resource-card"]', 'data-resource-id')
    assert.equal(secondPageIds.length, VISIBLE_IN_BROWSE - PAGE_SIZE)
    // 两页不能有交集 —— 这就是"翻页不重不漏"在界面上的样子。
    for (const id of secondPageIds) {
      assert.equal(firstPageIds.includes(id), false, `第 2 页不该出现第 1 页的资源 ${id}`)
    }
    assert.notEqual(await browser.attr('[data-testid="resource-page-next"]', 'disabled'), null, '末页的「下一页」必须禁用')
  })
})

describe('资源详情', () => {
  test('点卡片标题 → 地址是 /resources/<id>，页面上有标题与完整目录链路', async () => {
    await openDirectory(BROWSE_URL)
    const firstId = (await browser.allAttrs('[data-testid="resource-card"]', 'data-resource-id'))[0]
    await browser.click(`[data-resource-id="${firstId}"] [data-testid="resource-card-title"]`)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-detail-page"]\')',
      20000,
      '详情页出现',
    )
    assert.equal(await browser.url(), `/resources/${firstId}`, '详情地址用资源 id')
    // 面包屑是完整链路（目录树翻译出来的中文）
    await browser.waitForText('[data-testid="breadcrumb-current"]', '教学资源', 15000)
    assert.equal(await browser.text('[data-testid="resource-detail-directory"]'), '教育教学 / Pre-K / 美德 / 教学资源')
  })

  /**
   * ⚠️ 这条用例在阶段 6 被**改写过**，但不是"放松了"：
   *
   * 阶段 5 时详情页只有一个说明文字（「文件将在 Stage 6 接入」），当时的断言是
   * "页面上不许出现下载/预览按钮"。阶段 6 把文件功能做出来了，
   * 于是这句话和那个断言都过期了 —— 现在要断言的是：
   *   · 没有文件时仍然是「暂无文件」；
   *   · **没有**任何假的下载/预览按钮（这一条实质没有变，只是从"整页不许有"
   *     变成"没有文件时不许有"）；
   *   · 上传入口（「+ 添加文件」）只在服务端说可以编辑时出现。
   */
  test('没有文件时显示「暂无文件」，且不出现下载 / 预览按钮', async () => {
    // `file-empty` 是空态容器（标题 + 说明），所以用 includes 而不是全等比较。
    await browser.waitFor(
      `(document.querySelector('[data-testid="file-empty"]')?.innerText || '').includes('暂无文件')`,
      15000,
      '显示「暂无文件」',
    )
    const labels = await fakeActionButtons()
    assert.deepEqual(labels, [], `没有文件时不该有这些按钮：${labels.join('、')}`)
    assert.equal(await browser.exists('[data-testid="file-download"]'), false)
    assert.equal(await browser.exists('[data-testid="file-preview"]'), false)
  })

  test('刷新详情页仍然在（真实 reload，不是前端假状态）', async () => {
    const url = await browser.url()
    await browser.reload()
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-detail-page"]\')',
      20000,
      '刷新后详情页仍在',
    )
    assert.equal(await browser.url(), url)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-detail-title"]\')',
      15000,
      '刷新后标题渲染出来',
    )
  })

  test('不存在的资源 id → 页面给出"找不到"，不是白屏', async () => {
    await browser.goto(`${TEST_BASE}/resources/11111111-1111-4111-8111-111111111111`)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="resource-detail-notfound"]\')',
      20000,
      '显示找不到的提示',
    )
  })
})

describe('我的资源', () => {
  test('列出**自己**的全部资源（含草稿），不含别人的草稿', async () => {
    await browser.goto(`${TEST_BASE}/my-resources`)
    await browser.waitFor(
      '!!document.querySelector(\'[data-testid="my-resources-list"]\')',
      20000,
      '我的资源列表出现',
    )
    // ⚠️ 「我的资源」也是**服务端分页**的（每页 12 条），所以不能断言"第一页有 17 条"。
    // 第一版就是这么断言的（17 vs 12 直接红），错的是测试。
    // 总数要看页码文案，草稿要靠分栏去取。
    const info = await browser.text('[data-testid="my-resources-page-info"]')
    assert.equal(info, '第 1 页 / 共 2 页 · 本页 12 条', `总数应是本人上传的 17 条，实际文案「${info}」`)
    const titles = await browser.allTexts('[data-testid="my-resource-card"] [data-testid="resource-card-title"]')
    assert.equal(titles.length, PAGE_SIZE)
    assert.equal(titles.some((t) => /别人的草稿/.test(t ?? '')), false, '别人的草稿不该出现')
  })

  test('卡片上也带位置（"我的资源"里同样要能一眼看到去哪了）', async () => {
    const locations = await browser.allTexts('[data-testid="my-resource-card"] [data-testid="resource-card-location"]')
    assert.equal(locations.length > 0, true)
    assert.equal((locations[0] ?? '').trim(), '教育教学 / Pre-K / 美德 / 教学资源')
  })

  test('点「草稿」分栏 → 只剩草稿，且栏位高亮跟着变', async () => {
    await browser.click('[data-testid="my-resources-tab"][data-tab-key="DRAFT"]')
    await browser.waitFor(
      'document.querySelector(\'[data-testid="my-resources-tab"][data-tab-key="DRAFT"]\').getAttribute("data-tab-active") === "true"',
      15000,
      '草稿分栏高亮',
    )
    await browser.waitFor(
      'document.querySelectorAll(\'[data-testid="my-resources-list"] [data-resource-id]\').length === 1',
      15000,
      '草稿分栏只剩 1 条',
    )
    const titles = await browser.allTexts('[data-testid="my-resource-card"] [data-testid="resource-card-title"]')
    assert.equal(/我的草稿/.test(titles[0] ?? ''), true)
    const statuses = await browser.allAttrs('[data-testid="my-resource-card"]', 'data-resource-status')
    assert.deepEqual(statuses, ['DRAFT'])
  })

  test('点「已发布」分栏 → 16 条（15 条本目录 + 1 条周次教案）', async () => {
    await browser.click('[data-testid="my-resources-tab"][data-tab-key="PUBLISHED"]')
    await browser.waitFor(
      `document.querySelectorAll('[data-testid="my-resources-list"] [data-resource-id]').length === ${PAGE_SIZE}`,
      15000,
      '已发布分栏第一页 12 条',
    )
    const info = await browser.text('[data-testid="my-resources-page-info"]')
    assert.equal(info, '第 1 页 / 共 2 页 · 本页 12 条')
  })

  test('「我的资源」里也没有下载 / 预览 / 上传按钮', async () => {
    const labels = await fakeActionButtons()
    assert.deepEqual(labels, [], `不该出现这些按钮：${labels.join('、')}`)
  })
})

describe('另一个目录的位置显示（位置标签真的来自目录树）', () => {
  test('周次教案目录下的资源，位置标签是它自己的链路', async () => {
    await openDirectory(LESSON_URL)
    await browser.waitForText('[data-testid="resource-page-info"]', '第 1 页 / 共 1 页 · 本页 1 条', 15000)
    const location = await browser.text('[data-testid="resource-card-location"]')
    // 这个目录在种子里叫「教学详案」（slug 是 lesson）——
    // 期望值写的是**数据库里的中文名**，不是 slug，也不是我凭印象写的名字。
    assert.equal(
      location,
      '教育教学 / Pre-K / 美德 / 教学详案',
      '位置标签必须跟着目录走，不是一个写死的字符串',
    )
  })
})
