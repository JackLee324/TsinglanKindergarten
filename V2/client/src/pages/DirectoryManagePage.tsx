import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, Pencil, Trash2, ArrowUp, ArrowDown, Power } from 'lucide-react'
import { useDirectory } from '../directory/DirectoryProvider'
import { directoriesApi } from '../api/directories'
import { ApiError } from '../api/http'
import type { DirectoryNode } from '../api/types'
import { Button } from '../components/ui/Button'
import { Input, Label, Textarea } from '../components/ui/Input'
import { Dialog } from '../components/ui/Dialog'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { cn } from '../components/ui/cn'

/**
 * 目录管理（**只有管理员能看到入口**）。
 *
 * 三种保护都必须在界面上说清楚，因为服务端会拒绝：
 *   · 有子目录 → 不能删
 *   · 有资源（含回收站）→ 不能删
 *   · 还有授权挂靠 → 不能删
 * 与其让管理员点一次、看一条 409，不如在按钮旁边先把原因写出来。
 *
 * 这里**不出现**任何内部概念：没有 permission code、没有 scope、没有 RBAC。
 */
export function DirectoryManagePage() {
  const { roots, flat, ready, loading, refresh } = useDirectory()
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<DirectoryNode | null>(null)
  const [creatingUnder, setCreatingUnder] = useState<DirectoryNode | null | undefined>(undefined)

  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** 所有写操作走同一条通道：执行 → 失败显示可读原因 → 成功后刷新整棵树。 */
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const counts = useMemo(
    () => ({ total: flat.length, roots: roots.length }),
    [flat.length, roots.length],
  )

  if (!ready && loading) return <p className="text-sm text-muted-foreground">正在加载目录…</p>

  return (
    <div data-testid="directory-manage-page">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground" data-testid="page-title">
            目录管理
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {counts.total} 个目录节点（{counts.roots} 个一级栏目）。
            改中文名不会改变地址，历史链接不会失效。
          </p>
        </div>
        <Button
          onClick={() => setCreatingUnder(null)}
          disabled={busy}
          data-testid="manage-add-root"
        >
          <Plus className="size-4" /> 新增一级栏目
        </Button>
      </div>

      {error !== null && (
        <p
          className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="manage-error"
        >
          {error}
        </p>
      )}

      {roots.length === 0 ? (
        <EmptyState title="还没有任何一级栏目" testId="manage-empty" />
      ) : (
        <div className="rounded-xl border border-border bg-card" data-testid="manage-tree">
          {roots.map((node) => (
            <ManageRow
              key={node.id}
              node={node}
              depth={0}
              openIds={openIds}
              onToggle={toggle}
              busy={busy}
              onEdit={setEditing}
              onCreateChild={setCreatingUnder}
              run={run}
            />
          ))}
        </div>
      )}

      {editing !== null && (
        <EditDialog
          node={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            await run(() => directoriesApi.update(editing.id, input))
            setEditing(null)
          }}
        />
      )}

      {creatingUnder !== undefined && (
        <CreateDialog
          parent={creatingUnder}
          busy={busy}
          onClose={() => setCreatingUnder(undefined)}
          onSubmit={async (input) => {
            await run(() =>
              directoriesApi.create({
                parentId: creatingUnder === null ? null : creatingUnder.id,
                ...input,
              }),
            )
            // 新建子目录后**自动展开父行**。
            //
            // 不这么做的话，第一次给一个节点加子目录时：父行原本没有子节点、
            // 连展开箭头都不存在，新建完之后它才变成可展开的 —— 于是新目录
            // 建好了却看不见，管理员得自己猜着去展开一次。
            // 这是实测走一遍流程才发现的（浏览器测试里表现为"建完了但行不存在"）。
            if (creatingUnder !== null) {
              const parentId = creatingUnder.id
              setOpenIds((prev) => new Set(prev).add(parentId))
            }
            setCreatingUnder(undefined)
          }}
        />
      )}
    </div>
  )
}

