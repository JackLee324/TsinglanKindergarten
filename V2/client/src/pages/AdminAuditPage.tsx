import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { adminApi } from '../api/admin'
import type { AuditLogRow } from '../api/types'
import { useAuth } from '../auth/useAuth'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Input, Label } from '../components/ui/Input'
import { Spinner } from '../components/ui/Spinner'
import { humanMessage } from '../components/resource/errors'
import { AUDIT_ACTIONS, type AuditAction } from '@shared/audit-actions'

const PAGE_SIZE = 50

/**
 * 审计（业主 Stage 8 §14 / §15 / §35）。
 *
 * 每一条都能看到：操作者 / 动作 / 目标 / 时间 / 结果。
 * 筛选就是"查问题时真的会用到的那几个"：动作、结果、操作者 id、对象 id、时间区间。
 *
 * **不做统计聚合** —— 业主明确说"不要先做复杂统计"。
 * 这一页的用途是回答"谁把那个目录关了""谁改过这个老师的密码"。
 */
export function AdminAuditPage() {
  const { capabilities } = useAuth()
  const [action, setAction] = useState('')
  const [result, setResult] = useState('')
  const [actorId, setActorId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<readonly AuditLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await adminApi.audit({ action, result, actorId, targetId, from, to, limit: PAGE_SIZE, offset })
      setItems(res.items)
      setTotal(res.total)
    } catch (e) {
      setItems([])
      setTotal(0)
      setError(humanMessage(e, '加载审计失败'))
    } finally {
      setLoading(false)
    }
  }, [action, result, actorId, targetId, from, to, offset])

  useEffect(() => {
    void reload()
  }, [reload])

  if (capabilities?.canViewAudit !== true) {
    return (
      <EmptyState title="你没有审计权限" description="审计只对管理员开放。" testId="audit-forbidden" />
    )
  }

  const labelOf = (a: string): string =>
    Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, a)
      ? AUDIT_ACTIONS[a as AuditAction]
      : a

  return (
    <div data-testid="admin-audit-page">
      <h1 className="text-2xl font-semibold text-foreground" data-testid="page-title">
        审计
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        谁在什么时候做了什么、结果如何。审计只读，不可修改、不可删除。
      </p>

      <form
        className="mt-5 flex flex-wrap items-end gap-3"
        data-testid="audit-filters"
        onSubmit={(e) => {
          e.preventDefault()
          setOffset(0)
          void reload()
        }}
      >
        <div>
          <Label htmlFor="audit-action">动作</Label>
          <select
            id="audit-action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value)
              setOffset(0)
            }}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
            data-testid="audit-action-filter"
          >
            <option value="">全部动作</option>
            {Object.entries(AUDIT_ACTIONS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="audit-result">结果</Label>
          <select
            id="audit-result"
            value={result}
            onChange={(e) => {
              setResult(e.target.value)
              setOffset(0)
            }}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
            data-testid="audit-result-filter"
          >
            <option value="">全部</option>
            <option value="success">成功</option>
            <option value="denied">被拒绝</option>
            <option value="failed">失败</option>
          </select>
        </div>
        <div>
          <Label htmlFor="audit-actor">操作者 ID</Label>
          <Input
            id="audit-actor"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            placeholder="用户 uuid"
            className="w-52"
            data-testid="audit-actor-filter"
          />
        </div>
        <div>
          <Label htmlFor="audit-target">对象 ID</Label>
          <Input
            id="audit-target"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            placeholder="资源 / 目录 / 用户 uuid"
            className="w-52"
            data-testid="audit-target-filter"
          />
        </div>
        <div>
          <Label htmlFor="audit-from">起始</Label>
          <Input
            id="audit-from"
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-48"
            data-testid="audit-from-filter"
          />
        </div>
        <div>
          <Label htmlFor="audit-to">结束</Label>
          <Input
            id="audit-to"
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-48"
            data-testid="audit-to-filter"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" data-testid="audit-apply">
          <Search className="size-4" /> 查询
        </Button>
      </form>

      {error !== null && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="audit-error">
          {error}
        </p>
      )}

      <div className="mt-5">
        {loading && items.length === 0 ? (
          <Spinner label="正在加载审计…" />
        ) : items.length === 0 ? (
          <EmptyState title="没有符合条件的记录" testId="audit-empty" />
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border border-border" data-testid="audit-table">
              <table className="w-full text-sm">
                <thead className="bg-secondary text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">时间</th>
                    <th className="px-4 py-2 font-medium">操作者</th>
                    <th className="px-4 py-2 font-medium">动作</th>
                    <th className="px-4 py-2 font-medium">对象</th>
                    <th className="px-4 py-2 font-medium">结果</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((row) => (
                    <tr key={row.id} data-testid="audit-row" data-action={row.action} data-result={row.result}>
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                        {row.createdAt.slice(0, 19).replace('T', ' ')}
                      </td>
                      <td className="px-4 py-2 text-foreground" data-testid="audit-row-actor">
                        {row.actorName}
                      </td>
                      <td className="px-4 py-2 text-foreground" data-testid="audit-row-action">
                        {labelOf(row.action)}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground" data-testid="audit-row-target">
                        {row.targetType}
                        {row.targetId === null ? '' : ` · ${row.targetId.slice(0, 8)}`}
                      </td>
                      <td className="px-4 py-2">
                        <Badge
                          variant={row.result === 'success' ? 'success' : row.result === 'denied' ? 'danger' : 'warning'}
                          data-testid="audit-row-result"
                        >
                          {row.result === 'success' ? '成功' : row.result === 'denied' ? '被拒绝' : '失败'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3" data-testid="audit-pagination">
              <p className="text-sm text-muted-foreground" data-testid="audit-page-info">
                第 {Math.floor(offset / PAGE_SIZE) + 1} 页 · 共 {total} 条
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={offset <= 0 || loading}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  data-testid="audit-page-prev"
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total || loading}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  data-testid="audit-page-next"
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
