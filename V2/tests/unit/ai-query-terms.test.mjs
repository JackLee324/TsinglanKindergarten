/**
 * tests/unit/ai-query-terms.test.mjs —— 提问 → 词元（中文检索能不能用的关键一步）
 * ============================================================================
 * 背景：生产库没有 pgvector，检索只能走词法匹配；而 Postgres 的 `simple` 分词器
 * **不切中文**（整段连续汉字是一个词）。所以"老师随口问的一句话"必须在这里被切成
 * 短词元，否则 `plainto_tsquery` 要求整段同时出现 —— 正常提问一律命中 0 条。
 *
 * 这份测试钉住四件事：
 *   ① 长问句会被切出**多个**词元（否则多条件提问必然落空）；
 *   ② 虚词被剔除，实词保留（尤其「中文」「功能」这类含虚字的实词不能被误伤）；
 *   ③ 词元数量有上限（拼进 SQL 的条件数必须有界）；
 *   ④ LIKE 模式里的通配符被转义（否则用户输入 `%` 会变成"匹配一切"）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { aiQueryTerms } from '../helpers/modules.mjs'

const { queryTerms, likePattern } = aiQueryTerms

describe('① 中文长问句：切成短词元，才能被词法检索命中', () => {
  test('一句多条件提问会被切成多个词元（而不是一个整段）', () => {
    const { terms } = queryTerms('资源从草稿到发布要经过哪些步骤？')
    assert.equal(terms.length >= 6, true, `词元太少：${JSON.stringify(terms)}`)
    assert.equal(terms.includes('草稿'), true, '「草稿」必须作为独立词元')
    assert.equal(terms.includes('发布'), true, '「发布」必须作为独立词元')
    assert.equal(terms.some((t) => t.length > 6), false, `不该出现长整段词元：${JSON.stringify(terms)}`)
  })

  test('二元组覆盖连续汉字（中文两字组合已经足够有区分度）', () => {
    const { terms } = queryTerms('蒙特梭利')
    assert.deepEqual(
      [...terms].sort(),
      ['蒙特', '特梭', '梭利', '蒙特梭利'].sort(),
      '四字词：整词 + 三个二元组（短词的整词更精确，留着有用）',
    )
  })

  test('标点与空格是分隔符：逗号两侧各自切词', () => {
    const { terms } = queryTerms('上传完资源以后，为什么别人看不到？')
    assert.equal(terms.includes('上传'), true)
    assert.equal(terms.includes('资源'), true)
    assert.equal(terms.includes('别人'), true)
    assert.equal(terms.includes('不到'), true)
  })

  test('重复词元只出现一次（避免同一条件在 SQL 里算两遍）', () => {
    const { terms } = queryTerms('草稿 草稿 草稿')
    assert.equal(new Set(terms).size, terms.length)
  })
})

describe('② 虚词剔除：剔除的是虚词，不能误伤实词', () => {
  test('「的/了/吗/怎么/为什么/哪些」被剔除', () => {
    const { terms } = queryTerms('这个是怎么做的呢')
    for (const stop of ['的', '了', '吗', '呢', '怎么']) {
      assert.equal(terms.includes(stop), false, `虚词「${stop}」不该成为词元：${JSON.stringify(terms)}`)
    }
  })

  test('**实词里含虚字也不能被切坏**（中文 / 功能 / 目的）', () => {
    const { terms } = queryTerms('中文功能')
    assert.equal(terms.includes('中文'), true, '「中」不能被当成虚词删掉')
    assert.equal(terms.includes('功能'), true, '「能」不能被当成虚词删掉')
    // 短片段整段保留 → 含虚字的实词（目的）不会因为剔除「的」而消失
    assert.equal(queryTerms('目的').terms.includes('目的'), true, '「目的」必须能作为词元')
    assert.equal(queryTerms('资料夹').terms.includes('资料夹'), true, '「资料夹」必须能作为词元')
  })

  test('长片段才会剔除虚字：剩下的是实词二元组', () => {
    const { terms } = queryTerms('关于蒙特梭利的教学素材')
    assert.equal(terms.includes('蒙特'), true)
    assert.equal(terms.includes('梭利'), true)
    assert.equal(terms.includes('教学'), true)
    assert.equal(terms.includes('素材'), true)
    assert.equal(terms.includes('关于'), false, '「关于」是虚词，剔除后不该留下含它的二元组')
  })

  test('纯标点/空白 → 没有词元（调用方据此不去构造 ILIKE）', () => {
    assert.deepEqual(queryTerms('？。，！').terms, [])
    assert.deepEqual(queryTerms('   ').terms, [])
  })
})

describe('③ 有界：词元数量有上限（SQL 条件数必须可控）', () => {
  test('超长提问的词元数不超过上限', () => {
    const long = '关于蒙特梭利教学素材与观察评价以及课程大纲和教学详案还有课件与示范的说明'.repeat(3)
    const { terms } = queryTerms(long)
    assert.equal(terms.length <= 24, true, `词元太多：${terms.length}`)
    const capped = queryTerms(long, { maxTerms: 5 })
    assert.equal(capped.terms.length, 5)
  })

  test('英文按整词保留（含连字符），不切字母二元组', () => {
    const { terms } = queryTerms('Pre-K 的英文课程')
    assert.equal(terms.includes('pre-k'), true, 'Pre-K 要作为一个词才能对上原文')
    assert.equal(terms.includes('pr'), false, '英文不能切字母二元组')
  })

  test('**中英混排不能切出跨语种垃圾词元**（「调用Ai」曾经切出「用A」）', () => {
    const { terms } = queryTerms('调用Ai')
    assert.deepEqual([...terms].sort(), ['ai', '调用'].sort(), `混排词元应当干净：${JSON.stringify(terms)}`)
    assert.equal(terms.some((t) => /[\u4e00-\u9fff][a-z]/i.test(t)), false, '不该出现"汉字+字母"的相邻词元')
    const ordered = queryTerms('怎么调用AI助手')
    assert.equal(ordered.terms.includes('ai'), true)
    assert.equal(ordered.terms.includes('助手'), true)
    assert.equal(ordered.terms.some((t) => t === '用A' || t === 'I助'), false)
  })

  test('单字与空白片段被丢弃（长度 < 2 没有检索意义）', () => {
    const { terms } = queryTerms('a 中 ?')
    assert.deepEqual(terms, [])
  })
})

describe('④ LIKE 模式：用户输入的通配符必须被转义', () => {
  test('% _ \\ 都被转义（否则 `%` 会变成"匹配一切"）', () => {
    assert.equal(likePattern('100%'), '%100\\%%')
    assert.equal(likePattern('a_b'), '%a\\_b%')
    assert.equal(likePattern('c\\d'), '%c\\\\d%')
  })
})
