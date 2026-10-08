/**
 * tests/integration/migration-directory-resolution.test.mjs
 * ============================================================================
 * 业主 Stage 12B §6/§7 指定的回归：用**真实生产快照**逐条验证资源落位。
 *
 *   fixture：V2/.migration/prod-exports/prod-export-20261008_031823.ndjson
 *            sha256 b1a2e0e8b3fec3c1b2c24ade483f97aff7810e81bea41786fcdd395c511b708e
 *
 * 为什么不用开发库/人造数据：阶段 9 的预演就是拿"看起来很像"的本机数据跑的，
 * 结果与生产**资源 id 零重叠**（349 vs 348、共有 0 条）。这类测试一旦用假数据，
 * 它证明的只是"假数据能过"，而不是"生产数据能过"。
 *
 * 它**离线**跑：只读快照 + 一个纯函数 resolver，不连数据库、不写任何东西。
 * 断言的是：
 *   · 349 条全部精确落位（0 UNRESOLVED、0 fallback）
 *   · 覆盖业主点名的每一类 program / subject / sub_subject / folder_type
 *   · 落位目标**必须是资料夹**（不是 Section）—— 否则前端不渲染资源列表
 *   · 未知 folder_type / 缺 subject / 错 sub_subject → 明确 UNRESOLVED，且**不回退**
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FOLDER_KIND_BY_TYPE,
  buildDirectoryCodeIndex,
  candidateCodes,
  resolveLegacyResourceDirectory,
} from '../../scripts/lib/resolve-legacy-directory.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SNAPSHOT = join(ROOT, '.migration', 'prod-exports', 'prod-export-20261008_031823.ndjson')
const EXPECTED_SHA = 'b1a2e0e8b3fec3c1b2c24ade483f97aff7810e81bea41786fcdd395c511b708e'

if (!existsSync(SNAPSHOT)) {
  throw new Error(
    `缺少生产快照 fixture：${SNAPSHOT}\n` +
      '它是本阶段唯一的生产数据源（见 docs/V1_PRODUCTION_SOURCE_FREEZE.md）。' +
      '没有它就不要跑这条回归 —— 用假数据跑等于没跑。',
  )
}

const bytes = readFileSync(SNAPSHOT)
const actualSha = createHash('sha256').update(bytes).digest('hex')

const tables = new Map()
for (const line of bytes.toString('utf8').split('\n')) {
  if (line.trim() === '') continue
  const obj = JSON.parse(line)
  if (obj.kind !== 'row') continue
  const list = tables.get(obj.table) ?? []
  list.push(obj.row)
  tables.set(obj.table, list)
}
const resources = tables.get('resources') ?? []
const directories = tables.get('directories') ?? []

const byId = new Map(directories.map((d) => [String(d.id), d]))
const pathOf = (node) => {
  const parts = []
  let cur = node
  let guard = 0
  while (cur && guard++ < 20) {
    parts.unshift(String(cur.slug ?? cur.name ?? '?'))
    cur = cur.parent_id ? byId.get(String(cur.parent_id)) : null
  }
  return parts.join('/')
}
const index = buildDirectoryCodeIndex(
  directories.map((d) => ({ id: d.id, code: d.code, name: d.name, path: pathOf(d) })),
)
const resolve = (r) => resolveLegacyResourceDirectory({ ...r }, index)

describe('生产快照 fixture 本身可信', () => {
  test('sha256 与冻结文档一致（快照没有被替换过）', () => {
    assert.equal(actualSha, EXPECTED_SHA, '快照 sha256 与 docs/V1_PRODUCTION_SOURCE_FREEZE.md 不一致')
  })

  test('规模：349 资源 / 69 目录 / 24 账号（与生产一致）', () => {
    assert.equal(resources.length, 349, '资源总数')
    assert.equal(directories.length, 69, '目录总数')
    assert.equal((tables.get('teachers') ?? []).length, 24, '账号总数')
  })
})

describe('349 条资源逐条落位', () => {
  test('全部精确落位：0 UNRESOLVED、0 fallback、且目标必须是资料夹', () => {
    const unresolved = []
    const notFolder = []
    const codeCounts = new Map()
    for (const r of resources) {
      const got = resolve({
        program: r.program,
        subject: r.subject,
        sub_subject: r.sub_subject,
        folder_type: r.folder_type,
      })
      if (!got.resolved) {
        unresolved.push(`${r.id}（${r.program}/${r.subject}/${r.sub_subject ?? '—'}/${r.folder_type}）：${got.reason}`)
        continue
      }
      const node = byId.get(String(got.directoryId))
      if (node?.type !== 'folder') notFolder.push(`${r.id} → ${got.code}（type=${node?.type}）`)
      codeCounts.set(got.code, (codeCounts.get(got.code) ?? 0) + 1)
    }
    assert.deepEqual(unresolved, [], `有 ${unresolved.length} 条无法唯一确定目录：\n${unresolved.slice(0, 10).join('\n')}`)
    assert.deepEqual(
      notFolder,
      [],
      `有 ${notFolder.length} 条落到了非资料夹节点（前端不会渲染资源列表）：\n${notFolder.slice(0, 10).join('\n')}`,
    )
    assert.equal([...codeCounts.values()].reduce((a, b) => a + b, 0), 349, '落位总数必须等于 349')
  })

  test('落位分布与生产自带的 folder_type 分布吻合', () => {
    const kindOf = (ft) => FOLDER_KIND_BY_TYPE[ft]
    const byKind = new Map()
    for (const r of resources) {
      const kind = kindOf(r.folder_type)
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
    }
    const placed = new Map()
    for (const r of resources) {
      const got = resolve({
        program: r.program,
        subject: r.subject,
        sub_subject: r.sub_subject,
        folder_type: r.folder_type,
      })
      const kind = got.code?.split('_').pop() ?? '?'
      placed.set(kind, (placed.get(kind) ?? 0) + 1)
    }
    for (const [kind, n] of byKind) {
      assert.equal(placed.get(kind) ?? 0, n, `kind=${kind} 的资源数应当与 folder_type 口径一致`)
    }
    // 生产数据里的实际取值（冻结文档 §2）
    assert.equal(placed.get('resource') ?? 0, 245, '教学资源 245（= courseware）')
    assert.equal(placed.get('lesson') ?? 0, 80, '教学详案 80（= weekly_plans）')
    assert.equal(placed.get('outline') ?? 0, 24, '课程大纲 24（= curriculum_outline）')
  })
})

describe('业主点名的每一类都要覆盖到', () => {
  const cases = [
    ['Pre-K / 美德 / 课程大纲', { program: 'prek', subject: 'virtue', sub_subject: null, folder_type: 'curriculum_outline' }, 'prek:virtue_outline'],
    ['Pre-K / 美德 / 教学详案', { program: 'prek', subject: 'virtue', sub_subject: null, folder_type: 'weekly_plans' }, 'prek:virtue_lesson'],
    ['Pre-K / 美德 / 教学资源', { program: 'prek', subject: 'virtue', sub_subject: null, folder_type: 'courseware' }, 'prek:virtue_resource'],
    ['Pre-K / 美德 / 考核评估', { program: 'prek', subject: 'virtue', sub_subject: null, folder_type: 'observation' }, 'prek:virtue_assessment'],
    ['Pre-K / 蒙特梭利 / 教学资源', { program: 'prek', subject: 'montessori', sub_subject: 'practical_life', folder_type: 'courseware' }, 'prek:montessori_resource'],
    ['K / 英文 / 教学详案', { program: 'k', subject: 'english', sub_subject: null, folder_type: 'weekly_plans' }, 'k:english_lesson'],
    ['K / 中文 / 绘本阅读 / 教学资源', { program: 'k', subject: 'chinese', sub_subject: 'reading', folder_type: 'courseware' }, 'k:chinese:reading_resource'],
    ['K / 中文 / 古诗 / 教学资源', { program: 'k', subject: 'chinese', sub_subject: 'poetry', folder_type: 'courseware' }, 'k:chinese:poetry_resource'],
    ['K / 中文 / STEM / 教学资源', { program: 'k', subject: 'chinese', sub_subject: 'stem', folder_type: 'courseware' }, 'k:chinese:stem_resource'],
    ['K / 中文 / 美育 / 教学资源', { program: 'k', subject: 'chinese', sub_subject: 'arts', folder_type: 'courseware' }, 'k:chinese:arts_resource'],
    ['材料类 → 教学资源（V1 分类表如此）', { program: 'prek', subject: 'virtue', sub_subject: null, folder_type: 'materials' }, 'prek:virtue_resource'],
  ]
  for (const [title, input, expectedCode] of cases) {
    test(`${title} → ${expectedCode}`, () => {
      const got = resolve(input)
      assert.equal(got.resolved, true, `应当精确落位：${got.reason}`)
      assert.equal(got.code, expectedCode)
      const node = byId.get(String(got.directoryId))
      assert.equal(node.type, 'folder', '目标必须是资料夹节点')
      assert.equal(got.path !== null, true, '要能给出 V2 路径（报告里要用）')
    })
  }

  test('sub_subject 那一级存在时**必须**用它，不能被科目层顶掉', () => {
    // 两个候选都有，但 K/中文 这一支只有带 sub_subject 的那种
    const withSub = candidateCodes({ program: 'k', subject: 'chinese', sub_subject: 'reading', folder_type: 'courseware' })
    assert.deepEqual(withSub, ['k:chinese:reading_resource', 'k:chinese_resource'])
    const got = resolve({ program: 'k', subject: 'chinese', sub_subject: 'reading', folder_type: 'courseware' })
    assert.equal(got.code, 'k:chinese:reading_resource', '必须落到带 sub_subject 的那个资料夹')
  })
})

describe('无法唯一确定时：明确 UNRESOLVED，绝不回退', () => {
  test('未知 folder_type（research_archive）→ UNRESOLVED 且不返回任何目录', () => {
    const got = resolve({ program: 'prek', subject: 'virtue', sub_subject: null, folder_type: 'research_archive' })
    assert.equal(got.resolved, false)
    assert.equal(got.directoryId, null, '不允许给一个"替身"目录')
    assert.match(got.reason, /没有对应/)
  })

  test('缺 subject → UNRESOLVED', () => {
    const got = resolve({ program: 'prek', subject: '', sub_subject: null, folder_type: 'courseware' })
    assert.equal(got.resolved, false)
    assert.equal(got.directoryId, null)
  })

  test('错的 sub_subject → 先试带它的候选，再试科目层；两个都没有就 UNRESOLVED（不回退科目 Section）', () => {
    const got = resolve({ program: 'k', subject: 'chinese', sub_subject: 'does_not_exist', folder_type: 'courseware' })
    // k:chinese 这一支没有科目层资料夹 → 只能 UNRESOLVED
    assert.equal(got.resolved, false)
    assert.equal(got.directoryId, null)
    assert.deepEqual(got.tried, ['k:chinese:does_not_exist_resource', 'k:chinese_resource'])
  })

  test('科目层只有 Section（没有资料夹）时也 UNRESOLVED —— 绝不留到 Section 上', () => {
    const got = resolve({ program: 'growth', subject: 'l1', sub_subject: null, folder_type: 'courseware' })
    assert.equal(got.resolved, false)
    assert.equal(got.directoryId, null)
  })
})
