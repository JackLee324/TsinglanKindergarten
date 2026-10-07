import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Search } from 'lucide-react'
import { reviewsApi } from '../api/resources'
import type { ResourceListItem, ResourceSortKey, ResourceStatus } from '../api/types'
import { useDirectory } from '../directory/DirectoryProvider'
import { useAuth } from '../auth/useAuth'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card, CardContent } from '../components/ui/Card'
import { EmptyState } from '../components/ui/EmptyState'
import { Input, Label } from '../components/ui/Input'
import { Spinner } from '../components/ui/Spinner'
import { formatDate } from '../components/resource/ResourceCard'
import { humanMessage } from '../components/resource/errors'
import { DEFAULT_PAGE_SIZE, RESOURCE_SORTS, REVIEW_QUEUE_TABS } from '@shared/resource-query'
import { RESOURCE_STATUS_LABEL } from '@shared/resource-status'

/**
 * 审核队列（业主 Stage 7 §3 / §21）。
 *
 * 三个分栏：待审核 / 已发布 / 已退回。每一栏都支持
 * **搜索 + 目录过滤 + 排序 + 服务端分页** —— 业主明确要求"不要一次返回全部数据"，
 * 所以页码与总数都从服务端来（前端不自己截断）。
 *
 * ⚠️ 这里**没有**任何"我是不是管理员"的判断：能不能进这个页面由服务端的
 * `capabilities.canReview` 决定（见 app.tsx 的 RequireReview），
 * 具体的通过/退回也是服务端逐条判定的。
 */
