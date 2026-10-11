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

const { isMetaQuestion, buildSelfDescription, buildSystemPrompt, buildPlatformFacts, buildUserMessage, AI_SYSTEM_PROMPT } =
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
      // 业主第二轮实测问过的（当时落进了固定文案）
      '调用Ai',
      '怎么调用AI助手',
      '使用AI',
      'AI助手在哪',
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
      '体育',
      '中秋主题活动做月饼',
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

describe('③ 没有资料依据时：**交给模型**去说，但纪律写在我们这边', () => {
  test('给模型的指令里必须有"据实说没找到 + 不许编造 + 不许编号引用"', () => {
    const message = buildUserMessage('在吗', '', { facts: buildPlatformFacts({ directoryNames: ['教育教学'], visibleResourceCount: 12 }) })
    assert.match(message, /没有找到/, '要明确要求说没找到')
    assert.match(message, /不要.{0,4}编造|绝对不要/, '要明确禁止编造')
    assert.match(message, /不要[^\n]{0,24}编号引用/, '没有来源时不许给 [1][2] 这类引用')
    assert.match(message, /课程目录|关键词/, '要给出可操作的下一步')
  })

  test('平台事实：只含"他有权限访问的目录"与"他能看到的资源条数"', () => {
    const facts = buildPlatformFacts({ directoryNames: ['Pre-K', 'K'], visibleResourceCount: 37 })
    assert.match(facts, /Pre-K/)
    assert.match(facts, /37/)
    assert.match(facts, /你能看到的资源/, '措辞要准：管理员能看草稿，不能写成"已发布"')
    assert.match(facts, /平台事实/)
  })

  test('一个目录权限都没有时，平台事实据实说"没有任何目录的查看授权"', () => {
    const facts = buildPlatformFacts({ directoryNames: [], visibleResourceCount: 0 })
    assert.match(facts, /没有任何目录/)
  })

  test('没有给出平台事实时，不会留下空的事实区块（只是指令里提到它）', () => {
    const message = buildUserMessage('在吗', '', {})
    assert.doesNotMatch(message, /【平台事实】/, '没有事实就整块不出现')
  })

  test('meta 且资料为空时，要求"据实回答、不要用没找到来回避"', () => {
    const message = buildUserMessage('你现在是什么模型', '', { meta: true })
    assert.match(message, /关于你自己/)
    assert.match(message, /不要编造/)
    assert.doesNotMatch(message, /先明确说明"现有资料里没有找到/)
  })

  test('有资料时仍然是老口径：资料区块 + 提问，不带"没找到"指令', () => {
    const message = buildUserMessage('蓝莓藤蔓主题', '[1] 来源类型：FILE_TEXT｜标题：素材\n内容…', {})
    assert.match(message, /<<<资料开始>>>/)
    assert.doesNotMatch(message, /铁律提醒/)
  })
})
