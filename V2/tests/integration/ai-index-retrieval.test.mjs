/**
 * tests/integration/ai-index-retrieval.test.mjs
 *   —— 索引流水线 + 权限边界（Stage 15 的核心安全属性）
 * ============================================================================
 * 业主 Stage 15 §六 的硬要求：AI 检索必须经过 `AuthorizationService` 的目录权限，
 * 未发布资源 / 别人的草稿 / 无权目录**绝不能**因为"曾经进过索引"而泄露。
 * §八：索引异步、失败不影响上传；§五：不支持的格式如实记录、重复索引幂等。
 *
 * 这份测试用**真实应用进程**（含索引 worker）+ 真实数据库 + 真实本地存储跑：
 *   · 造三条内容相近、权限不同的资源（可见 / 别人的草稿 / 我的授权之外）；
 *   · 让 worker 真的去读对象、提取文字、写片段；
 *   · 再用 `scripts/ai-index.mjs search`（**同一份检索实现**）以不同身份查，
 *     并与 `/api/resources` 的结果相互比对。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ROOT,
  TEST_DB_URL,
  client,
  createAdmin,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { makeResource, purgeResources } from '../helpers/resource-fixture.mjs'

const SCRIPT = join(ROOT, 'scripts', 'ai-index.mjs')

/**
 * 只取检索**结果行**（`   · [来源] …` 以及紧随其后的片段摘要）。
 * 为什么不能直接扫整个输出：CLI 会把查询词回显在一行里（"以 X 检索「查询词」"），
 * 直接 `doesNotMatch(out, 关键词)` 会因为回显而假红 —— 断言必须落在结果上。
 */
