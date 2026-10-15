/**
 * tests/unit/resource-query-scope.test.mjs
 *   —— 列表范围条件的**结构**守卫：搜索 / 目录 / 上传者 / 可见性必须与回收站判定 AND 在一起
 * ============================================================================
 * 这一份只防一件事，但那件事线上真的发生过（2026-10-15）：
 *
 *   `queryResources()` 的 WHERE 里，"回收站分支"曾经是一个**裸的 OR 析取项**：
 *
 *     WHERE (recycled = true AND deleted_at IS NOT NULL)
 *        OR (recycled = false AND deleted_at IS NULL)
 *       AND (...目录范围...) AND (...上传者...) AND (...可见性...) AND (...搜索...)
 *
 *   SQL 里 `AND` 比 `OR` 结合得紧 → 它等价于「回收站那一支**绕过后面所有过滤
 *   条件**」→ 任何有 `resource.view` 的老师，在自己回收站里看到全平台被删的资源。
 *
 * 为什么必须在**结构**上再守一道（接口测试已经有一份了，见
 * `tests/integration/resource-scope-isolation.integration.test.mjs`）：
 *   · 接口测试跑一遍要起服务 + 数据库 + 造几十条夹具（几十秒）；
 *     这一份是毫秒级，能在**每次保存**时就拦住；
 *   · 接口测试只能覆盖"我知道要去查的那几条路"。
 *     这个缺陷的形态是"某个条件被排挤到 AND 链之外"，
 *     它可能以别的样子回来（换个字段、换个参数名），
 *     所以这里对**形状**断言，而不是对某一个具体用例断言。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bodyOf, readSource } from '../helpers/source.mjs'

const SERVICE = readSource('server/resources/resources.service.ts')
const QUERY = bodyOf(SERVICE, 'async queryResources(')
const COUNT = bodyOf(SERVICE, 'private async countMatching(')

/**
 * 两处 SQL 都必须满足的形状。
 *
 * `label` 只用于失败信息 —— 这条断言失败时，人要知道"该去哪儿改、为什么"。
 */
function assertScopeShape(sql, label) {
  /*
    ① 回收站判定必须是**一个**布尔比较，不许是两个析取项。
       这是缺陷的原始形状：一旦有人把 `X = $recycled` 展开成
       `(recycled = true AND X) OR (recycled = false AND NOT X)`，
       它就会把后面的 AND 链切掉一半。
  */
  assert.equal(
    /opt\.recycled\}\s*=\s*true\s+AND[\s\S]{0,60}?deleted_at IS NOT NULL[\s\S]{0,60}?\n\s*OR\b/.test(sql),
    false,
    `${label}：回收站判定又变回"两个析取项"了 —— SQL 的 AND 比 OR 紧，` +
      '那样会让回收站这一支绕过后面所有过滤条件（2026-10-15 的线上越权就是这么来的）。' +
      '请保留 `(r.deleted_at IS NOT NULL) = $recycled` 这种单布尔比较的形状。',
  )
  assert.match(
    sql,
    /\(r\.deleted_at IS NOT NULL\)\s*=\s*\$\{opt\.recycled\}/,
    `${label}：找不到"单布尔比较"的回收站判定。` +
      '如果你是有意重构成别的等价写法，请确认它**不可能**把后面的 AND 链切开，然后更新这条断言。',
  )

  // ② 上传者范围（回收站隔离靠它）
  assert.match(
    sql,
    /opt\.onlyUploaderId\}::uuid IS NULL OR r\.uploader_id = \$\{opt\.onlyUploaderId\}::uuid/,
    `${label}：缺少上传者范围条件（老师只看得到自己的，靠的就是它）`,
  )

  // ③ 状态可见性（别人的哪些状态我能看）
  assert.match(
    sql,
    /r\.uploader_id = \$\{[\w.]*ownerId\}::uuid\s+OR r\.status = ANY\(\$\{[\w.]*othersStatuses\}::text\[\]\)/,
    `${label}：缺少"自己的全部 + 别人的按状态"这条可见性条件`,
  )

  // ④ 目录范围
  assert.match(
    sql,
    /opt\.scope\}::uuid\[\] IS NULL OR r\.directory_id = ANY\(\$\{opt\.scope\}::uuid\[\]\)/,
    `${label}：缺少目录范围条件（scope）`,
  )

  // ⑤ 搜索条件必须也在 WHERE 里（否则搜索会退化成"看全部"）
  assert.match(sql, /pattern\}::text IS NULL/, `${label}：缺少搜索条件`)
}

