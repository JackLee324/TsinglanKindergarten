import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { FileText, MapPin } from 'lucide-react'
import type { ResourceListItem, ResourceStatus } from '../../api/types'
import { Card, CardContent } from '../ui/Card'
import { Badge } from '../ui/Badge'

/**
 * 资源卡片。
 *
 * 业主特别要求："资源所在位置始终可见" —— 所以每张卡片都带一行
 * 「Pre-K / 美德 / 教学资源」。这样"我上传以后到底去哪了"这个问题
 * 在界面上自然就不存在了。
 *
 * 卡片里**没有**下载/预览按钮：文件属于阶段 6。放一个点了会失败的按钮
 * 比不放更糟（业主的规则："不允许假成功"）。
 */
const STATUS_LABEL: Record<ResourceStatus, string> = {
  DRAFT: '草稿',
  PENDING_REVIEW: '待审核',
  PUBLISHED: '已发布',
  REJECTED: '已退回',
  RECALLED: '已撤回',
}

const STATUS_VARIANT: Record<ResourceStatus, 'secondary' | 'success' | 'warning' | 'danger' | 'muted'> = {
  DRAFT: 'muted',
  PENDING_REVIEW: 'warning',
  PUBLISHED: 'success',
  REJECTED: 'danger',
  RECALLED: 'secondary',
}

export function ResourceCard({
  resource,
  locationLabel,
  actions,
  testId = 'resource-card',
}: {
  readonly resource: ResourceListItem
  /** 由外层用目录树翻译好的中文位置；不在卡片里自己解析目录。 */
  readonly locationLabel: string
  /**
   * 卡片底部的流程动作（我的资源里的「提交审核」等）。
   *
   * 放在**卡片内部**而不是外面：卡片的 `data-resource-id` / `data-resource-status`
   * 是这条记录的稳定标识，动作按钮属于同一条记录，就该在同一个节点里。
   * （第一版把它放在卡片的兄弟节点上，于是 `[data-resource-id="x"] [data-testid=...]`
   *   这样的选择器全都找不到按钮 —— 浏览器用例直接红在这里。）
   */
  readonly actions?: ReactNode
  readonly testId?: string
}) {
  return (
    <Card
      data-testid={testId}
      data-resource-id={resource.id}
      data-resource-status={resource.status}
      className="transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
    >
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <Link
            to={`/resources/${resource.id}`}
            className="text-lg font-semibold text-foreground hover:text-primary"
            data-testid="resource-card-title"
          >
            {resource.title}
          </Link>
          <Badge variant={STATUS_VARIANT[resource.status]} data-testid="resource-card-status">
            {STATUS_LABEL[resource.status]}
          </Badge>
        </div>

        {resource.titleEn !== null && resource.titleEn !== '' && (
          <p className="mt-0.5 text-sm text-muted-foreground">{resource.titleEn}</p>
        )}

        {resource.description !== null && resource.description !== '' && (
          <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {resource.description}
          </p>
        )}

        {/* 资源所在位置：始终可见 */}
        <p
          className="mt-4 flex items-start gap-1.5 text-sm text-primary"
          data-testid="resource-card-location"
        >
          <MapPin className="mt-0.5 size-4 shrink-0" />
          <span>{locationLabel}</span>
        </p>

        {/*
          最新退回意见：直接摆在卡片上（业主 §16）。教师不用点进详情就知道要改什么。
        */}
        {resource.latestReviewComment !== null && resource.latestReviewComment !== '' && (
          <p
            className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="resource-card-review-comment"
          >
            退回意见：{resource.latestReviewComment}
          </p>
        )}

        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5" data-testid="resource-card-files">
            <FileText className="size-3.5" />
            {resource.fileCount > 0 ? `${resource.fileCount} 个文件` : '暂无文件'}
          </span>
          <span data-testid="resource-card-updated">{formatDate(resource.updatedAt)}</span>
        </div>

        {actions !== undefined && <div className="mt-3">{actions}</div>}
      </CardContent>
    </Card>
  )
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
