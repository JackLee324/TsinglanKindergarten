import type { HTMLAttributes } from 'react'
import { cn } from './cn'

/** 卡片：V1 的 `bg-white rounded-xl shadow-sm border border-[#E8E4F0]`。 */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-card shadow-sm', className)}
      {...rest}
    />
  )
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-6', className)} {...rest} />
}
