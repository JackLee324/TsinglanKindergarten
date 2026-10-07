/**
 * tests/unit/v1-mapping.test.mjs —— 迁移映射表本身（阶段 9）
 * ============================================================================
 * 迁移最容易出的两类错，都不是"跑不起来"，而是"跑起来了但悄悄搞错了"：
 *
 *   1. **丢**：某个 V1 的审计动作 / 权限码没有映射，脚本默默跳过；
 *   2. **编**：某个映射指向一个 V2 里并不存在的权限码或状态。
 *
 * 这一份把两张映射表**反过来查**：V1 的 30 个审计动作必须条条有去处，
 * 翻译出来的 V2 权限码必须在 `shared/permissions.ts` 的真实清单里。
 *
 * V1 的 30 个动作名是 `qls_test_0005` 里 `SELECT DISTINCT action` 的真实结果
 * （不是从代码里抄的期望值），所以它同时是一条"词表别漏"的回归线。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { permissions, resourceStatus, auditActions, v1Migration } from '../helpers/modules.mjs'

const {
  FOLDER_TYPE_TO_FOLDER_SLUG,
  STATUS_MAP,
  USER_STATUS_MAP,
  REVIEW_ACTION_MAP,
  REVIEW_TRANSITION,
  AUDIT_ACTION_MAP,
  AUDIT_LEGACY_ACTIONS,
  PERMISSION_MAP,
  DEFAULT_ADMIN_ROLES,
  slugFromV1Code,
  buildReviewTimeline,
  isV1PasswordFormat,
} = v1Migration

const { PERMISSION_CODES } = permissions
const { RESOURCE_STATUSES } = resourceStatus

/** V1 里真实出现过的 30 个审计动作（来自 V1 库的实测值）。 */
const V1_ACTUAL_ACTIONS = [
  'login', 'login_failed', 'password_changed', 'permission_change', 'permission_denied',
  'teacher_create', 'teacher_update',
  'directory_create', 'directory_delete', 'directory_rename', 'directory_update',
  'resource_upload', 'resource_edit', 'resource_delete', 'resource_restore', 'resource_purge',
  'resource_download', 'resource_download_denied', 'resource_submit_review', 'resource_approve',
  'resource_recall', 'resource_file_register', 'resource_directory_assign',
  'file_validation_rejected', 'data_export',
  'mfa_challenge_issued', 'mfa_enrolled', 'mfa_enabled', 'mfa_failed', 'mfa_success',
]

describe('状态映射（V1 小写 → V2 大写）', () => {
  test('V1 的 5 个状态都有去处，且落在 V2 的真实状态清单里', () => {
    assert.deepEqual(Object.keys(STATUS_MAP).sort(), [
      'draft', 'pending_review', 'published', 'recalled', 'rejected',
    ])
    for (const [v1, v2] of Object.entries(STATUS_MAP)) {
      assert.ok(RESOURCE_STATUSES.includes(v2), `V1「${v1}」映射到了不存在的 V2 状态「${v2}」`)
    }
  })

  test('映射是单射：不会有两个 V1 状态挤到同一个 V2 状态', () => {
    const values = Object.values(STATUS_MAP)
    assert.equal(new Set(values).size, values.length)
  })

  test('用户状态只映射到 active / inactive（V2 的 CHECK 就只有这两个值）', () => {
    assert.deepEqual(Object.values(USER_STATUS_MAP).sort(), ['active', 'inactive'])
  })
})

describe('审核动作与状态机', () => {
  test('三个审核动作映射到 V2 的状态机动作名', () => {
    assert.deepEqual(REVIEW_ACTION_MAP, {
      approve: 'review.approve',
      reject: 'review.reject',
      recall: 'review.recall',
    })
  })

  test('每个动作的 from/to 都是 V2 的真实状态', () => {
    for (const [action, [from, to]] of Object.entries(REVIEW_TRANSITION)) {
      assert.ok(RESOURCE_STATUSES.includes(from), `${action} 的 from_status 非法：${from}`)
      assert.ok(RESOURCE_STATUSES.includes(to), `${action} 的 to_status 非法：${to}`)
      assert.notEqual(from, to, `${action} 不该原地不动`)
    }
  })
})

describe('审计动作映射：一条都不许丢', () => {
  test('V1 实测的 30 个动作，每个都有去处', () => {
    assert.equal(V1_ACTUAL_ACTIONS.length, 30)
    for (const action of V1_ACTUAL_ACTIONS) {
      const mapped = AUDIT_ACTION_MAP[action]
      const legacy = AUDIT_LEGACY_ACTIONS[action]
      // 三种去处：翻译成 V2 动作 / 登记为 V1 历史动作（保原名 + 中文标签）/
      // 都没有 → 那就是"丢了"，必须红。
      assert.ok(
        mapped !== undefined || legacy !== undefined,
        `V1 动作「${action}」既没有映射也没有登记为历史动作 —— 它会在迁移里被丢掉`,
      )
      assert.equal(mapped !== undefined && legacy !== undefined, false, `「${action}」同时出现在两张表里`)
    }
  })

  test('映射出来的都是 V2 自己的审计动作（不能凭空造动作名）', () => {
    for (const [v1, v2] of Object.entries(AUDIT_ACTION_MAP)) {
      assert.ok(v2 in auditActions.AUDIT_ACTIONS, `V1「${v1}」映射到了 V2 不认识的审计动作「${v2}」`)
    }
  })

  test('历史动作标签是中文，而且写明是 V1 历史', () => {
    for (const [action, label] of Object.entries(AUDIT_LEGACY_ACTIONS)) {
      assert.match(label, /[\u4e00-\u9fa5]/, `「${action}」的标签不是中文`)
      assert.match(label, /V1 历史/, `「${action}」的标签要说明它是历史动作`)
    }
  })
})

