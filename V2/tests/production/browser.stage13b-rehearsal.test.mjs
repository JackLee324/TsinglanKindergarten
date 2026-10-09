/**
 * tests/production/browser.stage13b-rehearsal.test.mjs
 * ============================================================================
 * 业主 Stage 13B 的**部署环境**验收：对着已部署的 Docker 演练栈
 * （`https://v2.localhost:8443`，nginx + 真 PostgreSQL + 真对象存储）跑真实 Chrome。
 *
 * 为什么不能只跑 `tests/integration/browser.stage13b.test.mjs`：
 *   本地门禁跑的是**同一个 dist**，但存储是 local provider（对象落临时目录）、
 *   没有 nginx、没有 HTTPS、没有跨域直传、没有真实 S3 签名。
 *   "上传后资源不展示 / 文件打不开"这类故障恰恰**只**在这条链路上出现
 *   （历史上已经踩过两次：容器解析不了存储域名 → 登记 503；浏览器不信任存储证书 → 直传失败）。
 *   所以这里从教师**在界面里选文件**开始，一路验到数据库行、目录页可见、预览真实内容、
 *   下载哈希一致 —— 全部在部署环境上，而不是在测试替身上。
 *
 * 覆盖（对应业主点名的四件事）：
 *   ① 教师成长侧边栏：活动分支能收起、能再展开、点箭头不导航
 *   ② 上传：**界面选文件** → 详情页出现 → 数据库 `resources` / `resource_files` 两行都在
 *   ③ 可见性：回到**对应目录**就能看到自己的未发布资源（带「草稿」标签）；刷新后仍在
 *   ④ 打开文件：PNG/TXT/PDF 预览出真实内容；ZIP 点文件名直接下载且 sha256 与源文件一致
 *   ⑤ 失败路径：对象真的不存在时，预览必须报错（不许假成功）
 *   ⑥ 权限隔离：另一个只读老师看不到这条草稿（列表没有、详情 403）
 *   ⑦ 收尾：清掉本次夹具，资源计数回到基线
 *
 * 用法（本机演练）：
 *   PRODUCTION_BASE_URL=https://v2.localhost:8443 \
 *   PRODUCTION_ADMIN_USER=… PRODUCTION_ADMIN_PASSWORD=… \
 *   node --test tests/production/browser.stage13b-rehearsal.test.mjs
 *
 * ⚠️ 放在 `tests/production/`：它需要**一个已部署的环境**，`npm test` 的 glob 是
 *    `tests/integration/*`，所以它不会被顺带跑起来（与 stage12 那份同一个约定）。
 * ⚠️ 本文件会**写数据**（建一个验收用教师、传 4 个文件、最后全部清掉）。
 *    它只动自己造的东西：清理是 `purge`（硬删）那 4 条资源 + 撤销/停用验收账号。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { launchBrowser } from '../helpers/browser.mjs'
import { pdfBytes } from '../helpers/upload.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** macOS 上 Docker Desktop 的 CLI 不在 PATH 里，得自己找。 */
const DOCKER_CANDIDATE = '/Applications/Docker.app/Contents/Resources/bin/docker'

// ── 证书：自签 CA 必须在 **Node 启动前**进 NODE_EXTRA_CA_CERTS ────────────────
// （与 `deploy/verify.mjs` 同一个做法；在脚本里赋值太晚，fetch 的 TLS 上下文早就建好了。）
const CACERT = resolve(ROOT, process.env.STAGE13B_CACERT ?? 'deploy/tls/ca.pem')
if (existsSync(CACERT) && process.env.NODE_EXTRA_CA_CERTS !== CACERT) {
  const res = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CACERT },
  })
  process.exit(res.status ?? 1)
}

const BASE = (process.env.PRODUCTION_BASE_URL ?? '').replace(/\/+$/, '')
const ADMIN_USER = process.env.PRODUCTION_ADMIN_USER ?? ''
const ADMIN_PASSWORD = process.env.PRODUCTION_ADMIN_PASSWORD ?? ''
/**
 * 上传落到哪个目录（leaf folder，`allow_files = true`）。
 *
 * ⚠️ 用**演练库真实的 slug**：演练库是从 V1 迁过来的，根栏目是 `edu`
 * （本地 seed 树是 `education`）—— 照抄本地树的路径会在这里找不到节点。
 * 这个值由 `before` 里的目录树断言兜住：写错了就直接红，不会静默跳过。
 */
