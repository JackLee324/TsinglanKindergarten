/**
 * tests/integration/resource-permission.integration.test.mjs —— 资源的目录权限边界
 * ============================================================================
 * 这一份只问一个问题：**"我能不能看到这条资源"是不是只由 `user_permissions`
 * 的目录范围决定**。所有用例都围绕"四种授权形状"展开：
 *
 *   A 父目录授权   `resource.view` 挂在 `education/pre-k/virtue`（导航层）
 *                 → 覆盖整棵子树
 *   B 叶子授权     `resource.view` 只挂在 `.../virtue/resources`
 *                 → **只**覆盖那一个叶子，兄弟叶子看不到
 *   C 没有该权限   `resource.create` 挂在 virtue，但没有 `resource.view`
 *                 → 接口层就应当 403，而不是"返回空列表"
 *   D 全平台授权   `resource.view` 的 directory_id 为 NULL
 *                 → 所有目录都能看，但**未发布内容仍然只有本人可见**
 *
 * 三种失败模式是这里的重点，它们都会"看起来正常"：
 *   · 无权限时返回**空列表**而不是 403 —— 老师以为目录是空的，其实是没有权限；
 *   · 叶子授权被当成"父目录也给了" —— 越权；
 *   · 全平台 `resource.view` 被当成"管理员" —— 于是别人的草稿到处可见。
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
  withSql,
} from '../helpers/harness.mjs'
import { makeResource, purgeResources } from '../helpers/resource-fixture.mjs'

let admin
let a
let b
let c
let d
let e
let ids = {}
const probes = []
/** 各账号的 id，用来区分"自己的"和"别人的"资源。 */
const who = {}
const NOT_A_UUID = '11111111-1111-4111-8111-111111111111'

/** 搜索词含中文与空格：显式编码，不依赖 URL 解析器的宽容。 */
const q = (value) => `q=${encodeURIComponent(value)}`

/** 以某个账号请求列表，并断言状态码。 */
async function listAs(user, query, expectedStatus = 200) {
  const res = await user.get(`/api/resources?${query}`)
  assert.equal(
    res.status,
    expectedStatus,
    `期望 ${expectedStatus}，实际 ${res.status}：${JSON.stringify(res.data)}`,
  )
  return res.data
}

/** 结果里出现过哪些探针 id。 */
function seen(data) {
  return new Set(data.items.map((i) => i.id))
}

