import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { authApi } from '../api/auth'
import { ApiError } from '../api/http'
import type { Capabilities, SessionUser } from '../api/types'

export interface AuthState {
  readonly user: SessionUser | null
  readonly capabilities: Capabilities | null
  /** 首次"我是谁"探测是否结束。**在它结束前不要渲染任何依赖登录状态的东西。 */
  readonly ready: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)

/**
 * 会话与能力。
 *
 * 两点刻意为之：
 *   · `ready`：启动时要先问一次 `/api/auth/me`，否则第一帧会先渲染成"未登录"
 *     再跳到登录页 —— 用户看到的是闪一下的登录页，而不是自己的数据。
 *   · **能力来自服务端**（`/api/auth/capabilities`），前端不自己判断角色。
 *     页面只问"服务端说我能做什么"，不写 `role === 'ADMIN'`。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const me = await authApi.me()
      setUser(me.user)
      setCapabilities(await authApi.capabilities())
    } catch (error) {
      // 401 是正常情况（未登录）；其它错误也当作未登录，但要把能力清空，
      // 避免"上次的权限"残留导致按钮错误地出现。
      if (!(error instanceof ApiError)) throw error
      setUser(null)
      setCapabilities(null)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await refresh()
      setReady(true)
    })()
  }, [refresh])

  const login = useCallback(
    async (username: string, password: string) => {
      await authApi.login(username, password)
      await refresh()
    },
    [refresh],
  )

  const logout = useCallback(async () => {
    await authApi.logout()
    setUser(null)
    setCapabilities(null)
  }, [])

  const value = useMemo<AuthState>(
    () => ({ user, capabilities, ready, login, logout, refresh }),
    [user, capabilities, ready, login, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
