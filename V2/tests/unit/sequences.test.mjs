/**
 * tests/unit/sequences.test.mjs —— 序列落后的判定必须准确且"只落后才算"
 * ============================================================================
 * 2026-10-11 线上：`audit_logs` 序列停在 5、表里最大 621 → 每次审计写入主键冲突，
 * 而审计服务刻意不让业务失败 → **静默丢审计**（登录成功却查不到记录）。
 * 判定逻辑错一档就会出现两种坏结果：漏判（继续静默丢）或误判（对正常库乱 setval）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { compareSequenceLag } from '../../scripts/lib/sequences.mjs'

const row = (table, last, max) => ({ table, column: 'id', lastValue: last, maxValue: max })

describe('① 落后才算问题', () => {
  test('序列 < 表内最大 → 判为落后（就是线上那次）', () => {
    const behind = compareSequenceLag([row('audit_logs', '5', '621')])
    assert.equal(behind.length, 1)
    assert.equal(behind[0].table, 'audit_logs')
  })

  test('序列 == 表内最大 → 正常', () => {
    assert.deepEqual(compareSequenceLag([row('audit_logs', '621', '621')]), [])
  })

  test('序列超前（回滚/删行造成）→ 正常，不该被"修"回去', () => {
    assert.deepEqual(compareSequenceLag([row('audit_logs', '900', '621')]), [])
  })

  test('空表 + 未用过的序列（null）→ 正常', () => {
    assert.deepEqual(compareSequenceLag([row('sessions', null, '0')]), [])
  })

  test('空表但序列已被用过 → 正常', () => {
    assert.deepEqual(compareSequenceLag([row('sessions', '12', '0')]), [])
  })
})

describe('② 大整数与多行', () => {
  test('用 BigInt 比较（超过 2^53 也不会算错）', () => {
    const big = '9007199254740993' // 2^53 + 1
    assert.equal(compareSequenceLag([row('audit_logs', big, '9007199254740994')]).length, 1)
    assert.deepEqual(compareSequenceLag([row('audit_logs', big, big)]), [])
  })

  test('只挑出落后的那几行', () => {
    const behind = compareSequenceLag([
      row('users', '24', '24'),
      row('audit_logs', '5', '621'),
      row('resources', '400', '347'),
      row('sessions', '1', '9'),
    ])
    assert.deepEqual(behind.map((b) => b.table), ['audit_logs', 'sessions'])
  })

  test('空输入 / undefined → 空结果（不抛）', () => {
    assert.deepEqual(compareSequenceLag([]), [])
    assert.deepEqual(compareSequenceLag(undefined), [])
  })
})
