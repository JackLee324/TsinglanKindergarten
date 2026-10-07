/**
 * 审核：待审列表、通过、退回、以及"审核动作不混用"。
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
import { textBytes, uploadFile } from '../helpers/upload.mjs'

let admin
let author
let reviewer
let ids = {}
/** 本套件造的资源（after 里统一清掉，保证 0 残留）。 */
const probeResources = []

before(async () => {
  await resetDatabase()
  await createAdmin('rv_admin', 'ReviewAdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.kPe = await directoryIdByPath('education/k/pe')
  ids.kResources = await directoryIdByPath('education/k/pe/resources')
  ids.kResources = await directoryIdByPath('education/k/pe/resources')

  await startServer()
  admin = client()
  await admin.login('rv_admin', 'ReviewAdminPass!1')

  await createTeacher(
    'rv_author',
    'AuthorPass!1234',
    [
      { permission: 'resource.view', directoryId: ids.virtue },
      { permission: 'resource.create', directoryId: ids.virtue },
      { permission: 'resource.update.own', directoryId: ids.virtue },
      { permission: 'resource.download', directoryId: ids.virtue },
      { permission: 'resource.submit', directoryId: ids.virtue },
    ],
    '作者老师',
  )
  author = client()
  await author.login('rv_author', 'AuthorPass!1234')

  // 审核员：有审核权限，但**没有**上传权限 —— 证明两种权限是分开的
  await createTeacher(
    'rv_reviewer',
    'ReviewerPass!12',
    [
      { permission: 'resource.view', directoryId: ids.virtue },
      { permission: 'resource.review', directoryId: ids.virtue },
      { permission: 'resource.publish', directoryId: ids.virtue },
      { permission: 'resource.download', directoryId: ids.virtue },
    ],
    '审核老师',
  )
  reviewer = client()
  await reviewer.login('rv_reviewer', 'ReviewerPass!12')
})
after(async () => {
  // 清理探针：本套件的用例会造几十条资源，一条都不许留下（业主 §31：0 residue）。
  if (probeResources.length > 0) {
    const removed = await withSql(async (sql) => {
      const rows = await sql`
        DELETE FROM resources WHERE id = ANY(${probeResources}::uuid[]) RETURNING id::text
      `
      return rows.length
    })
    assert.equal(removed, probeResources.length, '探针资源必须全部清掉（残留核对）')
  }
  await stopServer()
})

/**
 * 造一条"已提交审核"的资源。
 *
 * 上传走 `helpers/upload.mjs`（真实的 申请地址 → PUT → 登记），
 * 不再手写元数据 —— 阶段 6 起登记只认票据。
 */
async function submitOne(title) {
  const created = await author.post('/api/resources', {
    directoryId: ids.resources,
    title,
  })
  const id = created.data.id
  await uploadFile(author, id, { bytes: textBytes(title), fileName: 'a.txt', mimeType: 'text/plain' })
  const submitted = await author.post(`/api/resources/${id}/submit`)
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data))
  return id
}

describe('待审列表', () => {
  /**
   * ⚠️ 这条用例是全量跑测试时救回来的一次真实回归。
   *
   * 阶段 5 给资源列表加可见性过滤后，非管理员的审核员拿到的是**空列表**
   * （接口仍然 200）—— 因为当时的可见性被写成 `isAdmin(user)` 一个布尔量。
   * 审核岗大多不是管理员，于是"审核台什么都看不到"，而没有任何断言会红。
   *
   * 修法在策略里（`AuthorizationService.resourceVisibility`），不在控制器里加开关 ——
   * 控制器里开一个"这次不看可见性"的旁路又是一条绕开统一授权的判定路径。
   */
  test('审核台能看到待审资源', async () => {
    const id = await submitOne('待审一号')
    const res = await reviewer.get('/api/reviews/pending')
    assert.equal(res.status, 200)
    assert.ok(res.data.items.some((i) => i.id === id))
    assert.ok(res.data.items.every((i) => i.status === 'PENDING_REVIEW'))
  })

  test('只有 resource.view 的教师看不到审核台（403）', async () => {
    await createTeacher('rv_plain', 'PlainPass!1234', [
      { permission: 'resource.view', directoryId: ids.virtue },
    ])
    const c = client()
    await c.login('rv_plain', 'PlainPass!1234')
    const res = await c.get('/api/reviews/pending')
    assert.equal(res.status, 403)
  })

  test('审核员没有上传权限（两种权限确实分开了）', async () => {
    const res = await reviewer.post('/api/resources', {
      directoryId: ids.resources,
      title: '审核员想自己传',
    })
    assert.equal(res.status, 403)
  })
})

