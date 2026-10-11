/**
 * tests/integration/ai-pdf-index.test.mjs —— PDF 从**上传**一路走到**问答**
 * ============================================================================
 * 业主 Stage 15 §五："已上传的文档能被检索"。PDF 是本轮（P5）新接入的格式，
 * 所以要证明的不是"解析函数能跑"（那是 `tests/unit/ai-pdf.test.mjs` 的事），
 * 而是这条**真实链路**：
 *
 *   ① 老师**走正常上传接口**传一个 PDF（申请地址 → PUT 字节 → 登记）；
 *   ② 上传**不等待**索引，但会自动排一个索引任务（§八：异步、不牵连上传）；
 *   ③ 后台 worker 真的去对象存储读字节 → 解出正文 → 写进 `ai_chunks`；
 *   ④ 检索能命中 PDF 里的中文关键词 → 提问时该 PDF 出现在**引用**里；
 *   ⑤ 扫描件（没有文字层）**如实记 SKIPPED**（原因说清），而不是假装索引成功，
 *      而且原文件照常能预览/下载。
 *
 * 关键词用中文长词：这同时验证了"中文 PDF 的 ToUnicode 映射"和
 * "检索对中文的处理"（Postgres 的 simple 分词器不切中文，靠词元覆盖）。
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
import { pdfWithTextBytes, scannedPdfBytes, textBytes, uploadFile } from '../helpers/upload.mjs'
import { purgeAiRows, startMockProvider, waitForJobsSettled } from '../helpers/ai-fixture.mjs'

const MODEL = 'deepseek-flash'
/** 只出现在这份 PDF 里的中文关键词（连续汉字，二字符粒度可命中）。 */
const KW_PDF = '中秋主题活动做月饼'

let storageDir
let mock
let browserless
let teacher
let pdfResourceId
let scannedResourceId
const probes = []

before(async () => {
  await resetDatabase()
  storageDir = mkdtempSync(join(tmpdir(), 'v2-ai-pdf-storage-'))
  mock = await startMockProvider({ model: MODEL })

  const preK = await directoryIdByPath('education/pre-k')
  teacher = await createTeacher(
    'ai_pdf_teacher',
    'AiPdfPass!1',
    [
      { permission: 'resource.view', directoryId: preK },
      { permission: 'resource.create', directoryId: preK },
      { permission: 'resource.update.own', directoryId: preK },
    ],
    'PDF 老师',
  )

  await startServer({
    env: {
      STORAGE_LOCAL_DIR: storageDir,
      AI_API_KEY: 'sk-fake-for-tests-do-not-log',
      AI_BASE_URL: mock.url,
      AI_MODEL: MODEL,
      AI_INDEX_INTERVAL_MS: '700',
      AI_INDEX_BATCH: '20',
    },
  })

  browserless = client()
  await browserless.login('ai_pdf_teacher', 'AiPdfPass!1')

  const resources = await directoryIdByPath('education/pre-k/virtue/resources')
  // ① 带文字层的 PDF：正文里有关键词
  const pdf = await browserless.post('/api/resources', { title: '中秋活动方案（PDF）', directoryId: resources })
  assert.equal(pdf.status, 201, JSON.stringify(pdf.data))
  pdfResourceId = pdf.data.id
  probes.push(pdfResourceId)

  // ② 扫描件：没有文字层
  const scanned = await browserless.post('/api/resources', { title: '手写通知（扫描件）', directoryId: resources })
  assert.equal(scanned.status, 201, JSON.stringify(scanned.data))
  scannedResourceId = scanned.data.id
  probes.push(scannedResourceId)

  const pdfBytes = pdfWithTextBytes(`${KW_PDF}：带孩子做月饼、赏月，并记录观察与感受。`)
  const pdfFile = await uploadFile(browserless, pdfResourceId, {
    bytes: pdfBytes,
    fileName: '中秋活动方案.pdf',
    mimeType: 'application/pdf',
  })
  assert.equal(pdfFile.size, pdfBytes.byteLength)

  const scannedFile = await uploadFile(browserless, scannedResourceId, {
    bytes: scannedPdfBytes(),
    fileName: '手写通知.pdf',
    mimeType: 'application/pdf',
  })
  assert.equal(scannedFile.size > 0, true)

  // 上传返回时**不等待**索引；这里等后台 worker 把两个任务都落地
  await waitForJobsSettled()
})

after(async () => {
  await stopServer()
  if (mock !== undefined) await mock.close()
  if (storageDir !== undefined) rmSync(storageDir, { recursive: true, force: true })
  await purgeAiRows()
  await purgeResources(probes)
  if (teacher === undefined) return
})

