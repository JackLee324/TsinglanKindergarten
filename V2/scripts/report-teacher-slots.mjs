#!/usr/bin/env node
/**
 * scripts/report-teacher-slots.mjs —— 教师账号**名额**与现有账号的差异报告（**只读**）
 * ============================================================================
 * 业主 Stage 14A §2.4 的要求：迁移材料里是 **24 个账号**，新规划是 **39 个岗位名额** ——
 * 必须出一份核对报告，说清"哪些名额还没绑定、哪些现有账号等待匹配、有没有重复或冲突"。
 * 并且明确：**39 个名额 ≠ 39 个已确认的真实教师账号**。
 *
 * 三条硬边界（与 `propose-directory-grants.mjs` 同源）：
 *   · **不连数据库**（源码里没有 postgres 导入）—— 名额的创建/绑定是 Stage B 的事；
 *   · **不猜**：V1 只有 `k_head` / `k_assistant` / `prek_head` / `prek_assistant` 这类
 *     岗位名，**没有**中方/外方之分；所以"中方主班 vs 外方主班"一律标 `DECISION_REQUIRED`，
 *     由业主按真实花名册决定，脚本不替它选；
 *   · **不产出任何"已绑定"的结论**：报告里的匹配只是**建议**，绑定动作由超级管理员在界面上做。
 *
 * 用法：
 *   node scripts/report-teacher-slots.mjs                    # 生成 .migration/teacher-slot-difference.{md,json}
 *   node scripts/report-teacher-slots.mjs --force             # 覆盖已有产物
 *   node scripts/report-teacher-slots.mjs --snapshot <ndjson> # 换一个迁移文件
 *
 * 退出码：0 成功 / 2 源文件或参数有问题 / 3 产物已存在（未给 --force）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const SNAPSHOT = resolve(ROOT, arg('snapshot', '.migration/prod-exports/v2-cutover-20261008.ndjson'))
const OUT_DIR = resolve(ROOT, arg('out-dir', '.migration'))
const OUT_MD = join(OUT_DIR, 'teacher-slot-difference.md')
const OUT_JSON = join(OUT_DIR, 'teacher-slot-difference.json')

function fail(message, code = 2) {
  console.error(`✖ ${message}`)
  process.exit(code)
}

// ── ① 名额规格：唯一一份真相（业主 Stage 14A §2 的表）────────────────────────
/** 学段 × 岗位 → 名额数。改这里就是改规划，别处不再各写一份。 */
export const SLOT_SPEC = Object.freeze([
  { track: 'K', position: 'LEAD_CN', count: 5, label: 'K 中方主班教师', codePrefix: 'K', codeSuffix: '' },
  { track: 'K', position: 'LEAD_INTL', count: 5, label: 'K 外方主班教师', codePrefix: 'K', codeSuffix: '-F' },
  { track: 'K', position: 'ASSISTANT', count: 5, label: 'K 助教', codePrefix: 'K', codeSuffix: '-A' },
  { track: 'PREK', position: 'LEAD_CN', count: 8, label: 'Pre-K 中方主班教师', codePrefix: 'PK', codeSuffix: '' },
  { track: 'PREK', position: 'LEAD_INTL', count: 8, label: 'Pre-K 外方主班教师', codePrefix: 'PK', codeSuffix: '-F' },
  { track: 'PREK', position: 'ASSISTANT', count: 8, label: 'Pre-K 助教', codePrefix: 'PK', codeSuffix: '-A' },
])

/** 岗位 → 该岗位在 V2 里应有的**权限**（服务端判据，不是界面显隐）。 */
export const POSITION_RIGHTS = Object.freeze({
  // 主班：可查看 + 可上传（上传=resource.create；不自动含删除/审核/发布/建文件夹）
  LEAD_CN: { canView: true, canUpload: true },
  LEAD_INTL: { canView: true, canUpload: true },
  // 助教：可查看、**不可上传**（手动构造上传请求也必须被服务端拒绝）
  ASSISTANT: { canView: true, canUpload: false },
})