describe('① 列表 SQL 的范围条件形状', () => {
  test('queryResources：五个条件一个都不能少，且不能有裸的 OR 析取项', () => {
    assertScopeShape(QUERY, 'queryResources')
  })

  test('countMatching：**同样**要满足（列表对了、总数没对也是一种泄漏）', () => {
    /*
      这一处特别容易漏：分页时"当页 0 行"会走 countMatching 拿总数，
      于是**光看列表是对的，总数却在泄漏**（"这个平台上还有 6 条我看不到的东西"）。
      变异测试里"只改 countMatching"确实只被一条用例抓到，说明它很隐蔽。
    */
    assertScopeShape(COUNT, 'countMatching')
  })

  test('两处 SQL 的范围条件必须逐字一致（不许只在一边加条件）', () => {
    const pick = (sql) => {
      const keep = [
        /\(r\.deleted_at IS NOT NULL\)\s*=\s*\$\{opt\.recycled\}/,
        /opt\.scope\}::uuid\[\] IS NULL OR r\.directory_id/,
        /opt\.directoryIds\}::uuid\[\] IS NULL OR r\.directory_id/,
        /opt\.status\}::text IS NULL OR r\.status/,
        /opt\.onlyUploaderId\}::uuid IS NULL OR r\.uploader_id/,
        /pattern\}::text IS NULL/,
      ]
      return keep.map((re) => re.test(sql))
    }
    assert.deepEqual(
      pick(COUNT),
      pick(QUERY),
      '列表与计数用的范围条件不一致 —— 分页/总数会与列表对不上（而且往往是对不上的那一边更宽）',
    )
  })
})

describe('② 调用方必须把范围参数一路传下去', () => {
  test('list() 把 scope / onlyUploaderId / visibility 都传给了 queryResources', () => {
    const list = bodyOf(SERVICE, 'async list(')
    const call = list.slice(list.indexOf('this.queryResources('))
    for (const needle of ['scope', 'directoryIds', 'onlyUploaderId', 'visibility']) {
      assert.match(
        call,
        new RegExp(`\\b${needle}\\b`),
        `list() 传给 queryResources 的参数里少了 ${needle} —— 少一个，结果范围就会变大`,
      )
    }
  })

  test('recycleBin() 的上传者过滤**来自授权层**，不是写死的', () => {
    const bin = bodyOf(SERVICE, 'async recycleBin(')
    assert.match(
      bin,
      /onlyUploaderId:\s*await this\.authz\.recycleBinUploaderFilter\(user\)/,
      'recycleBin() 必须问 AuthorizationService 要上传者过滤（管理员拿到 null、老师拿到自己的 id）',
    )
    assert.equal(
      /onlyUploaderId:\s*(null|user\.id)\b/.test(bin),
      false,
      '不要在 service 里自己写"是不是管理员" —— 那正是权限判定散开的起点',
    )
    assert.match(bin, /recycled:\s*true/)
  })

  test('mine(scope="recycle") 只看自己的', () => {
    const mine = bodyOf(SERVICE, 'async mine(')
    assert.match(mine, /onlyUploaderId:\s*user\.id/)
    assert.match(mine, /recycled:\s*scope === 'recycle'/)
  })

  test('活跃列表（/api/resources）永远不带 recycled —— 已删除的不该出现在活跃列表里', () => {
    const list = bodyOf(SERVICE, 'async list(')
    assert.match(list, /recycled:\s*filters\.recycled\s*===?\s*true/)
    // 控制器必须显式钉死 false，而不是把 DTO 里没有的字段透传成 undefined
    const controller = readSource('server/resources/resources.controller.ts')
    assert.match(
      controller,
      /recycled:\s*false/,
      '控制器的 list() 必须显式写 recycled: false —— 否则多传一个查询参数就可能翻出回收站里的东西',
    )
  })
})
