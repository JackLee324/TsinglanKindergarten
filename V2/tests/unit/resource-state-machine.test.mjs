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

  /**
   * 阶段 7 起是**六条**（业主 §1 逐条列出的就是这六条）。
   *
   * 少掉的是 `REJECTED->PENDING_REVIEW`：退回之后不经修改直接再交一次，
   * 审核员会看到一模一样的内容，而业主的流程是「REJECTED → 编辑 → 提交」。
   * 去掉它之后"重新提交"这条路上必然经过一次编辑动作（编辑会把状态变回 DRAFT）。
   */
  test('合法的转换恰好是这些（多一条都算违规）', () => {
    const legal = TRANSITIONS.map((t) => `${t.from}->${t.to}`).sort()
    assert.deepEqual(legal, [
      'DRAFT->PENDING_REVIEW',
      'PENDING_REVIEW->PUBLISHED',
      'PENDING_REVIEW->REJECTED',
      'PUBLISHED->RECALLED',
      'RECALLED->DRAFT',
      'REJECTED->DRAFT',
    ])
  })

  test('业主点名的五种"禁止"逐条断言（不是只断言"表里没有"）', () => {
    // 这五条是业主 §1 明确列出来的禁止项。逐条写出来，失败信息才能直接指认是哪一条放开了。
    for (const [from, to] of [
      ['DRAFT', 'PUBLISHED'], // 跳过审核
      ['DRAFT', 'REJECTED'], // 还没提交就"退回"
      ['PUBLISHED', 'REJECTED'], // 已发布只能撤回，不能退回
      ['REJECTED', 'PUBLISHED'], // 跳过复审
      ['RECALLED', 'PUBLISHED'], // 绕过重新审核
    ]) {
      assert.equal(isLegalTransition(from, to), false, `${from} → ${to} 必须是禁止的`)
    }
  })

  test('退回之后必须经过编辑（REJECTED 不能再直接提交）', () => {
    assert.equal(isLegalTransition('REJECTED', 'PENDING_REVIEW'), false)
    assert.equal(isLegalTransition('REJECTED', 'DRAFT'), true)
    assert.equal(isLegalTransition('DRAFT', 'PENDING_REVIEW'), true)
  })

  test('跳过审核直接发布被拒绝', () => {
    assert.equal(isLegalTransition('DRAFT', 'PUBLISHED'), false)
  })

  test('已发布不能回到待审（必须走撤回）', () => {
    assert.equal(isLegalTransition('PUBLISHED', 'PENDING_REVIEW'), false)
    assert.equal(isLegalTransition('PUBLISHED', 'RECALLED'), true)
  })

  test('穷举 25 种组合：只有表里的 6 种合法', () => {
    let legal = 0
    for (const from of RESOURCE_STATUSES) {
      for (const to of RESOURCE_STATUSES) {
        if (isLegalTransition(from, to)) legal += 1
      }
    }
    assert.equal(legal, 6)
  })

  test('「编辑之后去哪」与转换表必须一致（两处规则不许分叉）', () => {
    // 这条守卫来自一个真实的分叉：转换表里写着 REJECTED→DRAFT / RECALLED→DRAFT
    // （`action: 'update'`，意思是"编辑动作执行这条转换"），但 editOutcomeFor() 当时
    // 让编辑后的状态原地不动 —— 于是表里那两条**永远走不到**，
    // 教师编辑完被退回的资源后卡在 REJECTED，提交按钮永远点不动。
    //
    // 所以：**表里凡是标着 action='update' 的转换，都必须与编辑的去向一致。**
    const editTransitions = TRANSITIONS.filter((t) => t.action === 'update')
    assert.equal(editTransitions.length > 0, true, '至少要有一条"编辑"转换')
    for (const t of editTransitions) {
      assert.equal(
        editOutcomeFor(t.from).status,
        t.to,
        `表里说编辑 ${t.from} 会到 ${t.to}，但 editOutcomeFor 给的是 ${editOutcomeFor(t.from).status}`,
      )
    }

    // PUBLISHED 是**有意的例外**：编辑它等于"升版本 + 回到草稿重走审核"，
    // 不是一条普通的状态机转换，所以表里没有 PUBLISHED→DRAFT，
    // 而是靠 version+1 与 editOutcomeFor 一起表达。
    assert.equal(isLegalTransition('PUBLISHED', 'DRAFT'), false, 'PUBLISHED→DRAFT 不该出现在转换表里')
    assert.deepEqual(editOutcomeFor('PUBLISHED'), { status: 'DRAFT', bumpVersion: true })
    assert.deepEqual(editOutcomeFor('DRAFT'), { status: 'DRAFT', bumpVersion: false })
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
    // 阶段 7：已撤回的资源一旦编辑就回到草稿（表里的 RECALLED→DRAFT）。
    assert.deepEqual(editOutcomeFor('RECALLED'), { status: 'DRAFT', bumpVersion: false })
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
