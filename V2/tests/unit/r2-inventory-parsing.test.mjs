/**
 * tests/unit/r2-inventory-parsing.test.mjs —— 控制台导出的解析（业主 Stage 13C.1 §二）
 * ============================================================================
 * 为什么这份测试必须逐条列全：清单是拿来做**正式对账**的。
 * 一次 `split(',')` 就会把带逗号的对象键劈成两半，而"少了一个 key"在对比时
 * 与"对象被删了"长得一模一样 —— 会报出根本不存在的生产事故。
 *
 * 所以这里覆盖业主点名的 10 种情形，判据是"**要么正确解析，要么明确报错**"，
 * 不允许"跳过坏行、返回剩余部分"。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { CsvError, parseCsv } from '../../scripts/lib/csv.mjs'
import { InventorySourceError, parseConsoleExport } from '../../scripts/lib/inventory-source.mjs'

/** 键里带逗号的真实场景（R2 控制台导出的对象键确实长这样）。 */
const KEY_WITH_COMMA = 'uploads/76b60eb6-42ca-4143-a76c-9efd0202ee3e/1791293126057-校服申领登记,副本.png'
const KEY_WITH_QUOTE = 'uploads/a/他说"你好".png'
const KEY_CN = '上传/中文目录/教案-第3周.pdf'

describe('① CSV 基础与边界（10 种情形）', () => {
  test('1. 普通对象键', () => {
    const { format, objects } = parseConsoleExport('key,size\nuploads/a/1.png,123\n')
    assert.equal(format, 'csv')
    assert.deepEqual(objects.map((o) => [o.key, o.size]), [['uploads/a/1.png', 123]])
  })

  test('2. 含**逗号**的对象键（必须整体保留，不能被劈成两列）', () => {
    const csv = `key,size\n"${KEY_WITH_COMMA}",1618105\n`
    const { objects } = parseConsoleExport(csv)
    assert.equal(objects.length, 1)
    assert.equal(objects[0].key, KEY_WITH_COMMA, '带引号的逗号必须留在同一个字段里')
    assert.equal(objects[0].size, 1618105)
  })

  test('3. 字段内含**双引号**（RFC 4180 的 `""` 转义）', () => {
    const csv = `key,size\n"${KEY_WITH_QUOTE.replaceAll('"', '""')}",42\n`
    const { objects } = parseConsoleExport(csv)
    assert.equal(objects[0].key, KEY_WITH_QUOTE)
    assert.equal(objects[0].size, 42)
  })

  test('4. 含中文的对象键', () => {
    const { objects } = parseConsoleExport(`key,size\n"${KEY_CN}",2048\n`)
    assert.equal(objects[0].key, KEY_CN)
    assert.equal(objects[0].size, 2048)
  })

  test('5. CRLF 行尾', () => {
    const { objects } = parseConsoleExport('key,size\r\nuploads/a/1.png,10\r\nuploads/a/2.png,20\r\n')
    assert.deepEqual(objects.map((o) => o.key), ['uploads/a/1.png', 'uploads/a/2.png'])
    assert.deepEqual(objects.map((o) => o.size), [10, 20])
  })

  test('6. UTF-8 BOM（否则第一个表头会变成 \\uFEFFkey，认不出来）', () => {
    const { objects } = parseConsoleExport(`\uFEFFkey,size\nuploads/a/1.png,7\n`)
    assert.equal(objects.length, 1)
    assert.equal(objects[0].key, 'uploads/a/1.png')
  })

  test('7. 带引号的**合法换行**（字段跨行仍然是一个对象键）', () => {
    const csv = 'key,size\n"uploads/a/看起来\n换行了.png",99\n'
    const { objects } = parseConsoleExport(csv)
    assert.equal(objects.length, 1, '引号内的换行不能把一条记录拆成两条')
    assert.equal(objects[0].key, 'uploads/a/看起来\n换行了.png')
    assert.equal(objects[0].size, 99)
  })

  test('8. 缺失 key → 报错（带行号），不跳过', () => {
    assert.throws(
      () => parseConsoleExport('key,size\n,100\n'),
      (error) => {
        assert.ok(error instanceof InventorySourceError)
        assert.match(error.message, /对象键为空/)
        assert.match(error.message, /第 2 行/)
        return true
      },
    )
  })

  test('9. 非法 size → 报错（负号、小数、非数字都算）', () => {
    for (const bad of ['-1', '12.5', 'abc', '']) {
      assert.throws(
        () => parseConsoleExport(`key,size\nuploads/a/1.png,${bad}\n`),
        (error) => {
          assert.ok(error instanceof InventorySourceError, `"${bad}" 应当被拒绝`)
          assert.match(error.message, /size/)
          return true
        },
        `size="${bad}" 必须报错`,
      )
    }
  })

  test('10. 错误引号 / 损坏格式 → 必须失败（不是只跳过那一行）', () => {
    // 引号没闭合
    assert.throws(() => parseCsv('key,size\n"uploads/a/1.png,100\n'), CsvError)
    // 未加引号的字段中间出现引号
    assert.throws(() => parseCsv('key,size\nuploads/a/"1".png,100\n'), CsvError)
    // 引号闭合后还有多余字符
    assert.throws(() => parseCsv('key,size\n"abc"def,100\n'), CsvError)
    // 列数与表头不符
    assert.throws(
      () => parseConsoleExport('key,size\nuploads/a/1.png,100,extra\n'),
      (error) => {
        assert.match(error.message, /列数与表头不符/)
        return true
      },
    )
  })

  test('表头别名：name / object key / bytes 都认', () => {
    for (const header of ['name,bytes', 'Object Key,Size', '文件名,大小']) {
      const { objects } = parseConsoleExport(`${header}\nuploads/a/1.png,5\n`)
      assert.equal(objects[0].key, 'uploads/a/1.png', `表头 ${header} 应当被识别`)
      assert.equal(objects[0].size, 5)
    }
  })
})

