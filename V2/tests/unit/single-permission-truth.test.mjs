/**
 * tests/unit/single-permission-truth.test.mjs —— 「一个权限真相」的结构性证明
 * ============================================================================
 * 业主的要求：「不要重新加入 deny / grant / override / permission version /
 * role ceiling / subject_permissions / legacy folder permissions / 多套 Scope」。
 *
 * 这条要求不能只靠 review —— 它最容易以"加一列、加一张表"的形式悄悄回来，
 * 而那种改动**不会让任何接口测试变红**（新列没人用，接口照样全绿）。
 * 所以这里直接对 schema 与共享词汇表做结构性断言。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { permissions } from '../helpers/modules.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 全部迁移 SQL 拼起来（schema 的唯一权威）。 */
function allMigrationSql() {
  const dir = join(ROOT, 'database', 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

const SQL = allMigrationSql()
const SQL_CODE = SQL.replace(/--[^\n]*/g, '') // 去掉注释再匹配

describe('数据库里只有一个权限真相', () => {
  const tables = [...SQL_CODE.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)].map(
    (m) => m[1],
  )

  /**
   * 表的名单是**逐张列出来**的，不是数个数 —— 这样"悄悄多了一张表"会立刻红。
   *
   * 阶段 2 是 8 张；阶段 6 加了 2 张，都是文件存储需要的：
   *   · `upload_tickets`  —— 一次上传的票据（把客户端声明的 size/sha256 钉在服务端）
   *   · `storage_orphans` —— 上传成功但没能登记的对象的清理标记
   * 两张表都不涉及授权（下面的"授权只有 user_permissions 一张表"仍然成立）。
   */
  test('恰好 10 张表，名单逐张核对（V1 是 13 张，且旧表一张都不许回来）', () => {
    assert.deepEqual(tables.sort(), [
      'audit_logs',
      'directories',
      'resource_files',
      'resource_reviews',
      'resources',
      'sessions',
      'storage_orphans',
      'upload_tickets',
      'user_permissions',
      'users',
    ])
  })

  test('阶段 6 新增的两张表都不持有授权信息', () => {
    for (const table of ['upload_tickets', 'storage_orphans']) {
      assert.equal(tables.includes(table), true, `${table} 应当存在`)
    }
    // 它们不能有 permission 之类的列 —— 授权只有一个真相（user_permissions）。
    const create = SQL_CODE.slice(SQL_CODE.indexOf('CREATE TABLE upload_tickets'))
    const block = create.slice(0, create.indexOf(');'))
    assert.equal(/permission/i.test(block), false)
  })

  test('授权只有 user_permissions 一张表', () => {
    const permissionTables = tables.filter((t) => /permission|scope|grant|override/.test(t))
    assert.deepEqual(permissionTables, ['user_permissions'])
  })

  test('V1 的旧权限表一个都不在', () => {
    for (const banned of [
      'subject_permissions',
      'account_permission_overrides',
      'account_scopes',
      'role_permissions',
      'permission_overrides',
    ]) {
      assert.ok(!tables.includes(banned), `不该存在 ${banned}`)
    }
  })

  test('没有 deny / override / scope_kind / role_ceiling / permission version 这些列', () => {
    for (const banned of [
      'deny',
      'override',
      'scope_kind',
      'role_ceiling',
      'permissions_version',
      'permission_version',
    ]) {
      const pattern = new RegExp(`\\b${banned}\\b`, 'i')
      assert.ok(!pattern.test(SQL_CODE), `schema 里不该出现 ${banned}`)
    }
  })

  test('没有 legacy 分类列（folder_type / program / subject / sub_subject）', () => {
    for (const banned of ['folder_type', 'sub_subject']) {
      const pattern = new RegExp(`\\b${banned}\\b`, 'i')
      assert.ok(!pattern.test(SQL_CODE), `schema 里不该出现 ${banned}`)
    }
    // program / subject 只允许作为**目录树里的名字**出现，不能是 resources 的列
    const resourcesBlock = SQL_CODE.slice(SQL_CODE.indexOf('CREATE TABLE resources'))
    const resourcesTable = resourcesBlock.slice(0, resourcesBlock.indexOf(');'))
    for (const banned of ['program', 'subject', 'semester', 'week_number', 'theme']) {
      const pattern = new RegExp(`\\b${banned}\\b`, 'i')
      assert.ok(!pattern.test(resourcesTable), `resources 表里不该有 ${banned} 列`)
    }
  })

  test('身份只有 ADMIN / TEACHER 两种（数据库 CHECK 约束）', () => {
    const match = SQL_CODE.match(/role\s+text NOT NULL DEFAULT 'TEACHER'[\s\S]{0,200}?CHECK \(role IN \(([^)]*)\)\)/)
    assert.ok(match, '找不到 role 的 CHECK 约束')
    const values = match[1].split(',').map((v) => v.trim().replace(/'/g, ''))
    assert.deepEqual(values, ['ADMIN', 'TEACHER'])
  })

  test('资源状态只有五个（数据库 CHECK 约束）', () => {
    const match = SQL_CODE.match(/status\s+text NOT NULL DEFAULT 'DRAFT',[\s\S]{0,300}?CHECK \(([\s\S]*?)\)\s*\n\s*\)/)
    assert.ok(match, '找不到 status 的 CHECK 约束')
    for (const s of ['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'REJECTED', 'RECALLED']) {
      assert.ok(match[1].includes(`'${s}'`), `缺少状态 ${s}`)
    }
    assert.ok(!/ARCHIVED|DELETED|EXPIRED/.test(match[1]), '不该有额外的状态')
  })

  test('resources 的归属只能是 directory_id（NOT NULL + RESTRICT）', () => {
    assert.match(SQL_CODE, /directory_id\s+uuid NOT NULL REFERENCES directories \(id\) ON DELETE RESTRICT/)
  })

  test('删账号不得删掉历史资源（uploader_id 是 SET NULL）', () => {
    assert.match(SQL_CODE, /uploader_id\s+uuid REFERENCES users \(id\) ON DELETE SET NULL/)
  })
})

describe('共享词汇表里只有一个权限目录', () => {
  test('权限码是 12 项，且没有 deny/grant/override 之类的形态字段', () => {
    assert.equal(permissions.PERMISSION_CODES.length, 12)
    const meta = JSON.stringify(permissions.PERMISSIONS).toLowerCase()
    for (const banned of ['deny', 'grant', 'override', 'ceiling', 'version']) {
      assert.ok(!meta.includes(banned), `权限元数据里不该出现 ${banned}`)
    }
  })

  test('只有一种 scope 维度：directory | global', () => {
    for (const code of permissions.PERMISSION_CODES) {
      assert.ok(
        ['directory', 'global'].includes(permissions.PERMISSIONS[code].scope),
        `${code} 的 scope 不合法`,
      )
    }
  })

  test('全平台权限恰好是这两项（其余都可以限定到某个目录及其子树）', () => {
    // 断言的是**设计意图**，不是"我记得的三个"：
    //   · user.manage / audit.view 是平台级的，限定目录没有意义；
    //   · directory.manage **可以**被限定到子树（例如只让某位主任管 Pre-K），
    //     因此它是 directory scope，不是 global。
    const global = permissions.PERMISSION_CODES.filter(
      (c) => permissions.PERMISSIONS[c].scope === 'global',
    )
    assert.deepEqual([...global].sort(), ['audit.view', 'user.manage'])

    const directoryScoped = permissions.PERMISSION_CODES.filter(
      (c) => permissions.PERMISSIONS[c].scope === 'directory',
    )
    assert.equal(directoryScoped.length, 10, '其余 10 项都是可按目录限定的')
    assert.ok(directoryScoped.includes('directory.manage'))
  })
})

describe('代码里没有第二套授权实现', () => {
  const serverFiles = (() => {
    const out = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) out.push(full)
      }
    }
    walk(join(ROOT, 'server'))
    return out
  })()

  test('只有 AuthorizationService 直接查 user_permissions', () => {
    const offenders = serverFiles
      .filter((f) => !f.endsWith(join('authz', 'authorization.service.ts')))
      .filter((f) => /FROM user_permissions|INTO user_permissions|UPDATE user_permissions/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1))
    // users.service 需要**写入**授权（那是管理动作），但读取判定只能在 authz。
    assert.deepEqual(
      offenders.filter((f) => !f.endsWith(join('users', 'users.service.ts'))),
      [],
      `授权读取必须只在 AuthorizationService：\n  ${offenders.join('\n  ')}`,
    )
  })

  test('只有 AuthorizationService 做递归子树的授权判定', () => {
    const offenders = serverFiles
      .filter((f) => !f.endsWith(join('authz', 'authorization.service.ts')))
      .filter((f) => {
        const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
        return /WITH RECURSIVE reach/.test(code)
      })
      .map((f) => f.slice(ROOT.length + 1))
    // 目录服务需要子树（统计资源数、列子树目录 id）—— 那是**数据**查询，不是授权判定
    assert.deepEqual(
      offenders.filter(
        (f) =>
          !f.endsWith(join('directories', 'directories.service.ts')) &&
          !f.endsWith(join('resources', 'resources.service.ts')),
      ),
      [],
      `子树授权判定必须收口：\n  ${offenders.join('\n  ')}`,
    )
  })
})
