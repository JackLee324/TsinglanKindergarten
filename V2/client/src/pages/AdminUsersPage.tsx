import { useCallback, useEffect, useState } from 'react'
import { Search, UserPlus } from 'lucide-react'
import { adminApi } from '../api/admin'
import type { AdminUserRow, PermissionGrant } from '../api/types'
import { useAuth } from '../auth/useAuth'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Dialog } from '../components/ui/Dialog'
import { EmptyState } from '../components/ui/EmptyState'
import { Input, Label } from '../components/ui/Input'
import { Spinner } from '../components/ui/Spinner'
import { PermissionEditor } from '../components/admin/PermissionEditor'
import { humanMessage } from '../components/resource/errors'
import { DEFAULT_PAGE_SIZE } from '@shared/resource-query'

/**
 * 教师账号管理（业主 Stage 8 §2 / §3 / §28 / §29）。
 *
 * 界面上的承诺只有一句：**"我就是在管理老师。"**
 *   · 列表：姓名 / 用户名 / 状态 / 创建时间 / 最后登录 / 权限摘要；
 *   · 新增：姓名 + 用户名 + 密码 + 确认密码 + 启用 + 权限 + 开放目录；
 *   · 编辑：改姓名、启停、重置密码；
 *   · **没有**角色下拉、权限版本、Scope、Grant、Deny、Override、Effective。
 *
 * 分页与搜索都在服务端（业主 §28：不要一次读取所有教师）。
 */
