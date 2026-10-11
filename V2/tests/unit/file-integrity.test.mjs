/**
 * tests/unit/file-integrity.test.mjs —— "AI 不许碰原始文件"的可执行判据
 * ============================================================================
 * 业主 Stage 15 §二.10 / §三.11：上线前后用只读检查对比资源、文件记录、
 * storage key、文件哈希与对象清单；不一致就停止发布。
 * 这份测试盯住**比对规则本身**，因为规则写错会出两种坏结果：
 *   漏判（真的被改写了却说"通过"）或误判（正常上传新增文件被当成漂移）。
 *
 * 最要紧的一条：**新增允许，改写/删除绝不允许**。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { diffBaselines, findMissingObjects, buildBaseline } from '../../scripts/lib/file-integrity.mjs'

const base = (over = {}) =>
  buildBaseline({
    takenAt: '2026-10-11T00:00:00.000Z',
    database: { redacted: 'postgresql://u@h:5432/db', local: false },
    storage: { bucket: 'b', endpointHost: 'h' },
    counts: { resources: 1, resource_files: 1, directories: 1, upload_tickets: 0, storage_orphans: 0 },
    resources: [{ id: 'r1', title: '资源一', status: 'PUBLISHED', directoryId: 'd1', updatedAt: null }],
    files: [
      {
        id: 'f1',
        resourceId: 'r1',
        storageKey: 'resources/r1/abc-file.pdf',
        fileName: 'file.pdf',
        mimeType: 'application/pdf',
        size: '1000',
        sha256: 'aa',
      },
    ],
    objects: [{ key: 'resources/r1/abc-file.pdf', size: '1000', etag: 'e1' }],
    ...over,
  })

describe('① 没有变化 → 通过', () => {
  test('同一份基线自比：0 漂移', () => {
    const { drift } = diffBaselines(base(), base())
    assert.deepEqual(drift, [])
  })
})

describe('② 正常业务变化（变多）→ 不算漂移', () => {
  test('新增资源/文件/对象：允许', () => {
    const after = base({
      counts: { resources: 2, resource_files: 2, directories: 1, upload_tickets: 1, storage_orphans: 0 },
      resources: [
        { id: 'r1', title: '资源一', status: 'PUBLISHED', directoryId: 'd1', updatedAt: null },
        { id: 'r2', title: '新资源', status: 'DRAFT', directoryId: 'd1', updatedAt: null },
      ],
      files: [
        { id: 'f1', resourceId: 'r1', storageKey: 'resources/r1/abc-file.pdf', fileName: 'file.pdf', mimeType: 'application/pdf', size: '1000', sha256: 'aa' },
        { id: 'f2', resourceId: 'r2', storageKey: 'resources/r2/xyz-new.pdf', fileName: 'new.pdf', mimeType: 'application/pdf', size: '50', sha256: 'bb' },
      ],
      objects: [
        { key: 'resources/r1/abc-file.pdf', size: '1000', etag: 'e1' },
        { key: 'resources/r2/xyz-new.pdf', size: '50', etag: 'e2' },
      ],
    })
    const { drift, added } = diffBaselines(base(), after)
    assert.deepEqual(drift, [])
    assert.deepEqual(added, { resources: 1, files: 1, objects: 1 })
  })

  test('资源状态变化（发布/撤回）只记提示，不判漂移', () => {
    const after = base({ resources: [{ id: 'r1', title: '资源一', status: 'RECALLED', directoryId: 'd1', updatedAt: null }] })
    const { drift, notes } = diffBaselines(base(), after)
    assert.deepEqual(drift, [])
    assert.equal(notes.length, 1)
    assert.equal(notes[0].kind, 'resource-status-changed')
  })
})

describe('③ 改写或删除 → 必须判漂移（这是 AI 改动不许出现的形态）', () => {
  const cases = [
    ['删除文件记录', base({ files: [], counts: { resources: 1, resource_files: 0, directories: 1 } }), 'file-row-removed'],
    ['storage key 被改', base({ files: [{ id: 'f1', resourceId: 'r1', storageKey: 'resources/r1/MOVED.pdf', fileName: 'file.pdf', mimeType: 'application/pdf', size: '1000', sha256: 'aa' }] }), 'storage-key-changed'],
    ['文件字节数变了', base({ files: [{ id: 'f1', resourceId: 'r1', storageKey: 'resources/r1/abc-file.pdf', fileName: 'file.pdf', mimeType: 'application/pdf', size: '2000', sha256: 'aa' }] }), 'file-size-changed'],
    ['文件哈希变了', base({ files: [{ id: 'f1', resourceId: 'r1', storageKey: 'resources/r1/abc-file.pdf', fileName: 'file.pdf', mimeType: 'application/pdf', size: '1000', sha256: 'zz' }] }), 'file-sha256-changed'],
    ['文件被挂到别的资源', base({ files: [{ id: 'f1', resourceId: 'r9', storageKey: 'resources/r1/abc-file.pdf', fileName: 'file.pdf', mimeType: 'application/pdf', size: '1000', sha256: 'aa' }] }), 'file-resource-changed'],
    ['桶里对象消失', base({ objects: [] }), 'object-removed'],
    ['桶里对象被改写（ETag 变）', base({ objects: [{ key: 'resources/r1/abc-file.pdf', size: '1000', etag: 'e2' }] }), 'object-etag-changed'],
    ['桶里对象大小变了', base({ objects: [{ key: 'resources/r1/abc-file.pdf', size: '999', etag: 'e1' }] }), 'object-size-changed'],
    ['资源被删', base({ resources: [], counts: { resources: 0, resource_files: 1, directories: 1 } }), 'resource-removed'],
    ['资源的所属目录被改', base({ resources: [{ id: 'r1', title: '资源一', status: 'PUBLISHED', directoryId: 'd2', updatedAt: null }] }), 'resource-directory-changed'],
    ['计数变少', base({ counts: { resources: 0, resource_files: 1, directories: 1 } }), 'count-decreased'],
  ]

  for (const [label, after, expectedKind] of cases) {
    test(`${label} → ${expectedKind}`, () => {
      const { drift } = diffBaselines(base(), after)
      assert.equal(
        drift.some((d) => d.kind === expectedKind),
        true,
        `应当报出 ${expectedKind}，实际：${JSON.stringify(drift)}`,
      )
    })
  }
})

describe('④ 数据库引用的对象必须在桶里', () => {
  test('引用存在但对象缺失 → 直接列出来', () => {
    const missing = findMissingObjects(
      [{ id: 'f1', resourceId: 'r1', storageKey: 'k1' }],
      [{ key: 'k2', size: '1', etag: 'x' }],
    )
    assert.equal(missing.length, 1)
    assert.equal(missing[0].storageKey, 'k1')
  })

  test('比对时也会把它算作漂移', () => {
    const { drift } = diffBaselines(base(), base({ objects: [] }))
    assert.equal(drift.some((d) => d.kind === 'referenced-object-missing'), true)
  })
})
