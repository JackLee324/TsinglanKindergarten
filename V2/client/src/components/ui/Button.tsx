import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

type Variant = 'primary' | 'outline' | 'ghost' | 'secondary' | 'danger'
type Size = 'sm' | 'md'

/**
 * 按钮。视觉取自 V1：`rounded-lg`、主按钮 `bg-primary text-white`、
 * `hover:bg-primary-dark`、`px-5 py-2`。
 *
 * 只保留 V1 真正在用的几个变体 —— 组件库的价值在于一致，不在于数量。
 */
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-dark',
  outline: 'border border-border bg-card text-foreground hover:bg-secondary',
  ghost: 'text-foreground hover:bg-secondary',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-primary-light/40',
  danger: 'bg-destructive text-destructive-foreground hover:opacity-90',
}

const SIZES: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-5 py-2 text-sm',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant
  readonly size?: Size
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  )
}
