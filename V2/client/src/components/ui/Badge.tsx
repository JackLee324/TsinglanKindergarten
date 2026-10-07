import type { HTMLAttributes } from 'react'
import { cn } from './cn'

type Variant = 'secondary' | 'success' | 'warning' | 'danger' | 'muted'

/** 徽标：V1 的 `rounded-full px-3 py-1 text-xs font-medium`。 */
const VARIANTS: Record<Variant, string> = {
  secondary: 'bg-secondary text-secondary-foreground',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/20 text-[#8a6520]',
  danger: 'bg-destructive/15 text-destructive',
  muted: 'bg-muted text-muted-foreground',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly variant?: Variant
}

export function Badge({ variant = 'secondary', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    />
  )
}
