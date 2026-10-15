/**
 * tests/unit/admin-bulk-delete-contract.test.mjs
 *   —— 「批量删除是可恢复的、永久删除是高门槛的」的结构性证明
 * ============================================================================
 * 为什么这些断言必须是结构性的、而不是接口级的：
 *
 *   业主的硬要求是「删除必须是**可恢复的软删除**，不是永久删除」。
 *   这类要求有一个共同的失效方式 —— **它不会让任何接口测试变红**：
 *     · 有人为了"清理得干净一点"，在批量删除里顺手加一句 `DELETE FROM resources`；
 *       日常路径（多选 → 删除 → 回收站）照样全绿，
 *       直到某天业主发现东西真的没了。
 *     · 有人把 `MAX_BULK_DELETE` 只改了一边（前后端各有一个字面量），
 *       界面显示"一次最多 100 条"而服务端拒到第 51 条，或者反过来。
 *     · 有人给 `BulkDeleteItemResult` 加一个新的 outcome（比如 `partial`），
 *       界面上的三分支判断会把它**静默渲染成「失败」**，没有任何测试会红。
 *     · 有人觉得 `@RequireSuperAdmin()` 和 service 里的 `assertSuperAdmin()`
 *       重复，删掉其中一层 —— 另一层还在，所以接口测试依然全绿。
 *
 * 所以这里直接对源码做结构性断言，与 `single-permission-truth.test.mjs`
 * 是同一套思路：**"某个东西在代码里根本不存在"只能这样证明。**
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { bodyOf as body, readSource } from '../helpers/source.mjs'

const SERVICE = readSource('server/resources/resources.service.ts')
const DTO = readSource('server/resources/resources.dto.ts')
const CLIENT_API = readSource('client/src/api/resources.ts')
const ADMIN_PAGE = readSource('client/src/pages/AdminResourcesPage.tsx')
const BULK_RESULT = readSource('client/src/components/resource/BulkResultDialog.tsx')
const BULK_STATUS_DIALOG = readSource('client/src/components/resource/BulkStatusDialog.tsx')
const CONTROLLER = readSource('server/resources/resources.controller.ts')

/**
 * 截出某个方法体的花括号区间。
 *
 * ⚠️ 不能用「从签名到下一个 `/**`」那种切法：上面刚把注释剥掉了，
 * 结束标记根本不存在，于是会一路吞到文件末尾 —— 那样 `bulkSoftDelete` 里
 * 就会"出现" `purge()` 的 `DELETE FROM resources`，测试**假红**。
 * 花括号配对不依赖注释，而且配不上会抛（不会静默返回半截内容）。
 */
const NUMBER = (text, name) => {
  const match = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(text)
  assert.notEqual(match, null, `找不到常量 ${name}`)
  return Number(match[1])
}

