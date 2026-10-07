import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 类名合成：clsx 处理条件，twMerge 处理冲突（后写的赢）。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