describe('PDF：上传 → 异步索引 → 检索 → 问答引用', () => {
  test('① 上传就自动排了索引任务，且任务已经落地（不是 PENDING 挂着）', async () => {
    const rows = await withSql(async (sql) => {
      return await sql`
        SELECT state, count(*)::int AS n FROM ai_index_jobs
        WHERE resource_id = ${pdfResourceId} GROUP BY state
      `
    })
    const done = rows.find((r) => r.state === 'DONE')
    assert.ok(done, `PDF 的索引任务应当完成：${JSON.stringify(rows)}`)
    assert.equal(done.n, 2, '资源元数据 + 文件正文各一个任务')
  })

  test('② PDF 正文进了索引，中文关键词能原样查出来（ToUnicode 映射正确）', async () => {
    const rows = await withSql(async (sql) => {
      return await sql`
        SELECT source_kind, text FROM ai_chunks
        WHERE resource_id = ${pdfResourceId} AND status = 'READY' ORDER BY source_kind
      `
    })
    const fileText = rows.find((r) => r.source_kind === 'FILE_TEXT')
    assert.ok(fileText, `应当有 FILE_TEXT 片段：${JSON.stringify(rows.map((r) => r.source_kind))}`)
    assert.match(fileText.text, new RegExp(KW_PDF), `PDF 正文必须是可读中文（不是乱码）：${fileText.text}`)
    assert.match(fileText.text, /月饼/, '正文其余部分也要在')
    // 元数据片段也要有（标题能被搜到）
    assert.equal(rows.some((r) => r.source_kind === 'RESOURCE_META'), true)
  })

  test('③ 检索：中文提问能命中 PDF（词元覆盖让长问句也能查到）', async () => {
    const res = await browserless.post('/api/ai/chat', { question: `${KW_PDF} 怎么写？` })
    assert.equal(res.status, 201, JSON.stringify(res.data))
    assert.equal(res.data.noEvidence, false, 'PDF 正文已索引，不该答"没找到"')
    assert.equal(
      res.data.citations.some((c) => c.resourceId === pdfResourceId),
      true,
      `引用里应当有这份 PDF：${JSON.stringify(res.data.citations)}`,
    )
    // 送给模型的上下文里必须有 PDF 的正文（这才是"能检索"的实证）
    const sent = JSON.stringify(mock.requests.at(-1)?.body ?? {})
    assert.match(sent, new RegExp(KW_PDF), 'PDF 正文应当进入模型上下文')
  })

  test('④ 扫描件：如实记 SKIPPED 并说清原因（不假装索引成功）', async () => {
    const rows = await withSql(async (sql) => {
      return await sql`
        SELECT state, last_error FROM ai_index_jobs
        WHERE resource_id = ${scannedResourceId} AND file_id IS NOT NULL LIMIT 1
      `
    })
    assert.equal(rows.length, 1, '扫描件也应当有文件索引任务')
    assert.equal(rows[0].state, 'SKIPPED', `扫描件应当记 SKIPPED：${JSON.stringify(rows[0])}`)
    assert.match(String(rows[0].last_error), /扫描|文字层/, `原因要说清：${rows[0].last_error}`)

    const chunks = await withSql(async (sql) => {
      return await sql`
        SELECT count(*)::int AS n FROM ai_chunks WHERE resource_id = ${scannedResourceId} AND source_kind = 'FILE_TEXT'
      `
    })
    assert.equal(chunks[0].n, 0, '扫描件不该往索引里灌任何正文片段')

    // 但原文件照常可用：文件列表能读到（可预览/下载）
    const files = await browserless.get(`/api/resources/${scannedResourceId}/files`)
    assert.equal(files.status, 200)
    assert.equal(files.data.items.length, 1, '扫描件的原文件必须照常在')
    assert.equal(files.data.items[0].fileName, '手写通知.pdf')
  })

  test('⑤ 拿不到依据的东西仍然"没找到"（PDF 支持没有削弱这条纪律）', async () => {
    const res = await browserless.post('/api/ai/chat', { question: '寒假值班表的注意事项' })
    if (res.data.noEvidence === true) {
      assert.deepEqual(res.data.citations, [], '没有依据时不该有引用')
    } else {
      // 万一命中了别的资料，也绝不能凭空引用不存在的资源
      assert.equal(
        res.data.citations.every((c) => c.resourceId === '' || probes.includes(c.resourceId)),
        true,
        `引用只能来自本次夹具里的资源：${JSON.stringify(res.data.citations)}`,
      )
    }
  })

  test('⑥ 上传链路没有被 AI 影响：非 PDF 文件照常上传并索引', async () => {
    const resources = await directoryIdByPath('education/pre-k/virtue/resources')
    const created = await browserless.post('/api/resources', { title: 'PDF 轮次的文本探针', directoryId: resources })
    assert.equal(created.status, 201, JSON.stringify(created.data))
    probes.push(created.data.id)
    const uploaded = await uploadFile(browserless, created.data.id, {
      bytes: textBytes('pdf-round-text-probe'),
      fileName: 'probe.txt',
    })
    assert.equal(uploaded.fileName, 'probe.txt')
    await waitForJobsSettled()
    const rows = await withSql(async (sql) => {
      return await sql`
        SELECT count(*)::int AS n FROM ai_chunks WHERE resource_id = ${created.data.id} AND source_kind = 'FILE_TEXT'
      `
    })
    assert.equal(rows[0].n >= 1, true, '普通文本照常索引')
  })
})
