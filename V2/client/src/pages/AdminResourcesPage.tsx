import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Trash2, Upload } from 'lucide-react'
import { ApiError } from '../api/http'
import type { DirectoryNode, ResourceListItem, ResourceStatus } from '../api/types'
import { RESOURCE_STATUSES, RESOURCE_STATUS_LABEL } from '@shared/resource-status'
import { useDirectory } from '../directory/DirectoryProvider'
import { useAuth } from '../auth/useAuth'
import { MAX_BULK_DELETE, resourcesApi, type BulkDeleteResult } from '../api/resources'
import { humanMessage } from '../components/resource/errors'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Dialog } from '../components/ui/Dialog'
import { Input } from '../components/ui/Input'
import { Spinner } from '../components/ui/Spinner'
import { EmptyState } from '../components/ui/EmptyState'
import { UploadResourceDialog } from '../components/resource/UploadResourceDialog'

/** 状态 → 徽标样式。与列表其余部分共用同一套语义色。 */
const STATUS_VARIANT: Readonly<
  Record<ResourceStatus, 'secondary' | 'success' | 'warning' | 'danger' | 'muted'>
> = {
  DRAFT: 'muted',
  PENDING_REVIEW: 'warning',
  PUBLISHED: 'success',
  REJECTED: 'danger',
  RECALLED: 'secondary',
}

const PAGE_SIZE = 20

/** 把所有可选目录拍平（用于「按目录筛选」与上传时的目录下拉）。 */
function flattenDirectories(nodes: readonly DirectoryNode[], depth = 0): {
  id: string
  path: string
  label: string
  canUpload: boolean
}[] {
  const out: { id: string; path: string; label: string; canUpload: boolean }[] = []
  for (const node of nodes) {
    out.push({
      id: node.id,
      path: node.path,
      label: `${'　'.repeat(depth)}${node.name}`,
      // canUpload 由**服务端**算（allow_files && 我有权建）—— 前端不自己判断
      canUpload: node.capabilities.canUpload === true,
    })
    if (node.children.length > 0) out.push(...flattenDirectories(node.children, depth + 1))
  }
  return out
}

/**
 * 全局资源管理（超级管理员专用）。
 *
 * 三条设计约束：
 *
 * 1. **入口与页面都只是"不摆必然失败的操作"**，不是安全边界。
 *    真正的门槛在服务端：`/api/resources` 走统一授权（管理员看全部），
 *    批量删除与永久删除都额外要求 `@RequireSuperAdmin()`。
 *    普通教师直接敲这个 URL 会看到一句"没有权限"，而不是空的管理页。
 *
 * 2. **列表范围与状态由服务端决定**。这里不重新实现一套过滤规则：
 *    搜索 / 目录 / 状态 / 分页全部作为查询参数传给 `/api/resources`，
 *    与「我的资源」「审核队列」共用同一个查询（服务端的 `queryResources`）。
 *    管理员之所以能看到别人上传的草稿，靠的是服务端
 *    `resourceVisibility()` 里"管理员看全部"那一条策略 —— 前端没有旁路。
 *
 * 3. **批量删除是软删除**（进回收站、可恢复），且结果逐条如实。
 *    界面上永远不提供"彻底删除"：那是 `purge`，高风险且不在本页范围内。
 */
