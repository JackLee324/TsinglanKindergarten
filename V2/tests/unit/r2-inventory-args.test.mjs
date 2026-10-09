/**
 * tests/unit/r2-inventory-args.test.mjs —— `--max` 参数解析（业主 Stage 13C.3 §A）
 * ============================================================================
 * 这一条来自一个**真实的绕过**：以前的解析是
 *
 *     Number(arg('max', '0')) || 0
 *
 * 于是 `--max 0`、`--max abc`、`--max`（缺少数值）全都变成 `MAX = 0`，
 * 而完整性保护判的是 `MAX > 0` —— **显式传了 `--max`，脚本却走全量分支并产出
 * `complete=true`**，把"抽样清单不能当全量"这条门禁直接绕过去了。
 *
 * 所以判据必须是"**参数有没有出现**"，而不是"数值是不是 0"：
 *   · 没传 `--max` → 原有行为不变；
 *   · 传了且是正整数 → 一律不完整；
 *   · 传了但无效（0 / 负数 / 小数 / 非数字 / 缺少数值）→ **退出码 2，不产出任何产物**。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'r2-inventory.mjs')
const WORK = mkdtempSync(join(tmpdir(), 'r2-args-'))
const BUCKET = 'tsinglan-curriculum'
const KEYS = ['uploads/a/1.png', 'uploads/a/2.png', 'top.txt']

const EXPORT = join(WORK, 'three.json')

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}
const artifactOf = (p) => JSON.parse(readFileSync(p, 'utf8'))
const freshOut = (name) => join(WORK, name)

before(() => {
  writeFileSync(EXPORT, JSON.stringify(KEYS.map((key, i) => ({ key, size: 10 + i }))), 'utf8')
})

describe('① 没传 --max：完整性行为不变', () => {
  test('控制台导出 + --expect-count 一致 → complete=true', () => {
    const out = freshOut('no-max.json')
    const { code, out: text } = run([
      '--from-console', EXPORT, '--bucket', BUCKET,
      '--expect-count', '3', '--expect-source', 'fixture', '--out', out,
    ])
    assert.equal(code, 0, text)
    assert.equal(artifactOf(out).complete, true)
  })

  test('控制台导出但没核对数量 → 仍然不完整（13C.2 的规则没被削弱）', () => {
    const out = freshOut('no-max-unverified.json')
    const { code } = run(['--from-console', EXPORT, '--bucket', BUCKET, '--out', out])
    assert.equal(code, 0)
    assert.equal(artifactOf(out).complete, false)
    assert.equal(artifactOf(out).completeness.reason, 'console-export-unverified')
  })
})

describe('② 有效 --max（正整数）：一律不完整', () => {
  for (const value of ['1', '3', '100']) {
    test(`--max ${value} → complete=false，且 usableForProductionComparison=false`, () => {
      const out = freshOut(`max-${value}.json`)
      const { code, out: text } = run(['--from-console', EXPORT, '--bucket', BUCKET, '--max', value, '--out', out])
      assert.equal(code, 0, text)
      const artifact = artifactOf(out)
      assert.equal(artifact.complete, false, `--max ${value} 必须不完整（哪怕对象数少于上限）`)
      assert.equal(artifact.completeness.usableForProductionComparison, false)
      assert.equal(artifact.completeness.reason, 'truncated-by-max')
    })
  }

  test('--max 100（对象只有 3 条）不得被当成完整清单', () => {
    const out = freshOut('max-100.json')
    run(['--from-console', EXPORT, '--bucket', BUCKET, '--max', '100', '--out', out])
    assert.equal(artifactOf(out).objects.length, 3, '抽样仍然保留全部对象')
    assert.equal(artifactOf(out).complete, false)
  })
})

describe('③ 无效 --max：明确失败（退出码 2），且不产出任何产物', () => {
  const invalid = [
    ['--max', '0'],
    ['--max', 'abc'],
    ['--max', '1.5'],
    ['--max', '-3'],
    ['--max', ''],
    ['--max'], // 缺少数值
    ['--max', '+3'],
    ['--max', '0x10'],
    ['--max', '1e3'],
  ]

  for (const [flag, value] of invalid) {
    const label = value === undefined ? '缺少数值' : `"${value}"`
    test(`--max ${label} → 退出码 2，不写产物`, () => {
      const out = freshOut(`invalid-${String(value ?? 'missing').replace(/[^a-z0-9]/gi, '_')}.json`)
      if (existsSync(out)) throw new Error(`前置：${out} 不该存在`)
      const args = ['--from-console', EXPORT, '--bucket', BUCKET, flag]
      if (value !== undefined) args.push(value)
      args.push('--out', out)
      const { code, out: text } = run(args)
      assert.equal(code, 2, `必须参数级拒绝：${text}`)
      assert.match(text, /--max/)
      assert.equal(existsSync(out), false, '参数无效时绝不能产出清单（更不能退化成"全量"）')
      assert.equal(/完整性：完整/.test(text), false, '无效参数不得走到"完整清单"那条路')
    })
  }

  test('无效 --max 与 --compare 同用 → 仍然失败，且不输出差异结论', () => {
    const base = freshOut('cmp-base.json')
    assert.equal(
      run([
        '--from-console', EXPORT, '--bucket', BUCKET,
        '--expect-count', '3', '--expect-source', 'fixture', '--storage-id', 'id-a', '--out', base,
      ]).code,
      0,
    )
    const { code, out } = run([
      '--from-console', EXPORT, '--bucket', BUCKET, '--max', 'abc', '--compare', base,
    ])
    assert.equal(code, 2, out)
    assert.equal(/消失 \d+ 个|新增 \d+ 个/.test(out), false, '参数无效时不能输出任何差异结论')
  })

  test('有效 --max 与 --compare 同用 → 退出码 2（抽样不能拿来对账）', () => {
    const base = freshOut('cmp-base2.json')
    assert.equal(
      run([
        '--from-console', EXPORT, '--bucket', BUCKET,
        '--expect-count', '3', '--expect-source', 'fixture', '--storage-id', 'id-a', '--out', base,
      ]).code,
      0,
    )
    const { code, out } = run([
      '--from-console', EXPORT, '--bucket', BUCKET, '--max', '2', '--expect-count', '3',
      '--expect-source', 'fixture', '--compare', base,
    ])
    assert.equal(code, 2, out)
    assert.match(out, /不能一起用/)
    assert.equal(/消失 \d+ 个|新增 \d+ 个/.test(out), false)
  })
})
