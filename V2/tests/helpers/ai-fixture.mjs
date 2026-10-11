/**
 * tests/helpers/ai-fixture.mjs —— AI 测试的共用夹具（假模型服务器 + 可索引资源）
 * ============================================================================
 * 被两份测试共用：
 *   · `tests/integration/ai-chat-api.test.mjs`（接口层：状态 / 提问 / 出口审计 / 限流）
 *   · `tests/integration/browser.stage15-ai-panel.test.mjs`（界面层：入口 / 抽屉 / 引用链接）
 *
 * 两个设计决定，都是为了"测的是真东西"：
 *   ① **假模型服务器是一个真的 HTTP 服务**：应用通过 `AI_BASE_URL` 指过来，
 *      于是走的是真实的 fetch、真实的 JSON 解析、真实的状态码分支 ——
 *      但不会花钱，也不会把任何资料发到外部。
 *   ② 资源与文件**直接写库 + 真的把字节放进存储目录**，然后排索引任务让
 *      **真实的 worker** 去读、去提取、去写片段。夹具只"搭状态"，业务行为全走真实代码。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withSql } from './harness.mjs'
import { makeResource } from './resource-fixture.mjs'

/**
 * 启动假模型服务器（OpenAI 兼容的 `/responses`）。
 *
 * @returns `{ url, requests, setMode, setDelay, close }`
 *   · `requests` —— 每个请求的 `{ url, authorization, body }`，用来**审出口**
 *     （"发给模型的东西里有没有不该有的内容"是 Stage 15 最关键的一条断言）；
 *   · `setMode('error')` —— 让供应商返回 500，测错误分类；
 *   · `setDelay(ms)` —— 让回答变慢，测"加载中 / 取消"（前端取消必须真的断开连接）。
 */
export async function startMockProvider({ model = 'deepseek-flash' } = {}) {
  const state = { mode: 'answer', delayMs: 0, requests: [], aborted: 0 }

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body = {}
      try {
        body = raw === '' ? {} : JSON.parse(raw)
      } catch {
        body = { unparsable: raw.slice(0, 200) }
      }
      state.requests.push({ url: req.url, authorization: req.headers.authorization ?? null, body })

      /*
        记录"客户端在回答写完之前就断开了" —— 这是验证**取消**真的生效的可观测信号。
        只断言"界面回到了可用状态"是不够的：界面变了、连接还挂着，
        上游照样在算、账单照样在涨（用户点取消的**本意**是止损）。
      */
      res.on('close', () => {
        if (!res.writableEnded) state.aborted += 1
      })

      const send = () => {
        // 客户端已经断开（用户点了取消）→ 什么都别写，否则会抛 ERR_STREAM_WRITE_AFTER_END
        if (res.writableEnded || res.destroyed) return
        if (state.mode === 'error') {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: '供应商内部细节不该被透出' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model,
            output_text: '根据站内资料 [1]：可以先用藤蔓做拼贴，再记录颜色变化。',
            usage: { input_tokens: 1234, output_tokens: 56 },
          }),
        )
      }

      if (state.delayMs > 0) setTimeout(send, state.delayMs)
      else send()
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: state.requests,
    setMode: (mode) => {
      state.mode = mode
    },
    setDelay: (ms) => {
      state.delayMs = ms
    },
    /** 有多少次请求是被客户端**中途断开**的（取消提问/关面板应当让这个数字增加）。 */
    abortedCount: () => state.aborted,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 把文件字节放进夹具自己选的本地存储目录（服务多个 describe 共用同一目录）。 */
export function putObject(storageDir, storageKey, content) {
  const full = join(storageDir, storageKey)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** 造一条"资源 + 一个文本文件"（字节真的落盘），并返回 id。 */
export async function makeResourceWithFile({
  storageDir,
  directoryId,
  uploaderId,
  title,
  status = 'PUBLISHED',
  fileName,
  text,
}) {
  const content = Buffer.from(text, 'utf8')
  const resourceId = await makeResource({ directoryId, uploaderId, title, status })
  const storageKey = `resources/${resourceId}/${fileName}`
  const fileId = await withSql(async (sql) => {
    const rows = await sql`
      INSERT INTO resource_files (resource_id, file_name, storage_key, mime_type, size, sha256, created_by)
      VALUES (${resourceId}, ${fileName}, ${storageKey}, 'text/plain', ${content.byteLength},
              ${createHash('sha256').update(content).digest('hex')}, ${uploaderId})
      RETURNING id::text
    `
    return rows[0].id
  })
  putObject(storageDir, storageKey, content)
  return { resourceId, fileId }
}

/** 排一个索引任务（资源元数据 + 可选的文件正文）。幂等：重复排不会重复任务。 */
export async function enqueueResource(resourceId, fileId = null) {
  await withSql(async (sql) => {
    await sql`
      INSERT INTO ai_index_jobs (resource_id, file_id, reason)
      VALUES (${resourceId}, ${fileId}, 'BACKFILL') ON CONFLICT DO NOTHING
    `
    await sql`
      INSERT INTO ai_index_jobs (resource_id, file_id, reason)
      VALUES (${resourceId}, NULL, 'BACKFILL') ON CONFLICT DO NOTHING
    `
  })
}

/** 等后台索引任务全部落地（PENDING/RUNNING 清空）。超时即失败 —— 不用固定 sleep。 */
export async function waitForJobsSettled(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await withSql(async (sql) => {
      return await sql`SELECT count(*)::int AS n FROM ai_index_jobs WHERE state IN ('PENDING', 'RUNNING')`
    })
    if (row.n === 0) return
    if (Date.now() > deadline) throw new Error(`等索引 worker 超时：还剩 ${row.n} 个任务未落地`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** 清掉 AI 相关的表（夹具收尾用；不动 users / resources / directories）。 */
export async function purgeAiRows() {
  await withSql(async (sql) => {
    await sql`DELETE FROM ai_messages`
    await sql`DELETE FROM ai_conversations`
    await sql`DELETE FROM ai_chunks`
    await sql`DELETE FROM ai_index_jobs`
    await sql`DELETE FROM ai_usage_events`
  })
}
