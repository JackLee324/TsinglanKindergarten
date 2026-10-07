import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil } from 'lucide-react'
import { resourcesApi } from '../api/resources'
import { ApiError } from '../api/http'
import type { ResourceDetail } from '../api/types'
import { useDirectory } from '../directory/DirectoryProvider'
import { directoryUrl } from '../directory/path'
import { Breadcrumb } from '../components/Breadcrumb'
import { Card, CardContent } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input, Label, Textarea } from '../components/ui/Input'
import { Spinner } from '../components/ui/Spinner'
import { EDITABLE_STATUSES } from '@shared/resource-status'
import { EmptyState } from '../components/ui/EmptyState'
import { formatDate } from '../components/resource/ResourceCard'
import { FileList } from '../components/resource/FileList'

const STATUS_LABEL = {
  DRAFT: '草稿',
  PENDING_REVIEW: '待审核',
  PUBLISHED: '已发布',
  REJECTED: '已退回',
  RECALLED: '已撤回',
} as const

/**
 * 资源详情。
 *
 * 地址是 `/resources/:id` —— 用 **id** 而不是标题：标题可改、可重复，
 * 拿它做 URL identity 会让分享出去的链接在改名后失效。
 * 目录仍然是 slug 路径，两者不混。
 *
 * 文件区域是**真的**（阶段 6）：可预览的类型有「预览」+「下载」，
 * 不支持预览的类型**只有「下载」**并附上那句说明；
 * 能不能增删文件由服务端的能力位与资源状态共同决定。
 */
export function ResourceDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { resolve } = useDirectory()
  const [resource, setResource] = useState<ResourceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setResource(await resourcesApi.get(id))
    } catch (e) {
      setResource(null)
      setError(e instanceof ApiError ? e.message : '资源加载失败')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <Spinner label="正在加载资源…" />

  if (resource === null) {
    return (
      <div data-testid="resource-detail-page">
        <EmptyState
          title="找不到这条资源"
          description={error ?? '它可能已被删除，或者它不在你有权限的目录里。'}
          testId="resource-detail-notfound"
          action={
            <Button variant="outline" onClick={() => navigate(-1)}>
              返回
            </Button>
          }
        />
      </div>
    )
  }

  // 面包屑来自**目录树**（parentId 链），所以管理员改名之后这里自动跟着变。
  const chain = resolve(resource.directoryPath.split('/')).chain

  return (
    <div data-testid="resource-detail-page" data-resource-id={resource.id} data-resource-status={resource.status}>
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-primary"
        data-testid="resource-detail-back"
      >
        <ArrowLeft className="size-4" /> 返回
      </button>

      {/* 完整目录链路 —— 业主的验收点：改名后这里要同步 */}
      <div className="mb-4">
        <Breadcrumb chain={chain} />
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground" data-testid="resource-detail-title">
            {resource.title}
          </h1>
          {resource.titleEn !== null && resource.titleEn !== '' && (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="resource-detail-title-en">
              {resource.titleEn}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={resource.status === 'PUBLISHED' ? 'success' : 'secondary'} data-testid="resource-detail-status">
            {STATUS_LABEL[resource.status]}
          </Badge>
          {resource.capabilities.canEdit && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="resource-detail-edit">
              <Pencil className="size-4" /> 编辑
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <EditForm
          resource={resource}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false)
            await load()
          }}
        />
      ) : (
        <Card className="mt-5">
          <CardContent>
            <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <Field label="描述" testId="resource-detail-description" full>
                {resource.description ?? '未填写'}
              </Field>
              <Field label="所属目录" testId="resource-detail-directory">
                <Link to={directoryUrl(resource.directoryPath)} className="text-primary hover:underline">
                  {chain.map((n) => n.name).join(' / ') || resource.directoryPath}
                </Link>
              </Field>
              <Field label="上传者" testId="resource-detail-uploader">
                {resource.uploaderName ?? '未知'}
              </Field>
              <Field label="版本" testId="resource-detail-version">
                v{resource.version}
              </Field>
              <Field label="创建时间" testId="resource-detail-created">
                {formatDate(resource.createdAt)}
              </Field>
              <Field label="更新时间" testId="resource-detail-updated">
                {formatDate(resource.updatedAt)}
              </Field>
              {resource.status === 'REJECTED' && resource.reviewComment !== null && (
                <Field label="退回原因" testId="resource-detail-review-comment" full>
                  {resource.reviewComment}
                </Field>
              )}
            </dl>
          </CardContent>
        </Card>
      )}

      {/* 文件区域：真实的文件列表 + 预览 + 下载 + 添加/删除 */}
      <Card className="mt-5">
        <CardContent>
          <FileList
            resourceId={resource.id}
            items={resource.files}
            // 能不能增删文件 = 服务端给的能力位 ∧ 资源当前可编辑。
            // 已发布/待审核的资源由服务端再拦一次（409），界面这层只是不摆必然失败的按钮。
            canEdit={resource.capabilities.canEdit && EDITABLE_STATUSES.includes(resource.status)}
            onChange={load}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function Field({
  label,
  testId,
  full,
  children,
}: {
  readonly label: string
  readonly testId: string
  readonly full?: boolean
  readonly children: React.ReactNode
}) {
  return (
    <div className={full === true ? 'sm:col-span-2' : undefined}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground" data-testid={testId}>
        {children}
      </dd>
    </div>
  )
}

function EditForm({
  resource,
  onCancel,
  onSaved,
}: {
  readonly resource: ResourceDetail
  readonly onCancel: () => void
  readonly onSaved: () => Promise<void>
}) {
  const [title, setTitle] = useState(resource.title)
  const [titleEn, setTitleEn] = useState(resource.titleEn ?? '')
  const [description, setDescription] = useState(resource.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Card className="mt-5">
      <CardContent>
        <form
          className="space-y-4"
          data-testid="resource-edit-form"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            resourcesApi
              .update(resource.id, {
                title,
                titleEn: titleEn.trim() === '' ? null : titleEn.trim(),
                description: description.trim() === '' ? null : description.trim(),
              })
              .then(() => onSaved())
              .catch((err) => setError(err instanceof ApiError ? err.message : '保存失败'))
              .finally(() => setBusy(false))
          }}
        >
          <div>
            <Label htmlFor="res-title" required>
              标题
            </Label>
            <Input id="res-title" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="resource-edit-title" required />
          </div>
          <div>
            <Label htmlFor="res-title-en">英文标题</Label>
            <Input id="res-title-en" value={titleEn} onChange={(e) => setTitleEn(e.target.value)} data-testid="resource-edit-title-en" />
          </div>
          <div>
            <Label htmlFor="res-desc">描述</Label>
            <Textarea id="res-desc" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="resource-edit-description" />
          </div>
          {error !== null && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="resource-edit-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onCancel} disabled={busy}>
              取消
            </Button>
            <Button type="submit" disabled={busy} data-testid="resource-edit-save">
              保存
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            本阶段只能改标题、英文标题与描述。文件替换与目录变更属于后续阶段。
          </p>
        </form>
      </CardContent>
    </Card>
  )
}
