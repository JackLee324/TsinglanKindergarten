/**
 * tests/unit/r2-inventory-identity.test.mjs —— 存储身份与旧清单字段自洽
 *                    （业主 Stage 13C.3 §B / §C）
 * ============================================================================
 * 两条防线，各自对应一种"看起来没问题"的假通过：
 *
 *   §B 存储身份：桶名在 R2 里**只在账号内唯一**，跨账号完全可以重名。
 *      以前 `assertComparable` 只在两边 `endpointHost` 都非空时才比对它，
 *      而控制台导出的 `endpointHost` 是 `null` —— 于是一份控制台清单和一份
 *      实时清单，仅凭"桶名 + 前缀一样"就能通过范围检查。那比出来的
 *      "消失/新增"可能是**两个不同账号**的对比，是纯粹的假事故。
 *
 *   §C 旧清单自洽：产物是磁盘上的文件，可能被手改、可能是旧版本工具写的。
 *      只看 `complete === true` 等于"相信文件自己说它没问题"。
 *      这里要求 `readOnly` / `complete` / `usableForProductionComparison` /
 *      `verification` / `reason` / 计数 / `summary.count` / `scope` **互相印证**。
 *
 * 前两节是纯函数级（合成产物，能精确构造"跨账号同桶名"这种现实中不容易复现的情形），
 * 第三节跑真脚本、真产物。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertArtifactSelfConsistent,
  assertComparable,
  buildInventoryArtifact,
  buildStorageIdentity,
} from '../../scripts/lib/r2-target.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'r2-inventory.mjs')
const WORK = mkdtempSync(join(tmpdir(), 'r2-id-'))
const BUCKET = 'tsinglan-curriculum'
const KEYS = ['uploads/a/1.png', 'top.txt']

/** 造一份"合格"的清单产物（默认实时列举来源）。 */
function makeArtifact({
  method = 'api-list',
  bucket = BUCKET,
  prefix = '',
  endpointHost = 'acct-a.r2.cloudflarestorage.com',
  accessKeyId = 'AKA',
  declaredId = null,
  objects = KEYS.map((key, i) => ({ key, size: 10 + i })),
} = {}) {
  const completeness =
    method === 'api-list'
      ? { complete: true, reason: 'listed-all-pages', verification: 'tool-listed-all-pages', expectedCount: null, observedCount: objects.length, declaredBy: null, expectSource: null }
      : { complete: true, reason: 'console-export-count-verified', verification: 'tool-verified-count-match', expectedCount: objects.length, observedCount: objects.length, declaredBy: 'operator:--expect-count', expectSource: 'R2 控制台' }
  return buildInventoryArtifact({
    generatedAt: '2026-10-10T00:00:00.000Z',
    source: 'fixture',
    objects,
    scope: { method, endpointHost, bucket, prefix, prefixFilterApplied: prefix !== '' },
    completeness,
    identity: buildStorageIdentity({ method, endpointHost, accessKeyId, declaredId }),
  })
}

