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
    // 服务层不自己列一遍状态：只允许引用 `shared/resource-status.ts` 的那一份
    assert.match(one, /DELETABLE_STATUSES/)
    assert.equal(
      /status\s*===\s*'PUBLISHED'/.test(one),
      false,
      '不要在服务层另写一份状态名单 —— 那份名单只有一个真相',
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
    // 新增 outcome 时这里必须跟着改：/已删除/ /已跳过/ /失败/ 三分支都要显式出现
    for (const label of ['已删除', '已跳过', '失败']) {
      assert.ok(
        ADMIN_PAGE.includes(label),
        `管理页缺少「${label}」这一支的文案 —— outcome 词汇表变了就要同步`,
      )
    }
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
