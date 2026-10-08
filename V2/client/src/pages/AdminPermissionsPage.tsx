import { useEffect, useState } from 'react'
import { adminApi } from '../api/admin'
import type { AdminUserRow, PermissionGrant } from '../api/types'
import { useAuth } from '../auth/useAuth'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Label } from '../components/ui/Input'
import { Spinner } from '../components/ui/Spinner'
import { PermissionEditor } from '../components/admin/PermissionEditor'
import { humanMessage } from '../components/resource/errors'

/**
 * 权限管理（业主 Stage 8 §22 / §24）。
 *
 * 这个页面**不是**第二套权限编辑器：它选的是一位老师，然后渲染的是
 * 与「教师账号 → 权限」完全同一个 `PermissionEditor`。
 * 业主 §22 要求导航里有"权限"入口，而 §25 要求界面上不能说 RBAC 术语 ——
 * 这个页面用一句话把这件事说清楚：
 *
 *   「选择老师 → 勾权限 → 勾开放目录 → 保存」
 *
 * 界面上没有 scope / grant / deny / override / effective 中的任何一个词。
 */
export function AdminPermissionsPage() {
  const { capabilities } = useAuth()
  const [teachers, setTeachers] = useState<readonly AdminUserRow[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [grants, setGrants] = useState<PermissionGrant[] | null>(null)
  const [mode, setMode] = useState<'uniform' | 'per-permission'>('uniform')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /*
    先看能力位再取数（同 AdminUsersPage / AdminAuditPage）：老师在手机上打开
    `/admin/permissions` 时不该先发两次必然 403 的请求再被告知"你没权限"。
  */
  const canManageUsers = capabilities?.canManageUsers === true

  useEffect(() => {
    if (!canManageUsers) return
    adminApi
      // 只列教师：管理员的"权限"不在这里配（管理员天然拥有全部能力，业主 §26）。
      // ⚠️ 过滤**在服务端做**（列表接口本来就有 role 参数）——
      // 前端不比较角色，连"哪一行是教师"这件事也不自己判断。
      .users({ role: 'TEACHER', pageSize: 100 })
      .then((res) => {
        setTeachers(res.items)
        setSelectedId((prev) => prev || res.items[0]?.id || '')
      })
      .catch((e) => setError(humanMessage(e, '加载教师列表失败')))
  }, [canManageUsers])

  useEffect(() => {
    if (!canManageUsers || selectedId === '') return
    setGrants(null)
    setNotice(null)
    adminApi
      .userPermissions(selectedId)
      .then((res) => setGrants([...res.items]))
      .catch((e) => setError(humanMessage(e, '加载权限失败')))
  }, [selectedId, canManageUsers])

  if (!canManageUsers) {
    return (
      <EmptyState
        title="你没有权限管理权限"
        description="这个页面只对可以管理账号的人开放。"
        testId="permissions-forbidden"
      />
    )
  }

  const selected = teachers.find((t) => t.id === selectedId) ?? null

  async function save() {
    if (grants === null || selected === null) return
    setBusy(true)
    setError(null)
    try {
      const res = await adminApi.setPermissions(selected.id, grants)
      setNotice(
        res.revokedSessions > 0
          ? `已保存 ${res.grants} 条授权。该老师的登录状态已失效，需要重新登录后生效。`
          : `已保存 ${res.grants} 条授权。`,
      )
    } catch (e) {
      setError(humanMessage(e, '保存失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="admin-permissions-page">
      <h1 className="text-2xl font-semibold text-foreground" data-testid="page-title">
        权限
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        选择老师 → 勾选他能做什么 → 勾选开放目录 → 保存。保存后他需要重新登录。
      </p>

      <div className="mt-5 max-w-md">
        <Label htmlFor="permission-teacher">教师</Label>
        <select
          id="permission-teacher"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
          data-testid="permissions-teacher-select"
        >
          <option value="">请选择教师</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}（{t.username}）
            </option>
          ))}
        </select>
      </div>

      {notice !== null && (
        <p className="mt-4 rounded-lg bg-success/10 px-3 py-2 text-sm text-success" data-testid="permissions-notice">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="permissions-error">
          {error}
        </p>
      )}

      <div className="mt-5">
        {selected === null ? (
          <EmptyState title="还没有教师账号" description="先去「教师账号」新增一位老师。" testId="permissions-empty" />
        ) : grants === null ? (
          <Spinner label="正在加载权限…" />
        ) : (
          <>
            <PermissionEditor
              value={grants}
              // 下拉里换人 → 换 resetKey → 编辑器重建。
              resetKey={selected.id}
              onChange={(next, nextMode) => {
                setGrants(next)
                setMode(nextMode)
              }}
              // 底部那行"当前方式"读编辑器的实际方式，不是页面的猜测。
              onModeChange={setMode}
            />
            <div className="mt-4 flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground" data-testid="permissions-mode">
                当前方式：{mode === 'uniform' ? '统一开放目录' : '分别设置'}
              </p>
              <Button type="button" disabled={busy} onClick={() => void save()} data-testid="permissions-save">
                {busy ? '正在保存…' : '保存'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
