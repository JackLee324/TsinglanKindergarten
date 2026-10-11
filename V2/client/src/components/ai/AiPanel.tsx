/**
 * client/src/components/ai/AiPanel.tsx —— AI 助手面板（桌面右侧抽屉 / 移动全屏）
 * ============================================================================
 * 业主 Stage 15 的界面要求，逐条落在下面：
 *   · **有入口、可点击**：侧边栏「AI 助手」与顶栏按钮都能打开（`AiAssistantContext`）；
 *   · 桌面是右侧抽屉（不离开当前页面），移动端是**全屏**（小屏上抽屉太窄没法读）；
 *   · 多轮对话 + 会话列表（新建 / 切换 / 删除）；
 *   · 加载中、**取消**（真的断开请求）、失败后**重试**；
 *   · 建议问题（来自服务端 `status.suggestedQuestions`，前端不写死）；
 *   · 引用是**可点的站内链接**（回答里的 [1] 与下方的「参考来源」都是）；
 *   · 未配置密钥时**说清原因**并且不做任何假装（输入框禁用、不显示建议问题），
 *     同时明确告诉用户"其它功能不受影响"。
 *
 * 与后端的分工：面板不知道权限，也不过滤任何东西 ——
 * 能问到什么由服务端按当前账号的目录权限决定（检索在 SQL 里就过滤过了）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, Loader2, Plus, Send, Square, Trash2, X } from 'lucide-react'
import { aiApi } from '../../api/ai'
import { ApiError } from '../../api/http'
import type { AiCitation, AiConversationSummary, AiMessage, AiStatus } from '../../api/types'
import { Button } from '../ui/Button'
import { useIsDesktop } from '../useMediaQuery'
import { cn } from '../ui/cn'
import { useAiAssistant } from './AiAssistantContext'
import { AnswerText } from './AnswerText'

/** 本地消息：服务端返回的消息 + "正在生成中"的占位（还没落库）。 */
interface LocalMessage extends AiMessage {
  readonly pending?: boolean
}

let tempId = 0
const nextTempId = (): string => `local-${++tempId}`

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'AI_DISABLED':
        return error.message
      case 'AI_RATE_LIMITED':
        return `${error.message}（每个账号每分钟有提问次数上限，等一会儿再问）`
      case 'AI_TIMEOUT':
        return 'AI 回答超时了。可以把问题问得更具体一些，或者稍后重试。'
      case 'AI_AUTH_ERROR':
        return 'AI 服务鉴权失败：请管理员检查服务端密钥配置。'
      case 'AI_CANCELLED':
        return '请求已取消。'
      default:
        return error.message
    }
  }
  if (error instanceof Error && error.name === 'AbortError') return '请求已取消。'
  return '出错了，请重试。'
}

