import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

/**
 * 批量操作的**逐条结果**弹窗（批量删除与批量改状态共用）。
 *
 * 为什么批量操作必须逐条回报，而不是一句"成功"：
 * 选中的 10 条里可能有 1 条已经被人删了、1 条状态不允许动。
 * 把"本来就不该动"（skipped）和"真的出错了"（failed）混在一起，
 * 界面就会把前者显示成失败 —— 用户于是去重试一件永远不会成功的事。
 *
 * 所以三档分开、逐条给原因，颜色也分开：成功绿、跳过灰、失败红。
 */
export interface BulkResultRow {
  readonly id: string
  readonly outcome: 'ok' | 'skipped' | 'failed'
  readonly message: string
}

const OUTCOME_TEXT: Readonly<Record<BulkResultRow['outcome'], string>> = {
  ok: '成功',
  skipped: '已跳过',
  failed: '失败',
}

const OUTCOME_CLASS: Readonly<Record<BulkResultRow['outcome'], string>> = {
  ok: 'text-success',
  skipped: 'text-muted-foreground',
  failed: 'text-destructive',
}

export function BulkResultDialog({
  open,
  title,
  testId,
  /** 成功那一档的说法（「已删除」/「已改为…」），数字后面跟着显示。 */
  okLabel,
  rows,
  footer,
  onClose,
}: {
  readonly open: boolean
  readonly title: string
  readonly testId: string
  readonly okLabel: string
  readonly rows: readonly BulkResultRow[]
  /** 弹窗底部、按钮上方的补充说明（比如"到回收站可以恢复"）。 */
  readonly footer?: ReactNode
  readonly onClose: () => void
}) {
  const count = (outcome: BulkResultRow['outcome']) =>
    rows.filter((r) => r.outcome === outcome).length

  return (
    <Dialog open={open} title={title} onClose={onClose} testId={testId}>
      <div data-testid={`${testId}-body`}>
        <p className="text-sm text-foreground">
          {okLabel} <strong data-testid={`${testId}-ok`}>{count('ok')}</strong> 条 ·
          跳过 <strong data-testid={`${testId}-skipped`}>{count('skipped')}</strong> 条 ·
          失败 <strong data-testid={`${testId}-failed`}>{count('failed')}</strong> 条
        </p>
        <ul
          className="mt-3 max-h-64 space-y-1 overflow-y-auto text-sm"
          data-testid={`${testId}-items`}
        >
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-2">
              <span className={OUTCOME_CLASS[row.outcome]}>{OUTCOME_TEXT[row.outcome]}</span>
              <span className="text-muted-foreground">{row.message}</span>
            </li>
          ))}
        </ul>
        {footer !== undefined && <div className="mt-3">{footer}</div>}
        <div className="mt-5 flex justify-end">
          <Button type="button" onClick={onClose} data-testid={`${testId}-close`}>
            知道了
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
