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
 * 13C.4 又补了一层：**身份类型必须与来源匹配**。产物是磁盘上的文件，
 * 把 API 清单的身份块改成 `operator-declared` + 一个标签，比较逻辑就会改走
 * "标签相同即同一存储"那条路，**绕过指纹校验**。所以自洽校验现在也管身份：
 * `api-list` 必须是指纹（格式合法、端点与 scope 一致），控制台导出只能
 * 是"操作者声明（带标签、无指纹）"或"诚实的未知"（不带任何标签/指纹）。
 *
 * 13C.5 又把端点本身钉死：`api-list` 清单的 `scope.endpointHost` 与
 * `storageIdentity.endpointHost` 必须**都非空、都合法、规范化后一致** ——
 * 只比"两个字段是否相等"的话，把两者一起改成 `null`/空串就能蒙混过关。
 *
 * 前两节是纯函数级（合成产物，能精确构造"跨账号同桶名"这种现实中不容易复现的情形），
 * 第三节跑真脚本、真产物，第四节**先起本机 S3 产出真 API 清单、再篡改它的身份块**，
 * 验证比较确实被拒且不输出差异。
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
    // assertComparable 现在要求两份都是**完整产物**（它内部统一做自洽校验）
    const out = assertComparable(a, b)
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'identity-mismatch')
    assert.match(out.reason, /存储指纹不同/)
  })

  test('同一端点、不同凭据（换账号）→ 指纹不同 → 拒绝', () => {
    const a = makeArtifact({ accessKeyId: 'AKA' })
    const b = makeArtifact({ accessKeyId: 'AKB' })
    assert.notEqual(a.storageIdentity.fingerprint, b.storageIdentity.fingerprint)
    assert.equal(assertComparable(a, b).kind, 'identity-mismatch')
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

    const out = assertComparable(consoleArtifact, apiArtifact)
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'identity-unknown')
    assert.match(out.reason, /存储身份未知/)
    assert.match(out.reason, /--storage-id/, '要给出可执行的对齐方式')
  })

  test('控制台导出 + API 清单：API 那份带同一个 --storage-id → 允许比较', () => {
    const consoleArtifact = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'cf-account-tsinglan' })
    const apiArtifact = makeArtifact({ declaredId: 'cf-account-tsinglan' })
    assert.equal(assertComparable(consoleArtifact, apiArtifact).ok, true)
  })

  test('控制台导出 + API 清单：只有一边有 --storage-id → 仍然拒绝', () => {
    const consoleArtifact = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'cf-account-tsinglan' })
    const apiArtifact = makeArtifact({ declaredId: null })
    assert.equal(assertComparable(consoleArtifact, apiArtifact).kind, 'identity-unknown')
  })

  test('两份控制台导出：--storage-id 不同 → 拒绝', () => {
    const a = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'account-a' })
    const b = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'account-b' })
    assert.equal(assertComparable(a, b).kind, 'identity-mismatch')
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
    const out = assertComparable(tampered, makeArtifact())
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'inconsistent')
    assert.match(out.reason, /前一份清单不可用于对账/)
  })

  test('前一份清单不完整 → 拒绝（incomplete）', () => {
    const partial = makeArtifact()
    partial.complete = false
    partial.completeness.complete = false
    partial.completeness.usableForProductionComparison = false
    assert.equal(assertComparable(partial, makeArtifact()).kind, 'incomplete')
  })
})