function resultLines(output) {
  return output
    .split('\n')
    .filter((line) => /^\s+·\s\[/.test(line) || /^\s{4,}\S/.test(line))
    .join('\n')
}
const KEYWORD_VISIBLE = '紫藤花主题'
const KEYWORD_DRAFT = '草稿里的秘密'
const KEYWORD_OTHER_TRACK = '别的学段的秘密'

let storageDir
let resources = {}
let fileIds = {}
const probes = []

/** 直接调 CLI：与线上跑的是同一份索引/检索实现，不复制逻辑。 */
function aiCli(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      V2_ALLOW_DEV_SECRETS: '1',
      STORAGE_PROVIDER: 'local',
      STORAGE_LOCAL_DIR: storageDir,
      ...extraEnv,
    },
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/** 把字节写进"本地存储"里那个 key 应该在的位置（模拟一份已存在的对象）。 */
function putObject(storageKey, content) {
  const full = join(storageDir, storageKey)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** 造一条带文件的资源：资源行 + 文件行 + 真实对象。 */
async function makeResourceWithFile({ directoryId, uploaderId, title, status, fileName, mimeType, content }) {
  const resourceId = await makeResource({ directoryId, uploaderId, title, status })
  const storageKey = `resources/${resourceId}/probe-${fileName}`
  const sha256 = (await import('node:crypto')).createHash('sha256').update(content).digest('hex')
  const fileId = await withSql(async (sql) => {
    const rows = await sql`
      INSERT INTO resource_files (resource_id, file_name, storage_key, mime_type, size, sha256, created_by)
      VALUES (${resourceId}, ${fileName}, ${storageKey}, ${mimeType}, ${content.byteLength}, ${sha256}, ${uploaderId})
      RETURNING id::text
    `
    return rows[0].id
  })
  putObject(storageKey, content)
  probes.push(resourceId)
  return { resourceId, fileId }
}

/** 直接入队（模拟上传登记成功后的那次入队）。 */
async function enqueue(resourceId, fileId, reason = 'BACKFILL') {
  await withSql(async (sql) => {
    await sql`
      INSERT INTO ai_index_jobs (resource_id, file_id, reason)
      VALUES (${resourceId}, ${fileId}, ${reason}) ON CONFLICT DO NOTHING
    `
  })
}

/** 等 worker 把队列跑空（真实进程里的 worker，不是测试里手动跑）。 */
async function waitForJobsSettled(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await withSql(async (sql) => {
      return await sql`SELECT count(*)::int AS n FROM ai_index_jobs WHERE state IN ('PENDING','RUNNING')`
    })
    if (row.n === 0) return
    if (Date.now() > deadline) throw new Error(`等 worker 超时：还有 ${row.n} 个任务没结束`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

describe('AI 索引与权限检索', () => {
  before(async () => {
    await resetDatabase()
    storageDir = mkdtempSync(join(tmpdir(), 'v2-ai-storage-'))
    await createAdmin('ai_admin', 'AiAdminPass!1')
    const preK = await directoryIdByPath('education/pre-k')
    // 教师 A：只有 Pre-K 子树权限（K 学段的资源对他不可见）
    await createTeacher(
      'ai_teacher_a',
      'AiTeacherPass!1',
      [
        { permission: 'resource.view', directoryId: preK },
        { permission: 'resource.update.own', directoryId: preK },
      ],
      '权限甲老师',
    )
    const teacherB = await createTeacher(
      'ai_teacher_b',
      'AiTeacherPass!2',
      [{ permission: 'resource.view', directoryId: await directoryIdByPath('education') }],
      '权限乙老师',
    )

    const virtueResources = await directoryIdByPath('education/pre-k/virtue/resources')
    const kReading = await directoryIdByPath('education/k/chinese/arts/resources')

    // 三条内容相似、权限不同的资源
    const visible = await makeResourceWithFile({
      directoryId: virtueResources,
      uploaderId: teacherB.id,
      title: '主题教学素材',
      status: 'PUBLISHED',
      fileName: '主题素材.txt',
      mimeType: 'text/plain',
      // 故意写长（> maxChunkChars=800）→ 会切成多片；后面"内容变短"才测得出 STALE
      content: Buffer.from(
        `${KEYWORD_VISIBLE}：用落叶与藤蔓做拼贴，讨论颜色变化。\n\n` +
          Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 段：请小朋友观察叶脉的走向，用不同颜色记录自己的发现，并说明理由。`).join('\n\n'),
        'utf8',
      ),
    })
    resources.visible = visible.resourceId
    fileIds.visible = visible.fileId

    const draft = await makeResourceWithFile({
      directoryId: virtueResources,
      uploaderId: teacherB.id,
      title: '乙老师的草稿',
      status: 'DRAFT',
      fileName: '草稿.txt',
      mimeType: 'text/plain',
      content: Buffer.from(`${KEYWORD_DRAFT}：这条还没提交审核。`, 'utf8'),
    })
    resources.draft = draft.resourceId
    fileIds.draft = draft.fileId

    const otherTrack = await makeResourceWithFile({
      directoryId: kReading,
      uploaderId: teacherB.id,
      title: 'K 学段已发布',
      status: 'PUBLISHED',
      fileName: 'k.txt',
      mimeType: 'text/plain',
      content: Buffer.from(`${KEYWORD_OTHER_TRACK}：甲老师没有 K 学段的授权。`, 'utf8'),
    })
    resources.otherTrack = otherTrack.resourceId
    fileIds.otherTrack = otherTrack.fileId

    // 一条图片资源：OCR 未配置（测试环境没有密钥）→ 应当被记为 SKIPPED
    const image = await withSql(async (sql) => {
      const resourceId = await makeResource({
        directoryId: virtueResources,
        uploaderId: teacherB.id,
        title: '扫描的教案照片',
        status: 'PUBLISHED',
      })
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)])
      const storageKey = `resources/${resourceId}/probe-scan.png`
      const sha256 = (await import('node:crypto')).createHash('sha256').update(png).digest('hex')
      const rows = await sql`
        INSERT INTO resource_files (resource_id, file_name, storage_key, mime_type, size, sha256, created_by)
        VALUES (${resourceId}, '扫描.png', ${storageKey}, 'image/png', ${png.byteLength}, ${sha256}, ${teacherB.id})
        RETURNING id::text
      `
      putObject(storageKey, png)
      probes.push(resourceId)
      return { resourceId, fileId: rows[0].id }
    })
    resources.image = image.resourceId
    fileIds.image = image.fileId

    // 索引 worker 跑快一点（默认 15 秒；这里 1 秒，且启动后立刻跑一轮）
    await startServer({
      env: { STORAGE_LOCAL_DIR: storageDir, AI_INDEX_INTERVAL_MS: '1000', AI_INDEX_BATCH: '5' },
    })
  })

  after(async () => {
    await purgeResources(probes)
    await withSql(async (sql) => {
      await sql`DELETE FROM ai_chunks`
      await sql`DELETE FROM ai_index_jobs`
    })
    await stopServer()
  })

  test('① 上传后的文件被异步索引：worker 真的读对象、提取文字、写片段', async () => {
    await enqueue(resources.visible, fileIds.visible, 'UPLOADED')
    await enqueue(resources.visible, null, 'UPLOADED')
    await waitForJobsSettled()

    const chunks = await withSql(async (sql) => {
      return await sql`
        SELECT source_kind, text, status FROM ai_chunks
        WHERE resource_id = ${resources.visible} ORDER BY source_kind, chunk_index
      `
    })
    assert.equal(chunks.length > 0, true, '应当写入片段')
    const fileChunk = chunks.find((c) => c.source_kind === 'FILE_TEXT')
    assert.ok(fileChunk, `应当有 FILE_TEXT 片段：${JSON.stringify(chunks)}`)
    assert.match(fileChunk.text, new RegExp(KEYWORD_VISIBLE))
    assert.equal(fileChunk.status, 'READY')
    const metaChunk = chunks.find((c) => c.source_kind === 'RESOURCE_META')
    assert.ok(metaChunk, '应当同时有资源元数据片段（标题/目录/文件名）')
    assert.match(metaChunk.text, /主题教学素材/)
  })

  test('② 图片没有 OCR 时如实记为 SKIPPED（不是假装成功），且原文件与资源毫发无损', async () => {
    await enqueue(resources.image, fileIds.image, 'UPLOADED')
    await waitForJobsSettled()

    const [job] = await withSql(async (sql) => {
      return await sql`
        SELECT state, last_error FROM ai_index_jobs
        WHERE file_id = ${fileIds.image} ORDER BY id DESC LIMIT 1
      `
    })
    assert.equal(job.state, 'SKIPPED')
    assert.match(String(job.last_error), /OCR_DISABLED/)

    // 文件引用与资源都还在（索引失败不该动任何业务数据）
    const [file] = await withSql(async (sql) => {
      return await sql`SELECT count(*)::int AS n FROM resource_files WHERE id = ${fileIds.image}`
    })
    assert.equal(file.n, 1)
    const [resource] = await withSql(async (sql) => {
      return await sql`SELECT status FROM resources WHERE id = ${resources.image}`
    })
    assert.equal(resource.status, 'PUBLISHED')
  })

  test('③ 权限边界：教师检索不到别人的草稿、也检索不到自己无权目录里的已发布内容', async () => {
    // 先把三条内容都索引掉
    for (const key of ['visible', 'draft', 'otherTrack']) {
      await enqueue(resources[key], fileIds[key], 'BACKFILL')
    }
    await waitForJobsSettled()

    const draftsAsTeacherB = aiCli(['search', '--user', 'ai_teacher_b', '--query', KEYWORD_DRAFT])
    assert.equal(draftsAsTeacherB.status, 0, draftsAsTeacherB.out)
    assert.match(draftsAsTeacherB.out, new RegExp(KEYWORD_DRAFT), '上传者自己能检索到自己的草稿')

    // 教师 A：三条关键词都不是"看不到"或"看不到别人的"
    const asA = {
      visible: aiCli(['search', '--user', 'ai_teacher_a', '--query', KEYWORD_VISIBLE]),
      draft: aiCli(['search', '--user', 'ai_teacher_a', '--query', KEYWORD_DRAFT]),
      otherTrack: aiCli(['search', '--user', 'ai_teacher_a', '--query', KEYWORD_OTHER_TRACK]),
    }
    assert.equal(asA.visible.status, 0, asA.visible.out)
    assert.match(resultLines(asA.visible.out), new RegExp(KEYWORD_VISIBLE), '已发布且有授权 → 应该检索得到')
    assert.doesNotMatch(resultLines(asA.draft.out), new RegExp(KEYWORD_DRAFT), '别的老师的草稿绝不能检索到')
    assert.doesNotMatch(resultLines(asA.otherTrack.out), new RegExp(KEYWORD_OTHER_TRACK), '无权学段的内容绝不能检索到')
    // 而且不是"命中后又被过滤掉"：候选集里压根没有
    assert.match(asA.draft.out, /命中 0 条/)
    assert.match(asA.otherTrack.out, /命中 0 条/)
  })

  test('④ 与 /api/resources 一致：AI 检索到的资源必须都在这个账号的可见列表里', async () => {
    const c = client()
    await c.login('ai_teacher_a', 'AiTeacherPass!1')
    const list = await c.get('/api/resources?pageSize=100')
    assert.equal(list.status, 200, JSON.stringify(list.data))
    const visibleIds = new Set(list.data.items.map((item) => item.id))
    assert.equal(visibleIds.has(resources.visible), true)
    assert.equal(visibleIds.has(resources.draft), false, '草稿不该出现在列表里')
    assert.equal(visibleIds.has(resources.otherTrack), false, '无权学段的资源不该出现在列表里')

    // 反向核对：检索结果里的资源 id 都必须在可见列表里
    const search = aiCli(['search', '--user', 'ai_teacher_a', '--query', '主题', '--limit', '20'])
    assert.equal(search.status, 0, search.out)
    for (const match of search.out.matchAll(/\/resources\/([0-9a-f-]{36})/g)) {
      assert.equal(visibleIds.has(match[1]), true, `检索返回了不可见资源：${match[1]}`)
    }
  })

  test('⑤ 幂等：同一个文件重复入队、重复跑，片段不会翻倍', async () => {
    const before = await withSql(async (sql) => {
      return await sql`SELECT count(*)::int AS n FROM ai_chunks WHERE file_id = ${fileIds.visible}`
    })
    await enqueue(resources.visible, fileIds.visible, 'BACKFILL')
    await enqueue(resources.visible, fileIds.visible, 'BACKFILL')
    await waitForJobsSettled()
    const afterCount = await withSql(async (sql) => {
      return await sql`SELECT count(*)::int AS n FROM ai_chunks WHERE file_id = ${fileIds.visible}`
    })
    assert.equal(afterCount.n, before.n, '重复索引不该增加片段')
  })

  test('⑥ 来源变短后：多出来的旧片段被置为 STALE，且不再进入检索结果', async () => {
    const [file] = await withSql(async (sql) => {
      return await sql`SELECT storage_key, file_name FROM resource_files WHERE id = ${fileIds.visible}`
    })
    // 用更短的内容替换（模拟"文件被更新"）：旧片段的尾部下标应当作废
    const shorter = Buffer.from(`${KEYWORD_VISIBLE}：短版。`, 'utf8')
    const sha = (await import('node:crypto')).createHash('sha256').update(shorter).digest('hex')
    putObject(file.storage_key, shorter)
    await withSql(async (sql) => {
      await sql`UPDATE resource_files SET sha256 = ${sha}, size = ${shorter.byteLength} WHERE id = ${fileIds.visible}`
    })
    await enqueue(resources.visible, fileIds.visible, 'UPDATED')
    await waitForJobsSettled()

    const chunks = await withSql(async (sql) => {
      return await sql`
        SELECT status, count(*)::int AS n FROM ai_chunks
        WHERE file_id = ${fileIds.visible} GROUP BY status
      `
    })
    const byStatus = Object.fromEntries(chunks.map((r) => [r.status, r.n]))
    assert.equal((byStatus.READY ?? 0) > 0, true, '更新后仍有 READY 片段')
    assert.equal((byStatus.STALE ?? 0) > 0, true, `旧片段应当被置为 STALE：${JSON.stringify(byStatus)}`)

    // STALE 的片段不参与检索（SQL 里 status = 'READY' 是候选条件之一）
    const stale = await withSql(async (sql) => {
      return await sql`
        SELECT text FROM ai_chunks WHERE file_id = ${fileIds.visible} AND status = 'STALE' LIMIT 1
      `
    })
    if (stale.length > 0) {
      const search = aiCli(['search', '--user', 'ai_teacher_a', '--query', stale[0].text.slice(0, 30)])
      assert.doesNotMatch(search.out, /\[FILE_TEXT\]/, 'STALE 片段不该出现在检索结果里')
    }
  })

  test('⑦ 静态知识：目录说明与站点规则可检索（对所有登录用户）', async () => {
    const seeded = aiCli(['seed-static'])
    assert.equal(seeded.status, 0, seeded.out)
    const search = aiCli(['search', '--user', 'ai_teacher_a', '--query', '上传流程'])
    assert.equal(search.status, 0, search.out)
    assert.match(search.out, /SITE_RULE/, '站点规则应当被检索到')
  })
})
