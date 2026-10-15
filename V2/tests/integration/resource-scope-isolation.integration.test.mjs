/**
 * tests/integration/resource-scope-isolation.integration.test.mjs
 *   —— 列表范围隔离：**搜索 / 目录筛选 / 状态筛选 / 分页都不能绕过权限条件**
 * ============================================================================
 * 这份文件存在的理由是一个**线上真实发生过的越权**（2026-10-15 发现并修复）：
 *
 *   `queryResources()` 的 WHERE 里，"回收站分支"曾经是一个**裸的 OR 析取项**：
 *
 *     WHERE (recycled = true AND deleted_at IS NOT NULL)
 *        OR (recycled = false AND deleted_at IS NULL)
 *       AND (...目录范围...) AND (...上传者...) AND (...可见性...)
 *
 *   SQL 里 `AND` 比 `OR` 结合得紧，于是它等价于「回收站那一支**绕过后面所有
 *   过滤条件**」—— 任何有 `resource.view` 的老师，在自己「我的资源 → 回收站」
 *   里就能看到全平台所有被删的资源（标题、目录路径、上传者姓名）。
 *
 * 为什么它藏了那么久，以及这份文件要防的到底是什么：
 *   · 列表这一层有**四种**条件同时参与 —— 目录范围（scope/directoryId）、
 *     上传者（onlyUploaderId）、状态可见性（othersStatuses/ownerId）、分页/搜索。
 *     任何一处写成"或"而不是"与"，都表现为**结果范围悄悄变大**，
 *     而不是报错。它不会让任何一条已有用例变红。
 *   · 所以这里不只测"老师看不到别人的"，而是**逐个条件交叉**地测：
 *     分页翻到底、搜索命中别人的东西、按状态筛、按目录筛、只 mine、
 *     组合起来用 —— 每一条都要求"结果集合仍然只包含我有权看到的"。
 *
 * ── 一条纪律 ─────────────────────────────────────────────────────────────
 * 断言不写成"总数是 5"这种脆弱的形状，而是写成**契约**：
 * ・返回的每一行都必须满足 `uploaderId === 我 || status === 'PUBLISHED'`（普通教师的可见性策略）；
 * ・**别人的未发布资源**在整个结果集里一个都不许出现（跨所有分页）。
 * 这样将来种子数据变了，测试仍然在测同一件事。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
} from '../helpers/harness.mjs'
import { makeResource, purgeResources } from '../helpers/resource-fixture.mjs'

/** 普通教师的可见性策略（`AuthorizationService.resourceVisibility`）：自己的全部 + 别人的已发布。 */
const TEACHER_CAN_SEE_OTHERS = ['PUBLISHED']

let admin
let teacherA
let teacherB
const ids = {}
const probes = []
/** 这一组造出来的、用来验证隔离的 id 集合。 */
const fx = { aOwn: [], bOwn: [], aDeleted: [], bDeleted: [] }

/** 把整个结果集（跨所有分页）走一遍。 */
async function walkAllPages(api, path, { pageSize = 2, maxPages = 30 } = {}) {
  const seen = []
  let total = null
  let pages = 0
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await api.get(`${path}${sep}page=${page}&pageSize=${pageSize}`)
    assert.equal(res.status, 200, `${path} 第 ${page} 页应当 200：${JSON.stringify(res.data)}`)
    if (total === null) total = res.data.total
    else assert.equal(res.data.total, total, 'total 不该随页码变化（那是另一个缺陷）')
    pages = page
    if (res.data.items.length === 0) break
    seen.push(...res.data.items)
    if (seen.length >= res.data.total) break
  }
  return { items: seen, total, pages }
}

/**
 * 断言"这批结果里没有我看不到的东西"。
 *
 * @param who 视角用户 id（用来判断哪些是"自己的"）
 */
function assertNoInvisible(items, who, label) {
  const foreignUnpublished = items.filter(
    (i) => i.uploaderId !== who && !TEACHER_CAN_SEE_OTHERS.includes(i.status),
  )
  assert.deepEqual(
    foreignUnpublished.map((i) => `${i.title}(${i.status})`),
    [],
    `${label}：出现了别人的未发布资源 —— 范围条件被绕过了`,
  )
  // 更强的形状断言：每一行都必须符合可见性契约
  for (const i of items) {
    assert.ok(
      i.uploaderId === who || TEACHER_CAN_SEE_OTHERS.includes(i.status),
      `${label}：${i.title}（${i.status}）不符合普通教师的可见性契约`,
    )
  }
}

