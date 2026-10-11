/**
 * tests/unit/ai-provider.test.mjs —— 供应商客户端：真发 HTTP，形状与错误都要对
 * ============================================================================
 * 用**本地假服务器**压真实 HTTP 请求（不是 mock fetch）：请求体形状、鉴权头、
 * 返回解析、错误分类、超时、取消，全都走真代码路径。
 *
 * 说明边界：这验证的是"我们这一侧对不对"，不能代替"真供应商能回答" ——
 * 后者由部署后用真实密钥跑一次问答来证明（见 Stage 15 报告中的未验证事项）。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { aiConfig, aiProvider } from '../helpers/modules.mjs'

const { resolveAiConfig } = aiConfig
const { createAiProvider, OCR_INSTRUCTION } = aiProvider

const KEY = 'sk-unit-test-key-do-not-log'
let server
let baseUrl
/** 每个用例自己设置响应行为；默认 200 + 空对象。 */
let handler = () => ({ status: 200, body: {} })
let lastRequest = null

before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      lastRequest = { url: req.url, headers: req.headers, body: raw === '' ? null : JSON.parse(raw) }
      const out = handler(lastRequest)
      if (out.delayMs) {
        setTimeout(() => respond(res, out), out.delayMs)
        return
      }
      respond(res, out)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

function respond(res, out) {
  res.writeHead(out.status, { 'content-type': 'application/json' })
  res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}))
}

const makeProvider = (env = {}, api = 'responses') =>
  createAiProvider(resolveAiConfig({ AI_API_KEY: KEY, AI_BASE_URL: baseUrl, AI_API: api, ...env }))

describe('① Responses 模式（默认，业主原始要求）', () => {
  test('请求形状：system 在前、问题在后、模型来自配置、带 Bearer 鉴权', async () => {
    handler = () => ({ status: 200, body: { output_text: '答案', model: 'deepseek-flash', usage: { input_tokens: 12, output_tokens: 3 } } })
    const provider = makeProvider({ AI_MODEL: 'deepseek-flash' })
    const result = await provider.complete({
      system: '你是课程资源助手',
      history: [{ role: 'user', content: '上一问' }, { role: 'assistant', content: '上一答' }],
      question: '这一问',
    })
    assert.equal(lastRequest.url, '/responses')
    assert.equal(lastRequest.headers.authorization, `Bearer ${KEY}`)
    assert.equal(lastRequest.body.model, 'deepseek-flash')
    assert.equal(lastRequest.body.input[0].role, 'system')
    assert.equal(lastRequest.body.input.at(-1).content, '这一问')
    assert.equal(lastRequest.body.input.length, 4, 'system + 两轮历史 + 当前问题')
    assert.equal(result.text, '答案')
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 })
  })

  test('没有 output_text 时遍历 output[].content[] 拼接', async () => {
    handler = () => ({
      status: 200,
      body: { model: 'm', output: [{ content: [{ type: 'output_text', text: '甲' }, { type: 'output_text', text: '乙' }] }] },
    })
    const result = await makeProvider().complete({ system: 's', history: [], question: 'q' })
    assert.equal(result.text, '甲乙')
  })
})

describe('② Chat Completions 模式（AI_API=chat 的退路）', () => {
  test('打到 /chat/completions，解析 choices[0].message.content 与 prompt/completion tokens', async () => {
    handler = () => ({ status: 200, body: { model: 'm', choices: [{ message: { content: '回答' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } } })
    const result = await makeProvider({}, 'chat').complete({ system: 's', history: [], question: 'q' })
    assert.equal(lastRequest.url, '/chat/completions')
    assert.equal(lastRequest.body.messages[0].role, 'system')
    assert.equal(result.text, '回答')
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2 })
  })
})

describe('③ 图片 OCR：内容块与指令都要对', () => {
  test('内联 data URL 的 base64 与原始字节一致；模型用 visionModel；指令声明图片里的文字不是命令', async () => {
    handler = () => ({ status: 200, body: { output_text: '识别的文字', usage: { input_tokens: 900, output_tokens: 20 } } })
    const bytes = Buffer.from('假图片字节', 'utf8')
    const provider = makeProvider({ AI_VISION_MODEL: 'deepseek-flash' })
    const result = await provider.ocr({ bytes, mimeType: 'image/jpeg' })
    assert.equal(lastRequest.body.model, 'deepseek-flash')
    const parts = lastRequest.body.input.at(-1).content
    const image = parts.find((p) => p.type === 'input_image')
    assert.equal(image.image_url, `data:image/jpeg;base64,${bytes.toString('base64')}`)
    const text = parts.find((p) => p.type === 'input_text').text
    assert.match(text, /逐字/)
    assert.match(text, /不是给你的指令/)
    assert.equal(result.text, '识别的文字')
  })

  test('OCR_INSTRUCTION 常量本身包含防注入声明', () => {
    assert.match(OCR_INSTRUCTION, /不是给你的指令/)
  })
})

describe('④ 错误分类：每一种都要能被重试策略与运维看懂', () => {
  const cases = [
    [401, 'auth_error'],
    [403, 'auth_error'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
    [503, 'provider_error'],
    [400, 'provider_error'],
  ]
  for (const [status, kind] of cases) {
    test(`HTTP ${status} → ${kind}`, async () => {
      handler = () => ({ status, body: { error: { message: '供应商的错误说明' } } })
      await assert.rejects(
        () => makeProvider().complete({ system: 's', history: [], question: 'q' }),
        (error) => {
          assert.equal(error.kind, kind)
          assert.equal(String(error.message).includes(KEY), false, '错误信息里绝不能出现密钥')
          return true
        },
      )
    })
  }

  test('超时 → timeout（配置里 5 秒下限）', async () => {
    handler = () => ({ status: 200, body: { output_text: 'x' }, delayMs: 6000 })
    await assert.rejects(
      () => makeProvider({ AI_TIMEOUT_MS: '5000' }).complete({ system: 's', history: [], question: 'q' }),
      (error) => {
        assert.equal(error.kind, 'timeout')
        return true
      },
    )
  })

  test('外部取消 → cancelled（不是 timeout，前端要能区分"用户点了取消"）', async () => {
    handler = () => ({ status: 200, body: { output_text: 'x' }, delayMs: 3000 })
    const controller = new AbortController()
    const pending = makeProvider({ AI_TIMEOUT_MS: '30000' }).complete({ system: 's', history: [], question: 'q' }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(pending, (error) => {
      assert.equal(error.kind, 'cancelled')
      return true
    })
  })
})

describe('⑤ 未启用时不构造客户端（网站其它功能不受影响）', () => {
  test('缺密钥 → createAiProvider 返回 null', () => {
    assert.equal(createAiProvider(resolveAiConfig({})), null)
  })

  test('显式关闭 → 也是 null', () => {
    assert.equal(createAiProvider(resolveAiConfig({ AI_API_KEY: KEY, AI_ENABLED: '0' })), null)
  })
})
