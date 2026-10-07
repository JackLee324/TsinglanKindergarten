import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from './cn'

/**
 * 弹窗。视觉取自 V1：白底、rounded-xl、居中、遮罩 `bg-black/30`。
 *
 * 只做必要的事：Esc 关闭、点击遮罩关闭、打开时锁滚动。
 * 不做动画编排（业主明确要求"不要加入复杂动画"）。
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  testId,
}: {
  readonly open: boolean
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
  readonly testId?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      data-testid={testId ?? 'dialog'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-lg',
          'max-h-[85vh] overflow-y-auto',
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            data-testid="dialog-close"
            onClick={onClose}
            className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-secondary"
          >
            <X className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
