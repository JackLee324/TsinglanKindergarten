/**
 * tests/integration/ai-lifecycle.test.mjs —— 索引的**失败与开关**（业主 §八与 §四）
 * ============================================================================
 * 前两份 AI 集成测试证明的是"正常路径能跑"（索引、检索、权限、PDF）。
 * 这一份专门压**不正常的路径**，因为业主的三条要求都落在这里：
 *
 *   ① §八：索引失败**可重试**，而且失败只影响"这份资料暂时问不到"；
 *   ② §八：反复失败要**停下来并留痕**（不能无限重试烧 CPU、也不能假装成功）；
 *   ③ §四："AI 可独立关闭" —— 关掉 AI 之后，上传/预览/下载/审核照常，
 *      而且**不会产生任何模型费用**（图片 OCR 随 provider 一起关掉）。
 *
 * 失败不是"造一个假错误"造出来的：这里让**对象真的不存在**（删掉存储里的字节），
 * 让 worker 在读对象时真的抛错 —— 这正是现实中会遇到的形态
 * （上传登记了、对象还没可见 / 存储抖动）。恢复也是真的：把字节放回去。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  client,
  createTeacher,
  directoryIdByPath,
  resetDatabase,
  startServer,
  stopServer,
  withSql,
} from '../helpers/harness.mjs'
import { purgeResources } from '../helpers/resource-fixture.mjs'
import { textBytes, uploadFile } from '../helpers/upload.mjs'
import {
  enqueueResource,
  makeResourceWithFile,
  purgeAiRows,
  putObject,
  startMockProvider,
  waitForJobsSettled,
} from '../helpers/ai-fixture.mjs'

const MODEL = 'deepseek-flash'
const FAKE_KEY = 'sk-fake-for-tests-do-not-log'

let storageDir
let mock
let teacher
let resourcesDir
const probes = []

/**
 * 等某个索引任务满足条件（不用固定 sleep）。
 *
 * ⚠️ 判据必须是"**可区分前后**"的谓词，不能只看状态名：
 * 任务刚入队时本来就是 PENDING，只看状态名会**在失败发生之前就匹配上**
 * （第一版就是这么写的，于是"应当记下尝试次数：0"）。
 * 所以这里传的是整个判据函数，由调用方明确说清"什么样子才算到了那一步"。
 */