export function ReviewQueuePage() {
  const navigate = useNavigate()
  const { capabilities } = useAuth()
  const { resolve, roots } = useDirectory()
  const [params, setParams] = useSearchParams()

  const tab = (REVIEW_QUEUE_TABS.find((t) => t.key === params.get('tab'))?.key ??
    'PENDING_REVIEW') as ResourceStatus
  const q = params.get('q') ?? ''
  const directoryPath = params.get('dir') ?? ''
  const sort = params.get('sort') ?? 'updated_desc'
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)

  const [search, setSearch] = useState(q)
  const [items, setItems] = useState<readonly ResourceListItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /** 目录过滤选项来自**同一棵目录树**（不另开一份清单）。 */
  const directoryOptions = flatten(roots)

  const directoryId = directoryPath === '' ? null : (resolve(directoryPath.split('/')).node?.id ?? null)

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params)
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key)
        else next.set(key, value)
      }
      // 任何筛选变化都回到第 1 页 —— 否则会在一个更小的结果集里停在越界页上。
      if (!('page' in patch)) next.delete('page')
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    reviewsApi
      .queue(tab, {
        q: q === '' ? null : q,
        directoryId,
        // ⚠️ 不要传 includeSubtree：审核队列的目录过滤**在服务端固定包含子树**
        // （"我要看 Pre-K 这一块"），而 DTO 上没有这个字段 ——
        // 全局 ValidationPipe 是 forbidNonWhitelisted，多传一个字段就是 400，
        // 表现出来是"审核台一条都没有"（Stage 7 的浏览器用例抓到了这个）。
        sort: sortKeyOf(sort),
        page,
        pageSize: DEFAULT_PAGE_SIZE,
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
        setError(humanMessage(e, '加载审核队列失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab, q, directoryId, sort, page])

  const locationOf = (path: string): string =>
    path
      .split('/')
      .map((_, index, all) => resolve(all.slice(0, index + 1)).node?.name ?? all[index])
      .join(' / ')

  if (capabilities?.canReview !== true) {
    return (
      <EmptyState
        title="你没有审核权限"
        description="审核工作台只对持有审核权限的账号开放。"
        testId="review-forbidden"
      />
    )
  }

  return (
    <div data-testid="review-queue-page">
      <h1 className="text-2xl font-semibold text-foreground" data-testid="page-title">
        审核工作台
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        通过并发布会直接让资源出现在目录里；退回必须写明原因，教师能看到。
      </p>

      {/* 分栏 */}
      <div className="mt-5 flex flex-wrap gap-2" data-testid="review-tabs">
        {REVIEW_QUEUE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            data-testid="review-tab"
            data-tab-key={t.key}
            data-tab-active={String(t.key === tab)}
            onClick={() => update({ tab: t.key, page: null })}
            className={
              t.key === tab
                ? 'rounded-full bg-primary px-4 py-1.5 text-sm text-primary-foreground'
                : 'rounded-full bg-secondary px-4 py-1.5 text-sm text-secondary-foreground hover:bg-primary-light/40'
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 筛选：搜索 + 目录 + 排序 */}
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        data-testid="review-filters"
        onSubmit={(e) => {
          e.preventDefault()
          update({ q: search.trim() })
        }}
      >
        <div>
          <Label htmlFor="review-q">搜索</Label>
          <Input
            id="review-q"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="标题、描述、文件名"
            className="w-56"
            data-testid="review-search"
          />
        </div>
        <div>
          <Label htmlFor="review-dir">目录</Label>
          <select
            id="review-dir"
            value={directoryPath}
            onChange={(e) => update({ dir: e.target.value })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
            data-testid="review-directory"
          >
            <option value="">全部目录</option>
            {directoryOptions.map((opt) => (
              <option key={opt.path} value={opt.path}>
                {'　'.repeat(opt.depth)}
                {opt.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="review-sort">排序</Label>
          <select
            id="review-sort"
            value={sort}
            onChange={(e) => update({ sort: e.target.value })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
            data-testid="review-sort"
          >
            {RESOURCE_SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline" size="sm" data-testid="review-search-submit">
          <Search className="size-4" /> 搜索
        </Button>
      </form>

      {error !== null && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="review-error">
          {error}
        </p>
      )}

      <div className="mt-5">
        {loading && items.length === 0 ? (
          <Spinner label="正在加载审核队列…" />
        ) : items.length === 0 ? (
          <EmptyState
            title={q === '' ? '这一栏暂时没有资源' : `没有找到与「${q}」匹配的资源`}
            description={tab === 'PENDING_REVIEW' ? '有老师提交之后，资源会出现在这里。' : undefined}
            testId="review-empty"
          />
        ) : (
          <>
            <div className="space-y-3" data-testid="review-list">
              {items.map((item) => (
                <Card key={item.id} data-testid="review-row" data-resource-id={item.id}>
                  <CardContent>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          to={`/resources/${item.id}`}
                          className="text-lg font-semibold text-foreground hover:text-primary"
                          data-testid="review-row-title"
                        >
                          {item.title}
                        </Link>
                        <p className="mt-1 text-sm text-muted-foreground" data-testid="review-row-location">
                          {locationOf(item.directoryPath)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <span data-testid="review-row-uploader">{item.uploaderName ?? '未知'}</span>
                          {' · '}
                          <span data-testid="review-row-updated">更新于 {formatDate(item.updatedAt)}</span>
                          {' · '}
                          <span data-testid="review-row-files">共 {item.fileCount} 个文件</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={item.status === 'PUBLISHED' ? 'success' : item.status === 'REJECTED' ? 'danger' : 'warning'}
                          data-testid="review-row-status"
                        >
                          {RESOURCE_STATUS_LABEL[item.status]}
                        </Badge>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(`/resources/${item.id}`)}
                          data-testid="review-row-open"
                        >
                          查看
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between gap-3" data-testid="review-pagination">
              <p className="text-sm text-muted-foreground" data-testid="review-page-info">
                第 {page} 页 / 共 {totalPages} 页 · 共 {total} 条
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => update({ page: String(page - 1) })}
                  data-testid="review-page-prev"
                >
                  上一页
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => update({ page: String(page + 1) })}
                  data-testid="review-page-next"
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

/** 排序值收敛到白名单类型（URL 参数不可信，服务端还会再校验一次）。 */
function sortKeyOf(value: string): ResourceSortKey {
  const found = RESOURCE_SORTS.find((s) => s.key === value)
  return (found?.key ?? 'updated_desc') as ResourceSortKey
}

/** 目录树摊平成下拉选项（带层级缩进）。 */
function flatten(
  nodes: readonly { name: string; path: string; children: readonly unknown[] }[],
  depth = 0,
  out: { name: string; path: string; depth: number }[] = [],
): { name: string; path: string; depth: number }[] {
  for (const node of nodes) {
    out.push({ name: node.name, path: node.path, depth })
    flatten(node.children as never, depth + 1, out)
  }
  return out
}