before(async () => {
  await resetDatabase()
  const adminUser = await createAdmin('iso_admin', 'IsoAdminPass!1')
  ids.adminId = adminUser.id

  // A、B 都只有 education 这一支的 resource.view —— growth 这一支他们看不到
  ids.edu = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.lesson = await directoryIdByPath('education/pre-k/virtue/lesson')
  ids.outside = await directoryIdByPath('growth/l1')

  await startServer()
  admin = client()
  await admin.login('iso_admin', 'IsoAdminPass!1')

  const a = await createTeacher('iso_a', 'IsoAPass!12345', [
    { permission: 'resource.view', directoryId: await directoryIdByPath('education') },
  ], 'A 老师')
  const b = await createTeacher('iso_b', 'IsoBPass!12345', [
    { permission: 'resource.view', directoryId: await directoryIdByPath('education') },
  ], 'B 老师')
  ids.aId = a.id
  ids.bId = b.id

  teacherA = client(); await teacherA.login('iso_a', 'IsoAPass!12345')
  teacherB = client(); await teacherB.login('iso_b', 'IsoBPass!12345')

  const make = async (directoryId, uploaderId, title, status) => {
    const id = await makeResource({ directoryId, uploaderId, title, status })
    probes.push(id)
    return id
  }

  // ── A 的：5 条草稿（edu）+ 2 条草稿（lesson） ──
  for (let i = 1; i <= 5; i += 1) {
    fx.aOwn.push(await make(ids.edu, ids.aId, `隔离·草稿 A${i}`, 'DRAFT'))
  }
  for (let i = 1; i <= 2; i += 1) {
    fx.aOwn.push(await make(ids.lesson, ids.aId, `隔离·详案 A${i}`, 'DRAFT'))
  }

  // ── B 的：**同一个搜索词能命中**的 5 条草稿 + 1 条已发布（A 应当看得到后者） ──
  for (let i = 1; i <= 5; i += 1) {
    fx.bOwn.push(await make(ids.edu, ids.bId, `隔离·草稿 B${i}`, 'DRAFT'))
  }
  fx.bOwn.push(await make(ids.edu, ids.bId, '隔离·已发布 B', 'PUBLISHED'))

  // ── B 的：在 A **完全看不到**的目录里（草稿 + 已发布各一条）──
  fx.bOutside = [
    await make(ids.outside, ids.bId, '隔离·外部草稿 B', 'DRAFT'),
    await make(ids.outside, ids.bId, '隔离·外部已发布 B', 'PUBLISHED'),
  ]

  // ── 回收站：A 5 条、B 5 条、B 在外部目录 1 条 ──
  for (let i = 1; i <= 5; i += 1) {
    fx.aDeleted.push(await make(ids.edu, ids.aId, `隔离·回收 A${i}`, 'DRAFT'))
  }
  for (let i = 1; i <= 5; i += 1) {
    fx.bDeleted.push(await make(ids.edu, ids.bId, `隔离·回收 B${i}`, 'DRAFT'))
  }
  fx.bDeletedOutside = await make(ids.outside, ids.bId, '隔离·回收外部 B', 'DRAFT')

  // A、B 都没有 resource.delete.own，所以由管理员执行软删除
  for (const id of [...fx.aDeleted, ...fx.bDeleted, fx.bDeletedOutside]) {
    const res = await admin.del(`/api/resources/${id}`)
    assert.equal(res.status, 200, JSON.stringify(res.data))
  }

  // 前提自检：这一组的关键 id 都拿到了
  assert.equal(fx.aOwn.length, 7, 'A：edu 5 条 + lesson 2 条')
  assert.equal(fx.bOwn.length, 6, 'B：edu 5 条草稿 + 1 条已发布')
  assert.equal(fx.bOutside.length, 2, 'B：无权目录里 2 条（草稿 + 已发布）')
  assert.equal(fx.aDeleted.length, 5)
  assert.equal(fx.bDeleted.length, 5, 'B 在 edu 里删掉的 5 条')
  assert.equal(typeof fx.bDeletedOutside, 'string', 'B 在无权目录里删掉的那 1 条')
})