function ManageRow({
  node,
  depth,
  openIds,
  onToggle,
  busy,
  onEdit,
  onCreateChild,
  run,
}: {
  readonly node: DirectoryNode
  readonly depth: number
  readonly openIds: ReadonlySet<string>
  readonly onToggle: (id: string) => void
  readonly busy: boolean
  readonly onEdit: (node: DirectoryNode) => void
  readonly onCreateChild: (node: DirectoryNode | null) => void
  readonly run: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const open = openIds.has(node.id)
  const hasChildren = node.children.length > 0

  return (
    <>
      <div
        data-testid="manage-row"
        data-directory-id={node.id}
        data-directory-slug={node.slug}
        className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 last:border-b-0"
        style={{ paddingLeft: `${16 + depth * 20}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? '收起' : '展开'}
            aria-expanded={open}
            data-testid="manage-row-toggle"
            data-directory-id={node.id}
            onClick={() => onToggle(node.id)}
            className="rounded p-1 text-muted-foreground hover:bg-secondary"
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        ) : (
          <span className="w-6" />
        )}

        <span className="font-medium text-foreground" data-testid="manage-row-name">
          {node.name}
        </span>
        {node.nameEn !== null && node.nameEn !== '' && (
          <span className="text-sm text-muted-foreground" data-testid="manage-row-name-en">
            {node.nameEn}
          </span>
        )}

        <span className="ml-1 font-mono text-xs text-muted-foreground" data-testid="manage-row-slug">
          {node.slug}
        </span>

        {!node.enabled && (
          <Badge variant="warning" data-testid="manage-row-disabled">
            已停用
          </Badge>
        )}
        <Badge variant="muted">{capabilitySummary(node)}</Badge>
        {hasChildren && <Badge variant="secondary">{node.children.length} 个子目录</Badge>}

        <div className="ml-auto flex items-center gap-1">
          {/*
            排序：↑↓ 而不是拖拽 —— 确定性可测，也不存在"拖到一半失败"的中间状态。
          */}
          <IconButton
            label="上移"
            testId="manage-move-up"
            onClick={() => void run(() => directoriesApi.reorder(node.id, 'up'))}
            disabled={busy}
          >
            <ArrowUp className="size-4" />
          </IconButton>
          <IconButton
            label="下移"
            testId="manage-move-down"
            onClick={() => void run(() => directoriesApi.reorder(node.id, 'down'))}
            disabled={busy}
          >
            <ArrowDown className="size-4" />
          </IconButton>
          <IconButton
            label={node.enabled ? '停用' : '启用'}
            testId="manage-toggle-enabled"
            onClick={() => void run(() => directoriesApi.update(node.id, { enabled: !node.enabled }))}
            disabled={busy}
          >
            <Power className={cn('size-4', node.enabled ? '' : 'text-warning')} />
          </IconButton>
          <IconButton
            label="新建子目录"
            testId="manage-add-child"
            onClick={() => onCreateChild(node)}
            disabled={busy || !node.allowChildren}
          >
            <Plus className="size-4" />
          </IconButton>
          <IconButton
            label="编辑"
            testId="manage-edit"
            onClick={() => onEdit(node)}
            disabled={busy}
          >
            <Pencil className="size-4" />
          </IconButton>
          <IconButton
            label="删除"
            testId="manage-delete"
            onClick={() => void run(() => directoriesApi.remove(node.id))}
            disabled={busy}
            danger
          >
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </div>

      {open &&
        hasChildren &&
        node.children.map((child) => (
          <ManageRow
            key={child.id}
            node={child}
            depth={depth + 1}
            openIds={openIds}
            onToggle={onToggle}
            busy={busy}
            onEdit={onEdit}
            onCreateChild={onCreateChild}
            run={run}
          />
        ))}
    </>
  )
}

function IconButton({
  label,
  testId,
  onClick,
  disabled,
  danger,
  children,
}: {
  readonly label: string
  readonly testId: string
  readonly onClick: () => void
  readonly disabled: boolean
  readonly danger?: boolean
  readonly children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-lg p-2 transition-colors disabled:opacity-40',
        danger
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** 一行字说明这个节点能做什么 —— 用的是中文，不是能力码。 */
function capabilitySummary(node: DirectoryNode): string {
  const parts: string[] = []
  if (node.allowChildren) parts.push('可建子目录')
  if (node.allowFiles) parts.push('可放资源')
  if (node.allowCustomFolders) parts.push('教师可建文件夹')
  return parts.length > 0 ? parts.join(' · ') : '仅导航'
}

function EditDialog({
  node,
  busy,
  onClose,
  onSubmit,
}: {
  readonly node: DirectoryNode
  readonly busy: boolean
  readonly onClose: () => void
  readonly onSubmit: (input: {
    name: string
    nameEn: string | null
    description: string | null
    allowChildren: boolean
    allowFiles: boolean
    allowCustomFolders: boolean
  }) => Promise<void>
}) {
  const [name, setName] = useState(node.name)
  const [nameEn, setNameEn] = useState(node.nameEn ?? '')
  const [description, setDescription] = useState(node.description ?? '')
  const [allowChildren, setAllowChildren] = useState(node.allowChildren)
  const [allowFiles, setAllowFiles] = useState(node.allowFiles)
  const [allowCustomFolders, setAllowCustomFolders] = useState(node.allowCustomFolders)

  return (
    <Dialog open title={`编辑「${node.name}」`} onClose={onClose} testId="manage-edit-dialog">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void onSubmit({
            name,
            nameEn: nameEn.trim() === '' ? null : nameEn.trim(),
            description: description.trim() === '' ? null : description.trim(),
            allowChildren,
            allowFiles,
            allowCustomFolders,
          })
        }}
      >
        <div>
          <Label htmlFor="dir-name" required>
            中文名称
          </Label>
          <Input
            id="dir-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="manage-name-input"
            required
          />
          <p className="mt-1 text-xs text-muted-foreground">
            地址（{node.slug}）不会因为改中文名而改变，历史链接继续有效。
          </p>
        </div>
        <div>
          <Label htmlFor="dir-name-en">英文名称</Label>
          <Input
            id="dir-name-en"
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            data-testid="manage-name-en-input"
          />
        </div>
        <div>
          <Label htmlFor="dir-desc">描述</Label>
          <Textarea
            id="dir-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="manage-description-input"
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-foreground">这个目录能做什么</legend>
          <Checkbox
            label="可以继续新建子目录"
            checked={allowChildren}
            onChange={setAllowChildren}
            testId="manage-allow-children"
          />
          <Checkbox
            label="可以直接放资源"
            checked={allowFiles}
            onChange={setAllowFiles}
            testId="manage-allow-files"
          />
          <Checkbox
            label="允许教师自己建文件夹"
            checked={allowCustomFolders}
            onChange={setAllowCustomFolders}
            testId="manage-allow-custom-folders"
          />
        </fieldset>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" disabled={busy} data-testid="manage-save">
            保存
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function CreateDialog({
  parent,
  busy,
  onClose,
  onSubmit,
}: {
  readonly parent: DirectoryNode | null
  readonly busy: boolean
  readonly onClose: () => void
  readonly onSubmit: (input: {
    name: string
    nameEn: string | null
    description: string | null
    slug: string
  }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')

  // slug 可以由英文名自动带出来（纯英文时），但**中文名不会** ——
  // 中文得不到可读 slug，那种情况必须让管理员显式填，而不是编造 `node-1`。
  const suggestSlug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  return (
    <Dialog
      open
      title={parent === null ? '新增一级栏目' : `在「${parent.name}」下新建子目录`}
      onClose={onClose}
      testId="manage-create-dialog"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void onSubmit({
            name,
            nameEn: nameEn.trim() === '' ? null : nameEn.trim(),
            description: description.trim() === '' ? null : description.trim(),
            slug,
          })
        }}
      >
        <div>
          <Label htmlFor="new-name" required>
            名称
          </Label>
          <Input
            id="new-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (slug === '') setSlug(suggestSlug(nameEn === '' ? e.target.value : nameEn))
            }}
            placeholder="例如：活动"
            data-testid="manage-create-name"
            required
          />
        </div>
        <div>
          <Label htmlFor="new-name-en">英文名称</Label>
          <Input
            id="new-name-en"
            value={nameEn}
            onChange={(e) => {
              setNameEn(e.target.value)
              setSlug(suggestSlug(e.target.value))
            }}
            placeholder="例如：Activities"
            data-testid="manage-create-name-en"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            填写英文名会自动生成地址；中文名生成不出可读地址。
          </p>
        </div>
        <div>
          <Label htmlFor="new-slug" required>
            地址（slug）
          </Label>
          <Input
            id="new-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="activities"
            pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
            data-testid="manage-create-slug"
            required
          />
          <p className="mt-1 text-xs text-muted-foreground">
            只能用小写字母、数字与连字符。创建后不可修改。
          </p>
        </div>
        <div>
          <Label htmlFor="new-desc">描述</Label>
          <Textarea
            id="new-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            data-testid="manage-create-description"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" disabled={busy} data-testid="manage-create-submit">
            创建
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function Checkbox({
  label,
  checked,
  onChange,
  testId,
}: {
  readonly label: string
  readonly checked: boolean
  readonly onChange: (value: boolean) => void
  readonly testId: string
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="size-4 rounded border-border text-primary accent-[hsl(252_36%_64%)]"
      />
      {label}
    </label>
  )
}