const TARGET_PATH = process.env.STAGE13B_DIRECTORY_PATH ?? 'edu/prek/virtue/lesson'
/** 对象存储（本机演练的 SeaweedFS 监听在 18443；容器走 s3.localhost:8443 代理）。 */
const S3_ENDPOINT = process.env.STAGE13B_S3_ENDPOINT ?? 'http://127.0.0.1:18443'

const WORK = mkdtempSync(join(tmpdir(), 'v2-stage13b-'))
const FILES_DIR = join(WORK, 'files')
const DOWNLOAD_DIR = join(WORK, 'downloads')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 验收账号：用户名固定（可重复运行），口令**每次随机**，永不进仓库。 */
const TEACHER_UI = { username: 's13b_ui_teacher', password: `S13bUi-${randomBytes(12).toString('hex')}!Aa1` }
const TEACHER_READ = { username: 's13b_read_teacher', password: `S13bRe-${randomBytes(12).toString('hex')}!Aa1` }

const FIXTURES = {
  png: { name: '阶段13B图片.png', mime: 'image/png', previewable: true },
  txt: { name: '阶段13B文本.txt', mime: 'text/plain', previewable: true },
  pdf: { name: '阶段13B预览.pdf', mime: 'application/pdf', previewable: true },
  zip: { name: '阶段13B压缩包.zip', mime: 'application/zip', previewable: false },
}

let browser
const ids = {}
let admin
let baseline = {}
let s3

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** 走真实接口的会话客户端（cookie + 双提交 CSRF），用于准备夹具与清理。 */
function apiClient(label) {
  let cookie = ''
  let csrf = ''
  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (name === 'v2_session') cookie = `v2_session=${value}`
      if (name === 'v2_csrf') {
        csrf = decodeURIComponent(value)
        cookie = `${cookie}; v2_csrf=${value}`
      }
    }
  }
  const call = async (method, path, body) => {
    const headers = {}
    if (cookie !== '') headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (method !== 'GET') headers['x-v2-csrf'] = csrf
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    })
    absorb(res)
    const text = await res.text()
    let data = text
    try {
      data = JSON.parse(text)
    } catch {
      // 保持文本（错误页/HTML 会让断言信息更有用）
    }
    return { status: res.status, data }
  }
  return {
    label,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p) => call('DELETE', p),
    login: async (username, password) => {
      const res = await call('POST', '/api/auth/login', { username, password })
      assert.ok(res.status < 400, `${label} 登录失败：HTTP ${res.status} ${JSON.stringify(res.data)}`)
      return res
    },
  }
}

/**
 * 在**浏览器**里发一次接口请求（用当前登录会话的 cookie + 双提交 CSRF）。
 *
 * 用处：验证"当前这个人"经真实接口能看到什么。比再造一个 Node 会话更省一次登录
 * （演练代理对登录限流 5r/m，测试自己反复登录会把自己挡在门外 —— 那是测试的问题）。
 */
async function apiInPage(method, path, body) {
  return browser.session.eval(`(async () => {
    const csrf = decodeURIComponent((document.cookie.match(/(?:^|; )v2_csrf=([^;]*)/) ?? ['', ''])[1] ?? '')
    const res = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: { 'Content-Type': 'application/json', 'x-v2-csrf': csrf },
      body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))},
      credentials: 'same-origin',
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = text.slice(0, 300) }
    return { status: res.status, data }
  })()`)
}

/** 直接查**演练库**（界面/接口说成功不算，这里看的是那一行）。 */
function dbQuery(sqlText) {
  const hasBundled = existsSync(DOCKER_CANDIDATE)
  const out = execFileSync(
    hasBundled ? DOCKER_CANDIDATE : 'docker',
    [
      'compose',
      '--env-file',
      '.env.deploy',
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -t -F "|"',
    ],
    {
      cwd: ROOT,
      input: sqlText,
      encoding: 'utf8',
      env: hasBundled
        ? { ...process.env, PATH: `${dirname(DOCKER_CANDIDATE)}:${process.env.PATH ?? ''}` }
        : process.env,
    },
  )
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
}