describe('②bis 身份类型必须与来源匹配（业主 Stage 13C.4）', () => {
  test('合法的 API 指纹清单通过自洽检查', () => {
    assert.equal(assertArtifactSelfConsistent(makeArtifact()).ok, true)
  })

  test('API 清单的身份被改成 operator-declared（哪怕补上 declaredId）→ 拒绝', () => {
    const a = makeArtifact()
    a.storageIdentity = { ...a.storageIdentity, kind: 'operator-declared', declaredId: 'sneaky-label' }
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /api-endpoint-fingerprint/)
    // 比较也必须因此被拒（不是只在纯函数里拦）
    assert.equal(assertComparable(a, makeArtifact()).ok, false)
  })

  test('API 清单的身份被改成 unknown → 拒绝', () => {
    const a = makeArtifact()
    a.storageIdentity = { kind: 'unknown', fingerprint: null, declaredId: null, endpointHost: null }
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /api-endpoint-fingerprint/)
  })

  test('API 清单指纹缺失或格式不对 → 拒绝', () => {
    for (const bad of [null, '', 'sha256:', 'sha256:0123', 'md5:0123456789abcdef', 'sha256:0123456789ABCDEF', 'sha256:0123456789abcdef0']) {
      const a = makeArtifact()
      a.storageIdentity = { ...a.storageIdentity, fingerprint: bad }
      const out = assertArtifactSelfConsistent(a)
      assert.equal(out.ok, false, `指纹 "${String(bad)}" 应当被拒绝`)
      assert.match(out.reason, /指纹/)
    }
  })

  test('API 身份记录的端点与 scope.endpointHost 不一致 → 拒绝', () => {
    const a = makeArtifact()
    a.storageIdentity = { ...a.storageIdentity, endpointHost: 'someone-else.r2.cloudflarestorage.com' }
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /不一致/)
  })

  test('控制台清单带非空标签（无指纹）→ 通过', () => {
    const a = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'cf-account-tsinglan' })
    assert.equal(a.storageIdentity.kind, 'operator-declared')
    assert.equal(assertArtifactSelfConsistent(a).ok, true)
  })

  test('控制台清单声明 operator-declared 却没有标签 → 拒绝', () => {
    const a = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'x' })
    a.storageIdentity = { ...a.storageIdentity, declaredId: null }
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /declaredId/)
  })

  test('控制台清单被伪装成 API 指纹类型 → 拒绝', () => {
    const a = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'x' })
    a.storageIdentity = { ...a.storageIdentity, kind: 'api-endpoint-fingerprint', fingerprint: 'sha256:0123456789abcdef' }
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /不能伪装/)
  })

  test('unknown 身份必须"真的未知"（不得夹带标签或指纹）', () => {
    const withLabel = makeArtifact({ method: 'console-export', endpointHost: null })
    withLabel.storageIdentity = { kind: 'unknown', fingerprint: null, declaredId: 'sneaky', endpointHost: null }
    assert.equal(assertArtifactSelfConsistent(withLabel).ok, false)

    const withFingerprint = makeArtifact({ method: 'console-export', endpointHost: null })
    withFingerprint.storageIdentity = { kind: 'unknown', fingerprint: 'sha256:0123456789abcdef', declaredId: null, endpointHost: null }
    assert.equal(assertArtifactSelfConsistent(withFingerprint).ok, false)

    // 真正的未知：允许存在（它会在比较阶段被拒），字段必须干净
    const realUnknown = makeArtifact({ method: 'console-export', endpointHost: null })
    assert.deepEqual(realUnknown.storageIdentity, { kind: 'unknown', fingerprint: null, declaredId: null, endpointHost: null })
    assert.equal(assertArtifactSelfConsistent(realUnknown).ok, true)
  })

  test('身份块整体缺失 → 拒绝', () => {
    const a = makeArtifact()
    delete a.storageIdentity
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /storageIdentity/)
  })
})