after(async () => {
  const removed = await purgeResources(probes)
  assert.equal(removed, probes.length, '探针必须全部清掉（残留核对）')
  await stopServer()
})

// ────────────────────────────────────────────────────────────────────────────

describe('① 回收站：普通老师只看得到自己的（越权回归）', () => {
  test("A 的「我的资源 → 回收站」= 自己删的 5 条", async () => {
    const res = await teacherA.get('/api/resources/mine/recycle-bin?pageSize=50')
    assert.equal(res.status, 200)
    assert.equal(res.data.total, fx.aDeleted.length)
    assert.deepEqual(res.data.items.map((i) => i.id).sort(), [...fx.aDeleted].sort())
  })

  test('A 看不到 B 删掉的（含 B 在 A 无权目录里的那条）', async () => {
    const res = await teacherA.get('/api/resources/mine/recycle-bin?pageSize=50')
    const seen = new Set(res.data.items.map((i) => i.id))
    for (const id of [...fx.bDeleted, fx.bDeletedOutside]) {
      assert.equal(seen.has(id), false, `A 不该看到 ${id}`)
    }
  })

  test('全站回收站（/recycle-bin）对老师同样只给自己的', async () => {
    const a = await teacherA.get('/api/resources/recycle-bin?pageSize=50')
    const seen = new Set(a.data.items.map((i) => i.id))
    assert.equal(a.data.total, fx.aDeleted.length)
    assert.equal(seen.has(fx.bDeleted[0]), false)
    assert.equal(seen.has(fx.bDeletedOutside), false)
  })

  test('B 的回收站同样只看得到自己的', async () => {
    const res = await teacherB.get('/api/resources/mine/recycle-bin?pageSize=50')
    const seen = new Set(res.data.items.map((i) => i.id))
    assert.equal(res.data.total, fx.bDeleted.length + 1, 'B 自己删的 5 条 + 外部目录 1 条')
    assert.equal(seen.has(fx.aDeleted[0]), false)
  })

  test('超级管理员仍然看得到全平台（这条能力不能被修坏）', async () => {
    const res = await admin.get('/api/resources/recycle-bin?pageSize=50')
    assert.equal(res.data.total, fx.aDeleted.length + fx.bDeleted.length + 1)
    const seen = new Set(res.data.items.map((i) => i.id))
    for (const id of [...fx.aDeleted, ...fx.bDeleted, fx.bDeletedOutside]) {
      assert.equal(seen.has(id), true, `管理员应当看到 ${id}`)
    }
  })

  test('未登录：401（回收站不是公开接口）', async () => {
    const anon = client()
    for (const path of ['/api/resources/recycle-bin', '/api/resources/mine/recycle-bin']) {
      assert.equal((await anon.get(path)).status, 401, `${path} 应当 401`)
    }
  })
})

