/**
 * tests/unit/ai-config.test.mjs —— AI 开关的语义必须精确
 * ============================================================================
 * 业主 Stage 15 §四：密钥只在服务端环境变量；未配置时 AI 禁用**且不影响网站其它功能**。
 * 这里钉住三件事：
 *   ① 只有"开关开 + 有密钥"才算启用 —— 缺一个都必须禁用，并说清缺哪个；
 *   ② 默认供应商/模型/地址符合业主的决定（DeepSeek + deepseek-flash + 官方 base_url）；
 *   ③ 非法数字与非法布尔不许导致"意外放大"（例如把超时解析成 NaN 或把限流关掉）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { aiConfig } from '../helpers/modules.mjs'

const { resolveAiConfig } = aiConfig

describe('① 启用条件：开关 + 密钥，缺一不可', () => {
  test('默认（什么都没配）→ 禁用，并点名缺的是 AI_API_KEY', () => {
    const c = resolveAiConfig({})
    assert.equal(c.enabled, false)
    assert.match(c.disabledReason, /AI_API_KEY/)
  })

  test('有密钥但 AI_ENABLED=0 → 禁用，理由指向显式关闭', () => {
    const c = resolveAiConfig({ AI_API_KEY: 'sk-test', AI_ENABLED: '0' })
    assert.equal(c.enabled, false)
    assert.match(c.disabledReason, /AI_ENABLED/)
  })

  test('有密钥且未显式关闭 → 启用（默认不要求 AI_ENABLED=1，避免"配了却忘了开"）', () => {
    const c = resolveAiConfig({ AI_API_KEY: 'sk-test' })
    assert.equal(c.enabled, true)
    assert.equal(c.disabledReason, null)
  })

  test('别名密钥也认：DEEPSEEK_API_KEY / OPENAI_API_KEY', () => {
    assert.equal(resolveAiConfig({ DEEPSEEK_API_KEY: 'sk-a' }).enabled, true)
    assert.equal(resolveAiConfig({ OPENAI_API_KEY: 'sk-b' }).enabled, true)
  })

  test('理由里绝不回显密钥本身', () => {
    const c = resolveAiConfig({ AI_API_KEY: 'sk-super-secret-value', AI_ENABLED: '0' })
    assert.doesNotMatch(String(c.disabledReason), /sk-super-secret-value/)
  })
})

describe('② 默认值符合业主的决定（DeepSeek）', () => {
  test('provider=deepseek、base_url 官方地址、模型 deepseek-flash', () => {
    const c = resolveAiConfig({ AI_API_KEY: 'sk-test' })
    assert.equal(c.provider, 'deepseek')
    assert.equal(c.baseUrl, 'https://api.deepseek.com')
    assert.equal(c.model, 'deepseek-flash')
  })

  test('视觉模型默认跟随 AI_MODEL（deepseek-flash 本身支持图片）', () => {
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k' }).visionModel, 'deepseek-flash')
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_MODEL: 'other' }).visionModel, 'other')
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_VISION_MODEL: 'vlm' }).visionModel, 'vlm')
  })

  test('OCR 默认开（业主已选"用模型视觉能力做 OCR"）；embeddings 默认关（生产库没有 pgvector）', () => {
    const c = resolveAiConfig({ AI_API_KEY: 'k' })
    assert.equal(c.visionOcrEnabled, true)
    assert.equal(c.embeddingsEnabled, false)
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_VISION_OCR: 'off' }).visionOcrEnabled, false)
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_EMBEDDINGS: 'on' }).embeddingsEnabled, true)
  })

  test('API 格式默认 responses（业主原始要求），可用 AI_API=chat 切到兼容端点', () => {
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k' }).api, 'responses')
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_API: 'chat' }).api, 'chat')
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_API: 'CHAT' }).api, 'chat')
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_API: '瞎写' }).api, 'responses')
  })

  test('base_url 末尾斜杠会被去掉（避免拼出 //responses）', () => {
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_BASE_URL: 'https://x.example.com///' }).baseUrl, 'https://x.example.com')
  })
})

describe('③ 非法配置回落到默认，而不是"意外放大"', () => {
  test('超时/限流/并发/条数非法值一律回落默认', () => {
    const c = resolveAiConfig({
      AI_API_KEY: 'k',
      AI_TIMEOUT_MS: 'abc',
      AI_RATE_LIMIT_PER_MIN: '-5',
      AI_MAX_CONCURRENT: '999',
      AI_TOP_K: '0',
      AI_MAX_OUTPUT_TOKENS: 'nope',
    })
    assert.equal(c.timeoutMs, 45_000)
    assert.equal(c.rateLimitPerMin, 10)
    assert.equal(c.maxConcurrent, 2)
    assert.equal(c.topK, 8)
    assert.equal(c.maxOutputTokens, 1200)
  })

  test('合法值能覆盖（业主可以按需要调）', () => {
    const c = resolveAiConfig({ AI_API_KEY: 'k', AI_TOP_K: '3', AI_TIMEOUT_MS: '90000', AI_MAX_CONCURRENT: '1' })
    assert.equal(c.topK, 3)
    assert.equal(c.timeoutMs, 90_000)
    assert.equal(c.maxConcurrent, 1)
  })

  test('布尔开关的怪值不会把已开的功能关掉', () => {
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_VISION_OCR: 'maybe' }).visionOcrEnabled, true)
    assert.equal(resolveAiConfig({ AI_API_KEY: 'k', AI_EMBEDDINGS: '  ' }).embeddingsEnabled, false)
  })
})
