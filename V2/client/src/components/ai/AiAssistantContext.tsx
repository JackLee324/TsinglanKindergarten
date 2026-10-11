/**
 * client/src/components/ai/AiAssistantContext.tsx —— AI 面板的开关状态
 * ============================================================================
 * 为什么需要它：入口在**侧边栏和顶栏**（两处，桌面/移动各一个），
 * 面板本身挂在应用外壳（`Layout`）上。它们分处不同的子树，
 * 用一个 5 行的 context 比把状态提到 `Layout` 再一层层往下传更清楚 ——
 * 也让"入口"和"面板"各自只有一处实现（业主禁止第二套导航数据）。
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

interface AiAssistantValue {
  readonly isOpen: boolean
  readonly open: () => void
  readonly close: () => void
  readonly toggle: () => void
}

const AiAssistantContext = createContext<AiAssistantValue | null>(null)

export function AiAssistantProvider({ children }: { readonly children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])
  const value = useMemo(() => ({ isOpen, open, close, toggle }), [isOpen, open, close, toggle])
  return <AiAssistantContext.Provider value={value}>{children}</AiAssistantContext.Provider>
}

export function useAiAssistant(): AiAssistantValue {
  const value = useContext(AiAssistantContext)
  if (value === null) throw new Error('useAiAssistant 必须在 AiAssistantProvider 内使用')
  return value
}
