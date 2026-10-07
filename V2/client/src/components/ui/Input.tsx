import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

const BASE =
  'w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 ' +
  'focus:outline-none disabled:opacity-50'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(BASE, className)} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(BASE, 'min-h-20 resize-y', className)} {...rest} />
}

export function Label({
  children,
  htmlFor,
  required,
}: {
  readonly children: React.ReactNode
  readonly htmlFor?: string
  readonly required?: boolean
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-foreground">
      {children}
      {required === true && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  )
}