describe('②ter API 清单的端点必须非空、合法、一致（业主 Stage 13C.5）', () => {
  test('两个端点都合法且一致 → 通过（有效 API 端点 + 有效指纹）', () => {
    const a = makeArtifact()
    assert.equal(a.scope.endpointHost, 'acct-a.r2.cloudflarestorage.com')
    assert.equal(assertArtifactSelfConsistent(a).ok, true)
  })

  test('两个端点**同时为 null** → 拒绝（不能靠"都空所以相等"混过去）', () => {
    const a = makeArtifact()
    a.scope.endpointHost = null
    a.storageIdentity = { ...a.storageIdentity, endpointHost: null }
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /endpointHost/)
    assert.match(out.reason, /不合法/)
  })

  test('两个端点**同时为空字符串** → 拒绝', () => {
    const a = makeArtifact()
    a.scope.endpointHost = ''
    a.storageIdentity = { ...a.storageIdentity, endpointHost: '' }
    assert.equal(assertArtifactSelfConsistent(a).ok, false)
  })

  test('两个端点**同时为纯空白** → 拒绝', () => {
    const a = makeArtifact()
    a.scope.endpointHost = '   '
    a.storageIdentity = { ...a.storageIdentity, endpointHost: '\t \n' }
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /为空/)
  })

  test('两个端点**格式都非法** → 拒绝', () => {
    for (const bad of ['not a host!!', 'https://', 'host:99999', '-bad-.example.com', 'http://:8080', 'a b c']) {
      const a = makeArtifact()
      a.scope.endpointHost = bad
      a.storageIdentity = { ...a.storageIdentity, endpointHost: bad }
      const out = assertArtifactSelfConsistent(a)
      assert.equal(out.ok, false, `端点 "${bad}" 应当被拒绝`)
      assert.match(out.reason, /端点/)
    }
  })

  test('只有一个端点为空 → 同样拒绝（两种情况都测）', () => {
    const a = makeArtifact()
    a.scope.endpointHost = null
    assert.equal(assertArtifactSelfConsistent(a).ok, false, 'scope 为空 → 拒绝')

    const b = makeArtifact()
    b.storageIdentity = { ...b.storageIdentity, endpointHost: null }
    assert.equal(assertArtifactSelfConsistent(b).ok, false, '身份为空 → 拒绝')
  })

  test('身份端点与 scope 端点不一致 → 保持拒绝', () => {
    const a = makeArtifact()
    a.storageIdentity = { ...a.storageIdentity, endpointHost: 'other.r2.cloudflarestorage.com' }
    const out = assertArtifactSelfConsistent(a)
    assert.equal(out.ok, false)
    assert.match(out.reason, /不一致/)
  })

  test('大小写/端口写法不同但规范化后相同 → 视为一致（同一套端点规范）', () => {
    const a = makeArtifact()
    a.scope.endpointHost = 'ACCT-A.r2.CloudflareStorage.com'
    a.storageIdentity = { ...a.storageIdentity, endpointHost: 'acct-a.r2.cloudflarestorage.com' }
    assert.equal(assertArtifactSelfConsistent(a).ok, true)
  })

  test('端点检查没有放宽指纹要求（指纹仍需格式合法）', () => {
    const a = makeArtifact()
    a.storageIdentity = { ...a.storageIdentity, fingerprint: null }
    assert.equal(assertArtifactSelfConsistent(a).ok, false)
  })

  test('console-export 的空端点不受影响（它的身份靠操作者声明）', () => {
    const declared = makeArtifact({ method: 'console-export', endpointHost: null, declaredId: 'cf-account-tsinglan' })
    assert.equal(declared.scope.endpointHost, null)
    assert.equal(assertArtifactSelfConsistent(declared).ok, true)

    const unknown = makeArtifact({ method: 'console-export', endpointHost: null })
    assert.equal(assertArtifactSelfConsistent(unknown).ok, true)
  })

  test('assertComparable：当前侧被篡改为空端点时同样拒绝（不只管前一份）', () => {
    const previous = makeArtifact()
    const current = makeArtifact()
    current.scope.endpointHost = null
    current.storageIdentity = { ...current.storageIdentity, endpointHost: null }
    const out = assertComparable(previous, current)
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'inconsistent')
    assert.match(out.reason, /当前清单不可用于对账/)
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

  test('被篡改身份块的清单产物不能参与比较（走真比较脚本，拒绝且不输出差异）', () => {
    /*
      业主 Stage 13C.4 §二 9：要"修改已生成的真实清单产物，再通过实际比较脚本
      验证退出码和输出"，而不是只测一个孤立纯函数。

      这里的产物用**生产代码路径**生成（`buildInventoryArtifact` + `buildStorageIdentity`，
      与脚本里用的是同一对函数），写到磁盘后逐种篡改，再交给**真脚本**
      （`scripts/r2-inventory.mjs --compare`）跑：比较、自洽校验、退出码、输出全是真实行为。

      ⚠️ 这个文件不再自己起 S3 后端：单元测试是**按文件并行**跑的，
        两个文件同时占用固定的测试端口会互相打断；真后端的实时列举由
        `r2-inventory-completeness.test.mjs` 覆盖（那份是唯一占用后端端口的）。
    */
    const real = makeArtifact({ declaredId: 'id-a' })
    real.source = 'ListObjectsV2 endpoint=acct-a.r2.cloudflarestorage.com bucket=tsinglan-curriculum'
    assert.equal(real.scope.method, 'api-list')
    assert.equal(real.storageIdentity.kind, 'api-endpoint-fingerprint')
    assert.equal(assertArtifactSelfConsistent(real).ok, true, '真实产物本身必须自洽')

    const current = makeArtifact({ declaredId: 'id-a' })
    const currentPath = join(WORK, 'api-current.json')
    writeFileSync(currentPath, JSON.stringify(current), 'utf8')

    const tampers = [
      ['身份类型改成 operator-declared', 6, (a) => { a.storageIdentity.kind = 'operator-declared'; a.storageIdentity.declaredId = 'fake' }],
      ['身份类型改成 unknown', 6, (a) => { a.storageIdentity = { kind: 'unknown', fingerprint: null, declaredId: null, endpointHost: null } }],
      ['指纹被删掉', 6, (a) => { a.storageIdentity.fingerprint = null }],
      ['指纹格式被改坏', 6, (a) => { a.storageIdentity.fingerprint = 'sha256:zzzz' }],
      ['身份端点与 scope 不一致', 6, (a) => { a.storageIdentity.endpointHost = 'other.r2.cloudflarestorage.com' }],
      ['scope 端点被改到别处', 6, (a) => { a.scope.endpointHost = 'other.r2.cloudflarestorage.com' }],
    ]
    /*
      注：这里当前清单是**控制台导出**，与 api 清单互比时按规则比的是
      `--storage-id` 声明（"操作者确认这是同一个存储"），所以"指纹被换成另一个"
      在这条路径上不会触发拒绝 —— 那是 api↔api 的判据，已由第 ① 节的
      "两个不同账号、同一个桶名" 与 "同端点换凭据" 两条覆盖。
    */

    for (const [label, expectedCode, mutate] of tampers) {
      const copy = JSON.parse(JSON.stringify(real))
      mutate(copy)
      const tamperedPath = join(WORK, 'api-real.json')
      writeFileSync(tamperedPath, JSON.stringify(copy), 'utf8')

      const res = run([
        '--from-console', EXPORT, '--bucket', BUCKET,
        '--expect-count', String(KEYS.length), '--expect-source', 'fixture',
        '--storage-id', 'id-a', '--compare', tamperedPath,
      ])
      assert.equal(res.code, expectedCode, `${label}：应当退出码 ${expectedCode}，实际 ${res.code}\n${res.out}`)
      assert.match(res.out, /拒绝对比/, label)
      assert.equal(DIFF.test(res.out), false, `${label}：拒绝时不得输出任何差异结论`)
    }

    /*
      13C.5：把两个端点字段**一起**改成空值 —— 只比"字段是否相等"的写法会放过它。
      这些用例走的是真比较入口（`--compare`），不是孤立函数。
    */
    const clearedEndpoints = [
      ['两个端点同时改成 null', (a) => { a.scope.endpointHost = null; a.storageIdentity.endpointHost = null }],
      ['两个端点同时改成空字符串', (a) => { a.scope.endpointHost = ''; a.storageIdentity.endpointHost = '' }],
      ['两个端点同时改成纯空白', (a) => { a.scope.endpointHost = '  '; a.storageIdentity.endpointHost = '\t' }],
      ['两个端点同时改成非法格式', (a) => { a.scope.endpointHost = 'not a host!!'; a.storageIdentity.endpointHost = 'not a host!!' }],
    ]
    for (const [label, mutate] of clearedEndpoints) {
      const copy = JSON.parse(JSON.stringify(real))
      mutate(copy)
      const tamperedPath = join(WORK, 'api-endpoints-cleared.json')
      writeFileSync(tamperedPath, JSON.stringify(copy), 'utf8')

      const res = run([
        '--from-console', EXPORT, '--bucket', BUCKET,
        '--expect-count', String(KEYS.length), '--expect-source', 'fixture',
        '--storage-id', 'id-a', '--compare', tamperedPath,
      ])
      assert.equal(res.code, 6, `${label}：应当退出码 6，实际 ${res.code}\n${res.out}`)
      assert.match(res.out, /拒绝对比/, label)
      assert.match(res.out, /端点/, `${label}：拒绝原因要提到端点\n${res.out}`)
      assert.equal(DIFF.test(res.out), false, `${label}：拒绝时不得输出任何差异结论`)
    }

    // 对照：同身份、都自洽时比较正常进行（证明前面的拒绝不是因为"比不了"）
    const ok = run([
      '--from-console', EXPORT, '--bucket', BUCKET,
      '--expect-count', String(KEYS.length), '--expect-source', 'fixture',
      '--storage-id', 'id-a', '--compare', currentPath,
    ])
    assert.equal(ok.code, 0, ok.out)
    assert.match(ok.out, /消失 0 个 \/ 新增 0 个/)
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