before(async () => {
  await resetDatabase()
  await createAdmin('rp_admin', 'RpAdminPass!1')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtueLesson = await directoryIdByPath('education/pre-k/virtue/lesson')
  ids.kPeResources = await directoryIdByPath('education/k/pe/resources')

  await startServer()

  const aUser = await createTeacher('rp_a', 'RpAPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.update.own', directoryId: ids.virtue },
  ], 'A 父目录权限')
  const bUser = await createTeacher('rp_b', 'RpBPass!1', [
    { permission: 'resource.view', directoryId: ids.virtueResources },
  ], 'B 叶子权限')
  const cUser = await createTeacher('rp_c', 'RpCPass!1', [
    { permission: 'resource.create', directoryId: ids.virtue },
  ], 'C 没有查看权限')
  const dUser = await createTeacher('rp_d', 'RpDPass!1', [
    { permission: 'resource.view', directoryId: null },
  ], 'D 全平台权限')
  // 审核岗：有 review + publish，但**不是管理员**。
  // 这一位是用来钉住"审核台对非管理员必须是可用的"。
  const eUser = await createTeacher('rp_e', 'RpEPass!1', [
    { permission: 'resource.view', directoryId: ids.virtue },
    { permission: 'resource.review', directoryId: ids.virtue },
    { permission: 'resource.publish', directoryId: ids.virtue },
  ], 'E 审核岗')

  admin = client()
  await admin.login('rp_admin', 'RpAdminPass!1')
  a = client()
  await a.login('rp_a', 'RpAPass!1')
  b = client()
  await b.login('rp_b', 'RpBPass!1')
  c = client()
  await c.login('rp_c', 'RpCPass!1')
  d = client()
  await d.login('rp_d', 'RpDPass!1')
  e = client()
  await e.login('rp_e', 'RpEPass!1')

  Object.assign(who, { a: aUser.id, b: bUser.id, c: cUser.id, d: dUser.id, e: eUser.id })

  // 四条已发布 —— 用来分辨"看得见"与"看不见"。
  probes.push(await makeResource({
    directoryId: ids.virtueResources, uploaderId: who.a,
    title: '探针·美德教学资源·已发布', status: 'PUBLISHED',
  }))
  probes.push(await makeResource({
    directoryId: ids.virtueLesson, uploaderId: who.a,
    title: '探针·美德周次教案·已发布', status: 'PUBLISHED',
  }))
  probes.push(await makeResource({
    directoryId: ids.kPeResources, uploaderId: who.a,
    title: '探针·K 体能资源·已发布', status: 'PUBLISHED',
  }))
  // 两条草稿 —— 用来分辨"已发布"与"自己的未发布"。
  probes.push(await makeResource({
    directoryId: ids.virtueResources, uploaderId: who.a,
    title: '探针·A 的草稿', status: 'DRAFT',
  }))
  probes.push(await makeResource({
    directoryId: ids.virtueResources, uploaderId: who.b,
    title: '探针·B 的草稿', status: 'DRAFT',
  }))
  // 「别人提交的待审资源」与「别人被退回的资源」：审核台要看的就是它们。
  probes.push(await makeResource({
    directoryId: ids.virtueResources, uploaderId: who.b,
    title: '探针·B 提交的待审资源', status: 'PENDING_REVIEW',
  }))
  probes.push(await makeResource({
    directoryId: ids.virtueResources, uploaderId: who.b,
    title: '探针·B 被退回的资源', status: 'REJECTED',
  }))
})
after(async () => {
  const removed = await purgeResources(probes)
  assert.equal(removed, probes.length, '探针必须全部清掉（残留核对）')
  await stopServer()
})

describe('A：父目录授权覆盖整棵子树', () => {
  test('看得到子树里两个不同叶子的已发布资源', async () => {
    const data = await listAs(a, `${q('探针')}&pageSize=100`)
    const got = seen(data)
    assert.equal(got.has(probes[0]), true, 'virtue/resources 的已发布资源应当可见')
    assert.equal(got.has(probes[1]), true, 'virtue/lesson 的已发布资源应当可见（同一子树）')
  })

  test('看不到权限之外的 K 体能资源', async () => {
    const data = await listAs(a, `${q('探针')}&pageSize=100`)
    assert.equal(seen(data).has(probes[2]), false, 'K 体能不在授权子树里，不能出现')
  })

  test('看不到别人的草稿，但看得到自己的', async () => {
    const data = await listAs(a, `${q('探针·A 的草稿')}&pageSize=100`)
    assert.equal(seen(data).has(probes[3]), true, '自己的草稿应当可见')
    const other = await listAs(a, `${q('探针·B 的草稿')}&pageSize=100`)
    assert.equal(seen(other).has(probes[4]), false, '别人的草稿不能出现')
    assert.equal(other.total, 0)
  })

  test('includeSubtree=true 也不能越出授权范围', async () => {
    const data = await listAs(a, `directoryId=${ids.virtue}&includeSubtree=true&pageSize=100`)
    assert.equal(seen(data).has(probes[2]), false, '递归展开只在授权子树内递归')
    assert.equal(seen(data).has(probes[0]), true)
  })
})

describe('B：叶子授权只覆盖那一个叶子', () => {
  test('看得到叶子自己的已发布资源', async () => {
    const data = await listAs(b, q('探针·美德教学资源·已发布'))
    assert.equal(seen(data).has(probes[0]), true)
  })

  test('看不到**兄弟叶子**里的资源（授权是子树，不是兄弟）', async () => {
    // 这是最容易写错的越权：把"有权限的目录"当成"它的父目录也给了权限",
    // 于是同一个父目录下的其它资料夹全部可见。
    const data = await listAs(b, q('探针·美德周次教案·已发布'))
    assert.equal(seen(data).has(probes[1]), false, '兄弟叶子不在授权子树里')
    assert.equal(data.total, 0)
  })

  test('不指名目录时，列表里只有授权叶子里的东西', async () => {
    const data = await listAs(b, `${q('探针')}&pageSize=100`)
    const got = seen(data)
    assert.equal(got.has(probes[0]), true, '叶子里自己的已发布资源')
    assert.equal(got.has(probes[4]), true, '叶子里**自己**的草稿')
    assert.equal(got.has(probes[1]), false, '兄弟叶子')
    assert.equal(got.has(probes[2]), false, '授权之外')
    assert.equal(got.has(probes[3]), false, '同一叶子里**别人**的草稿')
  })

  test('指名父目录 → 403（不是空列表）', async () => {
    // 返回空列表会让人以为"这个目录没有资源"，而事实是"你没有权限"。
    await listAs(b, `directoryId=${ids.virtue}`, 403)
  })
})

