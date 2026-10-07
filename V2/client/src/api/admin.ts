import { api } from './http'
import type {
  AdminUserDetail,
  AuditLogPage,
  PermissionGrant,
  UserListPage,
  UserRole,
} from './types'

/**
 * 管理员接口（业主 Stage 8）。
 *
 * 这一层刻意保持"薄"：它只做请求，不做任何权限判断 ——
 * 能不能进管理页由服务端的 `capabilities` 决定，能不能执行由服务端逐条判定。
 * 前端**没有**任何 `role === 'ADMIN'`。
 */
export const adminApi = {
  /** 教师账号列表：服务端搜索 + 分页（业主 §28）。 */
  users: (query: { q?: string; status?: string; role?: string; page?: number; pageSize?: number }) => {
    const params = new URLSearchParams()
    if (query.q) params.set('q', query.q)
    if (query.status) params.set('status', query.status)
    if (query.role) params.set('role', query.role)
    if (query.page) params.set('page', String(query.page))
    if (query.pageSize) params.set('pageSize', String(query.pageSize))
    return api.get<UserListPage>(`/api/users?${params.toString()}`)
  },

  user: (id: string) => api.get<AdminUserDetail>(`/api/users/${id}`),

  createUser: (input: {
    name: string
    username: string
    password: string
    role: UserRole
    permissions?: PermissionGrant[]
  }) => api.post<AdminUserDetail>('/api/users', input),

  updateUser: (
    id: string,
    input: { name?: string; nameEn?: string | null; role?: UserRole; active?: boolean; password?: string },
  ) => api.patch<{ revokedSessions: number }>(`/api/users/${id}`, input),

  userPermissions: (id: string) =>
    api.get<{ items: PermissionGrant[] }>(`/api/users/${id}/permissions`),

  /** 整份替换：界面上勾选框提交的就是"最终结果"。 */
  setPermissions: (id: string, permissions: PermissionGrant[]) =>
    api.put<{ grants: number; revokedSessions: number }>(`/api/users/${id}/permissions`, {
      permissions,
    }),

  audit: (query: {
    action?: string
    result?: string
    actorId?: string
    targetType?: string
    targetId?: string
    from?: string
    to?: string
    limit?: number
    offset?: number
  }) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && String(value) !== '') {
        params.set(key, String(value))
      }
    }
    return api.get<AuditLogPage>(`/api/audit/logs?${params.toString()}`)
  },

  auditActions: () =>
    api.get<{ items: { action: string; label: string }[] }>('/api/audit/actions'),
}