export function AiPanel() {
  const { isOpen, close } = useAiAssistant()
  const isDesktop = useIsDesktop()

  const [status, setStatus] = useState<AiStatus | null>(null)
  const [conversations, setConversations] = useState<AiConversationSummary[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 上一次失败的问题：重试时原样重发（用户不必重新打字）。 */
  const [lastQuestion, setLastQuestion] = useState<string | null>(null)
  const [showConversations, setShowConversations] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const disabled = status !== null && !status.enabled

  /** 打开时拉状态与会话列表（状态只拉一次即可 —— 模型名不会中途变）。 */
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    void (async () => {
      try {
        const [s, list] = await Promise.all([aiApi.status(), aiApi.conversations().catch(() => [])])
        if (cancelled) return
        setStatus(s)
        setConversations(list)
      } catch {
        if (!cancelled) setError('读取 AI 状态失败，请刷新页面重试。')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isOpen])

  // 打开时把焦点给输入框（键盘用户不必先 Tab 一圈）
  useEffect(() => {
    if (isOpen && !disabled) inputRef.current?.focus()
  }, [isOpen, disabled])

  // 新消息到达后滚到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [messages])

  // Esc 关闭面板（与 Dialog 的行为一致）
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, close])

  // 关闭面板时中止进行中的提问：**不能让它继续烧钱**
  useEffect(() => {
    if (isOpen) return
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
  }, [isOpen])

  const loadConversation = useCallback(async (id: string) => {
    setConversationId(id)
    setError(null)
    setShowConversations(false)
    try {
      setMessages(await aiApi.messages(id))
    } catch {
      setError('读取这段对话失败，请重试。')
      setMessages([])
    }
  }, [])

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed === '' || busy || disabled) return
      setError(null)
      setLastQuestion(trimmed)
      setQuestion('')
      const controller = new AbortController()
      abortRef.current = controller
      setBusy(true)
      // 乐观显示：用户的问题立刻出现在对话里（不等服务端返回）
      setMessages((prev) => [
        ...prev,
        {
          id: nextTempId(),
          role: 'user',
          content: trimmed,
          citations: [],
          model: null,
          usage: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: nextTempId(),
          role: 'assistant',
          content: '',
          citations: [],
          model: null,
          usage: null,
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ])

      try {
        const input =
          conversationId === null ? { question: trimmed } : { question: trimmed, conversationId }
        const result = await aiApi.ask(input, controller.signal)
        if (controller.signal.aborted) return
        setConversationId(result.conversationId)
        // 把"正在生成中"的占位换成真正的回答（其余消息原样保留）
        setMessages((prev) => [
          ...prev.filter((m) => m.pending !== true),
          {
            id: nextTempId(),
            role: 'assistant',
            content: result.answer,
            citations: result.citations,
            model: result.model,
            usage: result.usage,
            createdAt: new Date().toISOString(),
          },
        ])
        setConversations(await aiApi.conversations().catch(() => conversations))
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.pending !== true))
        setError(errorText(e))
      } finally {
        abortRef.current = null
        setBusy(false)
      }
    },
    [busy, disabled, conversationId, conversations],
  )

  const cancel = (): void => {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setMessages((prev) => prev.filter((m) => m.pending !== true))
  }

  /** 回到空态（新对话 / 删掉当前会话之后）。**不动历史列表的开合** —— 
      删掉一段对话时列表突然消失会让人以为"整个历史都没了"。 */
  const startNew = (): void => {
    setConversationId(null)
    setMessages([])
    setError(null)
    setLastQuestion(null)
  }

  const removeConversation = async (id: string): Promise<void> => {
    try {
      await aiApi.deleteConversation(id)
    } catch {
      setError('删除对话失败，请重试。')
      return
    }
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (id === conversationId) startNew()
  }

  if (!isOpen) return null

  return (
    <>
      {/* 遮罩：桌面端点空白处关闭；移动端面板是全屏的，不需要遮罩 */}
      {isDesktop && (
        <div
          className="fixed inset-0 z-40 bg-black/20"
          data-testid="ai-backdrop"
          onMouseDown={close}
        />
      )}
      <section
        role="dialog"
        aria-label="AI 助手"
        data-testid="ai-panel"
        data-ai-mode={isDesktop ? 'drawer' : 'fullscreen'}
        className={cn(
          'fixed z-50 flex flex-col bg-card shadow-lg',
          isDesktop
            ? 'inset-y-0 right-0 w-[440px] border-l border-border'
            : 'inset-0 w-full',
        )}
      >
        {/* ── 头部 ───────────────────────────────────────────────────────── */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-dark">
              <Bot className="size-4" />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold text-foreground" data-testid="ai-title">
                AI 助手
              </p>
              <p className="truncate text-xs text-muted-foreground" data-testid="ai-model">
                {status === null ? '加载中…' : disabled ? '未启用' : `模型：${status.model}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              data-testid="ai-history-toggle"
              onClick={() => {
                const next = !showConversations
                setShowConversations(next)
                // 每次打开都重新拉一次：列表里显示的必须是服务端的当前状态
                if (next) void aiApi.conversations().then(setConversations).catch(() => {})
              }}
              title="历史对话"
            >
              历史
              {conversations.length > 0 && (
                <span className="text-xs text-muted-foreground">({conversations.length})</span>
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="ai-new"
              title="新对话"
              onClick={() => {
                startNew()
                setShowConversations(false)
              }}
            >
              <Plus className="size-4" />
              新对话
            </Button>
            <Button variant="ghost" size="sm" data-testid="ai-close" onClick={close} aria-label="关闭">
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {/* ── 历史对话列表 ───────────────────────────────────────────────── */}
        {showConversations && (
          <div className="max-h-56 shrink-0 overflow-y-auto border-b border-border bg-secondary/40 px-3 py-2" data-testid="ai-conversations">
            {conversations.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">还没有历史对话。</p>
            ) : (
              <ul className="space-y-1">
                {conversations.map((c) => (
                  <li key={c.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      data-testid="ai-conversation"
                      data-conversation-id={c.id}
                      data-active={String(c.id === conversationId)}
                      onClick={() => void loadConversation(c.id)}
                      className={cn(
                        'min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-xs min-h-10 sm:min-h-0',
                        c.id === conversationId
                          ? 'bg-primary/10 font-medium text-primary-dark'
                          : 'text-foreground hover:bg-card',
                      )}
                    >
                      {c.title === null || c.title === '' ? '（未命名对话）' : c.title}
                    </button>
                    <button
                      type="button"
                      aria-label="删除这段对话"
                      data-testid="ai-conversation-delete"
                      data-conversation-id={c.id}
                      onClick={() => void removeConversation(c.id)}
                      className="rounded p-2 text-muted-foreground hover:bg-card hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── 正文 ──────────────────────────────────────────────────────── */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4" data-testid="ai-messages">
          {disabled && (
            <div
              className="mb-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-foreground"
              data-testid="ai-disabled-notice"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <p className="font-medium">AI 助手当前不可用</p>
                <p className="mt-1">{status?.disabledReason ?? '未配置模型密钥。'}</p>
                <p className="mt-1 text-muted-foreground">
                  这是平台的<strong className="font-medium">可选能力</strong>：上传、预览、下载、审核等功能不受影响，照常可用。
                </p>
              </div>
            </div>
          )}

          {messages.length === 0 && !disabled && (
            <div className="space-y-3" data-testid="ai-empty">
              <p className="text-sm text-muted-foreground">
                我可以帮你找站内的课程资料、解释平台的使用与审核规则。
                <br />
                只能看到你有权限查看的内容，回答会给出引用来源。
              </p>
              {status !== null && status.suggestedQuestions.length > 0 && (
                <div className="space-y-2" data-testid="ai-suggestions">
                  <p className="text-xs font-medium text-muted-foreground">可以试试问：</p>
                  {status.suggestedQuestions.map((q) => (
                    <button
                      key={q}
                      type="button"
                      data-testid="ai-suggestion"
                      onClick={() => void ask(q)}
                      className="block w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-foreground hover:border-primary hover:bg-primary/5"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {status !== null && (
                <p className="text-xs text-muted-foreground" data-testid="ai-index-summary">
                  已索引资料片段 {status.index.chunks.READY ?? 0} 条
                  {status.visionOcr ? '（图片用模型识图转文字）' : ''}
                </p>
              )}
            </div>
          )}

          <div className="space-y-3">
            {messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </div>
        </div>

        {/* ── 错误 + 重试 ───────────────────────────────────────────────── */}
        {error !== null && (
          <div
            className="flex items-start justify-between gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-foreground"
            data-testid="ai-error"
          >
            <span className="leading-relaxed">{error}</span>
            <div className="flex shrink-0 items-center gap-1">
              {lastQuestion !== null && !busy && !disabled && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="ai-retry"
                  onClick={() => void ask(lastQuestion)}
                >
                  重试
                </Button>
              )}
              <button
                type="button"
                aria-label="关闭提示"
                data-testid="ai-error-dismiss"
                onClick={() => setError(null)}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* ── 输入区 ────────────────────────────────────────────────────── */}
        <div className="shrink-0 border-t border-border px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              data-testid="ai-input"
              value={question}
              disabled={disabled}
              rows={2}
              maxLength={500}
              placeholder={disabled ? 'AI 助手未启用' : '问点什么…（Enter 发送，Shift+Enter 换行）'}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void ask(question)
                }
              }}
              className={cn(
                'min-h-11 flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm',
                'focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            />
            {busy ? (
              <Button variant="outline" size="sm" data-testid="ai-cancel" onClick={cancel} className="h-11">
                <Square className="size-4" />
                取消
              </Button>
            ) : (
              <Button
                size="sm"
                data-testid="ai-send"
                disabled={disabled || question.trim() === ''}
                onClick={() => void ask(question)}
                className="h-11"
              >
                <Send className="size-4" />
                发送
              </Button>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground" data-testid="ai-footnote">
            AI 只能检索你有权限查看的资料，回答仅供参考；它不能修改资源或权限。
          </p>
        </div>
      </section>
    </>
  )
}

/** 一条消息（用户 / 助手）。助手消息带引用来源列表。 */
function MessageRow({ message }: { readonly message: LocalMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="ai-message-user">
        <p className="max-w-[85%] rounded-xl rounded-br-sm bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground">
          {message.content}
        </p>
      </div>
    )
  }

  /*
    系统提示（没有调用模型）与模型回答必须一眼分得开：
    系统提示用虚线边框 + 灰底 + 标签，模型回答用普通气泡。
    2026-10-11 业主把系统提示当成了"AI 敷衍"，就是因为两者长得一样。
  */
  const isSystem = message.pending !== true && message.model === null

  return (
    <div className="flex flex-col gap-1" data-testid="ai-message-assistant" data-answer-by={isSystem ? 'system' : 'model'}>
      {isSystem && (
        <span
          className="flex w-fit items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
          data-testid="ai-system-answer-label"
        >
          <AlertTriangle className="size-3" />
          系统提示 · 未调用 AI 模型
        </span>
      )}
      <div
        className={cn(
          'max-w-[95%] rounded-xl rounded-bl-sm border px-3 py-2',
          isSystem ? 'border-dashed border-border bg-muted/40' : 'border-border bg-secondary/40',
        )}
      >
        {message.pending === true ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ai-loading">
            <Loader2 className="size-4 animate-spin" />
            正在查阅站内资料…
          </p>
        ) : (
          <AnswerText text={message.content} citations={message.citations} />
        )}
      </div>
      {message.pending !== true && message.citations.length > 0 && (
        <CitationList citations={message.citations} />
      )}
    </div>
  )
}

/** 参考来源：可点的站内链接（这是业主明确要求的"引用链接"）。 */
function CitationList({ citations }: { readonly citations: readonly AiCitation[] }) {
  return (
    <div className="max-w-[95%] rounded-lg border border-dashed border-border px-3 py-2" data-testid="ai-citations">
      <p className="text-[11px] font-medium text-muted-foreground">参考来源</p>
      <ul className="mt-1 space-y-1">
        {citations.map((c) =>
          c.url === null ? (
            <li key={`${c.index}-${c.title}`} className="text-xs text-muted-foreground">
              [{c.index}] {c.title}
            </li>
          ) : (
            <li key={`${c.index}-${c.resourceId}`}>
              <Link
                to={c.url}
                data-testid="ai-citation"
                data-resource-id={c.resourceId}
                className="text-xs text-primary-dark underline-offset-2 hover:underline"
              >
                [{c.index}] {c.title}
                {c.directoryPath === '' ? '' : `（${c.directoryPath}）`}
              </Link>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}