describe('C：没有 resource.view', () => {
  test('列表直接 403，而不是空列表', async () => {
    await listAs(c, 'pageSize=10', 403)
  })

  test('指名自己**有 create 权限**的目录，仍然是 403', async () => {
    // `resource.create` 不等于 `resource.view`：能不能上传和能不能看是两件事。
    await listAs(c, `directoryId=${ids.virtue}`, 403)
  })

  test('我的资源 / 详情 也一并被拒', async () => {
    const mine = await c.get('/api/resources/mine')
    assert.equal(mine.status, 403, 'mine 也要 403')
    const one = await c.get(`/api/resources/${probes[0]}`)
    assert.equal(one.status, 403, '详情也要 403')
  })
})

describe('D：全平台授权不等于管理员', () => {
  test('所有目录的已发布资源都能看到', async () => {
    const data = await listAs(d, `${q('探针')}&pageSize=100`)
    const got = seen(data)
    for (const [index, label] of [
      [0, 'virtue/resources'],
      [1, 'virtue/lesson'],
      [2, 'K 体能'],
    ]) {
      assert.equal(got.has(probes[index]), true, `${label} 的已发布资源应当可见`)
    }
  })

  test('但看不到别人的草稿（这是教师，不是管理员）', async () => {
    const data = await listAs(d, `${q('探针')}&pageSize=100`)
    assert.equal(seen(data).has(probes[3]), false, 'A 的草稿不能因为"全平台 view"就可见')
    assert.equal(seen(data).has(probes[4]), false, 'B 的草稿同理')
  })
})

describe('管理员', () => {
  test('看得到全部，包括别人的草稿', async () => {
    const data = await listAs(admin, `${q('探针')}&pageSize=100`)
    const got = seen(data)
    for (const id of probes) assert.equal(got.has(id), true, `管理员应当看得到 ${id}`)
  })
})

describe('指名目录 / 资源的失败路径', () => {
  test('指名无权目录 → 403，并留下 authz.denied 审计', async () => {
    // ⚠️ 前后必须是**同一个**统计口径。第一版前半段数的是"全部 authz.denied"、
    // 后半段数的才是"针对这个目录的"，于是 `after > before` 恒不成立 ——
    // 断言红了，但被测代码其实是对的。
    const denialsOn = async () => {
      return withSql(async (sql) => {
        const rows = await sql`
          SELECT count(*)::int AS n FROM audit_logs
          WHERE action = 'authz.denied' AND target_id = ${ids.kPeResources}
        `
        return rows[0].n
      })
    }

    const before = await denialsOn()
    await listAs(a, `directoryId=${ids.kPeResources}`, 403)
    const after = await denialsOn()
    assert.equal(after, before + 1, '被拒必须留痕 —— 否则"谁被拒了"无从查起')
  })

  test('指名不存在的目录 → 403（不能 500）', async () => {
    const res = await a.get(`/api/resources?directoryId=${NOT_A_UUID}`)
    assert.equal(res.status, 403, `不存在的目录应当被拒，实际 ${res.status}`)
  })

  test('不存在的资源 id → 404，而不是 403 / 500', async () => {
    // 把"东西没了"说成"你没有权限"会让人去查权限配置，方向完全错。
    const res = await a.get(`/api/resources/${NOT_A_UUID}`)
    assert.equal(res.status, 404, `不存在的资源应当 404，实际 ${res.status}`)
  })

  test('看得见但**无权**的资源详情 → 403（A 取 K 体能的那条）', async () => {
    const res = await a.get(`/api/resources/${probes[2]}`)
    assert.equal(res.status, 403)
  })

  test('未登录 → 401', async () => {
    const anon = client()
    const res = await anon.get('/api/resources?pageSize=5')
    assert.equal(res.status, 401)
  })
})

