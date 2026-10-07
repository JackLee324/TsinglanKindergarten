import type { ReactNode } from 'react'

export function EmptyState({
  title,
  description,
  action,
  testId,
}: {
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
  readonly testId?: string
}) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center"
      data-testid={testId ?? 'empty-state'}
    >
      <p className="text-base font-medium text-foreground">{title}</p>
      {description !== undefined && (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  )
}