async function waitForJob(resourceId, label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    const rows = await withSql(async (sql) => {
      return await sql`
        SELECT id::text, state, attempts, last_error, next_attempt_at
        FROM ai_index_jobs WHERE resource_id = ${resourceId} AND file_id IS NOT NULL LIMIT 1
      `
    })
    last = rows[0] ?? null
    if (last !== null && predicate(last)) return last
    if (Date.now() > deadline) {
      throw new Error(`等任务「${label}」超时，当前：${JSON.stringify(last)}`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function chunkCount(resourceId, kind) {
  const [row] = await withSql(async (sql) => {
    return await sql`
      SELECT count(*)::int AS n FROM ai_chunks
      WHERE resource_id = ${resourceId} AND status = 'READY' AND source_kind = ${kind}
    `
  })
  return row.n
}

before(async () => {
  await resetDatabase()
  storageDir = mkdtempSync(join(tmpdir(), 'v2-ai-lifecycle-'))
  mock = await startMockProvider({ model: MODEL })
  const preK = await directoryIdByPath('education/pre-k')
  teacher = await createTeacher(
    'ai_life_teacher',
    'AiLifePass!1',
    [
      { permission: 'resource.view', directoryId: preK },
      { permission: 'resource.create', directoryId: preK },
      { permission: 'resource.update.own', directoryId: preK },
    ],
    '生命周期老师',
  )
  resourcesDir = await directoryIdByPath('education/pre-k/virtue/resources')
})

after(async () => {
  await stopServer()
  if (mock !== undefined) await mock.close()
  if (storageDir !== undefined) rmSync(storageDir, { recursive: true, force: true })
  await purgeAiRows()
  await purgeResources(probes)
})

describe('① 索引失败：会重试、会留痕、恢复后能成功', () => {
  let as
  let flaky
  let doomed

  before(async () => {
    await startServer({
      env: {
        STORAGE_LOCAL_DIR: storageDir,
        AI_API_KEY: FAKE_KEY,
        AI_BASE_URL: mock.url,
        AI_MODEL: MODEL,
        AI_INDEX_INTERVAL_MS: '700',
        AI_INDEX_BATCH: '20',
        AI_MAX_INDEX_ATTEMPTS: '5',
      },
    })
    as = client()
    await as.login('ai_life_teacher', 'AiLifePass!1')

    // 对象会在索引前被删掉 → worker 读对象时抛错（真实的瞬时故障形态）
    flaky = await makeResourceWithFile({
      storageDir,
      directoryId: resourcesDir,
      uploaderId: teacher.id,
      title: '对象暂时读不到的资源',
      fileName: 'flaky.txt',
      text: '这份资料第一次索引时对象还没可见，第二次才成功。',
    })
    probes.push(flaky.resourceId)
    rmSync(join(storageDir, 'resources', flaky.resourceId, 'flaky.txt'))

    await enqueueResource(flaky.resourceId, flaky.fileId)
  })

  after(async () => {
    await stopServer()
  })

  test('第一次失败：任务回到 PENDING（不是 DONE、也不是 FAILED），并记下原因与退避时间', async () => {
    // "失败过一次并在等重试"的判据：PENDING + 有 last_error + 尝试次数≥1
    const job = await waitForJob(
      flaky.resourceId,
      '第一次失败后回到 PENDING（带原因与退避）',
      (row) => row.state === 'PENDING' && row.last_error !== null && row.attempts >= 1,
    )
    assert.equal(job.attempts >= 1, true, `应当记下尝试次数：${job.attempts}`)
    assert.match(
      String(job.last_error),
      /对象|不存在|ENOENT|no such file/i,
      `失败原因要能看懂：${job.last_error}`,
    )
    const waitMs = new Date(job.next_attempt_at).getTime() - Date.now()
    assert.equal(waitMs > 1000, true, `应当有退避（不是立刻打满）：${waitMs}ms`)
    assert.equal(
      await chunkCount(flaky.resourceId, 'FILE_TEXT'),
      0,
      '失败时不该写入任何正文片段（不许留半份）',
    )
    // 资源元数据片段是另一个任务，它不该被这个失败牵连
    assert.equal(await chunkCount(flaky.resourceId, 'RESOURCE_META') >= 1, true, '元数据照常索引')
  })

  test('恢复后：把对象放回去 + 到点重跑 → 任务 DONE，正文进索引', async () => {
    putObject(storageDir, `resources/${flaky.resourceId}/flaky.txt`, Buffer.from('这份资料第一次索引时对象还没可见，第二次才成功。', 'utf8'))
    // 退避是 15s 起步（真实的指数退避）；测试不等 15 秒，而是把"下次可尝试时间"拨到现在 ——
    // 拨的是**时钟**，不是逻辑：重试仍然由 worker 按 next_attempt_at 认领。
    await withSql(async (sql) => {
      await sql`UPDATE ai_index_jobs SET next_attempt_at = now() WHERE resource_id = ${flaky.resourceId}`
    })
    const job = await waitForJob(flaky.resourceId, '重试后成功', (row) => row.state === 'DONE', 30_000)
    assert.equal(job.last_error === null || job.last_error === '', true, '成功后要清掉失败原因')
    assert.equal(await chunkCount(flaky.resourceId, 'FILE_TEXT'), 1, '正文片段写进去了')
    await waitForJobsSettled(10_000)
  })

  test('反复失败到上限 → FAILED（停下来留痕），而业务侧完全不受影响', async () => {
    // 单独起一个"只给 1 次机会"的服务：第一次失败就直接 FAILED
    await stopServer()
    await startServer({
      env: {
        STORAGE_LOCAL_DIR: storageDir,
        AI_API_KEY: FAKE_KEY,
        AI_BASE_URL: mock.url,
        AI_MODEL: MODEL,
        AI_INDEX_INTERVAL_MS: '700',
        AI_MAX_INDEX_ATTEMPTS: '1',
      },
    })
    const client2 = client()
    await client2.login('ai_life_teacher', 'AiLifePass!1')

    doomed = await makeResourceWithFile({
      storageDir,
      directoryId: resourcesDir,
      uploaderId: teacher.id,
      title: '对象永久缺失的资源',
      fileName: 'doomed.txt',
      text: '这份资料的对象永远不会出现，索引应当停下来并留痕。',
    })
    probes.push(doomed.resourceId)
    rmSync(join(storageDir, 'resources', doomed.resourceId, 'doomed.txt'))
    await enqueueResource(doomed.resourceId, doomed.fileId)

    const job = await waitForJob(doomed.resourceId, '到上限后 FAILED', (row) => row.state === 'FAILED', 30_000)
    assert.match(String(job.last_error), /对象|不存在|ENOENT|no such file/i, `原因要留痕：${job.last_error}`)

    // 业务侧照常：资源列表能看到它、文件元数据照常返回、AI 接口本身也没崩
    const list = await client2.get(`/api/resources?directoryId=${resourcesDir}&pageSize=50`)
    assert.equal(list.status, 200)
    assert.equal(
      list.data.items.some((item) => item.id === doomed.resourceId),
      true,
      '索引失败不该让资源从列表里消失',
    )
    const files = await client2.get(`/api/resources/${doomed.resourceId}/files`)
    assert.equal(files.status, 200, JSON.stringify(files.data))
    assert.equal(files.data.items.length, 1, '文件元数据照常返回')
    const status = await client2.get('/api/ai/status')
    assert.equal(status.status, 200, '一个任务失败不该让 AI 接口挂掉')
    // 而且它不影响别的资料：问上一份（已成功索引的）资料仍答得出
    const ask = await client2.post('/api/ai/chat', { question: '这份资料第一次索引时对象还没可见' })
    assert.equal(ask.status, 201, JSON.stringify(ask.data))
    assert.equal(ask.data.noEvidence, false, '另一份资料的索引没被这次失败牵连')
  })
})

describe('② AI 可独立关闭（密钥仍在，也能一键停）', () => {
  let offline

  before(async () => {
    await stopServer()
    await startServer({
      env: {
        STORAGE_LOCAL_DIR: storageDir,
        AI_API_KEY: FAKE_KEY,
        AI_BASE_URL: mock.url,
        AI_MODEL: MODEL,
        AI_ENABLED: '0',
        AI_INDEX_INTERVAL_MS: '700',
      },
    })
    offline = client()
    await offline.login('ai_life_teacher', 'AiLifePass!1')
  })

  after(async () => {
    await stopServer()
  })

  test('状态：禁用，且理由点名是"显式关闭"（不是"缺密钥"）', async () => {
    const res = await offline.get('/api/ai/status')
    assert.equal(res.status, 200)
    assert.equal(res.data.enabled, false)
    assert.match(String(res.data.disabledReason), /AI_ENABLED/, `理由要能指到开关：${res.data.disabledReason}`)
  })

  test('提问 → 503，且**一次模型调用都没有发生**（关掉就是真的不花钱）', async () => {
    const callsBefore = mock.requests.length
    const res = await offline.post('/api/ai/chat', { question: '随便问一句' })
    assert.equal(res.status, 503, JSON.stringify(res.data))
    assert.equal(res.data.code, 'AI_DISABLED')
    assert.equal(mock.requests.length, callsBefore, '禁用状态下不该有任何上游请求')
  })

  test('上传照常，而且**文本索引也在继续**（关的是问答，不是知识库）', async () => {
    const created = await offline.post('/api/resources', { title: 'AI 关闭时的上传探针', directoryId: resourcesDir })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    probes.push(created.data.id)
    const uploaded = await uploadFile(offline, created.data.id, {
      bytes: textBytes('ai-disabled-but-indexing'),
      fileName: 'probe.txt',
    })
    assert.equal(uploaded.fileName, 'probe.txt')
    await waitForJobsSettled(20_000)
    assert.equal(
      await chunkCount(created.data.id, 'FILE_TEXT'),
      1,
      '文本提取不需要模型，关掉 AI 也应照常索引（这样再打开时立刻可用）',
    )
  })

  test('图片在禁用时**不会**走 OCR（不产生费用），如实记为 SKIPPED', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ])
    const created = await offline.post('/api/resources', { title: 'AI 关闭时的图片探针', directoryId: resourcesDir })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    probes.push(created.data.id)
    const callsBefore = mock.requests.length
    await uploadFile(offline, created.data.id, { bytes: png, fileName: 'probe.png', mimeType: 'image/png' })
    await waitForJobsSettled(20_000)
    assert.equal(mock.requests.length, callsBefore, '禁用状态下 OCR 不该被调用（那是真金白银）')
    const [job] = await withSql(async (sql) => {
      return await sql`
        SELECT state, last_error FROM ai_index_jobs
        WHERE resource_id = ${created.data.id} AND file_id IS NOT NULL LIMIT 1
      `
    })
    assert.equal(job.state, 'SKIPPED', `图片应当如实记 SKIPPED：${JSON.stringify(job)}`)
    assert.match(String(job.last_error), /OCR/, `原因要说清是 OCR 没开：${job.last_error}`)
  })
})