function dbCounts() {
  const [row] = dbQuery(`
    SELECT (SELECT count(*) FROM users),
           (SELECT count(*) FROM resources),
           (SELECT count(*) FROM resource_files),
           (SELECT count(*) FROM users WHERE role = 'ADMIN');`)
  const [users, resources, files, admins] = row.split('|').map(Number)
  return { users, resources, files, admins }
}

/** 登录并等应用外壳出现（演练的代理限流是 5r/m，所以本文件只在必要时登录）。 */
async function loginAs(username, password) {
  await browser.goto(`${BASE}/`)
  await browser.waitFor(
    `!!document.querySelector('[data-testid="login-page"]') || !!document.querySelector('[data-testid="logout-button"]')`,
    25000,
    '应用或登录页就绪',
  )
  if (await browser.exists('[data-testid="logout-button"]')) {
    await browser.click('[data-testid="logout-button"]')
    await browser.waitFor(`!!document.querySelector('[data-testid="login-page"]')`, 20000, '退出')
  }
  await browser.fill('[data-testid="login-username"]', username)
  await browser.fill('[data-testid="login-password"]', password)
  await browser.click('[data-testid="login-submit"]')
  await browser.waitFor(`!!document.querySelector('[data-testid="header"]')`, 30000, `登录 ${username}`)
}

/** 侧边栏某个节点的展开状态（读 DOM，不看内部 state）。 */
async function navState(url) {
  return browser.session.eval(`(() => {
    const btn = document.querySelector('[data-nav-toggle="${url}"]')
    const children = document.querySelector('[data-nav-children="${url}"]')
    return {
      hasToggle: btn !== null,
      expanded: btn ? btn.getAttribute('aria-expanded') === 'true' : null,
      childCount: children ? children.children.length : 0,
      rendered: children !== null,
    }
  })()`)
}

/** 走真实上传弹窗：点「上传」→ 填标题 → **选本地文件** → 提交 → 等详情页。 */
async function uploadThroughUi({ title, fixture }) {
  await browser.waitFor(`!!document.querySelector('[data-testid="directory-upload"]')`, 25000, '上传按钮')
  await browser.click('[data-testid="directory-upload"]')
  await browser.waitFor(`!!document.querySelector('[data-testid="upload-dialog"]')`, 20000, '上传弹窗')
  await browser.fill('[data-testid="upload-title"]', title)
  await browser.setFileInput('[data-testid="upload-file-input"]', fixture.path)
  await browser.click('[data-testid="upload-submit"]')
  await browser.waitFor(`!!document.querySelector('[data-testid="resource-detail-page"]')`, 60000, '上传后进入详情页')
  const id = await browser.attr('[data-testid="resource-detail-page"]', 'data-resource-id')
  assert.equal(typeof id === 'string' && id.length > 0, true, '详情页必须带资源 id')
  return id
}

/** 详情页里某个文件行的操作按钮（按文件名定位）。 */
async function clickFileName() {
  await browser.waitFor(`!!document.querySelector('[data-testid="file-name"]')`, 25000, '文件名')
  await browser.click('[data-testid="file-name"]')
}

