/**
 * tests/unit/r2-inventory-completeness.test.mjs —— 清单完整性与对比范围
 * ============================================================================
 * 业主 Stage 13C.1 §三：**半个清单和全量清单在肉眼上完全一样**。
 * 唯一能区分它们的是产物里的完整性标记；而"用半个清单去对账"会得出
 * "生产对象被删了"这种**假事故**结论。所以这条链上的每个环节都要有测试：
 *
 *   ① 默认（不加 --max）= 完整；
 *   ② 用了 --max = `complete=false` + `usableForProductionComparison=false`；
 *   ③ `--compare` 遇到任一份不完整 → 拒绝（退出码 6）；
 *   ④ `--compare` 遇到桶/前缀/主机不一致 → 拒绝（退出码 7）；
 *   ⑤ `--max` 与 `--compare` 同时出现 → 直接拒绝（退出码 2）；
 *   ⑥ 范围的声明（bucket / prefix / method）真的写进产物，供下一次对比核对。
 *
 * 跑真脚本、读真产物（临时目录里），不做纯函数级别的"近似验证"。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'r2-inventory.mjs')
const WORK = mkdtempSync(join(tmpdir(), 'r2-inv-'))
const BUCKET = 'tsinglan-curriculum'

const exportObjects = (keys) => JSON.stringify(keys.map((key, i) => ({ key, size: 100 + i })))

function run(args, { env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** 生成一个控制台导出文件。 */
function writeExport(name, keys) {
  const path = join(WORK, name)
  writeFileSync(path, exportObjects(keys), 'utf8')
  return path
}

const FOUR = ['uploads/a/1.png', 'uploads/a/2.png', 'uploads/b/3.pdf', 'top.txt']

before(() => {
  mkdirSync(WORK, { recursive: true })
})

describe('① 完整性标记：默认完整，--max 必须标成不完整', () => {
  test('不加 --max：complete=true 且可用于正式对账', () => {
    const file = writeExport('full.json', FOUR)
    const outPath = join(WORK, 'full-out.json')
    const { code, out } = run(['--from-console', file, '--bucket', BUCKET, '--out', outPath])
    assert.equal(code, 0, out)
    assert.match(out, /完整性：完整（可用于正式对账）/)

    const artifact = JSON.parse(readFileSync(outPath, 'utf8'))
    assert.equal(artifact.complete, true)
    assert.equal(artifact.completeness.complete, true)
    assert.equal(artifact.completeness.usableForProductionComparison, true)
    assert.equal(artifact.completeness.reason, 'console-export-declared-complete')
    assert.deepEqual(artifact.scope, { method: 'console-export', endpointHost: null, bucket: BUCKET, prefix: '' })
    assert.equal(artifact.objects.length, 4)
  })

  test('--max 2：complete=false、明确不可用于正式对账，并打印警告', () => {
    const file = writeExport('full2.json', FOUR)
    const outPath = join(WORK, 'partial-out.json')
    const { code, out } = run(['--from-console', file, '--bucket', BUCKET, '--max', '2', '--out', outPath])
    assert.equal(code, 0, out)
    assert.match(out, /不完整（抽样\/截断）/)
    assert.match(out, /抽样/)

    const artifact = JSON.parse(readFileSync(outPath, 'utf8'))
    assert.equal(artifact.complete, false)
    assert.equal(artifact.completeness.reason, 'truncated-by-max')
    assert.equal(artifact.completeness.usableForProductionComparison, false, '不完整清单不能被当成对账依据')
    assert.equal(artifact.objects.length, 2)
  })
})

describe('② 对比守卫：不完整或范围不一致一律拒绝', () => {
  test('前一份不完整 → 退出码 6，且不输出差异结论', () => {
    const file = writeExport('full3.json', FOUR)
    const { code, out } = run([
      '--from-console', file, '--bucket', BUCKET,
      '--compare', join(WORK, 'partial-out.json'),
    ])
    assert.equal(code, 6, `必须拒绝：${out}`)
    assert.match(out, /拒绝对比/)
    assert.match(out, /不完整/)
    assert.equal(/消失 \d+ 个/.test(out), false, '拒绝时不能给出差异结论')
  })

  test('当前清单不完整（--max）→ 与 compare 一起用直接拒绝', () => {
    const file = writeExport('full4.json', FOUR)
    const { code, out } = run([
      '--from-console', file, '--bucket', BUCKET, '--max', '2',
      '--compare', join(WORK, 'full-out.json'),
    ])
    assert.equal(code, 2, `必须拒绝：${out}`)
    assert.match(out, /不能一起用/)
  })

  test('桶不一致 → 退出码 7（差异没有意义）', () => {
    const file = writeExport('other-bucket.json', FOUR)
    const { code, out } = run([
      '--from-console', file, '--bucket', 'another-bucket',
      '--compare', join(WORK, 'full-out.json'),
    ])
    assert.equal(code, 7, `必须拒绝：${out}`)
    assert.match(out, /桶不一致/)
  })

  test('前缀不一致 → 退出码 7', () => {
    const file = writeExport('prefixed.json', ['uploads/a/1.png'])
    const { code, out } = run([
      '--from-console', file, '--bucket', BUCKET, '--prefix', 'uploads/',
      '--compare', join(WORK, 'full-out.json'),
    ])
    assert.equal(code, 7, `必须拒绝：${out}`)
    assert.match(out, /前缀不一致/)
  })

  test('范围一致且都完整 → 正常对比；有对象消失时退出码 5', () => {
    const file = writeExport('missing-one.json', FOUR.slice(1))
    const { code, out } = run([
      '--from-console', file, '--bucket', BUCKET,
      '--compare', join(WORK, 'full-out.json'),
    ])
    assert.equal(code, 5, `对象消失了要交人工判断：${out}`)
    assert.match(out, /消失 1 个/)
    assert.match(out, /必须由人来判断/)
  })

  test('范围一致且没有消失 → 退出码 0', () => {
    const file = writeExport('same.json', FOUR)
    const { code, out } = run([
      '--from-console', file, '--bucket', BUCKET,
      '--compare', join(WORK, 'full-out.json'),
    ])
    assert.equal(code, 0, out)
    assert.match(out, /消失 0 个 \/ 新增 0 个/)
  })

  test('没有 --bucket 的 --from-console 被拒绝（范围无法核对）', () => {
    const file = writeExport('needs-bucket.json', FOUR)
    const { code, out } = run(['--from-console', file])
    assert.equal(code, 2, `必须拒绝：${out}`)
    assert.match(out, /--bucket/)
  })

  test('不是本工具产物的对比文件 → 退出码 6', () => {
    const bogus = join(WORK, 'bogus.json')
    writeFileSync(bogus, JSON.stringify({ objects: [{ key: 'a', size: 1 }] }), 'utf8')
    const file = writeExport('for-bogus.json', FOUR)
    const { code, out } = run(['--from-console', file, '--bucket', BUCKET, '--compare', bogus])
    assert.equal(code, 6, `必须拒绝：${out}`)
    assert.match(out, /readOnly|不是本工具产出/)
  })
})