describe('通过 / 退回', () => {
  test('通过 → PUBLISHED，写入 review.approve 流水', async () => {
    const id = await submitOne('通过一号')
    const res = await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(res.data.status, 'PUBLISHED')
    assert.ok(res.data.publishedAt, 'published_at 必须写上去')

    const history = await reviewer.get(`/api/resources/${id}/review-history`)
    assert.deepEqual(
      history.data.items.map((i) => i.action),
      ['submit', 'review.approve'],
    )
  })

  test('退回 → REJECTED，流水里是 review.reject 且带原因', async () => {
    const id = await submitOne('退回首号')
    const res = await reviewer.post(`/api/resources/${id}/review`, {
      action: 'reject',
      comment: '缺少教学目标',
    })
    assert.equal(res.status, 201)
    assert.equal(res.data.status, 'REJECTED')

    const history = await reviewer.get(`/api/resources/${id}/review-history`)
    const last = history.data.items.at(-1)
    assert.equal(last.action, 'review.reject')
    assert.equal(last.comment, '缺少教学目标')
  })

  test('没有 review/publish 权限的人不能裁决', async () => {
    const id = await submitOne('无权限裁决')
    const res = await author.post(`/api/resources/${id}/review`, { action: 'approve' })
    assert.equal(res.status, 403, '作者自己不能批准自己的东西')
  })

  test('范围外的资源：审核员既看不到也裁决不了（K 的体能）', async () => {
    const kPeResources = await directoryIdByPath('education/k/pe/resources')
    const created = await admin.post('/api/resources', {
      directoryId: kPeResources,
      title: 'K 的资源',
    })
    assert.equal(created.status, 201, JSON.stringify(created.data))

    // 审核员的范围只有 Pre-K/美德 → 越界的裁决必须在守卫层就被拒
    const res = await reviewer.post(`/api/resources/${created.data.id}/review`, {
      action: 'approve',
    })
    assert.equal(res.status, 403, `实际 ${res.status} ${JSON.stringify(res.data)}`)

    // 而且它根本不该出现在审核台的待审列表里
    await admin.post(`/api/resources/${created.data.id}/submit`)
    const pending = await reviewer.get('/api/reviews/pending')
    assert.ok(
      !pending.data.items.some((i) => i.id === created.data.id),
      '范围外的待审资源不该出现在审核台',
    )
  })
})

describe('撤回不写 reject', () => {
  test('撤回后数据库里没有 review.reject 记录', async () => {
    const id = await submitOne('撤回检查')
    await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    const recall = await author.post(`/api/resources/${id}/recall`)
    assert.equal(recall.status, 201, JSON.stringify(recall.data))

    const rows = await withSql(
      (sql) => sql`
        SELECT action FROM resource_reviews WHERE resource_id = ${id} ORDER BY created_at
      `,
    )
    const actions = rows.map((r) => r.action)
    assert.deepEqual(actions, ['submit', 'review.approve', 'review.recall'])
    assert.ok(!actions.includes('review.reject'))
  })

  test('审核员不能撤回别人的资源（撤回属于作者）', async () => {
    const id = await submitOne('别人撤回')
    await reviewer.post(`/api/resources/${id}/review`, { action: 'approve' })
    const res = await reviewer.post(`/api/resources/${id}/recall`)
    assert.equal(res.status, 403, '撤回要求所有权')
  })
})


