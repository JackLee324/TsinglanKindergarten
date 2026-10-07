/**
 * 审核：待审列表、通过、退回、以及"审核动作不混用"。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

let admin
let author
let reviewer
let ids = {}

before(async () => {
  await resetDatabase()
  await createAdmin('rv_admin', 'ReviewAdminPass!1')
  ids.resources = await directoryIdByPath('education/pre-k/virtue/resources')
  ids.virtue = await directoryIdByPath('education/pre-k/virtue')
  ids.kPe = await directoryIdByPath('education/k/pe')

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
  await stopServer()
})

async function submitOne(title) {
  const created = await author.post('/api/resources', {
    directoryId: ids.resources,
    title,
  })
  const id = created.data.id
  const bytes = Buffer.from(`内容 ${title}`, 'utf8')
  const req = await author.post(`/api/resources/${id}/files/upload-url`, {
    fileName: 'a.txt',
    mimeType: 'text/plain',
    size: bytes.byteLength,
  })
  await fetch(`${TEST_BASE}${req.data.uploadUrl}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: bytes,
  })
  await author.post(`/api/resources/${id}/files/register`, {
    storageKey: req.data.storageKey,
    fileName: 'a.txt',
    mimeType: 'text/plain',
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })
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
