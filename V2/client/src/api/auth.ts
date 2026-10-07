import { api, request } from './http'
import type { Capabilities, SessionUser } from './types'

export const authApi = {
  login: (username: string, password: string) =>
    request<{ user: SessionUser; permissions: string[] }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
      skipAuthRedirect: true,
    }),

  logout: () => api.post<{ ok: true }>('/api/auth/logout'),

  /** 启动时探测"我是谁"。401 是正常情况（未登录），不跳转。 */
  me: () =>
    request<{ user: SessionUser; permissions: string[] }>('/api/auth/me', {
      method: 'GET',
      skipAuthRedirect: true,
    }),

  capabilities: () => api.get<Capabilities>('/api/auth/capabilities'),
}