describe('① 存储身份：桶名相同不足以证明是同一个存储', () => {
  test('两个不同账号、同一个桶名 → 拒绝（identity-mismatch）', () => {
    const a = makeArtifact({ endpointHost: 'acct-a.r2.cloudflarestorage.com', accessKeyId: 'AKA' })
    const b = makeArtifact({ endpointHost: 'acct-b.r2.cloudflarestorage.com', accessKeyId: 'AKB' })
    assert.equal(a.scope.bucket, b.scope.bucket, '前提：桶名故意一样')
    const out = assertComparable(a, { complete: b.complete, scope: b.scope, storageIdentity: b.storageIdentity })
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'identity-mismatch')
    assert.match(out.reason, /存储指纹不同/)
  })

  test('同一端点、不同凭据（换账号）→ 指纹不同 → 拒绝', () => {
    const a = makeArtifact({ accessKeyId: 'AKA' })
    const b = makeArtifact({ accessKeyId: 'AKB' })
    assert.notEqual(a.storageIdentity.fingerprint, b.storageIdentity.fingerprint)
    assert.equal(
      assertComparable(a, { complete: b.complete, scope: b.scope, storageIdentity: b.storageIdentity }).kind,
      'identity-mismatch',
    )
  })

  test('指纹里不含凭据原文（只落 sha256 截断）', () => {
    const a = makeArtifact({ accessKeyId: 'super-secret-access-key' })
    const text = JSON.stringify(a)
    assert.equal(text.includes('super-secret-access-key'), false, '产物里不能出现 Access Key 原文')
    assert.match(a.storageIdentity.fingerprint, /^sha256:[0-9a-f]{16}$/)
  })

  test('控制台导出无 --storage-id → 身份未知 → 拒绝（哪怕桶名/前缀都一样）', () => {
    const consoleArtifact = makeArtifact({ method: 'console-export', endpointHost: null })
    const apiArtifact = makeArtifact()
    assert.equal(consoleArtifact.storageIdentity.kind, 'unknown')

    const out = assertComparable(consoleArtifact, {
      complete: apiArtifact.complete,
      scope: apiArtifact.scope,
      storageIdentity: apiArtifact.storageIdentity,
    })
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'identity-unknown')
    assert.match(out.reason, /存储身份未知/)
    assert.match(out.reason, /--storage-id/, '要给出可执行的对齐方式')
  })

  test('控制台导出 + API 清单：API 那份带同一个 --storage-id → 允许比较', () => {
    const consoleArtifact = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'cf-account-tsinglan' })
    const apiArtifact = makeArtifact({ declaredId: 'cf-account-tsinglan' })
    assert.equal(
      assertComparable(consoleArtifact, {
        complete: apiArtifact.complete,
        scope: apiArtifact.scope,
        storageIdentity: apiArtifact.storageIdentity,
      }).ok,
      true,
    )
  })

  test('控制台导出 + API 清单：只有一边有 --storage-id → 仍然拒绝', () => {
    const consoleArtifact = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'cf-account-tsinglan' })
    const apiArtifact = makeArtifact({ declaredId: null })
    const out = assertComparable(consoleArtifact, {
      complete: apiArtifact.complete,
      scope: apiArtifact.scope,
      storageIdentity: apiArtifact.storageIdentity,
    })
    assert.equal(out.kind, 'identity-unknown')
  })

  test('两份控制台导出：--storage-id 不同 → 拒绝', () => {
    const a = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'account-a' })
    const b = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'account-b' })
    const out = assertComparable(a, { complete: b.complete, scope: b.scope, storageIdentity: b.storageIdentity })
    assert.equal(out.kind, 'identity-mismatch')
  })
})

describe('② 旧清单的自洽校验（§C）：只看 complete 是不够的', () => {
  test('合格产物通过自洽校验', () => {
    assert.equal(assertArtifactSelfConsistent(makeArtifact()).ok, true)
    assert.equal(
      assertArtifactSelfConsistent(makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'x' })).ok,
      true,
    )
  })

  test('被手改的字段一律被抓住', () => {
    const cases = [
      ['readOnly 被去掉', (a) => { delete a.readOnly }],
      ['complete 改成 false', (a) => { a.complete = false }],
      ['complete 与 completeness.complete 矛盾', (a) => { a.completeness.complete = false }],
      ['usableForProductionComparison 改成 false', (a) => { a.completeness.usableForProductionComparison = false }],
      ['verification 与来源不符', (a) => { a.completeness.verification = 'none' }],
      ['reason 与 verification 不自洽', (a) => { a.completeness.reason = 'truncated-by-max' }],
      ['summary.count 与 objects 不符', (a) => { a.summary.count = a.objects.length + 1 }],
      ['scope.bucket 被清空', (a) => { a.scope.bucket = '' }],
      ['scope.method 未知', (a) => { a.scope.method = 'something-else' }],
      ['控制台清单缺 expectSource', (a) => { a.completeness.expectSource = '' }],
      ['控制台清单 expectedCount 与行数不符', (a) => { a.completeness.expectedCount = 99 }],
      ['objects 不是数组', (a) => { a.objects = 'nope' }],
    ]
    for (const [label, mutate] of cases) {
      const artifact = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'x' })
      mutate(artifact)
      const out = assertArtifactSelfConsistent(artifact)
      assert.equal(out.ok, false, `${label} 应当被拒绝：${JSON.stringify(out)}`)
    }
  })

  test('前一份清单不自洽 → assertComparable 直接拒绝，且不进入范围/身份判断', () => {
    const tampered = makeArtifact()
    tampered.completeness.verification = 'none'
    const current = { complete: true, scope: makeArtifact().scope, storageIdentity: makeArtifact().storageIdentity }
    const out = assertComparable(tampered, current)
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'inconsistent')
    assert.match(out.reason, /前一份清单不可用于对账/)
  })

  test('前一份清单不完整 → 拒绝（incomplete）', () => {
    const partial = makeArtifact()
    partial.complete = false
    partial.completeness.complete = false
    partial.completeness.usableForProductionComparison = false
    const current = { complete: true, scope: partial.scope, storageIdentity: partial.storageIdentity }
    assert.equal(assertComparable(partial, current).kind, 'incomplete')
  })
})