before(async () => {
  if (BASE === '') throw new Error('需要 PRODUCTION_BASE_URL（对着已部署的演练环境跑）')
  if (ADMIN_USER === '' || ADMIN_PASSWORD === '') {
    throw new Error('需要 PRODUCTION_ADMIN_USER / PRODUCTION_ADMIN_PASSWORD（演练的超级管理员）')
  }
  assert.equal(BASE.startsWith('https://'), true, '验收环境必须是 https://')

  mkdirSync(FILES_DIR, { recursive: true })
  mkdirSync(DOWNLOAD_DIR, { recursive: true })

  FIXTURES.png.bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8Dwn4GBgYGRAQoAAB0hAwH8g0m6AAAAAElFTkSuQmCC',
    'base64',
  )
  FIXTURES.txt.bytes = Buffer.from('阶段 13B 演练环境验收：纯文本内容\n第二行：从界面选文件上传后必须能按文本渲染。\n', 'utf8')
  FIXTURES.pdf.bytes = pdfBytes('stage13b-rehearsal-preview')
  FIXTURES.zip.bytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
    Buffer.from('stage13b rehearsal zip fixture\n'.repeat(8)),
  ])
  for (const f of Object.values(FIXTURES)) {
    f.sha256 = sha256(f.bytes)
    f.path = join(FILES_DIR, f.name)
    writeFileSync(f.path, f.bytes)
  }

  // 对象存储客户端：只用来删**本文件自己刚传上去的**那个对象（验证失败路径）。
  const env = Object.fromEntries(
    readFileSync(join(ROOT, '.env.deploy'), 'utf8')
      .split('\n')
      .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  )
  ids.bucket = env.STORAGE_BUCKET
  s3 = new S3Client({
    region: 'auto',
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: env.STORAGE_ACCESS_KEY, secretAccessKey: env.STORAGE_SECRET_KEY },
  })

  baseline = dbCounts()
  assert.equal(baseline.admins, 1, `演练环境必须只有一名管理员，实际 ${baseline.admins}`)

  browser = await launchBrowser()
  await browser.enableDownloads(DOWNLOAD_DIR)
  await browser.startProblemWatch()

  // 夹具账号与授权：全部走**线上接口**（因此会落审计、走真实权限门槛）。
  admin = apiClient('管理员')
  await admin.login(ADMIN_USER, ADMIN_PASSWORD)

  const tree = await admin.get('/api/directories/tree')
  assert.equal(tree.status, 200, JSON.stringify(tree.data))
  // ⚠️ `/api/directories/tree` 返回的是 `{ roots: [...] }`，不是根节点本身。
  //    第一版把整个响应当根节点压栈，于是"一个节点都没遍历到"，
  //    表现为找不到目录 —— 目录树断言在这里是**故意**兜住这种低级错误的。
  const stack = [...(tree.data.roots ?? [])]
  assert.ok(stack.length > 0, `目录树是空的：${JSON.stringify(tree.data).slice(0, 200)}`)
  let node = null
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur.path === TARGET_PATH) node = cur
    for (const child of cur.children ?? []) stack.push(child)
  }
  assert.ok(node, `目录树里找不到 ${TARGET_PATH}`)
  assert.equal(node.allowFiles, true, `${TARGET_PATH} 必须允许放文件（否则上传会被服务端拒）`)
  ids.dir = { id: node.id, path: node.path, name: node.name }
})

after(async () => {
  try {
    if (browser) await browser.close()
  } finally {
    rmSync(WORK, { recursive: true, force: true })
  }
})

/** 建（或复用）一个教师账号，并整份替换它的授权。 */
async function ensureTeacher(account, grants, label) {
  // 先查再建：本文件要能**重复运行**，而重复运行时账号已经存在，
  // 直接 POST 会拿到 409（那会在浏览器/网络面板上留下一条无意义的 4xx）。
  const list = await admin.get(`/api/users?q=${encodeURIComponent(account.username)}&pageSize=100`)
  assert.equal(list.status, 200, `列账号失败：${JSON.stringify(list.data)}`)
  const found = list.data.items.find((u) => u.username === account.username)
  let id = found?.id
  if (found === undefined) {
    const created = await admin.post('/api/users', {
      name: label,
      username: account.username,
      password: account.password,
      role: 'TEACHER',
    })
    assert.equal(created.status, 201, `建账号失败：${JSON.stringify(created.data)}`)
    id = created.data.id
  } else {
    // 复用：重置口令并确保是启用的（上一次运行收尾时停用过它）
    const reset = await admin.patch(`/api/users/${id}`, { password: account.password, active: true })
    assert.equal(reset.status, 200, `重置口令失败：${JSON.stringify(reset.data)}`)
  }
  const perms = await admin.put(`/api/users/${id}/permissions`, { permissions: grants })
  assert.equal(perms.status, 200, `授权失败：${JSON.stringify(perms.data)}`)
  return id
}

