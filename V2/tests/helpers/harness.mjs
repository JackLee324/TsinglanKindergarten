/**
 * tests/helpers/harness.mjs —— 集成测试的统一夹具
 * ============================================================================
 * 三条设计原则（都来自 V1 的教训）：
 *
 * 1. **每个套件用独立数据库。** 测试库 `qls_v2_test` 在每个套件启动前被**完全重建**
 *    （drop + migrate + seed）。V1 的套件共用一个库，套件之间会互相制造假 401 与
 *    假 404，只能靠"跑完手动清理"维持，最后还是漏了 230 条探针行。
 *
 * 2. **服务是子进程，跑的是 `npm run build` 的真实产物。**
 *    测的是将要部署的东西，而不是一份被测试框架改写过的源码。
 *
 * 3. **夹具自己清理，且清理是断言的一部分。** 套件结束时核对 resources/users 的
 *    id 集合与开跑前一致，多了或少了都算失败 —— V1 是"跑完再人工查一次"，
 *    这里做成机器检查。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

export const TEST_DB_URL =
  process.env.V2_TEST_DATABASE_URL ??
  'postgresql://qlsadmin:qlsdev_local_only@127.0.0.1:55432/qls_v2_test'

export const TEST_PORT = Number(process.env.V2_TEST_PORT ?? 3311)
export const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`

let serverProcess = null
let storageDir = null

/** 用编译产物里的真函数（不是测试里重写一份）。 */
export const dist = {
  hashPassword: (plain) => require(join(ROOT, 'dist/server/auth/password.js')).hashPassword(plain),
  status: () => require(join(ROOT, 'dist/shared/resource-status.js')),
  permissions: () => require(join(ROOT, 'dist/shared/permissions.js')),
  directory: () => require(join(ROOT, 'dist/shared/directory.js')),
  auditActions: () => require(join(ROOT, 'dist/shared/audit-actions.js')),
}

export function adminSql() {
  return postgres(TEST_DB_URL, { max: 4, onnotice: () => {} })
}

/**
 * 重建测试库：删除所有表再跑迁移与 seed。
 * **只允许对名字里带 `_test` 的库执行** —— 这条守卫不是装饰：
 * 一个写错的 URL 会清掉开发库甚至生产库。
 */