describe('③ 脚本级：身份与自洽守卫真的在退出码上生效', () => {
  const EXPORT = join(WORK, 'two.json')
  const run = (args) => {
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
  }
  const DIFF = /消失 \d+ 个|新增 \d+ 个/

  before(() => {
    writeFileSync(EXPORT, JSON.stringify(KEYS.map((key, i) => ({ key, size: 10 + i }))), 'utf8')
  })

  test('两份都没有 --storage-id → 退出码 6（身份未知），且不输出差异', () => {
    const a = join(WORK, 's-a.json')
    assert.equal(run(['--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--out', a]).code, 0)
    const { code, out } = run(['--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--compare', a])
    assert.equal(code, 6, out)
    assert.match(out, /存储身份未知/)
    assert.equal(DIFF.test(out), false)
  })

  test('两边 --storage-id 一致 → 比较通过（退出码 0）', () => {
    const a = join(WORK, 's-b.json')
    assert.equal(
      run(['--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--storage-id', 'prod-r2', '--out', a]).code,
      0,
    )
    const { code, out } = run([
      '--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--storage-id', 'prod-r2', '--compare', a,
    ])
    assert.equal(code, 0, out)
    assert.match(out, /消失 0 个 \/ 新增 0 个/)
  })

  test('--storage-id 不同 → 退出码 7，且不输出差异', () => {
    const a = join(WORK, 's-c.json')
    assert.equal(
      run(['--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--storage-id', 'prod-r2', '--out', a]).code,
      0,
    )
    const { code, out } = run([
      '--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--storage-id', 'other-r2', '--compare', a,
    ])
    assert.equal(code, 7, out)
    assert.equal(DIFF.test(out), false)
  })

  test('被改过的旧产物（completeness 自相矛盾）→ 退出码 6，且不输出差异', () => {
    const a = join(WORK, 's-d.json')
    assert.equal(
      run(['--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--storage-id', 'prod-r2', '--out', a]).code,
      0,
    )
    const artifact = JSON.parse(readFileSync(a, 'utf8'))
    artifact.completeness.verification = 'none' // 手改：假装完整
    const tampered = join(WORK, 's-d-tampered.json')
    writeFileSync(tampered, JSON.stringify(artifact), 'utf8')

    const { code, out } = run([
      '--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--storage-id', 'prod-r2', '--compare', tampered,
    ])
    assert.equal(code, 6, out)
    assert.match(out, /前一份清单不可用于对账/)
    assert.equal(DIFF.test(out), false)
  })

  test('产物里带着存储身份（可审计），且不含任何凭据', () => {
    const a = join(WORK, 's-e.json')
    run([
      '--from-console', EXPORT, '--bucket', BUCKET, '--expect-count', '2', '--expect-source', 'fixture', '--storage-id', 'prod-r2', '--out', a,
    ])
    const artifact = JSON.parse(readFileSync(a, 'utf8'))
    assert.deepEqual(Object.keys(artifact.storageIdentity).sort(), ['declaredId', 'endpointHost', 'fingerprint', 'kind'])
    assert.equal(artifact.storageIdentity.kind, 'operator-declared')
    assert.equal(artifact.storageIdentity.declaredId, 'prod-r2')
    assert.equal(artifact.storageIdentity.fingerprint, null)
  })
})