describe('① 教师成长侧边栏的展开/收起（业主 Stage 13B §3）', () => {
  test('活动分支可以收起、可以再展开，点箭头不导航', async () => {
    await loginAs(ADMIN_USER, ADMIN_PASSWORD)
    await browser.goto(`${BASE}/directory/growth/l1/safety`)
    await browser.waitFor(`!!document.querySelector('[data-nav-toggle="/directory/growth"]')`, 30000, '导航就绪')

    const initial = await navState('/directory/growth')
    assert.equal(initial.expanded, true, `进入该分支后应自动展开：${JSON.stringify(initial)}`)
    assert.ok(initial.childCount > 0, '展开时必须真的有子节点渲染出来')

    await browser.click('[data-nav-toggle="/directory/growth"]')
    await browser.waitFor(
      `document.querySelector('[data-nav-toggle="/directory/growth"]').getAttribute('aria-expanded') === 'false'`,
      10000,
      '收起',
    )
    assert.equal((await navState('/directory/growth')).rendered, false, '收起后子节点必须从 DOM 消失')

    const urlBefore = await browser.url()
    await browser.click('[data-nav-toggle="/directory/growth"]')
    await browser.waitFor(
      `document.querySelector('[data-nav-toggle="/directory/growth"]').getAttribute('aria-expanded') === 'true'`,
      10000,
      '再次展开',
    )
    assert.ok((await navState('/directory/growth')).childCount > 0, '再次展开后子节点回来了')
    assert.equal(await browser.url(), urlBefore, '点箭头只能切换展开状态，不能导航')

    // 收起之后**不会**因为"当前就在这里"被自动重新展开
    await browser.click('[data-nav-toggle="/directory/growth"]')
    await new Promise((r) => setTimeout(r, 600))
    assert.equal((await navState('/directory/growth')).expanded, false, '用户收起后必须保持收起')
  })
})

describe('② 从界面选文件上传 → 数据库真的多了一行（业主 Stage 13B §4）', () => {
  test('准备验收账号（建/复用 + 授权）', async () => {
    const grants = [
      { permission: 'resource.view', directoryId: ids.dir.id },
      { permission: 'resource.create', directoryId: ids.dir.id },
      { permission: 'resource.update.own', directoryId: ids.dir.id },
      { permission: 'resource.download', directoryId: ids.dir.id },
      { permission: 'resource.submit', directoryId: ids.dir.id },
    ]
    ids.teacherUi = await ensureTeacher(TEACHER_UI, grants, '阶段13B验收教师')
    // 只读教师：**能进这个目录**，但没有上传权 —— 用来验隔离
    ids.teacherRead = await ensureTeacher(
      TEACHER_READ,
      [
        { permission: 'resource.view', directoryId: ids.dir.id },
        { permission: 'resource.download', directoryId: ids.dir.id },
      ],
      '阶段13B只读教师',
    )
    const listed = await admin.get(`/api/users/${ids.teacherUi}/permissions`)
    assert.equal(listed.status, 200, JSON.stringify(listed.data))
    assert.equal(listed.data.items.length, grants.length, `授权条数不对：${JSON.stringify(listed.data.items)}`)
  })

  test('教师在界面上选文件上传：详情页出现、数据库两行都在、sha256 与源文件一致', async () => {
    await loginAs(TEACHER_UI.username, TEACHER_UI.password)

    for (const [key, fixture] of Object.entries(FIXTURES)) {
      const title = `阶段13B验收-${key}`
      await browser.goto(`${BASE}/directory/${ids.dir.path}`)
      await browser.waitFor(`!!document.querySelector('[data-testid="directory-upload"]')`, 30000, `${key}：上传入口`)
      const resourceId = await uploadThroughUi({ title, fixture })
      ids[key] = { resourceId, title, fixture }

      // 界面说成功不算：数据库里必须真的有这两行
      const rows = dbQuery(`
        SELECT r.status, d.id::text, f.file_name, f.size, f.sha256, f.storage_key, f.mime_type
        FROM resources r
        JOIN directories d ON d.id = r.directory_id
        JOIN resource_files f ON f.resource_id = r.id
        WHERE r.id = '${resourceId}';`)
      assert.equal(rows.length, 1, `${key}：数据库里应当有 1 行（资源 + 文件），实际 ${rows.length}`)
      const [status, dirId, fileName, size, sha, storageKey, mime] = rows[0].split('|')
      assert.equal(status, 'DRAFT', `${key}：新上传必须是草稿`)
      assert.equal(dirId, ids.dir.id, `${key}：必须落在**界面上选的那个**目录里（不是别处）`)
      assert.equal(fileName, fixture.name, `${key}：文件名要原样存下来`)
      assert.equal(Number(size), fixture.bytes.length, `${key}：字节数要一致`)
      assert.equal(sha, fixture.sha256, `${key}：**数据库里的 sha256 必须等于源文件**`)
      assert.ok(storageKey.length > 10, `${key}：storage_key 不能是空的`)
      assert.equal(mime, fixture.mime, `${key}：mime 要按上传时声明的保存`)
    }
  })
})