export function AdminUsersPage() {
  const { capabilities } = useAuth()
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<readonly AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminUserRow | null>(null)
  const [permissionTarget, setPermissionTarget] = useState<AdminUserRow | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await adminApi.users({
        q: appliedQuery,
        status: statusFilter,
        page,
        pageSize: DEFAULT_PAGE_SIZE,
      })
      setItems(res.items)
      setTotal(res.total)
      setTotalPages(res.totalPages)
    } catch (e) {
      setItems([])
      setTotal(0)
      setError(humanMessage(e, '加载教师账号失败'))
    } finally {
      setLoading(false)
    }
  }, [appliedQuery, statusFilter, page])

  useEffect(() => {
    void reload()
  }, [reload])

  if (capabilities?.canManageUsers !== true) {
    return (
      <EmptyState
        title="你没有教师管理权限"
        description="这个页面只对可以管理账号的人开放。"
        testId="users-forbidden"
      />
    )
  }

  return (
    <div data-testid="admin-users-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground" data-testid="page-title">
            教师账号
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            给老师开账号、开权限。改动权限会让他**立刻**需要重新登录。
          </p>
        </div>
        <Button type="button" onClick={() => setCreating(true)} data-testid="users-create">
          <UserPlus className="size-4" /> 新增教师
        </Button>
      </div>

      <form
        className="mt-5 flex flex-wrap items-end gap-3"
        data-testid="users-filters"
        onSubmit={(e) => {
          e.preventDefault()
          setPage(1)
          setAppliedQuery(query.trim())
        }}
      >
        <div>
          <Label htmlFor="users-q">搜索</Label>
          <Input
            id="users-q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="姓名或用户名"
            className="w-56"
            data-testid="users-search"
          />
        </div>
        <div>
          <Label htmlFor="users-status">状态</Label>
          <select
            id="users-status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value)
              setPage(1)
            }}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
            data-testid="users-status-filter"
          >
            <option value="">全部</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </div>
        <Button type="submit" variant="outline" size="sm" data-testid="users-search-submit">
          <Search className="size-4" /> 搜索
        </Button>
      </form>

      {notice !== null && (
        <p className="mt-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success" data-testid="users-notice">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="users-error">
          {error}
        </p>
      )}

      <div className="mt-5">
        {loading && items.length === 0 ? (
          <Spinner label="正在加载教师账号…" />
        ) : items.length === 0 ? (
          <EmptyState
            title={appliedQuery === '' ? '还没有教师账号' : `没有找到与「${appliedQuery}」匹配的账号`}
            testId="users-empty"
          />
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border border-border" data-testid="users-table">
              <table className="w-full text-sm">
                <thead className="bg-secondary text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">姓名</th>
                    <th className="px-4 py-2 font-medium">用户名</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">创建时间</th>
                    <th className="px-4 py-2 font-medium">最后登录</th>
                    <th className="px-4 py-2 font-medium">权限</th>
                    <th className="px-4 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((row) => (
                    <tr key={row.id} data-testid="users-row" data-user-id={row.id} data-username={row.username}>
                      <td className="px-4 py-3">
                        <span className="text-foreground" data-testid="users-row-name">
                          {row.name}
                        </span>
                        {/*
                          这一行**是不是管理员**由服务端算好（`row.isAdmin`）。
                          前端不比较角色 —— 即使这里只是显示一个标签，
                          也没有理由让"管理员"这个概念在界面里再定义一次。
                        */}
                        {row.isAdmin && (
                          <Badge variant="secondary" className="ml-2">
                            管理员
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground" data-testid="users-row-username">
                        {row.username}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={row.status === 'active' ? 'success' : 'muted'} data-testid="users-row-status">
                          {row.status === 'active' ? '启用' : '停用'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{row.createdAt.slice(0, 10)}</td>
                      <td className="px-4 py-3 text-muted-foreground" data-testid="users-row-last-login">
                        {row.lastLoginAt === null ? '从未登录' : row.lastLoginAt.slice(0, 16).replace('T', ' ')}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground" data-testid="users-row-permissions">
                        {row.isAdmin
                          ? '全部管理能力'
                          : row.permissionSummary.length === 0
                            ? '未配置'
                            : row.permissionSummary
                                .map((s) =>
                                  s.global ? s.label : `${s.label} ${s.directoryCount} 个目录`,
                                )
                                .join(' / ')}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setEditing(row)}
                            data-testid="users-row-edit"
                          >
                            编辑
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setPermissionTarget(row)}
                            data-testid="users-row-permissions-button"
                          >
                            权限
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3" data-testid="users-pagination">
              <p className="text-sm text-muted-foreground" data-testid="users-page-info">
                第 {page} 页 / 共 {totalPages} 页 · 共 {total} 人
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="users-page-prev"
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                  data-testid="users-page-next"
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {creating && (
        <CreateTeacherDialog
          onClose={() => setCreating(false)}
          onCreated={async (name) => {
            setCreating(false)
            setNotice(`已创建教师账号：${name}`)
            await reload()
          }}
        />
      )}

      {editing !== null && (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null)
            setNotice(message)
            await reload()
          }}
        />
      )}

      {permissionTarget !== null && (
        <PermissionsDialog
          user={permissionTarget}
          onClose={() => setPermissionTarget(null)}
          onSaved={async (message) => {
            setPermissionTarget(null)
            setNotice(message)
            await reload()
          }}
        />
      )}
    </div>
  )
}