describe('② 回收站：**分页**不能绕过范围条件', () => {
  test('A 的回收站翻完每一页，都只有自己的（pageSize=2 → 3 页）', async () => {
    const { items, total, pages } = await walkAllPages(teacherA, '/api/resources/mine/recycle-bin', {
      pageSize: 2,
    })
    assert.equal(total, fx.aDeleted.length)
    assert.ok(pages >= 3, `5 条按每页 2 条应当至少 3 页，实际 ${pages}`)
    assert.equal(items.length, fx.aDeleted.length, '跨页合计应当正好是自己的条数（不重不漏）')
    assert.deepEqual(items.map((i) => i.id).sort(), [...fx.aDeleted].sort())
  })

  test('全站回收站分页也一样（pageSize=1，逐页确认）', async () => {
    const { items, total } = await walkAllPages(teacherA, '/api/resources/recycle-bin', { pageSize: 1 })
    assert.equal(total, fx.aDeleted.length)
    assert.equal(items.length, fx.aDeleted.length)
    const foreign = items.filter((i) => i.uploaderId !== ids.aId)
    assert.deepEqual(foreign.map((i) => i.title), [], '任何一页都不该出现别人的东西')
  })

  test('B 的回收站分页也只看得到自己的（6 条 → 3 页）', async () => {
    const { items, total } = await walkAllPages(teacherB, '/api/resources/mine/recycle-bin', { pageSize: 2 })
    assert.equal(total, fx.bDeleted.length + 1)
    assert.equal(items.filter((i) => i.uploaderId !== ids.bId).length, 0)
  })

  test('管理员的分页能看到全部人（pageSize=4 → 3 页，跨页合计 11 条）', async () => {
    const { items, total } = await walkAllPages(admin, '/api/resources/recycle-bin', { pageSize: 4 })
    assert.equal(total, fx.aDeleted.length + fx.bDeleted.length + 1)
    assert.equal(items.length, total, '跨页合计应当等于总数')
    const seen = new Set(items.map((i) => i.id))
    for (const id of [...fx.aDeleted, ...fx.bDeleted, fx.bDeletedOutside]) {
      assert.equal(seen.has(id), true)
    }
  })

  test('翻到最后一页之后：空列表，而且 total 不变（不能靠翻页试探出别人的东西）', async () => {
    const res = await teacherA.get('/api/resources/mine/recycle-bin?page=99&pageSize=2')
    assert.equal(res.status, 200)
    assert.deepEqual(res.data.items, [])
    assert.equal(res.data.total, fx.aDeleted.length)
  })

  test('回收站接口不接受目录/搜索参数来放大范围（传了也是忽略）', async () => {
    // 这两个接口只读 page/pageSize。传别的参数进去必须被忽略，
    // 而不是"顺手当条件用" —— 一旦哪天接了 directoryId，这里就要立刻红。
    const withExtras = await teacherA.get(
      `/api/resources/mine/recycle-bin?pageSize=50&directoryId=${ids.outside}&q=%E9%9A%94%E7%A6%BB&status=DRAFT&onlyMine=false`,
    )
    assert.equal(withExtras.status, 200, JSON.stringify(withExtras.data))
    const plain = await teacherA.get('/api/resources/mine/recycle-bin?pageSize=50')
    assert.equal(withExtras.data.total, plain.data.total)
    assert.deepEqual(
      withExtras.data.items.map((i) => i.id).sort(),
      plain.data.items.map((i) => i.id).sort(),
    )
  })
})

describe('③ 普通列表：**搜索**不能绕过可见性', () => {
  test('同一个搜索词，老师只拿到自己的（B 的 5 条同名前缀草稿一条都不出现）', async () => {
    const { items, total } = await walkAllPages(teacherA, '/api/resources?q=隔离·草稿')
    assert.equal(total, 5, '只应当是 A 在同一个前缀下的那 5 条草稿')
    assertNoInvisible(items, ids.aId, '搜索「隔离·草稿」')
    const seen = new Set(items.map((i) => i.id))
    for (const id of fx.bOwn) assert.equal(seen.has(id), false, 'B 的东西不该被搜出来')
  })

  test('管理员用同一个词能看到两边（证明是"按权限过滤"，不是"搜不到"）', async () => {
    const res = await admin.get('/api/resources?q=隔离·草稿&pageSize=50')
    assert.equal(res.data.total, 10, 'A 的 5 条 + B 的 5 条')
  })

  test('老师的搜索仍然能搜到**已发布**的别人的资源（不是被一刀切掉）', async () => {
    const res = await teacherA.get('/api/resources?q=隔离·已发布&pageSize=50')
    assert.equal(res.data.total, 1)
    assert.equal(res.data.items[0].uploaderId, ids.bId)
    assert.equal(res.data.items[0].status, 'PUBLISHED')
  })

  test('无权目录里的东西，无论发布与否都搜不到；指名那个目录则 403', async () => {
    const search = await teacherA.get('/api/resources?q=隔离·外部&pageSize=50')
    assert.equal(search.data.total, 0, 'growth 那一支的东西不该被搜出来（含已发布的）')

    const explicit = await teacherA.get(`/api/resources?directoryId=${ids.outside}&q=隔离`)
    assert.equal(explicit.status, 403, '指名无权目录必须 403，而不是空列表')
  })

  test('搜索**搜不到已删除的**资源（活跃列表只含未删除的）', async () => {
    const res = await teacherA.get('/api/resources?q=隔离·回收&pageSize=50')
    assert.equal(res.data.total, 0, '回收站里的东西不该出现在活跃列表里')
  })

  test('搜索 + 状态筛选叠加，仍然只给自己的草稿', async () => {
    const { items, total } = await walkAllPages(
      teacherA,
      '/api/resources?q=隔离&status=DRAFT',
      { pageSize: 2 },
    )
    assert.equal(total, fx.aOwn.length, 'A 自己的 7 条草稿')
    assertNoInvisible(items, ids.aId, '搜索 + status=DRAFT')
  })

  test('状态筛选 PUBLISHED 只给已发布的（别人的已发布也在这里）', async () => {
    const res = await teacherA.get('/api/resources?q=隔离&status=PUBLISHED&pageSize=50')
    assert.equal(res.data.total, 1)
    assert.equal(res.data.items.every((i) => i.status === 'PUBLISHED'), true)
  })

  test('onlyMine=true 不能被当成"看这个目录里我可见的全部"', async () => {
    // 这一条防的是一类真实缺陷：DTO 里有参数、控制器忘了往下传，
    // 于是结果范围**悄悄变大**（目录页会列出别人的待审核内容）。
    const res = await teacherA.get('/api/resources?onlyMine=true&q=隔离&pageSize=50')
    assert.equal(res.data.total, fx.aOwn.length)
    assert.equal(res.data.items.every((i) => i.uploaderId === ids.aId), true)
  })
})

