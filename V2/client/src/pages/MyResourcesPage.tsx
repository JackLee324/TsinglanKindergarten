import { useEffect, useState } from 'react'
import { resourcesApi } from '../api/resources'
import { ApiError } from '../api/http'
import type { ResourceListItem, ResourceStatus } from '../api/types'
import { MY_RESOURCE_TABS } from '@shared/resource-query'
import { useDirectory } from '../directory/DirectoryProvider'
import { ResourceCard } from '../components/resource/ResourceCard'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'
import { EmptyState } from '../components/ui/EmptyState'
import { cn } from '../components/ui/cn'

/**
 * 「我的资源」。
 *
 * 分栏与 `shared/resource-query.ts` 的 `MY_RESOURCE_TABS` **同源** ——
 * 前后端各写一份分栏迟早会出现"界面有 6 栏、接口只认 5 个"。
 *
 * 只列**自己上传**的资源（服务端按 uploader 过滤，不依赖前端传参），
 * 所以草稿、待审核、已退回、已撤回在这里都看得到 —— 这是它们唯一该出现的地方。
 */
export function MyResourcesPage() {
  const { resolve } = useDirectory()
  const [tab, setTab] = useState<(typeof MY_RESOURCE_TABS)[number]['key']>('ALL')
  const [items, setItems] = useState<readonly ResourceListItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const status = MY_RESOURCE_TABS.find((t) => t.key === tab)?.status ?? null

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    resourcesApi
      .mine({ status: status as ResourceStatus | null, page, pageSize: 12 })
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
  }, [status, page])

  const labelOf = (path: string): string =>
    path
      .split('/')
      .map((_, index, all) => resolve(all.slice(0, index + 1)).node?.name ?? all[index])
      .join(' / ')

  return (
    <div data-testid="my-resources-page">
      <h1 className="text-2xl font-semibold text-foreground" data-testid="page-title">
        我的资源
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        这里是你上传的全部资源，包括别人看不到的草稿与待审核内容（共 {total} 条）。
      </p>

      <div className="mt-5 flex flex-wrap gap-2" data-testid="my-resources-tabs">
        {MY_RESOURCE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            data-testid="my-resources-tab"
            data-tab-key={t.key}
            data-tab-active={String(t.key === tab)}
            onClick={() => {
              setTab(t.key)
              setPage(1)
            }}
            className={cn(
              'rounded-full px-4 py-1.5 text-sm transition-colors',
              t.key === tab
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-primary-light/40',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error !== null && (
        <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="my-resources-error">
          {error}
        </p>
      )}

      <div className="mt-6">
        {loading && items.length === 0 ? (
          <Spinner label="正在加载…" />
        ) : items.length === 0 ? (
          <EmptyState
            title={status === null ? '你还没有上传过资源' : '这一栏暂时没有资源'}
            description={status === null ? '进入任意目录即可看到该目录下的资源。' : undefined}
            testId="my-resources-empty"
          />
        ) : (
          <>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="my-resources-list">
              {items.map((item) => (
                <ResourceCard
                  key={item.id}
                  resource={item}
                  locationLabel={labelOf(item.directoryPath)}
                  testId="my-resource-card"
                />
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between gap-3" data-testid="my-resources-pagination">
              <p className="text-sm text-muted-foreground" data-testid="my-resources-page-info">
                第 {page} 页 / 共 {totalPages} 页 · 本页 {items.length} 条
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  data-testid="my-resources-prev"
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  data-testid="my-resources-next"
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