// ===========================================================================
// 审核队列：搜索 / 目录过滤 / 排序 / 服务端分页（业主 §3）
// ===========================================================================
describe('审核队列', () => {
  const PREFIX = `队列探针${Date.now().toString().slice(-6)}`

  /** 造 n 条待审资源（都带文件，否则提交会被拒）。 */
  async function makePending(count, titlePrefix = PREFIX) {
    const ids_ = []
    for (let i = 1; i <= count; i += 1) {
      const created = await author.post('/api/resources', {
        directoryId: ids.resources,
        title: `${titlePrefix} ${String(i).padStart(2, '0')}`,
      })
      assert.equal(created.status, 201, JSON.stringify(created.data))
      probeResources.push(created.data.id)
      await uploadFile(author, created.data.id, {
        bytes: textBytes(`${titlePrefix}-${i}`),
        fileName: `f${i}.txt`,
        mimeType: 'text/plain',
      })
      const submitted = await author.post(`/api/resources/${created.data.id}/submit`)
      assert.equal(submitted.status, 201, JSON.stringify(submitted.data))
      ids_.push(created.data.id)
    }
    return ids_
  }

  test('默认按最近更新排序，且服务端分页（不再一次全给）', async () => {
    const made = await makePending(3)
    assert.equal(made.length, 3)

    const res = await reviewer.get(`/api/reviews/pending?q=${encodeURIComponent(PREFIX)}&pageSize=2`)
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.items.length, 2)
    assert.equal(res.data.total, 3)
    assert.equal(res.data.totalPages, 2)
    assert.equal(res.data.pageSize, 2)

    const second = await reviewer.get(
      `/api/reviews/pending?q=${encodeURIComponent(PREFIX)}&pageSize=2&page=2`,
    )
    assert.equal(second.data.items.length, 1)
  })

  test('搜索覆盖标题', async () => {
    const res = await reviewer.get(`/api/reviews/pending?q=${encodeURIComponent(PREFIX)} 02`)
    assert.equal(res.data.total, 1)
    assert.match(res.data.items[0].title, /02$/)
  })

  test('排序白名单生效：最早更新在前的顺序与默认相反，非法值退回默认', async () => {
    const desc = await reviewer.get(`/api/reviews/pending?q=${encodeURIComponent(PREFIX)}&pageSize=100`)
    const asc = await reviewer.get(
      `/api/reviews/pending?q=${encodeURIComponent(PREFIX)}&pageSize=100&sort=updated_asc`,
    )
    const descIds = desc.data.items.map((i) => i.id)
    const ascIds = asc.data.items.map((i) => i.id)
    assert.deepEqual(ascIds, [...descIds].reverse(), '升序应当是降序的反向')

    // 不认识的排序值：**退回默认**，不报错也不拼进 SQL。
    const bogus = await reviewer.get(
      `/api/reviews/pending?q=${encodeURIComponent(PREFIX)}&pageSize=100&sort=bogus`,
    )
    assert.equal(bogus.status, 200, JSON.stringify(bogus.data))
    assert.deepEqual(bogus.data.items.map((i) => i.id), descIds, '非法排序应当退回默认顺序')

    // 明显畸形的值（超长 / 带 SQL 片段）在 DTO 层就被挡下 —— 两个方向都要有。
    const injection = await reviewer.get(
      `/api/reviews/pending?q=${encodeURIComponent(PREFIX)}&sort=${encodeURIComponent('title;DROP TABLE resources')}`,
    )
    assert.equal(injection.status, 400, `畸形排序值应当 400，实际 ${injection.status}`)
  })

  test('目录过滤：指定目录时只返回那个目录子树里的资源', async () => {
    // 选「美德」：探针资源挂在 **美德/教学资源**（它的子目录）里。
    // 能数到 3 条就证明过滤是**递归**的 —— 这正是审核台要的语义
    // （选了「Pre-K 这一块」就该看到整块，而不是只有恰好挂在那一个节点上的东西）。
    const inVirtue = await reviewer.get(
      `/api/reviews/pending?directoryId=${ids.virtue}&q=${encodeURIComponent(PREFIX)}&pageSize=100`,
    )
    assert.equal(inVirtue.data.total, 3, '目录过滤必须包含子树')

    // 指名一个**自己没权限**的目录 → 403（不是"空列表"）。
    //
    // 403 与"0 条"是两件事：前者是"你没有这个目录的权限"，
    // 后者是"这个目录里没有待审的东西"。返回空列表会让审核员以为后者，
    // 于是永远不会去查权限配置（阶段 5 定下的规则，这里在审核队列上同样成立）。
    const inK = await reviewer.get(
      `/api/reviews/pending?directoryId=${ids.kPe}&q=${encodeURIComponent(PREFIX)}&pageSize=100`,
    )
    assert.equal(inK.status, 403, JSON.stringify(inK.data))

    // 向上越界也不行：`education/pre-k` 是审核员授权节点的**上级**。
    // 授权是向下的（子树），不是向上的，所以这里同样是 403。
    const inPreK = await reviewer.get(
      `/api/reviews/pending?directoryId=${await directoryIdByPath('education/pre-k')}&q=${encodeURIComponent(PREFIX)}&pageSize=100`,
    )
    assert.equal(inPreK.status, 403, '授权只向下覆盖：上级目录不能因为"包含我的节点"就被放行')
  })

  test('三个分栏各自只返回对应状态', async () => {
    for (const [path, status] of [
      ['pending', 'PENDING_REVIEW'],
      ['published', 'PUBLISHED'],
      ['rejected', 'REJECTED'],
    ]) {
      const res = await reviewer.get(`/api/reviews/${path}?pageSize=100`)
      assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.data)}`)
      for (const item of res.data.items) {
        assert.equal(item.status, status, `${path} 里出现了 ${item.status}`)
      }
    }
  })

  test('队列按目录授权过滤：范围外的资源不出现', async () => {
    // reviewer 的审核范围只有 virtue；K 体能的资源由管理员创建并提交。
    const kCreated = await admin.post('/api/resources', {
      directoryId: ids.kResources,
      title: `${PREFIX} K 体能`,
    })
    assert.equal(kCreated.status, 201)
    probeResources.push(kCreated.data.id)
    await uploadFile(admin, kCreated.data.id, {
      bytes: textBytes('k'),
      fileName: 'k.txt',
      mimeType: 'text/plain',
    })
    await admin.post(`/api/resources/${kCreated.data.id}/submit`)

    const queue = await reviewer.get(`/api/reviews/pending?q=${encodeURIComponent(PREFIX)}&pageSize=100`)
    assert.equal(
      queue.data.items.some((i) => i.id === kCreated.data.id),
      false,
      '范围外的待审资源不该出现在审核台',
    )
  })
})
