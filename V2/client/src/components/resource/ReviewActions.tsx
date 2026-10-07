import { useState } from 'react'
import { CheckCircle2, Send, Undo2, XCircle } from 'lucide-react'
import { resourcesApi } from '../../api/resources'
import type { ResourceDetail } from '../../api/types'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Label, Textarea } from '../ui/Input'
import { humanMessage } from './errors'

/**
 * 资源详情页上的**流程动作**（业主 Stage 7 §21 / §22）。
 *
 * ⚠️ 这里就是业主点名要避免的那件事的反面：
 * 不再有独立的「审核详情页」—— 审核员和教师看的是**同一个资源详情页**，
 * 只是各自看到的动作不同。动作清单来自服务端的 `capabilities`，
 * 前端不做任何角色判断（没有 `role === 'ADMIN'`，也没有 `roles.includes(...)`）。
 *
 * 三个动作的措辞与后果：
 *   · 「提交审核」   DRAFT → PENDING_REVIEW（教师）
 *   · 「通过并发布」 PENDING_REVIEW → PUBLISHED（审核员，**一步**，业主 §14）
 *   · 「退回」       PENDING_REVIEW → REJECTED（审核员，**必须**填原因）
 *   · 「撤回」       PUBLISHED → RECALLED（作者，原因可选）
 */
export function ReviewActions({
  resource,
  onChanged,
}: {
  readonly resource: ResourceDetail
  readonly onChanged: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [rejectComment, setRejectComment] = useState('')
  const [recalling, setRecalling] = useState(false)
  const [recallComment, setRecallComment] = useState('')

  const caps = resource.capabilities
  const nothingToDo =
    !caps.canSubmit && !caps.canApprove && !caps.canReject && !caps.canRecall

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await onChanged()
    } catch (e) {
      setError(humanMessage(e, '操作失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5" data-testid="review-actions">
      {error !== null && (
        <p
          className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="review-action-error"
        >
          {error}
        </p>
      )}

      {/*
        被拒的**原因**要说清楚。审核员在自己的资源上会看到「不能审核自己上传的资源」——
        如果只说"没有权限"，他会去找管理员要权限，而要到了也没用（系统就是不允许自审）。
      */}
      {resource.status === 'PENDING_REVIEW' && caps.reviewDeniedReason === 'self-review' && (
        <p
          className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-sm text-foreground"
          data-testid="review-self-notice"
        >
          这条资源是你自己上传的，不能自己审核，需要由其他审核员处理。
        </p>
      )}

      {nothingToDo ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {caps.canSubmit && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void run(() => resourcesApi.submit(resource.id))}
              data-testid="action-submit"
            >
              <Send className="size-4" /> 提交审核
            </Button>
          )}

          {caps.canApprove && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void run(() => resourcesApi.review(resource.id, { action: 'approve' }))}
              data-testid="action-approve"
            >
              <CheckCircle2 className="size-4" /> 通过并发布
            </Button>
          )}

          {caps.canReject && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRejectComment('')
                setRejecting(true)
              }}
              data-testid="action-reject"
            >
              <XCircle className="size-4" /> 退回
            </Button>
          )}

          {caps.canRecall && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRecallComment('')
                setRecalling(true)
              }}
              data-testid="action-recall"
            >
              <Undo2 className="size-4" /> 撤回
            </Button>
          )}
        </div>
      )}

      {/* 退回：原因**必填**（业主 §6：教师之后必须能看到退回原因） */}
      <Dialog
        open={rejecting}
        title="退回这条资源"
        testId="reject-dialog"
        onClose={() => setRejecting(false)}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            退回后资源会变成「已退回」，教师会在「我的资源」里看到你写的意见。
          </p>
          <div>
            <Label htmlFor="reject-comment" required>
              审核意见
            </Label>
            <Textarea
              id="reject-comment"
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
              placeholder="例如：请补充课程目标。"
              maxLength={1000}
              data-testid="reject-comment"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRejecting(false)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || rejectComment.trim() === ''}
              onClick={() =>
                void run(async () => {
                  await resourcesApi.review(resource.id, {
                    action: 'reject',
                    comment: rejectComment.trim(),
                  })
                  setRejecting(false)
                })
              }
              data-testid="reject-submit"
            >
              确认退回
            </Button>
          </div>
        </div>
      </Dialog>

      {/* 撤回：原因可选。**不是 reject** —— 教师的「我的资源」里不会出现假的退回原因。 */}
      <Dialog
        open={recalling}
        title="撤回这条资源"
        testId="recall-dialog"
        onClose={() => setRecalling(false)}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            撤回后资源从目录里消失，但不会删除；你可以在「我的资源」里修改后重新提交审核。
          </p>
          <div>
            <Label htmlFor="recall-comment">撤回原因（选填）</Label>
            <Textarea
              id="recall-comment"
              value={recallComment}
              onChange={(e) => setRecallComment(e.target.value)}
              placeholder="例如：内容需要调整，暂时下架。"
              maxLength={1000}
              data-testid="recall-comment"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRecalling(false)}>
              取消
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await resourcesApi.recall(resource.id, recallComment.trim() || null)
                  setRecalling(false)
                })
              }
              data-testid="recall-submit"
            >
              确认撤回
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
