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

/**
 * 启动被测服务（跑编译产物）。
 *
 * ── 两道防线，都来自一次真实事故 ──────────────────────────────────────────
 * 阶段 3 我用探针脚本验证"停用目录"的修复时，连续三次都得到"没修好"的结论 ——
 * 而真正的原因是我的第一个探针**崩溃在 stopServer 之前**，于是一个**旧构建**的
 * 服务一直占着测试端口。之后每个探针的 startServer 都是"spawn 一个立刻因
 * EADDRINUSE 退出的子进程，然后对着那个旧进程做健康检查并成功返回"，
 * 于是所有断言都跑在旧代码上。
 *
 * 这种失败模式比"测试挂了"危险得多：它会**假绿**（新写的回归没被发现）。
 * 所以这里加两道防线：
 *   1. 启动前先探测端口：已经有东西在回应 → 立刻抛错，而不是继续跑；
 *   2. 健康检查必须返回**本次启动注入的 instanceId**，否则也是抛错。
 * 同时监听子进程退出，把它的 stderr 原样带进错误信息。
 */
/**
 * @param options.env 额外/覆盖的环境变量。
 *
 * 用途：阶段 6 的存储集成测试要让**被测服务**连到真的 S3 兼容后端，
 * 于是必须能往子进程里注入 STORAGE_PROVIDER=s3 与那四个连接参数。
 * 除此之外一律走下面的默认值 —— 默认值本身也是被测行为的一部分。
 */
export async function startServer(options = {}) {
  if (serverProcess) return

  // 防线 1：端口上已经有服务在回应 → 拒绝启动（几乎总是上一次没清干净）
  try {
    const probe = await fetch(`${TEST_BASE}/api/health`)
    if (probe.ok) {
      const body = await probe.json().catch(() => ({}))
      throw new Error(
        `测试端口 ${TEST_PORT} 上已经有一个服务在回应（instanceId=${body.instanceId ?? 'n/a'}）。\n` +
          '这几乎总是上一次运行没有清理干净 —— 如果就这样继续，所有断言都会跑在**旧代码**上。\n' +
          `请先执行：pkill -f "dist/server/main.js"`,
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('已经有一个服务在回应')) throw error
    // 连不上 = 端口空闲，正是我们要的
  }

  storageDir = mkdtempSync(join(tmpdir(), 'v2-storage-'))
  const instanceId = `v2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  serverProcess = spawn(process.execPath, [join(ROOT, 'dist/server/main.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      V2_ALLOW_DEV_SECRETS: '1',
      V2_INSTANCE_ID: instanceId,
      SERVER_PORT: String(TEST_PORT),
      DATABASE_URL: TEST_DB_URL,
      STORAGE_PROVIDER: 'local',
      STORAGE_LOCAL_DIR: storageDir,
      V2_DOWNLOAD_TTL_SECONDS: '60',
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logs = []
  serverProcess.stdout.on('data', (d) => logs.push(String(d)))
  serverProcess.stderr.on('data', (d) => logs.push(String(d)))

  /*
    ⚠️ 下面这两行不是可有可无的：子进程的 stdout/stderr 是**管道**，
    只要还有人在读，Node 的事件循环就一直"有活干"。
    于是当 `after` 钩子里的断言先抛了、`stopServer()` 被跳过时，
    测试进程会**永远不退出**（阶段 11 整跑时真的卡了 40 多分钟），
    而那个端口上还挂着一个旧服务，后面的套件会踩在它身上 ——
    表现是一堆"会话不对/资源不是自己的"这类看不懂的失败。

    处理：stream 与子进程都 unref（数据照收，只是不再吊着事件循环），
    再挂一个 exit 兜底：无论如何都要把服务杀掉。
  */
  serverProcess.stdout.unref?.()
  serverProcess.stderr.unref?.()
  serverProcess.unref?.()
  const killServerOnExit = () => {
    try {
      serverProcess?.kill('SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
  process.on('exit', killServerOnExit)

  let exited = null
  serverProcess.on('exit', (code, signal) => {
    exited = { code, signal }
  })

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `服务进程在启动后立刻退出（code=${exited.code} signal=${exited.signal}）：\n${logs.join('')}`,
      )
    }
    try {
      const res = await fetch(`${TEST_BASE}/api/health`)
      if (res.ok) {
        // 防线 2：必须是我刚启动的那一个
        const body = await res.json().catch(() => ({}))
        if (body.instanceId !== instanceId) {
          throw new Error(
            `端口 ${TEST_PORT} 上回应的是另一个服务（instanceId=${body.instanceId ?? 'n/a'}，` +
              `期望 ${instanceId}）。测试会跑在旧代码上，因此中止。`,
          )
        }
        return
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('回应的是另一个服务')) throw error
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error(`服务在 20 秒内没起来：\n${logs.join('')}`)
}

/**
 * 停掉被测服务，并**等到端口真的空出来**。
 *
 * 旧实现用的是 `kill('SIGTERM')` + sleep(300ms) + `if (!killed) kill('SIGKILL')`，
 * 而 `child.killed` 只表示"信号已发出"，不表示进程已退出 —— 于是 Nest 还没来得及
 * 优雅关闭时，SIGKILL 永远不会补上，进程留下来占着端口。这就是上面那次事故的直接原因。
 */
export async function stopServer() {
  if (serverProcess) {
    const child = serverProcess
    serverProcess = null
    const pid = child.pid
    child.kill('SIGTERM')

    const exited = await waitForExit(child, 3000)
    if (!exited) {
      child.kill('SIGKILL')
      await waitForExit(child, 3000)
    }
    // 再确认端口已释放；没释放就说清楚，而不是留给下一次运行去踩。
    for (let i = 0; i < 40; i += 1) {
      try {
        await fetch(`${TEST_BASE}/api/health`)
      } catch {
        break
      }
      await sleep(100)
    }
    void pid
  }
  if (storageDir) {
    rmSync(storageDir, { recursive: true, force: true })
    storageDir = null
  }
}

/** 等子进程真正退出（不是"信号已发出"）。 */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
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

/** 对外暴露：测试里要重跑 seed 来验证幂等性。 */
export function runProjectScript(relativePath) {
  return runScript(relativePath)
}

/**
 * 跑一个项目脚本并**返回它的输出**（失败即抛，带上输出便于定位）。
 *
 * 用于验证"运维真的会跑的那些脚本"（migrate / seed / cleanup-orphans）——
 * 只测接口不测脚本的话，清理脚本坏了也没人知道。
 */
export function runProjectScriptCaptured(relativePath, extraEnv = {}, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, relativePath), ...args], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL, ...extraEnv },
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

/**
 * 脚本的**拒绝路径**：返回退出码，而不是抛异常。
 *
 * 迁移里有一部分行为是"必须停下"（未知状态、无目录归属、声称有文件却没有源存储）。
 * 这些路径如果用"跑通就算过"的辅助函数去测，就等于没测 —— 它们本来就该失败。
 */
export function runProjectScriptFailure(relativePath, extraEnv = {}, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, relativePath), ...args], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (out += String(d)))
    child.on('close', (code) => resolve({ code, out }))
  })
}

/**
 * 本次运行的本地存储目录（由 `startServer` 创建并注入被测进程）。
 *
 * 用真实路径去断言"对象真的落盘了 / 真的被删掉了"——
 * 只看接口返回的话，"删除"完全可以只删数据库那一行。
 */
export function testStorageDir() {
  if (storageDir === null) throw new Error('startServer 还没跑，存储目录还不存在')
  return storageDir
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
