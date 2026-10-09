import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { filesApi } from '../../api/files'
import type { PreviewResponse, ResourceFileSummary } from '../../api/types'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Spinner } from '../ui/Spinner'
import { humanMessage } from './errors'

/**
 * 文件预览。
 *
 * 业主 §19 的要求：**优先用浏览器原生能力**，不引入巨型 PDF SDK。
 *   · PDF  → `<iframe>`（浏览器自带的 PDF 阅读器）
 *   · 图片 → `<img>`
 *   · TXT  → 取回文本自己渲染（**不是** iframe，见下）
 *
 * §36 的安全边界也在这里：
 *   · 预览地址是**服务端签发的短命 URL**，类型与处置方式由服务端决定（写进签名）；
 *   · TXT 用 `fetch(...).text()` 读回来当**文本**渲染 —— 绝不会把它塞进 iframe，
 *     因此一个内容是 HTML 的 .txt 不会执行任何脚本；
 *   · 不做 SVG 内联、不做 `dangerouslySetInnerHTML`。
 *
 * 不支持的类型**打不开这个弹窗**（列表里根本没有预览按钮），
 * 这里再兜一次：拿到 `previewable: false` 就显示那句话。
 */
export function FilePreviewDialog({
  resourceId,
  file,
  onClose,
}: {
  readonly resourceId: string
  readonly file: ResourceFileSummary
  readonly onClose: () => void
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'text'; content: string }
    | { kind: 'url'; preview: Extract<PreviewResponse, { previewable: true }> }
    | { kind: 'unsupported'; message: string }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' })
  const [downloading, setDownloading] = useState(false)
  /** 点「重新加载」时 +1：重新申请一个**新的**签名地址（旧的可能已过期）。 */
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    filesApi
      .preview(resourceId, file.id)
      .then(async (res) => {
        if (cancelled) return
        if (!res.previewable) {
          setState({ kind: 'unsupported', message: res.message })
          return
        }
        if (res.viewer === 'text') {
          // 纯文本：自己读回来渲染成文本节点，永远不当作 HTML。
          //
          // ⚠️ 必须先看 `response.ok`：签名地址可能已过期、对象可能已经不在存储里，
          // 那些情况下响应体是一段 XML/HTML 错误页 —— 直接 `.text()` 会把它
          // **当成文件内容渲染出来**，看起来像"预览成功了，只是内容很怪"。
          // 这类"假成功"比报错更糟，所以这里显式判断状态码。
          const response = await fetch(res.url)
          if (!response.ok) {
            if (!cancelled) {
              setState({
                kind: 'error',
                message: `无法读取文件内容（存储返回 ${response.status}）。文件可能已被移除，或预览地址已过期 —— 可以点「重新加载」。`,
              })
            }
            return
          }
          const text = await response.text()
          if (!cancelled) setState({ kind: 'text', content: text })
          return
        }
        setState({ kind: 'url', preview: res })
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: 'error', message: humanMessage(e, '预览加载失败') })
      })
    return () => {
      cancelled = true
    }
  }, [resourceId, file.id, reloadToken])

  /**
   * 下载。
   *
   * 原先这里是 `try { … } finally { … }`：申请签名地址失败时异常会**逃出去**
   * （调用方是 `void download()`），于是用户什么提示都没有，控制台里多一条
   * 未处理的 Promise rejection。现在把失败变成一句人话。
   */
  async function download() {
    setDownloading(true)
    setState((prev) => (prev.kind === 'error' ? { kind: 'loading' } : prev))
    try {
      const { url } = await filesApi.download(resourceId, file.id)
      window.location.assign(url)
    } catch (e) {
      setState({ kind: 'error', message: humanMessage(e, '下载失败') })
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Dialog open title={`预览：${file.fileName}`} testId="file-preview-dialog" onClose={onClose}>
      <div className="space-y-3">
        <div
          className="overflow-hidden rounded-lg border border-border bg-secondary"
          data-testid="file-preview-body"
          data-viewer={state.kind === 'url' ? state.preview.viewer : state.kind}
        >
          {state.kind === 'loading' && (
            <div className="flex h-64 items-center justify-center">
              <Spinner label="正在加载预览…" />
            </div>
          )}

          {state.kind === 'unsupported' && (
            <p className="p-6 text-center text-sm text-muted-foreground" data-testid="file-preview-message">
              {state.message}
            </p>
          )}

          {state.kind === 'error' && (
            <div className="p-6 text-center">
              <p className="text-sm text-destructive" data-testid="file-preview-error">
                {state.message}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setReloadToken((n) => n + 1)}
                data-testid="file-preview-retry"
              >
                重新加载
              </Button>
            </div>
          )}

          {state.kind === 'text' && (
            <pre
              className="max-h-[60vh] overflow-auto whitespace-pre-wrap p-4 text-sm text-foreground"
              data-testid="file-preview-text"
            >
              {state.content}
            </pre>
          )}

          {state.kind === 'url' && state.preview.viewer === 'pdf' && (
            // 浏览器自带的 PDF 阅读器 —— 不引入任何 PDF SDK。
            // `<iframe>` 的加载失败**不会**冒泡成 JS 异常，所以无法像 <img> 那样捕获；
            // 因此给用户一个明确的手动出口：「打不开？重新加载 / 下载」。
            <div>
              <iframe
                title={file.fileName}
                src={state.preview.url}
                className="h-[60vh] w-full bg-white"
                data-testid="file-preview-pdf"
              />
              <p className="border-t border-border bg-white/60 px-3 py-2 text-xs text-muted-foreground">
                如果这里一直空白，说明浏览器没能取到文件（地址可能已过期）。
                点下面的「重新加载」重新申请地址，或直接「下载」。
              </p>
            </div>
          )}

          {state.kind === 'url' && state.preview.viewer === 'image' && (
            <div className="flex max-h-[60vh] items-center justify-center p-2">
              <img
                src={state.preview.url}
                alt={file.fileName}
                className="max-h-[56vh] max-w-full rounded object-contain"
                data-testid="file-preview-image"
                onError={() => {
                  // 图片解码/加载失败是可捕获的：给明确错误，不要停在空白/加载中。
                  setState({
                    kind: 'error',
                    message:
                      '图片没能加载出来。文件可能已被移除，或预览地址已过期 —— 可以点「重新加载」。',
                  })
                }}
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            预览地址是短时有效的授权地址，不会公开文件位置。
          </p>
          <div className="flex gap-2">
            {state.kind === 'url' && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setReloadToken((n) => n + 1)}
                data-testid="file-preview-reload"
              >
                重新加载
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose} data-testid="file-preview-close">
              <X className="size-4" /> 关闭
            </Button>
            <Button
              type="button"
              disabled={downloading}
              onClick={() => void download()}
              data-testid="file-preview-download"
            >
              <Download className="size-4" /> 下载
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