describe('③ 上传后的资源在对应目录里看得见（业主 Stage 13B §4 的核心症状）', () => {
  test('回到目录页：自己的草稿在「我的未发布资源」里，带「草稿」标签；刷新后仍在', async () => {
    await browser.goto(`${BASE}/directory/${ids.dir.path}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="my-unpublished-section"]')`, 30000, '未发布区域')
    const shown = await browser.session.eval(`(() => ({
      titles: [...document.querySelectorAll('[data-testid="my-unpublished-card"] [data-testid="resource-card-title"]')].map((e) => e.innerText.trim()),
      statuses: [...document.querySelectorAll('[data-testid="my-unpublished-card"] [data-testid="resource-card-status"]')].map((e) => e.innerText.trim()),
      publicTitles: [...document.querySelectorAll('[data-testid="resource-list"] [data-testid="resource-card-title"]')].map((e) => e.innerText.trim()),
    }))()`)

    for (const key of Object.keys(FIXTURES)) {
      assert.ok(
        shown.titles.includes(ids[key].title),
        `${key}：本人应当在自己的未发布区域里看到它，实际：${JSON.stringify(shown.titles)}`,
      )
    }
    assert.equal(new Set(shown.statuses).size, 1, `状态标签应当都是草稿：${JSON.stringify(shown.statuses)}`)
    assert.equal(shown.statuses[0], '草稿', `状态标签要如实：${JSON.stringify(shown.statuses)}`)
    assert.equal(
      shown.publicTitles.some((t) => t.startsWith('阶段13B验收-')),
      false,
      `未发布的资源不能出现在公开列表里：${JSON.stringify(shown.publicTitles)}`,
    )

    // 刷新（真实 reload）之后仍然在 —— 不是"前端内存里的假象"
    await browser.reload()
    await browser.waitFor(`!!document.querySelector('[data-testid="my-unpublished-section"]')`, 30000, '刷新后仍在')
    const after = await browser.session.eval(
      `[...document.querySelectorAll('[data-testid="my-unpublished-card"] [data-testid="resource-card-title"]')].map((e) => e.innerText.trim())`,
    )
    for (const key of Object.keys(FIXTURES)) {
      assert.ok(after.includes(ids[key].title), `${key}：刷新后仍要看得见，实际：${JSON.stringify(after)}`)
    }
  })
})

