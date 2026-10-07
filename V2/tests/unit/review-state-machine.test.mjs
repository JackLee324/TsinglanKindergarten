/**
 * tests/unit/review-state-machine.test.mjs —— 审核工作流的规则（业主 Stage 7 §1）
 * ============================================================================
 * `resource-state-machine.test.mjs` 测的是**资源状态机本身**（状态、转换、编辑去向）。
 * 这一份测的是**审核工作流**在它之上的那几条业务规则：
 *
 *   · 谁能对哪个状态做什么动作（教师 vs 审核员）；
 *   · 「通过并发布」是一步，不是两步（业主 §14）；
 *   · 退回**必须**有原因（业主 §6），其余转换不要求；
 *   · 每个动作 → 审计动作名的映射只有一处（业主 §20）；
 *   · 界面的中文标签从同一份定义来，不手工同步。
 *
 * 全部是纯函数层面的断言 —— 它们回答的是"规则是什么"，
 * 而接口层"规则真的生效了"由 integration 套件回答。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resourceStatus, auditActions } from '../helpers/modules.mjs'

const {
  RESOURCE_STATUSES,
  RESOURCE_STATUS_LABEL,
  TRANSITIONS,
  ACTION_AUDIT_NAME,
  findTransition,
  isLegalTransition,
  allowedNextStatuses,
  editOutcomeFor,
} = resourceStatus

const { AUDIT_ACTIONS } = auditActions

describe('六个状态，五个中文标签', () => {
  test('状态清单固定', () => {
    assert.deepEqual([...RESOURCE_STATUSES], [
      'DRAFT',
      'PENDING_REVIEW',
      'PUBLISHED',
      'REJECTED',
      'RECALLED',
    ])
  })

  test('每个状态都有界面文案（界面不许自己写）', () => {
    assert.deepEqual(RESOURCE_STATUS_LABEL, {
      DRAFT: '草稿',
      PENDING_REVIEW: '待审核',
      PUBLISHED: '已发布',
      REJECTED: '已退回',
      RECALLED: '已撤回',
    })
  })
})

describe('动作与权限', () => {
  test('提交审核只能从草稿出发，且要求所有权', () => {
    const submit = TRANSITIONS.filter((t) => t.action === 'submit')
    assert.deepEqual(
      submit.map((t) => `${t.from}->${t.to}`),
      ['DRAFT->PENDING_REVIEW'],
      '只有草稿能提交；REJECTED / RECALLED 必须先编辑（业主 §13）',
    )
    for (const t of submit) {
      assert.equal(t.permission, 'resource.submit')
      assert.equal(t.requireOwner, true, '提交必须是自己上传的资源')
    }
  })

  test('通过 = 发布，是同一件事（业主 §14），不做成两步', () => {
    const approve = TRANSITIONS.find((t) => t.action === 'review.approve')
    assert.equal(approve.from, 'PENDING_REVIEW')
    assert.equal(approve.to, 'PUBLISHED', '通过之后直接就是已发布，没有中间态')
    assert.equal(approve.requireOwner, false, '审核的是别人的东西')
    // 状态清单里**没有**"审核通过但未发布"这种中间状态 —— 这是业主明确不要的复杂度。
    assert.equal(
      RESOURCE_STATUSES.some((s) => /APPROVED|REVIEWED/.test(s)),
      false,
    )
  })

  test('退回只在待审核时可用，且必须带原因', () => {
    const reject = TRANSITIONS.find((t) => t.action === 'review.reject')
    assert.equal(reject.from, 'PENDING_REVIEW')
    assert.equal(reject.to, 'REJECTED')
    assert.equal(reject.requireComment, true, '业主 §6：退回必须填审核意见')
    const others = TRANSITIONS.filter((t) => t.action !== 'review.reject')
    for (const t of others) {
      assert.equal(t.requireComment, false, `${t.action} 不该要求原因`)
    }
  })

  test('撤回是独立动作：不等于退回，也不写进退回原因', () => {
    const recall = TRANSITIONS.find((t) => t.action === 'review.recall')
    assert.equal(recall.from, 'PUBLISHED')
    assert.equal(recall.to, 'RECALLED')
    assert.equal(recall.requireComment, false, '撤回原因可选')
    assert.notEqual(recall.action, 'review.reject', '撤回绝不能复用 reject')
    assert.equal(recall.requireOwner, true, '撤回属于作者（管理员走统一的绕过）')
  })
})

describe('每个状态"接下来能去哪"符合业务流程', () => {
  test('草稿 → 只有提交审核', () => {
    assert.deepEqual([...allowedNextStatuses('DRAFT')], ['PENDING_REVIEW'])
  })

  test('待审核 → 通过（已发布）或退回', () => {
    assert.deepEqual([...allowedNextStatuses('PENDING_REVIEW')].sort(), ['PUBLISHED', 'REJECTED'])
  })

  test('已发布 → 只能撤回', () => {
    assert.deepEqual([...allowedNextStatuses('PUBLISHED')], ['RECALLED'])
  })

  test('已退回 / 已撤回 → 回到草稿（编辑即回草稿）', () => {
    assert.deepEqual([...allowedNextStatuses('REJECTED')], ['DRAFT'])
    assert.deepEqual([...allowedNextStatuses('RECALLED')], ['DRAFT'])
    assert.deepEqual(editOutcomeFor('REJECTED').status, 'DRAFT')
    assert.deepEqual(editOutcomeFor('RECALLED').status, 'DRAFT')
  })

  test('每个状态都有出路（不存在走不出去的终态）', () => {
    for (const status of RESOURCE_STATUSES) {
      assert.equal(
        allowedNextStatuses(status).length > 0,
        true,
        `${status} 没有任何出路 —— 资源会卡死在这里`,
      )
    }
  })

  test('完整闭环：草稿 → 待审 → 退回 → 草稿 → 待审 → 发布 → 撤回 → 草稿', () => {
    const chain = [
      ['DRAFT', 'PENDING_REVIEW'],
      ['PENDING_REVIEW', 'REJECTED'],
      ['REJECTED', 'DRAFT'],
      ['DRAFT', 'PENDING_REVIEW'],
      ['PENDING_REVIEW', 'PUBLISHED'],
      ['PUBLISHED', 'RECALLED'],
      ['RECALLED', 'DRAFT'],
    ]
    for (const [from, to] of chain) {
      assert.equal(isLegalTransition(from, to), true, `${from} → ${to} 应当是允许的`)
    }
  })
})

describe('审计动作名（业主 §20）', () => {
  test('业主点名的四个动作都在审计清单里', () => {
    for (const action of [
      'resource.submit_review',
      'resource.approve',
      'resource.reject',
      'resource.recall',
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, action),
        true,
        `审计清单里缺少 ${action}`,
      )
    }
  })

  test('状态机动作 → 审计动作只有一份映射，且覆盖每个动作', () => {
    const mapped = Object.keys(ACTION_AUDIT_NAME).sort()
    const actions = [...new Set(TRANSITIONS.map((t) => t.action))].sort()
    for (const action of actions) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(ACTION_AUDIT_NAME, action),
        true,
        `${action} 没有对应的审计动作名`,
      )
    }
    assert.equal(mapped.includes('submit'), true)
    assert.deepEqual(ACTION_AUDIT_NAME.submit, 'resource.submit_review')
    assert.deepEqual(ACTION_AUDIT_NAME['review.approve'], 'resource.approve')
    assert.deepEqual(ACTION_AUDIT_NAME['review.reject'], 'resource.reject')
    assert.deepEqual(ACTION_AUDIT_NAME['review.recall'], 'resource.recall')
  })

  test('三个 review.* 动作名互相区分（业主：审核操作不要混用）', () => {
    const names = ['review.approve', 'review.reject', 'review.recall']
    assert.equal(new Set(names).size, 3)
    // 它们对应的审计动作也必须各不相同 —— 否则审计里"通过"和"撤回"会长得一样。
    const auditNames = names.map((n) => ACTION_AUDIT_NAME[n])
    assert.equal(new Set(auditNames).size, 3, `审计名重复了：${auditNames.join('、')}`)
  })
})

describe('转换表里不存在"双重动作"', () => {
  test('同一个 from→to 只有一条规则（不会出现两条互相矛盾的规则）', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}->${t.to}`)
    assert.equal(new Set(keys).size, keys.length, `有重复的转换：${keys.join('、')}`)
  })

  test('findTransition 对表外的组合返回 undefined（调用方据此 409）', () => {
    assert.equal(findTransition('DRAFT', 'PUBLISHED'), undefined)
    assert.equal(findTransition('REJECTED', 'PENDING_REVIEW'), undefined)
    assert.notEqual(findTransition('DRAFT', 'PENDING_REVIEW'), undefined)
  })
})