describe('权限码映射（只用于 V1 的显式授权）', () => {
  test('翻译出来的都是 V2 的真实权限码', () => {
    for (const [v1, v2] of Object.entries(PERMISSION_MAP)) {
      assert.ok(PERMISSION_CODES.includes(v2), `V1「${v1}」翻译成了不存在的 V2 权限「${v2}」`)
    }
  })

  test('MFA / 安全 / 存储运维这类 V2 没有的概念**不**在映射表里', () => {
    for (const banned of [
      'mfa.manage_self', 'security.events', 'system.health', 'session.view',
      'session.revoke', 'account.force_logout', 'audit.export',
    ]) {
      assert.equal(banned in PERMISSION_MAP, false, `「${banned}」在 V2 里没有对应能力，不该被翻译`)
    }
  })

  test('默认的管理员角色就是 V1 的两个最高角色', () => {
    assert.deepEqual(DEFAULT_ADMIN_ROLES, ['super_admin', 'principal'])
  })
})

describe('V1 的 folder_type → V2 资料夹（用 V1 自己的分类表）', () => {
  test('V1 里真实出现过的三个值都要有资料夹', () => {
    // 实测：courseware=245，weekly_plans=80，curriculum_outline=23
    assert.equal(FOLDER_TYPE_TO_FOLDER_SLUG.courseware, 'resources')
    assert.equal(FOLDER_TYPE_TO_FOLDER_SLUG.weekly_plans, 'lesson')
    assert.equal(FOLDER_TYPE_TO_FOLDER_SLUG.curriculum_outline, 'outline')
  })

  test('另外三个登记值：两个有对应，research_archive **没有**（不猜）', () => {
    assert.equal(FOLDER_TYPE_TO_FOLDER_SLUG.materials, 'resources')
    assert.equal(FOLDER_TYPE_TO_FOLDER_SLUG.observation, 'assessment')
    assert.equal(
      'research_archive' in FOLDER_TYPE_TO_FOLDER_SLUG,
      false,
      'research_archive 在 PDF 里没有对应资料夹，V1 自己拒绝为它写目录 —— 迁移也不许编一个',
    )
  })

  test('落点必须是 V2 真实存在的资料夹 slug', () => {
    const v2FolderSlugs = ['outline', 'lesson', 'resources', 'assessment']
    for (const [folderType, slug] of Object.entries(FOLDER_TYPE_TO_FOLDER_SLUG)) {
      assert.ok(v2FolderSlugs.includes(slug), `${folderType} 映射到了不存在的资料夹 ${slug}`)
    }
  })
})

