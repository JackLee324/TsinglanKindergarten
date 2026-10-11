/**
 * tests/unit/ai-chunk.test.mjs —— 分片必须确定、有界、不丢边界
 * ============================================================================
 * 为什么这么较真：`ai_chunks` 的唯一键是 (来源, 下标)。分片只要不确定，
 * 每次重索引都会写出"看起来是新的"片段 —— 幂等形同虚设（业主 §五）。
 * 另外每片都必须**真的**不超过上限：否则"按上限估算 token 预算"就是假的。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { aiChunk } from '../helpers/modules.mjs'

const { chunkText, normalizeText } = aiChunk

describe('① 确定性：同样的输入 × 两次 = 同样的输出', () => {
  test('中文长文重复切分结果完全一致', () => {
    const input = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段：这是关于主题教学的说明，包含中文与 English words。`).join('\n\n')
    const a = chunkText(input, { maxChars: 200 })
    const b = chunkText(input, { maxChars: 200 })
    assert.deepEqual(a, b)
    assert.equal(a.length > 1, true, '应当切成多片')
  })

  test('规范化：CRLF、连续空行、行内多余空格都被抹平', () => {
    assert.equal(normalizeText('a\r\n\r\n\r\n\r\nb   c'), 'a\n\nb c')
    assert.equal(normalizeText('  \n\n 只留这段 \n\n  '), '只留这段')
  })
})

describe('② 每片都在"目标上限 + 有界重叠"之内', () => {
  test('任何一片都不超过 maxChars + overlap（不为了卡上限把句子截断）', () => {
    const text = Array.from({ length: 40 }, () => '素材与工作单：请小朋友把形状与颜色配对，并说明理由。').join('\n\n')
    for (const maxChars of [120, 200, 500]) {
      const overlap = Math.floor(maxChars * 0.1)
      const chunks = chunkText(text, { maxChars, overlap })
      for (const chunk of chunks) {
        // 上限 = 目标 + 重叠 + 2（拼接重叠用的换行）；这是**有界**的，不是无界漂移
        assert.equal(
          chunk.length <= maxChars + overlap + 2,
          true,
          `超过 maxChars+overlap+2（${maxChars}+${overlap}+2）：${chunk.length}`,
        )
      }
      // 第一片没有重叠前缀，必须严格不超过目标值
      assert.equal(chunks[0].length <= maxChars, true)
    }
  })

  test('没有任何一片是空串或纯空白', () => {
    const chunks = chunkText('甲。\n\n\n\n乙。\n\n   \n\n丙。', { maxChars: 100 })
    for (const chunk of chunks) assert.equal(chunk.trim().length > 0, true)
  })
})

describe('③ 边界：句子边界优先、无标点则硬切、上限片数', () => {
  test('超长段落优先在句末标点处断开', () => {
    const sentence = '这是一个很长的句子。'
    const paragraph = sentence.repeat(40) // 400 字，无空行
    const chunks = chunkText(paragraph, { maxChars: 100 })
    assert.equal(chunks.length > 1, true)
    for (const chunk of chunks.slice(0, -1)) {
      assert.equal(/[。！？]$/.test(chunk.trim()), true, `应当断在句末：${chunk.slice(-12)}`)
    }
  })

  test('完全没有标点的长串也能切开（不会产出一个超长片）', () => {
    const chunks = chunkText('啊'.repeat(500), { maxChars: 120, overlap: 12 })
    assert.equal(chunks.length >= 4, true)
    for (const chunk of chunks) assert.equal(chunk.length <= 120 + 12 + 2, true)
  })

  test('片数上限生效（防御超大文档）', () => {
    const chunks = chunkText('句子。'.repeat(2000), { maxChars: 100, maxChunks: 5 })
    assert.equal(chunks.length, 5)
  })

  test('空输入 / 纯空白 → 没有任何片段（不是"一个空片段"）', () => {
    assert.deepEqual(chunkText('', { maxChars: 100 }), [])
    assert.deepEqual(chunkText('   \n\n \t ', { maxChars: 100 }), [])
  })

  test('重叠：相邻片段确实共享内容（避免答案正好被切在边界）', () => {
    const text = Array.from({ length: 12 }, (_, i) => `第${i}段内容甲乙丙丁戊己庚辛壬癸。`).join('\n\n')
    const chunks = chunkText(text, { maxChars: 60, overlap: 12 })
    assert.equal(chunks.length > 1, true)
    const tail = chunks[0].slice(-8)
    assert.equal(chunks[1].includes(tail), true, '下一片应当带着上一片的尾部')
  })
})
