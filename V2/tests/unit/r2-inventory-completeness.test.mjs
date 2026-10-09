/**
 * tests/unit/r2-inventory-completeness.test.mjs —— 清单完整性、范围与对比守卫
 * ============================================================================
 * 业主 Stage 13C.2 的完成标准是两句话：
 *   · **任何不能证明完整的清单，都不能被当成生产全量清单**；
 *   · **任何范围不同的两份清单，都不能生成误导性的差异结论**。
 *
 * 所以这份测试按"来源 × 完整性"的每个格子跑真脚本、读真产物：
 *
 *   ① `--max`：4 条 `--max 10`、4 条 `--max 4`、空清单 `--max 10` —— **一律不完整**
 *      （"这次刚好没截断"不能自证完整）；
 *   ② 实时列举（真起一个本机 S3 后端）：显式 `--max` 但**没到上限** → 仍然不完整；
 *      不加 `--max` → 完整；
 *   ③ 控制台导出：只是"格式正确"时**默认不完整**；只有 `--expect-count` 与解析结果
 *      一致才完整，且产物里把「操作者声明」与「工具验证」分开记录；
 *      数量不一致 → 退出码 9 且**不产出产物**；文件自称分页/总数不符 → 退出码 8；
 *   ④ 前缀：声明的 Prefix 必须**真的过滤对象集合**（不是只改元数据）；
 *   ⑤ 对比：不完整 / 桶不同 / 前缀不同 → 拒绝（6 / 7），且**不输出差异结论**。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { S3_TEST_ACCESS_KEY, S3_TEST_SECRET_KEY, s3TestClient, startS3Backend } from '../helpers/s3-backend.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'r2-inventory.mjs')
const WORK = mkdtempSync(join(tmpdir(), 'r2-inv-'))
const BUCKET = 'tsinglan-curriculum'

const FOUR = ['uploads/a/1.png', 'uploads/a/2.png', 'uploads/b/3.pdf', 'top.txt']
const toObjects = (keys) => keys.map((key, i) => ({ key, size: 100 + i }))

function writeExport(name, keys) {
  const path = join(WORK, name)
  writeFileSync(path, JSON.stringify(toObjects(keys)), 'utf8')
  return path
}
function writeRaw(name, text) {
  const path = join(WORK, name)
  writeFileSync(path, text, 'utf8')
  return path
}
function run(args, { env = {} } = {}) {
  // spawnSync：要同时拿到**退出码**与输出（失败不算异常，退出码本身是被测行为）
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}
const artifactOf = (path) => JSON.parse(readFileSync(path, 'utf8'))
const DIFF_LINE = /消失 \d+ 个|新增 \d+ 个|迁移/

describe('① --max：只要用了，就一律不完整（业主 Stage 13C.2 §一）', () => {
  test('4 条对象 + --max 10（**没到上限**）→ complete=false', () => {
    const file = writeExport('four-a.json', FOUR)
    const out = join(WORK, 'four-a-out.json')
    const { code, out: text } = run(['--from-console', file, '--bucket', BUCKET, '--max', '10', '--out', out])
    assert.equal(code, 0, text)
    const artifact = artifactOf(out)
    assert.equal(artifact.complete, false, '--max 一律不完整，哪怕对象数远没到上限')
    assert.equal(artifact.completeness.reason, 'truncated-by-max')
    assert.equal(artifact.completeness.usableForProductionComparison, false)
    assert.equal(artifact.objects.length, 4, '抽样时对象仍然照原样保留（只是不能当全量）')
    assert.match(text, /哪怕这次没截到上限也一样/)
  })

  test('4 条对象 + --max 4（**刚好等于上限**）→ complete=false', () => {
    const file = writeExport('four-b.json', FOUR)
    const out = join(WORK, 'four-b-out.json')
    const { code } = run(['--from-console', file, '--bucket', BUCKET, '--max', '4', '--out', out])
    assert.equal(code, 0)
    const artifact = artifactOf(out)
    assert.equal(artifact.complete, false)
    assert.equal(artifact.objects.length, 4)
  })

  test('空清单 + --max 10（**空桶也不例外**）→ complete=false', () => {
    const file = writeExport('empty.json', [])
    const out = join(WORK, 'empty-out.json')
    const { code } = run(['--from-console', file, '--bucket', BUCKET, '--max', '10', '--out', out])
    assert.equal(code, 0)
    const artifact = artifactOf(out)
    assert.equal(artifact.complete, false)
    assert.equal(artifact.objects.length, 0)
  })

  test('不完整的 --max 产物不能参与对比（退出码 6，且没有差异结论）', () => {
    const full = writeExport('full-for-compare.json', FOUR)
    const fullOut = join(WORK, 'full-for-compare-out.json')
    assert.equal(
      run(['--from-console', full, '--bucket', BUCKET, '--expect-count', '4', '--expect-source', 'fixture', '--out', fullOut]).code,
      0,
    )

    const partial = writeExport('partial-for-compare.json', FOUR)
    const partialOut = join(WORK, 'partial-for-compare-out.json')
    assert.equal(run(['--from-console', partial, '--bucket', BUCKET, '--max', '2', '--out', partialOut]).code, 0)

    // 当前不完整：--max 与 --compare 同时出现 → 参数级拒绝（退出码 2）
    const bothFlags = run([
      '--from-console', partial, '--bucket', BUCKET, '--max', '2',
      '--expect-count', '4', '--expect-source', 'fixture', '--compare', fullOut,
    ])
    assert.equal(bothFlags.code, 2, bothFlags.out)
    assert.match(bothFlags.out, /不能一起用/)
    assert.equal(DIFF_LINE.test(bothFlags.out), false, '参数级拒绝也不能输出差异')
    // 前一份不完整 → 6
    const { code, out } = run([
      '--from-console', full, '--bucket', BUCKET, '--expect-count', '4', '--expect-source', 'fixture', '--compare', partialOut,
    ])
    assert.equal(code, 6, out)
    assert.match(out, /拒绝对比/)
    assert.equal(DIFF_LINE.test(out), false, '拒绝时不能输出任何差异结论')
  })
})

describe('② 实时列举：显式 --max 但没到上限，仍然不完整（真起本机 S3 后端）', () => {
  let backend
  let env

  before(async () => {
    backend = await startS3Backend({ bucket: `r2inv-${Date.now().toString(36)}` })
    const client = s3TestClient()
    for (const Key of ['probe/1.txt', 'probe/2.txt', 'probe/3.txt']) {
      await client.send(new PutObjectCommand({ Bucket: backend.bucket, Key, Body: Buffer.from('probe') }))
    }
    env = {
      R2_ENDPOINT: backend.endpoint, // http://127.0.0.1:18444 → 需要 --allow-http-local
      R2_BUCKET: backend.bucket,
      R2_ACCESS_KEY_ID: S3_TEST_ACCESS_KEY,
      R2_SECRET_ACCESS_KEY: S3_TEST_SECRET_KEY,
    }
  })

  after(async () => {
    if (backend) await backend.stop()
  })

  test('不加 --max：走完全部分页 → complete=true，verification=工具列举', () => {
    const out = join(WORK, 'api-full.json')
    const { code, out: text } = run(['--allow-http-local', '--out', out], { env })
    assert.equal(code, 0, text)
    const artifact = artifactOf(out)
    assert.equal(artifact.complete, true)
    assert.equal(artifact.completeness.reason, 'listed-all-pages')
    assert.equal(artifact.completeness.verification, 'tool-listed-all-pages')
    assert.equal(artifact.objects.length, 3)
    assert.equal(artifact.scope.prefixFilterApplied, false)
  })

  test('显式 --max 100（远大于 3 个对象）→ 仍然 complete=false', () => {
    const out = join(WORK, 'api-max.json')
    const { code, out: text } = run(['--allow-http-local', '--max', '100', '--out', out], { env })
    assert.equal(code, 0, text)
    const artifact = artifactOf(out)
    assert.equal(artifact.complete, false, '用了 --max 就不完整，哪怕实际只列到 3 个')
    assert.equal(artifact.completeness.reason, 'truncated-by-max')
    assert.equal(artifact.completeness.usableForProductionComparison, false)
    assert.match(text, /抽样/)
  })

  test('实时列举也支持 --prefix（服务端过滤，元数据标记已应用）', () => {
    const out = join(WORK, 'api-prefix.json')
    const { code, out: text } = run(['--allow-http-local', '--prefix', 'probe/', '--out', out], { env })
    assert.equal(code, 0, text)
    const artifact = artifactOf(out)
    assert.equal(artifact.complete, true)
    assert.equal(artifact.scope.prefix, 'probe/')
    assert.equal(artifact.scope.prefixFilterApplied, true)
    assert.equal(artifact.objects.length, 3)
  })

  test('http 默认仍然被拒（只有 --allow-http-local 才放行）', () => {
    const { code, out } = run([], { env })
    assert.equal(code, 2, out)
    assert.match(out, /必须是 https/)
  })
})

describe('③ 控制台导出：格式正确 ≠ 已证明全量（业主 Stage 13C.2 §二）', () => {
  test('只给出文件、没有任何数量核对 → complete=false（unverified）', () => {
    const file = writeExport('unverified.json', FOUR)
    const out = join(WORK, 'unverified-out.json')
    const { code, out: text } = run(['--from-console', file, '--bucket', BUCKET, '--out', out])
    assert.equal(code, 0, text)
    const artifact = artifactOf(out)
    assert.equal(artifact.complete, false, 'JSON 合法 ≠ 覆盖整个桶')
    assert.equal(artifact.completeness.reason, 'console-export-unverified')
    assert.equal(artifact.completeness.verification, 'none')
    assert.equal(artifact.completeness.declaredBy, null)
    assert.match(text, /只证明"文件格式有效"/)
  })

  test('--expect-count 与解析结果一致 → complete=true，并记录"谁声明/工具验证了什么"', () => {
    const file = writeExport('verified.json', FOUR)
    const out = join(WORK, 'verified-out.json')
    const { code, out: text } = run([
      '--from-console', file, '--bucket', BUCKET,
      '--expect-count', '4', '--expect-source', 'R2 控制台 2026-10-10 15:04 显示 4 个对象',
      '--out', out,
    ])
    assert.equal(code, 0, text)
    const artifact = artifactOf(out)
    assert.equal(artifact.complete, true)
    assert.equal(artifact.completeness.reason, 'console-export-count-verified')
    assert.equal(artifact.completeness.verification, 'tool-verified-count-match')
    assert.equal(artifact.completeness.declaredBy, 'operator:--expect-count')
    assert.equal(artifact.completeness.expectedCount, 4)
    assert.equal(artifact.completeness.observedCount, 4)
    assert.match(String(artifact.completeness.expectSource), /R2 控制台/)
  })

  test('--expect-count 与解析结果不一致 → 退出码 9，且**不产出产物**', () => {
    const file = writeExport('mismatch.json', FOUR)
    const out = join(WORK, 'mismatch-out.json')
    const { code, out: text } = run([
      '--from-console', file, '--bucket', BUCKET,
      '--expect-count', '5', '--expect-source', 'R2 控制台', '--out', out,
    ])
    assert.equal(code, 9, text)
    assert.match(text, /不一致/)
    assert.equal(existsSync(out), false, '数量对不上时绝不能产出可对账的清单')
  })

  test('--expect-count 必须带 --expect-source（数字要可追溯）', () => {
    const file = writeExport('no-source.json', FOUR)
    const { code, out } = run(['--from-console', file, '--bucket', BUCKET, '--expect-count', '4'])
    assert.equal(code, 2, out)
    assert.match(out, /--expect-source/)
  })

  test('JSON 自称分页未走完（IsTruncated / 下一页令牌）→ 退出码 8', () => {
    const truncated = writeRaw(
      'truncated.json',
      JSON.stringify({ Contents: [{ Key: 'a', Size: 1 }], IsTruncated: true, NextContinuationToken: 'tok' }),
    )
    const r1 = run(['--from-console', truncated, '--bucket', BUCKET])
    assert.equal(r1.code, 8, r1.out)
    assert.match(r1.out, /IsTruncated|一页/)

    const token = writeRaw(
      'next-token.json',
      JSON.stringify({ objects: [{ key: 'a', size: 1 }], NextContinuationToken: 'tok' }),
    )
    const r2 = run(['--from-console', token, '--bucket', BUCKET])
    assert.equal(r2.code, 8, r2.out)
    assert.match(r2.out, /下一页令牌/)
  })

  test('JSON 自带总数与行数不符 → 退出码 8（不是完整导出）', () => {
    const file = writeRaw('declared-count.json', JSON.stringify({ objects: [{ key: 'a', size: 1 }], KeyCount: 7 }))
    const { code, out } = run(['--from-console', file, '--bucket', BUCKET])
    assert.equal(code, 8, out)
    assert.match(out, /声明有 7 个对象/)
  })
})

describe('④ 前缀：声明的范围必须与**真实对象集合**一致（业主 Stage 13C.2 §三）', () => {
  test('整桶导出 + --prefix uploads/ → 真的过滤，元数据标记已应用', () => {
    const file = writeExport('whole-bucket.json', FOUR)
    const out = join(WORK, 'prefix-out.json')
    const { code, out: text } = run([
      '--from-console', file, '--bucket', BUCKET, '--prefix', 'uploads/',
      '--expect-count', '3', '--expect-source', 'R2 控制台（uploads/ 下 3 个）',
      '--out', out,
    ])
    assert.equal(code, 0, text)
    const artifact = artifactOf(out)
    assert.deepEqual(artifact.objects.map((o) => o.key), ['uploads/a/1.png', 'uploads/a/2.png', 'uploads/b/3.pdf'])
    assert.equal(artifact.objects.some((o) => o.key === 'top.txt'), false, '前缀之外的对象必须被过滤掉')
    assert.equal(artifact.scope.prefix, 'uploads/')
    assert.equal(artifact.scope.prefixFilterApplied, true)
    assert.equal(artifact.complete, true)
    assert.match(text, /前缀过滤/)
  })

  test('数量按"整桶"报但声明了前缀 → 退出码 9（范围声明与实际不符）', () => {
    const file = writeExport('whole-bucket-2.json', FOUR)
    const { code, out } = run([
      '--from-console', file, '--bucket', BUCKET, '--prefix', 'uploads/',
      '--expect-count', '4', '--expect-source', 'R2 控制台（整桶 4 个）',
    ])
    assert.equal(code, 9, out)
    assert.match(out, /不一致/)
  })

  test('前缀在导出里一个对象都没有 → 拒绝产出空清单', () => {
    const file = writeExport('no-such-prefix.json', FOUR)
    const { code, out } = run(['--from-console', file, '--bucket', BUCKET, '--prefix', 'nothing/'])
    assert.equal(code, 2, out)
    assert.match(out, /没有任何对象/)
  })

  test('没有 --prefix 但对象全在一个顶层目录下 → 提醒可能的范围误声明（只是提示）', () => {
    const file = writeExport('single-segment.json', ['uploads/a/1.png', 'uploads/b/2.png'])
    const out = join(WORK, 'single-segment-out.json')
    const { code, out: text } = run(['--from-console', file, '--bucket', BUCKET, '--out', out])
    assert.equal(code, 0, text)
    assert.match(text, /如果它其实是一个前缀导出/)
    assert.equal(artifactOf(out).scope.prefix, '', '没有声明前缀时不能自己替它声明')
  })
})

describe('⑤ 对比守卫：范围不同的清单不产生差异结论', () => {
  test('桶不同 → 退出码 7；前缀不同 → 退出码 7；都不输出差异', () => {
    const base = writeExport('cmp-base.json', FOUR)
    const baseOut = join(WORK, 'cmp-base-out.json')
    assert.equal(
      run(['--from-console', base, '--bucket', BUCKET, '--expect-count', '4', '--expect-source', 'fixture', '--out', baseOut]).code,
      0,
    )

    const other = writeExport('cmp-other.json', FOUR)
    const byBucket = run([
      '--from-console', other, '--bucket', 'another-bucket', '--expect-count', '4', '--expect-source', 'fixture', '--compare', baseOut,
    ])
    assert.equal(byBucket.code, 7, byBucket.out)
    assert.match(byBucket.out, /桶不一致/)
    assert.equal(DIFF_LINE.test(byBucket.out), false)

    const byPrefix = run([
      '--from-console', other, '--bucket', BUCKET, '--prefix', 'uploads/', '--expect-count', '3',
      '--expect-source', 'fixture', '--compare', baseOut,
    ])
    assert.equal(byPrefix.code, 7, byPrefix.out)
    assert.match(byPrefix.out, /前缀不一致/)
    assert.equal(DIFF_LINE.test(byPrefix.out), false)
  })

  test('范围一致、都完整：正常对比；对象消失 → 退出码 5（交人工判断）', () => {
    const base = writeExport('cmp-base2.json', FOUR)
    const baseOut = join(WORK, 'cmp-base2-out.json')
    assert.equal(
      run(['--from-console', base, '--bucket', BUCKET, '--expect-count', '4', '--expect-source', 'fixture', '--out', baseOut]).code,
      0,
    )

    const fewer = writeExport('cmp-fewer.json', FOUR.slice(1))
    const { code, out } = run([
      '--from-console', fewer, '--bucket', BUCKET, '--expect-count', '3', '--expect-source', 'fixture', '--compare', baseOut,
    ])
    assert.equal(code, 5, out)
    assert.match(out, /消失 1 个/)
    assert.match(out, /必须由人来判断/)
  })

  test('--from-console 不给 --bucket → 退出码 2（范围无法核对）', () => {
    const file = writeExport('needs-bucket.json', FOUR)
    const { code, out } = run(['--from-console', file])
    assert.equal(code, 2, out)
    assert.match(out, /--bucket/)
  })

  test('不是本工具产出的对比文件 → 退出码 6', () => {
    const bogus = writeRaw('bogus.json', JSON.stringify({ objects: toObjects(FOUR) }))
    const file = writeExport('for-bogus.json', FOUR)
    const { code, out } = run(['--from-console', file, '--bucket', BUCKET, '--compare', bogus])
    assert.equal(code, 6, out)
    assert.match(out, /拒绝对比/)
    assert.equal(DIFF_LINE.test(out), false)
  })

  test('产物已存在 → 拒绝覆盖（退出码 4）', () => {
    const file = writeExport('overwrite.json', FOUR)
    const out = join(WORK, 'overwrite-out.json')
    assert.equal(run(['--from-console', file, '--bucket', BUCKET, '--out', out]).code, 0)
    const again = run(['--from-console', file, '--bucket', BUCKET, '--out', out])
    assert.equal(again.code, 4, again.out)
    assert.match(again.out, /拒绝覆盖/)
  })
})

describe('⑥ 完整性判定的纯函数（把规则本身钉住）', () => {
  test('--max 恒不完整；控制台导出默认不完整；数量核对通过才完整', async () => {
    const { decideCompleteness, applyPrefixFilter } = await import('../../scripts/lib/r2-target.mjs')

    assert.equal(decideCompleteness({ source: 'api-list', usedMax: true, expectCount: null, observedCount: 0 }).complete, false)
    assert.equal(decideCompleteness({ source: 'api-list', usedMax: true, expectCount: null, observedCount: 999 }).complete, false)
    assert.equal(decideCompleteness({ source: 'api-list', usedMax: false, expectCount: null, observedCount: 5 }).complete, true)
    assert.equal(
      decideCompleteness({ source: 'console-export', usedMax: false, expectCount: null, observedCount: 5 }).reason,
      'console-export-unverified',
    )
    assert.equal(decideCompleteness({ source: 'console-export', usedMax: false, expectCount: 5, observedCount: 5 }).complete, true)
    assert.equal(decideCompleteness({ source: 'console-export', usedMax: false, expectCount: 6, observedCount: 5 }).complete, false)
    // 有 --max 时，即使操作者给了数量也不放行（抽样就是抽样）
    assert.equal(decideCompleteness({ source: 'console-export', usedMax: true, expectCount: 5, observedCount: 5 }).complete, false)

    const objects = [{ key: 'uploads/a' }, { key: 'other/b' }]
    assert.deepEqual(applyPrefixFilter(objects, '').map((o) => o.key), ['uploads/a', 'other/b'])
    assert.deepEqual(applyPrefixFilter(objects, 'uploads/').map((o) => o.key), ['uploads/a'])
  })
})
