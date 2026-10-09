import { api } from './http'
import type {
  AdminUserDetail,
  AuditLogPage,
  PermissionGrant,
  PermissionItem,
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
    /** 建好后是否立即启用 —— 由后端在同一事务里落库（Stage 13 §5）。 */
    active?: boolean
    permissions?: PermissionGrant[]
  }) => api.post<AdminUserDetail>('/api/users', input),

  updateUser: (
    id: string,
    input: {
      name?: string
      nameEn?: string | null
      /** 改用户名：唯一性由 lower(username) 唯一索引保证，服务端给可读的 409。 */
      username?: string
      role?: UserRole
      active?: boolean
      password?: string
    },
  ) => api.patch<{ revokedSessions: number }>(`/api/users/${id}`, input),

  userPermissions: (id: string) =>
    api.get<{ items: PermissionItem[] }>(`/api/users/${id}/permissions`),

  /**
   * 整份替换：界面上勾选框提交的就是"最终结果"。
   *
   * 只提交 `{ permission, directoryId }`：读接口会**多带一个 `label`**
   * （界面要显示中文名），而服务端 DTO 开了白名单，多带字段直接 400。
   * 所以"瘦身"放在这里统一做，而不是指望每个调用方都记得自己 map 一遍 ——
   * 漏一次的表现就是"我只是打开一位老师、什么都没改，点保存却报请求参数不合法"。
   */
  setPermissions: (id: string, permissions: readonly PermissionGrant[]) =>
    api.put<{ grants: number; revokedSessions: number }>(`/api/users/${id}/permissions`, {
      permissions: permissions.map((g) => ({ permission: g.permission, directoryId: g.directoryId })),
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
