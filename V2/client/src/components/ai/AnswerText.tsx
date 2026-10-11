/**
 * client/src/components/ai/AnswerText.tsx —— 把回答渲染成**安全的**富文本
 * ============================================================================
 * 为什么不用 `dangerouslySetInnerHTML` + 一个 markdown 库：
 *   回答里会出现**上传文档的内容**（老师传的文件可能包含 `<script>`、`<img onerror>`）。
 *   把它当 HTML 插进页面，就等于让"往平台传一个文件"变成"在别人浏览器里执行脚本"。
 *   所以这里全部走 React 元素：**没有任何一处把字符串当 HTML 解析**。
 *
 * 支持的语法刻意只有回答真正会用到的四种（多一种就多一处出错的地方）：
 *   · 段落（空行分隔）、`- ` 无序列表、`1. ` 有序列表、`### ` 小标题
 *   · 行内 `**加粗**`、`` `代码` ``
 *   · 引用标记 `[1]`：解析成指向引用来源的**站内链接**（资源的 url 由服务端给出）
 */
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AiCitation } from '../../api/types'

/** 行内解析：`**粗**`、`` `码` ``、`[n]`（引用）。 */
function renderInline(text: string, citations: readonly AiCitation[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // 一个正则同时匹配三种行内标记，顺序即优先级
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[(\d{1,2})\]/g
  let last = 0
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const key = `${keyPrefix}-i${index++}`
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-foreground">
          {match[1]}
        </strong>,
      )
    } else if (match[2] !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-secondary px-1 py-0.5 text-[0.8em]">
          {match[2]}
        </code>,
      )
    } else {
      const number = Number(match[3])
      const citation = citations.find((c) => c.index === number)
      if (citation === undefined) {
        // 模型引用了不存在的编号：原样显示，不假装它是链接（宁可不漂亮，也不要假链接）
        nodes.push(match[0])
      } else if (citation.url !== null) {
        nodes.push(
          <Link
            key={key}
            to={citation.url}
            title={`${citation.title}${citation.directoryPath === '' ? '' : ` ｜ ${citation.directoryPath}`}`}
            data-testid="ai-citation-link"
            data-citation-index={String(number)}
            className="mx-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 text-[0.75em] font-medium text-primary-dark align-super hover:bg-primary/20"
          >
            [{number}]
          </Link>,
        )
      } else {
        nodes.push(
          <span
            key={key}
            title={citation.title}
            data-testid="ai-citation-plain"
            className="mx-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-secondary px-1.5 text-[0.75em] font-medium text-muted-foreground align-super"
          >
            [{number}]
          </span>,
        )
      }
    }
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** 块级解析：按行成段，列表连续项合并成一个 `<ul>`，`### ` 成小标题。 */
export function AnswerText({
  text,
  citations = [],
  testId = 'ai-answer',
}: {
  readonly text: string
  readonly citations?: readonly AiCitation[]
  readonly testId?: string
}) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let list: string[] = []
  let key = 0

  const flushList = (): void => {
    if (list.length === 0) return
    blocks.push(
      <ul key={`ul-${key++}`} className="my-1 list-disc space-y-1 pl-5">
        {list.map((item, i) => (
          <li key={i}>{renderInline(item, citations, `li-${key}-${i}`)}</li>
        ))}
      </ul>,
    )
    list = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const heading = /^#{2,4}\s+(.*)$/.exec(line)
    if (bullet !== null) {
      list.push(bullet[1])
      continue
    }
    flushList()
    if (line.trim() === '') continue
    if (heading !== null) {
      blocks.push(
        <p key={`h-${key++}`} className="mt-2 font-semibold text-foreground">
          {renderInline(heading[1], citations, `h-${key}`)}
        </p>,
      )
      continue
    }
    blocks.push(
      <p key={`p-${key++}`} className="whitespace-pre-wrap">
        {renderInline(line, citations, `p-${key}`)}
      </p>,
    )
  }
  flushList()

  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-foreground" data-testid={testId}>
      {blocks.map((block, i) => (
        <Fragment key={i}>{block}</Fragment>
      ))}
    </div>
  )
}
