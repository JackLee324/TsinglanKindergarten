import { useState } from 'react'
import { Download, Eye, FileText, Trash2 } from 'lucide-react'
import { filesApi } from '../../api/files'
import type { ResourceFileSummary } from '../../api/types'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { FilePreviewDialog } from './FilePreviewDialog'
import { AddFileDialog } from './AddFileDialog'
import { humanMessage } from './errors'

/**
 * 资源里的文件列表。
 *
 * 业主 §9 的界面规则，逐条落在这里：
 *
 *   · PDF / 图片 / TXT → 有「预览」和「下载」两个按钮；
 *   · DOCX / XLSX / PPTX / ZIP → **只有「下载」**，并显示
 *     「此文件类型暂不支持在线预览，请下载查看。」；
 *   · 不支持的类型**不渲染预览按钮** —— 业主原话是"不能点按钮没有反应"，
 *     所以宁可没有这个按钮。
 *
 * 「+ 添加文件」一次只加一个（§2），并且复用同一个上传弹窗 ——
 * 上传逻辑只有一份，不因为入口不同长出两套。
 */
export function FileList({
  resourceId,
  items,
  canEdit,
  onChange,
}: {
  readonly resourceId: string
  readonly items: readonly ResourceFileSummary[]
  /** 能不能增删文件（服务端算的能力位 + 资源状态是否可编辑）。 */
  readonly canEdit: boolean
  readonly onChange: () => void | Promise<void>
}) {
  const [previewing, setPreviewing] = useState<ResourceFileSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  async function download(file: ResourceFileSummary) {
    setError(null)
    setBusyId(file.id)
    try {
      const { url } = await filesApi.download(resourceId, file.id)
      // 短期签名地址：用完即弃，不在前端保存任何存储凭据。
      window.location.assign(url)
    } catch (e) {
      setError(humanMessage(e, '下载失败'))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(file: ResourceFileSummary) {
    if (!window.confirm(`确定删除「${file.fileName}」吗？删除后无法恢复。`)) return
    setError(null)
    setBusyId(file.id)
    try {
      await filesApi.remove(resourceId, file.id)
      await onChange()
    } catch (e) {
      setError(humanMessage(e, '删除失败'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div data-testid="file-list">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <FileText className="size-5 text-muted-foreground" /> 文件
          <span className="text-sm font-normal text-muted-foreground" data-testid="file-count">
            共 {items.length} 个
          </span>
        </h2>
        {canEdit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
            data-testid="file-add"
          >
            + 添加文件
          </Button>
        )}
      </div>

      {error !== null && (
        <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="file-error">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="暂无文件"
          description={
            canEdit
              ? '这个资源还没有文件。可以点「+ 添加文件」上传第一个文件。'
              : '这个资源还没有文件。'
          }
          testId="file-empty"
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="file-rows">
          {items.map((file) => (
            <li
              key={file.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid="file-row"
              data-file-id={file.id}
              data-file-name={file.fileName}
              data-previewable={String(file.previewable)}
            >
              <div className="min-w-0 flex-1">
                {/*
                  文件名本身可点（业主 Stage 13B §5.1）：
                  能在线预览的 → 打开预览；只有下载能力的（Office / ZIP）→ 直接下载，
                  绝不给一个"点了没反应"或者空白预览的入口。
                  用真正的 <button>，所以键盘（Tab + Enter）也能操作。
                */}
                <button
                  type="button"
                  onClick={() => {
                    if (file.previewable) setPreviewing(file)
                    else void download(file)
                  }}
                  title={file.previewable ? '点击预览' : '此类型不支持在线预览，点击下载'}
                  className="block max-w-full truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  data-testid="file-name"
                  data-file-name={file.fileName}
                >
                  {file.fileName}
                </button>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {file.sizeLabel} · 上传于 {file.createdAt.slice(0, 10)}
                </p>
                {/*
                  不支持预览时**逐字**显示业主指定的这句话（文案来自服务端，
                  不在界面里再写一遍）。这里不渲染预览按钮。
                */}
                {file.previewable === false && file.previewMessage !== null && (
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="file-preview-unsupported">
                    {file.previewMessage}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                {file.previewable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPreviewing(file)}
                    data-testid="file-preview"
                  >
                    <Eye className="size-4" /> 预览
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyId === file.id}
                  onClick={() => void download(file)}
                  data-testid="file-download"
                >
                  <Download className="size-4" /> 下载
                </Button>
                {canEdit && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === file.id}
                    onClick={() => void remove(file)}
                    data-testid="file-delete"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {previewing !== null && (
        <FilePreviewDialog
          resourceId={resourceId}
          file={previewing}
          onClose={() => setPreviewing(null)}
        />
      )}

      {adding && (
        // 往已有资源里加文件：不需要再问标题/描述/目录，只选文件。
        <AddFileDialog
          open={adding}
          resourceId={resourceId}
          onClose={() => setAdding(false)}
          onUploaded={onChange}
        />
      )}
    </div>
  )
}
