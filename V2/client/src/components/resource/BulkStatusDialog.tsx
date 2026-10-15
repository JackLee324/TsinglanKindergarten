import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Label, Textarea } from '../ui/Input'
import {
  FORCE_STATUS_REQUIRES_COMMENT,
  RESOURCE_STATUSES,
  RESOURCE_STATUS_LABEL,
  type ResourceStatus,
} from '@shared/resource-status'

/**
 * 「批量修改状态」（超级管理员强制覆盖）。
 *
 * ── 这是**绕过状态机**的操作，所以界面上必须把代价说清楚 ──────────────────
 * 教师与审核员走的六条转换是**流程**：每条都有前置状态、有权限码、有所有权要求，
 * 只能一格一格走。这个弹窗是管理员直接覆盖 —— 五个状态里任何一个都能设，
 * 包括把一批草稿直接变成已发布。所以：
 *   · **改成「已发布」必须在弹窗内再确认一次**（那一步绕过了审核）；
 *   · **改成「已退回」必须写原因**（教师端"我的资源"卡片上直接显示退回原因，
 *     不写的话教师只看到"已退回"而不知道为什么 —— 数据库上也有同名约束）；
 *   · 弹窗里直说"这一步不产生审核记录，只记审计"，
 *     免得管理员以为界面上的"已发布"就等于走过审核了。
 */
export function BulkStatusDialog({
  open,
  count,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  readonly open: boolean
  readonly count: number
  readonly busy: boolean
  readonly error: string | null
  readonly onSubmit: (status: ResourceStatus, comment: string) => void
  readonly onClose: () => void
}) {
  const [status, setStatus] = useState<ResourceStatus>('RECALLED')
  const [comment, setComment] = useState('')
  /** 改成「已发布」时的第二次确认（勾上才能提交）。 */
  const [publishConfirmed, setPublishConfirmed] = useState(false)

  // 每次打开都回到干净状态：上一次勾过的"确认发布"绝不能留到下一次。
  useEffect(() => {
    if (!open) return
    setStatus('RECALLED')
    setComment('')
    setPublishConfirmed(false)
  }, [open])

  const needsComment = FORCE_STATUS_REQUIRES_COMMENT.includes(status)
  const isPublish = status === 'PUBLISHED'
  const commentMissing = needsComment && comment.trim() === ''
  const blocked = busy || commentMissing || (isPublish && !publishConfirmed)

  return (
    <Dialog
      open={open}
      title="批量修改状态"
      onClose={busy ? () => undefined : onClose}
      testId="admin-bulk-status-dialog"
    >
      <p className="text-sm text-foreground">
        将选中的 <strong>{count}</strong> 条资源统一改成：
      </p>

      <div className="mt-3">
        <Label htmlFor="bulk-status-select" required>
          目标状态
        </Label>
        <select
          id="bulk-status-select"
          className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground min-h-10"
          value={status}
          disabled={busy}
          onChange={(e) => {
            setStatus(e.target.value as ResourceStatus)
            setPublishConfirmed(false)
          }}
          data-testid="admin-bulk-status-select"
        >
          {RESOURCE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {RESOURCE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-3">
        <Label htmlFor="bulk-status-comment">
          原因{needsComment ? '（必填）' : '（选填）'}
        </Label>
        <Textarea
          id="bulk-status-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={
            needsComment ? '请写清楚为什么退回 —— 教师会在「我的资源」里看到这句话' : '选填：说明为什么这样改'
          }
          maxLength={1000}
          disabled={busy}
          data-testid="admin-bulk-status-comment"
        />
        {commentMissing && (
          <p className="mt-1 text-xs text-destructive" data-testid="admin-bulk-status-comment-error">
            退回必须写原因（教师端要能看到）
          </p>
        )}
      </div>

      {isPublish && (
        <div
          className="mt-3 rounded-lg bg-destructive/10 px-3 py-2.5"
          data-testid="admin-bulk-status-publish-warning"
        >
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              改成「已发布」会<strong>绕过审核流程</strong>：这些内容会立刻对全园可见，
              而且<strong>不会</strong>产生审核记录（只记审计）。
            </span>
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="size-4"
              checked={publishConfirmed}
              disabled={busy}
              onChange={(e) => setPublishConfirmed(e.target.checked)}
              data-testid="admin-bulk-status-publish-confirm"
            />
            我确认要跳过审核，直接发布这 {count} 条
          </label>
        </div>
      )}

      {error !== null && (
        <p
          className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="admin-bulk-status-error"
        >
          {error}
        </p>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        这是一次<strong className="text-foreground">强制覆盖</strong>
        ：不走状态机、不要求满足前置状态。
        每一步都会记进审计（动作名「强制修改状态」），改成已撤回 / 已退回 / 待审核 / 已发布
        还会写进审核时间线。
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy} data-testid="admin-bulk-status-cancel">
          取消
        </Button>
        <Button
          type="button"
          onClick={() => onSubmit(status, comment.trim())}
          disabled={blocked}
          data-testid="admin-bulk-status-confirm"
        >
          {busy ? '正在修改…' : '确认修改'}
        </Button>
      </div>
    </Dialog>
  )
}
