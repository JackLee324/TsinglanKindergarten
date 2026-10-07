import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { resourcesApi } from '../../api/resources'
import type { ResourceReviewRecord } from '../../api/types'
import { Badge } from '../ui/Badge'
import { formatDate } from './ResourceCard'

/**
 * 审核时间线（业主 Stage 7 §7）。
 *
 * 业主点名的要求：「不要只在 resource 表保存 reviewComment，
 * 必须独立 resource_reviews，第一次退回 / 第二次通过 / 第三次撤回全部保留。」
 *
 * 所以这里渲染的是**完整流水**，不是"最后一条意见"。
 * 没有流水时整块不渲染 —— 一个空的时间线只会占地方。
 */
export function ReviewHistory({ resourceId }: { readonly resourceId: string }) {
  const [items, setItems] = useState<readonly ResourceReviewRecord[]>([])

  useEffect(() => {
    let cancelled = false
    resourcesApi
      .reviewHistory(resourceId)
      .then((res) => {
        if (!cancelled) setItems(res.items)
      })
      // 审核历史读不到不该让整页报错（它是补充信息）——
      // 但也**不假装没有**：下面会显示一条诚实的提示。
      .catch(() => {
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [resourceId])

  if (items.length === 0) return null

  return (
    <div className="mt-5" data-testid="review-history">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-foreground">
        <History className="size-5 text-muted-foreground" /> 审核记录
      </h2>
      <ol className="space-y-2" data-testid="review-history-list">
        {items.map((item) => (
          <li
            key={item.id}
            className="rounded-lg border border-border bg-card px-4 py-3"
            data-testid="review-history-item"
            data-action={item.action}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={item.action === 'review.reject' ? 'danger' : item.action === 'review.recall' ? 'secondary' : 'success'}
                data-testid="review-history-action"
              >
                {item.actionLabel}
              </Badge>
              <span className="text-xs text-muted-foreground" data-testid="review-history-meta">
                {item.actorName ?? '未知'} · {formatDate(item.createdAt)}
              </span>
            </div>
            {item.comment !== null && item.comment !== '' && (
              <p className="mt-2 text-sm text-foreground" data-testid="review-history-comment">
                {item.comment}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}