describe('② JSON 导出（文档里优先推荐的那条路）', () => {
  test('接受数组 / {objects} / {Contents} 三种形状', () => {
    const rows = [{ key: 'uploads/a/1.png', size: 10 }]
    for (const text of [JSON.stringify(rows), JSON.stringify({ objects: rows }), JSON.stringify({ Contents: rows })]) {
      const { format, objects } = parseConsoleExport(text)
      assert.equal(format, 'json')
      assert.deepEqual(objects.map((o) => o.key), ['uploads/a/1.png'])
    }
  })

  test('带逗号/中文/引号的键在 JSON 里天然安全', () => {
    const { objects } = parseConsoleExport(
      JSON.stringify([{ key: KEY_WITH_COMMA, size: 1 }, { key: KEY_WITH_QUOTE, size: 2 }, { key: KEY_CN, size: 3 }]),
    )
    assert.deepEqual(objects.map((o) => o.key), [KEY_WITH_COMMA, KEY_WITH_QUOTE, KEY_CN])
  })

  test('结构无法解释 → 明确报错（并说清按哪种格式解析的）', () => {
    // 以 `{` / `[` 开头的一律当 JSON，结构不对就报 JSON 的错
    assert.throws(() => parseConsoleExport('{"foo":[]}'), (error) => {
      assert.ok(error instanceof InventorySourceError)
      assert.match(error.message, /JSON 结构无法解释/)
      return true
    })
    assert.throws(() => parseConsoleExport('{ 坏 json'), /JSON 解析失败/)

    // 其余（裸字符串、裸数字）会走 CSV：报"认不出表头"也是**明确失败**，
    // 关键是**不许**返回一份空清单或部分清单。
    for (const bad of ['"just a string"', '123']) {
      assert.throws(() => parseConsoleExport(bad), (error) => {
        assert.ok(error instanceof InventorySourceError, `必须明确失败：${bad}`)
        assert.match(error.message, /CSV|JSON/)
        return true
      })
    }
  })

  test('缺 key / 非法 size / 重复 key 都要失败', () => {
    assert.throws(() => parseConsoleExport('[{"size":1}]'), /缺少对象键/)
    assert.throws(() => parseConsoleExport('[{"key":"a","size":"x"}]'), /size 不是非负整数/)
    assert.throws(
      () => parseConsoleExport('[{"key":"a","size":1},{"key":"a","size":2}]'),
      /重复对象键/,
    )
  })

  test('空文件 → 报错', () => {
    assert.throws(() => parseConsoleExport('   \n'), /空文件/)
  })
})