describe('目录 slug 规整', () => {
  test('V1 的 code 末段去掉主体前缀，与 V2 的 seed slug 对得上', () => {
    assert.equal(slugFromV1Code('prek:virtue_outline', '课程大纲'), 'outline')
    assert.equal(slugFromV1Code('prek:virtue_lesson', '教学详案'), 'lesson')
    assert.equal(slugFromV1Code('prek:virtue_resource', '教学资源'), 'resources')
    assert.equal(slugFromV1Code('k:chinese:arts_assessment', '考核评估'), 'assessment')
    assert.equal(slugFromV1Code('growth:l1:safety:plan:disease', '传染病识别与防治'), 'disease')
  })

  test('规整结果是确定性的（重跑不会建出两个节点）', () => {
    assert.equal(slugFromV1Code('root:edu', '教育教学'), slugFromV1Code('root:edu', '教育教学'))
  })

  test('中文名也生成得出合法 slug，且符合 V2 的 slug 正则', () => {
    const slug = slugFromV1Code('custom:活动', '活动')
    assert.match(slug, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
  })

  test('不同节点不会撞成同一个 slug', () => {
    const slugs = [
      slugFromV1Code('prek:virtue_outline', '课程大纲'),
      slugFromV1Code('prek:virtue_lesson', '教学详案'),
      slugFromV1Code('prek:virtue_resource', '教学资源'),
      slugFromV1Code('prek:virtue_assessment', '考核评估'),
    ]
    assert.equal(new Set(slugs).size, 4)
  })
})

describe('审核时间线：审核记录出走审核，审计补提交', () => {
  const at = (min) => new Date(Date.UTC(2026, 0, 1, 0, min, 0))

  test('提交 + 通过：DRAFT → PENDING_REVIEW → PUBLISHED', () => {
    const rows = buildReviewTimeline(
      [{ id: 'r1', resource_id: 'res1', reviewer_id: 'u1', action: 'approve', comment: null, created_at: at(30) }],
      [{ id: 'a1', resource_id: 'res1', teacher_id: 'u2', action: 'resource_submit_review', created_at: at(10) }],
    )
    const res1 = rows.filter((r) => r.resourceId === 'res1').sort((a, b) => a.at - b.at)
    assert.equal(res1.length, 2)
    assert.deepEqual(res1.map((r) => [r.action, r.from, r.to]), [
      ['submit', 'DRAFT', 'PENDING_REVIEW'],
      ['review.approve', 'PENDING_REVIEW', 'PUBLISHED'],
    ])
    assert.equal(res1[0].source, 'audit_logs', '提交只能来自审计（V1 的审核表不记提交）')
    assert.equal(res1[1].source, 'review_records')
  })

  test('一个审批不会被记两次（审计里也有 resource_approve）', () => {
    // 审计里那条 resource_approve 由 buildReviewTimeline 之外的人负责搬进审计表，
    // 这里断言的是：**审核记录只由 review_records 产生**，不与审计重复。
    const rows = buildReviewTimeline(
      [{ id: 'r1', resource_id: 'res1', reviewer_id: 'u1', action: 'approve', comment: null, created_at: at(30) }],
      [],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].v1Id, 'r1')
  })

  test('退回 → 再提交 → 再通过：四段都在，顺序正确', () => {
    const rows = buildReviewTimeline(
      [
        { id: 'r1', resource_id: 'res1', reviewer_id: 'u1', action: 'reject', comment: '周次不对', created_at: at(20) },
        { id: 'r2', resource_id: 'res1', reviewer_id: 'u1', action: 'approve', comment: null, created_at: at(50) },
      ],
      [
        { id: 'a1', resource_id: 'res1', teacher_id: 'u2', action: 'resource_submit_review', created_at: at(10) },
        { id: 'a2', resource_id: 'res1', teacher_id: 'u2', action: 'resource_submit_review', created_at: at(40) },
      ],
    ).sort((a, b) => a.at - b.at)

    assert.deepEqual(rows.map((r) => [r.action, r.from, r.to]), [
      ['submit', 'DRAFT', 'PENDING_REVIEW'],
      ['review.reject', 'PENDING_REVIEW', 'REJECTED'],
      ['submit', 'DRAFT', 'PENDING_REVIEW'],
      ['review.approve', 'PENDING_REVIEW', 'PUBLISHED'],
    ])
    // 四段都是合法的 V2 转换，没有一条需要人工确认。
    assert.equal(rows.every((r) => r.needsReview === false), true)
    // 中间那一步"退回后老师又编辑了"V1 不记录，按状态机推出来并**标明**。
    assert.equal(rows[2].inferredEdit, true)
    assert.match(rows[2].note, /未记录/)
  })

  test('撤回是独立动作：PUBLISHED → RECALLED，不是"退回"', () => {
    const rows = buildReviewTimeline(
      [
        { id: 'r1', resource_id: 'res1', reviewer_id: 'u1', action: 'approve', comment: null, created_at: at(20) },
        { id: 'r2', resource_id: 'res1', reviewer_id: 'u1', action: 'recall', comment: null, created_at: at(30) },
      ],
      // V1 的提交只在审计里 —— 真实数据的形状就是这样，夹具也得是。
      [{ id: 'a1', resource_id: 'res1', teacher_id: 'u2', action: 'resource_submit_review', created_at: at(10) }],
    ).sort((a, b) => a.at - b.at)
    assert.deepEqual(rows.map((r) => [r.action, r.from, r.to]), [
      ['submit', 'DRAFT', 'PENDING_REVIEW'],
      ['review.approve', 'PENDING_REVIEW', 'PUBLISHED'],
      ['review.recall', 'PUBLISHED', 'RECALLED'],
    ])
    assert.equal(rows[2].action === 'review.reject', false, '撤回不能被记成退回')
    assert.equal(rows.every((r) => r.needsReview === false), true)
  })

  test('对不上的时间线**不丢**，改成标记待人工确认', () => {
    const rows = buildReviewTimeline(
      [{ id: 'r1', resource_id: 'res1', reviewer_id: 'u1', action: 'approve', comment: null, created_at: at(10) }],
      [],
    )
    assert.equal(rows.length, 1, '记录必须还在')
    assert.equal(rows[0].needsReview, true)
    assert.match(rows[0].note, /时间线|期望/)
  })

  test('V2 里没有的动作也不丢（保留原名 + 标记）', () => {
    const rows = buildReviewTimeline(
      [{ id: 'r1', resource_id: 'res1', reviewer_id: 'u1', action: 'archive', comment: null, created_at: at(10) }],
      [],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].needsReview, true)
    assert.equal(rows[0].rawAction, 'archive')
  })
})

test('占位口令不会被误认成 V1 格式', () => {
  assert.equal(isV1PasswordFormat('scrypt$16384$8$1$abc$def'), false)
})
