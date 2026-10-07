/**
 * 状态机是资源生命周期的唯一规则来源。
 * 这里穷举**所有** from→to 组合，因此"某条不该存在的转换被放行"不可能悄悄发生。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { filePolicy, resourceStatus } from '../helpers/modules.mjs'
const {
  RESOURCE_STATUSES,
  TRANSITIONS,
  isLegalTransition,
  allowedNextStatuses,
  editOutcomeFor,
} = resourceStatus

/**
 * 预览策略现在在 `shared/file-policy.ts`（「能不能预览」是**文件**的属性，
 * 不是资源状态的属性，而且必须与"允许上传哪些类型"读同一张表）。
 * 这一条仍然留在本文件里，因为它同样是"只有一份真相"的守卫。
 */
const { isPreviewable, isPreviewableMime, PREVIEW_UNSUPPORTED_MESSAGE, PREVIEWABLE_MIME_TYPES } = filePolicy

describe('资源状态机', () => {
  test('恰好五个状态', () => {
    assert.deepEqual([...RESOURCE_STATUSES], [
      'DRAFT',
      'PENDING_REVIEW',
      'PUBLISHED',
      'REJECTED',
      'RECALLED',
    ])
  })

  test('合法的转换恰好是这些（多一条都算违规）', () => {
    const legal = TRANSITIONS.map((t) => `${t.from}->${t.to}`).sort()
    assert.deepEqual(legal, [
      'DRAFT->PENDING_REVIEW',
      'PENDING_REVIEW->PUBLISHED',
      'PENDING_REVIEW->REJECTED',
      'PUBLISHED->RECALLED',
      'RECALLED->DRAFT',
      'REJECTED->DRAFT',
      'REJECTED->PENDING_REVIEW',
    ])
  })

  test('跳过审核直接发布被拒绝', () => {
    assert.equal(isLegalTransition('DRAFT', 'PUBLISHED'), false)
  })

  test('已发布不能回到待审（必须走撤回）', () => {
    assert.equal(isLegalTransition('PUBLISHED', 'PENDING_REVIEW'), false)
    assert.equal(isLegalTransition('PUBLISHED', 'RECALLED'), true)
  })

  test('穷举 25 种组合：只有表里的 7 种合法', () => {
    let legal = 0
    for (const from of RESOURCE_STATUSES) {
      for (const to of RESOURCE_STATUSES) {
        if (isLegalTransition(from, to)) legal += 1
      }
    }
    assert.equal(legal, 7)
  })

  test('退回必须带原因，其他转换不要求', () => {
    const reject = TRANSITIONS.find((t) => t.action === 'review.reject')
    const others = TRANSITIONS.filter((t) => t.action !== 'review.reject')
    assert.equal(reject.requireComment, true)
    for (const t of others) assert.equal(t.requireComment, false)
  })

  test('撤回是独立动作，绝不是 review.reject', () => {
    const recall = TRANSITIONS.find((t) => t.to === 'RECALLED')
    assert.ok(recall)
    assert.equal(recall.action, 'review.recall')
    assert.notEqual(recall.action, 'review.reject')
  })

  test('编辑已发布资源 → 升版本并回到草稿（不原地覆盖）', () => {
    assert.deepEqual(editOutcomeFor('PUBLISHED'), { status: 'DRAFT', bumpVersion: true })
    assert.deepEqual(editOutcomeFor('DRAFT'), { status: 'DRAFT', bumpVersion: false })
    assert.deepEqual(editOutcomeFor('RECALLED'), { status: 'RECALLED', bumpVersion: false })
  })

  test('从草稿出发只有一条路', () => {
    assert.deepEqual([...allowedNextStatuses('DRAFT')], ['PENDING_REVIEW'])
  })

  test('预览白名单：PDF / JPG / PNG / TXT，且提示语是业主指定的原文', () => {
    // 现在是**推导**出来的（来自 ALLOWED_FILE_TYPES 里 previewable 的那些），
    // 所以顺序随类型表的顺序（pdf → png/jpg/jpeg → txt）。
    // 关键性质没变：只有这四类能预览，Office 与 ZIP 不在里面。
    assert.deepEqual([...PREVIEWABLE_MIME_TYPES].sort(), [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'text/plain',
    ])
    assert.equal(isPreviewableMime('application/pdf'), true)
    assert.equal(isPreviewableMime('image/png'), true)
    assert.equal(isPreviewableMime('text/plain'), true)
    assert.equal(
      isPreviewableMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      false,
    )
    assert.equal(isPreviewableMime('application/zip'), false)
    // 以**扩展名**为准：一个 zip 声明成 image/png 也不能走图片预览。
    assert.equal(isPreviewable('课件.zip', 'image/png'), false)
    assert.equal(isPreviewable('照片.png', 'image/png'), true)
    assert.equal(PREVIEW_UNSUPPORTED_MESSAGE, '此文件类型暂不支持在线预览，请下载查看。')
  })
})
