import { useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { resourcesApi } from '../../api/resources'
import { useDirectory } from '../../directory/DirectoryProvider'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input, Label, Textarea } from '../ui/Input'
import { humanMessage } from './errors'
import { useFileUpload } from './useFileUpload'
import { ALLOWED_TYPES_LABEL, MAX_FILE_SIZE_LABEL, formatFileSize } from '@shared/file-policy'

/**
 * 「上传资源」弹窗（业主 §13 / §14 / §15）。
 *
 * 三条硬要求都落在这个表单上：
 *
 *   1. **不再出现班型 / 科目 / 资料夹 / 所属目录**。
 *      老师从目录树里点进来，`directoryId` 已经确定；让他再选一次，
 *      正是 V1 那个「我上传以后到底去哪了」的根源。
 *      位置在这里**只读地显示**，让他确认。
 *
 *   2. **一次一个文件**；再加文件去详情页点「+ 添加文件」。
 *
 *   3. **真进度、真取消、真错误**：上传中显示「正在上传 35%」、可取消；
 *      失败时显示真正的原因，**绝不**把失败说成"保存成功"。
 *
 * 顺序：建草稿资源 → 算哈希 → 申请地址 → PUT → 登记 → 跳到详情页。
 * 先把资源建出来是必要的：对象 key 的形状是 `resources/{resourceId}/…`，
 * 没有资源就没有归属。
 */
export function UploadResourceDialog({
  open,
  directoryId,
  directoryPath,
  onClose,
  onCreated,
}: {
  readonly open: boolean
  readonly directoryId: string
  /** 当前目录的 slug 路径（目录页已经解析好的那条链，不另开一份索引）。 */
  readonly directoryPath: string
  readonly onClose: () => void
  readonly onCreated: (resourceId: string) => void
}) {
  const { resolve } = useDirectory()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  /** 资源只建一次：重复点「保存草稿」不会建出第二条草稿。 */
  const [resourceId, setResourceId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const upload = useFileUpload(resourceId)

  const locationLabel =
    directoryPath === ''
      ? '—'
      : resolve(directoryPath.split('/')).chain.map((n) => n.name).join(' / ')

  const busy = creating || upload.state.busy

  function reset() {
    setTitle('')
    setDescription('')
    setFile(null)
    setCreating(false)
    setCreateError(null)
    setResourceId(null)
    upload.reset()
    if (inputRef.current) inputRef.current.value = ''
  }

  function close() {
    if (busy) return // 上传中不许关，免得留下一个没人管的半成品资源
    reset()
    onClose()
  }

  async function save() {
    if (title.trim() === '') {
      setCreateError('请输入资源标题')
      return
    }
    if (file === null) {
      setCreateError('请选择要上传的文件')
      return
    }
    setCreateError(null)

    let id = resourceId
    if (id === null) {
      setCreating(true)
      try {
        const created = await resourcesApi.create({
          directoryId,
          title: title.trim(),
          description: description.trim() === '' ? null : description.trim(),
        })
        id = created.id
        setResourceId(id)
      } catch (e) {
        setCreating(false)
        setCreateError(humanMessage(e, '创建资源失败'))
        return
      }
      setCreating(false)
    }

    // 上传链路来自 hook（与「+ 添加文件」是同一份实现）。
    // 资源 id 显式传进去：它是**刚刚**创建的，而 hook 的参数来自上一次渲染。
    const ok = await upload.start(file, id)
    if (ok) onCreated(id)
  }

  return (
    <Dialog open={open} title="上传资源" testId="upload-dialog" onClose={close}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="upload-title" required>
            资源标题
          </Label>
          <Input
            id="upload-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：美德课程教案"
            maxLength={200}
            data-testid="upload-title"
          />
        </div>

        <div>
          <Label htmlFor="upload-description">资源描述</Label>
          <Textarea
            id="upload-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="选填：这份资源是做什么用的"
            maxLength={2000}
            data-testid="upload-description"
          />
        </div>

        {/*
          「所在目录」是**只读**的：老师从目录里点进来，位置已经定了。
          V1 的毛病正是让老师自己挑班型/科目/资料夹，然后没人知道东西去哪了。
        */}
        <div className="rounded-lg bg-secondary px-3 py-2.5">
          <p className="text-xs text-muted-foreground">所在目录</p>
          <p className="mt-0.5 text-sm text-foreground" data-testid="upload-location">
            {locationLabel}
          </p>
        </div>

        <div>
          <Label htmlFor="upload-file-input">文件</Label>
          <input
            ref={inputRef}
            id="upload-file-input"
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.txt,.docx,.xlsx,.pptx,.zip"
            disabled={busy}
            className="sr-only"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              upload.reset()
            }}
            data-testid="upload-file-input"
          />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              data-testid="upload-choose-file"
            >
              <Upload className="size-4" /> {file === null ? '选择文件' : '重新选择'}
            </Button>
            {file !== null && (
              <span className="text-sm text-muted-foreground" data-testid="upload-file-name">
                {file.name}（{formatFileSize(file.size)}）
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            支持 {ALLOWED_TYPES_LABEL}，单个文件不超过 {MAX_FILE_SIZE_LABEL}。
            一次一个文件，保存后可在详情页继续「+ 添加文件」。
          </p>
        </div>

        {upload.state.progress !== null && (
          <div data-testid="upload-progress">
            <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all duration-200"
                style={{ width: `${upload.state.progress.percent}%` }}
                data-testid="upload-progress-bar"
                data-percent={String(upload.state.progress.percent)}
              />
            </div>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="upload-progress-text">
              {upload.state.progress.percent >= 100
                ? '上传完成，正在保存…'
                : `正在上传 ${upload.state.progress.percent}%`}
            </p>
          </div>
        )}

        {upload.state.uploadedName !== null && (
          <p
            className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success"
            data-testid="upload-done"
          >
            ✓ 已上传：{upload.state.uploadedName}
          </p>
        )}

        {(createError ?? upload.state.error) !== null && (
          <p
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="upload-error"
          >
            {createError ?? upload.state.error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {upload.state.busy ? (
            <Button type="button" variant="outline" onClick={upload.cancel} data-testid="upload-cancel">
              <X className="size-4" /> 取消上传
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={close}>
              关闭
            </Button>
          )}
          <Button
            type="button"
            disabled={busy || title.trim() === '' || file === null}
            onClick={() => void save()}
            data-testid="upload-submit"
          >
            {creating
              ? '正在创建…'
              : upload.state.phase === 'hashing' || upload.state.phase === 'requesting'
                ? '准备上传…'
                : upload.state.busy
                  ? '上传中…'
                  : '保存草稿'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
