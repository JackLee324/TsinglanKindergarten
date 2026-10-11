/**
 * tests/unit/ai-prompt.test.mjs —— 提示词里的三条纪律（业主反馈后新增的判据）
 * ============================================================================
 * 背景（2026-10-11 业主实测反馈"AI 助手的回答好像是假的"）：
 *   他在线上问「你现在是什么模型」，检索命中 0 条，于是走了"没依据就不调模型"的
 *   确定性回复 —— 收到的却是一句与问题毫不相干的"现有资料里没有找到相关内容"。
 *   一个真正的助手用固定文案回答"你是什么模型"，任何人都会判断它是假的。
 *
 * 所以这里钉三件事：
 *   ① **问助手自己的问题要被识别出来**（`isMetaQuestion`），并且判定要保守：
 *      问资料的问题不能被误判成问助手（误判会白白调模型、还可能带偏回答）；
 *   ② 识别出来之后要有**据实可答的事实**（`buildSelfDescription`）——
 *      供应商、模型名、能力边界都来自服务端配置，且**绝不包含密钥**；
 *   ③ 真正没找到时，系统提示要**自己说明身份**（"未调用 AI 模型"）、
 *      带上用户的原问题、并给出路标（有权访问的目录），而不是一句冷冰冰的固定文案。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { aiPrompt } from '../helpers/modules.mjs'

const { isMetaQuestion, buildSelfDescription, buildSystemPrompt, buildNoEvidenceAnswer, buildUserMessage, AI_SYSTEM_PROMPT } =
  aiPrompt

const CONFIG = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  visionOcrEnabled: true,
  topK: 8,
  rateLimitPerMin: 10,
}

describe('① 「问助手自己」的识别：要准，也要稳', () => {
  test('业主实际问过的那几句都要命中', () => {
    for (const question of [
      '你现在是什么模型',
      '你是什么模型',
      '你是谁',
      '你叫什么名字',
      '你能做什么',
      '你能干什么？',
      '你怎么知道我能看哪些资料',
      '你会不会泄露别的老师的草稿',
      '你能修改资源吗',
      '你的知识来源是什么',
      'deepseek 是什么',
    ]) {
      assert.equal(isMetaQuestion(question), true, `应当识别为"问助手自己"：${question}`)
    }
  })

  test('问站内资料的问题**不能**被误判（否则会白白调模型、带偏回答）', () => {
    for (const question of [
      '体育',
      '现在有什么内容',
      '中秋主题活动怎么做',
      '上传完资源以后，为什么别人看不到？',
      '资源从草稿到发布要经过哪些步骤？',
      '蒙特梭利的日常生活区有哪些材料',
      '',
      '？',
    ]) {
      assert.equal(isMetaQuestion(question), false, `不该误判：${question}`)
    }
  })
})

describe('② 自我描述：据实、且不含密钥', () => {
  test('写明供应商与模型名（界面上本来也显示，透明不算泄密）', () => {
    const text = buildSelfDescription(CONFIG)
    assert.match(text, /deepseek/)
    assert.match(text, /deepseek-flash/)
    assert.match(text, /关于你自己/)
  })

  test('写清能力边界：不能发布/改权限、能看到什么由权限系统决定', () => {
    const text = buildSelfDescription(CONFIG)
    assert.match(text, /不能发布|不能.{0,4}修改/)
    assert.match(text, /权限系统|权限/)
  })

  test('**不含任何密钥痕迹**（只描述配置，不回显值）', () => {
    const text = buildSelfDescription({ ...CONFIG, model: 'some-model' })
    assert.doesNotMatch(text, /sk-|api[_-]?key|密钥值/i)
  })

  test('模型名变了，描述跟着变（不是写死的文案）', () => {
    assert.match(buildSelfDescription({ ...CONFIG, model: 'deepseek-reasoner' }), /deepseek-reasoner/)
  })

  test('普通问题的系统提示**不含**自我描述（保持回答聚焦在资料上）', () => {
    assert.equal(buildSystemPrompt(CONFIG), AI_SYSTEM_PROMPT)
    assert.doesNotMatch(buildSystemPrompt(CONFIG), /关于你自己/)
    assert.match(buildSystemPrompt(CONFIG, { meta: true }), /关于你自己/)
  })

  test('meta 提示里明确要求"不要编造版本号/训练数据"', () => {
    const text = buildSystemPrompt(CONFIG, { meta: true })
    assert.match(text, /不要编造/)
  })
})

describe('③ 没找到时的系统提示：说清身份、带回问题、给出路标', () => {
  test('明确声明"未调用 AI 模型"，并原样带回用户的问题', () => {
    const text = buildNoEvidenceAnswer({ question: '体育', directoryNames: ['Pre-K', 'K'] })
    assert.match(text, /未调用 AI 模型/)
    assert.match(text, /「体育」/)
    assert.match(text, /系统提示/)
  })

  test('列出**有权访问的目录**当路标', () => {
    const text = buildNoEvidenceAnswer({ question: '体育', directoryNames: ['Pre-K', 'K', '教师成长'] })
    assert.match(text, /Pre-K/)
    assert.match(text, /K/)
    assert.match(text, /教师成长/)
  })

  test('一个目录权限都没有时，明说没有授权（不列空清单）', () => {
    const text = buildNoEvidenceAnswer({ question: '体育', directoryNames: [] })
    assert.match(text, /没有任何目录/)
    assert.doesNotMatch(text, /有权访问的目录包括/)
  })

  test('meta 且资料为空时，用户消息要求"据实回答、不要用没找到来回避"', () => {
    const message = buildUserMessage('你现在是什么模型', '', { meta: true })
    assert.match(message, /关于你自己/)
    assert.match(message, /不要编造/)
    assert.doesNotMatch(message, /明确说明没有找到/)
  })

  test('非 meta 且资料为空时，仍然要求"没找到就说没找到"（不许编造）', () => {
    const message = buildUserMessage('体育', '', {})
    assert.match(message, /明确说明没有找到/)
  })
})
