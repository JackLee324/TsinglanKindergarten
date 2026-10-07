/**
 * tests/integration/resource-pagination.integration.test.mjs —— 服务端分页
 * ============================================================================
 * 这里测的不是"翻页按钮能不能点"，而是四条**容易被悄悄违反**的性质：
 *
 * 1. `total` 是**过滤后的真实总数**，不是当前页长度。
 *    实现成 `items.length` 时，界面第一页显示"共 20 条"——
 *    数据量小的时候看不出来，等资源超过一页就永远少报。
 * 2. 越界页要返回**空列表但正确的 total / totalPages**。
 *    顺手把 total 也清成 0 的话，界面会显示"共 0 页"，
 *    用户以为资源没了，其实只是页码大了。
 * 3. 翻页**不重不漏**：把每一页拼起来必须正好等于全集。
 *    这条在 ORDER BY 有并列值时会被破坏（见下面"相同的 updated_at"那一条）。
 * 4. 非法分页参数**直接 400**，不悄悄替换成默认值。
 *    悄悄替换的后果是：用户传错参数，拿到的是"看起来正常"的第一页，
 *    排查方向会完全错。
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
import { makeResource, makeResources, purgeResources } from '../helpers/resource-fixture.mjs'
import { resourceQuery } from '../helpers/modules.mjs'

const { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } = resourceQuery

/** 本次套件造的资源标题前缀：保证搜索只在探针范围内生效。 */
const PREFIX = `分页探针${Date.now().toString().slice(-6)}`
/**
 * 并列探针用**独立前缀**。
 *
 * 它只服务于"排序 tiebreaker"那一条。如果沿用 `PREFIX`，后面的
 * 「筛选叠加」断言就会随 describe 的执行顺序漂移（先跑并列块 → total 变大），
 * 那种测试在今天过、明天因为顺序调整而红，是最难查的一类。
 */
const TIED_PREFIX = `并列探针${Date.now().toString().slice(-6)}`
const TIED_PREFIX_ROWS = 9
const TIED_PAGE_SIZE = 3
const TOTAL = 23

let admin
let teacher
let t
let ids = {}
const probes = []

/** 只取本套件的探针（用前缀隔离，不受库里其它数据影响）。 */
async function page(query) {
  const res = await teacher.get(`/api/resources?directoryId=${ids.virtueResources}&q=${PREFIX}&${query}`)
  assert.equal(res.status, 200, `分页请求应成功，实际 ${res.status} ${JSON.stringify(res.data)}`)
  return res.data
}

before(async () => {
  await resetDatabase()
  await createAdmin('pg_admin', 'PgAdminPass!1')
  ids.virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
  const virtue = await directoryIdByPath('education/pre-k/virtue')

  await startServer()
  admin = client()
  await admin.login('pg_admin', 'PgAdminPass!1')
  t = await createTeacher('pg_teacher', 'PgTeacherPass!1', [
    { permission: 'resource.view', directoryId: virtue },
  ], '分页老师')
  teacher = client()
  await teacher.login('pg_teacher', 'PgTeacherPass!1')

  probes.push(
    ...(await makeResources({
      directoryId: ids.virtueResources,
      uploaderId: t.id,
      count: TOTAL,
      prefix: PREFIX,
    })),
  )
})
after(async () => {
  const removed = await purgeResources(probes)
  assert.equal(removed, probes.length, '探针必须全部清掉（残留核对）')
  await stopServer()
})

describe('页大小', () => {
  test(`不传 pageSize → 默认 ${DEFAULT_PAGE_SIZE} 条，但 total 是全集 ${TOTAL}`, async () => {
    const data = await page('')
    assert.equal(data.items.length, DEFAULT_PAGE_SIZE, '第一页应是默认页大小')
    assert.equal(data.total, TOTAL, 'total 必须是真实总数，不是本页长度')
    assert.equal(data.totalPages, Math.ceil(TOTAL / DEFAULT_PAGE_SIZE))
  })

  test('pageSize=5 → 本页 5 条，total 仍然是全集', async () => {
    const data = await page('pageSize=5')
    assert.equal(data.items.length, 5)
    assert.equal(data.total, TOTAL)
    assert.equal(data.totalPages, 5)
  })

  test(`pageSize 的上限是 ${MAX_PAGE_SIZE}，取满不报错`, async () => {
    const data = await page(`pageSize=${MAX_PAGE_SIZE}`)
    assert.equal(data.items.length, TOTAL, `只有 ${TOTAL} 条，取满也只会返回 ${TOTAL} 条`)
    assert.equal(data.totalPages, 1)
  })
})

describe('非法分页参数（直接 400，不悄悄改成默认值）', () => {
  // 悄悄改成默认值会让"传错参数"表现为"正常的第一页"，
  // 于是调用方永远发现不了自己传错了。
  for (const query of [
    'page=0',
    'page=-1',
    'page=1.5',
    'page=abc',
    'pageSize=0',
    'pageSize=-3',
    `pageSize=${MAX_PAGE_SIZE + 1}`,
    'pageSize=abc',
  ]) {
    test(`${query} → 400`, async () => {
      const res = await teacher.get(
        `/api/resources?directoryId=${ids.virtueResources}&q=${PREFIX}&${query}`,
      )
      assert.equal(res.status, 400, `${query} 应被拒绝，实际 ${res.status}`)
    })
  }
})

