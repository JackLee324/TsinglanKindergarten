import { useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Label } from '../ui/Input'
import { useFileUpload } from './useFileUpload'
import { ALLOWED_TYPES_LABEL, MAX_FILE_SIZE_LABEL } from '@shared/file-policy'

/**
 * 「+ 添加文件」：往**已有的**资源里再加一个文件（业主 §2：一次一个）。
 *
 * 与「上传资源」共用同一条上传链路（`useFileUpload`），
 * 区别只在于资源是现成的，不再问标题和描述。
 */
export function AddFileDialog({
  open,
  resourceId,
  onClose,
  onUploaded,
}: {
  readonly open: boolean
  readonly resourceId: string
  readonly onClose: () => void
  readonly onUploaded: () => void | Promise<void>
}) {
  const upload = useFileUpload(resourceId)
  const [file, setFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function close() {
    if (upload.state.busy) return
    setFile(null)
    upload.reset()
    onClose()
  }

  async function submit() {
    if (file === null) return
    const ok = await upload.start(file)
    if (ok) {
      setFile(null)
      await onUploaded()
      onClose()
    }
  }

  return (
    <Dialog open={open} title="添加文件" testId="add-file-dialog" onClose={close}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="add-file-input">文件</Label>
          <input
            ref={inputRef}
            id="add-file-input"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.txt,.docx,.xlsx,.pptx,.zip"
            disabled={upload.state.busy}
            className="sr-only"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              upload.reset()
            }}
            data-testid="add-file-input"
          />
          <div className="mt-1 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={upload.state.busy}
              onClick={() => inputRef.current?.click()}
              data-testid="add-file-choose"
            >
              <Upload className="size-4" /> {file === null ? '选择文件' : '重新选择'}
            </Button>
            {file !== null && (
              <span className="text-sm text-muted-foreground" data-testid="add-file-name">
                {file.name}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            支持 {ALLOWED_TYPES_LABEL}，单个文件不超过 {MAX_FILE_SIZE_LABEL}。
          </p>
        </div>

        {upload.state.progress !== null && (
          <div data-testid="add-file-progress">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all duration-200"
                style={{ width: `${upload.state.progress.percent}%` }}
                data-testid="add-file-progress-bar"
                data-percent={String(upload.state.progress.percent)}
              />
            </div>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="add-file-progress-text">
              {upload.state.progress.percent >= 100
                ? '上传完成，正在保存…'
                : `正在上传 ${upload.state.progress.percent}%`}
            </p>
          </div>
        )}

        {upload.state.error !== null && (
          <p
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="add-file-error"
          >
            {upload.state.error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {upload.state.busy ? (
            <Button type="button" variant="outline" onClick={upload.cancel} data-testid="add-file-cancel">
              <X className="size-4" /> 取消上传
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={close}>
              关闭
            </Button>
          )}
          <Button
            type="button"
            disabled={upload.state.busy || file === null}
            onClick={() => void submit()}
            data-testid="add-file-submit"
          >
            {upload.state.busy ? '上传中…' : '上传这个文件'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
