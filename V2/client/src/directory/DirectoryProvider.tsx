import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { directoriesApi } from '../api/directories'
import type { DirectoryNode } from '../api/types'
import { useAuth } from '../auth/useAuth'
import { resolveInTree, type ResolvedTarget } from './path'

export interface DirectoryState {
  readonly roots: readonly DirectoryNode[]
  /** 全部分支的扁平列表（管理页与查找用）。 */
  readonly flat: readonly DirectoryNode[]
  readonly loading: boolean
  /** 首次加载是否结束（成功或失败）。**在它结束前不要对树做判断。** */
  readonly ready: boolean
  readonly error: string | null
  refresh: () => Promise<void>
  /** 按 id 找节点（管理页用；靠 id 而不是 slug 定位，避免改名期间错位）。 */
  byId: (id: string) => DirectoryNode | null
  /** 按 slug 路径在**已加载的树**里解析（不额外发请求，保证各处读的是同一棵树）。 */
  resolve: (segments: readonly string[]) => ResolvedTarget
}

export const DirectoryContext = createContext<DirectoryState | null>(null)

/**
 * 全站**唯一**持有目录树的地方。
 *
 * 侧边栏、目录卡片、面包屑、管理页读的都是这一份数据；任何页面都不得自己请求
 * `GET /api/directories/*` 并缓存副本 —— 那就是"第二份目录真相"。
 * V1 因此专门写了静态测试来禁止它，V2 从第一行代码起就这样设计。
 */
export function DirectoryProvider({ children }: { children: ReactNode }) {
  const { user, ready: authReady } = useAuth()
  const [roots, setRoots] = useState<readonly DirectoryNode[]>([])
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await directoriesApi.tree()
      setRoots(res.roots)
      setError(null)
    } catch (e) {
      setRoots([])
      setError(e instanceof Error ? e.message : '目录加载失败')
    } finally {
      setLoading(false)
      setReady(true)
    }
  }, [])

  useEffect(() => {
    if (!authReady) return
    if (user === null) {
      // 退出登录后必须清空：否则下一个登录的人会先看到上一个人的目录。
      setRoots([])
      setReady(false)
      return
    }
    void refresh()
  }, [authReady, user, refresh])

  const flat = useMemo(() => {
    const out: DirectoryNode[] = []
    const walk = (nodes: readonly DirectoryNode[]) => {
      for (const n of nodes) {
        out.push(n)
        walk(n.children)
      }
    }
    walk(roots)
    return out
  }, [roots])

  const byId = useCallback((id: string) => flat.find((n) => n.id === id) ?? null, [flat])

  const resolve = useCallback(
    (segments: readonly string[]) => resolveInTree(roots, segments),
    [roots],
  )

  const value = useMemo<DirectoryState>(
    () => ({ roots, flat, loading, ready, error, refresh, byId, resolve }),
    [roots, flat, loading, ready, error, refresh, byId, resolve],
  )

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>
}

export function useDirectory(): DirectoryState {
  const ctx = useContext(DirectoryContext)
  if (!ctx) throw new Error('useDirectory 必须在 DirectoryProvider 内使用')
  return ctx
}