describe('越界页', () => {
  test('页码超出末页 → items 为空，但 total / totalPages 仍然是真实的', async () => {
    const data = await page('pageSize=10&page=99')
    assert.deepEqual(data.items, [], '越界页没有数据')
    assert.equal(data.total, TOTAL, '越界页不能把 total 清成 0 —— 那会显示"共 0 页"')
    assert.equal(data.totalPages, 3)
    assert.equal(data.page, 99, '回显请求的页码，不偷偷改回第 1 页')
  })
})

describe('不重不漏', () => {
  test('逐页取完 → 并集正好等于全集，且没有重复', async () => {
    const seen = []
    for (let p = 1; p <= 3; p += 1) {
      const data = await page(`pageSize=10&page=${p}`)
      seen.push(...data.items.map((i) => i.id))
    }
    assert.equal(seen.length, TOTAL, `三页拼起来应是 ${TOTAL} 条`)
    assert.equal(new Set(seen).size, TOTAL, '不能有重复行（重复意味着另一行被漏掉）')
    assert.deepEqual(
      [...new Set(seen)].sort(),
      [...probes].sort(),
      '翻页取到的必须正好是全部探针',
    )
  })

  test('同一个请求连续两次返回**完全相同**的顺序（分页必须可重复）', async () => {
    const a = await page('pageSize=10&page=2')
    const b = await page('pageSize=10&page=2')
    assert.deepEqual(
      a.items.map((i) => i.id),
      b.items.map((i) => i.id),
      '同样的请求两次顺序不同 → 用户会看到同一页内容"跳来跳去"',
    )
  })

  /**
   * `updated_at` 并列时的顺序必须是**明确**的，不能交给 Postgres 的自由裁量。
   *
   * ⚠️ 这条测试的诚实说明：我原本写的是"去掉 tiebreaker 它就会红"，
   * 实测**并不会** —— 同样的数据 + 同样的语句，Postgres 每次返回的顺序是
   * 一致的（排序算法是确定性的），所以"翻页重复/漏行"在这个规模下复现不出来。
   * 并列顺序真正会变的场合是：换了执行计划、加了索引、并行扫描、
   * 或者两次翻页之间有人动了数据 —— 那都不是能在单测里稳定制造的。
   *
   * 所以这里改成**钉住"顺序是定义好的"这件事本身**：并列时必须按
   * `id` 降序返回。这条断言在去掉 tiebreaker 之后确实会红（已验证：
   * 无 tiebreaker 时返回的是插入顺序，不是 id 降序），
   * 于是"顺序被某次重构悄悄改掉"就瞒不过去了。
   */
  test('updated_at 完全相同的行：顺序必须是明确的（id 降序），且翻页不重不漏', async () => {
    // 用 SQL 把一批行的 updated_at 改成同一个值：真实的批量导入
    // （一条事务里插多行）就是这个形状 —— 事务里 now() 是常量。
    const tied = await makeResources({
      directoryId: ids.virtueResources,
      uploaderId: null,
      count: TIED_PREFIX_ROWS,
      prefix: TIED_PREFIX,
    })
    probes.push(...tied)
    await withSql(async (sql) => {
      await sql`UPDATE resources SET updated_at = timestamptz '2026-01-01 00:00:00+08'
                WHERE id = ANY(${tied}::uuid[])`
    })

    const got = []
    for (let p = 1; p <= 3; p += 1) {
      const res = await teacher.get(
        `/api/resources?directoryId=${ids.virtueResources}&q=${TIED_PREFIX}&pageSize=3&page=${p}`,
      )
      assert.equal(res.status, 200)
      // 9 条 ÷ 每页 3 条 = 正好 3 页，每页都必须是满的 ——
      // "每页都是满的"同时钉住了"没有行被跳过"。
      assert.equal(
        res.data.items.length,
        TIED_PAGE_SIZE,
        `第 ${p} 页应有 ${TIED_PAGE_SIZE} 条（updated_at 全部并列）`,
      )
      assert.equal(res.data.total, TIED_PREFIX_ROWS)
      got.push(...res.data.items.map((i) => i.id))
    }
    assert.equal(new Set(got).size, TIED_PREFIX_ROWS, '并列行翻页不能重复')
    assert.deepEqual([...new Set(got)].sort(), [...tied].sort(), '并列行翻页不能漏')
    // 并列值的顺序是**定义好的**：id 降序。
    // （canonical uuid 文本是定宽十六进制，字符串序 == 数值序，
    //   所以这里可以直接用 JS 的字符串排序来推期望值。）
    assert.deepEqual(
      got,
      [...tied].sort().reverse(),
      'updated_at 并列时必须按 id 降序 —— 顺序不能由 Postgres 自由决定',
    )
  })
})

describe('分页与筛选叠加', () => {
  test('状态筛选 + 分页：total 是叠加之后的总数', async () => {
    // 这 23 条都是 PUBLISHED（夹具默认），再加一条 DRAFT 后：
    //   status=DRAFT → total 1；status=PUBLISHED → total 23。
    const draft = await makeResource({
      directoryId: ids.virtueResources,
      uploaderId: t.id,
      title: `${PREFIX}-草稿`,
      status: 'DRAFT',
    })
    probes.push(draft)

    const drafted = await page('status=DRAFT&pageSize=5')
    assert.equal(drafted.total, 1, 'status=DRAFT 的 total 必须只数草稿')
    assert.equal(drafted.items.length, 1)
    assert.equal(drafted.items[0].id, draft)

    const published = await page('status=PUBLISHED&pageSize=5')
    assert.equal(published.total, TOTAL, 'status=PUBLISHED 的 total 必须不含草稿')
    assert.equal(published.items.length, 5)

    const all = await page('pageSize=5')
    assert.equal(all.total, TOTAL + 1, '不筛状态时 total 是全部')
  })
})