describe('详情里的能力位（canEdit）由服务端算', () => {
  test('自己的资源 → canEdit=true；别人上传的 → canEdit=false', async () => {
    const mine = await a.get(`/api/resources/${probes[3]}`)
    assert.equal(mine.status, 200)
    assert.equal(mine.data.capabilities.canEdit, true, 'A 有 update.own 且是自己上传的')

    // B 上传的草稿 A 看不到 → 403；换成 B 自己看：有 view 但没有 update.own → false。
    const bOwn = await b.get(`/api/resources/${probes[4]}`)
    assert.equal(bOwn.status, 200)
    assert.equal(bOwn.data.capabilities.canEdit, false, 'B 没有 update.own 授权')
  })

  test('A 看别人上传的已发布资源 → canEdit=false（所有权在能力位里也生效）', async () => {
    // 需要一条 A 看不见上传者但看得见的资源：让 B 上传、A 有 view 权限。
    const uploaded = await makeResource({
      directoryId: ids.virtueResources, uploaderId: who.b,
      title: '探针·B 上传的已发布资源', status: 'PUBLISHED',
    })
    probes.push(uploaded)
    const res = await a.get(`/api/resources/${uploaded}`)
    assert.equal(res.status, 200, '已发布资源 A 看得到')
    assert.equal(res.data.capabilities.canEdit, false, '不是自己上传的就不能编辑')
  })
})

/**
 * 审核岗的可见性 —— 这一组是**全量跑测试时暴露出来的真实回归**。
 *
 * 阶段 5 给列表加上可见性过滤之后，`GET /api/reviews/pending` 对非管理员的
 * 审核员返回了**空列表**（接口还是 200）。原因是当时把可见性写成了
 * `isAdmin(user)` 一个布尔量，而审核岗大多不是管理员 ——
 * 于是"审核台什么都看不到"，但没有任何断言会红。
 *
 * 正确的规则是：审核 / 发布岗能看到别人上传的**已提交**内容，
 * 但**永远看不到别人的草稿**。下面三条分别钉住这三件事。
 */
describe('审核岗（非管理员）的可见性', () => {
  test('审核台能看到别人提交的待审资源', async () => {
    const res = await e.get('/api/reviews/pending')
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(
      res.data.items.some((i) => i.id === probes[5]),
      true,
      '待审列表里必须有别人提交的那条 —— 否则审核台是空的',
    )
    assert.equal(res.data.items.every((i) => i.status === 'PENDING_REVIEW'), true)
  })

  test('「已退回」列表里能看到别人被退回的资源（审核台要能回看）', async () => {
    const res = await e.get('/api/reviews/rejected')
    assert.equal(res.status, 200)
    assert.equal(res.data.items.some((i) => i.id === probes[6]), true)
  })

  test('**但看不到别人的草稿** —— 草稿对非本人一律不可见，审核岗也不例外', async () => {
    // 草稿是"还没交出去的东西"。审核岗能看到它，就等于老师没有私人工作区。
    const data = await listAs(e, `${q('探针')}&pageSize=100`)
    const got = seen(data)
    assert.equal(got.has(probes[3]), false, 'A 的草稿不能因为"我是审核岗"就可见')
    assert.equal(got.has(probes[4]), false, 'B 的草稿同理')
    // 已提交的那两条要能看到（否则就退化成"审核岗什么都看不到"）
    assert.equal(got.has(probes[5]), true)
    assert.equal(got.has(probes[6]), true)
  })

  test('普通教师看不到别人提交的待审 / 被退回资源', async () => {
    const data = await listAs(a, `${q('探针')}&pageSize=100`)
    const got = seen(data)
    assert.equal(got.has(probes[5]), false, '没有 review/publish 授权 → 看不到别人的待审资源')
    assert.equal(got.has(probes[6]), false, '也看不到别人被退回的资源')
  })
})