/** 新增教师。字段就这些 —— 业主 §3 的原话是"就结束"。 */
function CreateTeacherDialog({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void
  readonly onCreated: (name: string) => void | Promise<void>
}) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [active, setActive] = useState(true)
  const [grants, setGrants] = useState<PermissionGrant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await adminApi.createUser({
        name: name.trim(),
        username: username.trim(),
        password,
        // 身份固定为教师：界面上没有"选身份"这一步（业主 §1：只有 ADMIN 与 TEACHER，
        // 而新建的永远是老师）。
        role: 'TEACHER',
        permissions: grants,
      })
      if (!active) {
        // 新增时就停用：先建再停用（接口分开，语义清楚）
        const created = await adminApi.users({ q: username.trim(), pageSize: 1 })
        const id = created.items[0]?.id
        if (id) await adminApi.updateUser(id, { active: false })
      }
      await onCreated(name.trim())
    } catch (e) {
      setError(humanMessage(e, '创建失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open title="新增教师" testId="create-user-dialog" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="new-name" required>
              姓名
            </Label>
            <Input id="new-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="new-user-name" />
          </div>
          <div>
            <Label htmlFor="new-username" required>
              用户名
            </Label>
            <Input
              id="new-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              data-testid="new-user-username"
            />
          </div>
          <div>
            <Label htmlFor="new-password" required>
              密码
            </Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="new-user-password"
            />
          </div>
          <div>
            <Label htmlFor="new-confirm" required>
              确认密码
            </Label>
            <Input
              id="new-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              data-testid="new-user-confirm"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            data-testid="new-user-active"
          />
          启用
        </label>

        <PermissionEditor
          value={grants}
          // 新建时没有对象可换，用一个固定 key —— 编辑器只在真的换人时重建。
          resetKey="new-user"
          onChange={(next) => setGrants(next)}
        />

        {error !== null && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="create-user-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || name.trim() === '' || username.trim() === '' || password === ''}
            onClick={() => void submit()}
            data-testid="create-user-submit"
          >
            {busy ? '正在保存…' : '保存'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** 编辑：姓名、启停、重置密码。**没有**"改成管理员"这种开关给自己用。 */
function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  readonly user: AdminUserRow
  readonly onClose: () => void
  readonly onSaved: (message: string) => void | Promise<void>
}) {
  const [name, setName] = useState(user.name)
  const [active, setActive] = useState(user.status === 'active')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const input: { name?: string; active?: boolean; password?: string } = {
        name: name.trim(),
        active,
      }
      if (password !== '') input.password = password
      const res = await adminApi.updateUser(user.id, input)
      await onSaved(
        res.revokedSessions > 0
          ? '已保存。该账号的登录状态已失效，需要重新登录。'
          : '已保存。',
      )
    } catch (e) {
      setError(humanMessage(e, '保存失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open title={`编辑：${user.name}`} testId="edit-user-dialog" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="edit-name">姓名</Label>
          <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="edit-user-name" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            data-testid="edit-user-active"
          />
          启用（停用后该账号立刻不能登录，已登录的会掉线）
        </label>
        <div>
          <Label htmlFor="edit-password">重置密码（留空表示不改）</Label>
          <Input
            id="edit-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 8 位"
            data-testid="edit-user-password"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            只能设置新密码，看不到也取不回旧密码（数据库里存的是哈希）。
          </p>
        </div>

        {error !== null && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="edit-user-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={() => void submit()} data-testid="edit-user-submit">
            {busy ? '正在保存…' : '保存'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** 权限：勾权限 + 勾目录。保存成功即撤销该账号全部会话（业主 §5）。 */
function PermissionsDialog({
  user,
  onClose,
  onSaved,
}: {
  readonly user: AdminUserRow
  readonly onClose: () => void
  readonly onSaved: (message: string) => void | Promise<void>
}) {
  const [grants, setGrants] = useState<PermissionGrant[] | null>(null)
  const [mode, setMode] = useState<'uniform' | 'per-permission'>('uniform')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    adminApi
      .userPermissions(user.id)
      .then((res) => setGrants([...res.items]))
      .catch((e) => setError(humanMessage(e, '加载权限失败')))
  }, [user.id])

  async function submit() {
    if (grants === null) return
    setBusy(true)
    setError(null)
    try {
      const res = await adminApi.setPermissions(user.id, grants)
      await onSaved(
        res.revokedSessions > 0
          ? '权限已保存。该账号的登录状态已失效，需要重新登录后生效。'
          : '权限已保存。',
      )
    } catch (e) {
      setError(humanMessage(e, '保存权限失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open title={`权限：${user.name}`} testId="user-permissions-dialog" onClose={onClose}>
      <div className="space-y-4">
        {grants === null ? (
          <Spinner label="正在加载权限…" />
        ) : (
          <PermissionEditor
            value={grants}
            // 换一位老师 = 换一个 resetKey：编辑器据此重建勾选状态。
            resetKey={user.id}
            onChange={(next, nextMode) => {
              setGrants(next)
              setMode(nextMode)
            }}
          />
        )}

        {error !== null && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="user-permissions-error">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" data-testid="user-permissions-mode">
            当前方式：{mode === 'uniform' ? '统一开放目录' : '分别设置'}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || grants === null}
              onClick={() => void submit()}
              data-testid="user-permissions-save"
            >
              {busy ? '正在保存…' : '保存权限'}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