describe('④ 打开文件：预览出真内容、下载哈希一致（业主 Stage 13B §5.1）', () => {
  test('PNG：点文件名 → 图片真的解码显示', async () => {
    await browser.goto(`${BASE}/resources/${ids.png.resourceId}`)
    await clickFileName()
    await browser.waitFor(`!!document.querySelector('[data-testid="file-preview-image"]')`, 30000, '图片预览')
    const loaded = await browser.session.eval(
      `(() => { const img = document.querySelector('[data-testid="file-preview-image"]'); return !!img && img.complete && img.naturalWidth > 0 })()`,
    )
    assert.equal(loaded, true, '图片必须真的解码出来（坏图也会有一个 <img> 元素）')
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('TXT：点文件名 → 预览里出现**文件真实内容**', async () => {
    await browser.goto(`${BASE}/resources/${ids.txt.resourceId}`)
    await clickFileName()
    await browser.waitFor(`!!document.querySelector('[data-testid="file-preview-text"]')`, 30000, '文本预览')
    const text = await browser.text('[data-testid="file-preview-text"]')
    assert.match(text, /阶段 13B 演练环境验收：纯文本内容/, `预览必须是文件真实内容：${text.slice(0, 120)}`)
    assert.match(text, /第二行/, '多行内容都要在')
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('PDF：点文件名 → 预览框真的取到了 PDF 字节（%PDF 头）', async () => {
    await browser.goto(`${BASE}/resources/${ids.pdf.resourceId}`)
    await clickFileName()
    await browser.waitFor(`!!document.querySelector('[data-testid="file-preview-pdf"]')`, 30000, 'PDF 预览')
    const src = await browser.attr('[data-testid="file-preview-pdf"]', 'src')
    assert.ok(typeof src === 'string' && src.length > 0, 'PDF 预览必须有 src')
    const res = await fetch(new URL(src, BASE).toString())
    assert.equal(res.status, 200, `PDF 预览地址必须可取：HTTP ${res.status}`)
    const head = Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString('latin1')
    assert.equal(head, '%PDF-', `取回来的必须是真 PDF（头是 ${JSON.stringify(head)}）`)
    await browser.click('[data-testid="file-preview-close"]')
  })

  test('ZIP：点文件名 → 直接下载，sha256 与源文件一致；没有预览按钮', async () => {
    await browser.goto(`${BASE}/resources/${ids.zip.resourceId}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="file-row"]')`, 30000, '文件行')
    assert.equal(await browser.exists('[data-testid="file-preview"]'), false, 'ZIP 不该有预览按钮')
    assert.equal(await browser.exists('[data-testid="file-preview-unsupported"]'), true, '要说明不支持在线预览')

    await browser.click('[data-testid="file-name"]')
    const saved = await browser.waitForDownload(DOWNLOAD_DIR, (n) => n.endsWith('.zip'), 60000)
    const bytes = readFileSync(saved)
    assert.equal(bytes.length, ids.zip.fixture.bytes.length, '下载字节数要一致')
    assert.equal(sha256(bytes), ids.zip.fixture.sha256, '**下载内容的 sha256 必须等于源文件**')
    rmSync(saved, { force: true })
  })
})

describe('⑤ 失败路径：对象真的不存在时必须报错，不许假成功', () => {
  test('把 TXT 的对象删掉后：预览报错、不渲染"内容"、给得出重试', async () => {
    const [storageKey] = dbQuery(
      `SELECT storage_key FROM resource_files WHERE resource_id = '${ids.txt.resourceId}';`,
    )
    assert.ok(storageKey && storageKey.length > 10, `要拿得到 storage_key：${storageKey}`)
    await s3.send(new DeleteObjectCommand({ Bucket: ids.bucket, Key: storageKey }))
    await assert.rejects(
      () => s3.send(new HeadObjectCommand({ Bucket: ids.bucket, Key: storageKey })),
      (err) => {
        assert.equal(
          err?.$metadata?.httpStatusCode,
          404,
          `对象必须真的被删掉（HeadObject 应当 404，实际 ${err?.$metadata?.httpStatusCode} ${err?.name}）：${storageKey}`,
        )
        return true
      },
    )

    await browser.goto(`${BASE}/resources/${ids.txt.resourceId}`)
    await clickFileName()
    await browser.waitFor(`!!document.querySelector('[data-testid="file-preview-error"]')`, 30000, '预览错误提示')
    const message = await browser.text('[data-testid="file-preview-error"]')
    assert.match(message, /无法读取|失败|不存在|过期/, `错误信息要可读：${message}`)
    assert.equal(
      await browser.exists('[data-testid="file-preview-text"]'),
      false,
      '对象不存在时不能渲染出"内容"（那正是假成功）',
    )
    assert.equal(await browser.exists('[data-testid="file-preview-retry"]'), true, '要给得出重试入口')
    await browser.click('[data-testid="file-preview-close"]')
  })
})

describe('⑥ 权限隔离：别人看不到这条草稿', () => {
  test('只读教师：列表里没有，详情 403，目录页没有那块区域', async () => {
    // 换成只读教师（能进这个目录，但没有上传权）
    await loginAs(TEACHER_READ.username, TEACHER_READ.password)

    const list = await apiInPage('GET', `/api/resources?directoryId=${ids.dir.id}&pageSize=100`)
    assert.equal(list.status, 200, JSON.stringify(list.data))
    assert.equal(
      list.data.items.some((r) => r.title.startsWith('阶段13B验收-')),
      false,
      `别人的草稿不能出现在列表里：${JSON.stringify(list.data.items.map((r) => r.title))}`,
    )
    const detail = await apiInPage('GET', `/api/resources/${ids.png.resourceId}`)
    assert.equal(detail.status, 403, `别人的草稿详情必须 403，实际 ${detail.status}`)

    // 浏览器里也不能有：看同一个目录页
    await browser.goto(`${BASE}/directory/${ids.dir.path}`)
    await browser.waitFor(`!!document.querySelector('[data-testid="directory-page"]')`, 30000, '目录页')
    assert.equal(
      await browser.exists('[data-testid="my-unpublished-section"]'),
      false,
      '自己的未发布区域不该出现（他没有未发布资源）',
    )
    const titles = await browser.allTexts('[data-testid="resource-card-title"]')
    assert.equal(
      titles.some((t) => t.startsWith('阶段13B验收-')),
      false,
      `目录页也不能出现别人的草稿：${JSON.stringify(titles)}`,
    )
  })
})

describe('⑦ 收尾：清掉本次夹具，计数回到基线', () => {
  test('purge 4 条资源 + 停用验收账号；资源与文件计数回到基线', async () => {
    for (const key of Object.keys(FIXTURES)) {
      const { resourceId } = ids[key]
      const soft = await admin.del(`/api/resources/${resourceId}`)
      assert.ok([200, 204].includes(soft.status), `${key}：移到回收站失败 ${soft.status} ${JSON.stringify(soft.data)}`)
      const purged = await admin.post(`/api/resources/${resourceId}/purge`)
      assert.ok([200, 201, 204].includes(purged.status), `${key}：硬删失败 ${purged.status} ${JSON.stringify(purged.data)}`)
    }
    for (const id of [ids.teacherUi, ids.teacherRead]) {
      await admin.put(`/api/users/${id}/permissions`, { permissions: [] })
      const off = await admin.patch(`/api/users/${id}`, { active: false })
      assert.equal(off.status, 200, `停用验收账号失败：${JSON.stringify(off.data)}`)
    }

    const rows = dbQuery(
      `SELECT id FROM resources WHERE title LIKE '阶段13B验收-%';`,
    )
    assert.deepEqual(rows, [], `验收资源必须真的被删掉：${JSON.stringify(rows)}`)
    const after = dbCounts()
    assert.equal(after.resources, baseline.resources, `资源计数要回到基线：${JSON.stringify({ baseline, after })}`)
    assert.equal(after.files, baseline.files, `文件计数要回到基线：${JSON.stringify({ baseline, after })}`)
    assert.equal(after.admins, 1, '全程不能多出管理员')
  })

  test('过程中没有未登记的浏览器错误（网络/控制台）', async () => {
    // `problemReport` 返回的是**过滤后的数组**；`allow` 按子串匹配 URL / 文本。
    // 这里登记的每一条都必须说得出理由：
    //   1) `/api/auth/me` 的 401 —— **设计如此**：启动时探测"我是谁"，
    //      未登录就是 401，前端把它标成 `skipAuthRedirect`（`client/src/api/auth.ts`），
    //      本文件中途登出登入，所以这个 401 一定会出现；
    //   2) `s3.localhost` —— ⑤ 故意删掉对象后，预览去读它必然 404，那正是被测行为；
    //   3) 草稿资源 id —— ⑥ 只读教师取别人的草稿详情必然 403，那也是断言的一部分。
    const problems = browser.problemReport({
      allow: ['/api/auth/me', 's3.localhost', ids.png.resourceId],
    })
    assert.deepEqual(
      problems,
      [],
      `浏览器里出现了未登记的错误：${JSON.stringify(problems, null, 2)}`,
    )
  })
})
