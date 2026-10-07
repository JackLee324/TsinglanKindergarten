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

  useEffect(() => {
    let cancelled = false
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
          const text = await fetch(res.url).then((r) => r.text())
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
  }, [resourceId, file.id])

  async function download() {
    setDownloading(true)
    try {
      const { url } = await filesApi.download(resourceId, file.id)
      window.location.assign(url)
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
            <p className="p-6 text-center text-sm text-destructive" data-testid="file-preview-error">
              {state.message}
            </p>
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
            <iframe
              title={file.fileName}
              src={state.preview.url}
              className="h-[60vh] w-full bg-white"
              data-testid="file-preview-pdf"
            />
          )}

          {state.kind === 'url' && state.preview.viewer === 'image' && (
            <div className="flex max-h-[60vh] items-center justify-center p-2">
              <img
                src={state.preview.url}
                alt={file.fileName}
                className="max-h-[56vh] max-w-full rounded object-contain"
                data-testid="file-preview-image"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            预览地址是短时有效的授权地址，不会公开文件位置。
          </p>
          <div className="flex gap-2">
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