export async function resetDatabase() {
  const dbName = new URL(TEST_DB_URL).pathname.replace(/^\//, '')
  if (!/_test$/.test(dbName)) {
    throw new Error(`拒绝重置非测试库：${dbName}（库名必须以 _test 结尾）`)
  }

  const sql = postgres(TEST_DB_URL, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
    `)
  } finally {
    await sql.end({ timeout: 5 })
  }

  await runScript('scripts/migrate.mjs')
  await runScript('scripts/seed.mjs')
}

/** 创建一个 ADMIN 账号（直接写库，避免依赖 bootstrap 脚本的单次性约束）。 */
export async function createAdmin(username = 'admin', password = 'V2TestAdmin!2026') {
  const sql = adminSql()
  try {
    const rows = await sql`
      INSERT INTO users (username, name, name_en, password_hash, role)
      VALUES (${username}, '系统管理员', 'Administrator', ${dist.hashPassword(password)}, 'ADMIN')
      RETURNING id
    `
    return { id: rows[0].id, username, password }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** 创建一个 TEACHER 账号，并按 `grants` 写入授权。 */
export async function createTeacher(
  username,
  password,
  grants = [],
  name = username,
) {
  const sql = adminSql()
  try {
    const rows = await sql`
      INSERT INTO users (username, name, password_hash, role, status)
      VALUES (${username}, ${name}, ${dist.hashPassword(password)}, 'TEACHER', 'active')
      RETURNING id
    `
    const id = rows[0].id
    for (const g of grants) {
      await sql`
        INSERT INTO user_permissions (user_id, permission, directory_id)
        VALUES (${id}, ${g.permission}, ${g.directoryId ?? null})
      `
    }
    return { id, username, password }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * 按 slug 路径取目录 id（测试里到处都要用）。
 *
 * ⚠️ 不传 sql 时**自己开、自己关**。第一版把默认参数写成 `adminSql()`，
 * 于是每次调用都泄漏一个连接，postgres.js 会让事件循环一直活着 ——
 * 表现为 `node --test` 跑完不出结果、直到超时被杀。这个坑我踩过一次，
 * 所以在这里写明原因，避免以后有人把 withSql 再"简化"回去。
 */
export async function directoryIdByPath(path, sql) {
  const run = async (client) => {
    const segments = path.split('/')
    let parentId = null
    for (const segment of segments) {
      const rows = parentId
        ? await client`SELECT id FROM directories WHERE parent_id = ${parentId} AND slug = ${segment}`
        : await client`SELECT id FROM directories WHERE parent_id IS NULL AND slug = ${segment}`
      if (rows.length === 0) throw new Error(`测试夹具找不到目录：${path}（断在 ${segment}）`)
      parentId = rows[0].id
    }
    return parentId
  }
  return sql ? run(sql) : withSql(run)
}

export async function withSql(fn) {
  const sql = adminSql()
  try {
    return await fn(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * HTTP 客户端：自动处理 cookie 罐与 CSRF 头。
 * 这不是"方便封装"——双提交 cookie 要求每次请求带上与 cookie 相同的头，
 * 手工写在每个测试里只会写漏，而写漏的表现是随机 403。
 */
export function client(baseUrl = TEST_BASE) {
  const jar = new Map()

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

  const store = (res) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [kv] = raw.split(';')
      const i = kv.indexOf('=')
      if (i > 0) {
        const name = kv.slice(0, i).trim()
        const value = kv.slice(i + 1).trim()
        if (value === '') jar.delete(name)
        else jar.set(name, value)
      }
    }
  }

  async function request(method, path, body, options = {}) {
    const headers = {}
    if (body !== undefined && !(body instanceof Buffer)) headers['content-type'] = 'application/json'
    if (jar.size > 0) headers.cookie = cookieHeader()
    const csrf = jar.get('v2_csrf')
    if (csrf) headers['x-v2-csrf'] = csrf
    Object.assign(headers, options.headers ?? {})

    const res = await fetch(baseUrl + path, {
      method,
      headers,
      body:
        body === undefined
          ? undefined
          : body instanceof Buffer
            ? body
            : JSON.stringify(body),
      redirect: 'manual',
    })
    store(res)
    let data = null
    const text = await res.text()
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    return { status: res.status, data, headers: res.headers }
  }

  return {
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b, o),
    put: (p, b, o) => request('PUT', p, b, o),
    patch: (p, b, o) => request('PATCH', p, b, o),
    del: (p, o) => request('DELETE', p, undefined, o),
    async login(username, password) {
      const res = await request('POST', '/api/auth/login', { username, password })
      return res
    },
    cookie: (name) => jar.get(name),
    jar,
  }
}

/** 启动被测服务（跑编译产物）。 */
export async function startServer() {
  if (serverProcess) return
  storageDir = mkdtempSync(join(tmpdir(), 'v2-storage-'))

  serverProcess = spawn(process.execPath, [join(ROOT, 'dist/server/main.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      V2_ALLOW_DEV_SECRETS: '1',
      SERVER_PORT: String(TEST_PORT),
      DATABASE_URL: TEST_DB_URL,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_DIR: storageDir,
      V2_DOWNLOAD_TTL_SECONDS: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logs = []
  serverProcess.stdout.on('data', (d) => logs.push(String(d)))
  serverProcess.stderr.on('data', (d) => logs.push(String(d)))

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${TEST_BASE}/api/health`)
      if (res.ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error(`服务在 20 秒内没起来：\n${logs.join('')}`)
}

export async function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    await sleep(300)
    if (!serverProcess.killed) serverProcess.kill('SIGKILL')
    serverProcess = null
  }
  if (storageDir) {
    rmSync(storageDir, { recursive: true, force: true })
    storageDir = null
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 残留核对：跑完一个套件后，资源与账号的 id 集合必须与开跑前**逐行一致**。
 * 多了（探针没清干净）或少了（误删了既有数据）都算失败。
 */
export async function snapshotIds() {
  return withSql(async (sql) => {
    const resources = await sql`SELECT id::text FROM resources ORDER BY id`
    const users = await sql`SELECT id::text FROM users ORDER BY id`
    const directories = await sql`SELECT id::text FROM directories ORDER BY id`
    return {
      resources: resources.map((r) => r.id),
      users: users.map((r) => r.id),
      directories: directories.map((r) => r.id),
    }
  })
}

export async function assertNoResidue(before, label) {
  const after = await snapshotIds()
  const problems = []
  for (const key of ['resources', 'users', 'directories']) {
    const b = new Set(before[key])
    const a = new Set(after[key])
    const added = [...a].filter((x) => !b.has(x))
    const removed = [...b].filter((x) => !a.has(x))
    if (added.length) problems.push(`${key} 新增 ${added.length} 行（探针没清干净）`)
    if (removed.length) problems.push(`${key} 少了 ${removed.length} 行（误删了既有数据）`)
  }
  if (problems.length) {
    throw new Error(`[${label}] 残留核对失败：\n  - ${problems.join('\n  - ')}`)
  }
}

/** 用系统 node 跑一个脚本（migrate / seed），失败即抛。 */
function runScript(relativePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, relativePath)], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${relativePath} 退出码 ${code}：\n${out}`))
    })
  })
}
