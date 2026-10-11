/**
 * server/ai/query-terms.ts —— 把"老师随口问的一句话"变成可检索的词元
 * ============================================================================
 * 为什么需要它（这是实测出来的问题，不是设计洁癖）：
 *
 * 生产库**没有 pgvector**（实测 `pg_available_extensions` 里只有 pg_trgm / unaccent），
 * 所以检索只能走词法匹配：pg_trgm 相似度 + `ILIKE` + `to_tsvector('simple')`。
 * 而 Postgres 的 `simple` 分词器**不切中文** —— 一整段连续汉字会被当成**一个词**。
 * 后果是：问「蓝莓藤蔓主题 还能怎么延伸？」时，tsquery 变成
 * `'蓝莓藤蔓主题' & '还能怎么延伸'`，要求两个词**同时**出现；而资料里只有前者，
 * 于是命中 0 条、AI 回答"没找到" —— 一句完全正常的提问被判成没资料。
 *
 * 处理办法：把提问切成**短词元**再逐个匹配，并且用"覆盖率"打分：
 *   · 去掉"的/了/是/吗/怎么/为什么/哪些…"这类不承载检索意义的虚词；
 *   · 对剩下的中文片段取**二元组（bigram）** —— 中文里两字组合已经足够有区分度
 *     （「资料夹」「草稿」「权限」「上传」都是两字词），不像三元组那样容易整段落空；
 *   · 英文/数字保留整词（英文没有"字"的概念，切碎只会更差）；
 *   · 相关判定 = **至少命中 2 个词元** 且 **覆盖率 ≥ 20%**（两个条件都要）。
 *
 * 门槛是这样定出来的（对着真实语料量的，不是拍的）：
 *   · 单个二字组合的巧合太多 —— 实测「草稿里的秘密」这类**故意用来验证权限边界**的
 *     查询，会因为在站规里撞上「草稿」而命中 1 个词元；要求 ≥2 个就把它挡在门外，
 *     于是"检索不到无权内容"这条断言仍然成立（`ai-index-retrieval.test.mjs` ③）。
 *   · 但真实提问会很长：「资源从草稿到发布要经过哪些步骤？」有 12 个词元，
 *     资料里只能命中 3 个（覆盖率 0.25）—— 要求 50% 会把这类**完全正常的提问**
 *     判成"没资料"，AI 就变成"问什么都说找不到"。所以覆盖率下限放到 20%，
 *     同时用"≥2 个词元"兜住短查询。
 *
 * 覆盖率门槛为什么必须有：低于它，随便一段文字都可能因为撞上一两个二字组合
 * 而被当成"依据" —— 那会让 AI 拿着无关资料硬答（比回答"没找到"更糟）。
 * 门槛以上的部分映射成 0.6~1.0 的分数（见 retrieval.service.ts 的 SQL），
 * 让"命中更多词元"的资料排在前面。
 *
 * ⚠️ 这只是**排序与召回**的手段，不是权限手段：候选集在 SQL 里就已经按
 *    `AuthorizationService` 的策略过滤过了（见 retrieval.service.ts）。
 *    词元来自用户的提问，永远不会扩大他能看到的范围。
 */
import { normalizeText } from './chunk'

/** 只有虚词才剔除；任何可能构成实词的单字都保留（例如「中」「能」「要」）。 */
const STOP_PHRASES: readonly string[] = [
  '为什么',
  '怎么样',
  '怎么',
  '怎样',
  '如何',
  '什么',
  '哪些',
  '哪个',
  '多少',
  '是否',
  '能否',
  '可以',
  '能不能',
  '是不是',
  '有没有',
  '我们',
  '你们',
  '他们',
  '以及',
  '一下',
  '一个',
  '以后',
  '关于',
  '有关',
  '针对',
  '然后',
  '还有',
  '还是',
  '比如',
  '例如',
  '这样',
  '那样',
  '就是',
  '目前',
  '现在',
  '应该',
  '需要',
  '请问',
]

/** 单字虚词（只列绝不会成为实词成分的那些：「中文」的「中」、「功能」的「能」不在其中） */
const STOP_CHARS: readonly string[] = ['的', '了', '吗', '呢', '吧', '啊', '请', '我', '你', '他', '她', '它', '们', '这', '那', '些', '都', '也', '还', '就']

const HAN = /\p{Script=Han}/u
/** 按"非（汉字/字母/数字/连字符）"切段：标点、空格都是分隔符。 */
const SEGMENT_SPLIT = /[^\p{Script=Han}\p{L}\p{N}-]+/u

export interface QueryTerms {
  /** 原始查询（保留给字面量匹配 / 相似度 / 全文检索用）。 */
  readonly raw: string
  /** 词元列表（中文二元组 + 英文整词），去重且保序。 */
  readonly terms: readonly string[]
}

function stripStopWords(segment: string): string {
  let out = segment
  for (const phrase of STOP_PHRASES) {
    if (out.length < phrase.length) continue
    out = out.split(phrase).join('')
  }
  for (const char of STOP_CHARS) {
    if (out.length <= 1) break
    out = out.split(char).join('')
  }
  return out
}

/**
 * 中文片段 → 词元。
 *
 * 短片段（≤6 字）先**整段**保留：老师用几个字提问时，那通常就是一个关键词
 * （「草稿」「假期」「目的」「资料夹」），整段匹配比拆成二元组更精确，
 * 也避免「目的」这类含虚字的实词被虚词剔除误伤。
 * 长片段只取二元组 —— 一整句几乎不可能在资料里原样出现。
 */
function hanTerms(segment: string, push: (term: string) => void): void {
  if (segment.length <= 6) push(segment)
  const content = stripStopWords(segment)
  if (content.length < 2) return
  if (content.length <= 4) push(content)
  for (let i = 0; i + 2 <= content.length; i += 1) push(content.slice(i, i + 2))
}

/**
 * 把提问拆成词元。纯函数，无 IO —— 单元测试直接压它
 * （`tests/unit/ai-query-terms.test.mjs`）。
 */
export function queryTerms(query: string, options: { readonly maxTerms?: number } = {}): QueryTerms {
  const raw = normalizeText(query)
  const maxTerms = Math.max(1, options.maxTerms ?? 24)
  const seen = new Set<string>()
  const terms: string[] = []
  const push = (term: string): void => {
    const t = term.trim()
    if (t.length < 2) return
    if (seen.has(t)) return
    if (terms.length >= maxTerms) return
    seen.add(t)
    terms.push(t)
  }

  for (const segment of raw.split(SEGMENT_SPLIT)) {
    if (segment === '') continue
    if (HAN.test(segment)) {
      hanTerms(segment, push)
      continue
    }
    // 英文/数字：整词（含连字符，例如 Pre-K 要作为一个词才能对上原文）
    for (const token of segment.split('-').length > 1 ? [segment, ...segment.split('-')] : [segment]) {
      push(token.toLowerCase())
    }
  }

  return { raw, terms }
}

/** 字面量匹配用的 LIKE 模式（转义 % _ \，与原来的检索保持一致）。 */
export function likePattern(text: string): string {
  return `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`
}