/** 生成 39 个名额（确定性：同样的规格永远同样的编号）。 */
export function buildSlots() {
  const slots = []
  for (const spec of SLOT_SPEC) {
    const width = spec.track === 'PREK' ? 2 : 2
    for (let i = 1; i <= spec.count; i += 1) {
      const n = String(i).padStart(width, '0')
      slots.push({
        code: `${spec.codePrefix}-${n}${spec.codeSuffix}`,
        track: spec.track,
        position: spec.position,
        positionLabel: spec.label,
        classNo: `${spec.codePrefix}-${n}`,
        // 名额**不是**可登录账号：一律从这个状态开始（业主 §2.2）
        status: 'UNASSIGNED',
        canView: POSITION_RIGHTS[spec.position].canView,
        canUpload: POSITION_RIGHTS[spec.position].canUpload,
        boundUsername: null,
      })
    }
  }
  return slots
}

// ── ② V1 岗位 → 名额的**建议**（只在"学段 + 层级"这一层能对上）─────────────────
const V1_ROLE_HINT = {
  k_head: { track: 'K', level: 'LEAD' },
  k_assistant: { track: 'K', level: 'ASSISTANT' },
  prek_head: { track: 'PREK', level: 'LEAD' },
  prek_assistant: { track: 'PREK', level: 'ASSISTANT' },
  // 下面这些在 39 个名额里**没有对应岗位**：要业主单独决定怎么处理
  pe_specialist: null,
  curriculum_director: null,
  principal: null,
  visitor: null,
}

/**
 * 主流程。**包在函数里并由 isMain 守卫调用**：单元测试要 import `buildSlots()` /
 * `SLOT_SPEC` 做规格断言，如果模块一被 import 就跑主流程，测试会因为
 * "产物已存在 → 拒绝覆盖"而直接退出（这条我自己踩过一次）。
 */