describe('③ 索引也可以单独停（上传照常，只是不再更新知识库）', () => {
  let paused

  before(async () => {
    await stopServer()
    await startServer({
      env: {
        STORAGE_LOCAL_DIR: storageDir,
        AI_API_KEY: FAKE_KEY,
        AI_BASE_URL: mock.url,
        AI_MODEL: MODEL,
        AI_INDEX_ENABLED: '0',
      },
    })
    paused = client()
    await paused.login('ai_life_teacher', 'AiLifePass!1')
  })

  after(async () => {
    await stopServer()
  })

  test('上传成功、任务排上了队，但没有 worker 去处理（停的是索引，不是上传）', async () => {
    const created = await paused.post('/api/resources', { title: '索引暂停时的上传探针', directoryId: resourcesDir })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    probes.push(created.data.id)
    const uploaded = await uploadFile(paused, created.data.id, {
      bytes: textBytes('indexing-paused-probe'),
      fileName: 'paused.txt',
    })
    assert.equal(uploaded.fileName, 'paused.txt')

    await new Promise((r) => setTimeout(r, 3000))
    const rows = await withSql(async (sql) => {
      return await sql`SELECT state FROM ai_index_jobs WHERE resource_id = ${created.data.id}`
    })
    assert.equal(rows.length >= 1, true, '入队仍然发生（上传路径不依赖 worker 是否在跑）')
    assert.equal(
      rows.every((r) => r.state === 'PENDING'),
      true,
      `没有 worker 时任务只应当是 PENDING：${JSON.stringify(rows)}`,
    )
    assert.equal(await chunkCount(created.data.id, 'FILE_TEXT'), 0, '暂停期间不产生新片段')

    // 业务侧照常
    const files = await paused.get(`/api/resources/${created.data.id}/files`)
    assert.equal(files.status, 200)
    assert.equal(files.data.items[0].fileName, 'paused.txt')
  })
})
