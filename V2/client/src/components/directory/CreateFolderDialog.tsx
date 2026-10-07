import { useState } from 'react'
import { ApiError } from '../../api/http'
import { directoriesApi } from '../../api/directories'
import type { DirectoryNode } from '../../api/types'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input, Label } from '../ui/Input'

/**
 * 教师自建文件夹（业主 §10：目录树里"教学资源"这一类节点允许老师自己再分层）。
 *
 * 为什么是**独立组件**而不是把管理页那个新建弹窗复用过来：
 * 管理页的弹窗允许选「可以继续新建子目录 / 可以放资源 / 允许教师再建文件夹」，
 * 那是**管理员给目录定规矩**；老师建文件夹时这些规矩由父节点决定，
 * 不该（也不能）由老师自己改。两者的输入项不一样，共用只会让两边都别扭。
 *
 * 权限不由界面判断：按钮是否出现看服务端的 `capabilities.canCreateFolder`，
 * 真调用时服务端还会再判一次（`directory.create_folder` + 覆盖到该目录）。
 */
export function CreateFolderDialog({
  open,
  parent,
  onClose,
  onCreated,
}: {
  readonly open: boolean
  readonly parent: DirectoryNode | null
  readonly onClose: () => void
  readonly onCreated: (node: DirectoryNode) => void
}) {
  const [name, setName] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open || parent === null) return null

  const submit = async () => {
    /*
      中文名生成不出可读地址（服务端的 `slugifyCandidate` 对纯中文返回空）。
      这不是界面可以替老师决定的事 —— 地址会出现在浏览器的 URL 里，
      所以要求他给一个英文/拼音名。**在提交之前就说清楚**，
      而不是等他点完创建再看一句服务端的英文报错。
    */
    const hasAscii = /[a-z0-9]/i.test(name.trim())
    if (!hasAscii && nameEn.trim() === '') {
      setError('请再填一个英文/拼音名称：文件夹的地址由它生成（例如 huanjing）。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await directoriesApi.createFolder({
        parentId: parent.id,
        name: name.trim(),
        nameEn: nameEn.trim() === '' ? null : nameEn.trim(),
      })
      setName('')
      setNameEn('')
      onCreated(created)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '新建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      title={`在「${parent.name}」下新建文件夹`}
      onClose={() => {
        if (!busy) onClose()
      }}
      testId="create-folder-dialog"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div>
          <Label htmlFor="folder-name" required>
            名称
          </Label>
          <Input
            id="folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：环境创设"
            data-testid="create-folder-name"
            required
          />
        </div>
        <div>
          <Label htmlFor="folder-name-en">英文 / 拼音名称</Label>
          <Input
            id="folder-name-en"
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            placeholder="例如：huanjing"
            data-testid="create-folder-name-en"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            文件夹的地址由它生成。中文名生成不出可读地址，所以中文名要在这里填一个英文或拼音。
          </p>
        </div>

        <p className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
          文件夹会建在「{parent.name}」下面，之后你放进去的资源就属于它。
        </p>

        {error !== null && (
          <p
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="create-folder-error"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" disabled={busy} data-testid="create-folder-submit">
            {busy ? '正在创建…' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