function main() {
  // ── ③ 读迁移文件里的账号（只读解析）──────────────────────────────────────────
  if (!existsSync(SNAPSHOT)) fail(`找不到迁移文件：${SNAPSHOT}`)
  const teachers = []
  for (const line of readFileSync(SNAPSHOT, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.kind !== 'row' || record.table !== 'teachers') continue
    const roles = Array.isArray(record.row.roles) ? record.row.roles.map(String) : []
    teachers.push({
      id: String(record.row.id),
      username: record.row.username === null || record.row.username === undefined ? `v1-no-username-${String(record.row.id).slice(0, 8)}` : String(record.row.username),
      name: String(record.row.name ?? ''),
      v1Roles: roles,
      status: String(record.row.status ?? ''),
    })
  }
  if (teachers.length === 0) fail('迁移文件里没有 teachers（检查 --snapshot 指向的文件）')

  const slots = buildSlots()

  /** 现有账号 → 建议名额：只按 学段+层级 找候选，并明确标出"中方/外方需业主定"。 */
  function suggestFor(teacher) {
    const hints = teacher.v1Roles.map((r) => V1_ROLE_HINT[r]).filter((h) => h !== undefined && h !== null)
    if (hints.length === 0) {
      return { kind: 'NO_SLOT', why: `V1 角色 ${teacher.v1Roles.join('、') || '(无)'} 在 39 个名额里没有对应岗位` }
    }
    const hint = hints[0]
    const candidates = slots.filter((s) => s.track === hint.track && s.position.startsWith(hint.level === 'LEAD' ? 'LEAD' : 'ASSISTANT'))
    const leadAmbiguous = hint.level === 'LEAD' && candidates.length > 1
    return {
      kind: 'CANDIDATE',
      track: hint.track,
      level: hint.level,
      candidates: candidates.map((s) => s.code),
      decision: leadAmbiguous ? 'DECISION_REQUIRED（中方/外方主班二选一，V1 数据里没有这个区分）' : 'DECISION_REQUIRED（由超级管理员绑定）',
    }
  }

  const accounts = teachers.map((t) => ({ ...t, suggestion: suggestFor(t) }))

  // 冲突与统计
  const byRole = {}
  for (const t of teachers) for (const r of t.v1Roles) byRole[r] = (byRole[r] ?? 0) + 1
  const noSlot = accounts.filter((a) => a.suggestion.kind === 'NO_SLOT')
  const usable = accounts.filter((a) => a.suggestion.kind === 'CANDIDATE')
  const teachingSlots = slots.length
  const conflict = {
    /** 39 个名额没有任何一条被"自动绑定"——这是设计，不是遗留问题。 */
    autoBound: 0,
    /** V1 里没有中方/外方之分：所有主班名额都必须由业主按花名册决定。 */
    leadSlotsNeedingDecision: slots.filter((s) => s.position.startsWith('LEAD')).length,
    /** V1 账号里，岗位对不上 39 个名额的（如体能专科、教研主管、园长、访客、探针）。 */
    accountsWithoutSlot: noSlot.length,
    /** 教师岗位账号（能对应到名额的）数量。 */
    accountsMatchable: usable.length,
    /** 39 - 可对应账号 = 仍需外部招聘/花名册补充的名额。 */
    slotsStillUnbound: teachingSlots - usable.length,
  }

  // ── ④ 产物 ──────────────────────────────────────────────────────────────────
  for (const out of [OUT_MD, OUT_JSON]) {
    if (existsSync(out) && !has('force')) {
      fail(
        `产物已存在，拒绝覆盖：${out}\n  （这份报告可能已经被批注过 —— 确认要重生成时加 --force。）`,
        3,
      )
    }
  }
  mkdirSync(OUT_DIR, { recursive: true })

  const artifact = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    source: SNAPSHOT.replace(`${ROOT}/`, ''),
    spec: SLOT_SPEC.map((s) => ({ ...s })),
    summary: {
      slots: teachingSlots,
      accountsInMigration: accounts.length,
      ...conflict,
    },
    slots,
    accounts,
    roleHistogram: byRole,
    /** 明确写死：这份报告什么都没改。 */
    note: '名额只是"待配置岗位"；未经超级管理员绑定并启用之前不能登录，也没有默认口令与任何额外权限。',
  }
  writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  const md = []
  md.push('# 教师账号名额（39）与现有账号（迁移的 24 个）差异报告')
  md.push('')
  md.push('> **只读产出**：脚本没有连数据库、没有创建或绑定任何账号、没有改任何数据。')
  md.push(`> 源：\`${artifact.source}\`（V2 专用迁移文件）。生成于 ${artifact.generatedAt}。`)
  md.push('')
  md.push('## 0. 一句话结论')
  md.push('')
  md.push(`- 39 个名额已按规划生成：**${teachingSlots} 个**（5+5+5 K / 8+8+8 Pre-K）。`)
  md.push(`- 迁移材料里的账号：**${accounts.length} 个**，其中能按"学段+层级"对上名额的 **${usable.length} 个**。`)
  md.push(`- **仍需绑定/补充的名额：${conflict.slotsStillUnbound} 个**；岗位对不上 39 个名额的现有账号：**${noSlot.length} 个**。`)
  md.push(`- **自动绑定数：0** —— 这是设计：名额不是账号，未经超级管理员绑定并启用前不能登录、没有默认口令。`)
  md.push('')
  md.push('## 1. 名额清单（全部 UNASSIGNED）')
  md.push('')
  md.push('| 编号 | 学段 | 岗位 | 班级位 | 查看 | 上传 | 状态 |')
  md.push('|---|---|---|---|---|---|---|')
  for (const s of slots) {
    md.push(`| \`${s.code}\` | ${s.track} | ${s.positionLabel} | ${s.classNo} | ${s.canView ? '允许' : '—'} | ${s.canUpload ? '允许' : '**不允许**'} | ${s.status} |`)
  }
  md.push('')
  md.push('## 2. 现有账号 → 名额建议（**全部需要超级管理员确认/绑定**）')
  md.push('')
  md.push('| 账号 | 姓名 | V1 角色 | 状态 | 建议 |')
  md.push('|---|---|---|---|---|')
  for (const a of accounts) {
    const sug = a.suggestion.kind === 'NO_SLOT'
      ? `**无对应名额** —— ${a.suggestion.why}`
      : `候选 ${a.suggestion.candidates.slice(0, 3).join('、')}${a.suggestion.candidates.length > 3 ? ' …' : ''}；${a.suggestion.decision}`
    md.push(`| ${a.username} | ${a.name} | ${a.v1Roles.join('、') || '(无)'} | ${a.status} | ${sug} |`)
  }
  md.push('')
  md.push('## 3. V1 角色分布（用于判断名额够不够）')
  md.push('')
  md.push('| V1 角色 | 人数 | 在 39 个名额里有对应岗位？ |')
  md.push('|---|---|---|')
  for (const [role, n] of Object.entries(byRole).sort()) {
    const hint = V1_ROLE_HINT[role]
    md.push(`| \`${role}\` | ${n} | ${hint ? `有（${hint.track} / ${hint.level}）` : '**没有** —— 需业主决定处理方式'} |`)
  }
  md.push('')
  md.push('## 4. 需要业主确认的事（本报告不替你决定）')
  md.push('')
  md.push('1. **中方/外方主班**：V1 数据里没有这个区分（只有 `k_head` / `prek_head`），')
  md.push('   所以 5+5+8+8 个主班名额各自属于中方还是外方，必须按真实花名册填。')
  md.push(`2. **岗位对不上的 ${noSlot.length} 个账号**（体能专科、教学主任、园长/平台管理员、访客、探针账号…）：`)
  md.push('   是保留为"无名额"的独立账号，还是映射到某个名额？**不得**自动删号，也不得强行映射。')
  md.push('3. **班级位与真实班级名**：名额里的 `K-01` / `PK-03` 是**位置编号**，真实班级名（如"K1 班"）由业主给。')
  md.push('4. **助教是否可上传**：按业主 §2 的表，助教**不允许**上传 —— 这条会在 Stage B 用服务端测试钉住。')
  md.push('')
  md.push('## 5. 下一步（Stage B 才会写数据）')
  md.push('')
  md.push('1. 新增 `teacher_slots` 表（名额）+ `users.slot_id`（绑定），全部以 `UNASSIGNED` 起步；')
  md.push('2. 超级管理员在「教师账号」页逐个填写真实姓名/用户名/班级并**启用**，此时才创建可登录账号；')
  md.push('3. 绑定与启停都写审计；岗位权限按 §2 的表初始化（助教只给查看）；')
  md.push('4. 本报告可直接作为绑定工作的核对清单（第 1、2 节）。')
  md.push('')
  writeFileSync(OUT_MD, `${md.join('\n')}\n`, 'utf8')

  console.log('教师名额差异报告已生成（**未连数据库、未创建或绑定任何账号**）')
  console.log(`  源：${artifact.source}`)
  console.log(`  名额：${teachingSlots} 个（自动绑定 0）`)
  console.log(`  迁移账号：${accounts.length} 个；可对应名额 ${usable.length} 个；岗位无对应 ${noSlot.length} 个`)
  console.log(`  仍需绑定/补充的名额：${conflict.slotsStillUnbound} 个`)
  console.log(`  已写入：${OUT_MD.replace(`${ROOT}/`, '')}`)
  console.log(`  已写入：${OUT_JSON.replace(`${ROOT}/`, '')}`)
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main()
