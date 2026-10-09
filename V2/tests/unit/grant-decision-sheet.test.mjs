/**
 * tests/unit/grant-decision-sheet.test.mjs —— 教师授权决策清单工具的边界
 * ============================================================================
 * 业主 Stage 13C §1 的要求有两层意思，这份测试把两层都钉住：
 *
 *   ① **它只产出"要人来填的表"**：不连数据库、不替业主做决定、不写任何授权；
 *   ② **它必须来自冻结的那一份迁移文件**：sha256 与清单不符时直接拒绝 ——
 *      决策表若建立在改过的文件上，业主填的就是一份假的业务决定。
 *
 * 做法：用一个**临时夹具**（2 个账号 + 3 个目录的迷你 NDJSON）跑真脚本，
 * 因此不依赖仓库里那份真实快照（它在 `.migration/` 里、不进版本库）。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'propose-directory-grants.mjs')
const DIST_PERMISSIONS = join(ROOT, 'dist', 'shared', 'permissions.js')

const WORK = mkdtempSync(join(tmpdir(), 'grant-sheet-'))
const SNAPSHOT = join(WORK, 'fixture.ndjson')
const MANIFEST = join(WORK, 'fixture.exclusion.json')

/** 迷你"迁移文件"：结构与真实产物一致（header + table + row）。 */
function fixtureLines() {
  const teacherA = {
    id: 'aaaa1111-1111-4111-8111-111111111111',
    username: 'teach_a',
    name: '甲老师',
    roles: ['prek_head'],
    status: 'active',
  }
  const teacherNoUsername = {
    id: '749e5d41-ae21-4ae0-937c-352603f72043',
    username: null,
    name: '系统初始化',
    roles: ['principal'],
    status: 'active',
  }
  const dirs = [
    { id: 'd1', parent_id: null, code: 'root:education', name: '教育教学', name_en: 'Education', type: 'root', enabled: true },
    { id: 'd1b', parent_id: 'd1', code: 'prek', name: 'Pre-K', name_en: 'Pre-K', type: 'program', enabled: true },
    { id: 'd2', parent_id: 'd1b', code: 'prek:virtue', name: '美德', name_en: 'Virtue', type: 'subject', enabled: true },
    { id: 'd3', parent_id: 'd2', code: 'prek:virtue_resource', name: '教学资源', name_en: 'Materials', type: 'folder', enabled: true },
  ]
  return [
    { kind: 'header', tool: 'fixture', formatVersion: 1, createdAt: '2026-01-01T00:00:00.000Z', sourceDatabase: 'fixture' },
    { kind: 'table', table: 'teachers', columns: [], rowCount: 2 },
    { kind: 'table', table: 'directories', columns: [], rowCount: 4 },
    ...dirs.map((row) => ({ kind: 'row', table: 'directories', row })),
    ...[teacherA, teacherNoUsername].map((row) => ({ kind: 'row', table: 'teachers', row })),
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n'
}

function run(args, { env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: undefined, ...env },
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

before(() => {
  assert.equal(
    existsSync(DIST_PERMISSIONS),
    true,
    '这份测试要读 dist/shared/permissions.js（权限清单的唯一真相）—— 请先 npm run build，不要另抄一份清单进测试',
  )
  const text = fixtureLines()
  writeFileSync(SNAPSHOT, text, 'utf8')
  const sha256 = createHash('sha256').update(readFileSync(SNAPSHOT)).digest('hex')
  writeFileSync(MANIFEST, JSON.stringify({ output: { sha256 } }, null, 2), 'utf8')
})

describe('① 生成决策表：只读、不猜、不写库', () => {
  test('从夹具生成 md + json：账号/目录/权限清单齐全，每个账号都是 DECISION_REQUIRED', () => {
    const outDir = join(WORK, 'ok')
    const { code, out } = run(['--snapshot', SNAPSHOT, '--manifest', MANIFEST, '--out-dir', outDir])
    assert.equal(code, 0, `应当成功：${out}`)
    assert.match(out, /没有连数据库、没有写任何授权/, '要自报"只读"')

    const json = JSON.parse(readFileSync(join(outDir, 'production-grant-decision-sheet.json'), 'utf8'))
    assert.equal(json.readOnly, true)
    assert.equal(json.policy.doNotGrantAllDirectories, true, '策略里要写死"不给全站开放"')
    assert.equal(json.accounts.length, 2)
    assert.equal(json.directories.length, 4)
    assert.equal(json.permissionChecklist.length, 11, '可授予权限 11 个（user.manage 不对外授予）')

    for (const a of json.accounts) {
      assert.equal(a.decision, 'DECISION_REQUIRED', `${a.username} 应当等业主决定`)
      assert.deepEqual(a.grants, [], `${a.username} 不能预填任何授权`)
      assert.equal(a.currentGrants, 0, '迁移不发授权：现状必须是 0 条')
    }

    // V1 无用户名 → 迁移后是**停用**占位账号，决策表不能显示成 active
    const placeholder = json.accounts.find((a) => a.username.startsWith('v1-no-username-'))
    assert.ok(placeholder, `要按迁移规则合成占位用户名：${JSON.stringify(json.accounts.map((a) => a.username))}`)
    assert.match(placeholder.status, /inactive/, '占位账号必须是停用')
    assert.equal(placeholder.suggestedRole, 'TEACHER')

    // 目录路径用 import-v1 里同一个 slugFromV1Code 推导（`prek:virtue_resource` → `resources`）
    const paths = json.directories.map((d) => d.path)
    assert.equal(paths.includes('education/prek/virtue/resources'), true, JSON.stringify(paths))

    const md = readFileSync(join(outDir, 'production-grant-decision-sheet.md'), 'utf8')
    assert.match(md, /教师目录授权决策清单/)
    assert.match(md, /不能"为了页面能用"就给所有教师开放全部目录/)
    assert.match(md, /education\/prek\/virtue\/resources/)
  })

  test('脚本里没有数据库客户端（不可能偷偷写授权）', () => {
    const source = readFileSync(SCRIPT, 'utf8')
    for (const forbidden of ["from 'postgres'", 'INSERT INTO user_permissions', 'DELETE FROM user_permissions']) {
      assert.equal(source.includes(forbidden), false, `只读工具里出现了 ${forbidden}`)
    }
  })
})

describe('② 两个必须拒绝的情形', () => {
  test('sha256 与清单不符 → 拒绝（决策表必须建立在冻结文件上）', () => {
    const badManifest = join(WORK, 'bad.exclusion.json')
    writeFileSync(badManifest, JSON.stringify({ output: { sha256: 'deadbeef'.repeat(8) } }), 'utf8')
    const { code, out } = run([
      '--snapshot', SNAPSHOT,
      '--manifest', badManifest,
      '--out-dir', join(WORK, 'bad-sha'),
    ])
    assert.equal(code, 2, `应当拒绝：${out}`)
    assert.match(out, /sha256 与清单不符/)
    assert.equal(existsSync(join(WORK, 'bad-sha', 'production-grant-decision-sheet.md')), false, '被拒时不该产出文件')
  })

  test('产物已存在 → 拒绝覆盖（业主填过的表不能被抹掉）', () => {
    const outDir = join(WORK, 'existing')
    const first = run(['--snapshot', SNAPSHOT, '--manifest', MANIFEST, '--out-dir', outDir])
    assert.equal(first.code, 0, first.out)
    const md = join(outDir, 'production-grant-decision-sheet.md')
    writeFileSync(md, '业主填写中，请勿覆盖\n', 'utf8')

    const second = run(['--snapshot', SNAPSHOT, '--manifest', MANIFEST, '--out-dir', outDir])
    assert.equal(second.code, 3, `应当拒绝覆盖：${second.out}`)
    assert.match(second.out, /拒绝覆盖/)
    assert.equal(readFileSync(md, 'utf8'), '业主填写中，请勿覆盖\n', '已有内容一个字都不能变')

    // --force 时才允许重生成
    const forced = run(['--snapshot', SNAPSHOT, '--manifest', MANIFEST, '--out-dir', outDir, '--force'])
    assert.equal(forced.code, 0, forced.out)
    assert.match(readFileSync(md, 'utf8'), /教师目录授权决策清单/)
  })
})