describe('④ 普通列表：**目录筛选**不能绕过范围', () => {
  test('指名 A 无权的目录 → 403（不是空列表、也不是全量）', async () => {
    const res = await teacherA.get(`/api/resources?directoryId=${ids.outside}&pageSize=50`)
    assert.equal(res.status, 403, JSON.stringify(res.data))
  })

  test('includeSubtree=true 也不能越出授权范围', async () => {
    const res = await teacherA.get(`/api/resources?directoryId=${ids.edu}&includeSubtree=true&pageSize=50`)
    assert.equal(res.status, 200)
    assertNoInvisible(res.data.items, ids.aId, 'includeSubtree=true')
    assert.equal(res.data.items.some((i) => i.uploaderId === ids.bId && i.status !== 'PUBLISHED'), false)
  })

  test('按目录筛 + 分页：跨页合计仍然只有该目录里我可见的', async () => {
    const { items, total } = await walkAllPages(
      teacherA,
      `/api/resources?directoryId=${ids.lesson}`,
      { pageSize: 1 },
    )
    assert.equal(total, 2, 'lesson 里只有 A 自己的 2 条草稿')
    assert.equal(items.length, 2)
    assertNoInvisible(items, ids.aId, '目录筛选：教学详案')
  })

  test('A 无权的目录里的已发布资源，也不会从别的入口漏进来', async () => {
    const all = await teacherA.get('/api/resources?pageSize=100')
    assert.equal(all.status, 200)
    const leaked = all.data.items.filter((i) => fx.bOutside.includes(i.id))
    assert.deepEqual(leaked.map((i) => i.title), [], '同一条已发布资源在无权目录里也不该出现')
  })
})

describe('⑤ 普通列表：**分页**不能绕过权限条件', () => {
  test('pageSize=1 逐页走完，每一页都符合可见性契约', async () => {
    const { items, total, pages } = await walkAllPages(teacherA, '/api/resources', { pageSize: 1 })
    assert.equal(items.length, total, `跨页合计应当等于 total（${total}）`)
    assert.ok(pages >= total, '每页 1 条时页数应当不少于条数')
    assertNoInvisible(items, ids.aId, '逐页遍历')
  })

  test('超过最后一页：空列表、total 不变', async () => {
    const res = await teacherA.get('/api/resources?page=99&pageSize=5')
    assert.equal(res.status, 200)
    assert.deepEqual(res.data.items, [])
    const first = await teacherA.get('/api/resources?page=1&pageSize=5')
    assert.equal(res.data.total, first.data.total)
  })

  test('管理员看到的总数 ≥ 老师看到的总数（范围确实更宽）', async () => {
    const a = await teacherA.get('/api/resources?pageSize=100')
    const adm = await admin.get('/api/resources?pageSize=100')
    assert.equal(adm.data.total > a.data.total, true, `管理员 ${adm.data.total} 应当多于老师 ${a.data.total}`)
    assert.equal(adm.data.total, fx.aOwn.length + fx.bOwn.length + fx.bOutside.length)
  })
})
