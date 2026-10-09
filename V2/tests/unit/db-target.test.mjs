/**
 * tests/unit/db-target.test.mjs —— 运维脚本的"目标库"解析与脱敏
 * ============================================================================
 * 业主 Stage 13C §4：执行最高权限交接的脚本**不许有默认库**，
 * 而且必须能在动手之前把目标（脱敏）打印出来给操作者确认。
 *
 * 这份测试盯住三件事：
 *   ① 没有 / 空白 / 非法 / 非 postgres / 缺库名的 `DATABASE_URL` → 一律**不解析出目标**
 *      （调用方据此立刻退出，不连库）；
 *   ② 脱敏结果里**绝不含口令**，也**不含**查询串（参数里也可能带敏感值）；
 *   ③ 本机 / 非本机判定 —— "我以为在跑本机、其实在跑生产"是最危险的误解。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  announceDatabaseTarget,
  redactDatabaseUrl,
  resolveDatabaseTarget,
} from '../../scripts/lib/db-target.mjs'

describe('① 没有明确目标就不解析（运维脚本不猜库）', () => {
  test('缺失 / 空白 / 只有空格 → ok: false，并说清为什么', () => {
    for (const env of [{}, { DATABASE_URL: undefined }, { DATABASE_URL: '' }, { DATABASE_URL: '   ' }]) {
      const out = resolveDatabaseTarget(env)
      assert.equal(out.ok, false, `必须拒绝：${JSON.stringify(env)}`)
      assert.match(out.reason, /DATABASE_URL/, '要说清缺的是哪个变量')
      assert.match(out.reason, /不接受任何默认库/, '要说清"不猜默认库"这条规则')
      // 拒绝理由里**不能**出现"带凭据的连接串"（`user:password@` 形状）。
      // 允许出现占位示例（`postgresql://用户@主机:5432/库名`）—— 那是给人照做的模板，
      // 里面没有口令；真口令出现在这里才是泄漏。
      assert.equal(
        /:\/\/[^\s@/]+:[^\s@/]+@/.test(out.reason),
        false,
        `理由里不该出现带口令的连接串：${out.reason}`,
      )
    }
  })

  test('协议不对 / 缺库名 → 拒绝（不猜）', () => {
    const bad = resolveDatabaseTarget({ DATABASE_URL: 'mysql://u:p@h:3306/db' })
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /postgres/, '要说清必须是 postgres 连接串')

    const noDb = resolveDatabaseTarget({ DATABASE_URL: 'postgresql://u:p@h:5432/' })
    assert.equal(noDb.ok, false)
    assert.match(noDb.reason, /库名/, '要说清没给库名')
  })

  test('合法连接串 → ok: true，并给出脱敏目标与库名', () => {
    const out = resolveDatabaseTarget({
      DATABASE_URL: 'postgresql://qlsadmin:secret-pw@127.0.0.1:55432/qls_v2_test',
    })
    assert.equal(out.ok, true)
    assert.equal(out.database, 'qls_v2_test')
    assert.equal(out.host, '127.0.0.1')
    assert.equal(out.local, true)
    assert.equal(out.redacted.includes('secret-pw'), false, '脱敏结果不能含口令')
    assert.equal(out.redacted, 'postgresql://qlsadmin@127.0.0.1:55432/qls_v2_test')
  })
})

describe('② 脱敏：口令与查询串都不许出现在输出里', () => {
  test('口令被丢掉，用户名/主机/端口/库名保留', () => {
    assert.equal(
      redactDatabaseUrl('postgresql://user:pa%40ss@db.example.com:5432/qls'),
      'postgresql://user@db.example.com:5432/qls',
    )
  })

  test('查询串整段丢掉（`?password=` 这类参数也可能带敏感值）', () => {
    const redacted = redactDatabaseUrl(
      'postgresql://user:pw@db.example.com:5432/qls?sslmode=require&password=oops',
    )
    assert.equal(redacted, 'postgresql://user@db.example.com:5432/qls')
    assert.equal(redacted.includes('oops'), false)
    assert.equal(redacted.includes('pw'), false)
  })

  test('没有用户名/端口时也照样能打印', () => {
    assert.equal(redactDatabaseUrl('postgresql://db.example.com/qls'), 'postgresql://db.example.com/qls')
  })

  test('解析不了的串不回显原内容（它可能带着口令）', () => {
    const redacted = redactDatabaseUrl('这不是一个 URL，但里面可能有 secret')
    assert.equal(redacted.includes('secret'), false)
    assert.match(redacted, /隐去/)
  })
})

describe('③ 本机 / 非本机判定（消除"我以为在跑本机"）', () => {
  test('本机地址判定为本机', () => {
    for (const host of ['127.0.0.1', 'localhost']) {
      const out = resolveDatabaseTarget({ DATABASE_URL: `postgresql://u@${host}:5432/qls` })
      assert.equal(out.local, true, `${host} 应当判为本机`)
    }
  })

  test('远端地址判定为非本机（并给一句提醒）', () => {
    const out = resolveDatabaseTarget({
      DATABASE_URL: 'postgresql://u:pw@db.production.example.com:5432/qls',
    })
    assert.equal(out.local, false)
    const lines = []
    announceDatabaseTarget(out, (line) => lines.push(line))
    const text = lines.join('\n')
    assert.match(text, /目标数据库：postgresql:\/\/u@db\.production\.example\.com:5432\/qls/, text)
    assert.match(text, /非本机/, '远端目标要被标出来')
    assert.equal(text.includes('pw'), false, `提醒里不能带口令：${text}`)
  })
})
