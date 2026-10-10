/**
 * tests/unit/teacher-slots.test.mjs —— 39 个名额的规格、状态机与"只读"边界
 * ============================================================================
 * 业主 Stage 14A §2 订了名额数（5+5+5 K / 8+8+8 Pre-K）与岗位权限
 * （主班可上传、助教**不可**上传）。这些是后续所有实现与测试的基准，
 * 所以先把基准本身钉住 —— 而不是等 Stage B 写完再"顺便发现"规格抄错了。
 *
 * 另外守住三条边界（与 13C 系列同源）：
 *   · 名额生成**不连数据库**（源码里没有 postgres 导入）；
 *   · 名额**不是**可登录账号（全部从 UNASSIGNED 起步、没有口令、没有授权）；
 *   · 差异报告**不覆盖**已有产物（业主可能已经批注过）。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POSITION_RIGHTS, SLOT_SPEC, buildSlots } from '../../scripts/report-teacher-slots.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'report-teacher-slots.mjs')
const WORK = mkdtempSync(join(tmpdir(), 'slots-'))

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { code: res.status ?? 1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

describe('① 39 个名额的规格与编号', () => {
  test('总数 39，且 5+5+5 K / 8+8+8 Pre-K', () => {
    const slots = buildSlots()
    assert.equal(slots.length, 39)
    const count = (track, position) => slots.filter((s) => s.track === track && s.position === position).length
    assert.equal(count('K', 'LEAD_CN'), 5)
    assert.equal(count('K', 'LEAD_INTL'), 5)
    assert.equal(count('K', 'ASSISTANT'), 5)
    assert.equal(count('PREK', 'LEAD_CN'), 8)
    assert.equal(count('PREK', 'LEAD_INTL'), 8)
    assert.equal(count('PREK', 'ASSISTANT'), 8)
    // 规格表本身也要对得上（防止只改了一处）
    assert.equal(SLOT_SPEC.reduce((n, s) => n + s.count, 0), 39)
  })

  test('编号唯一、可读、可反解（K-01 / K-01-F / PK-03-A 的规则）', () => {
    const slots = buildSlots()
    const codes = slots.map((s) => s.code)
    assert.equal(new Set(codes).size, codes.length, '编号必须唯一')
    for (const code of codes) {
      assert.match(code, /^(K|PK)-\d{2}(-F|-A)?$/, `编号格式不对：${code}`)
    }
    assert.ok(codes.includes('K-01') && codes.includes('K-05'))
    assert.ok(codes.includes('K-01-F') && codes.includes('K-05-F'))
    assert.ok(codes.includes('K-01-A') && codes.includes('K-05-A'))
    assert.ok(codes.includes('PK-01') && codes.includes('PK-08'))
    assert.ok(codes.includes('PK-01-F') && codes.includes('PK-08-F'))
    assert.ok(codes.includes('PK-01-A') && codes.includes('PK-08-A'))
    // 确定性：两次生成必须一模一样（否则重跑会建出重复名额）
    assert.deepEqual(buildSlots(), slots)
  })

  test('主班可上传、助教**不可**上传（岗位权限的唯一真相）', () => {
    assert.deepEqual(POSITION_RIGHTS.LEAD_CN, { canView: true, canUpload: true })
    assert.deepEqual(POSITION_RIGHTS.LEAD_INTL, { canView: true, canUpload: true })
    assert.deepEqual(POSITION_RIGHTS.ASSISTANT, { canView: true, canUpload: false })
    for (const s of buildSlots()) {
      const isAssistant = s.position === 'ASSISTANT'
      assert.equal(s.canUpload, !isAssistant, `${s.code} 的上传权限与岗位不符`)
      assert.equal(s.canView, true)
    }
  })
})

describe('② 名额不是可登录账号（业主 §2.2）', () => {
  test('全部从 UNASSIGNED 起步、没有绑定任何账号', () => {
    for (const s of buildSlots()) {
      assert.equal(s.status, 'UNASSIGNED', `${s.code} 的初始状态必须是 UNASSIGNED`)
      assert.equal(s.boundUsername, null, `${s.code} 不得预绑定账号`)
    }
  })

  test('脚本里没有数据库客户端（不可能偷偷建账号）', () => {
    const source = readFileSync(SCRIPT, 'utf8')
    for (const forbidden of ["from 'postgres'", 'INSERT INTO users', 'INSERT INTO teacher_slots', 'UPDATE users']) {
      assert.equal(source.includes(forbidden), false, `只读工具里出现了 ${forbidden}`)
    }
  })
})

describe('③ 差异报告：从迁移文件读出 24 个账号，且不覆盖已有产物', () => {
  const fixture = join(WORK, 'teachers.ndjson')
  before(() => {
    const rows = [
      { kind: 'table', table: 'teachers', columns: [], rowCount: 4 },
      { kind: 'row', table: 'teachers', row: { id: '11111111-1111-4111-8111-111111111111', username: 'k-head01', name: 'K主教01', roles: ['k_head'], status: 'active' } },
      { kind: 'row', table: 'teachers', row: { id: '22222222-2222-4222-8222-222222222222', username: 'k-teacher01', name: 'K教师01', roles: ['k_assistant'], status: 'active' } },
      { kind: 'row', table: 'teachers', row: { id: '33333333-3333-4333-8333-333333333333', username: 'pe-teacher01', name: '体能教师01', roles: ['pe_specialist'], status: 'active' } },
      { kind: 'row', table: 'teachers', row: { id: '749e5d41-ae21-4ae0-937c-352603f72043', username: null, name: '系统初始化', roles: ['principal'], status: 'active' } },
    ]
    writeFileSync(fixture, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  })

  test('生成报告：可对应的账号有候选、岗位无对应的账号明确标出、自动绑定为 0', () => {
    const outDir = join(WORK, 'out1')
    const { code, out } = run(['--snapshot', fixture, '--out-dir', outDir])
    assert.equal(code, 0, out)

    const artifact = JSON.parse(readFileSync(join(outDir, 'teacher-slot-difference.json'), 'utf8'))
    assert.equal(artifact.readOnly, true)
    assert.equal(artifact.slots.length, 39)
    assert.equal(artifact.accounts.length, 4)
    assert.equal(artifact.summary.autoBound, 0, '自动绑定必须恒为 0')
    assert.equal(artifact.summary.slotsStillUnbound, 39 - 2, '能对应的只有主班与助教两条')

    const byUser = Object.fromEntries(artifact.accounts.map((a) => [a.username, a.suggestion]))
    assert.equal(byUser['k-head01'].kind, 'CANDIDATE')
    assert.match(byUser['k-head01'].decision, /DECISION_REQUIRED/, '中方/外方必须由业主决定')
    assert.equal(byUser['k-teacher01'].kind, 'CANDIDATE')
    assert.equal(byUser['pe-teacher01'].kind, 'NO_SLOT', '体能专科在 39 个名额里没有对应岗位')
    assert.equal(byUser['v1-no-username-749e5d41'].kind, 'NO_SLOT')

    const md = readFileSync(join(outDir, 'teacher-slot-difference.md'), 'utf8')
    assert.match(md, /只读产出/)
    assert.match(md, /仍需绑定\/补充的名额/)
  })

  test('产物已存在 → 拒绝覆盖（加 --force 才重生成）', () => {
    const outDir = join(WORK, 'out2')
    assert.equal(run(['--snapshot', fixture, '--out-dir', outDir]).code, 0)
    const md = join(outDir, 'teacher-slot-difference.md')
    writeFileSync(md, '业主批注：PK-03 归 K2 班\n', 'utf8')

    const again = run(['--snapshot', fixture, '--out-dir', outDir])
    assert.equal(again.code, 3, again.out)
    assert.match(again.out, /拒绝覆盖/)
    assert.equal(readFileSync(md, 'utf8'), '业主批注：PK-03 归 K2 班\n', '已有内容一个字都不能变')

    const forced = run(['--snapshot', fixture, '--out-dir', outDir, '--force'])
    assert.equal(forced.code, 0, forced.out)
    assert.match(readFileSync(md, 'utf8'), /教师账号名额/)
  })

  test('源文件不存在 → 退出码 2（不当成"没问题"）', () => {
    const { code, out } = run(['--snapshot', join(WORK, 'nope.ndjson'), '--out-dir', join(WORK, 'out3')])
    assert.equal(code, 2, out)
    assert.match(out, /找不到迁移文件/)
    assert.equal(existsSync(join(WORK, 'out3', 'teacher-slot-difference.md')), false)
  })
})