export function AdminResourcesPage() {
  const navigate = useNavigate()
  const { capabilities } = useAuth()
  const { roots, resolve } = useDirectory()
  const allowed = capabilities?.canManageAllResources === true

  const [q, setQ] = useState('')
  /** 已提交的搜索词（与输入框分开：输入时不立刻打接口）。 */
  const [appliedQ, setAppliedQ] = useState('')
  const [directoryId, setDirectoryId] = useState('')
  const [status, setStatus] = useState<ResourceStatus | ''>('')
  const [page, setPage] = useState(1)

  const [items, setItems] = useState<readonly ResourceListItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /** 勾选是**跨页保留**的；界面上始终显示总数，避免"以为只选了这一页"。 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [bulkResult, setBulkResult] = useState<BulkDeleteResult | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  /** 全局上传入口的目录选择（初始为空 = 必须由管理员选）。 */
  const [uploadTarget, setUploadTarget] = useState<{ id: string; path: string }>({ id: '', path: '' })

  const directories = useMemo(() => flattenDirectories(roots), [roots])
  const uploadable = useMemo(() => directories.filter((d) => d.canUpload), [directories])

  const labelOf = useCallback(
    (path: string): string =>
      path === ''
        ? '—'
        : path
            .split('/')
            .map((_, index, all) => resolve(all.slice(0, index + 1)).node?.name ?? all[index])
            .join(' / '),
    [resolve],
  )

  const [reloadToken, setReloadToken] = useState(0)
  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  useEffect(() => {
    if (!allowed) return
    let cancelled = false
    setLoading(true)
    setError(null)
    resourcesApi
      .list({
        q: appliedQ === '' ? null : appliedQ,
        directoryId: directoryId === '' ? null : directoryId,
        status: status === '' ? null : status,
        page,
        pageSize: PAGE_SIZE,
      })
      .then((res) => {
        if (cancelled) return
        setItems(res.items)
        setTotal(res.total)
        setTotalPages(res.totalPages)
      })
      .catch((e) => {
        if (cancelled) return
        setItems([])
        setTotal(0)
        setError(e instanceof ApiError ? e.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [allowed, appliedQ, directoryId, status, page, reloadToken])

  // ── 权限兜底（服务端仍是唯一门槛）──────────────────────────────────────
  if (!allowed) {
    return (
      <EmptyState
        title="你没有资源管理权限"
        description="这个页面只有超级管理员可以打开。如果你认为这是需要的，请联系管理员。"
        testId="admin-resources-forbidden"
      />
    )
  }

  const pageIds = items.map((i) => i.id)
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const selectedOnPage = pageIds.filter((id) => selected.has(id)).length

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 全选/取消**当前页**。语义写死在按钮文案里，不做"选中全部筛选结果"的暗示。 */
  function togglePage() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOnPageSelected) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }

  function clearSelection() {
    setSelected(new Set())
  }

  async function runBulkDelete() {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await resourcesApi.bulkDelete(ids)
      setBulkResult(result)
      setConfirmOpen(false)
      // 按服务端结果更新：真正删掉的从勾选里移除；被跳过/失败的留着手动决定。
      const removed = new Set(result.items.filter((i) => i.outcome === 'deleted').map((i) => i.id))
      setSelected((prev) => new Set([...prev].filter((id) => !removed.has(id))))
      reload()
    } catch (e) {
      setActionError(humanMessage(e, '批量删除失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="admin-resources-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground" data-testid="page-title">
            资源管理
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            平台上的**全部**资源（含别人上传的草稿、待审核、已退回）。共 {total} 条。
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setUploadTarget({ id: '', path: '' })
            setUploadOpen(true)
          }}
          data-testid="admin-resources-upload"
        >
          <Upload className="size-4" /> 上传资源
        </Button>
      </div>

      {/* ── 筛选区 ───────────────────────────────────────────────────── */}
      <div className="mt-5 flex flex-wrap items-end gap-3" data-testid="admin-resources-filters">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setAppliedQ(q.trim())
            setPage(1)
          }}
        >
          <div>
            <label className="text-xs text-muted-foreground" htmlFor="admin-resources-q">
              搜索（标题 / 英文标题 / 描述）
            </label>
            <Input
              id="admin-resources-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="输入关键词"
              maxLength={100}
              data-testid="admin-resources-search"
            />
          </div>
          <Button type="submit" variant="outline" data-testid="admin-resources-search-submit">
            <Search className="size-4" /> 搜索
          </Button>
        </form>

        <div>
          <label className="text-xs text-muted-foreground" htmlFor="admin-resources-directory">
            目录
          </label>
          <select
            id="admin-resources-directory"
            className="mt-1 w-56 rounded-lg border border-border bg-card px-3 py-2 text-sm min-h-10"
            value={directoryId}
            onChange={(e) => {
              setDirectoryId(e.target.value)
              setPage(1)
            }}
            data-testid="admin-resources-directory-filter"
          >
            <option value="">全部目录</option>
            {directories.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-muted-foreground" htmlFor="admin-resources-status">
            状态
          </label>
          <select
            id="admin-resources-status"
            className="mt-1 w-40 rounded-lg border border-border bg-card px-3 py-2 text-sm min-h-10"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ResourceStatus | '')
              setPage(1)
            }}
            data-testid="admin-resources-status-filter"
          >
            <option value="">全部状态</option>
            {RESOURCE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {RESOURCE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── 批量操作条 ───────────────────────────────────────────────── */}
      <div
        className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-secondary px-3 py-2"
        data-testid="admin-resources-bulkbar"
      >
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="size-4"
            checked={allOnPageSelected}
            onChange={togglePage}
            disabled={pageIds.length === 0}
            data-testid="admin-resources-select-page"
          />
          全选本页（{selectedOnPage}/{pageIds.length}）
        </label>
        <span className="text-sm text-muted-foreground" data-testid="admin-resources-selected-count">
          已选 <strong data-testid="admin-resources-selected-total">{selected.size}</strong> 条
          {selected.size > pageIds.length && selectedOnPage < selected.size
            ? '（含其他页）'
            : ''}
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            className="text-sm text-muted-foreground underline"
            onClick={clearSelection}
            data-testid="admin-resources-clear-selection"
          >
            清空选择
          </button>
        )}
        <div className="ml-auto">
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setConfirmOpen(true)}
            data-testid="admin-resources-bulk-delete"
          >
            <Trash2 className="size-4" /> 批量删除
          </Button>
        </div>
      </div>

      {actionError !== null && (
        <p
          className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="admin-resources-action-error"
        >
          {actionError}
        </p>
      )}
      {error !== null && (
        <p
          className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="admin-resources-error"
        >
          {error}
        </p>
      )}

      {/* ── 列表 ─────────────────────────────────────────────────────── */}
      <div className="mt-4">
        {loading && items.length === 0 ? (
          <Spinner label="正在加载…" />
        ) : items.length === 0 ? (
          <EmptyState
            title="没有符合条件的资源"
            description="换个搜索词，或把目录/状态筛选调回「全部」。"
            testId="admin-resources-empty"
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[52rem] text-left text-sm" data-testid="admin-resources-table">
                <thead className="bg-secondary/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2" />
                    <th className="px-3 py-2">标题</th>
                    <th className="px-3 py-2">所属目录</th>
                    <th className="px-3 py-2">上传者</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">文件</th>
                    <th className="px-3 py-2">最近更新</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.id}
                      className="border-t border-border"
                      data-testid="admin-resource-row"
                      data-resource-id={item.id}
                      data-resource-status={item.status}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={selected.has(item.id)}
                          onChange={() => toggleOne(item.id)}
                          aria-label={`选择 ${item.title}`}
                          data-testid="admin-resource-select"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-left font-medium text-foreground hover:underline"
                          onClick={() => navigate(`/resources/${item.id}`)}
                          data-testid="admin-resource-title"
                        >
                          {item.title}
                        </button>
                        {item.titleEn !== null && item.titleEn !== '' && (
                          <p className="text-xs text-muted-foreground">{item.titleEn}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground" data-testid="admin-resource-directory">
                        {labelOf(item.directoryPath)}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground" data-testid="admin-resource-uploader">
                        {item.uploaderName ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={STATUS_VARIANT[item.status]} data-testid="admin-resource-status">
                          {RESOURCE_STATUS_LABEL[item.status]}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground" data-testid="admin-resource-files">
                        {item.fileCount > 0 ? `${item.fileCount} 个` : '无'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground" data-testid="admin-resource-updated">
                        {new Date(item.updatedAt).toLocaleDateString('zh-CN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              className="mt-4 flex items-center justify-between gap-3"
              data-testid="admin-resources-pagination"
            >
              <p className="text-sm text-muted-foreground" data-testid="admin-resources-page-info">
                第 {page} 页 / 共 {totalPages} 页 · 本页 {items.length} 条 · 筛选结果共 {total} 条
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="admin-resources-prev"
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  data-testid="admin-resources-next"
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── 批量删除确认 ─────────────────────────────────────────────── */}
      <Dialog
        open={confirmOpen}
        title="批量删除资源"
        onClose={() => setConfirmOpen(false)}
        testId="admin-bulk-delete-dialog"
      >
        <p className="text-sm text-foreground" data-testid="admin-bulk-delete-summary">
          即将删除 <strong>{selected.size}</strong> 条资源。
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          这是**可恢复**的操作：资源会被移入回收站，文件、审核记录与审计都会保留，之后可以恢复。
          {selected.size > MAX_BULK_DELETE && (
            <span className="mt-1 block text-destructive">
              一次最多删除 {MAX_BULK_DELETE} 条，请分批操作。
            </span>
          )}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          已发布的资源不会被删除，会逐条告诉你原因（需先撤回）。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmOpen(false)}
            disabled={busy}
            data-testid="admin-bulk-delete-cancel"
          >
            取消
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => void runBulkDelete()}
            disabled={busy || selected.size === 0 || selected.size > MAX_BULK_DELETE}
            data-testid="admin-bulk-delete-confirm"
          >
            {busy ? '正在删除…' : '确认删除'}
          </Button>
        </div>
      </Dialog>

      {/* ── 批量删除结果（逐条如实）──────────────────────────────────── */}
      <Dialog
        open={bulkResult !== null}
        title="批量删除结果"
        onClose={() => setBulkResult(null)}
        testId="admin-bulk-delete-result"
      >
        {bulkResult !== null && (
          <div data-testid="admin-bulk-result-body">
            <p className="text-sm text-foreground">
              成功 <strong data-testid="admin-bulk-deleted">{bulkResult.deleted}</strong> 条 ·
              跳过 <strong data-testid="admin-bulk-skipped">{bulkResult.skipped}</strong> 条 ·
              失败 <strong data-testid="admin-bulk-failed">{bulkResult.failed}</strong> 条
              {bulkResult.duplicated > 0 && `（已忽略 ${bulkResult.duplicated} 个重复 ID）`}
            </p>
            <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto text-sm" data-testid="admin-bulk-items">
              {bulkResult.items.map((it) => (
                <li key={it.id} className="flex items-start gap-2">
                  <span
                    className={
                      it.outcome === 'deleted'
                        ? 'text-success'
                        : it.outcome === 'skipped'
                          ? 'text-muted-foreground'
                          : 'text-destructive'
                    }
                  >
                    {it.outcome === 'deleted' ? '已删除' : it.outcome === 'skipped' ? '已跳过' : '失败'}
                  </span>
                  <span className="text-muted-foreground">{it.message}</span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end">
              <Button type="button" onClick={() => setBulkResult(null)} data-testid="admin-bulk-result-close">
                知道了
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* ── 全局上传入口 ─────────────────────────────────────────────── */}
      <UploadResourceDialog
        open={uploadOpen}
        directoryId={uploadTarget.id}
        directoryPath={uploadTarget.path}
        directoryChoices={uploadable}
        onDirectoryChange={setUploadTarget}
        onClose={() => setUploadOpen(false)}
        onCreated={(id) => {
          setUploadOpen(false)
          reload()
          navigate(`/resources/${id}`)
        }}
      />
    </div>
  )
}