describe('① 批量删除必须是**软**删除：代码里不存在物理删除这条路', () => {
  const bulk = body(SERVICE, 'async bulkSoftDelete(')
  const one = body(SERVICE, 'private async softDeleteOne(')

  test('bulkSoftDelete / softDeleteOne 里没有 DELETE FROM resources', () => {
    for (const [name, text] of [['bulkSoftDelete', bulk], ['softDeleteOne', one]]) {
      assert.equal(
        /DELETE\s+FROM\s+resources/i.test(text),
        false,
        `${name}() 里出现了物理删除 —— 批量删除必须是可恢复的软删除`,
      )
      // 也不能借着 purge 拐个弯删掉
      assert.equal(
        /this\.purge\(/.test(text),
        false,
        `${name}() 不能调用 purge()：那是不可逆的永久删除`,
      )
    }
  })

  test('软删除只写 deleted_at，并且用条件更新挡住并发', () => {
    assert.match(one, /UPDATE\s+resources\s+SET\s+deleted_at\s*=\s*now\(\)/i)
    assert.match(
      one,
      /WHERE\s+id\s*=\s*\$\{id\}\s+AND\s+deleted_at\s+IS\s+NULL/i,
      '条件更新是并发安全的关键：两个同时到达的请求只能有一个改到行',
    )
  })

  test('不可删除的状态由共享的 DELETABLE_STATUSES 判定，不是散落的 if', () => {
    /*
      2026-10-15 起这条规则的判定收进了一处 `assertDeletable()`（单个与批量共用），
      因为它现在要同时管两件事：
        · DELETABLE_STATUSES 里的状态 → 放行；
        · **已发布** → 普通角色仍然拒绝，但超级管理员可以直接删（先记已撤回）。

      这个形状本身就是缺陷温床，所以这里钉三件事：
        1. 名单仍然只引用共享的那一份（不在服务层另写一遍）；
        2. 单个与批量都**必须**走同一个判定函数（否则两条路会分叉）；
        3. 调用方**必须处理返回值** —— 见下一条用例，它是真出过事的。
    */
    const judge = body(SERVICE, 'private async assertDeletable(')
    assert.match(judge, /DELETABLE_STATUSES/, '状态名单必须引用共享的那一份')
    assert.match(judge, /isSuperAdmin\(actor\)/, '已发布能不能删由超管身份决定')
    assert.match(judge, /recallForForcedDelete\(/, '超管删已发布前必须先记为已撤回')

    assert.match(one, /assertDeletable\(/, '批量路径必须用同一个判定')
    const single = body(SERVICE, 'async softDelete(')
    assert.match(single, /assertDeletable\(/, '单条路径必须用同一个判定')

    for (const [name, text] of [['softDeleteOne', one], ['softDelete', single]]) {
      assert.equal(
        /DELETABLE_STATUSES/.test(text),
        false,
        `${name}() 不得自己引用状态名单 —— 判定只有一处（assertDeletable）`,
      )
      assert.equal(
        /isSuperAdmin\(/.test(text),
        false,
        `${name}() 不得自己判"是不是超管" —— 那正是会分叉的地方`,
      )
    }
    /*
      注意：**允许**调用方出现 `=== 'PUBLISHED'` ——
      `softDelete()` 用它只是给审计加一句"这条是已发布的"（如实标注），
      不是判定。断言要盯判定，盯文案会把好代码也判红。
    */
  })

  /**
   * 这一条来自 2026-10-15 真实发生过的缺陷：
   * `assertDeletable()` 只**返回**原因（不抛异常），而 `softDelete()` 第一版
   * 写成 `await this.assertDeletable(...)` 就直接往下删了 ——
   * 于是"普通教师不能删已发布的"这条规则在单条 DELETE 这条路上完全失效，
   * 老师删自己已发布的资源返回了 200。
   *
   * "名字带 assert、实际只返回原因"是最容易被读漏的形状，
   * 所以这里对**调用点**断言，而不只是对判定函数断言。
   */
  test('调用方必须处理 assertDeletable 的返回值（名字带 assert、实际只返回原因）', () => {
    const single = body(SERVICE, 'async softDelete(')
    assert.match(
      single,
      /const\s+\w+\s*=\s*await this\.assertDeletable\(/,
      'softDelete() 必须把返回值接住',
    )
    assert.match(
      single,
      /if\s*\(\s*\w+\s*!==\s*null\s*\)\s*\{\s*throw/,
      'softDelete() 必须把原因抛成 409 —— 光调用不检查等于没判',
    )

    assert.match(
      one,
      /const\s+\w+\s*=\s*await this\.assertDeletable\(/,
      'softDeleteOne() 必须把返回值接住',
    )
    assert.match(one, /if\s*\(\s*\w+\s*!==\s*null\s*\)/, 'softDeleteOne() 必须把原因翻译成"跳过"')
    assert.equal(
      /await this\.assertDeletable\([^)]*\)\s*$/m.test(single) &&
        !/const\s+\w+\s*=\s*await this\.assertDeletable\(/.test(single),
      false,
      '不允许出现"只调用、不接返回值"的写法',
    )
  })

  test('管理页面上**不存在**永久删除这条路（只留代码注释说明为什么不提供）', () => {
    assert.equal(
      /purge/i.test(ADMIN_PAGE),
      false,
      '资源管理页不得出现任何 purge 调用：界面上永远不提供"彻底删除"',
    )
    assert.equal(
      /resourcesApi\.(purge|hardDelete|destroy)/.test(ADMIN_PAGE),
      false,
    )
  })
})

describe('② 前后端的上限必须是同一个数', () => {
  test('MAX_BULK_DELETE 在服务端 DTO 与客户端 API 里一致', () => {
    const server = NUMBER(DTO, 'MAX_BULK_DELETE')
    const client = NUMBER(CLIENT_API, 'MAX_BULK_DELETE')
    assert.equal(
      client,
      server,
      `客户端说 ${client}、服务端认 ${server} —— 用户会看到"一次最多 ${client} 条"，` +
        '然后被服务端以另一条上限拒绝（或者更糟：界面允许一个服务端一定会拒的数量）',
    )
    assert.ok(server > 0)
  })

  test('服务端用 ArrayMaxSize 拒绝超限，而不是**截断**', () => {
    // 悄悄只删前 N 条是最坏的失败方式：用户以为全删了
    assert.match(DTO, /@ArrayMaxSize\(MAX_BULK_DELETE/)
    assert.equal(
      /slice\(0,\s*MAX_BULK_DELETE\)/.test(DTO + SERVICE),
      false,
      '超限必须报错，不能静默截断',
    )
  })
})

describe('③ 逐条结果的词汇表必须两边一致', () => {
  test("outcome 只能是 'deleted' | 'skipped' | 'failed'，且前后端一字不差", () => {
    const serverMatch = /outcome:\s*('deleted'\s*\|\s*'skipped'\s*\|\s*'failed')/.exec(SERVICE)
    const clientMatch = /outcome:\s*('deleted'\s*\|\s*'skipped'\s*\|\s*'failed')/.exec(CLIENT_API)
    assert.notEqual(serverMatch, null, '服务端 BulkDeleteItemResult.outcome 的联合类型变了？')
    assert.notEqual(clientMatch, null, '客户端 BulkDeleteItemResult.outcome 的联合类型变了？')
    // 规范化空白后再比，两边必须**完全相同**（多一个分支就是界面渲染不到的状态）
    const norm = (s) => s.replace(/\s+/g, '')
    assert.equal(norm(serverMatch[1]), norm(clientMatch[1]))
  })

  test('界面按三个分支渲染，而且没有兜底成「失败」的静默路径', () => {
    /*
      三分支的文案原本直接写在管理页里；2026-10-15 抽成了共用组件
      （批量删除与批量改状态共用同一份逐条结果弹窗），所以这里跟着走：
        · 组件里必须**显式**有三种状态各自的文案与配色；
        · 管理页必须**真的用**那个组件 —— 否则"抽出去了但没人用"就没人渲染。
    */
    for (const label of ['成功', '已跳过', '失败']) {
      assert.ok(
        BULK_RESULT.includes(label),
        `逐条结果组件缺少「${label}」这一支的文案 —— outcome 词汇表变了就要同步`,
      )
    }
    assert.match(
      BULK_RESULT,
      /outcome:\s*'ok'\s*\|\s*'skipped'\s*\|\s*'failed'/,
      '客户端把两种批量结果归一成 ok/skipped/failed 三档',
    )
    assert.match(ADMIN_PAGE, /BulkResultDialog/, '管理页必须用这个组件渲染结果')
    assert.match(ADMIN_PAGE, /toRows\(/, '两种批量结果都要经 toRows 归一 —— 不许各写一套分支')
  })

  test('服务端对"不存在""已在回收站""并发抢先"都返回 skipped（不是 failed）', () => {
    // 语义区别很重要：skipped = "本来就不用删"，failed = "真的出错了"，界面配色不同
    for (const reason of ['NOT_FOUND', 'ALREADY_DELETED', 'CONFLICT']) {
      const re = new RegExp(`outcome:\\s*'skipped',\\s*reason:\\s*'${reason}'`)
      assert.match(SERVICE, re, `${reason} 应当是 skipped，而不是 failed`)
    }
    assert.match(SERVICE, /outcome:\s*'failed'/)
  })
})


describe('③.5 「批量修改状态」的界面必须把代价说清楚', () => {
  test('改成「已发布」有第二次确认，而且明说绕过审核', () => {
    assert.match(BULK_STATUS_DIALOG, /admin-bulk-status-publish-confirm/, '要有"我确认跳过审核"的勾选框')
    assert.match(BULK_STATUS_DIALOG, /publishConfirmed/, '提交按钮必须受它约束')
    assert.match(BULK_STATUS_DIALOG, /绕过审核流程/, '必须直说这一步绕过审核')
    assert.match(BULK_STATUS_DIALOG, /不会<\/strong>产生审核记录|不产生审核记录/, '必须直说不产生审核记录')
    // 切走再切回来不能留着上次的勾
    assert.match(BULK_STATUS_DIALOG, /setPublishConfirmed\(false\)/, '每次打开/换目标状态都要清掉那次确认')
  })

  test('改成「已退回」必须写原因（教师端要能看到）', () => {
    assert.match(BULK_STATUS_DIALOG, /FORCE_STATUS_REQUIRES_COMMENT/, '必填名单必须来自共享词汇表')
    assert.match(BULK_STATUS_DIALOG, /commentMissing/, '没写原因时提交按钮要被禁用')
    assert.match(BULK_STATUS_DIALOG, /教师端要能看到|教师会在「我的资源」里看到/, '要说明"为什么必填"')
  })

  test('入口只在管理页，而且与删除并列（不是藏在别处）', () => {
    assert.match(ADMIN_PAGE, /admin-resources-bulk-status/, '要有「批量修改状态」按钮')
    assert.match(ADMIN_PAGE, /BulkStatusDialog/, '管理页必须挂上这个弹窗')
    assert.match(ADMIN_PAGE, /MAX_BULK_STATUS/, '超上限时按钮要禁用（与后端同一个数）')
  })
})


describe('④.5 三个超管专属动作的**两层门槛**都要在（变异测试发现的缺口）', () => {
  /**
   * 为什么必须两层都断言：
   * 控制器上的 `@RequireSuperAdmin()` 挡住 HTTP 这条路，
   * service 里的 `assertSuperAdmin()` 挡的是"绕过控制器直接调 service"
   * （以及将来有人新加一条路由却忘了写装饰器）。
   *
   * 这个缺口是变异测试自己暴露出来的：把 `bulkForceStatus()` 里的
   * `assertSuperAdmin()` 删掉，**全部 30 条接口用例照样是绿的** ——
   * 因为老师根本走不到那一行。光测 HTTP 层次证明不了纵深防御还在。
   */
  const CASES = [
    {
      name: '批量删除',
      route: "@Post('bulk-delete')",
      method: 'async bulkSoftDelete(',
    },
    {
      name: '批量修改状态',
      route: "@Post('bulk-status')",
      method: 'async bulkForceStatus(',
    },
    {
      name: '永久删除',
      route: "@Post(':id/purge')",
      method: 'async purge(',
    },
  ]

  for (const c of CASES) {
    test(`${c.name}：控制器有 @RequireSuperAdmin()，service 里也有 assertSuperAdmin()`, () => {
      const route = body(CONTROLLER, c.route)
      assert.match(route, /@RequireSuperAdmin\(\)/, `${c.name} 的控制器少了超管装饰器`)
      assert.match(route, /@RequirePermission\(/, `${c.name} 也要声明确切的权限动作`)

      const method = body(SERVICE, c.method)
      assert.match(
        method,
        /this\.authz\.assertSuperAdmin\(/,
        `${c.name} 的 service 少了第二次判定 —— 直接调 service 的路径会绕过去`,
      )
    })
  }

  test('批量改状态不能出现在 :id 路由之后（否则 bulk-status 会被当成一个资源 id）', () => {
    const bulkStatus = CONTROLLER.indexOf("@Post('bulk-status')")
    const firstIdRoute = CONTROLLER.indexOf("@Get(':id')")
    assert.notEqual(bulkStatus, -1)
    assert.notEqual(firstIdRoute, -1)
    assert.ok(bulkStatus < firstIdRoute, 'bulk-status 必须声明在 :id 之前')
  })
})

describe('④ 永久删除的两层门槛缺一不可', () => {
  test('控制器声明 @RequireSuperAdmin()，service 再调一次 assertSuperAdmin()', () => {
    const route = body(CONTROLLER, "@Post(':id/purge')")
    assert.match(route, /@RequireSuperAdmin\(\)/, '控制器少了超管门槛（越权缺口就是这么来的）')
    assert.match(route, /this\.resources\.purge\(/)
    // 纵深防御：绕过控制器直接调 service 也要挡住
    const purge = body(SERVICE, 'async purge(')
    assert.match(
      purge,
      /this\.authz\.assertSuperAdmin\(/,
      'service 层必须自己再判一次超管 —— 不能只靠控制器上的装饰器',
    )
  })

  test('永久删除有"必须先软删除"的前置条件（可恢复的那一步在前）', () => {
    const purge = body(SERVICE, 'async purge(')
    assert.match(purge, /deleted_at === null/)
    assert.match(purge, /RESOURCE_NOT_IN_RECYCLE_BIN/)
  })

  test('永久删除**先删对象再删行**，并且删完回查（否则会留下孤儿）', () => {
    const purge = body(SERVICE, 'async purge(')
    const deleteObject = purge.indexOf('this.storage.delete(')
    const deleteRow = purge.search(/DELETE\s+FROM\s+resources/i)
    assert.notEqual(deleteObject, -1, 'purge 必须真的删对象')
    assert.notEqual(deleteRow, -1, 'purge 必须真的删数据库行')
    assert.ok(
      deleteObject < deleteRow,
      '顺序不能反：先删对象再删行。反过来一旦存储失败，桶里会留下没人知道的孤儿，' +
        '而用户看到的是"删成功了"',
    )
    // 关键的一条：`delete(` 必须被 await（修复前漏了 await，异常还被 catch {} 吞掉）
    assert.match(purge, /await this\.storage\.delete\(/)
    assert.match(purge, /await this\.storage\.head\(/)
    // 删完必须回查，核验没过就不写 success
    assert.match(purge, /leftover/)
    assert.match(purge, /result:\s*leftover\.length === 0 \? 'success' : 'failed'/)
  })

  test('purge 不再吞异常：没有空的 catch {}', () => {
    const purge = body(SERVICE, 'async purge(')
    assert.equal(
      /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(purge),
      false,
      '空的 catch {} 会把"对象没删掉"变成静默成功 —— 这正是修复前的那个缺陷',
    )
  })
})
