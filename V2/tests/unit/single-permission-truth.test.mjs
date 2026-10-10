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

/**
 * 服务端源码全文（去注释）。
 *
 * 用来证明"某个东西运行期根本不存在"—— 迁移记账表就是这种：
 * 它只属于 `scripts/import-v1.mjs`，一旦有业务代码开始读它，
 * 说明迁移渗进了运行期，那正是 V1 的老毛病（兼容层永久留在业务里）。
 */
function readServerSources() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) files.push(readFileSync(full, 'utf8'))
    }
  }
  walk(join(ROOT, 'server'))
  return files.join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('数据库里只有一个权限真相', () => {
  const tables = [...SQL_CODE.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_]+)/g)].map(
    (m) => m[1],
  )

  /**
   * 表的名单是**逐张列出来**的，不是数个数 —— 这样"悄悄多了一张表"会立刻红。
   *
   * 阶段 2 是 8 张；阶段 6 加了 2 张，都是文件存储需要的：
   *   · `upload_tickets`  —— 一次上传的票据（把客户端声明的 size/sha256 钉在服务端）
   *   · `storage_orphans` —— 上传成功但没能登记的对象的清理标记
   * 阶段 9 又加了 2 张，都是**迁移记账**（不是业务表，前缀 `v1_` 已经写明来历）：
   *   · `v1_import_runs`   —— 每次导入一行（源标签、各表计数）
   *   · `v1_migration_map` —— 每条搬过来的对象一行（幂等键 + V1 有而 V2 没有的历史字段）
   *
   * 它们不持有任何授权（下面"授权只有 user_permissions 一张表"约束的就是这件事），
   * 也不参与运行时的读写 —— 只有 `scripts/import-v1.mjs` 与迁移报告会碰它们。
   * 加这两张表是为了满足业主 Stage 9 的"幂等 + 可追溯 + 历史字段不丢"，
   * 不是为了给 V2 添一个业务概念。
   *
   * 阶段 14A 再加 1 张业务表（业主的"39 个名额"）：
   *   · `teacher_slots` —— 岗位编制名额（K-01 … PK-08）。**名额 ≠ 账号**：
   *     名额是学校编制，账号要等管理员绑上真实人员才在 `users` 里诞生。
   *     它只存一列 `bound_user_id` 指向 `users`，**不持有任何授权** ——
   *     报到哪个班、能传什么，仍然由 `user_permissions` 唯一决定。
   *
   * 名单是**逐张列出来**的（不是数个数），所以"悄悄多了一张表"会立刻红；
   * 每次加表都必须同时改这份名单 + 上面的说明 —— 这就是这张清单的用处。
   */
  test('恰好 13 张表（11 张业务 + 2 张迁移记账），名单逐张核对（V1 旧表一张都不许回来）', () => {
    assert.deepEqual(tables.sort(), [
      'audit_logs',
      'directories',
      'resource_files',
      'resource_reviews',
      'resources',
      'sessions',
      'storage_orphans',
      'teacher_slots',
      'upload_tickets',
      'user_permissions',
      'users',
      'v1_import_runs',
      'v1_migration_map',
    ])
  })

  test('迁移记账表不许渗进运行期（名字带 v1_，服务端一行都不读）', () => {
    const serverCode = readServerSources()
    for (const table of ['v1_import_runs', 'v1_migration_map']) {
      assert.match(table, /^v1_/, `${table} 应当以 v1_ 开头：一眼看出它不是产品概念`)
      assert.equal(
        serverCode.includes(table),
        false,
        `服务端代码不该读 ${table} —— 它是迁移记账，只属于 scripts/`,
      )
    }
  })

  test('阶段 6 / 阶段 9 / 阶段 14A 新增的表都不持有授权信息', () => {
    for (const table of [
      'upload_tickets',
      'storage_orphans',
      'v1_import_runs',
      'v1_migration_map',
      'teacher_slots',
    ]) {
      assert.equal(tables.includes(table), true, `${table} 应当存在`)
      /*
        查的是**列名**，不是整段文本里的子串。

        `v1_migration_map` 的 CHECK 里有一个字符串字面量 `'permission'`
        （迁移实体的取值之一：把 V1 的授权行搬过来），那是**分类标签**，
        不是授权数据。用子串扫描会把它误判成"这张表藏着授权"，
        而真正要防的是"多了一列 permission/scope/grant/deny/override"。
      */
      const at = SQL_CODE.indexOf(`CREATE TABLE ${table}`)
      assert.notEqual(at, -1, `找不到 ${table} 的定义`)
      const block = SQL_CODE.slice(at, SQL_CODE.indexOf(');', at))
      const columns = [...block.matchAll(/^\s{2}([a-z0-9_]+)\s+\w/gm)].map((m) => m[1])
      assert.equal(columns.length > 0, true, `没能解析出 ${table} 的列`)
      for (const column of columns) {
        assert.equal(
          /permission|scope|grant|deny|override/.test(column),
          false,
          `${table}.${column} 看起来是授权字段 —— 授权只有一个真相（user_permissions）`,
        )
      }
    }
  })

  test('授权只有 user_permissions 一张表', () => {
    const permissionTables = tables.filter((t) => /permission|scope|grant|override/.test(t))
    assert.deepEqual(permissionTables, ['user_permissions'])
  })

  test('V1 的旧表一个都不在（含旧账号/旧审核表）', () => {
    for (const banned of [
      // V1 的授权形态（业主点名不许回来）
      'subject_permissions',
      'account_permission_overrides',
      'account_scopes',
      'role_permissions',
      'permission_overrides',
      // V1 的账号与审核记录表：V2 用 users / resource_reviews 取代
      // （`teachers` 一表兼了账号+角色数组，`review_records` 只关联 resource_id，
      //  拿不到"谁在哪个目录上有权审"这件事）
      'teachers',
      'review_records',
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
